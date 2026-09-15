import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import type {
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubCaptureSnapshot,
  HubMeetingSummary,
  HubProcessingJobInfo,
  MeetingDetail,
  MeetingHubOverview,
} from "../src/domain/hub";

const RENDERER_DIR = join(process.cwd(), "dist/src/renderer");
const HTML_PATH = join(RENDERER_DIR, "storage-settings.html");
const HUB_JS_PATH = join(RENDERER_DIR, "meetings-hub.js");

const REFRESH_LABEL = "↻ Refresh";

function summary(id: string, title: string, overrides?: Partial<HubMeetingSummary>): HubMeetingSummary {
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
    ...overrides,
  };
}

function captureSnapshot(overrides?: Partial<HubCaptureSnapshot>): HubCaptureSnapshot {
  return {
    flowId: "flow-1",
    meetingId: "meeting-9",
    phase: "RECORDING",
    meetingStatus: "RECORDING",
    startedAt: "2026-09-14T08:05:00.000Z",
    requestedCapabilities: ["MICROPHONE", "SYSTEM_LOOPBACK"],
    startedCapabilities: ["MICROPHONE", "SYSTEM_LOOPBACK"],
    activeSources: ["MICROPHONE", "SYSTEM_LOOPBACK"],
    ...overrides,
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
  assert.equal(harness.element("hub-notice").classList.contains("visible"), true);
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

test("stale notice timers never hide a newer refresh success", async () => {
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
  const notice = harness.element("hub-notice");

  // Refreshing state appears while IPC is pending.
  harness.click("hub-refresh-button");
  await tick();
  assert.equal(harness.calls.overview, 2);
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.textContent, "↻ Refreshing…");

  // Second click while busy: no duplicate IPC, truthful busy notice.
  harness.click("hub-refresh-button");
  await tick();
  assert.equal(harness.calls.overview, 2);
  assert.equal(notice.textContent, "A refresh is already in progress…");
  assert.equal(notice.classList.contains("visible"), true);

  // Age the busy notice so its stale 3.5s hide timer would fire first.
  harness.advanceTime(3000);
  assert.equal(notice.classList.contains("visible"), true);

  // IPC resolves: success notice present AND visible, button restored.
  assert.ok(release !== undefined, "deferred overview must be releasable");
  release(overviewWith([summary("meeting-9", "Retro")]));
  await harness.waitFor(
    () => refresh.disabled === false && notice.textContent === "Meeting hub refreshed.",
    "refresh success notice",
  );
  assert.equal(notice.classList.contains("visible"), true);
  assert.equal(refresh.textContent, REFRESH_LABEL);
  assert.equal(harness.element("hub-today-count").textContent, "1");

  // Advance past the STALE busy timer's due (3500) but before the success
  // timer's due (3000 + 3500): the newer success notice must survive.
  harness.advanceTime(600);
  assert.equal(notice.textContent, "Meeting hub refreshed.");
  assert.equal(notice.classList.contains("visible"), true, "a stale busy timer must not hide the newer success notice");

  // The success notice still auto-hides on its own schedule.
  harness.advanceTime(6000);
  assert.equal(notice.classList.contains("visible"), false);
});

test("Standalone recording control starts a local capture through the existing capture API", async () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.match(html, /id="hub-record-button"/, "packaged Meetings page must expose the standalone record control");
  assert.match(html, /id="hub-recording-status"/, "packaged Meetings page must expose the recording state pill");

  const active = summary("meeting-9", "Local meeting", { status: "RECORDING", isActive: true });
  let overviews = 0;
  const harness = bootHub({
    getOverview: () => {
      overviews += 1;
      return Promise.resolve(overviews === 1 ? overviewWith([]) : overviewWith([active]));
    },
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    startCapture: () => Promise.resolve(captureSnapshot({})),
  });
  await harness.waitFor(
    () => harness.calls.overview === 1 && harness.element("hub-record-button").disabled === false,
    "record control ready",
  );

  const record = harness.element("hub-record-button");
  assert.equal(record.textContent, "● Start recording");
  assert.equal(harness.element("hub-recording-status").hidden, true);

  harness.click("hub-record-button");
  await harness.waitFor(
    () => harness.calls.startCapture.length === 1 && record.textContent === "■ Stop recording",
    "standalone start settles",
  );

  // The existing capture API is invoked with a standalone request: Capture
  // settings sources, a local title, and no meeting id.
  assert.equal(harness.calls.startCapture.length, 1);
  const request = harness.calls.startCapture[0];
  assert.ok(request !== undefined);
  assert.equal(request.meetingId, undefined);
  assert.equal(request.microphone, true);
  assert.equal(request.systemLoopback, true);
  assert.equal(request.screen, false);
  assert.match(request.title ?? "", /^Local meeting — /);

  // Success is confirmed and the active recording state renders.
  const noticeEl = harness.element("hub-notice");
  assert.equal(noticeEl.textContent, "Recording started. Meeting audio stays on this device.");
  assert.equal(noticeEl.classList.contains("visible"), true);
  const pill = harness.element("hub-recording-status");
  assert.equal(pill.hidden, false);
  assert.equal(pill.textContent, "● Recording — Local meeting");
});

