import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TaskManagementService } from "../src/tasks/TaskManagementService";
import { StorageError } from "../src/storage/errors";
import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore } from "./helpers";

async function seedMeetingWithAnalysis(store: LocalFirstStore, options: { title?: string; taskText?: string; followups?: string[]; analysisCreatedAt?: string } = {}): Promise<string> {
  const meetingId = randomUUID();
  await store.createMeeting({
    meetingId,
    title: options.title ?? "Planning sync",
    meetingDate: "2026-09-07",
    startedAt: "2026-09-07T09:00:00.000Z",
  });
  await store.saveAnalysis(
    {
      meetingId,
      createdAt: options.analysisCreatedAt ?? "2026-09-08T10:00:00.000Z",
      summary: "Local-first storage confirmed.",
      decisions: [],
      tasks: options.taskText === undefined ? [] : [{ taskId: randomUUID(), text: options.taskText }],
      risks: [],
      questions: [],
      followups: options.followups ?? [],
    },
    {},
  );
  return meetingId;
}

async function seedPlainMeeting(store: LocalFirstStore, title = "Standup"): Promise<string> {
  const meetingId = randomUUID();
  await store.createMeeting({ meetingId, title, meetingDate: "2026-09-09", startedAt: "2026-09-09T09:00:00.000Z" });
  return meetingId;
}

function service(store: LocalFirstStore): TaskManagementService {
  return new TaskManagementService({ store, clock: () => new Date("2026-09-09T08:00:00.000Z") });
}

test("tasks: analysis-extracted tasks list with meeting and analysis provenance", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedMeetingWithAnalysis(store, {
      title: "Planning sync",
      taskText: "Verify the backup restore flow on Windows",
      followups: ["Check restore once installer lands", "Ask finance about the reserve"],
    });
    const items = service(store).listTasks();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.meetingId, meetingId);
    assert.equal(item.meetingTitle, "Planning sync");
    assert.equal(item.meetingDate, "2026-09-07");
    assert.equal(item.sourceKind, "ANALYSIS_TASKS");
    assert.equal(item.analysisDate, "2026-09-08T10:00:00.000Z");
    assert.equal(item.text, "Verify the backup restore flow on Windows");
    assert.equal(item.status, "OPEN");
    assert.equal(typeof item.taskId, "string");
    assert.ok(!JSON.stringify(item).includes("/"), "task DTO must never contain paths");
  });
});

test("tasks: manual create, edit, complete and reopen keep provenance and audit", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedPlainMeeting(store);
    const tasks = service(store);
    const created = tasks.createTask({
      meetingId,
      text: "  Send the notes to the team  ",
      assignee: "  Ada ",
      dueDate: "2026-10-01",
    });
    assert.equal(created.text, "Send the notes to the team");
    assert.equal(created.assignee, "Ada");
    assert.equal(created.dueDate, "2026-10-01");
    assert.equal(created.sourceKind, "MANUAL");
    assert.equal(created.status, "OPEN");

    const done = tasks.setTaskStatus(created.taskId, "DONE");
    assert.equal(done.status, "DONE");

    const reopened = tasks.setTaskStatus(created.taskId, "OPEN");
    assert.equal(reopened.status, "OPEN");

    const inProgress = tasks.setTaskStatus(created.taskId, "IN_PROGRESS");
    assert.equal(inProgress.status, "IN_PROGRESS");

    const edited = tasks.updateTask(created.taskId, { assignee: null, dueDate: null, text: "Send the summary to the team" });
    assert.equal(edited.text, "Send the summary to the team");
    assert.equal(edited.assignee, undefined);
    assert.equal(edited.dueDate, undefined);

    const audits = store.database.listAuditRecords(50).map((entry) => entry.action);
    assert.ok(audits.includes("TASK_CREATED"), audits.join(","));
    assert.ok(audits.includes("TASK_UPDATED"), audits.join(","));
  });
});

test("tasks: invalid transitions, unknown tasks and bad fields are rejected", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedPlainMeeting(store);
    const tasks = service(store);
    const created = tasks.createTask({ meetingId, text: "Ship v2" });

    assert.equal(tasks.setTaskStatus(created.taskId, "DONE").status, "DONE");
    assert.throws(
      () => tasks.setTaskStatus(created.taskId, "IN_PROGRESS"),
      (error: unknown) => error instanceof StorageError && /can only move to: OPEN/i.test(error.message),
    );
    assert.equal(tasks.setTaskStatus(created.taskId, "OPEN").status, "OPEN"); // reopen
    assert.equal(tasks.setTaskStatus(created.taskId, "OPEN").status, "OPEN"); // idempotent
    const cancelled = tasks.setTaskStatus(created.taskId, "CANCELLED");
    assert.equal(cancelled.status, "CANCELLED");
    assert.throws(
      () => tasks.setTaskStatus(created.taskId, "DONE"),
      (error: unknown) => error instanceof StorageError && /can only move to: OPEN/i.test(error.message),
    );
    assert.equal(tasks.setTaskStatus(created.taskId, "OPEN").status, "OPEN"); // reopen cancelled

    assert.throws(() => tasks.setTaskStatus(randomUUID(), "OPEN"), /no longer exists/i);
    assert.throws(() => tasks.updateTask(randomUUID(), { text: "x" }), /no longer exists/i);
    assert.throws(() => tasks.createTask({ meetingId: randomUUID(), text: "Ghost task" }), /does not exist/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "" }), /task text is invalid/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "   " }), /task text is invalid/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "x".repeat(2001) }), /task text is invalid/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "ok", assignee: "x".repeat(201) }), /assignee is too long/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "ok", dueDate: "2026-13-40" }), /due date/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "ok", dueDate: "10/01/2026" }), /due date/i);
    assert.throws(() => tasks.createTask({ meetingId, text: "ok", dueDate: "2026-02-30" }), /not a real calendar date/i);
    assert.equal(tasks.createTask({ meetingId, text: "ok", dueDate: "2026-02-28" }).dueDate, "2026-02-28");
  });
});

