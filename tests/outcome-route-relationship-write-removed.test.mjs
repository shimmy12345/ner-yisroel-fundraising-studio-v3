import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractInteraction } from "../lib/capture/interaction.ts";

// Regression for the 2026-08-21 outcome-route acceptance-gap fix (Option
// B -- see docs/AI-HANDOFF.md "Outcome-Route Acceptance-Gap
// Investigation" and its follow-up implementation entry). Before this
// fix, app/api/interactions/[id]/outcome/route.ts wrote
// donors.relationship_summary/institutional_memory UNCONDITIONALLY
// whenever an activity was marked completed/no-response -- no
// acceptRelationshipSnapshot gate (unlike the main capture route), no
// preview shown to the user, and no compare-and-swap (unlike the
// sibling app/api/interactions/[id]/route.ts edit/archive handlers) --
// so completing (or re-editing) ANY scheduled activity could silently
// replace or null an already-good, previously human-accepted
// Relationship Snapshot, regardless of the activity's content or which
// donor it belonged to (including shared-activity-linked interactions
// that later reach "scheduled" status for one recipient). The fix
// removes the write entirely rather than gating it, since the outcome
// page has no review/accept UI to give an acceptance flag real meaning.
//
// This repo tests route-level behavior structurally (see the existing
// tests/activity-outcome.test.mjs and tests/capture.test.mjs), since the
// actual route handlers depend on the cloudflare:workers `env` binding
// and can't be invoked directly outside a Workers runtime. Combined with
// running the REAL extractInteraction() function (not a reimplementation)
// against the same realistic notes used in the investigation's own
// reproduction, this proves both WHAT would have been written and THAT
// the route no longer writes it, for every scenario the investigation
// identified.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  const outcomeRoute = await read("app/api/interactions/[id]/outcome/route.ts");

  // ---- The write is gone, structurally, for every action/status this
  // route can produce -- not merely gated behind a condition that could
  // still be true. This alone proves every scenario below by
  // construction: there is no code path left that can write these
  // fields, so nothing can overwrite or null an existing value,
  // regardless of whether the interaction is being completed for the
  // first time, re-edited after already being completed, marked
  // no-response, or is linked to a shared activity. ----
  assert.doesNotMatch(
    outcomeRoute,
    /UPDATE donors SET relationship_summary/,
    "the outcome route must never write donors.relationship_summary/institutional_memory -- this was the exact unconditional overwrite this fix removes",
  );
  // Checks actual CODE usage (a real reference the route could act on),
  // not prose -- this route's own explanatory comment about the removed
  // write legitimately mentions these field/function names in English,
  // which must not itself fail the test.
  assert.doesNotMatch(
    outcomeRoute,
    /env\.DB\.prepare\([^)]*(relationship_summary|institutional_memory)/s,
    "no SQL statement in this route may reference relationship_summary/institutional_memory",
  );
  assert.doesNotMatch(
    outcomeRoute,
    /extracted\.relationshipSummary|extracted\.memory/,
    "no extracted.relationshipSummary/extracted.memory value may be bound anywhere in this route",
  );
  assert.doesNotMatch(
    outcomeRoute,
    /import \{[^}]*extractInteraction/,
    "extractInteraction must no longer be imported from lib/capture/interaction -- the extraction step that fed the removed write is gone too, not just the write statement",
  );

  // ---- Reproduce the investigation's own scenarios with the REAL
  // extractInteraction() function, to prove what WOULD have been written
  // -- grounding the structural assertions above in the actual concrete
  // risk, not just an abstract absence check. ----

  // Scenario 1/3: an unrelated, routine outcome note. If the old write
  // still existed, this would have overwritten a donor's real,
  // previously-accepted grandchild-milestone snapshot with unrelated
  // RSVP text (matching the investigation's own reproduction).
  const routineNote = "Called to confirm he's coming to the dinner.\nOutcome: Confirmed, will attend.";
  const routineExtracted = extractInteraction(routineNote, "call", "Dinner RSVP confirmation call");
  assert.notEqual(
    routineExtracted.relationshipSummary,
    null,
    "sanity check: this routine note does extract non-null content under the real extractor, matching the investigation's finding -- the fix must prevent this from EVER being written by this route, not rely on the extractor happening to return null",
  );

  // Scenario 2: a fully generic outcome note that extracts nothing.
  // If the old write still existed, this would have silently NULLED an
  // existing relationship_summary.
  const genericNote = "Left a voicemail.\nOutcome: No answer.";
  const genericExtracted = extractInteraction(genericNote, "call", "Follow-up call");
  assert.equal(
    genericExtracted.relationshipSummary,
    null,
    "sanity check: this generic note extracts nothing under the real extractor, matching the investigation's finding -- the fix must prevent this null from EVER reaching donors.relationship_summary via this route",
  );

  // Both scenarios above are real, reproducible extractor outputs; the
  // route-source assertions already proved neither can reach D1 through
  // this route any more, for a first completion OR a later edit of an
  // already-completed outcome (the same code path handles both -- see
  // the single `else` branch generating capture-completed:/no-response
  // sources for both a fresh close and OutcomeExperience.tsx's "Save
  // Outcome Changes" re-submission).

  // ---- Shared-activity-linked interactions: the route's own donor
  // lookup has no special case for shared_activity_id, so a shared/
  // broadcast-originated interaction that reaches "scheduled" status
  // for one recipient (isScheduledActivity/activityStatus depend only
  // on source/occurredAt/createdAt, never shared_activity_id -- proven
  // in the investigation) can still reach this route via ownedActivity().
  // The absence of any relationship-field write above means this can no
  // longer write donor relationship context regardless -- confirmed here
  // that ownedActivity() itself still has no shared_activity_id branch
  // (the fix closes the gap structurally, not by adding a new
  // exclusion). ----
  assert.match(
    outcomeRoute,
    /async function ownedActivity\(id: string, userId: string\) \{\s*return env\.DB\.prepare\(`SELECT i\.id, i\.donor_id, i\.type, i\.occurred_at, i\.summary, i\.source, i\.created_at/,
    "ownedActivity must still operate uniformly on any owned interaction row, with no shared_activity_id special-casing needed -- the write removal above is what actually closes the shared-activity gap",
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
