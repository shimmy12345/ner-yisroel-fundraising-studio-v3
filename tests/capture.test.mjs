import assert from "node:assert/strict";
import {
  extractInteraction,
  inferInteractionKind,
  inferSubject,
  reminderDueAt,
} from "../lib/capture/interaction.ts";

const note = "Coffee with Elena. She loved Maya’s update and wants to visit campus this fall. I promised to send the outcomes brief.";

assert.equal(inferInteractionKind(note), "meeting");
assert.equal(inferSubject(note, "meeting"), "Maya’s progress and fall campus visit");

const extracted = extractInteraction(note);
assert.equal(extracted.type, "meeting");
assert.equal(extracted.subject, "Maya’s progress and fall campus visit");
assert.equal(extracted.sentiment, "warm");
assert.deepEqual(extracted.commitments, ["Send scholarship outcomes"]);

const now = new Date("2026-07-30T16:00:00-04:00");
assert.equal(reminderDueAt("none", undefined, now), null);
assert.equal(reminderDueAt("tomorrow", undefined, now)?.getDate(), 31);
assert.equal(reminderDueAt("next-week", undefined, now)?.getDate(), 6);
assert.equal(reminderDueAt("custom", "2026-08-15", now)?.getDate(), 15);
assert.equal(reminderDueAt("custom", undefined, now), null);

process.stdout.write("Capture behavior checks passed.\n");
