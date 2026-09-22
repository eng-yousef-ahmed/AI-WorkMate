import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import {
  isAllowedLoopbackHost,
  parseLoopbackCallback,
  startLoopbackCallbackServer,
  type LoopbackListener,
} from "../src/integrations/oauth/LoopbackOAuthCallbackServer";

test("loopback host validation only accepts localhost and 127.0.0.1", () => {
  assert.equal(isAllowedLoopbackHost("localhost"), true);
  assert.equal(isAllowedLoopbackHost("localhost:34567"), true);
  assert.equal(isAllowedLoopbackHost("127.0.0.1"), true);
  assert.equal(isAllowedLoopbackHost("127.0.0.1:34567"), true);
  assert.equal(isAllowedLoopbackHost("LOCALHOST"), true);
  assert.equal(isAllowedLoopbackHost("evil.example.com"), false);
  assert.equal(isAllowedLoopbackHost("localhost.evil.example.com"), false);
  assert.equal(isAllowedLoopbackHost("127.0.0.2"), false);
  assert.equal(isAllowedLoopbackHost(undefined), false);
  assert.equal(isAllowedLoopbackHost(""), false);
});

test("callback parsing accepts only the root path with code and state", () => {
  const valid = parseLoopbackCallback({
    url: "/?code=abc&state=xyz",
    host: "localhost:41234",
  });
  assert.equal(valid.accepted, true);
  if (valid.accepted) {
    assert.deepEqual(valid.callback, { redirectUrl: "/?code=abc&state=xyz" });
  }

  assert.equal(parseLoopbackCallback({ url: "/callback?code=abc&state=xyz", host: "localhost:1" }).accepted, false);
  assert.equal(parseLoopbackCallback({ url: "/?code=abc", host: "localhost:1" }).accepted, false);
  assert.equal(parseLoopbackCallback({ url: "/?state=xyz", host: "localhost:1" }).accepted, false);
  assert.equal(parseLoopbackCallback({ url: "/?code=abc&state=xyz", host: "attacker.com" }).accepted, false);
});

test("callback parsing surfaces provider error parameters", () => {
  const parsed = parseLoopbackCallback({
    url: "/?error=access_denied&error_description=The+user+cancelled",
    host: "localhost:1",
  });
  assert.equal(parsed.accepted, true);
  if (parsed.accepted) {
    assert.deepEqual(parsed.callback.providerError, {
      code: "access_denied",
      description: "The user cancelled",
    });
  }
});

interface DispatchableLoopbackListener extends LoopbackListener {
  dispatch(request: { url: string; host?: string; method?: string }): { status: number; html?: string };
}

interface DispatchableFactory {
  listenerFactory: (handle: (request: { url: string; host?: string; method?: string }) => { status: number; html?: string }) => Promise<DispatchableLoopbackListener>;
  /** The listener instance created for the running server. */
  created: DispatchableLoopbackListener | undefined;
  closeCalls: number;
}

function createDispatchableFactory(): DispatchableFactory {
  const state: DispatchableFactory = {
    listenerFactory: async () => {
      throw new Error("uninitialized");
    },
    created: undefined,
    closeCalls: 0,
  };
  state.listenerFactory = async (handle) => {
    const listener: DispatchableLoopbackListener = {
      port: 41730,
      redirectUri: "http://localhost:41730/",
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

test("startLoopbackCallbackServer resolves with the captured redirect URL", async () => {
  const factory = createDispatchableFactory();
  const server = await startLoopbackCallbackServer({
    timeoutMs: 5000,
    listenerFactory: factory.listenerFactory,
  });
  assert.equal(server.port, 41730);
  assert.equal(server.redirectUri, "http://localhost:41730/");
  assert.ok(factory.created);

  const captured = factory.created!.dispatch({
    url: "/?code=secret-code&state=secret-state",
    host: "localhost:41730",
  });
  assert.equal(captured.status, 200);
  assert.match(captured.html ?? "", /sign-in complete/i);

  const callback = await server.callback;
  assert.deepEqual(callback, { redirectUrl: "/?code=secret-code&state=secret-state" });
  await server.close();
  assert.equal(factory.closeCalls, 1);
});

test("loopback server rejects non-GET methods, foreign hosts, and bad paths", async () => {
  const factory = createDispatchableFactory();
  const server = await startLoopbackCallbackServer({
    timeoutMs: 5000,
    listenerFactory: factory.listenerFactory,
  });
  assert.ok(factory.created);
  const dispatch = (url: string, extra?: { host?: string; method?: string }) =>
    factory.created!.dispatch({ url, host: extra?.host ?? "localhost:41730", method: extra?.method });

  assert.equal(dispatch("/?code=a&state=b", { method: "POST" }).status, 405);
  assert.equal(dispatch("/?code=a&state=b", { host: "attacker.com" }).status, 403);
  assert.equal(dispatch("/other?code=a&state=b").status, 404);
  assert.equal(dispatch("/?code=a").status, 400);
  await server.close();
});

test("startLoopbackCallbackServer times out when no callback arrives", async () => {
  const server = await startLoopbackCallbackServer({
    timeoutMs: 40,
    listenerFactory: async () => ({
      port: 0,
      redirectUri: "http://localhost:0/",
      close: async () => undefined,
    }),
  });
  await assert.rejects(server.callback, /expired/);
});

test("startLoopbackCallbackServer rejects when cancelled via AbortSignal", async () => {
  const controller = new AbortController();
  const server = await startLoopbackCallbackServer({
    timeoutMs: 10_000,
    signal: controller.signal,
    listenerFactory: async () => ({
      port: 0,
      redirectUri: "http://localhost:0/",
      close: async () => undefined,
    }),
  });
  controller.abort();
  await assert.rejects(server.callback, /cancelled/);
});

test("server already cancelled at start throws immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startLoopbackCallbackServer({ signal: controller.signal }),
    /cancelled/,
  );
});

test("real-socket loopback server captures a genuine localhost callback", async () => {
  const server = await startLoopbackCallbackServer({ timeoutMs: 5000 });
  const url = new URL(server.redirectUri);
  assert.equal(url.hostname, "localhost");
  assert.equal(url.protocol, "http:");

  // Connect to 127.0.0.1 while presenting the localhost Host header, exactly
  // like a local browser would after the provider redirect.
  const response = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: url.port,
        path: "/?code=real-code&state=real-state",
        method: "GET",
        headers: { host: `localhost:${url.port}` },
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ statusCode: incoming.statusCode, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(response.statusCode, 200);

  const callback = await server.callback;
  assert.ok(callback.redirectUrl.includes("code=real-code"));
  assert.ok(callback.redirectUrl.includes("state=real-state"));
  await server.close();
});

test("real-socket loopback server refuses a foreign Host header", async () => {
  const server = await startLoopbackCallbackServer({ timeoutMs: 5000 });
  const url = new URL(server.redirectUri);
  const statusCode = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: url.port,
        path: "/?code=evil&state=evil",
        method: "GET",
        headers: { host: "attacker.example.com" },
      },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => resolve(incoming.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(statusCode, 403);
  // The flow must stay pending (no callback, no crash), then time out.
  const outcome = await Promise.race([
    server.callback.then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
  ]);
  assert.equal(outcome, "pending");
  await server.close();
});
