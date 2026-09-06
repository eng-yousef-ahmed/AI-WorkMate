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
  assert.ok(source.includes("GraphicsCaptureItem.FromAbi(itemPointer)"), "The returned pointer must be wrapped with GraphicsCaptureItem.FromAbi");
  assert.ok(source.includes("catch (COMException ex)"), "Interop failures must be mapped through COMException");
});
