/**
 * Sidebar highlight and visible page must follow the hash route. Storage was
 * hardcoded `class="active"` while Meetings is first in the document, so the
 * first paint and Overview/Projects links could not match the displayed page.
 */
const WORKSPACE_NAV_DEFAULT = "storage";

const WORKSPACE_NAV_COPY: Record<string, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "WORKSPACE / OVERVIEW", title: "Overview" },
  meetings: { eyebrow: "WORKSPACE / MEETINGS", title: "Meeting hub" },
  tasks: { eyebrow: "WORKSPACE / TASKS", title: "Tasks & follow-ups" },
  notifications: { eyebrow: "WORKSPACE / NOTIFICATIONS", title: "Notifications" },
  projects: { eyebrow: "WORKSPACE / PROJECTS", title: "Projects" },
  storage: { eyebrow: "SETTINGS / STORAGE", title: "AI WorkMate Storage" },
  privacy: { eyebrow: "SETTINGS / PRIVACY", title: "Privacy" },
  capture: { eyebrow: "SETTINGS / CAPTURE", title: "Capture & reminders" },
  integrations: { eyebrow: "SETTINGS / INTEGRATIONS", title: "Calendars" },
};

function workspaceNavRoute(hash: string): string {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return WORKSPACE_NAV_DEFAULT;
  }
  return trimmed in WORKSPACE_NAV_COPY ? trimmed : WORKSPACE_NAV_DEFAULT;
}

function workspaceNavLinks(): NodeListOf<HTMLAnchorElement> {
  return document.querySelectorAll<HTMLAnchorElement>("aside.sidebar nav a[href^='#']");
}

function syncWorkspacePages(route: string): void {
  for (const node of document.querySelectorAll("[data-workspace-page]")) {
    const page = node.getAttribute("data-workspace-page");
    (node as HTMLElement).hidden = page !== route;
  }
}

function syncWorkspaceNav(): void {
  const route = workspaceNavRoute(window.location.hash);
  syncWorkspacePages(route);
  for (const link of workspaceNavLinks()) {
    const href = link.getAttribute("href") ?? "";
    const id = href.startsWith("#") ? href.slice(1) : href;
    const isActive = id === route;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
      if (link.querySelector(".active-dot") === null) {
        const dot = document.createElement("span");
        dot.className = "active-dot";
        link.append(dot);
      }
    } else {
      link.removeAttribute("aria-current");
      const dot = link.querySelector(".active-dot");
      if (dot !== null) {
        dot.remove();
      }
    }
  }

  const copy = WORKSPACE_NAV_COPY[route];
  if (copy === undefined) {
    return;
  }
  const eyebrow = document.getElementById("page-eyebrow");
  const title = document.getElementById("page-title");
  if (eyebrow !== null) {
    eyebrow.textContent = copy.eyebrow;
  }
  if (title !== null) {
    title.textContent = copy.title;
  }
}

window.addEventListener("hashchange", () => {
  syncWorkspaceNav();
});
window.addEventListener("popstate", () => {
  syncWorkspaceNav();
});
syncWorkspaceNav();
