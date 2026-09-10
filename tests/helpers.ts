import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore } from "../src/security/CredentialStore";
import { LocalFirstStore, type LocalFirstStoreOptions } from "../src/storage/LocalFirstStore";
import { removeDirectoryAfterSqliteClose } from "../src/storage/sqlite-lifecycle";

import type { LoopbackListener } from "../src/integrations/oauth/LoopbackOAuthCallbackServer";

export type DispatchableLoopbackListener = LoopbackListener & {
  dispatch(request: { url: string; host?: string; method?: string }): { status: number; html?: string };
};

export interface DispatchableLoopbackFactory {
  listenerFactory: (handle: (request: { url: string; host?: string; method?: string }) => { status: number; html?: string }) => Promise<DispatchableLoopbackListener>;
  /** The listener instance created for the running server. */
  created: DispatchableLoopbackListener | undefined;
  closeCalls: number;
}

/** Injectable loopback listener that lets tests simulate the browser callback. */
export function createDispatchableLoopbackFactory(port = 41730): DispatchableLoopbackFactory {
  const state: DispatchableLoopbackFactory = {
    listenerFactory: async () => {
      throw new Error("uninitialized");
    },
    created: undefined,
    closeCalls: 0,
  };
  state.listenerFactory = async (handle) => {
    const listener: DispatchableLoopbackListener = {
      port,
      redirectUri: `http://localhost:${port}/`,
      close: async () => {
        state.closeCalls += 1;
      },
      dispatch: (request) => handle(request),
    };
    state.created = listener;
    return listener;
  };
  return state;
}

/** In-memory CredentialStore double for tests that exercise secret handling. */
export function createFakeCredentialStore(): {
  store: CredentialStore;
  values: Map<string, string>;
  get: (service: string, account: string) => string | undefined;
} {
  const values = new Map<string, string>();
  return {
    store: {
      get: async (service, account) => values.get(`${service}:${account}`) ?? null,
      set: async (service, account, secret) => {
        values.set(`${service}:${account}`, secret);
      },
      delete: async (service, account) => {
        values.delete(`${service}:${account}`);
      },
    },
    values,
    get: (service, account) => values.get(`${service}:${account}`),
  };
}

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
    await removeDirectoryAfterSqliteClose(root);
  }
}

export async function temporaryDirectory(prefix = "ai-workmate-external-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
