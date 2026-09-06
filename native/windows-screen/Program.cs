using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Foundation.Metadata;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using WinRT;

Console.OutputEncoding = Encoding.UTF8;
Console.Error.WriteLine("AI WorkMate Windows screen helper starting.");

try
{
    var command = args.Length == 0 ? "" : args[0].ToLowerInvariant();
    return command switch
    {
        "capabilities" => WriteCapabilities(),
        "capture" => await CaptureAsync(args.Skip(1).ToArray()),
        _ => Fail("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", $"Unknown command: {command}", false, 2),
    };
}
catch (UnauthorizedAccessException ex)
{
    return Fail("NATIVE_PERMISSION_DENIED", ex.Message, true, 10);
}
catch (CaptureException ex)
{
    return Fail(ex.Code, ex.Message, ex.Retryable, 11);
}
catch (Exception ex)
{
    return Fail("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", Describe(ex), true, 1);
}

static int WriteCapabilities()
{
    var displays = EnumerateDisplays();
    var windows = EnumerateWindows();
    Console.Out.WriteLine(JsonSerializer.Serialize(new
    {
        checkedAt = DateTimeOffset.UtcNow.ToString("O"),
        displays,
        windows,
        captureApi = new { screen = "DXGI_DESKTOP_DUPLICATION", window = "WINDOWS_GRAPHICS_CAPTURE" },
        minWindowsBuild = 17763,
    }));
    return 0;
}

static List<object> EnumerateDisplays()
{
    using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
    var displays = new List<object>();
    uint adapterIndex = 0;
    while (factory.EnumAdapters1(adapterIndex, out var adapter).Success && adapter is not null)
    {
        using (adapter)
        {
            uint outputIndex = 0;
            while (adapter.EnumOutputs(outputIndex, out var output).Success && output is not null)
            {
                using (output)
                {
                    var desc = output.Description;
                    var bounds = desc.DesktopCoordinates;
                    var id = DisplayId(desc.DeviceName);
                    displays.Add(new
                    {
                        id,
                        label = string.IsNullOrWhiteSpace(desc.DeviceName) ? $"Display {displays.Count + 1}" : desc.DeviceName,
                        isDefault = displays.Count == 0,
                        width = Math.Abs(bounds.Right - bounds.Left),
                        height = Math.Abs(bounds.Bottom - bounds.Top),
                    });
                }
                outputIndex++;
            }
        }
        adapterIndex++;
    }
    return displays;
}

static List<object> EnumerateWindows()
{
    var windows = new List<object>();
    NativeMethods.EnumWindows((hwnd, _) =>
    {
        if (!IsCapturableWindow(hwnd))
        {
            return true;
        }
        var title = GetWindowTitle(hwnd);
        windows.Add(new
        {
            id = WindowId(hwnd),
            label = title,
            isDefault = false,
        });
        return true;
    }, IntPtr.Zero);
    return windows;
}

static async Task<int> CaptureAsync(string[] args)
{
    var parsed = ParseArguments(args);
    var kind = parsed.GetValueOrDefault("kind")?.ToLowerInvariant();
    var format = parsed.GetValueOrDefault("format")?.ToLowerInvariant();
    var sourceId = parsed.GetValueOrDefault("source-id");
    if (format != "aiwvid-jsonl")
    {
        throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Only aiwvid-jsonl output is supported by the Windows screen helper.", false);
    }
    if (kind == "screen")
    {
        return CaptureDisplay(sourceId);
    }
    if (kind == "window")
    {
        return await CaptureWindowAsync(sourceId);
    }
    throw new CaptureException("NATIVE_CAPABILITY_UNAVAILABLE", "Capture kind must be screen or window.", false);
}

static int CaptureDisplay(string? sourceId)
{
    using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
    if (!TryFindOutput(factory, sourceId, out var adapter, out var output, out var displayId, out var label))
    {
        throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The requested Windows display is unavailable.", true);
    }
    using (adapter)
    using (output)
    {
        D3D11.D3D11CreateDevice(
            adapter,
            DriverType.Unknown,
            DeviceCreationFlags.BgraSupport,
            new[] { FeatureLevel.Level_11_0, FeatureLevel.Level_10_0 },
            out var device).CheckError();
        if (device is null)
        {
            throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Direct3D 11 could not be initialised for the requested Windows display.", false);
        }
        using (device)
        {
            using var output1 = output.QueryInterface<IDXGIOutput1>();
            using var duplication = output1.DuplicateOutput(device);
            var bounds = output.Description.DesktopCoordinates;
            var width = Math.Abs(bounds.Right - bounds.Left);
            var height = Math.Abs(bounds.Bottom - bounds.Top);
            return RunFrameLoop(
                "SCREEN",
                displayId,
                label,
                width,
                height,
                (w, h, timeoutMs) => AcquireDuplicationFrame(device, duplication, w, h, timeoutMs));
        }
    }
}

