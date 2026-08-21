import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Static source-text checks -- the API routes touch cloudflare:workers'
// `env.DB`, which only exists inside a Workers runtime, so (matching this
// repo's existing convention -- see tests/personalization.test.mjs) their
// D1-dependent safety properties are verified against the route source
// itself rather than by executing them against a live D1 instance.
// tests/monday-import.test.mjs covers everything that IS a pure function
// (parsing, classification, matching, fingerprinting) by actually calling it.

async function run() {
  const preview = await readFile(new URL("../app/api/import/monday/preview/route.ts", import.meta.url), "utf8");
  const commit = await readFile(new URL("../app/api/import/monday/commit/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/onboarding/import/monday/MondayImportExperience.tsx", import.meta.url), "utf8");

  // Both routes are gated to the live workspace only.
  assert.match(preview, /mode !== "live"/);
  assert.match(commit, /mode !== "live"/);

  // Every D1 read/write in both routes is scoped to the authenticated owner.
  assert.match(preview, /WHERE owner_user_id=\? AND data_source='live'/);
  assert.match(commit, /WHERE owner_user_id=\? AND data_source='live'/);
  assert.match(commit, /WHERE id=\? AND user_id=\?/);

  // The preview route never writes -- it only ever SELECTs.
  assert.doesNotMatch(preview, /INSERT INTO|UPDATE |DELETE FROM/);

  // The commit route re-derives the disposition itself rather than trusting
  // whatever label the client sent, and rejects a decision whose action
  // does not match that re-derived disposition.
  assert.match(commit, /classifyMondayDisposition\(text, dueDateIso, todayIso\)/);
  assert.match(commit, /disposition !== "confirm_contact_candidate"/);
  assert.match(commit, /disposition !== "future_planned"/);
  assert.match(commit, /disposition !== "historical_planned"/);

  // This feature can never touch gifts, giving_activities, donor identity,
  // or campaigns -- it only ever writes interactions/recommendations rows
  // it deterministically owns, and never issues a DELETE at all. Checked
  // against the SQL statement strings only (stripping // comments first),
  // since the routes' own doc comments legitimately name those tables when
  // describing the guarantee itself.
  for (const source of [preview, commit]) {
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\bgifts\b/i, "must never reference the gifts table");
    assert.doesNotMatch(code, /giving_activities/i, "must never reference giving_activities");
    assert.doesNotMatch(code, /\bcampaigns\b/i, "must never reference campaigns");
    assert.doesNotMatch(code, /INSERT INTO donors/i, "must never create a donor row");
    assert.doesNotMatch(code, /DELETE FROM/i, "must never delete anything");
  }
  // Relationship Intelligence Phase 2: confirm_contact no longer writes
  // donors.relationship_summary/institutional_memory directly -- it
  // delegates to the shared accept pipeline (lib/relationships/
  // fact-accept.ts + fact-accept-plan.ts), the same decision/synthesis
  // logic every other explicit-acceptance path uses. Unlike the other
  // three routes (which call the single-shot planFactAcceptance()
  // directly), confirm_contact calls the pure planFactAcceptanceStep()
  // against an in-memory per-donor working state it threads across its
  // own decision loop -- the fix for the same-request/same-donor
  // supersession race (see docs/AI-HANDOFF.md's Phase 2 section) -- so
  // it must never call planFactAcceptance() itself. The commit route
  // itself must contain NO direct UPDATE of the donors table at all
  // (confirmed below); the actual donor-column-scoping guarantee
  // ("never donor identity fields like display_name, email, donor_code,
  // or external_id") is checked against fact-accept.ts, the one place
  // that statement now lives.
  assert.match(commit, /planFactAcceptanceStep\(/, "confirm_contact must delegate to the shared pure planning core");
  assert.doesNotMatch(commit, /planFactAcceptance\(/, "confirm_contact must use the state-threading planFactAcceptanceStep(), never the single-shot planFactAcceptance() which would re-read D1 per decision and miss an earlier same-donor decision in this same request");
  assert.doesNotMatch(commit, /UPDATE donors SET/, "confirm_contact must never build its own donors UPDATE statement -- that responsibility now belongs entirely to lib/relationships/fact-accept.ts");
  const factAccept = await readFile(new URL("../lib/relationships/fact-accept.ts", import.meta.url), "utf8");
  const donorUpdateMatch = /UPDATE donors SET relationship_summary = \?, institutional_memory = \?, relationship_health = 86, updated_at = \?\s*WHERE id = \? AND owner_user_id = \? AND data_source = 'live' AND relationship_summary IS \? AND institutional_memory IS \?/.exec(factAccept);
  assert.ok(donorUpdateMatch, "the shared pipeline's donors CAS UPDATE statement must exist and be readable");
  for (const identityField of ["display_name", "email", "donor_code", "external_id", "phone", "address_line_1"]) {
    assert.doesNotMatch(factAccept, new RegExp(`UPDATE donors SET[^;]*\\b${identityField}\\b`), `the shared accept pipeline must never touch donor identity field ${identityField}`);
  }

  // Idempotent upsert: both interactions and recommendations are written
  // via a SELECT-then-UPDATE/INSERT on the same deterministic id, using the
  // monday-prefixed id helpers -- never a bare crypto.randomUUID() row.
  assert.match(commit, /SELECT id FROM interactions WHERE id=\? AND user_id=\?/);
  assert.match(commit, /SELECT id FROM recommendations WHERE id=\? AND user_id=\?/);
  assert.match(commit, /UPDATE interactions SET/);
  assert.match(commit, /UPDATE recommendations SET/);
  assert.match(commit, /mondayInteractionId\(fingerprint\)/);
  assert.match(commit, /mondayRecommendationId\(fingerprint\)/);
  assert.doesNotMatch(commit.replace(/^\s*\/\/.*$/gm, ""), /crypto\.randomUUID/, "Monday-imported rows must use the deterministic monday- id, never a random one");

  // No bulk "confirm contact" path exists anywhere -- every confirmation is
  // a single-row decision with its own explicit date, both in the route's
  // decision loop and in the review UI itself.
  assert.doesNotMatch(commit, /confirmAll|bulkConfirm|confirm_all/i);
  assert.doesNotMatch(ui, /confirm all/i);
  assert.doesNotMatch(ui, /bulk confirm/i);
  assert.match(ui, /bulk "confirm contact" action/i, "the review UI's own file must document that this constraint is deliberate");

  // Historical/undated planned actions never carry the old Monday date
  // forward silently -- "Create follow-up now" always starts from a blank
  // date, and Monday's original date is preserved as provenance in the
  // recommendation's reason text, never reused as the new due date. The
  // task itself must never be described as "historical" -- an
  // accept_future_planned row is a live, not-yet-due follow-up -- so the
  // reason is provenance-only text derived from dueDateIso (the original
  // Monday date), while `action` (asserted separately below) carries the
  // actual task text.
  assert.match(commit, /dueDateLabel = dueDateIso/, "the provenance label must be derived from the original Monday due date, never the new decision.dueDate");
  assert.match(commit, /reason = `Imported from Monday\$\{dueDateLabel/);
  assert.doesNotMatch(commit, /Historical Monday task/, "the task text must never be described as historical");
  assert.match(ui, /setDecision\(key, \{ kind: "create_followup", dueDate: "" \}\)/, "Create follow-up now must start from a blank date, never the old Monday due date");

  // Monday's own Status column ("Done"/blank) is display-only: shown as a
  // hint next to a row, but it must never pre-select a decision, never
  // appear inside a setDecision(...) call, and never be sent to the write
  // route at all -- the commit route has no field for it. Every reference
  // to a row's status must go through the display-only formatter, never
  // read directly to drive a decision or a conditional write path.
  const rowStatusUsages = ui.match(/row\.status\b/g) ?? [];
  assert.ok(rowStatusUsages.length > 0, "the UI must actually read row.status somewhere, to prove this check isn't vacuous");
  const rowStatusAsFormatterArg = ui.match(/mondayStatusLabel\(row\.status\)/g) ?? [];
  assert.equal(rowStatusUsages.length, rowStatusAsFormatterArg.length, "every use of row.status must be an argument to the display-only formatter, never a condition driving setDecision or the commit body");
  const commitBodyMatch = /const base = \{([^}]+)\}/.exec(ui);
  assert.ok(commitBodyMatch, "the commit request body builder must exist and be readable");
  assert.doesNotMatch(commitBodyMatch[1], /status/i, "the commit request body must never include Monday's Status column");
  // recommendations.status ('open'/'completed'/'dismissed') is an
  // unrelated, pre-existing SQL column -- the check here is specifically
  // that the incoming Decision payload is never read for a "status" field.
  assert.doesNotMatch(commit, /decision\.status/, "the commit route must never read a Status field off the incoming decision");

  console.log("Monday import: route and UI safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
