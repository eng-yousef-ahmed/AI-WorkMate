import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAssistedJoinPlan, classifyJoinPlatform } from "../src/meetings/AssistedJoin";
import type { CalendarEventAssociation } from "../src/domain/models";

test("classifies Teams, Zoom, Google Meet, other online, and unsafe URLs", () => {
  assert.equal(classifyJoinPlatform("https://teams.microsoft.com/l/meetup-join/19%3Aabc"), "TEAMS");
  assert.equal(classifyJoinPlatform("https://company.zoom.us/j/123456789"), "ZOOM");
  assert.equal(classifyJoinPlatform("https://meet.google.com/abc-defg-hij"), "GOOGLE_MEET");
  assert.equal(classifyJoinPlatform("https://example.com/call"), "OTHER_ONLINE");
  assert.equal(classifyJoinPlatform("file:///etc/passwd"), "NONE");
  assert.equal(classifyJoinPlatform("javascript:alert(1)"), "NONE");
  assert.equal(classifyJoinPlatform("http://127.0.0.1/join"), "NONE");
  assert.equal(classifyJoinPlatform(undefined), "NONE");
});

test("assisted join never claims unattended joining and refuses cancelled meetings", () => {
  const association: CalendarEventAssociation = {
    provider: "MICROSOFT_GRAPH",
    externalEventId: "evt-1",
    meetingId: "m-1",
    subject: "Standup",
    startTime: "2026-09-09T10:00:00.000Z",
    endTime: "2026-09-09T10:30:00.000Z",
    attendees: [],
    isCancelled: false,
    meetingPlatform: "TEAMS",
    normalizedFingerprint: "fp",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3Aabc", provider: "teamsForBusiness" },
  };
  const plan = buildAssistedJoinPlan({ meetingId: "m-1", meetingTitle: "Standup", association });
  assert.equal(plan.platform, "TEAMS");
  assert.equal(plan.nextAction, "OPEN_JOIN_URL");
  assert.equal(plan.hasJoinUrl, true);
  assert.equal(plan.steps.some((step) => /password|MFA/i.test(step)), true);
  assert.equal(plan.warnings.some((warning) => /CAPTCHA/i.test(warning)), true);
  assert.equal(JSON.stringify(plan).includes("file:"), false);

  const cancelled = buildAssistedJoinPlan({
    meetingId: "m-1",
    meetingTitle: "Standup",
    association: { ...association, isCancelled: true },
  });
  assert.equal(cancelled.nextAction, "UNAVAILABLE");

  const noLink = buildAssistedJoinPlan({ meetingId: "m-2", meetingTitle: "In person" });
  assert.equal(noLink.nextAction, "RECORD_ONLY");
  assert.equal(noLink.platform, "NONE");
});
