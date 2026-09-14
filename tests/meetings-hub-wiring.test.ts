import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import type { HubCaptureCapabilities, HubMeetingSummary, MeetingHubOverview } from "../src/domain/hub";

const RENDERER_DIR = join(process.cwd(), "dist/src/renderer");
const HTML_PATH = join(RENDERER_DIR, "storage-settings.html");
const HUB_JS_PATH = join(RENDERER_DIR, "meetings-hub.js");

const REFRESH_LABEL = "↻ Refresh";

function summary(id: string, title: string): HubMeetingSummary {
  return {
    meetingId: id,
    title,
    meetingDate: "2026-09-14",
    status: "SCHEDULED",
    createdAt: "2026-09-14T07:00:00.000Z",
    updatedAt: "2026-09-14T07:00:00.000Z",
    isActive: false,
    artifactCount: 0,
    hasRecording: false,
    hasTranscript: false,
    hasAnalysis: false,
  };
}

function overviewWith(today: HubMeetingSummary[]): MeetingHubOverview {
  return {
    serverTime: "2026-09-14T08:00:00.000Z",
    todayLabel: "Monday",
    today,
    upcoming: [],
    recent: [],
    historyTotal: 0,
  };
}

function fullCaps(): HubCaptureCapabilities {
  return { supported: true, microphone: true, systemLoopback: true, screen: true, window: true };
}

test("Meetings Refresh invokes the real hub load and visibly updates the page", async () => {
  let calls = 0;
  const harness = bootHub({
    getOverview: () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? overviewWith([]) : overviewWith([summary("meeting-1", "Standup")]));
    },
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      harness.element("hub-refresh-button").disabled === false &&
      harness.element("hub-today-count").textContent === "0",
    "initial hub load",
  );

  const refresh = harness.element("hub-refresh-button");
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.textContent, REFRESH_LABEL);
  assert.equal(harness.element("hub-today-count").textContent, "0");
  assert.equal(harness.element("hub-capture-status").textContent, "Local capture ready (microphone, system audio, screen, window)");

  harness.click("hub-refresh-button");
  await harness.waitFor(
    () =>
      harness.calls.overview === 2 &&
      harness.element("hub-refresh-button").disabled === false &&
      harness.element("hub-today-count").textContent === "1",
    "manual refresh reload",
  );

  // Fresh IPC data re-rendered: counts, lists, and capture status all update.
  assert.equal(harness.calls.captureCapabilities, 2);
  assert.equal(harness.element("hub-today-count").textContent, "1");
  assert.equal(harness.element("hub-today").children.length, 1);
  assert.equal(harness.element("hub-capture-status").textContent, "Local capture ready (microphone, system audio, screen, window)");
  // Success is confirmed only after the real load resolved and rendered.
  assert.equal(harness.element("hub-notice").textContent, "Meeting hub refreshed.");
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.textContent, REFRESH_LABEL);
});

test("Meetings Refresh shows a loading state and never fakes success while busy", async () => {
  let release: ((value: MeetingHubOverview) => void) | undefined;
  let calls = 0;
  const harness = bootHub({
    getOverview: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(overviewWith([]));
      }
      return new Promise<MeetingHubOverview>((resolve) => {
        release = resolve;
      });
    },
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      harness.element("hub-refresh-button").disabled === false &&
      harness.element("hub-today-count").textContent === "0",
    "initial hub load",
  );
  const refresh = harness.element("hub-refresh-button");

  harness.click("hub-refresh-button");
  await tick();
  // The click invoked the real load and the button visibly reflects it;
  // no success notice appears before the IPC resolves.
  assert.equal(harness.calls.overview, 2);
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.textContent, "↻ Refreshing…");
  assert.notEqual(harness.element("hub-notice").textContent, "Meeting hub refreshed.");

  // A second click while busy triggers no new IPC and says so truthfully.
  harness.click("hub-refresh-button");
  await tick();
  assert.equal(harness.calls.overview, 2);
  assert.equal(harness.element("hub-notice").textContent, "A refresh is already in progress…");

  assert.ok(release !== undefined, "deferred overview must be releasable");
  release(overviewWith([summary("meeting-2", "Planning")]));
  await harness.waitFor(() => refresh.disabled === false, "refresh settle");
  assert.equal(harness.element("hub-today-count").textContent, "1");
  assert.equal(harness.element("hub-notice").textContent, "Meeting hub refreshed.");
  assert.equal(refresh.textContent, REFRESH_LABEL);
});

