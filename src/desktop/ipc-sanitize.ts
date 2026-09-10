import {
  ArchiveSecurityError,
  InsufficientDiskSpaceError,
  StorageError,
  UnsafePathError,
} from "../storage/errors";

const FILESYSTEM_LEAK_PATTERN =
  /(?:[A-Za-z]:(?:\\+|\/(?!\/))|\\\\|\/home\/|\/Users\/|\/tmp\/|\/var\/|file:\/\/|DATA_ROOT|Program Files|AppData|LOCALAPPDATA|Unsafe path rejected)/i;

/**
 * True when a message looks like it contains a filesystem path, DATA_ROOT, or
 * an unsafe-path rejection that must never cross into the renderer.
 */
export function rendererErrorContainsFilesystemLeak(message: string): boolean {
  return FILESYSTEM_LEAK_PATTERN.test(message);
}

export interface SanitizeRendererIpcErrorOptions {
  /** Extra application errors that may reach the renderer when path-free. */
  isAllowed?: (error: unknown) => boolean;
}

/**
 * Converts an IPC failure into a renderer-safe Error. Known application errors
 * keep their user-facing copy unless they embed a path. Unexpected errors and
 * path-bearing messages become `fallback`.
 */
export function sanitizeRendererIpcError(
  error: unknown,
  fallback: string,
  options: SanitizeRendererIpcErrorOptions = {},
): Error {
  if (error instanceof InsufficientDiskSpaceError) {
    return new StorageError("There is not enough free disk space to complete this action.");
  }
  if (error instanceof UnsafePathError) {
    return new StorageError("The selected path is not allowed.");
  }
  if (error instanceof Error && rendererErrorContainsFilesystemLeak(error.message)) {
    console.error("IPC error sanitized (filesystem details withheld)", error);
    if (error instanceof ArchiveSecurityError) {
      return new StorageError("The backup could not be verified and was not restored.");
    }
    return new StorageError(fallback);
  }
  if (error instanceof StorageError) {
    return error;
  }
  if (options.isAllowed?.(error) === true && error instanceof Error) {
    return error;
  }
  if (error instanceof Error) {
    console.error("IPC error", error);
  }
  return new StorageError(fallback);
}