static async Task<int> CaptureWindowAsync(string? sourceId)
{
    if (string.IsNullOrWhiteSpace(sourceId) || !TryParseWindowId(sourceId, out var hwnd) || !NativeMethods.IsWindow(hwnd) || !IsCapturableWindow(hwnd))
    {
        throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The requested Windows window is unavailable.", true);
    }
    if (!NativeMethods.GetWindowRect(hwnd, out var rect))
    {
        throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The requested Windows window has no client rectangle.", true);
    }
    var title = GetWindowTitle(hwnd);
    var width = Math.Max(1, rect.Right - rect.Left);
    var height = Math.Max(1, rect.Bottom - rect.Top);

    // Pre-flight Windows Graphics Capture availability. When an OS API is missing, CsWinRT's
    // activation-factory lookup fails a QueryInterface and surfaces E_NOINTERFACE as an
    // InvalidCastException whose message is only "Specified cast is not valid." Failing fast
    // here with the actual reason keeps WGC verification errors actionable.
    if (!ApiInformation.IsTypePresent("Windows.Graphics.Capture.GraphicsCaptureItem"))
    {
        throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Windows Graphics Capture (GraphicsCaptureItem) is not available on this Windows build; window capture requires Windows 10 version 1803 (build 17134) or later.", false);
    }
    if (!ApiInformation.IsTypePresent("Windows.Graphics.Capture.Direct3D11CaptureFramePool")
        || !ApiInformation.IsMethodPresent("Windows.Graphics.Capture.Direct3D11CaptureFramePool", "CreateFreeThreaded", 4))
    {
        throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Direct3D11CaptureFramePool.CreateFreeThreaded is not available on this Windows build; window capture requires Windows 10 version 1809 (build 17763) or later.", false);
    }
    if (!ApiInformation.IsMethodPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "StartCapture", 0))
    {
        throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "GraphicsCaptureSession.StartCapture is not available on this Windows build.", false);
    }

    ID3D11Device d3dDevice;
    try
    {
        D3D11.D3D11CreateDevice(
            null,
            DriverType.Hardware,
            DeviceCreationFlags.BgraSupport,
            new[] { FeatureLevel.Level_11_0, FeatureLevel.Level_10_0 },
            out d3dDevice).CheckError();
        if (d3dDevice is null)
        {
            throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Direct3D 11 could not be initialised for Windows Graphics Capture.", false);
        }
    }
    catch (CaptureException)
    {
        throw;
    }
    catch (Exception ex)
    {
        throw new CaptureException(
            "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
            $"Windows Graphics Capture could not initialise Direct3D 11 for window \"{title}\" ({WindowId(hwnd)}) [stage:D3D11CreateDevice] {Describe(ex)}",
            false);
    }
    using (d3dDevice)
    {
        IDirect3DDevice winrtDevice;
        try
        {
            winrtDevice = CreateWinRtDevice(d3dDevice);
        }
        catch (CaptureException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CaptureException(
                "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
                $"Windows Graphics Capture could not create the WinRT Direct3D device for window \"{title}\" ({WindowId(hwnd)}) [stage:CreateWinRtDevice] {Describe(ex)}",
                false);
        }
        GraphicsCaptureItem item;
        try
        {
            item = CreateCaptureItemForWindow(hwnd);
        }
        catch (CaptureException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CaptureException(
                "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
                $"Windows Graphics Capture could not create the capture item for window \"{title}\" ({WindowId(hwnd)}) [stage:item-interop] {Describe(ex)}",
                false);
        }
        using var pool = CreateFramePool(winrtDevice, item, title, hwnd);
        using var session = CreateCaptureSession(pool, item, title, hwnd);
        var latest = new ConcurrentQueue<byte[]>();
        var closed = false;
        try
        {
            item.Closed += (_, _) => closed = true;
            // The handler's second parameter is named `args` (not `_`): a lambda parameter named `_`
            // is an ordinary variable in scope (typed object here for TypedEventHandler<..., object>),
            // so an `out _` argument in the body would pass that object variable to
            // ConcurrentQueue<byte[]>.TryDequeue(out byte[]) instead of being a discard -> CS1503.
            // With no `_` in scope, the `out _` below is a genuine discard that drops the oldest JPEG.
            pool.FrameArrived += (sender, args) =>
            {
                using var frame = sender.TryGetNextFrame();
                if (frame is null)
                {
                    return;
                }
                try
                {
                    var bytes = EncodeSoftwareBitmap(frame);
                    if (bytes.Length > 0)
                    {
                        latest.Enqueue(bytes);
                        while (latest.Count > 2)
                        {
                            latest.TryDequeue(out _);
                        }
                    }
                }
                catch
                {
                    // The next loop iteration reports stream failure if no frames arrive.
                }
            };
            session.IsCursorCaptureEnabled = true;
            session.StartCapture();
        }
        catch (Exception ex)
        {
            throw new CaptureException(
                "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
                $"Windows Graphics Capture could not start capturing window \"{title}\" ({WindowId(hwnd)}) [stage:start-capture] {Describe(ex)}",
                false);
        }
        return RunFrameLoop(
            "WINDOW",
            WindowId(hwnd),
            title,
            width,
            height,
            (_, _, timeoutMs) =>
            {
                if (closed || !NativeMethods.IsWindow(hwnd))
                {
                    throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The captured window disappeared.", true);
                }
                var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
                while (DateTime.UtcNow < deadline)
                {
                    if (latest.TryDequeue(out var jpeg) && jpeg.Length > 0)
                    {
                        return jpeg;
                    }
                    Thread.Sleep(20);
                }
                return latest.TryDequeue(out var fallback) ? fallback : Array.Empty<byte>();
            });
    }
}

