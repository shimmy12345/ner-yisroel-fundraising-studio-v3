import assert from "node:assert/strict";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Deterministic: same (interactionId, generation) always yields the same id.
assert.equal(deriveGoogleEventId("int-1", 0), deriveGoogleEventId("int-1", 0));

// Different generations of the SAME meeting get DIFFERENT ids -- this is
// the whole point: a reopen must never reuse a tombstoned Google id.
assert.notEqual(deriveGoogleEventId("int-1", 0), deriveGoogleEventId("int-1", 1));
assert.notEqual(deriveGoogleEventId("int-1", 1), deriveGoogleEventId("int-1", 2));

// Different meetings never collide.
assert.notEqual(deriveGoogleEventId("int-1", 0), deriveGoogleEventId("int-2", 0));

// Google's own constraints (verified against current Calendar API docs,
// see docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md SS4.1): lowercase
// base32hex only (a-v, 0-9), length 5-1024.
for (const [interactionId, generation] of [["a", 0], ["a-very-long-interaction-id-" + "x".repeat(200), 7], ["", 0], ["unicode-donor-אב", 3]]) {
  const id = deriveGoogleEventId(interactionId, generation);
  assert.match(id, /^[0-9a-v]+$/, `id "${id}" must only contain base32hex characters`);
  assert.ok(id.length >= 5 && id.length <= 1024, `id length ${id.length} must be within Google's 5-1024 range`);
}

// Negative/non-integer generations are rejected outright -- never
// silently coerced into something that might collide.
assert.throws(() => deriveGoogleEventId("int-1", -1));
assert.throws(() => deriveGoogleEventId("int-1", 1.5));

process.stdout.write("calendar-event-id.test.mjs: all assertions passed\n");
