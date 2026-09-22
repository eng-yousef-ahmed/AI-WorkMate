import { rm } from "node:fs/promises";

/**
 * SQLite on Windows keeps the .sqlite / WAL / SHM files locked until the
 * connection is checkpointed, switched off WAL, and closed. Call this from
 * the owner that opened DatabaseSync — never from a timed retry loop.
 */
export function releaseSqliteConnection(exec: (sql: string) => void, close: () => void): void {
  try {
    exec("PRAGMA wal_checkpoint(TRUNCATE);");
    exec("PRAGMA journal_mode = DELETE;");
  } catch {
    // Still close so the native handle is dropped even if checkpoint fails.
  }
  close();
}

/** Remove a directory after every SQLite owner for that tree has closed. */
export async function removeDirectoryAfterSqliteClose(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
