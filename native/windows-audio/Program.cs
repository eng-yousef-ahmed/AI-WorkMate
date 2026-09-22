using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

Console.OutputEncoding = Encoding.UTF8;
Console.Error.WriteLine("AI WorkMate Windows audio helper starting.");

try
{
    var command = args.Length == 0 ? "" : args[0].ToLowerInvariant();
    switch (command)
    {
        case "capabilities":
            WriteCapabilities();
            return 0;
        case "capture":
            return await CaptureAsync(args.Skip(1).ToArray());
        default:
            WriteError("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", $"Unknown command: {command}", false);
            return 2;
    }
}
catch (UnauthorizedAccessException ex)
{
    WriteError("NATIVE_PERMISSION_DENIED", ex.Message, true);
    return 10;
}
catch (COMExceptionLike ex)
{
    WriteError(ex.Code, ex.Message, ex.Retryable);
    return 11;
}
catch (COMException ex)
{
    var mapped = MapComException(ex, "NATIVE_WINDOWS_API_INITIALIZATION_FAILED");
    WriteError(mapped.Code, mapped.Message, mapped.Retryable);
    return 12;
}
catch (Exception ex)
{
    WriteError("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", ex.Message, true);
    return 1;
}

static void WriteCapabilities()
{
    using var enumerator = new MMDeviceEnumerator();
    var defaultMicId = TryGetDefaultDeviceId(enumerator, DataFlow.Capture, Role.Communications)
        ?? TryGetDefaultDeviceId(enumerator, DataFlow.Capture, Role.Multimedia);
    var defaultRenderId = TryGetDefaultDeviceId(enumerator, DataFlow.Render, Role.Multimedia);

    var microphone = EnumerateDevices(enumerator, DataFlow.Capture, defaultMicId);
    var systemAudio = EnumerateDevices(enumerator, DataFlow.Render, defaultRenderId);

    var payload = new
    {
        checkedAt = DateTimeOffset.UtcNow.ToString("O"),
        microphone,
        systemAudio,
    };
    Console.Out.WriteLine(JsonSerializer.Serialize(payload));
}

static List<object> EnumerateDevices(MMDeviceEnumerator enumerator, DataFlow flow, string? defaultId)
{
    var devices = new List<object>();
    foreach (var device in enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active))
    {
        using (device)
        {
            var id = device.ID ?? string.Empty;
            var label = device.FriendlyName ?? id;
            devices.Add(new
            {
                id,
                label,
                isDefault = defaultId != null && string.Equals(defaultId, id, StringComparison.OrdinalIgnoreCase),
            });
        }
    }
    return devices;
}

static string? TryGetDefaultDeviceId(MMDeviceEnumerator enumerator, DataFlow flow, Role role)
{
    try
    {
        return enumerator.GetDefaultAudioEndpoint(flow, role)?.ID;
    }
    catch
    {
        return null;
    }
}

static async Task<int> CaptureAsync(string[] args)
{
    try
    {
        var parsed = ParseArguments(args);
        var kind = parsed.GetValueOrDefault("kind")?.ToLowerInvariant();
        var sourceId = parsed.GetValueOrDefault("source-id");
        var format = parsed.GetValueOrDefault("format")?.ToLowerInvariant();
        if (format != "aiwpcm-jsonl")
        {
            throw new COMExceptionLike("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Only aiwpcm-jsonl output is supported by the Windows audio helper.", false);
        }
        if (kind != "microphone" && kind != "loopback")
        {
            throw new COMExceptionLike("NATIVE_CAPABILITY_UNAVAILABLE", "Capture kind must be microphone or loopback.", false);
        }

        using var enumerator = new MMDeviceEnumerator();
        var flow = kind == "microphone" ? DataFlow.Capture : DataFlow.Render;
        using var device = SelectDevice(enumerator, flow, sourceId);
        using var capture = kind == "microphone"
            ? new WasapiCapture(device)
            : new WasapiLoopbackCapture(device);

        var source = kind == "microphone" ? "MICROPHONE_AUDIO" : "SYSTEM_AUDIO";
        var sourceLabel = device.FriendlyName ?? device.ID ?? "Windows audio device";
        var startedAt = DateTimeOffset.UtcNow.ToString("O");
        var sequence = 0L;
        var stopped = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var writeLock = new object();
        var errors = new ConcurrentQueue<Exception>();

        capture.DataAvailable += (_, eventArgs) =>
        {
            if (eventArgs.BytesRecorded <= 0)
            {
                return;
            }
            try
            {
                var buffer = eventArgs.Buffer.AsSpan(0, eventArgs.BytesRecorded).ToArray();
                var record = new
                {
                    recordType = "chunk",
                    sequence = sequence++,
                    timestamp = DateTimeOffset.UtcNow.ToString("O"),
                    source,
                    sourceId = device.ID,
                    format = FormatPayload(capture.WaveFormat),
                    byteLength = buffer.Length,
                    sha256 = Convert.ToHexString(SHA256.HashData(buffer)).ToLowerInvariant(),
                    dataBase64 = Convert.ToBase64String(buffer),
                };
                lock (writeLock)
                {
                    Console.Out.WriteLine(JsonSerializer.Serialize(record));
                    Console.Out.Flush();
                }
            }
            catch (Exception ex)
            {
                errors.Enqueue(ex);
                stopped.TrySetException(ex);
            }
        };

        capture.RecordingStopped += (_, eventArgs) =>
        {
            if (eventArgs.Exception != null)
            {
                stopped.TrySetException(eventArgs.Exception);
            }
            else
            {
                stopped.TrySetResult(0);
            }
        };

        var header = new
        {
            recordType = "format",
            source,
            sourceId = device.ID,
            sourceLabel,
            startedAt,
            format = FormatPayload(capture.WaveFormat),
        };
        Console.Out.WriteLine(JsonSerializer.Serialize(header));
        Console.Out.Flush();

        capture.StartRecording();
        var controlTask = Task.Run(async () =>
        {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) != null)
            {
                var command = line.Trim().ToLowerInvariant();
                if (command == "stop" || command.StartsWith("abort", StringComparison.Ordinal))
                {
                    capture.StopRecording();
                    return;
                }
            }
        });

        await Task.WhenAny(stopped.Task, controlTask);
        if (!stopped.Task.IsCompleted)
        {
            capture.StopRecording();
        }
        await stopped.Task;
        if (errors.TryDequeue(out var error))
        {
            throw error;
        }
        return 0;
    }
    catch (UnauthorizedAccessException ex)
    {
        WriteError("NATIVE_PERMISSION_DENIED", ex.Message, true);
        return 20;
    }
    catch (COMExceptionLike ex)
    {
        WriteError(ex.Code, ex.Message, ex.Retryable);
        return 21;
    }
    catch (COMException ex)
    {
        var mapped = MapComException(ex, "NATIVE_CAPTURE_STREAM_FAILED");
        WriteError(mapped.Code, mapped.Message, mapped.Retryable);
        return 22;
    }
    catch (Exception ex)
    {
        WriteError("NATIVE_CAPTURE_STREAM_FAILED", ex.Message, true);
        return 23;
    }
}

