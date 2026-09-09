import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { TaskManagementService } from "../src/tasks/TaskManagementService";
import { DEFAULT_DIGEST_TIME, NotificationCenterService } from "../src/notifications/NotificationCenterService";
import { StorageError } from "../src/storage/errors";
import type { HubNotification } from "../src/domain/hub";

/** Local time helper: 2026-09-09T09:15 in the machine's timezone. */
function at(hours: number, minutes: number, day = 9, month = 8): Date {
  return new Date(2026, month, day, hours, minutes, 0, 0);
}

interface CenterHarness {
  store: LocalFirstStore;
  tasks: TaskManagementService;
  root: string;
  /** Mutable clock; tests advance time by calling moveTo. */
  moveTo: (next: Date) => void;
  makeCenter: () => NotificationCenterService;
  present: HubNotification[];
}

async function withCenter(run: (harness: CenterHarness) => Promise<void>, startAt = at(9, 15)): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-notifications-"));
  let now = startAt;
  const clock = (): Date => now;
  const present: HubNotification[] = [];
  const store = new LocalFirstStore(root, { clock });
  try {
    await store.initialize();
    const tasks = new TaskManagementService({ store, clock });
    const makeCenter = (): NotificationCenterService => new NotificationCenterService({
      store,
      tasks,
      clock,
      presenter: (notification) => present.push(notification),
    });
    await run({ store, tasks, root, moveTo: (next) => { now = next; }, makeCenter, present });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function seedMeeting(store: LocalFirstStore, title: string, meetingDate = "2026-09-09"): Promise<string> {
  return (await store.createMeeting({ title, meetingDate })).meetingId;
}

function assertNotificationShape(item: HubNotification): void {
  assert.equal(typeof item.notificationId, "string");
  assert.ok(item.notificationId.length > 0);
  assert.ok(["MEETING_READY", "MEETING_ISSUE", "TASK_DUE", "FOLLOWUP_DIGEST"].includes(item.kind));
  assert.ok(["INFO", "WARNING"].includes(item.severity));
  assert.ok(item.title.length > 0 && item.title.length <= 140);
  assert.ok(item.body.length > 0 && item.body.length <= 1000);
  assert.ok(Number.isFinite(Date.parse(item.createdAt)));
  // Renderer safety: no absolute paths, artifact file names, or DATA_ROOT
  // hints cross the boundary.
  const json = JSON.stringify(item);
  assert.equal(json.includes(":\\"), false, `path leaked: ${json}`);
  assert.equal(json.includes(".txt"), false, `artifact leaked: ${json}`);
  assert.equal(json.includes(".json"), false, `artifact leaked: ${json}`);
  assert.equal(json.includes("DATA_ROOT"), false, `data-root leaked: ${json}`);
}

test("notifications: defaults are local-first with the digest opt-in off", async () => {
  await withCenter(async ({ makeCenter }) => {
    const center = makeCenter();
    const settings = center.getSettings();
    assert.equal(settings.notificationsEnabled, true);
    assert.equal(settings.digestEnabled, false);
    assert.equal(settings.digestTime, DEFAULT_DIGEST_TIME);
    const page = center.listPage();
    assert.equal(page.unread, 0);
    assert.deepEqual(page.notifications, []);
  });
});

test("notifications: settings validate types, time format, and persist", async () => {
  await withCenter(async ({ makeCenter }) => {
    const center = makeCenter();
    assert.throws(() => center.updateSettings({ notificationsEnabled: "yes" as unknown as boolean }), StorageError);
    assert.throws(() => center.updateSettings({ digestEnabled: 1 as unknown as boolean }), StorageError);
    assert.throws(() => center.updateSettings({ digestTime: "9am" }), StorageError);
    assert.throws(() => center.updateSettings({ digestTime: "24:00" }), StorageError);
    assert.throws(() => center.updateSettings({ digestTime: "09:60" }), StorageError);
    assert.throws(() => center.updateSettings({} as never), StorageError);

    const updated = center.updateSettings({ digestEnabled: true, digestTime: "17:45", notificationsEnabled: false });
    assert.equal(updated.digestEnabled, true);
    assert.equal(updated.digestTime, "17:45");
    assert.equal(updated.notificationsEnabled, false);
    assert.ok(updated.updatedAt.length > 0);

    // Settings survive service recreation (persisted in the local database).
    const reread = makeCenter().getSettings();
    assert.equal(reread.digestEnabled, true);
    assert.equal(reread.digestTime, "17:45");
    assert.equal(reread.notificationsEnabled, false);
  });
});

test("notifications: due-task alerts fire once per task+due date and respect the master toggle", async () => {
  await withCenter(async ({ store, tasks, makeCenter, present }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Planning sync");
    const dueToday = tasks.createTask({ meetingId, text: "Send the Q3 invoice", dueDate: "2026-09-09" });
    const overdue = tasks.createTask({ meetingId, text: "Renew the domain certificate", assignee: "Ada", dueDate: "2026-09-07" });
    tasks.createTask({ meetingId, text: "Draft the roadmap", dueDate: "2026-09-20" }); // future: never alerted

    const first = await center.runAutomation();
    assert.equal(first.taskAlerts, 2);
    assert.equal(first.digestFired, false);
    assert.equal(first.inserted, 2);
    assert.equal(center.listPage().unread, 2);
    assert.equal(present.length, 2); // popups fired while the master toggle is on

    const items = center.listPage().notifications;
    const dueItem = items.find((item) => item.taskId === dueToday.taskId);
    assert.ok(dueItem !== undefined);
    assert.equal(dueItem!.kind, "TASK_DUE");
    assert.equal(dueItem!.severity, "INFO");
    assert.equal(dueItem!.title, "Task due today");
    assert.ok(dueItem!.body.includes("Send the Q3 invoice"));
    assert.equal(dueItem!.action, "open-tasks");
    assertNotificationShape(dueItem!);

    const overdueItem = items.find((item) => item.taskId === overdue.taskId);
    assert.ok(overdueItem !== undefined);
    assert.equal(overdueItem!.severity, "WARNING");
    assert.equal(overdueItem!.title, "Task overdue");
    assert.ok(overdueItem!.body.includes("Ada"));

    // Idempotent ticks: nothing new on a second run the same day.
    const second = await center.runAutomation();
    assert.equal(second.inserted, 0);
    assert.equal(center.listPage().unread, 2);

    // Completing a task stops further alerts for it.
    tasks.setTaskStatus(dueToday.taskId, "DONE");
    const completed = await center.runAutomation();
    assert.equal(completed.inserted, 0);

    // Master toggle off: automation and popups both go quiet, history kept.
    center.updateSettings({ notificationsEnabled: false });
    const presentBefore = present.length;
    const silenced = await center.runAutomation();
    assert.equal(silenced.inserted, 0);
    assert.equal(present.length, presentBefore);
    assert.equal(center.listPage().unread, 2);
  });
});

test("notifications: due-date edits alert at most once per task+due-date pair", async () => {
  await withCenter(async ({ store, tasks, makeCenter }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Ops sync");
    const task = tasks.createTask({ meetingId, text: "Rotate the signing key", dueDate: "2026-09-09" });
    await center.runAutomation();
    tasks.updateTask(task.taskId, { dueDate: "2026-09-20" });
    tasks.updateTask(task.taskId, { dueDate: "2026-09-09" });
    const summary = await center.runAutomation();
    assert.equal(summary.taskAlerts, 0); // same task + same due date already alerted
    assert.equal(center.listPage().unread, 1);

    // Moving the due date forward to a never-alerted date produces one new row.
    tasks.updateTask(task.taskId, { dueDate: "2026-09-08" });
    const moved = await center.runAutomation();
    assert.equal(moved.taskAlerts, 1);
    assert.equal(center.listPage().unread, 2);
  });
});

test("notifications: daily digest is opt-in, fires after its time, once per local day", async () => {
  await withCenter(async ({ store, tasks, moveTo, makeCenter }) => {
    const meetingId = await seedMeeting(store, "Planning sync");
    tasks.createTask({ meetingId, text: "Ship the migration script", dueDate: "2026-09-09" });
    tasks.createTask({ meetingId, text: "Tidy the backlog", dueDate: "2026-09-30" });

    const center = makeCenter();
    center.updateSettings({ digestEnabled: true, digestTime: "17:45" });

    // 09:15 is before the digest time: only the due-task alert exists.
    const early = await center.runAutomation();
    assert.equal(early.digestFired, false);
    assert.equal(center.listPage().unread, 1);

    // Advance past the digest time on the same local day.
    moveTo(at(18, 0));
    const fired = await center.runAutomation();
    assert.equal(fired.digestFired, true);
    const digest = center.listPage().notifications.find((item) => item.kind === "FOLLOWUP_DIGEST");
    assert.ok(digest !== undefined);
    assert.ok(digest!.body.includes("2 open tasks"));
    assert.ok(digest!.body.includes("1 due today or overdue"));
    assert.equal(digest!.action, "open-tasks");
    assertNotificationShape(digest!);

    // Same local day, later: no second digest.
    moveTo(at(23, 59));
    const again = await center.runAutomation();
    assert.equal(again.digestFired, false);
    assert.equal(center.listPage().notifications.filter((item) => item.kind === "FOLLOWUP_DIGEST").length, 1);

    // The digest never fires before the configured time on a new day.
    moveTo(at(9, 0, 10));
    const nextMorning = await center.runAutomation();
    assert.equal(nextMorning.digestFired, false);

    // Next day after the time: digest runs again (previous one stays).
    moveTo(at(18, 0, 10));
    const secondDay = await center.runAutomation();
    assert.equal(secondDay.digestFired, true);
    assert.equal(center.listPage().notifications.filter((item) => item.kind === "FOLLOWUP_DIGEST").length, 2);
  });
});

test("notifications: a fully quiet day records no digest row", async () => {
  await withCenter(async ({ store, tasks, moveTo, makeCenter }) => {
    const meetingId = await seedMeeting(store, "Planning sync");
    const task = tasks.createTask({ meetingId, text: "Ship the migration script", dueDate: "2026-09-09" });
    const center = makeCenter();
    center.updateSettings({ digestEnabled: true, digestTime: "09:00" });
    moveTo(at(10, 0));
    const first = await center.runAutomation();
    assert.equal(first.digestFired, true);

    // Complete every task and move to the next day: digest marks the day but
    // inserts no empty row.
    tasks.setTaskStatus(task.taskId, "DONE");
    moveTo(at(10, 0, 10));
    const quiet = await center.runAutomation();
    assert.equal(quiet.digestFired, false);
    assert.equal(quiet.inserted, 0);
    const digests = center.listPage().notifications.filter((item) => item.kind === "FOLLOWUP_DIGEST");
    assert.equal(digests.length, 1);

    // ... and it never retries that quiet day.
    moveTo(at(20, 0, 10));
    const retry = await center.runAutomation();
    assert.equal(retry.digestFired, false);
  });
});

test("notifications: meeting outcomes are recorded per terminal status and deduped", async () => {
  await withCenter(async ({ store, makeCenter, present }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Design review", "2026-09-08");
    assert.equal(center.recordMeetingOutcome(meetingId), undefined); // SCHEDULED
    store.transitionMeeting(meetingId, "PROCESSING");
    assert.equal(center.recordMeetingOutcome(meetingId), undefined); // live

    store.transitionMeeting(meetingId, "COMPLETED");
    const ready = center.recordMeetingOutcome(meetingId);
    assert.ok(ready !== undefined);
    assert.equal(ready!.kind, "MEETING_READY");
    assert.equal(ready!.severity, "INFO");
    assert.equal(ready!.meetingId, meetingId);
    assert.equal(ready!.action, "open-meeting");
    assert.ok(ready!.body.includes("Design review"));
    assertNotificationShape(ready!);
    assert.equal(center.recordMeetingOutcome(meetingId), undefined); // deduped
    assert.equal(center.listPage().unread, 1);
    assert.equal(present.length, 1);

    // A later failed run lands as a distinct warning row.
    store.transitionMeeting(meetingId, "PROCESSING");
    store.transitionMeeting(meetingId, "FAILED");
    const issue = center.recordMeetingOutcome(meetingId);
    assert.ok(issue !== undefined);
    assert.equal(issue!.kind, "MEETING_ISSUE");
    assert.equal(issue!.severity, "WARNING");
    assert.equal(center.recordMeetingOutcome(meetingId), undefined);
    assert.equal(center.listPage().unread, 2);

    // Re-processing to completion is deduped: each terminal status notifies
    // at most once per meeting, so the center never accumulates repeats.
    store.transitionMeeting(meetingId, "PROCESSING");
    store.transitionMeeting(meetingId, "COMPLETED");
    assert.equal(center.recordMeetingOutcome(meetingId), undefined);
    assert.equal(center.listPage().unread, 2);

    // Unknown ids are a no-op (never an invented row).
    assert.equal(center.recordMeetingOutcome("missing-meeting"), undefined);
  });
});

test("notifications: read state, mark-all-read, and newest-first pages", async () => {
  await withCenter(async ({ store, makeCenter }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Weekly sync");
    store.transitionMeeting(meetingId, "PROCESSING");
    store.transitionMeeting(meetingId, "COMPLETED");
    const first = center.recordMeetingOutcome(meetingId);
    store.transitionMeeting(meetingId, "PROCESSING");
    store.transitionMeeting(meetingId, "FAILED");
    const second = center.recordMeetingOutcome(meetingId);
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(center.listPage().unread, 2);

    const read = center.markRead(first!.notificationId);
    assert.ok(read !== undefined);
    assert.ok(read!.readAt !== null && Number.isFinite(Date.parse(read!.readAt)));
    assert.equal(center.markRead(first!.notificationId)?.readAt, read!.readAt); // idempotent
    assert.equal(center.listPage().unread, 1);

    assert.throws(() => center.markRead(""), StorageError);
    assert.throws(() => center.markRead("   "), StorageError);

    const marked = center.markAllRead();
    assert.equal(marked, 1);
    assert.equal(center.listPage().unread, 0);
    const page = center.listPage(10);
    assert.equal(page.notifications.length, 2);
    assert.ok(page.notifications.every((item) => item.readAt !== null));
    assert.ok(page.notifications[0]!.createdAt >= page.notifications[1]!.createdAt);
  });
});

test("notifications: retention caps history and prunes aged rows", async () => {
  await withCenter(async ({ store, tasks, makeCenter }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Backlog grooming");
    // 40 distinct overdue tasks flood the center with alerts.
    for (let index = 0; index < 40; index += 1) {
      tasks.createTask({ meetingId, text: `Bulk cleanup item ${index}`, dueDate: "2026-09-01" });
    }
    const first = await center.runAutomation();
    assert.equal(first.taskAlerts, 40);
    assert.equal(center.listPage(1000).notifications.length, 40);

    // Retention keeps at most NOTIFICATION_RETENTION_ROWS (500): nothing
    // pruned at 40 rows, so adding more due tasks keeps the cap enforced.
    for (let index = 0; index < 30; index += 1) {
      tasks.createTask({ meetingId, text: `More cleanup item ${index}`, dueDate: "2026-09-02" });
    }
    await center.runAutomation();
    assert.ok(center.listPage(1000).notifications.length <= 500);
  });
});

test("notifications: aged rows older than the retention window are pruned", async () => {
  await withCenter(async ({ store, tasks, moveTo, makeCenter }) => {
    const center = makeCenter();
    const meetingId = await seedMeeting(store, "Spring cleanup", "2026-07-01");
    tasks.createTask({ meetingId, text: "Archive winter recordings", dueDate: "2026-07-01" });
    moveTo(at(10, 0, 1, 6)); // 2026-07-01
    await center.runAutomation();
    assert.equal(center.listPage().unread, 1);

    // Two months later the alert is still listed (history is kept until the
    // retention window passes and a prune pass runs).
    moveTo(at(10, 0));
    await center.runAutomation();
    assert.equal(center.listPage().unread, 1);

    // After 70 days the old row is pruned; the overdue task re-alerts with a
    // fresh createdAt (bounded, never silent growth).
    moveTo(at(10, 0, 10, 10)); // 2026-11-10: > 60 days after 2026-07-01
    const pruned = await center.runAutomation();
    assert.equal(pruned.pruned, 1);
    assert.equal(pruned.inserted, 1);
    const remaining = center.listPage().notifications;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.kind, "TASK_DUE");
    assert.ok(Date.parse(remaining[0]!.createdAt) >= Date.parse("2026-11-10T00:00:00.000Z"));
  });
});

