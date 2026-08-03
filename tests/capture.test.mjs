import assert from "node:assert/strict";
import {
  extractInteraction,
  inferInteractionKind,
  inferSubject,
  reminderDueAt,
} from "../lib/capture/interaction.ts";
import { isFutureScheduledDate, parseScheduledDate, schedulingLabel, toLocalDateTimeValue } from "../lib/capture/scheduling.ts";
import { searchDonors } from "../lib/relationships/donor-search.ts";
import { isScheduledActivity, sanitizeScheduledRelationshipContext, scheduleBucket } from "../lib/workspace/scheduled-activity.ts";
import { readFile } from "node:fs/promises";

const note = "Coffee with Elena. She loved Maya’s update and wants to visit campus this fall. I promised to send the outcomes brief.";

assert.equal(inferInteractionKind(note), "meeting");
assert.equal(inferSubject(note, "meeting"), "Elena");

const extracted = extractInteraction(note);
assert.equal(extracted.type, "meeting");
assert.equal(extracted.subject, "Elena");
assert.equal(extracted.sentiment, "warm");
assert.deepEqual(extracted.commitments, ['Send the material referenced in “Elena”']);
assert.equal(inferInteractionKind("Visited the campus with Elena"), "visit");
assert.equal(extractInteraction("Visited the campus with Elena").type, "visit");

const now = new Date("2026-07-30T16:00:00-04:00");
assert.equal(reminderDueAt("none", undefined, now), null);
assert.equal(reminderDueAt("tomorrow", undefined, now)?.getDate(), 31);
assert.equal(reminderDueAt("next-week", undefined, now)?.getDate(), 6);
assert.equal(reminderDueAt("custom", "2026-08-15", now)?.getDate(), 15);
assert.equal(reminderDueAt("custom", undefined, now), null);

assert.equal(toLocalDateTimeValue(new Date(2026, 6, 30, 16, 5)), "2026-07-30T16:05");
assert.equal(parseScheduledDate("not-a-date"), null);
assert.equal(isFutureScheduledDate("2026-07-31T10:00", new Date(2026, 6, 30, 16, 0)), true);
assert.equal(schedulingLabel("2026-07-30T16:00", new Date(2026, 6, 30, 16, 0, 30)), "Now");

const scheduleNow = Math.floor(new Date("2026-08-03T10:00:00-04:00").getTime() / 1000);
const createdAt = scheduleNow - 3600;
const todayCall = Math.floor(new Date("2026-08-03T15:00:00-04:00").getTime() / 1000);
const futureEmail = Math.floor(new Date("2026-08-05T09:00:00-04:00").getTime() / 1000);
const pastCall = Math.floor(new Date("2026-08-01T09:00:00-04:00").getTime() / 1000);
assert.equal(isScheduledActivity("capture-scheduled:call", todayCall, createdAt), true);
assert.equal(scheduleBucket("capture-scheduled:call", todayCall, createdAt, scheduleNow, "America/New_York"), "today");
assert.equal(scheduleBucket("capture-scheduled:email", futureEmail, createdAt, scheduleNow, "America/New_York"), "upcoming");
assert.equal(scheduleBucket("capture-scheduled:meeting", futureEmail, createdAt, scheduleNow, "America/New_York"), "upcoming");
assert.equal(scheduleBucket("capture:call", pastCall, scheduleNow, scheduleNow, "America/New_York"), null);
assert.deepEqual(sanitizeScheduledRelationshipContext(
  "Latest meeting: schedule meeting. No positive or negative sentiment was inferred.",
  "Captured from meeting: schedule meeting",
  [{ type: "meeting", summary: "schedule meeting\nschedule meeting", source: "capture:meeting", occurredAt: futureEmail, createdAt }],
), { summary: null, memory: null });

const donors = [
  { id: "2", name: "Zimmer Household", lastName: "Zimmer", spouse: "Ari", code: "JL-200", email: "z@example.test", phone: "555-2000" },
  { id: "1", name: "Adler Household", lastName: "Adler", spouse: "Miriam", code: "JL-100", email: "a@example.test", phone: "555-1000" },
];
assert.deepEqual(searchDonors(donors, "").map((donor) => donor.id), ["1", "2"]);
assert.equal(searchDonors(donors, "Miriam")[0]?.id, "1");
assert.equal(searchDonors(donors, "JL-200")[0]?.id, "2");
assert.equal(searchDonors(donors, "5551000")[0]?.id, "1");

const interactionRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
const workspace = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const donorDirectory = await readFile(new URL("../app/donors/page.tsx", import.meta.url), "utf8");
assert.doesNotMatch(interactionRoute, /Only meetings can be scheduled in the future/);
assert.match(interactionRoute, /capture-scheduled/);
assert.match(interactionRoute, /if \(!scheduled\)/);
assert.match(interactionRoute, /\["call", "email", "meeting", "visit", "note", "personal"\]/);
assert.match(interactionRoute, /storedType, occurredAtEpoch/);
assert.match(workspace, /i\.source LIKE 'capture-scheduled:%' OR i\.occurred_at > i\.created_at/);
assert.match(workspace, /todaySchedule/);
assert.match(workspace, /upcomingActivities/);
assert.match(workspace, /i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(workspace, /MAX\(occurred_at\).*source NOT LIKE 'capture-scheduled:%'.*occurred_at <= created_at/);
assert.match(donorDirectory, /searchDonors\(searchable, "", Number\.MAX_SAFE_INTEGER\)/);

process.stdout.write("Capture behavior checks passed.\n");