test("Standalone start respects the existing Capture settings", async () => {
  const harness = bootHub({
    getOverview: () => Promise.resolve(overviewWith([])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    preferences: () => Promise.resolve({ captureMicrophone: false, captureSystemLoopback: true, captureScreen: true }),
    startCapture: () => Promise.resolve(captureSnapshot({})),
  });
  await harness.waitFor(() => harness.element("hub-record-button").disabled === false, "record control ready");
  harness.click("hub-record-button");
  await harness.waitFor(() => harness.calls.startCapture.length === 1, "standalone start invoked");
  const request = harness.calls.startCapture[0];
  assert.ok(request !== undefined);
  assert.equal(request.microphone, false);
  assert.equal(request.systemLoopback, true);
  assert.equal(request.screen, true);
  await harness.waitFor(
    () => harness.element("hub-record-button").disabled === false && harness.calls.overview === 2,
    "standalone start settles",
  );
});

test("Duplicate standalone starts are prevented while a start is in flight", async () => {
  let release: ((value: HubCaptureSnapshot) => void) | undefined;
  const harness = bootHub({
    getOverview: () => Promise.resolve(overviewWith([])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    startCapture: () => new Promise<HubCaptureSnapshot>((resolve) => {
      release = resolve;
    }),
  });
  await harness.waitFor(() => harness.element("hub-record-button").disabled === false, "record control ready");

  harness.click("hub-record-button");
  await tick();
  harness.click("hub-record-button");
  await tick();
  assert.equal(harness.calls.startCapture.length, 1);
  assert.equal(harness.element("hub-notice").textContent, "A capture action is already in progress…");

  assert.ok(release !== undefined, "deferred capture start must be releasable");
  release(captureSnapshot({}));
  await harness.waitFor(
    () => harness.element("hub-record-button").disabled === false && harness.calls.overview === 2,
    "standalone start settles",
  );
  assert.equal(harness.calls.startCapture.length, 1);
});

test("Stop recording invokes the existing stop path for the active meeting", async () => {
  const active = summary("meeting-9", "Local meeting", { status: "RECORDING", isActive: true });
  let overviews = 0;
  const harness = bootHub({
    getOverview: () => {
      overviews += 1;
      return Promise.resolve(overviews === 1 ? overviewWith([active]) : overviewWith([]));
    },
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    stopCapture: (meetingId) =>
      Promise.resolve(
        captureSnapshot({ meetingId, phase: "COMPLETED", meetingStatus: "COMPLETED", activeSources: [] }),
      ),
  });
  await harness.waitFor(
    () => harness.calls.overview === 1 && harness.element("hub-record-button").textContent === "■ Stop recording",
    "active recording renders",
  );
  assert.equal(harness.element("hub-recording-status").hidden, false);

  harness.click("hub-record-button");
  await harness.waitFor(
    () => harness.calls.stopCapture.length === 1 && harness.element("hub-record-button").textContent === "● Start recording",
    "stop settles",
  );
  assert.deepEqual(harness.calls.stopCapture, ["meeting-9"]);
  const noticeEl = harness.element("hub-notice");
  assert.equal(noticeEl.textContent, "Recording stopped.");
  assert.equal(noticeEl.classList.contains("visible"), true);
});

test("Capture start failure is surfaced visibly and never announced as success", async () => {
  const harness = bootHub({
    getOverview: () => Promise.resolve(overviewWith([])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    startCapture: () =>
      Promise.resolve(
        captureSnapshot({
          phase: "FAILED",
          meetingStatus: "FAILED",
          startedCapabilities: [],
          activeSources: [],
          error: { message: "Required source MICROPHONE could not start.", failed: true },
        }),
      ),
  });
  await harness.waitFor(() => harness.element("hub-record-button").disabled === false, "record control ready");
  harness.click("hub-record-button");
  await harness.waitFor(
    () => harness.calls.startCapture.length === 1 && harness.calls.overview === 2,
    "failed start settles",
  );

  const noticeEl = harness.element("hub-notice");
  assert.equal(noticeEl.textContent, "Required source MICROPHONE could not start.");
  assert.equal(noticeEl.classList.contains("visible"), true);
  assert.equal(noticeEl.classList.contains("error"), true);
  // No recording state is rendered for the failed start.
  assert.equal(harness.element("hub-record-button").textContent, "● Start recording");
  assert.equal(harness.element("hub-recording-status").hidden, true);
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
  startCapture?: (request: HubCaptureRequest) => Promise<HubCaptureSnapshot>;
  stopCapture?: (meetingId: string) => Promise<HubCaptureSnapshot>;
  getDetail?: (meetingId: string) => Promise<MeetingDetail>;
  processMeeting?: (meetingId: string, approved: boolean) => Promise<unknown>;
  preferences?: () => Promise<{ captureMicrophone: boolean; captureSystemLoopback: boolean; captureScreen: boolean }>;
}

interface HubHarness {
  element(id: string): FakeHubElement;
  click(id: string): void;
  waitFor(condition: () => boolean, label: string): Promise<void>;
  /** Advances the virtual window-timer clock, firing due callbacks in order. */
  advanceTime(ms: number): void;
  calls: {
    overview: number;
    captureCapabilities: number;
    startCapture: HubCaptureRequest[];
    stopCapture: string[];
    detail: number;
    processMeeting: string[];
  };
  location: { hash: string };
}

function bootHub(options: HubBootOptions): HubHarness {
  const calls: HubHarness["calls"] = {
    overview: 0,
    captureCapabilities: 0,
    startCapture: [],
    stopCapture: [],
    detail: 0,
    processMeeting: [],
  };
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
    ["hub-record-button", "button", false],
    ["hub-recording-status", "span", true],
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
  getOrCreate("hub-record-button", "button").textContent = "● Start recording";
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
  const captureStart: (request: HubCaptureRequest) => Promise<HubCaptureSnapshot> =
    options.startCapture ?? unexpected("startCapture");
  const captureStop: (meetingId: string) => Promise<HubCaptureSnapshot> =
    options.stopCapture ?? unexpected("stopCapture");
  const detailLoader: (meetingId: string) => Promise<MeetingDetail> =
    options.getDetail ?? unexpected("getDetail");
  const meetingProcessor: (meetingId: string, approved: boolean) => Promise<unknown> =
    options.processMeeting ?? unexpected("processMeeting");
  const meetings = {
    getOverview: () => {
      calls.overview += 1;
      return options.getOverview();
    },
    getCaptureCapabilities: () => {
      calls.captureCapabilities += 1;
      return options.getCaptureCapabilities();
    },
    getDetail: (meetingId: string) => {
      calls.detail += 1;
      return detailLoader(meetingId);
    },
    getTranscriptContent: unexpected("getTranscriptContent"),
    searchTranscripts: unexpected("searchTranscripts"),
    getAnalysis: unexpected("getAnalysis"),
    startCapture: (request: HubCaptureRequest) => {
      calls.startCapture.push(request);
      return captureStart(request);
    },
    stopCapture: (meetingId: string) => {
      calls.stopCapture.push(meetingId);
      return captureStop(meetingId);
    },
    abortCapture: unexpected("abortCapture"),
    listActiveCaptures: unexpected("listActiveCaptures"),
    processMeeting: (meetingId: string, approved: boolean) => {
      calls.processMeeting.push(meetingId);
      return meetingProcessor(meetingId, approved);
    },
    openLinkedUrl: unexpected("openLinkedUrl"),
    askMeetingHistory: unexpected("askMeetingHistory"),
    listHistory: unexpected("listHistory"),
    getAssistedJoinPlan: unexpected("getAssistedJoinPlan"),
    beginAssistedJoin: unexpected("beginAssistedJoin"),
    getAssistedFlowPlan: unexpected("getAssistedFlowPlan"),
  };

  const location = { hash: "#meetings" };
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  // Virtual clock for window timers: the real script's setTimeout/clearTimeout
  // calls (notice auto-hide, search debounce) run on this clock, so timer
  // races reproduce deterministically without wall-clock waits, and pending
  // timers never hold the test runner open.
  let virtualNow = 0;
  let nextTimerId = 1;
  const pendingTimers = new Map<number, { due: number; callback: () => void }>();
  const windowSetTimeout = ((callback: (...args: unknown[]) => void, ms?: number): unknown => {
    const id = nextTimerId;
    nextTimerId += 1;
    pendingTimers.set(id, { due: virtualNow + (ms ?? 0), callback: () => callback() });
    return id;
  }) as unknown as typeof setTimeout;
  const windowClearTimeout = ((handle: unknown): void => {
    pendingTimers.delete(handle as number);
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
        getPreferences: options.preferences ?? unexpected("getPreferences"),
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
    advanceTime: (ms: number): void => {
      virtualNow += ms;
      const due = [...pendingTimers.entries()]
        .filter(([, timer]) => timer.due <= virtualNow)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      for (const [id, timer] of due) {
        pendingTimers.delete(id);
        timer.callback();
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

// --- Failed-process re-render regression -------------------------------------

function hubDescendants(root: FakeHubElement): FakeHubElement[] {
  const found: FakeHubElement[] = [];
  const walk = (node: FakeHubElement): void => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function hubFindButton(root: FakeHubElement, label: string): FakeHubElement | undefined {
  return hubDescendants(root).find((node) => node.tagName === "button" && node.textContent === label);
}

test("Failed Transcribe & analyze re-renders the persisted FAILED state instead of sticking on Processing", async () => {
  const FAILURE = "Analysis quality rejected: Summary is not grounded in the meeting transcript";
  let status: "COMPLETED" | "FAILED" = "COMPLETED";
  const failedJobs: HubProcessingJobInfo[] = [
    { jobId: "job-analysis-1", jobType: "ANALYSIS", state: "FAILED", createdAt: "2026-09-15T10:00:00.000Z", error: FAILURE },
  ];
  const detailFor = (): MeetingDetail => ({
    meeting: summary("meeting-1", "Local meeting", { status, hasRecording: true }),
    folderLabel: "Local meeting",
    artifacts: [],
    transcripts: [],
    processingJobs: status === "FAILED" ? failedJobs : [],
  });
  const harness = bootHub({
    getOverview: () =>
      Promise.resolve(overviewWith([summary("meeting-1", "Local meeting", { status, hasRecording: true })])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    getDetail: () => Promise.resolve(detailFor()),
    processMeeting: (_meetingId) => {
      status = "FAILED";
      return Promise.reject(new Error(FAILURE));
    },
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      harness.element("hub-refresh-button").disabled === false &&
      hubFindButton(harness.element("hub-today"), "Details") !== undefined,
    "initial hub load with an actionable meeting",
  );

  const detailsButton = hubFindButton(harness.element("hub-today"), "Details");
  assert.ok(detailsButton !== undefined);
  detailsButton.dispatch("click", {});
  await harness.waitFor(
    () => hubFindButton(harness.element("hub-detail"), "Transcribe & analyze") !== undefined,
    "detail renders the process action",
  );

  const processButton = hubFindButton(harness.element("hub-detail"), "Transcribe & analyze");
  assert.ok(processButton !== undefined);
  processButton.dispatch("click", {});
  await harness.waitFor(
    () =>
      harness.calls.processMeeting.length === 1 &&
      harness.element("hub-notice").textContent === FAILURE &&
      hubDescendants(harness.element("hub-today")).some(
        (node) => node.className.includes("status-pill") && node.textContent === "Failed",
      ),
    "failed process re-renders persisted state",
  );

  assert.deepEqual(harness.calls.processMeeting, ["meeting-1"]);
  // The failure is surfaced with the error style and stays visible.
  const noticeEl = harness.element("hub-notice");
  assert.equal(noticeEl.textContent, FAILURE);
  assert.equal(noticeEl.classList.contains("visible"), true);
  assert.equal(noticeEl.classList.contains("error"), true);
  // The detail header reflects the persisted FAILED status (not a stale pill).
  assert.equal(
    hubDescendants(harness.element("hub-detail")).some(
      (node) => node.tagName === "small" && node.textContent.includes("Failed"),
    ),
    true,
  );
  // The persisted ANALYSIS job error renders in the detail jobs panel.
  assert.equal(
    hubDescendants(harness.element("hub-detail")).some((node) => node.textContent === FAILURE),
    true,
  );
  // The overview row pill re-rendered as Failed via the post-run refresh.
  assert.equal(harness.calls.overview, 2);
  // Retry stays available: FAILED meetings still offer Transcribe & analyze.
  assert.equal(hubFindButton(harness.element("hub-detail"), "Transcribe & analyze") !== undefined, true);
});

test("P1-1: duplicate Transcribe & analyze clicks while processing is in flight issue a single IPC", async () => {
  let release: ((value: unknown) => void) | undefined;
  const detailFor = (): MeetingDetail => ({
    meeting: summary("meeting-1", "Local meeting", { status: "COMPLETED", hasRecording: true }),
    folderLabel: "Local meeting",
    artifacts: [],
    transcripts: [],
    processingJobs: [],
  });
  const harness = bootHub({
    getOverview: () =>
      Promise.resolve(overviewWith([summary("meeting-1", "Local meeting", { status: "COMPLETED", hasRecording: true })])),
    getCaptureCapabilities: () => Promise.resolve(fullCaps()),
    getDetail: () => Promise.resolve(detailFor()),
    processMeeting: () =>
      new Promise<unknown>((resolve) => {
        release = resolve;
      }),
  });
  await harness.waitFor(
    () =>
      harness.calls.overview === 1 &&
      hubFindButton(harness.element("hub-today"), "Details") !== undefined,
    "initial hub load with an actionable meeting",
  );

  const detailsButton = hubFindButton(harness.element("hub-today"), "Details");
  assert.ok(detailsButton !== undefined);
  detailsButton.dispatch("click", {});
  await harness.waitFor(
    () => hubFindButton(harness.element("hub-detail"), "Transcribe & analyze") !== undefined,
    "detail renders the process action",
  );

  // Two rapid clicks: the first starts the IPC, the second is refused locally.
  const processButton = hubFindButton(harness.element("hub-detail"), "Transcribe & analyze");
  assert.ok(processButton !== undefined);
  processButton.dispatch("click", {});
  processButton.dispatch("click", {});
  await tick();
  assert.deepEqual(harness.calls.processMeeting, ["meeting-1"]);
  assert.equal(harness.element("hub-notice").textContent, "This meeting is already being processed…");

  // A refresh that re-renders the detail mid-run offers no second action.
  harness.click("hub-refresh-button");
  await harness.waitFor(
    () =>
      harness.element("hub-refresh-button").disabled === false &&
      hubFindButton(harness.element("hub-detail"), "Processing…") !== undefined,
    "mid-flight refresh shows the disabled processing state",
  );
  const midFlightButton = hubFindButton(harness.element("hub-detail"), "Processing…");
  assert.ok(midFlightButton !== undefined);
  assert.equal(midFlightButton.disabled, true);
  assert.equal(hubFindButton(harness.element("hub-detail"), "Transcribe & analyze"), undefined);
  assert.equal(harness.calls.processMeeting.length, 1);

  assert.ok(release !== undefined, "deferred process meeting must be releasable");
  release(undefined);
  await harness.waitFor(
    () =>
      harness.calls.overview === 3 &&
      hubFindButton(harness.element("hub-detail"), "Transcribe & analyze") !== undefined,
    "settled process re-renders through the post-run refresh",
  );
  assert.equal(harness.calls.processMeeting.length, 1);
});
