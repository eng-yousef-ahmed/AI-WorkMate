import assert from "node:assert/strict";
import { test } from "node:test";

import { CalendarConnectionError, type CalendarConnectionStatus } from "../src/calendar/CalendarConnection";
import type { StorageRuntime } from "../src/storage/StorageRuntime";
import { CALENDAR_IPC_CHANNELS, type MicrosoftOAuthSettingsInput } from "../src/desktop/storage-api";
import { registerCalendarIpc } from "../src/desktop/calendar-ipc";

type IpcHandler = (...args: unknown[]) => unknown;

const AUTHORIZED_EVENT = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
const UNAUTHORIZED_EVENT = { sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

function invoke(handlers: Map<string, IpcHandler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve(handler(...args));
}

function connectedStatus(): CalendarConnectionStatus {
  return {
    provider: "MICROSOFT_GRAPH",
    state: "CONNECTED",
    account: { accountId: "user-1", displayName: "Ada Lovelace", email: "ada@example.com" },
    accessTokenExpiresAt: "2026-09-09T13:00:00.000Z",
  };
}

function register(
  runtime: StorageRuntime,
  overrides: {
    openExternal?: (url: string) => Promise<void>;
    saveOAuthApplicationConfig?: (input: MicrosoftOAuthSettingsInput) => Promise<void>;
  } = {},
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerCalendarIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime: runtime as StorageRuntime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
    openExternal: overrides.openExternal ?? (async () => undefined),
    saveOAuthApplicationConfig: overrides.saveOAuthApplicationConfig ?? (async () => undefined),
  });
  return handlers;
}

test("calendar IPC status routes to the runtime and reaches only the authorized renderer", async () => {
  let calls = 0;
  const handlers = register({ getMicrosoftCalendarStatus: async () => { calls += 1; return connectedStatus(); } } as unknown as StorageRuntime);

  const status = await invoke(handlers, CALENDAR_IPC_CHANNELS.getMicrosoftStatus, AUTHORIZED_EVENT);
  assert.equal(calls, 1);
  assert.deepEqual(status, connectedStatus());
  const statusJson = JSON.stringify(status);
  assert.equal(statusJson.includes("ada@example.com"), true); // non-secret identity is displayable
  assert.equal(statusJson.includes("refreshToken"), false);
  assert.equal(statusJson.includes("access_token"), false);
  assert.equal(statusJson.includes("accessTokenExpiresAt"), true); // expiry metadata only

  await assert.rejects(
    async () => invoke(handlers, CALENDAR_IPC_CHANNELS.getMicrosoftStatus, UNAUTHORIZED_EVENT),
    /unauthorized renderer/,
  );
  await assert.rejects(
    async () => invoke(handlers, CALENDAR_IPC_CHANNELS.getMicrosoftStatus, { ...AUTHORIZED_EVENT, senderFrame: { url: "https://evil.example" } }),
    /unauthorized renderer/,
  );
  assert.equal(calls, 1); // the authorized call is the only one that reached the runtime
});

test("begin sign-in opens the authorization URL in the default browser", async () => {
  const opened: string[] = [];
  const handlers = register(
    {
      beginMicrosoftCalendarSignIn: async () => ({
        flowId: "flow-1",
        provider: "MICROSOFT_GRAPH" as const,
        authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&state=s1",
        redirectUri: "http://localhost:49321",
        startedAt: "2026-09-09T12:00:00.000Z",
        expiresAt: "2026-09-09T12:05:00.000Z",
        autoCapture: true,
      }),
    } as unknown as StorageRuntime,
    { openExternal: async (url) => { opened.push(url); } },
  );

  const result = await invoke(handlers, CALENDAR_IPC_CHANNELS.beginMicrosoftSignIn, AUTHORIZED_EVENT);
  assert.deepEqual(opened, ["https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&state=s1"]);
  assert.equal((result as { flowId: string }).flowId, "flow-1");

  // A browser failure must still tell the user how to finish (URL is not secret).
  const blocked = register(
    {
      beginMicrosoftCalendarSignIn: async () => ({
        flowId: "flow-2",
        provider: "MICROSOFT_GRAPH" as const,
        authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&state=s2",
        redirectUri: "http://localhost:49321",
        startedAt: "2026-09-09T12:00:00.000Z",
        expiresAt: "2026-09-09T12:05:00.000Z",
        autoCapture: true,
      }),
    } as unknown as StorageRuntime,
    { openExternal: async () => { throw new Error("no default browser"); } },
  );
  await assert.rejects(
    invoke(blocked, CALENDAR_IPC_CHANNELS.beginMicrosoftSignIn, AUTHORIZED_EVENT),
    /open this address in your browser/i,
  );
});

test("complete sign-in validates the renderer input before touching the runtime", async () => {
  const received: unknown[] = [];
  const handlers = register({
    completeMicrosoftCalendarSignIn: async (input: unknown) => { received.push(input); return connectedStatus(); },
  } as unknown as StorageRuntime);

  const status = await invoke(handlers, CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn, AUTHORIZED_EVENT, {
    flowId: "flow-1",
    redirectUrl: "http://localhost:49321/?code=abc&state=xyz",
  });
  assert.equal(received.length, 1);
  assert.deepEqual(status, connectedStatus());

  for (const invalid of [
    { flowId: "flow-1" },
    { redirectUrl: "http://localhost:49321/?code=abc&state=xyz" },
    { flowId: "", redirectUrl: "http://localhost/?code=abc" },
    { flowId: "flow-1", redirectUrl: "file:///etc/passwd" },
    { flowId: "flow-1", redirectUrl: "javascript:alert(1)" },
    "not-an-object",
    { flowId: "flow-1", redirectUrl: `http://localhost/?code=${"x".repeat(9000)}` },
  ]) {
    await assert.rejects(
      invoke(handlers, CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn, AUTHORIZED_EVENT, invalid),
      /invalid/i,
    );
  }
  assert.equal(received.length, 1); // none of the invalid inputs reached the runtime
});

