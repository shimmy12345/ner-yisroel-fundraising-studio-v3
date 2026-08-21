import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractInteraction } from "../lib/capture/interaction.ts";

// Regression for the 2026-08-21 outcome-route acceptance-gap fix (Option
// B -- see docs/AI-HANDOFF.md "Outcome-Route Acceptance-Gap
// Investigation" and its follow-up implementation entry), UPDATED for
// the same-day Option A implementation ("Outcome-Note Relationship
// Snapshot Review/Accept Flow") that re-adds a relationship-snapshot
// write to this route.
//
// Before Option B, app/api/interactions/[id]/outcome/route.ts wrote
// donors.relationship_summary/institutional_memory UNCONDITIONALLY
// whenever an activity was marked completed/no-response -- no
// acceptRelationshipSnapshot gate (unlike the main capture route), no
// preview shown to the user, and no compare-and-swap (unlike the
// sibling app/api/interactions/[id]/route.ts edit/archive handlers) --
// so completing (or re-editing) ANY scheduled activity could silently
// replace or null an already-good, previously human-accepted
// Relationship Snapshot, regardless of the activity's content or which
// donor it belonged to (including shared-activity-linked interactions
// that later reach "scheduled" status for one recipient). Option B fixed
// this by removing the write entirely, since the outcome page had no
// review/accept UI to give an acceptance flag real meaning.
//
// Option A gives the outcome page that review/accept UI (a live preview
// plus an explicit, default-unchecked checkbox in OutcomeExperience.tsx,
// mirroring CaptureExperience.tsx) and, ONLY once that UI exists,
// restores the write -- but strictly behind the same double-gate the
// main capture route already uses, plus a NULL-safe compare-and-swap
// against the donor row read at the top of the same request. This file
// now proves the SPECIFIC danger Option B fixed -- an unconditional or
// silently-inferred write -- still cannot happen, not that the write is
// categorically absent.
//
// This repo tests route-level behavior structurally (see the existing
// tests/activity-outcome.test.mjs and tests/capture.test.mjs), since the
// actual route handlers depend on the cloudflare:workers `env` binding
// and can't be invoked directly outside a Workers runtime. Combined with
// running the REAL extractInteraction() function (not a reimplementation)
// against realistic notes, this proves both WHAT would be proposed and
// THAT the route can only ever write it behind an explicit, per-request
// acceptance flag the user must have seen a matching preview for.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  const outcomeRoute = await read("app/api/interactions/[id]/outcome/route.ts");

  // ---- The write exists again (Option A), but ONLY inside a block
  // gated on both (a) the activity genuinely closing (completed/
  // no-response -- cancel/reschedule/reopen never reach it) and (b) an
  // explicit acceptRelationshipSnapshot === true flag from the client.
  // This is the same shape as the main capture route's own gate, checked
  // below. ----
  assert.match(
    outcomeRoute,
    /if \(\(nextStatus === "completed" \|\| nextStatus === "no-response"\) && body\.acceptRelationshipSnapshot === true\) \{/,
    "the relationship-snapshot write must remain gated on BOTH the activity closing and an explicit acceptRelationshipSnapshot === true flag -- never unconditional, never inferred from action alone",
  );
  // The gate must appear strictly before the one and only UPDATE donors
  // statement in this route -- i.e. there is no second, ungated write
  // path that bypasses the check above.
  const gateIndex = outcomeRoute.indexOf('body.acceptRelationshipSnapshot === true');
  const writeIndex = outcomeRoute.indexOf('UPDATE donors SET relationship_summary');
  assert.ok(gateIndex >= 0 && writeIndex >= 0 && gateIndex < writeIndex, "the acceptance gate must appear before the donors UPDATE, and both must exist exactly once");
  assert.equal(
    (outcomeRoute.match(/UPDATE donors SET relationship_summary/g) ?? []).length,
    1,
    "there must be exactly one relationship-snapshot write path in this route -- no second, ungated one",
  );

  // ---- The write additionally requires the extractor to have found
  // something concrete -- an accepted checkbox alone, with nothing
  // meaningful in the note, must not write. ----
  assert.match(
    outcomeRoute,
    /if \(extracted\.relationshipSummary !== null\) \{/,
    "even with acceptRelationshipSnapshot === true, the write must not proceed unless the extractor actually found something",
  );

  // ---- The write is a NULL-safe compare-and-swap against the donor row
  // read at the top of THIS request, not an unconditional replace --
  // this is what stands in for Option B's removed write's safety net. ----
  assert.match(
    outcomeRoute,
    /WHERE id = \? AND owner_user_id = \? AND data_source = 'live' AND relationship_summary IS \? AND institutional_memory IS \?/,
    "the relationship-snapshot write must be a NULL-safe (IS, not =) compare-and-swap against the donor's current relationship_summary/institutional_memory read at request start",
  );
  assert.match(
    outcomeRoute,
    /relationshipUpdated = \(results\[relationshipStatementIndex\]\?\.meta\?\.changes \?\? 0\) > 0/,
    "a failed compare-and-swap (stale donor row) must fail closed -- reported honestly as not updated, not silently treated as success",
  );

  // ---- Never inferred: the write must depend on the client-sent flag,
  // never on note content alone (e.g. no code path that sets
  // acceptRelationshipSnapshot itself, or writes whenever `extracted...
  // !== null` regardless of the flag). ----
  assert.doesNotMatch(
    outcomeRoute,
    /body\.acceptRelationshipSnapshot\s*=(?!=)/,
    "the route must never assign/infer acceptRelationshipSnapshot itself -- it must only ever read the client-sent value",
  );

  // ---- Reopen/cancel/reschedule structurally cannot reach the write:
  // the gate above requires nextStatus to be completed/no-response,
  // which those three actions never set (see the action branches). ----
  assert.match(outcomeRoute, /nextStatus = "scheduled";[\s\S]*?\} else if \(body\.action === "cancel"\)/, "reopen must set nextStatus to \"scheduled\", which the relationship-write gate excludes");
  assert.match(outcomeRoute, /nextStatus = "cancelled";/, "cancel must set nextStatus to \"cancelled\", which the relationship-write gate excludes");
  assert.match(outcomeRoute, /nextOccurredAt = Math\.floor\(rescheduledAt\.getTime\(\) \/ 1000\);\s*nextSource = `capture-scheduled:rescheduled:/, "reschedule keeps the activity scheduled, which the relationship-write gate excludes");

  // ---- Reproduce realistic scenarios with the REAL extractInteraction()
  // function, to prove what the route would propose (not write, since
  // this route only ever writes on explicit accept) -- grounding the
  // gate assertions above in concrete extractor behavior, not just an
  // abstract presence check. ----

  // A routine outcome note that DOES extract non-null content -- proves
  // the route would only write this if the user explicitly accepted it
  // (the gate assertions above), never automatically.
  const routineNote = "Called to confirm he's coming to the dinner.\nOutcome: Confirmed, will attend.";
  const routineExtracted = extractInteraction(routineNote, "call", "Dinner RSVP confirmation call");
  assert.notEqual(
    routineExtracted.relationshipSummary,
    null,
    "sanity check: this routine note extracts non-null content under the real extractor -- the route must never write this without an explicit accept, per the gate assertions above",
  );

  // A fully generic outcome note that extracts nothing -- proves that
  // even with acceptRelationshipSnapshot === true, this route (and the
  // client, which only ever sends true when its own preview is non-null)
  // would never write anything for this note.
  const genericNote = "Left a voicemail.\nOutcome: No answer.";
  const genericExtracted = extractInteraction(genericNote, "call", "Follow-up call");
  assert.equal(
    genericExtracted.relationshipSummary,
    null,
    "sanity check: this generic note extracts nothing under the real extractor -- confirms the `extracted.relationshipSummary !== null` gate above is not vacuous",
  );

  // ---- Shared-activity-linked interactions: the route's own donor
  // lookup has no special case for shared_activity_id, so a shared/
  // broadcast-originated interaction that reaches "scheduled" status
  // for one recipient (isScheduledActivity/activityStatus depend only
  // on source/occurredAt/createdAt, never shared_activity_id) can still
  // reach this route via ownedActivity(). The write is still scoped to
  // exactly `existing.donor_id` -- the one donor tied to the one
  // interaction id this request already resolved -- with no fan-out
  // possible to other recipients of the same shared_activity_id, and
  // still requires that donor's OWN explicit accept from OutcomeExperience.
  // tsx before anything is written. ----
  assert.match(
    outcomeRoute,
    /async function ownedActivity\(id: string, userId: string\) \{\s*return env\.DB\.prepare\(`SELECT i\.id, i\.donor_id, i\.type, i\.occurred_at, i\.summary, i\.source, i\.created_at, d\.relationship_summary, d\.institutional_memory/,
    "ownedActivity must still operate uniformly on any owned interaction row, with no shared_activity_id special-casing needed -- the write is scoped to existing.donor_id from a single resolved interaction id, so no fan-out is structurally possible",
  );
  assert.match(
    outcomeRoute,
    /existing\.donor_id, profile\.id, existing\.relationship_summary, existing\.institutional_memory/,
    "the relationship-snapshot write must bind to existing.donor_id -- the single donor already resolved for this one interaction id, never a broader shared-activity scope",
  );

  // ---- Ordinary completion/no-response/status/persistence behavior
  // must be completely unaffected by this fix. ----
  assert.match(outcomeRoute, /UPDATE interactions SET occurred_at = \?, summary = \?, source = \?.*source = \? AND occurred_at = \?/, "the interaction row itself must still be updated (status/source/summary/occurred_at), unchanged by this fix");
  assert.match(outcomeRoute, /capture-completed:\$\{plannedEpoch\}:\$\{body\.action === "no-response" \? "no-response" : "completed"\}:/, "completed/no-response source-prefix generation must be unchanged");
  assert.match(outcomeRoute, /nextStatus = body\.action === "no-response" \? "no-response" : "completed";/, "completed/no-response status transition must be unchanged");
  assert.match(outcomeRoute, /nextSummary = `\$\{subject\}\\n\$\{notes\}\\nOutcome: \$\{outcome\}`;/, "outcome-note persistence into the interaction's own summary must be unchanged");
  assert.match(outcomeRoute, /INSERT INTO activity_status_audits/, "status-change audit logging must be unchanged");
  assert.match(outcomeRoute, /DELETE FROM recommendations WHERE id = \? AND user_id = \?/, "the old activity reminder must still be cleared on outcome, unchanged");
  assert.match(outcomeRoute, /followUpId = `activity-followup-\$\{id\}`;/, "follow-up creation must be unchanged");
  assert.match(outcomeRoute, /action === "reopen"/, "reopen handling must be unchanged");
  assert.match(outcomeRoute, /body\.action === "undo"/, "undo handling must be unchanged");
  assert.match(outcomeRoute, /\(results\[0\]\.meta\?\.changes \?\? 0\) === 0/, "the interaction-row compare-and-swap (stale-update detection) must be unchanged");
  assert.doesNotMatch(outcomeRoute, /DELETE FROM interactions/, "outcome actions must still never hard-delete an interaction row");

  // ---- No regression to the main capture route's own, separate,
  // already-correct acceptance gate. ----
  const interactionRoute = await read("app/api/interactions/route.ts");
  assert.match(
    interactionRoute,
    /if \(!scheduled && body\.acceptRelationshipSnapshot === true\) \{/,
    "the main capture route's explicit-acceptance gate must remain completely unaffected by this fix",
  );

  console.log("outcome-route-relationship-write-removed: ok");
}

await run();