test("tasks: source artifacts must belong to the originating meeting", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeetingWithAnalysis(store, { taskText: "task a" });
    const secondId = await seedMeetingWithAnalysis(store, { taskText: "task b" });
    const foreignArtifact = store.database.listArtifacts(secondId).find((artifact) => artifact.artifactType === "ANALYSIS_TASKS");
    assert.ok(foreignArtifact !== undefined);
    assert.throws(
      () => service(store).createTask({ meetingId: firstId, text: "wrong provenance", sourceArtifactId: foreignArtifact!.fileId }),
      /does not belong to the originating meeting/i,
    );
  });
});

test("tasks: list filtering by meeting and status, active-first ordering and limit", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeetingWithAnalysis(store, { title: "Alpha", taskText: "Old open task", analysisCreatedAt: "2026-09-01T10:00:00.000Z" });
    const secondId = await seedMeetingWithAnalysis(store, { title: "Beta", taskText: "Due soon", analysisCreatedAt: "2026-09-02T10:00:00.000Z" });
    const tasks = service(store);
    const dueSoon = tasks.createTask({ meetingId: secondId, text: "Manual due soon", dueDate: "2026-09-10" });
    void dueSoon;
    const later = tasks.createTask({ meetingId: firstId, text: "Manual later", dueDate: "2026-12-01" });
    void later;
    const done = tasks.createTask({ meetingId: firstId, text: "Finished already" });
    tasks.setTaskStatus(done.taskId, "DONE");

    const all = tasks.listTasks();
    assert.equal(all.length, 5); // two analysis tasks + three manual
    // Active tasks sort before done ones.
    assert.equal(all[all.length - 1]?.status, "DONE");
    const onlyBeta = tasks.listTasks({ meetingId: secondId });
    assert.equal(onlyBeta.length, 2);
    assert.ok(onlyBeta.every((item) => item.meetingId === secondId));
    const open = tasks.listTasks({ status: "OPEN" });
    assert.equal(open.length, 4);
    const doneOnly = tasks.listTasks({ status: "DONE" });
    assert.equal(doneOnly.length, 1);
    const single = tasks.listTasks({ limit: 1 });
    assert.equal(single.length, 1);
  });
});

test("tasks: follow-up suggestions come from analysis artifacts only, with conversion and dedupe", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeetingWithAnalysis(store, {
      title: "Planning",
      followups: ["Check restore once the installer lands", "Ask finance about the reserve"],
    });
    const secondId = await seedPlainMeeting(store);

    const tasks = service(store);
    const suggestions = await tasks.listFollowupSuggestions();
    assert.equal(suggestions.length, 2);
    for (const suggestion of suggestions) {
      assert.equal(suggestion.meetingId, firstId);
      assert.equal(suggestion.meetingTitle, "Planning");
      assert.equal(suggestion.analysisDate, "2026-09-08T10:00:00.000Z");
      assert.equal(suggestion.alreadyTask, false);
      assert.equal(typeof suggestion.sourceArtifactFileId, "string");
      assert.match(suggestion.followupId, /:/);
    }
    const scoped = await tasks.listFollowupSuggestions(secondId);
    assert.equal(scoped.length, 0);

    const converted = await tasks.convertFollowupToTask(suggestions[0]!.followupId);
    assert.equal(converted.text, "Check restore once the installer lands");
    assert.equal(converted.sourceKind, "ANALYSIS_FOLLOWUPS");
    assert.equal(converted.analysisDate, "2026-09-08T10:00:00.000Z");
    assert.equal(converted.meetingId, firstId);

    const after = await tasks.listFollowupSuggestions();
    const flagged = after.find((suggestion) => suggestion.text === "Check restore once the installer lands");
    assert.ok(flagged !== undefined);
    assert.equal(flagged!.alreadyTask, true);

    // Converting the same follow-up twice is idempotent (returns the same task).
    const again = await tasks.convertFollowupToTask(suggestions[0]!.followupId);
    assert.equal(again.taskId, converted.taskId);
    assert.equal((await tasks.listFollowupSuggestions()).filter((item) => item.text === "Check restore once the installer lands").length, 1);

    await assert.rejects(
      tasks.convertFollowupToTask("not-a-real-followup"),
      /invalid/i,
    );
    await assert.rejects(
      tasks.convertFollowupToTask(`${suggestions[1]!.sourceArtifactFileId}:99`),
      /no longer exists/i,
    );
  });
});

