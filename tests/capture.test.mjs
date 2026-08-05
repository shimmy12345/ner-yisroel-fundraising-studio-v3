import assert from "node:assert/strict";
import {
  extractInteraction,
  inferInteractionKind,
  inferSubject,
  reminderDueAt,
  sanitizeRelationshipSnapshot,
  splitInteractionSummary,
} from "../lib/capture/interaction.ts";
import { isFutureScheduledDate, parseScheduledDate, schedulingLabel, toLocalDateTimeValue } from "../lib/capture/scheduling.ts";
import { searchDonors } from "../lib/relationships/donor-search.ts";
import { isScheduledActivity, sanitizeScheduledRelationshipContext, scheduleBucket } from "../lib/workspace/scheduled-activity.ts";
import { readFile } from "node:fs/promises";

const note = "Coffee with Elena. She loved Maya’s update and wants to visit campus this fall. I promised to send the outcomes brief.";

assert.equal(inferInteractionKind(note), "meeting");
assert.equal(inferSubject(note, "meeting"), "Campus visit and impact update");

const extracted = extractInteraction(note);
assert.equal(extracted.type, "meeting");
assert.equal(extracted.subject, "", "an unaccepted suggestion never becomes the saved subject");
assert.equal(extracted.suggestedSubject, "Campus visit and impact update");
assert.deepEqual(extracted.commitments, ['Send the material referenced in “Campus visit and impact update”']);
assert.equal(extractInteraction(note, "meeting", "Campus stewardship").subject, "Campus stewardship", "an explicitly accepted subject is preserved");
assert.match(extracted.relationshipSummary, /Latest discussion topics: Campus visit and impact update\./);
assert.match(extracted.relationshipSummary, /People mentioned: Elena, Maya/);
assert.match(extracted.relationshipSummary, /Commitments:/);
assert.match(extracted.relationshipSummary, /Recommended next action:/);
assert.doesNotMatch(extracted.relationshipSummary, /sentiment|confidence|classification|extraction/i);
assert.deepEqual(splitInteractionSummary("\nFirst line of the note\nSecond line"), { subject: "", note: "First line of the note\nSecond line", timelineTitle: "Interaction Note", timelineNote: "First line of the note" });
assert.deepEqual(splitInteractionSummary("Stewardship call\nFirst line\nSecond line"), { subject: "Stewardship call", note: "First line\nSecond line", timelineTitle: "Stewardship call", timelineNote: "First line\nSecond line" });
assert.equal(sanitizeRelationshipSnapshot("Latest meeting: Campus visit. No positive or negative sentiment was inferred."), "Latest meeting: Campus visit.");
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
const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const timelineExperience = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const workspace = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const donorDirectory = await readFile(new URL("../app/donors/page.tsx", import.meta.url), "utf8");
const donorDirectoryExperience = await readFile(new URL("../app/donors/DonorDirectoryExperience.tsx", import.meta.url), "utf8");
assert.doesNotMatch(interactionRoute, /Only meetings can be scheduled in the future/);
assert.match(interactionRoute, /capture-scheduled/);
assert.match(interactionRoute, /if \(!scheduled\)/);
assert.match(interactionRoute, /\["call", "email", "meeting", "visit", "note", "personal"\]/);
assert.match(interactionRoute, /storedType, occurredAtEpoch/);
assert.match(captureExperience, /subject: subject\.trim\(\)/, "the accepted field value, including blank, is sent explicitly");
assert.match(captureExperience, /placeholder=\{note\.trim\(\)\.length >= 4 \? preview\.suggestedSubject/);
assert.match(captureExperience, /Use suggestion/);
assert.doesNotMatch(captureExperience, /subject: subject\.trim\(\) \|\| undefined/);
assert.match(timelineExperience, /splitInteractionSummary\(activity\.summary\)/);
assert.match(workspace, /i\.source LIKE 'capture-scheduled:%' OR i\.occurred_at > i\.created_at/);
assert.match(workspace, /todaySchedule/);
assert.match(workspace, /upcomingActivities/);
assert.match(workspace, /i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(workspace, /MAX\(occurred_at\).*source NOT LIKE 'capture-scheduled:%'.*occurred_at <= created_at/);
assert.match(donorDirectory, /DonorDirectoryExperience/);
assert.match(donorDirectoryExperience, /searchDonors\(relationships\.map/);

process.stdout.write("Capture behavior checks passed.\n");