test("Meetings Refresh surfaces hub errors safely without fake success", async () => {
  let calls = 0;
  const harness = bootHub({
    getOverview: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(overviewWith([]));
      }
      return Promise.reject(new Error("Choose a local data location before using the meeting hub."));
    },
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      harness.element("hub-refresh-button").disabled === false &&
      harness.element("hub-today-count").textContent === "0",
    "initial hub load",
  );
  const refresh = harness.element("hub-refresh-button");

  harness.click("hub-refresh-button");
  await harness.waitFor(() => harness.calls.overview === 2, "failing refresh invoked");
  await harness.waitFor(() => refresh.disabled === false, "failing refresh settle");

  assert.equal(harness.element("hub-notice").textContent, "Choose a local data location before using the meeting hub.");
  assert.equal(refresh.textContent, REFRESH_LABEL);
});

test("Local capture status is a non-interactive readiness indicator", async () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const tag = html.match(/<(span|button|a)[^>]*id="hub-capture-status"[^>]*>/);
  assert.ok(tag !== null, "hub-capture-status element must exist in the packaged HTML");
  assert.equal(tag[1], "span", "capture status must be a span, not a button/link");
  assert.match(tag[0], /role="status"/, "capture status must expose role=status");

  const harness = bootHub({
    getOverview: () => Promise.resolve(overviewWith([])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      harness.element("hub-refresh-button").disabled === false &&
      harness.element("hub-today-count").textContent === "0",
    "initial hub load",
  );

  // The real script attaches no click action to the indicator.
  assert.equal(harness.element("hub-capture-status").listenerCount("click"), 0);
  assert.equal(harness.element("hub-capture-status").listenerCount("keydown"), 0);

  const beforeOverview = harness.calls.overview;
  const beforeCaps = harness.calls.captureCapabilities;
  const beforeHash = harness.location.hash;
  const beforeNotice = harness.element("hub-notice").textContent;
  harness.click("hub-capture-status");
  await tick();
  await tick();

  assert.equal(harness.calls.overview, beforeOverview, "clicking the status must not reload");
  assert.equal(harness.calls.captureCapabilities, beforeCaps, "clicking the status must not rediscover");
  assert.equal(harness.location.hash, beforeHash, "clicking the status must not navigate");
  assert.equal(harness.element("hub-notice").textContent, beforeNotice, "clicking the status must not announce");
  // Indicator behavior itself is preserved from the real discovery result.
  assert.equal(harness.element("hub-capture-status").textContent, "Local capture ready (microphone, system audio, screen, window)");
});

// --- Harness: boots the real packaged meetings-hub.js with a fake DOM --------

interface HubBootOptions {
  getOverview: () => Promise<MeetingHubOverview>;
  getCaptureCapabilities: () => Promise<HubCaptureCapabilities>;
}

interface HubHarness {
  element(id: string): FakeHubElement;
  click(id: string): void;
  waitFor(condition: () => boolean, label: string): Promise<void>;
  calls: { overview: number; captureCapabilities: number };
  location: { hash: string };
}

function bootHub(options: HubBootOptions): HubHarness {
  const calls = { overview: 0, captureCapabilities: 0 };
  const elements = new Map<string, FakeHubElement>();
  const getOrCreate = (id: string, tag: string): FakeHubElement => {
    const existing = elements.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = new FakeHubElement(tag, id);
    elements.set(id, created);
    return created;
  };

  const staticElements: Array<[string, string, boolean]> = [
    ["hub-today", "div", false],
    ["hub-upcoming", "div", false],
    ["hub-recent", "div", false],
    ["hub-search-results", "div", true],
    ["hub-search-input", "input", false],
    ["hub-search-status", "div", true],
    ["hub-detail", "div", true],
    ["hub-notice", "div", false],
    ["hub-capture-status", "span", false],
    ["hub-day-label", "p", false],
    ["hub-today-count", "span", false],
    ["hub-upcoming-count", "span", false],
    ["hub-history-count", "span", false],
    ["hub-refresh-button", "button", false],
    ["hub-history-filters", "div", false],
    ["chat-thread", "div", false],
    ["chat-empty", "div", false],
    ["chat-suggestions", "div", false],
    ["chat-form", "form", false],
    ["chat-question", "input", false],
    ["chat-send-button", "button", false],
    ["chat-status", "div", true],
    ["chat-scope-wrap", "label", true],
    ["chat-scope-current", "input", false],
  ];
  for (const [id, tag, hidden] of staticElements) {
    const el = getOrCreate(id, tag);
    el.hidden = hidden;
  }
  getOrCreate("hub-refresh-button", "button").textContent = REFRESH_LABEL;
  getOrCreate("hub-capture-status", "span").textContent = "Capture status…";

  const filters = getOrCreate("hub-history-filters", "div");
  for (const key of ["ALL", "COMPLETED", "INCOMPLETE", "MICROSOFT_GRAPH", "GOOGLE_CALENDAR"]) {
    const chip = new FakeHubElement("button", `hub-history-${key}`);
    chip.dataset.history = key;
    chip.classList.add("tasks-filter");
    if (key === "ALL") {
      chip.classList.add("active");
    }
    filters.append(chip);
  }

  const unexpected = (name: string) => (): Promise<never> =>
    Promise.reject(new Error(`unexpected renderer API call in hub wiring test: ${name}`));
  const meetings = {
    getOverview: () => {
      calls.overview += 1;
      return options.getOverview();
    },
    getCaptureCapabilities: () => {
      calls.captureCapabilities += 1;
      return options.getCaptureCapabilities();
    },
    getDetail: unexpected("getDetail"),
    getTranscriptContent: unexpected("getTranscriptContent"),
    searchTranscripts: unexpected("searchTranscripts"),
    getAnalysis: unexpected("getAnalysis"),
    startCapture: unexpected("startCapture"),
    stopCapture: unexpected("stopCapture"),
    abortCapture: unexpected("abortCapture"),
    listActiveCaptures: unexpected("listActiveCaptures"),
    processMeeting: unexpected("processMeeting"),
    openLinkedUrl: unexpected("openLinkedUrl"),
    askMeetingHistory: unexpected("askMeetingHistory"),
    listHistory: unexpected("listHistory"),
    getAssistedJoinPlan: unexpected("getAssistedJoinPlan"),
    beginAssistedJoin: unexpected("beginAssistedJoin"),
    getAssistedFlowPlan: unexpected("getAssistedFlowPlan"),
  };

  const location = { hash: "#meetings" };
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  // Notice auto-hide timers (3.5s/8s) must not hold the test runner open.
  const windowSetTimeout = ((callback: (...args: unknown[]) => void, ms?: number): unknown => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  }) as unknown as typeof setTimeout;
  const windowClearTimeout = ((handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as unknown as typeof clearTimeout;
  const windowObject: Record<string, unknown> = {
    location,
    setTimeout: windowSetTimeout,
    clearTimeout: windowClearTimeout,
    addEventListener: (type: string, listener: (event: unknown) => void): void => {
      const bucket = windowListeners.get(type) ?? [];
      bucket.push(listener);
      windowListeners.set(type, bucket);
    },
    aiWorkMate: {
      meetings,
      storage: {
        exportMeeting: unexpected("exportMeeting"),
        exportOfficeDocument: unexpected("exportOfficeDocument"),
      },
      automation: {
        getPreferences: unexpected("getPreferences"),
      },
    },
  };
  const documentObject = {
    visibilityState: "visible",
    getElementById: (id: string): FakeHubElement | null => elements.get(id) ?? null,
    createElement: (tag: string): FakeHubElement => new FakeHubElement(tag, ""),
  };
  windowObject.document = documentObject;

  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    JSON,
    Math,
    Promise,
    console,
  });
  vm.runInContext(readFileSync(HUB_JS_PATH, "utf8"), context, { filename: "meetings-hub.js" });

  return {
    element: (id: string): FakeHubElement => {
      const el = elements.get(id);
      assert.ok(el !== undefined, `harness element must exist: ${id}`);
      return el;
    },
    click: (id: string): void => {
      const el = elements.get(id);
      assert.ok(el !== undefined, `click target must exist: ${id}`);
      el.dispatch("click", {});
    },
    waitFor: async (condition: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      for (;;) {
        if (condition()) {
          return;
        }
        assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
        await tick();
      }
    },
    calls,
    location,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeHubClassList {
  private readonly names = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) {
      this.names.add(name);
    }
  }

  remove(...names: string[]): void {
    for (const name of names) {
      this.names.delete(name);
    }
  }

  toggle(name: string, force?: boolean): boolean {
    if (force === true) {
      this.names.add(name);
    } else if (force === false) {
      this.names.delete(name);
    } else if (this.names.has(name)) {
      this.names.delete(name);
    } else {
      this.names.add(name);
    }
    return this.names.has(name);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeHubElement {
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  title = "";
  type = "";
  scrollTop = 0;
  scrollHeight = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeHubElement[] = [];
  readonly classList = new FakeHubClassList();
  parent: FakeHubElement | null = null;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(
    readonly tagName: string,
    public id: string,
  ) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  append(...nodes: FakeHubElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeHubElement[]): void {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children.length = 0;
    this.append(...nodes);
  }

  querySelectorAll(selector: string): FakeHubElement[] {
    if (selector === "[data-history]") {
      return this.children.filter((child) => child.dataset.history !== undefined);
    }
    if (selector === ".tasks-filter") {
      return this.children.filter((child) => child.classList.contains("tasks-filter"));
    }
    return [];
  }

  remove(): void {
    if (this.parent === null) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  scrollIntoView(): void {
    return;
  }
}
