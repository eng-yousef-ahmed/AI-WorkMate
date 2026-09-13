import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const RENDERER_DIR = join(process.cwd(), "dist/src/renderer");
const HTML_PATH = join(RENDERER_DIR, "storage-settings.html");
const NAV_JS_PATH = join(RENDERER_DIR, "workspace-nav.js");

const WORKSPACE_ROUTES = ["overview", "meetings", "tasks", "notifications", "projects"] as const;
const SETTINGS_ROUTES = ["storage", "privacy", "capture", "integrations"] as const;
const ALL_ROUTES = [...WORKSPACE_ROUTES, ...SETTINGS_ROUTES];

test("sidebar HTML lists every Workspace and Settings route as a hash link", () => {
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
});

test("sidebar active item follows the hash for every Workspace and Settings route", () => {
  const source = readFileSync(NAV_JS_PATH, "utf8");
  const { document, location, fireHash } = createNavDocument();

  vm.runInNewContext(source, {
    window: document.defaultView,
    document,
    NodeList: Array,
  });

  assert.equal(activeRoute(document), "storage");
  assert.equal(document.getElementById("page-title")?.textContent, "AI WorkMate Storage");

  fireHash("#meetings");
  assert.equal(activeRoute(document), "meetings");
  assert.equal(document.getElementById("page-title")?.textContent, "Meeting hub");
  assert.equal(document.getElementById("page-eyebrow")?.textContent, "WORKSPACE / MEETINGS");

  fireHash("#storage");
  assert.equal(activeRoute(document), "storage");
  assert.equal(document.getElementById("page-title")?.textContent, "AI WorkMate Storage");

  for (const route of ALL_ROUTES) {
    fireHash(`#${route}`);
    assert.equal(activeRoute(document), route, `${route} must be the only active sidebar item`);
    const active = sidebarLinks(document).find((link) => link.getAttribute("href") === `#${route}`);
    assert.equal(active?.getAttribute("aria-current"), "page");
    assert.equal(active?.querySelector(".active-dot") !== null, true);
    const others = sidebarLinks(document).filter((link) => link.getAttribute("href") !== `#${route}`);
    for (const link of others) {
      assert.equal(link.classList.contains("active"), false, `${link.getAttribute("href")} must not stay active`);
      assert.equal(link.getAttribute("aria-current"), null);
      assert.equal(link.querySelector(".active-dot"), null);
    }
  }

  location.hash = "";
  document.defaultView.dispatchEvent(new Event("hashchange"));
  assert.equal(activeRoute(document), "storage");

  const filter = document.getElementById("tasks-filter-all");
  assert.equal(filter?.classList.contains("active"), true);
});

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

function createNavDocument(): { document: FakeDocument; location: { hash: string }; fireHash: (hash: string) => void } {
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
  ]);

  const hashListeners: Array<() => void> = [];
  const location = { hash: "" };
  const document = {
    getElementById(id: string): FakeElement | null {
      return byId.get(id) ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      if (selector === "aside.sidebar nav a[href^='#']") {
        return links;
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
      if (type === "hashchange") {
        hashListeners.push(listener);
      }
    },
    dispatchEvent(event: Event): boolean {
      if (event.type === "hashchange") {
        for (const listener of hashListeners) {
          listener();
        }
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
  };
}
