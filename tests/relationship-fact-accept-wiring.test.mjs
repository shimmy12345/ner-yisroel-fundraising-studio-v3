import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Relationship Intelligence Phase 2 -- cross-cutting regression coverage
// for the properties that are true of the WHOLE wired system (all four
// explicit-acceptance routes plus the shared lib/relationships/
// fact-accept.ts pipeline together), rather than any single route or any
// single pure function in isolation. Companions:
//   - tests/relationship-fact-synthesis.test.mjs (pure synthesis scoring)
//   - tests/relationship-fact-accept-core.test.mjs (pure supersession
//     decision logic)
//   - tests/outcome-route-relationship-write-removed.test.mjs and
//     tests/outcome-relationship-snapshot-accept.test.mjs (Outcome route)
//   - tests/relationship-snapshot-family-terms.test.mjs (Capture route)
//   - tests/monday-import-safety.test.mjs (Monday commit route)
// Same repo convention as those: route files import cloudflare:workers'
// `env` and can't be invoked directly in Node, so D1-dependent properties
// are verified structurally against source text.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relPath) => readFile(path.join(repoRoot, relPath), "utf8");

async function walk(dir, matches = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, matches);
    else if (/\.(ts|tsx)$/.test(entry.name)) matches.push(full);
  }
  return matches;
}