test("notifications: history and settings persist across store reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-notif-reopen-"));
  const clock = (): Date => at(10, 0);
  const store = new LocalFirstStore(root, { clock });
  await store.initialize();
  try {
    const tasks = new TaskManagementService({ store, clock });
    const center = new NotificationCenterService({ store, tasks, clock });
    const meetingId = await seedMeeting(store, "Persisted review", "2026-09-08");
    store.transitionMeeting(meetingId, "PROCESSING");
    store.transitionMeeting(meetingId, "COMPLETED");
    const ready = center.recordMeetingOutcome(meetingId);
    assert.ok(ready !== undefined);
    center.markRead(ready!.notificationId);
    tasks.createTask({ meetingId, text: "Persist the summary", dueDate: "2026-09-09" });
    await center.runAutomation();
    center.updateSettings({ digestEnabled: true, digestTime: "08:00" });
    assert.equal(center.listPage().unread, 1);
  } finally {
    store.close();
  }

  const reopened = new LocalFirstStore(root, { clock });
  await reopened.initialize();
  try {
    const reopenedTasks = new TaskManagementService({ store: reopened, clock });
    const reopenedCenter = new NotificationCenterService({ store: reopened, tasks: reopenedTasks, clock });
    const settings = reopenedCenter.getSettings();
    assert.equal(settings.digestEnabled, true);
    assert.equal(settings.digestTime, "08:00");
    const page = reopenedCenter.listPage();
    assert.equal(page.unread, 1);
    assert.equal(page.notifications.length, 2); // MEETING_READY (read) + TASK_DUE
    const readyItem = page.notifications.find((item) => item.kind === "MEETING_READY");
    assert.ok(readyItem !== undefined);
    assert.ok(readyItem!.readAt !== null);
    const dueItem = page.notifications.find((item) => item.kind === "TASK_DUE");
    assert.ok(dueItem !== undefined);
    assert.equal(dueItem!.readAt, null);
    for (const item of page.notifications) {
      assertNotificationShape(item);
    }
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
