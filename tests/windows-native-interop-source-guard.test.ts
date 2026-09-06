import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Linux-safe guard for the native WGC/WinRT interop boundary. The helper is
 * .NET/Windows-only and cannot be compiled in this sandbox, so the test pins
 * the source-level contract that fixed the real-Windows failure
 * "Marshaling directives are invalid." (the CLR cannot marshal projected WinRT
 * types through a ComImport interface on .NET Core+).
 */
const PROGRAM_CS_PATH = join(process.cwd(), "native", "windows-screen", "Program.cs");

test("WGC interop declaration uses ABI IntPtr signatures, never projected types with MarshalAs(IInspectable)", async () => {
  const source = await readFile(PROGRAM_CS_PATH, "utf8");
  assert.ok(source.length > 0, "Program.cs must exist and be non-empty");
  assert.ok(
    !source.includes("[MarshalAs(UnmanagedType.IInspectable)]"),
    "ComImport interface must not carry a MarshalAs(IInspectable) directive on a projected WinRT type",
  );
  assert.ok(
    !source.includes("out GraphicsCaptureItem result"),
    "ComImport interface must not return a projected GraphicsCaptureItem by out parameter",
  );
  assert.ok(!source.includes("[PreserveSig]"), "ComImport interop methods rely on the CLR HRESULT mapping");
  assert.ok(
    source.includes("IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);"),
    "CreateForWindow must declare an ABI IntPtr signature",
  );
  assert.ok(
    source.includes("IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);"),
    "CreateForMonitor must declare an ABI IntPtr signature",
  );
  assert.ok(
    source.includes('[System.Runtime.InteropServices.Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]'),
    "The ComImport interface Guid attribute must be explicitly qualified to System.Runtime.InteropServices",
  );
  assert.ok(
    !source.includes("[Guid("),
    "A bare [Guid( attribute would be ambiguous (CS0104) once Windows.Foundation.Metadata is imported for ApiInformation",
  );
  assert.ok(source.includes("GraphicsCaptureItem.FromAbi(itemPointer)"), "The returned pointer must be wrapped with GraphicsCaptureItem.FromAbi");
  assert.ok(source.includes("catch (COMException ex)"), "Interop failures must be mapped through COMException");
});

test("WGC device/API handling uses canonical CsWinRT conversions, API guards, and stage-tagged failures", async () => {
  const source = await readFile(PROGRAM_CS_PATH, "utf8");
  assert.ok(
    source.includes("return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);"),
    "The WinRT D3D device must be created with the canonical CsWinRT MarshalInterface<T>.FromAbi conversion",
  );
  assert.ok(
    !source.includes("MarshalInspectable<IDirect3DDevice>"),
    "The WinRT D3D device must not be created through MarshalInspectable<IDirect3DDevice> (MarshalInterface<T>.FromAbi is the documented interop form)",
  );
  assert.ok(
    source.includes('new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760")'),
    "CreateForWindow must be called with the canonical IGraphicsCaptureItem IID constant",
  );
  assert.ok(
    !source.includes("typeof(GraphicsCaptureItem).GUID"),
    "The item IID must not be derived from typeof(GraphicsCaptureItem).GUID",
  );
  assert.ok(
    source.includes('ApiInformation.IsTypePresent("Windows.Graphics.Capture.GraphicsCaptureItem")'),
    "WGC availability must be pre-flighted with ApiInformation.IsTypePresent",
  );
  assert.ok(
    source.includes('ApiInformation.IsMethodPresent("Windows.Graphics.Capture.Direct3D11CaptureFramePool", "CreateFreeThreaded", 4)'),
    "CreateFreeThreaded availability must be pre-flighted (E_NOINTERFACE from a missing API surfaces as InvalidCastException)",
  );
  assert.ok(
    source.includes('ApiInformation.IsMethodPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "StartCapture", 0)'),
    "StartCapture availability must be pre-flighted",
  );
  assert.ok(
    source.includes("static string Describe(Exception ex)"),
    "Unexpected exceptions must be enriched with type/HRESULT/stack/OS so the failing stage is identifiable",
  );
  for (const stage of [
    "[stage:D3D11CreateDevice]",
    "[stage:CreateWinRtDevice]",
    "[stage:item-interop]",
    "[stage:frame-pool]",
    "[stage:capture-session]",
    "[stage:start-capture]",
    "[stage:is-supported]",
    "[stage:monitor-resolve]",
    "[stage:adapter-select]",
  ]) {
    assert.ok(source.includes(stage), `WGC init failures must be tagged with ${stage}`);
  }
});

test("WGC WINDOW zero-frame pipeline is adapter-bound, rooted, instrumented, and never silently swallows frame delivery failure", async () => {
  const source = await readFile(PROGRAM_CS_PATH, "utf8");
  // The D3D11 device must be bound to the DXGI adapter of the window's monitor (the same
  // binding the Windows-verified SCREEN path uses); a default-adapter device silently
  // receives no WGC frames on multi-GPU machines.
  assert.ok(
    source.includes("NativeMethods.IsIconic(hwnd)"),
    "Minimized windows must be excluded from enumeration: WGC never delivers frames for them",
  );
  assert.ok(
    source.includes("MonitorFromWindow(hwnd, NativeMethods.MONITOR_DEFAULTTONEAREST)"),
    "WGC device selection must resolve the window's monitor",
  );
  assert.ok(
    source.includes("GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi)"),
    "WGC device selection must read the monitor device name to find its DXGI output/adapter",
  );
  assert.ok(
    source.includes('ApiInformation.IsMethodPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsSupported", 0)'),
    "WGC support must be pre-flighted with GraphicsCaptureSession.IsSupported (RDP/basic adapters StartCapture silently and deliver nothing)",
  );
  // Strong process-lifetime roots: FrameArrived is delivered asynchronously on the pool
  // thread, so item/pool/session/device must outlive the synchronous capture loop.
  assert.ok(source.includes("internal static class WindowCaptureRoots"), "WGC session graph must have process-lifetime roots");
  assert.ok(source.includes("WindowCaptureRoots.Clear()"), "WGC session roots must be released after the capture loop");
  // Every delivery stage must be counted and reported, never swallowed: the zero-frame
  // failure carries structured counters through the error record state.
  for (const counter of [
    "frameArrivedCount = FrameArrivedCount",
    "tryGetNextFrameCount = TryGetNextFrameCount",
    "frameAcquiredCount = FrameAcquiredCount",
    "readbackCount = ReadbackCount",
    "jpegEncodedCount = JpegEncodedCount",
    "encodeFailureCount = EncodeFailureCount",
  ]) {
    assert.ok(source.includes(counter), `WGC pipeline state must report ${counter.split(" ")[0]}`);
  }
  assert.ok(source.includes("state.ToRecord()"), "The zero-frame error must attach the structured pipeline state");
  assert.ok(source.includes("startCaptureSucceeded = StartCaptureSucceeded"), "Pipeline state must report whether StartCapture succeeded");
  assert.ok(source.includes("HandleWindowFrameArrived(sender, state)"), "FrameArrived must dispatch into the counted, non-swallowing handler");
  assert.ok(
    source.includes('stage = state.FrameArrivedCount == 0 ? "frame-arrival"'),
    "The zero-frame failure must name the exact WGC stage where delivery stopped",
  );
  assert.ok(
    source.includes("NATIVE_CAPTURE_STREAM_FAILED") && source.includes("delivered no JPEG frames"),
    "A silent zero-frame session must fail closed with a stage-precise native error",
  );
});