static Direct3D11CaptureFramePool CreateFramePool(IDirect3DDevice winrtDevice, GraphicsCaptureItem item, string title, IntPtr hwnd)
{
    try
    {
        return Direct3D11CaptureFramePool.CreateFreeThreaded(
            winrtDevice,
            DirectXPixelFormat.B8G8R8A8UIntNormalized,
            2,
            item.Size);
    }
    catch (Exception ex)
    {
        throw new CaptureException(
            "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
            $"Windows Graphics Capture could not create the frame pool for window \"{title}\" ({WindowId(hwnd)}) [stage:frame-pool] {Describe(ex)}",
            false);
    }
}

static GraphicsCaptureSession CreateCaptureSession(Direct3D11CaptureFramePool pool, GraphicsCaptureItem item, string title, IntPtr hwnd)
{
    try
    {
        return pool.CreateCaptureSession(item);
    }
    catch (Exception ex)
    {
        throw new CaptureException(
            "NATIVE_WINDOWS_API_INITIALIZATION_FAILED",
            $"Windows Graphics Capture could not create the capture session for window \"{title}\" ({WindowId(hwnd)}) [stage:capture-session] {Describe(ex)}",
            false);
    }
}

static int RunFrameLoop(
    string source,
    string sourceId,
    string sourceLabel,
    int width,
    int height,
    Func<int, int, int, byte[]> acquireJpeg)
{
    var startedAt = DateTimeOffset.UtcNow.ToString("O");
    var sequence = 0L;
    var stopped = false;
    var errors = new ConcurrentQueue<Exception>();
    var scaled = ScaleSize(width, height, 1280);
    WriteRecord(new
    {
        recordType = "format",
        source,
        sourceId,
        sourceLabel,
        startedAt,
        format = VideoFormat(scaled.width, scaled.height),
    });

    var control = Task.Run(async () =>
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            var command = line.Trim().ToLowerInvariant();
            if (command == "stop" || command.StartsWith("abort", StringComparison.Ordinal))
            {
                stopped = true;
                return;
            }
        }
        stopped = true;
    });

    try
    {
        while (!stopped && !control.IsCompleted)
        {
            byte[] jpeg;
            try
            {
                jpeg = acquireJpeg(scaled.width, scaled.height, 250);
            }
            catch (CaptureException)
            {
                throw;
            }
            // SharpGenException.Descriptor is private in SharpGen.Runtime 2.2.0-beta (the version Vortice 3.6.2
            // depends on); ResultCode is the public accessor for the failing HRESULT (DXGI_ERROR_ACCESS_LOST).
            catch (SharpGen.Runtime.SharpGenException ex) when (ex.ResultCode == Vortice.DXGI.ResultCode.AccessLost)
            {
                throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The captured display was lost or its mode changed.", true);
            }
            if (jpeg.Length == 0)
            {
                Thread.Sleep(50);
                continue;
            }
            var record = new
            {
                recordType = "chunk",
                sequence = sequence++,
                timestamp = DateTimeOffset.UtcNow.ToString("O"),
                source,
                sourceId,
                format = VideoFormat(scaled.width, scaled.height),
                width = scaled.width,
                height = scaled.height,
                byteLength = jpeg.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(jpeg)).ToLowerInvariant(),
                dataBase64 = Convert.ToBase64String(jpeg),
            };
            WriteRecord(record);
            Thread.Sleep(150);
        }
        return 0;
    }
    catch (Exception ex)
    {
        errors.Enqueue(ex);
        throw;
    }
}

