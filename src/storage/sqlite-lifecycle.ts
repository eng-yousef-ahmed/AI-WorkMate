import { rm } from "node:fs/promises";

/**
 * SQLite on Windows keeps the .sqlite / WAL / SHM files locked until the
 * connection is checkpointed, switched off WAL, and closed. Node's
 * DatabaseSync uses sqlite3_close_v2, so outstanding StatementSync objects
 * also keep the handle until they are collected.
 */
export function releaseSqliteConnection(exec: (sql: string) => void, close: () => void): void {
  try {
    exec("PRAGMA wal_checkpoint(TRUNCATE);");
    exec("PRAGMA journal_mode = DELETE;");
  } catch {
    // Best-effort: still close so the native handle is dropped.
  }
  close();
  collectNativeSqliteHandles();
}

export function isWindowsFileLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { code: unknown }).code);
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

/**
 * Remove a directory that previously held a SQLite database. Retries only while
 * the OS still reports the file as locked, yielding the event loop so native
 * close/finalizers can run. This is not a timed sleep.
 */
export async function removeDirectoryAfterSqliteClose(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      lastError = error;
      if (!isWindowsFileLockError(error)) {
        throw error;
      }
      if (attempt === 0 || attempt === 8 || attempt === 16) {
        collectNativeSqliteHandles();
      }
      await yieldEventLoop();
    }
  }
  throw lastError;
}

function collectNativeSqliteHandles(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
