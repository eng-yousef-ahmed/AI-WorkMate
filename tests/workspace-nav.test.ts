import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const RENDERER_DIR = join(process.cwd(), "dist/src/renderer");
const HTML_PATH = join(RENDERER_DIR, "storage-settings.html");
const NAV_JS_PATH = join(RENDERER_DIR, "workspace-nav.js");
const MEETINGS_JS_PATH = join(RENDERER_DIR, "meetings-hub.js");

const WORKSPACE_ROUTES = ["overview", "meetings", "tasks", "notifications", "projects"] as const;
const SETTINGS_ROUTES = ["storage", "privacy", "capture", "integrations"] as const;
const ALL_ROUTES = [...WORKSPACE_ROUTES, ...SETTINGS_ROUTES];

test("sidebar HTML lists every Workspace and Settings route as a hash link with a page", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const workspace = html.match(/<nav aria-label="Workspace">([\s\S]*?)<\/nav>/);
  const settings = html.match(/<nav aria-label="Settings">([\s\S]*?)<\/nav>/);
  assert.notEqual(workspace, null);
  assert.notEqual(settings, null);
  const workspaceHrefs = [...(workspace?.[1] ?? "").matchAll(/href="#([a-z]+)"/g)].map((match) => match[1]);
  const settingsHrefs = [...(settings?.[1] ?? "").matchAll(/href="#([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(workspaceHrefs, [...WORKSPACE_ROUTES]);
  assert.deepEqual(settingsHrefs, [...SETTINGS_ROUTES]);
  assert.match(html, /href="#storage"[^>]*aria-current="page"|aria-current="page"[^>]*href="#storage"/);
  for (const route of ALL_ROUTES) {
    assert.match(html, new RegExp(`id="${route}"[^>]*data-workspace-page="${route}"|data-workspace-page="${route}"[^>]*id="${route}"`));
  }
  assert.match(html, /id="overview"[^>]*hidden|hidden[^>]*id="overview"/);
  assert.match(html, /id="projects"[^>]*hidden|hidden[^>]*id="projects"/);
  assert.match(html, /id="meetings"[^>]*hidden|hidden[^>]*id="meetings"/);
  assert.equal(/id="storage"[^>]*\bhidden\b/.test(html), false);
});

test("sidebar active item follows the hash for every Workspace and Settings route", () => {
  const { document, fireHash } = bootNav();

  assert.equal(activeRoute(document), "storage");
  assert.equal(document.getElementById("page-title")?.textContent, "AI WorkMate Storage");
  assertVisible(document, "storage");

  fireHash("#meetings");
  assert.equal(activeRoute(document), "meetings");
  assert.equal(document.getElementById("page-title")?.textContent, "Meeting hub");
  assert.equal(document.getElementById("page-eyebrow")?.textContent, "WORKSPACE / MEETINGS");
  assertVisible(document, "meetings");

  fireHash("#storage");
  assert.equal(activeRoute(document), "storage");
  assert.equal(document.getElementById("page-title")?.textContent, "AI WorkMate Storage");
  assertVisible(document, "storage");

  for (const route of ALL_ROUTES) {
    fireHash(`#${route}`);
    assert.equal(activeRoute(document), route, `${route} must be the only active sidebar item`);
    const active = sidebarLinks(document).find((link) => link.getAttribute("href") === `#${route}`);
    assert.equal(active?.getAttribute("aria-current"), "page");
    assert.equal(active?.querySelector(".active-dot") !== null, true);
    assertVisible(document, route);
    const others = sidebarLinks(document).filter((link) => link.getAttribute("href") !== `#${route}`);
    for (const link of others) {
      assert.equal(link.classList.contains("active"), false, `${link.getAttribute("href")} must not stay active`);
      assert.equal(link.getAttribute("aria-current"), null);
      assert.equal(link.querySelector(".active-dot"), null);
    }
  }

  const filter = document.getElementById("tasks-filter-all");
  assert.equal(filter?.classList.contains("active"), true);
});

test("direct hash, refresh, unknown hash, and back/forward keep the matching page active", () => {
  const refreshed = bootNav("#meetings");
  assert.equal(activeRoute(refreshed.document), "meetings");
  assertVisible(refreshed.document, "meetings");
  assert.equal(refreshed.document.getElementById("page-title")?.textContent, "Meeting hub");

  const { document, fireHash, firePopstate, location } = bootNav();
  fireHash("#overview");
  fireHash("#meetings");
  fireHash("#tasks");
  assert.equal(activeRoute(document), "tasks");
  assertVisible(document, "tasks");

  firePopstate("#meetings");
  assert.equal(activeRoute(document), "meetings");
  assertVisible(document, "meetings");

  firePopstate("#overview");
  assert.equal(activeRoute(document), "overview");
  assertVisible(document, "overview");

  fireHash("#not-a-route");
  assert.equal(activeRoute(document), "storage");
  assertVisible(document, "storage");

  location.hash = "";
  document.defaultView.dispatchEvent(new Event("hashchange"));
  assert.equal(activeRoute(document), "storage");
  assertVisible(document, "storage");
});

test("Windows Back/Forward traverses Overview -> Meetings -> Tasks history", () => {
  const { document, location, fireHash } = bootNav();
  const fireHistoryTraversal = (hash: string): void => {
    // Chromium history traversal (goBack/goForward from Alt+Left/Right or
    // mouse Back/Forward) re-targets the URL and fires popstate+hashchange;
    // workspace-nav must sync the same route from the hash either way.
    location.hash = hash;
    document.defaultView.dispatchEvent(new Event("popstate"));
    document.defaultView.dispatchEvent(new Event("hashchange"));
  };
  const expectRoute = (route: string, eyebrow: string, title: string): void => {
    assert.equal(activeRoute(document), route, `Back/Forward must land on ${route}`);
    assert.equal(document.getElementById("page-eyebrow")?.textContent, eyebrow);
    assert.equal(document.getElementById("page-title")?.textContent, title);
    assertVisible(document, route);
    const active = sidebarLinks(document).find((link) => link.getAttribute("href") === `#${route}`);
    assert.equal(active?.getAttribute("aria-current"), "page");
    assert.equal(active?.querySelector(".active-dot") !== null, true);
    for (const page of document.querySelectorAll("[data-workspace-page]")) {
      const belongs = page.getAttribute("data-workspace-page") === route;
      assert.equal(page.getAttribute("aria-hidden"), belongs ? null : "true", `${page.id} aria-hidden`);
    }
    for (const link of sidebarLinks(document).filter((item) => item.getAttribute("href") !== `#${route}`)) {
      assert.equal(link.classList.contains("active"), false);
      assert.equal(link.getAttribute("aria-current"), null);
    }
  };

  // Sidebar clicks push hash history entries (hashchange path).
  fireHash("#overview");
  expectRoute("overview", "WORKSPACE / OVERVIEW", "Overview");
  fireHash("#meetings");
  expectRoute("meetings", "WORKSPACE / MEETINGS", "Meeting hub");
  fireHash("#tasks");
  expectRoute("tasks", "WORKSPACE / TASKS", "Tasks & follow-ups");

  // Windows Back (Alt+Left / mouse Back) walks the same stack backwards.
  fireHistoryTraversal("#meetings");
  expectRoute("meetings", "WORKSPACE / MEETINGS", "Meeting hub");
  fireHistoryTraversal("#overview");
  expectRoute("overview", "WORKSPACE / OVERVIEW", "Overview");

  // Windows Forward (Alt+Right / mouse Forward) walks it forwards again.
  fireHistoryTraversal("#meetings");
  expectRoute("meetings", "WORKSPACE / MEETINGS", "Meeting hub");
  fireHistoryTraversal("#tasks");
  expectRoute("tasks", "WORKSPACE / TASKS", "Tasks & follow-ups");
});

test("opening a meeting from another page sets the meetings hash", () => {
  const source = readFileSync(MEETINGS_JS_PATH, "utf8");
  assert.match(source, /location\.hash = ["']meetings["']/);
});

test("navigation HTML has unique ids and every renderer lookup exists", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);

  const rendererDir = join(process.cwd(), "src/renderer");
  const files = ["storage-settings.ts", "meetings-hub.ts", "tasks.ts", "automation.ts", "notifications.ts", "workspace-nav.ts"];
  const missing: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(rendererDir, name), "utf8");
    for (const match of source.matchAll(/\$<\s*[^>]*>\s*\(\s*"([^"]+)"\s*\)|\$\(\s*"([^"]+)"\s*\)|getElementById\(\s*"([^"]+)"\s*\)/g)) {
      const id = match[1] ?? match[2] ?? match[3];
      if (id === undefined || id === "hub-transcript-viewer") {
        continue;
      }
      if (!ids.includes(id)) {
        missing.push(`${name}:${id}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("hash routing does not invoke capture, backup, calendar, or preload IPC", () => {
  const source = readFileSync(NAV_JS_PATH, "utf8");
  assert.equal(source.includes("aiWorkMate"), false);
  assert.equal(source.includes("ipcRenderer"), false);
  assert.equal(/\brequire\s*\(/.test(source), false);
  assert.equal(source.includes("createBackup"), false);
  assert.equal(source.includes("startCapture"), false);
  assert.equal(source.includes("beginMicrosoft"), false);
  assert.equal(source.includes("beginGoogle"), false);
  assert.match(source, /^"use strict";\s*\(function\s*\(\)\s*\{/m);
});

test("hidden workspace pages are inert and drop focus", () => {
  const { document, fireHash } = bootNav();
  const meetings = document.getElementById("meetings");
  const focused = new FakeElement("input", "chat-question");
  meetings?.append(focused);
  document.activeElement = focused;
  fireHash("#meetings");
  fireHash("#storage");
  assert.equal(meetings?.hidden, true);
  assert.equal(meetings?.getAttribute("inert"), "");
  assert.equal(meetings?.getAttribute("aria-hidden"), "true");
  assert.equal(focused.blurred, true);
  assert.equal(document.getElementById("storage")?.getAttribute("inert"), null);
  assert.equal(document.getElementById("storage")?.getAttribute("aria-hidden"), null);
});

test("task and meeting cross-links change the hash instead of only scrolling", () => {
  const notifications = readFileSync(join(process.cwd(), "src/renderer/notifications.ts"), "utf8");
  assert.match(notifications, /location\.hash !== ["']#tasks["']/);
  assert.match(notifications, /location\.hash = ["']tasks["']/);
  assert.equal(notifications.includes("scrollIntoView"), false);
  const meetings = readFileSync(join(process.cwd(), "src/renderer/meetings-hub.ts"), "utf8");
  assert.match(meetings, /location\.hash !== ["']#meetings["']/);
  assert.match(meetings, /location\.hash = ["']meetings["']/);
});

function bootNav(initialHash = ""): ReturnType<typeof createNavDocument> & { firePopstate: (hash: string) => void } {
  const harness = createNavDocument(initialHash);
  vm.runInNewContext(readFileSync(NAV_JS_PATH, "utf8"), {
    window: harness.document.defaultView,
    document: harness.document,
  });
  return harness;
}

function assertVisible(document: FakeDocument, route: string): void {
  const pages = document.querySelectorAll("[data-workspace-page]");
  assert.equal(pages.length > 0, true);
  for (const page of pages) {
    const belongs = page.getAttribute("data-workspace-page") === route;
    assert.equal(page.hidden, !belongs, `${page.id || page.getAttribute("data-workspace-page")} hidden=${page.hidden}`);
    assert.equal(page.getAttribute("inert"), belongs ? null : "");
  }
}

function activeRoute(document: FakeDocument): string | undefined {
  const active = sidebarLinks(document).filter((link) => link.classList.contains("active"));
  assert.equal(active.length, 1);
  return active[0]?.getAttribute("href")?.slice(1);
}

function sidebarLinks(document: FakeDocument): FakeElement[] {
  return [...document.querySelectorAll("aside.sidebar nav a[href^='#']")];
}

interface FakeDocument {
  getElementById(id: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  createElement(tag: string): FakeElement;
  activeElement: FakeElement | null;
  defaultView: FakeWindow;
}

interface FakeWindow {
  location: { hash: string };
  addEventListener(type: string, listener: () => void): void;
  dispatchEvent(event: Event): boolean;
  document: FakeDocument;
}

class FakeClassList {
  constructor(private readonly names: Set<string>) {}
  add(name: string): void {
    this.names.add(name);
  }
  remove(name: string): void {
    this.names.delete(name);
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

class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = "";
  className = "";
  hidden = false;
  blurred = false;
  readonly attributes = new Map<string, string>();
  readonly classList: FakeClassList;
  private readonly classes = new Set<string>();

  constructor(
    readonly tagName: string,
    readonly id = "",
  ) {
    this.classList = new FakeClassList(this.classes);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    if (force === true) {
      this.attributes.set(name, "");
      return true;
    }
    if (force === false) {
      this.attributes.delete(name);
      return false;
    }
    if (this.attributes.has(name)) {
      this.attributes.delete(name);
      return false;
    }
    this.attributes.set(name, "");
    return true;
  }

  contains(node: { parent?: FakeElement | null } | null): boolean {
    let current: FakeElement | null | undefined = node as FakeElement | null;
    while (current !== null && current !== undefined) {
      if (current === this) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  blur(): void {
    this.blurred = true;
  }

  append(node: FakeElement): void {
    node.parent = this;
    this.children.push(node);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === ".active-dot") {
      return this.children.find((child) => child.className === "active-dot" || child.classList.contains("active-dot")) ?? null;
    }
    return null;
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
}

function createNavDocument(initialHash = ""): {
  document: FakeDocument;
  location: { hash: string };
  fireHash: (hash: string) => void;
  firePopstate: (hash: string) => void;
} {
  const links = ALL_ROUTES.map((route) => {
    const link = new FakeElement("a");
    link.setAttribute("href", `#${route}`);
    if (route === "storage") {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
      const dot = new FakeElement("span");
      dot.className = "active-dot";
      link.append(dot);
    }
    return link;
  });
  const pages = ALL_ROUTES.flatMap((route) => {
    const page = new FakeElement("section", route);
    page.setAttribute("data-workspace-page", route);
    page.hidden = route !== "storage";
    if (route === "storage") {
      const extra = new FakeElement("section", "local-runtime");
      extra.setAttribute("data-workspace-page", "storage");
      extra.hidden = false;
      return [page, extra];
    }
    return [page];
  });
  const eyebrow = new FakeElement("div", "page-eyebrow");
  eyebrow.textContent = "SETTINGS / STORAGE";
  const title = new FakeElement("h1", "page-title");
  title.textContent = "AI WorkMate Storage";
  const filter = new FakeElement("button", "tasks-filter-all");
  filter.classList.add("active");
  const byId = new Map<string, FakeElement>([
    ["page-eyebrow", eyebrow],
    ["page-title", title],
    ["tasks-filter-all", filter],
    ...pages.map((page) => [page.id, page] as const),
  ]);

  const listeners = new Map<string, Array<() => void>>();
  const location = { hash: initialHash };
  const document: FakeDocument = {
    activeElement: null,
    getElementById(id: string): FakeElement | null {
      return byId.get(id) ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === "aside.sidebar nav a[href^='#']") {
        return links;
      }
      if (selector === "[data-workspace-page]") {
        return pages;
      }
      return [];
    },
    createElement(tag: string): FakeElement {
      return new FakeElement(tag);
    },
    defaultView: {} as FakeWindow,
  };
  const windowObject: FakeWindow = {
    location,
    addEventListener(type: string, listener: () => void): void {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    dispatchEvent(event: Event): boolean {
      for (const listener of listeners.get(event.type) ?? []) {
        listener();
      }
      return true;
    },
    document,
  };
  document.defaultView = windowObject;

  return {
    document,
    location,
    fireHash(hash: string): void {
      location.hash = hash;
      windowObject.dispatchEvent(new Event("hashchange"));
    },
    firePopstate(hash: string): void {
      location.hash = hash;
      windowObject.dispatchEvent(new Event("popstate"));
    },
  };
}