test("cancel and disconnect route through the runtime and reflect the resulting status", async () => {
  const handlers = register({
    cancelMicrosoftCalendarSignIn: async () => undefined,
    disconnectMicrosoftCalendar: async () => ({ provider: "MICROSOFT_GRAPH" as const, state: "DISCONNECTED" as const }),
    getMicrosoftCalendarStatus: async () => ({ provider: "MICROSOFT_GRAPH" as const, state: "DISCONNECTED" as const }),
  } as unknown as StorageRuntime);

  const afterCancel = await invoke(handlers, CALENDAR_IPC_CHANNELS.cancelMicrosoftSignIn, AUTHORIZED_EVENT);
  assert.equal((afterCancel as CalendarConnectionStatus).state, "DISCONNECTED");
  const afterDisconnect = await invoke(handlers, CALENDAR_IPC_CHANNELS.disconnectMicrosoft, AUTHORIZED_EVENT);
  assert.equal((afterDisconnect as CalendarConnectionStatus).state, "DISCONNECTED");
});

test("auto sync results are renderer-safe counters that never include cursors or error details", async () => {
  const handlers = register({
    syncMicrosoftCalendarAuto: async () => ({
      provider: "MICROSOFT_GRAPH" as const,
      mode: "DELTA" as const,
      createdCount: 1,
      updatedCount: 2,
      unchangedCount: 3,
      cancelledCount: 0,
      deletedCount: 1,
      movedOutCount: 0,
      deltaCursorAdvanced: true,
      errorCount: 0,
      errors: [],
      deltaCursor: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=SECRET_CURSOR",
      windowStart: "2026-08-01T00:00:00.000Z",
    }),
  } as unknown as StorageRuntime);

  const result = await invoke(handlers, CALENDAR_IPC_CHANNELS.syncMicrosoftCalendarAuto, AUTHORIZED_EVENT);
  assert.deepEqual(result, {
    provider: "MICROSOFT_GRAPH",
    mode: "DELTA",
    createdCount: 1,
    updatedCount: 2,
    unchangedCount: 3,
    cancelledCount: 0,
    deletedCount: 1,
    movedOutCount: 0,
    deltaCursorAdvanced: true,
    errorCount: 0,
    errors: [],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("SECRET_CURSOR"), false);
  assert.equal(serialized.includes("windowStart"), false);

  // Runtime failure becomes a fixed availability error, never the raw message.
  const failing = register({
    syncMicrosoftCalendarAuto: async () => { throw new Error("Graph said InvalidAuthenticationToken access_token=supersecret"); },
  } as unknown as StorageRuntime);
  const failedResult = await invoke(failing, CALENDAR_IPC_CHANNELS.syncMicrosoftCalendarAuto, AUTHORIZED_EVENT);
  assert.deepEqual(failedResult, {
    provider: "MICROSOFT_GRAPH",
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    cancelledCount: 0,
    errorCount: 1,
    errors: [{ code: "MICROSOFT_CALENDAR_SYNC_UNAVAILABLE", retryable: false }],
  });
  assert.equal(JSON.stringify(failedResult).includes("supersecret"), false);
});

test("saving the OAuth config validates input, persists settings, and returns the new status", async () => {
  const saved: MicrosoftOAuthSettingsInput[] = [];
  const handlers = register(
    { getMicrosoftCalendarStatus: async () => connectedStatus() } as unknown as StorageRuntime,
    {
      saveOAuthApplicationConfig: async (input) => { saved.push(input); },
    },
  );

  const status = await invoke(handlers, CALENDAR_IPC_CHANNELS.saveMicrosoftOAuthConfig, AUTHORIZED_EVENT, {
    clientId: " 11111111-1111-1111-1111-111111111111 ",
    tenant: " common ",
    redirectUri: "",
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { clientId: "11111111-1111-1111-1111-111111111111", tenant: "common", redirectUri: "" });
  assert.equal((status as CalendarConnectionStatus).state, "CONNECTED");

  const untouched = saved.length;
  for (const invalid of [{ clientId: 123 }, { tenant: ["common"] }, "clientId", null, { clientId: "x".repeat(600) }]) {
    await assert.rejects(
      invoke(handlers, CALENDAR_IPC_CHANNELS.saveMicrosoftOAuthConfig, AUTHORIZED_EVENT, invalid),
      /invalid/i,
    );
  }
  assert.equal(saved.length, untouched);
});

test("unexpected main-process errors cross IPC only as sanitized messages", async () => {
  const handlers = register({
    disconnectMicrosoftCalendar: async () => {
      throw new Error("EACCES: permission denied, open '/home/secret/credential-vault.json'");
    },
  } as unknown as StorageRuntime);
  await assert.rejects(
    invoke(handlers, CALENDAR_IPC_CHANNELS.disconnectMicrosoft, AUTHORIZED_EVENT),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes("/home/secret"), false);
      assert.equal(message.includes("credential-vault"), false);
      assert.match(message, /could not be completed/i);
      return true;
    },
  );

  // Known connection errors keep their fixed, pre-written messages.
  const known = register({
    completeMicrosoftCalendarSignIn: async () => {
      throw new CalendarConnectionError("MICROSOFT_SIGNIN_EXPIRED", "The sign-in window expired. Please start again.", false);
    },
  } as unknown as StorageRuntime);
  await assert.rejects(
    invoke(known, CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn, AUTHORIZED_EVENT, {
      flowId: "flow-1",
      redirectUrl: "http://localhost/?code=abc&state=xyz",
    }),
    /sign-in window expired/i,
  );
});
