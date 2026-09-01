export class StorageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class DataRootValidationError extends StorageError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataRootValidationError";
  }
}

export class InsufficientDiskSpaceError extends StorageError {
  public readonly availableBytes: number | null;
  public readonly requiredBytes: number;

  public constructor(availableBytes: number | null, requiredBytes: number) {
    super(
      availableBytes === null
        ? `Available disk space could not be determined safely; recording is blocked (${formatBytes(requiredBytes)} required).`
        : `Insufficient disk space: ${formatBytes(availableBytes)} available, ${formatBytes(requiredBytes)} required.`,
    );
    this.name = "InsufficientDiskSpaceError";
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
  }
}

export class UnsafePathError extends StorageError {
  public constructor(path: string) {
    super(`Unsafe path rejected: ${path}`);
    this.name = "UnsafePathError";
  }
}

export class DuplicateMeetingError extends StorageError {
  public readonly meetingId?: string;

  public constructor(message: string, meetingId?: string) {
    super(message);
    this.name = "DuplicateMeetingError";
    if (meetingId !== undefined) {
      this.meetingId = meetingId;
    }
  }
}

export class MigrationVerificationError extends StorageError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationVerificationError";
  }
}

export class ArchiveSecurityError extends StorageError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchiveSecurityError";
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "unknown space";
  }
  return `${bytes.toLocaleString("en-US")} bytes`;
}