async function run() {
  const appFiles = await walk(path.join(repoRoot, "app"));
  const libFiles = await walk(path.join(repoRoot, "lib"));
  const allFiles = [...appFiles, ...libFiles];

  // ================================================================
  // 10: no legacy automatic relationship-summary overwrite path
  // remains anywhere in the app/lib tree -- the ONLY two places that
  // may ever write donors.relationship_summary are the two CAS
  // statements inside lib/relationships/fact-accept.ts itself
  // (planFactAcceptance's and planFactArchival's). Every other file
  // that references relationship_summary in a write context is a bug:
  // a second, ungated write path this project explicitly requires not
  // to exist.
  // ================================================================
  let writeSites = 0;
  for (const file of allFiles) {
    const relPath = path.relative(repoRoot, file).replace(/\\/g, "/");
    const source = await read(relPath);
    const matches = source.match(/UPDATE donors SET[^;]*relationship_summary/gs) ?? [];
    if (matches.length === 0) continue;
    assert.equal(relPath, "lib/relationships/fact-accept.ts", `found an UPDATE donors ... relationship_summary statement outside the shared accept pipeline, in ${relPath} -- this is exactly the legacy overwrite path Phase 2 requires be fully removed`);
    writeSites += matches.length;
  }
  assert.equal(writeSites, 2, "lib/relationships/fact-accept.ts must contain exactly its two known CAS writes (planFactAcceptance's and planFactArchival's) -- not more, not fewer");

  // ================================================================
  // 5 (the "not deleted" half): no file anywhere ever hard-deletes a
  // relationship fact row. Supersession/archival are status
  // transitions (UPDATE ... SET status = ...), never DELETE.
  // ================================================================
  for (const file of allFiles) {
    const relPath = path.relative(repoRoot, file).replace(/\\/g, "/");
    const source = await read(relPath);
    assert.doesNotMatch(source, /DELETE FROM donor_relationship_facts/, `${relPath} must never hard-delete a relationship fact row -- supersession/archival are status transitions only`);
  }

  // ================================================================
  // 6: structured Ask/yahrtzeit/giving/pledge/payment-plan/reminder
  // information must never be redundantly promoted into relationship
  // facts. The shared pipeline's INSERT binds fact_text to exactly
  // one source -- extracted.relationshipSummary, itself derived only
  // from input.noteText -- and never reads amount_cents, purpose,
  // yahrtzeit fields, pledge fields, or reminder fields at all. This
  // is a structural guarantee (the module doesn't even query those
  // tables for fact content), not a convention that could silently
  // regress.
  // ================================================================
  const factAccept = await read("lib/relationships/fact-accept.ts");
  const factAcceptPlan = await read("lib/relationships/fact-accept-plan.ts");
  assert.match(
    factAcceptPlan,
    /factText: extracted\.relationshipSummary,/,
    "the pure planner's newFact.factText must bind to extracted.relationshipSummary and nothing else -- no ask/yahrtzeit/pledge field may ever be interpolated into it",
  );
  assert.match(
    factAccept,
    /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'current', \?, \?, \?, \?\)`\)\s*\.bind\(newFact\.id, donorId, userId, newFact\.category, newFact\.lifecycle, newFact\.factText, newFact\.sourceInteractionId, newFact\.sourceInteractionOccurredAt, supersedeFactId, newFact\.fingerprint, now, now\)/,
    "the materialized fact_text column must bind to the planned newFact.factText and nothing else -- no ask/yahrtzeit/pledge field may ever be interpolated into it",
  );
  for (const forbidden of ["amount_cents", "amountCents", "askAmount", "yahrtzeit", "pledge_activity_id", "installment_amount_cents", "gift_source"]) {
    assert.doesNotMatch(factAccept, new RegExp(forbidden, "i"), `the shared accept pipeline must never reference ${forbidden} -- structured Ask/yahrtzeit/giving/pledge data must never be duplicated into relationship facts`);
    assert.doesNotMatch(factAcceptPlan, new RegExp(forbidden, "i"), `the pure planning core must never reference ${forbidden} -- structured Ask/yahrtzeit/giving/pledge data must never be duplicated into relationship facts`);
  }
  // The pipeline's only D1 reads are: current facts, the donor row, and
  // pending asks' source_interaction_id (the one narrow, sanctioned
  // channel -- see fact-synthesis's pinning behavior -- which itself
  // never reads amount/purpose). No yahrtzeits/pledges/giving_activities/
  // recommendations table is ever queried by this module.
  for (const forbiddenTable of ["yahrtzeits", "pledge_payment_plans", "giving_activities", "gifts g ", "recommendations"]) {
    assert.doesNotMatch(factAccept, new RegExp(forbiddenTable.trim()), `the shared accept pipeline must never query ${forbiddenTable.trim()} -- structured records stay structured, never folded into a relationship fact`);
  }
  // The pure planning core has no D1 access at all -- it cannot query
  // any table, structured or otherwise (confirmed separately below by
  // its complete lack of a cloudflare:workers import statement -- its
  // own header comment legitimately names "cloudflare:workers" in
  // English when explaining this property, which must not itself fail
  // this check).
  assert.doesNotMatch(factAcceptPlan, /from ["']cloudflare:workers["']/, "the pure planning core must have no cloudflare:workers import at all, so it stays directly unit-testable and provably cannot touch D1");

  // ================================================================
  // 7: source-interaction provenance is correct at every one of the
  // four wired call sites -- each attributes its fact to the specific
  // interaction id (and that interaction's own occurred_at) the
  // acceptance is actually about, never a different or synthetic one.
  // ================================================================
  const captureRoute = await read("app/api/interactions/route.ts");
  assert.match(
    captureRoute,
    /sourceInteractionId: interactionId, sourceInteractionOccurredAt: occurredAtEpoch,/,
    "Capture must attribute the fact to the interaction it is creating in this same request, not a different one",
  );

  const outcomeRoute = await read("app/api/interactions/[id]/outcome/route.ts");
  assert.match(
    outcomeRoute,
    /sourceInteractionId: id, sourceInteractionOccurredAt: nextOccurredAt,/,
    "Outcome must attribute the fact to the activity being closed (this request's own interaction id) and its new occurred_at, not the pre-outcome value",
  );

  const editRoute = await read("app/api/interactions/[id]/route.ts");
  assert.match(
    editRoute,
    /sourceInteractionId: id, sourceInteractionOccurredAt: occurredAtEpoch,/,
    "Edit re-acceptance must attribute the fact to the interaction being edited (this request's own id) and its edited occurred_at",
  );

  const mondayRoute = await read("app/api/import/monday/commit/route.ts");
  assert.match(
    mondayRoute,
    /donorId: donor\.id, userId: profile\.id, sourceInteractionId: id, sourceInteractionOccurredAt: occurredAt,/,
    "Monday confirm_contact must attribute the fact to the deterministic monday- interaction id it is itself creating/updating, and that decision's own occurredAt",
  );
  assert.match(mondayRoute, /const id = mondayInteractionId\(fingerprint\);/, "the id bound as sourceInteractionId in the Monday commit route must be the deterministic per-decision interaction id, never a random or borrowed one");

  // ================================================================
  // 3 (same-request/same-donor supersession race, fixed): Monday's
  // decision loop must thread an in-memory per-donor working state
  // between decisions -- never call the single-shot D1-reading
  // planFactAcceptance() directly, which would re-read D1 per decision
  // and miss an earlier, not-yet-executed decision for the same donor
  // in this same batch.
  // ================================================================
  assert.doesNotMatch(mondayRoute, /planFactAcceptance\(/, "the Monday commit route must never call the single-shot planFactAcceptance() -- it must thread state through planFactAcceptanceStep() instead, so multiple decisions for the same donor in one request compose correctly");
  assert.match(mondayRoute, /const factStateByDonor = new Map/, "the route must maintain a per-donor working-state cache across its decision loop");
  assert.match(mondayRoute, /planFactAcceptanceStep\(donorFactState\.workingState, \{/, "each decision must be planned against the cached working state, not a fresh D1 read");
  assert.match(mondayRoute, /donorFactState\.workingState = nextState;/, "each decision's returned nextState must be written back into the per-donor cache before the next decision for that donor is planned, so supersession/synthesis correctly compose across decisions in one request");

  // ================================================================
  // 2: rejection (the client simply never sending
  // acceptRelationshipSnapshot: true) must create nothing and change
  // no Snapshot -- proven here by confirming every one of the four
  // call sites is unconditionally guarded by that exact flag check,
  // so there is no path to planFactAcceptance without it.
  // ================================================================
  assert.match(captureRoute, /if \(!scheduled && body\.acceptRelationshipSnapshot === true\) \{\s*const plan = await planFactAcceptance\(/, "Capture's call into the shared pipeline must be strictly inside the acceptRelationshipSnapshot === true gate");
  assert.match(outcomeRoute, /if \(\(nextStatus === "completed" \|\| nextStatus === "no-response"\) && body\.acceptRelationshipSnapshot === true\) \{\s*const kind[\s\S]*?const plan = await planFactAcceptance\(/, "Outcome's call into the shared pipeline must be strictly inside its double gate");
  assert.match(editRoute, /if \(body\.acceptRelationshipSnapshot === true && !scheduled\) \{\s*const plan = await planFactAcceptance\(/, "Edit's re-acceptance call must be strictly inside the acceptRelationshipSnapshot === true gate");
  // Monday's own recency-guard precondition (occurredAt >= latestOther)
  // is a pre-existing, already-approved gate this feature preserves
  // unchanged -- confirmed here to still wrap the call.
  assert.match(mondayRoute, /if \(occurredAt >= latestOther\) \{\s*let donorFactState = factStateByDonor\.get\(donor\.id\);/, "Monday confirm_contact's call into the shared pipeline must remain strictly inside its pre-existing recency-guard precondition");

  console.log("relationship-fact-accept-wiring: ok");
}

await run();