static MMDevice SelectDevice(MMDeviceEnumerator enumerator, DataFlow flow, string? sourceId)
{
    if (!string.IsNullOrWhiteSpace(sourceId))
    {
        foreach (var device in enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active))
        {
            if (string.Equals(device.ID, sourceId, StringComparison.OrdinalIgnoreCase))
            {
                return device;
            }
        }
        throw new COMExceptionLike("NATIVE_DEVICE_UNAVAILABLE", "The requested Windows audio device is unavailable.", true);
    }
    try
    {
        return enumerator.GetDefaultAudioEndpoint(flow, flow == DataFlow.Capture ? Role.Communications : Role.Multimedia);
    }
    catch
    {
        return enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
    }
}

static object FormatPayload(WaveFormat format)
{
    return new
    {
        container = "AIWPCM_JSONL",
        encoding = "PCM",
        sampleRateHz = format.SampleRate,
        channels = format.Channels,
        bitsPerSample = format.BitsPerSample,
        blockAlign = format.BlockAlign,
        averageBytesPerSecond = format.AverageBytesPerSecond,
    };
}

static Dictionary<string, string> ParseArguments(string[] args)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var index = 0; index < args.Length; index++)
    {
        var token = args[index];
        if (!token.StartsWith("--", StringComparison.Ordinal))
        {
            continue;
        }
        var key = token[2..];
        if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
        {
            result[key] = "true";
        }
        else
        {
            result[key] = args[++index];
        }
    }
    return result;
}

static HelperError MapComException(COMException ex, string fallbackCode)
{
    if (ex.HResult == unchecked((int)0x80070005) || ex.Message.Contains("access denied", StringComparison.OrdinalIgnoreCase))
    {
        return new HelperError("NATIVE_PERMISSION_DENIED", ex.Message, true);
    }
    if (ex.Message.Contains("device", StringComparison.OrdinalIgnoreCase)
        && (ex.Message.Contains("unavailable", StringComparison.OrdinalIgnoreCase)
            || ex.Message.Contains("disconnect", StringComparison.OrdinalIgnoreCase)
            || ex.Message.Contains("invalid", StringComparison.OrdinalIgnoreCase)
            || ex.Message.Contains("not found", StringComparison.OrdinalIgnoreCase)))
    {
        return new HelperError("NATIVE_DEVICE_UNAVAILABLE", ex.Message, true);
    }
    return new HelperError(fallbackCode, ex.Message, true);
}

static void WriteError(string code, string message, bool retryable)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(new
    {
        recordType = "error",
        code,
        message,
        retryable,
    }));
    Console.Error.WriteLine($"{code}: {message}");
}

internal sealed record HelperError(string Code, string Message, bool Retryable);

internal sealed class COMExceptionLike : Exception
{
    public string Code { get; }
    public bool Retryable { get; }

    public COMExceptionLike(string code, string message, bool retryable) : base(message)
    {
        Code = code;
        Retryable = retryable;
    }
}