static byte[] AcquireDuplicationFrame(ID3D11Device device, IDXGIOutputDuplication duplication, int width, int height, int timeoutMs)
{
    // Vortice 3.6.2 maps C++ UINT to C# uint, so the DXGI timeout is a uint (AcquireNextFrame also returns
    // a Result because IDXGIOutputDuplication methods are generated with check="false").
    var result = duplication.AcquireNextFrame((uint)Math.Max(0, timeoutMs), out _, out var resource);
    if (result == Vortice.DXGI.ResultCode.WaitTimeout)
    {
        // No new desktop image yet: normal for Desktop Duplication, the caller retries.
        return Array.Empty<byte>();
    }
    if (result.Failure)
    {
        if (result == Vortice.DXGI.ResultCode.AccessLost)
        {
            throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "The captured display was lost or its mode changed.", true);
        }
        return Array.Empty<byte>();
    }
    if (resource is null)
    {
        // No frame was handed over, so there is nothing to release on the duplication object.
        return Array.Empty<byte>();
    }

    try
    {
        // A using(...) statement cannot host a `using var` declaration as its embedded statement (CS1023),
        // so the desktop resource gets an explicit block and every COM texture is scoped inside it.
        using (resource)
        {
            using var texture = resource.QueryInterface<ID3D11Texture2D>();
            if (texture is null)
            {
                return Array.Empty<byte>();
            }
            var desc = texture.Description;
            desc.Usage = ResourceUsage.Staging;
            desc.BindFlags = BindFlags.None;
            desc.CPUAccessFlags = CpuAccessFlags.Read;
            desc.MiscFlags = ResourceOptionFlags.None;
            desc.MipLevels = 1;
            desc.ArraySize = 1;
            desc.SampleDescription = new SampleDescription(1, 0);
            using var staging = device.CreateTexture2D(desc);
            device.ImmediateContext.CopyResource(staging, texture);
            var mapped = device.ImmediateContext.Map(staging, 0, MapMode.Read);
            try
            {
                return EncodeBgraJpeg(mapped.DataPointer, (int)mapped.RowPitch, (int)desc.Width, (int)desc.Height, width, height);
            }
            finally
            {
                device.ImmediateContext.Unmap(staging, 0);
            }
        }
    }
    finally
    {
        duplication.ReleaseFrame();
    }
}

static unsafe byte[] EncodeBgraJpeg(IntPtr data, int rowPitch, int srcWidth, int srcHeight, int destWidth, int destHeight)
{
    using var source = new Bitmap(srcWidth, srcHeight, PixelFormat.Format32bppArgb);
    var bits = source.LockBits(new Rectangle(0, 0, srcWidth, srcHeight), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try
    {
        var dest = (byte*)bits.Scan0;
        var src = (byte*)data;
        for (var y = 0; y < srcHeight; y++)
        {
            Buffer.MemoryCopy(src + (y * rowPitch), dest + (y * bits.Stride), bits.Stride, Math.Min(bits.Stride, srcWidth * 4));
        }
    }
    finally
    {
        source.UnlockBits(bits);
    }
    using var scaled = destWidth == srcWidth && destHeight == srcHeight
        ? source
        : new Bitmap(source, destWidth, destHeight);
    using var stream = new MemoryStream();
    var encoder = ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
    using var parameters = new EncoderParameters(1);
    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
    scaled.Save(stream, encoder, parameters);
    return stream.ToArray();
}

static byte[] EncodeSoftwareBitmap(Direct3D11CaptureFrame frame)
{
    using var bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask().GetAwaiter().GetResult();
    if (bitmap is null)
    {
        return Array.Empty<byte>();
    }
    using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
    var encoder = BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream).AsTask().GetAwaiter().GetResult();
    encoder.SetSoftwareBitmap(bitmap);
    encoder.BitmapTransform.ScaledWidth = (uint)ScaleSize(bitmap.PixelWidth, bitmap.PixelHeight, 1280).width;
    encoder.BitmapTransform.ScaledHeight = (uint)ScaleSize(bitmap.PixelWidth, bitmap.PixelHeight, 1280).height;
    encoder.FlushAsync().AsTask().GetAwaiter().GetResult();
    stream.Seek(0);
    var buffer = new Windows.Storage.Streams.Buffer((uint)stream.Size);
    stream.ReadAsync(buffer, (uint)stream.Size, Windows.Storage.Streams.InputStreamOptions.None).AsTask().GetAwaiter().GetResult();
    var bytes = new byte[buffer.Length];
    buffer.CopyTo(bytes);
    return bytes;
}

