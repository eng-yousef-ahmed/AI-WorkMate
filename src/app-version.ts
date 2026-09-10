import { StorageError } from "./storage/errors";

/**
 * Application version recorded in `storage-config.json` after a successful
 * open. Must stay aligned with `package.json` `version` (enforced by tests).
 */
export const APP_VERSION = "0.1.0";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseAppVersion(value: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new StorageError("The application version is invalid.");
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every((part) => Number.isInteger(part) && part >= 0)) {
    throw new StorageError("The application version is invalid.");
  }
  return [major, minor, patch];
}

/** Negative when `left` is older than `right`. */
export function compareAppVersions(left: string, right: string): number {
  const leftParts = parseAppVersion(left);
  const rightParts = parseAppVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Fail closed when this binary is older than the workspace's last successful
 * open. Opening a newer schema/layout with an older build can corrupt data.
 */
export function assertAppVersionCompatible(lastOpenedAppVersion: string | undefined, currentAppVersion: string): void {
  parseAppVersion(currentAppVersion);
  if (lastOpenedAppVersion === undefined || lastOpenedAppVersion.length === 0) {
    return;
  }
  if (compareAppVersions(lastOpenedAppVersion, currentAppVersion) > 0) {
    throw new StorageError(
      "This workspace was last opened by a newer AI WorkMate version and cannot be opened by this build.",
    );
  }
}