test("tasks: persist across store reopen with provenance, owner, due date and status", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-tasks-persist-"));
  try {
    const open = async (): Promise<LocalFirstStore> => {
      const store = new LocalFirstStore(root);
      await store.initialize();
      return store;
    };
    const first = await open();
    const meetingId = randomUUID();
    await first.createMeeting({ meetingId, title: "Planning sync", meetingDate: "2026-09-07", startedAt: "2026-09-07T09:00:00.000Z" });
    await first.saveAnalysis(
      {
        meetingId,
        createdAt: "2026-09-08T10:00:00.000Z",
        summary: "s",
        decisions: [],
        tasks: [{ taskId: randomUUID(), text: "Verify backup restore on Windows", assignee: "Ada", dueDate: "2026-10-01", status: "OPEN" }],
        risks: [],
        questions: [],
        followups: ["Check restore flow"],
      },
      {},
    );
    const service = new TaskManagementService({ store: first, clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const manual = service.createTask({ meetingId, text: "Manual task", assignee: "Bilal", dueDate: "2026-10-15" });
    service.setTaskStatus(manual.taskId, "IN_PROGRESS");
    first.close();

    const second = await open();
    const tasks = new TaskManagementService({ store: second, clock: () => new Date("2026-09-09T09:00:00.000Z") });
    const items = tasks.listTasks({ meetingId });
    assert.equal(items.length, 2);
    const analysisTask = items.find((item) => item.text === "Verify backup restore on Windows");
    assert.ok(analysisTask !== undefined);
    assert.equal(analysisTask!.sourceKind, "ANALYSIS_TASKS");
    assert.equal(analysisTask!.analysisDate, "2026-09-08T10:00:00.000Z");
    assert.equal(analysisTask!.assignee, "Ada");
    assert.equal(analysisTask!.dueDate, "2026-10-01");
    assert.equal(analysisTask!.meetingTitle, "Planning sync");
    const persistedManual = items.find((item) => item.text === "Manual task");
    assert.ok(persistedManual !== undefined);
    assert.equal(persistedManual!.status, "IN_PROGRESS");
    assert.equal(persistedManual!.assignee, "Bilal");
    assert.equal(persistedManual!.dueDate, "2026-10-15");
    assert.equal(persistedManual!.sourceKind, "MANUAL");

    const done = tasks.setTaskStatus(analysisTask!.taskId, "DONE");
    assert.equal(done.status, "DONE");
    second.close();

    const third = await open();
    try {
      const after = new TaskManagementService({ store: third, clock: () => new Date("2026-09-09T10:00:00.000Z") }).listTasks({ meetingId });
      assert.equal(after.find((item) => item.taskId === analysisTask!.taskId)?.status, "DONE");
      // Provenance survives even after the status change was persisted.
      assert.equal(after.find((item) => item.taskId === analysisTask!.taskId)?.sourceKind, "ANALYSIS_TASKS");
    } finally {
      third.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tasks: renderer-safe task DTOs never leak paths or artifact names", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedMeetingWithAnalysis(store, {
      title: "Planning",
      taskText: "Verify restore",
      followups: ["Check restore flow"],
    });
    const tasks = service(store);
    const suggestions = await tasks.listFollowupSuggestions();
    const converted = await tasks.convertFollowupToTask(suggestions[0]!.followupId);
    const serialized = JSON.stringify([...tasks.listTasks({ meetingId }), ...suggestions, converted]);
    assert.ok(!serialized.includes("/"), "task DTOs must never contain path separators");
    assert.ok(!serialized.includes("\\"), "task DTOs must never contain backslashes");
    assert.ok(!serialized.includes(".txt"), "task DTOs must never expose artifact file names");
    assert.ok(!serialized.includes(".json"), "task DTOs must never expose artifact file names");
    assert.equal(serialized.includes("DATA_ROOT"), false);
  });
});

test("tasks: corrupted follow-up artifacts never block suggestions for other meetings", async () => {
  await withTempStore(async (store, root) => {
    const firstId = await seedMeetingWithAnalysis(store, { title: "Good", followups: ["One good follow-up"] });
    await seedMeetingWithAnalysis(store, { title: "Bad artifact", followups: ["Hidden"] });
    const brokenArtifact = store.database.listArtifacts(firstId).find((artifact) => artifact.artifactType === "ANALYSIS_FOLLOWUPS");
    assert.ok(brokenArtifact !== undefined);
    await rm(join(root, brokenArtifact!.relativePath), { force: true });

    const suggestions = await service(store).listFollowupSuggestions();
    assert.ok(suggestions.length >= 1);
    assert.ok(!suggestions.some((suggestion) => suggestion.meetingId === firstId));
  });
});