static IDirect3DDevice CreateWinRtDevice(ID3D11Device device)
{
    using var dxgi = device.QueryInterface<IDXGIDevice>();
    var hr = NativeMethods.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var inspectable);
    if (hr < 0 || inspectable == IntPtr.Zero)
    {
        throw new CaptureException("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", "Could not create a WinRT Direct3D device for Graphics Capture.", false);
    }
    try
    {
        // Canonical C#/WinRT RCW creation for an interface pointer returned by the OS interop
        // export CreateDirect3D11DeviceFromDXGIDevice: MarshalInterface<T>.FromAbi is the
        // documented .NET 6+ replacement for the obsolete
        // `Marshal.GetObjectForIUnknown(pUnknown) as IDirect3DDevice` pattern (CsWinRT interop
        // docs). The interop reference is released only after the RCW owns the object.
        return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
    }
    finally
    {
        Marshal.Release(inspectable);
    }
}

static GraphicsCaptureItem CreateCaptureItemForWindow(IntPtr hwnd)
{
    // CsWinRT interop rule: a ComImport interface must exchange ABI types (IntPtr), never projected
    // WinRT types. The CLR maps the native HRESULT to a COMException on failure and returns the
    // created item pointer as the method's result; the pointer is then wrapped with the projected
    // class's FromAbi and the interop reference is released.
    var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
    // Canonical IID of Windows.Graphics.Capture.IGraphicsCaptureItem, used verbatim by the
    // maintained C# WGC implementations (Starward, WindowsAppSDK interop samples).
    var itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    IntPtr itemPointer;
    try
    {
        itemPointer = interop.CreateForWindow(hwnd, ref itemIid);
    }
    catch (COMException ex)
    {
        throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", $"Windows Graphics Capture could not attach to the selected window (0x{ex.HResult:X8}).", true);
    }
    if (itemPointer == IntPtr.Zero)
    {
        throw new CaptureException("NATIVE_DEVICE_UNAVAILABLE", "Windows Graphics Capture returned no item for the selected window.", true);
    }
    try
    {
        return GraphicsCaptureItem.FromAbi(itemPointer);
    }
    finally
    {
        Marshal.Release(itemPointer);
    }
}

static bool TryFindOutput(IDXGIFactory1 factory, string? sourceId, out IDXGIAdapter1 adapter, out IDXGIOutput output, out string displayId, out string label)
{
    adapter = null!;
    output = null!;
    displayId = "";
    label = "";
    uint adapterIndex = 0;
    while (factory.EnumAdapters1(adapterIndex, out var candidateAdapter).Success)
    {
        adapterIndex++;
        if (candidateAdapter is null)
        {
            break;
        }
        uint outputIndex = 0;
        while (candidateAdapter.EnumOutputs(outputIndex, out var candidateOutput).Success)
        {
            outputIndex++;
            if (candidateOutput is null)
            {
                break;
            }
            var id = DisplayId(candidateOutput.Description.DeviceName);
            if (string.IsNullOrWhiteSpace(sourceId) || string.Equals(sourceId, id, StringComparison.OrdinalIgnoreCase))
            {
                adapter = candidateAdapter;
                output = candidateOutput;
                displayId = id;
                label = candidateOutput.Description.DeviceName;
                return true;
            }
            candidateOutput.Dispose();
        }
        candidateAdapter.Dispose();
    }
    return false;
}

static object VideoFormat(int width, int height) => new
{
    container = "AIWVID_JSONL",
    encoding = "JPEG",
    width,
    height,
    bitsPerPixel = 24,
    frameIntervalMs = 200,
};

