import { DataRootValidationError, InsufficientDiskSpaceError } from "./errors";
import { getAvailableBytes } from "./LocalStorageService";

export type AvailableBytesForDirectory = (directory: string) => Promise<number | null>;

/**
 * Fail closed when the destination volume cannot be measured or does not have
 * `requiredBytes + marginBytes` free. Callers must pass the destination
 * directory — DATA_ROOT space is not a substitute for a backup/export drive.
 */
export async function assertDirectoryHasSpace(
  directory: string,
  requiredBytes: number,
  marginBytes: number,
  provider: AvailableBytesForDirectory = getAvailableBytes,
): Promise<void> {
  if (!Number.isFinite(requiredBytes) || requiredBytes < 0) {
    throw new DataRootValidationError("requiredBytes must be a non-negative finite number.");
  }
  if (!Number.isFinite(marginBytes) || marginBytes < 0) {
    throw new DataRootValidationError("spaceSafetyMarginBytes must be a non-negative finite number.");
  }
  const requiredWithMargin = requiredBytes + marginBytes;
  const availableBytes = await provider(directory);
  if (availableBytes === null || availableBytes < requiredWithMargin) {
    throw new InsufficientDiskSpaceError(availableBytes, requiredWithMargin);
  }
}
