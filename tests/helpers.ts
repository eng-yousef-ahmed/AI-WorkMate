import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFirstStore, type LocalFirstStoreOptions } from "../src/storage/LocalFirstStore";

export async function withTempStore<T>(
  callback: (store: LocalFirstStore, root: string) => Promise<T>,
  options: LocalFirstStoreOptions = { spaceSafetyMarginBytes: 0 },
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-test-"));
  const store = new LocalFirstStore(root, options);
  await store.initialize();
  try {
    return await callback(store, root);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

export async function temporaryDirectory(prefix = "ai-workmate-external-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
