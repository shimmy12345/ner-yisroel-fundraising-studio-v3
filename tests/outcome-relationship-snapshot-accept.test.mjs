import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractInteraction } from "../lib/capture/interaction.ts";

// Option A (2026-08-21): Outcome-Note Relationship Snapshot Review/Accept
// Flow -- see docs/AI-HANDOFF.md. Covers the six scenarios the task
// explicitly called out, on top of the general gate/CAS/shared-activity
// assertions already in tests/outcome-route-relationship-write-removed.
// test.mjs (that file's name predates this feature and is kept for its
// own git-blame history; it now also asserts the Option A gate shape).
//
// Same repo convention as every other route test here: route/page/
// component behavior is asserted structurally against source text (the
// actual handlers need the cloudflare:workers `env` binding and a live
// D1 database this test suite doesn't have), combined with running the
// REAL extractInteraction() function (never a reimplementation) to prove
// concrete extractor behavior for each scenario.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  const outcomeRoute = await read("app/api/interactions/[id]/outcome/route.ts");
  const outcomePage = await read("app/interactions/[id]/outcome/page.tsx");
  const outcomeExperience = await read("app/interactions/[id]/outcome/OutcomeExperience.tsx");

  // ================================================================
  // Scenario 1: donor already has an accepted Relationship Snapshot,
  // outcome note extracts something new, user explicitly accepts it.
  // ================================================================

  // The donor's CURRENT relationship_summary/institutional_memory is
  // fetched in the SAME query as the interaction/activity row (page.tsx
  // for display, route.ts's ownedActivity() for the write's CAS
  // baseline) -- never a second, separately-cacheable read that could
  // drift from what the write actually compares against.
  assert.match(
    outcomePage,
    /SELECT i\.id, i\.donor_id, d\.display_name, d\.primary_first_name, d\.last_name, d\.donor_code, d\.external_id, i\.type, i\.occurred_at, i\.summary, i\.source, i\.created_at, d\.relationship_summary, d\.institutional_memory/,
    "the outcome page must read the donor's current relationship_summary/institutional_memory in the same query as the activity row",
  );
  assert.match(
    outcomePage,
    /currentRelationshipSummary: activity\.relationship_summary,\s*currentInstitutionalMemory: activity\.institutional_memory,/,
    "the outcome page must pass the donor's current snapshot through to OutcomeExperience as-read, not derived or defaulted",
  );

  // The client shows that current value ALONGSIDE the proposal, so
  // accepting a replacement is a visible, informed choice -- not a
  // silent swap. This is additive to (never a substitute for) the
  // explicit checkbox itself.
  assert.match(
    outcomeExperience,
    /Current Relationship Snapshot:<\/strong>\{" "\}\s*\{activity\.currentRelationshipSummary/,
    "the current stored Relationship Snapshot must be shown to the user before they can accept a proposed replacement",
  );
  assert.match(
    outcomeExperience,
    /<input type="checkbox" checked=\{acceptRelationshipSnapshot\} onChange=\{\(event\) => setAcceptRelationshipSnapshot\(event\.target\.checked\)\} \/>/,
    "acceptance must be a real checkbox bound to component state, not inferred",
  );
  // Defaults unchecked -- re-asserted here explicitly for this scenario,
  // since it is the exact requirement ("Acceptance must be explicit and
  // default to not accepted").
  assert.match(
    outcomeExperience,
    /const \[acceptRelationshipSnapshot, setAcceptRelationshipSnapshot\] = useState\(false\);/,
    "acceptRelationshipSnapshot must default to false",
  );

  // Once accepted and sent, the server's write REPLACES the donor's
  // current relationship_summary/institutional_memory wholesale (the
  // established, existing behavior of every other accept path in this
  // app -- see route.ts's own comment on why merging was rejected),
  // gated by a CAS against the exact value read at request start so a
  // concurrent change elsewhere is never silently clobbered.
  assert.match(
    outcomeRoute,
    /UPDATE donors SET relationship_summary = \?, institutional_memory = \?, relationship_health = 86, updated_at = \?\s*WHERE id = \? AND owner_user_id = \? AND data_source = 'live' AND relationship_summary IS \? AND institutional_memory IS \?/,
    "an accepted proposal must replace relationship_summary/institutional_memory (and bump relationship_health to 86, matching every other accept path) via a CAS against the donor row read at request start",
  );

  // Concrete extractor proof: a note containing a real, specific
  // relationship fact extracts non-null content that would be proposed.
  const richNote = "Spoke with her about her granddaughter's bat mitzvah next spring.\nOutcome: She's excited, wants an invitation.";
  const richExtracted = extractInteraction(richNote, "call", "Bat mitzvah check-in");
  assert.notEqual(richExtracted.relationshipSummary, null, "sanity check: a note with a concrete relationship fact must extract non-null content for this scenario to be meaningful");

  // ================================================================
  // Scenario 2: donor already has an accepted Relationship Snapshot,
  // outcome note extracts something new, user does NOT accept it --
  // the donor's snapshot must remain byte-for-byte unchanged.
  // ================================================================

  // The client only ever sends true when BOTH the box is checked AND
  // the current preview is non-null -- leaving the box unchecked means
  // acceptRelationshipSnapshot is always false in the request body,
  // regardless of what the note contains.
  assert.match(
    outcomeExperience,
    /acceptRelationshipSnapshot: acceptRelationshipSnapshot && preview\.relationshipSummary !== null,/,
    "the client must gate the sent flag on the checkbox state AND a non-null preview -- an unchecked box must never send true",
  );

  // Server-side, the write is entirely inside the gated block -- with
  // acceptRelationshipSnapshot !== true, execution never enters the
  // block, so no UPDATE donors statement is even constructed, let alone
  // executed. This is a stronger guarantee than "the CAS WHERE clause
  // wouldn't match" -- the statement itself is never added to the batch.
  assert.match(
    outcomeRoute,
    /let relationshipStatementIndex = -1;\s*if \(\(nextStatus === "completed" \|\| nextStatus === "no-response"\) && body\.acceptRelationshipSnapshot === true\) \{/,
    "relationshipStatementIndex must start at -1 and the donors UPDATE must only ever be pushed onto the batch inside the acceptance-gated block",
  );
  assert.match(
    outcomeRoute,
    /if \(relationshipStatementIndex >= 0\) relationshipUpdated = /,
    "relationshipUpdated must only be computed from a statement that was actually added to the batch -- never assumed true",
  );

  // ================================================================
  // Scenario 3: outcome note contains no meaningful relationship
  // information -- no checkbox offered, nothing written, regardless of
  // whether the user would have wanted to accept.
  // ================================================================

  assert.match(
    outcomeExperience,
    /No meaningful relationship details detected\./,
    "when nothing extracts, the UI must say so plainly and offer no acceptance affordance",
  );
  // The ternary structure itself: the checkbox/current-value block only
  // renders in the `preview.relationshipSummary !== null` branch: the
  // `null` branch renders only the empty-state paragraph, no <input>.
  assert.match(
    outcomeExperience,
    /\{preview\.relationshipSummary !== null \? \(\s*<div className="relationship-snapshot-preview">/,
    "the checkbox/proposal/current-value block must be conditioned on preview.relationshipSummary !== null",
  );

  const genericNote = "Left a voicemail.\nOutcome: No answer.";
  const genericExtracted = extractInteraction(genericNote, "call", "Follow-up call");
  assert.equal(genericExtracted.relationshipSummary, null, "sanity check: a generic note with no relationship-relevant content must extract null under the real extractor");

  // Server-side, even a maliciously/mistakenly sent acceptRelationshipSnapshot:
  // true for such a note cannot write anything -- the extractor result is
  // recomputed server-side from the actual submitted notes/outcome text,
  // never trusted from the client, and the inner null-check gates the
  // write a second time.
  assert.match(
    outcomeRoute,
    /const extracted = extractInteraction\(`\$\{notes\}\\nOutcome: \$\{outcomeText\}`, kind, subject\);\s*if \(extracted\.relationshipSummary !== null\) \{/,
    "the server must independently re-run extraction on the submitted text and gate the write on a non-null result, never trusting the client's preview",
  );

  // ================================================================
  // Scenario 4: editing an outcome (re-submitting "Save Outcome
  // Changes" on an already-completed activity) must not silently
  // reapply or overwrite the Relationship Snapshot.
  // ================================================================

  // Every page load recomputes acceptRelationshipSnapshot fresh via
  // useState(false) -- there is no prop, query param, or stored value
  // that could pre-check the box when editing an already-completed
  // outcome. The user must check it again, every time, to write again.
  assert.doesNotMatch(
    outcomeExperience,
    /useState\(acceptRelationshipSnapshot\)|acceptRelationshipSnapshot: true/,
    "acceptRelationshipSnapshot must never be initialized from a prop or hardcoded true -- only ever a fresh, unchecked useState(false)",
  );
  // The route handles a re-submitted "complete" action for an
  // already-completed activity through the exact same `else` branch (no
  // separate "edit outcome" code path with different rules), so the
  // same gate applies identically whether this is the first close or a
  // later edit.
  assert.match(
    outcomeRoute,
    /nextStatus = body\.action === "no-response" \? "no-response" : "completed";/,
    "editing an already-completed outcome (re-submitting \"complete\") must set the same nextStatus and go through the identical gated write path -- no separate unguarded edit path exists",
  );

  // ================================================================
  // Scenario 5: reopening an outcome must never touch relationship
  // data, even if the client happens to send acceptRelationshipSnapshot
  // in the request body (submit() always includes it for every action).
  // ================================================================

  // submit() builds one shared JSON body for every action, including
  // acceptRelationshipSnapshot -- so reopen's request body is NOT free
  // of the field; safety here depends entirely on the server-side gate,
  // confirmed below, not on the client omitting the field for reopen.
  assert.match(
    outcomeExperience,
    /action, auditId, outcome, notes, completedAt: isoValue\(completedAt\), rescheduledAt: isoValue\(rescheduledAt\), followUpEnabled,/,
    "submit() must build a single shared request body across all actions (including reopen) -- confirms the server-side gate, not client omission, is what protects reopen",
  );
  assert.match(
    outcomeRoute,
    /if \(body\.action === "reopen"\) \{\s*if \(!\['completed', 'no-response', 'cancelled'\]\.includes\(currentStatus\)\) return Response\.json\(\{ error: "This activity is already open" \}, \{ status: 409 \}\);\s*nextSource = reopenActivitySource\(existing\.source, existing\.type\);\s*nextOccurredAt = plannedEpoch;\s*nextSummary = `\$\{subject\}\\n\$\{notes\}`;\s*nextStatus = "scheduled";/,
    "reopen must set nextStatus to \"scheduled\", which structurally falls outside the completed/no-response write gate regardless of what acceptRelationshipSnapshot the request body carries",
  );

  // ================================================================
  // Scenario 6: shared-activity-linked interactions reaching the
  // outcome route must still only ever write the ONE donor tied to the
  // resolved interaction id -- no fan-out to other recipients of the
  // same shared_activity_id, and no different rules for shared vs.
  // solo activities.
  // ================================================================

  // Checks actual CODE usage (a SQL column reference or JS identifier
  // the route could act on), not prose -- this route's own explanatory
  // comment on the write legitimately mentions shared_activity_id in
  // English, which must not itself fail this check.
  assert.doesNotMatch(
    outcomeRoute,
    /i\.shared_activity_id|\.shared_activity_id\b(?!\s*--)|shared_activity_id\s*=/,
    "the outcome route (including its Option A write) must have no shared_activity_id-specific branch -- safety comes from scoping to a single already-resolved interaction id, not from a special case",
  );
  assert.match(
    outcomeRoute,
    /WHERE i\.id = \? AND i\.user_id = \? AND d\.owner_user_id = \? AND d\.data_source = 'live' LIMIT 1`\)\s*\.bind\(id, userId, userId\)\.first<InteractionRow>\(\);/,
    "ownedActivity must resolve exactly one interaction/donor pair from the single interaction id in the URL -- the same donor the relationship-snapshot write then targets",
  );
  // The OutcomeActivity type/props the client receives are entirely
  // donor-scoped (donorId, donorName, currentRelationshipSummary, ...)
  // with no shared-activity roster or sibling-interaction data at all,
  // so there is no client-side path to a broader accept either.
  assert.doesNotMatch(
    outcomeExperience,
    /shared_activity_id|sharedActivity|recipients/i,
    "OutcomeExperience must have no shared-activity roster or multi-recipient concept -- the accept checkbox can only ever apply to the one donor this page is scoped to",
  );

  console.log("outcome-relationship-snapshot-accept: ok");
}

await run();