static (int width, int height) ScaleSize(int width, int height, int maxWidth)
{
    if (width <= maxWidth || width <= 0 || height <= 0)
    {
        return (Math.Max(1, width), Math.Max(1, height));
    }
    var scaledHeight = Math.Max(1, (int)Math.Round(height * (maxWidth / (double)width)));
    return (maxWidth, scaledHeight);
}

static string DisplayId(string deviceName)
{
    var name = deviceName.Replace(@"\\.\", "", StringComparison.Ordinal).Replace("\\", "", StringComparison.Ordinal);
    if (string.IsNullOrWhiteSpace(name))
    {
        name = "DISPLAY";
    }
    return $"display:{name}";
}

static string WindowId(IntPtr hwnd) => $"hwnd:{hwnd.ToInt64():X}";

static bool TryParseWindowId(string sourceId, out IntPtr hwnd)
{
    hwnd = IntPtr.Zero;
    if (!sourceId.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }
    if (!long.TryParse(sourceId[5..], System.Globalization.NumberStyles.HexNumber, null, out var value))
    {
        return false;
    }
    hwnd = new IntPtr(value);
    return hwnd != IntPtr.Zero;
}

static bool IsCapturableWindow(IntPtr hwnd)
{
    if (!NativeMethods.IsWindow(hwnd) || !NativeMethods.IsWindowVisible(hwnd))
    {
        return false;
    }
    if (NativeMethods.GetWindowTextLength(hwnd) <= 0)
    {
        return false;
    }
    var style = NativeMethods.GetWindowLongPtr(hwnd, NativeMethods.GWL_EXSTYLE);
    if ((style.ToInt64() & NativeMethods.WS_EX_TOOLWINDOW) != 0)
    {
        return false;
    }
    if (NativeMethods.DwmGetWindowAttribute(hwnd, NativeMethods.DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0)
    {
        return false;
    }
    return true;
}

static string GetWindowTitle(IntPtr hwnd)
{
    var length = NativeMethods.GetWindowTextLength(hwnd);
    var builder = new StringBuilder(length + 1);
    NativeMethods.GetWindowText(hwnd, builder, builder.Capacity);
    return builder.ToString();
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

static void WriteRecord(object record)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(record));
    Console.Out.Flush();
}

static int Fail(string code, string message, bool retryable, int exitCode)
{
    Console.Out.WriteLine(JsonSerializer.Serialize(new
    {
        recordType = "error",
        code,
        message,
        retryable,
    }));
    Console.Error.WriteLine($"{code}: {message}");
    return exitCode;
}

// Enriches an unexpected .NET exception with its type, HRESULT, inner exceptions, the first stack
// frames and the OS build, so a failing stage can be identified from the error record alone when
// CsWinRT reports bare failures (for example E_NOINTERFACE mapped to InvalidCastException with the
// generic message "Specified cast is not valid.").
static string Describe(Exception ex)
{
    var builder = new StringBuilder();
    for (var current = ex; current is not null; current = current.InnerException)
    {
        if (builder.Length > 0)
        {
            builder.Append(" <-- ");
        }
        builder.Append(current.GetType().FullName);
        builder.Append(" 0x");
        builder.Append(current.HResult.ToString("X8"));
        builder.Append(": ");
        builder.Append(current.Message);
        if (!string.IsNullOrWhiteSpace(current.StackTrace))
        {
            var frames = current.StackTrace.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var frame in frames.Take(2))
            {
                builder.Append(" | ");
                builder.Append(frame);
            }
        }
    }
    builder.Append(" [os:");
    builder.Append(Environment.OSVersion.Version);
    builder.Append(']');
    return builder.ToString();
}

internal sealed class CaptureException : Exception
{
    public string Code { get; }
    public bool Retryable { get; }

    public CaptureException(string code, string message, bool retryable) : base(message)
    {
        Code = code;
        Retryable = retryable;
    }
}

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IGraphicsCaptureItemInterop
{
    // ABI-only signatures: parameters and return values are IntPtr because the CLR cannot marshal
    // projected WinRT types (or UnmanagedType.IInspectable directives) through a ComImport
    // interface on .NET Core+ ("Marshaling directives are invalid."). The non-PreserveSig return
    // value is the native [out, retval] item pointer; a failed HRESULT surfaces as COMException.
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

internal static class NativeMethods
{
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int DWMWA_CLOAKED = 14;

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice")]
    public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
