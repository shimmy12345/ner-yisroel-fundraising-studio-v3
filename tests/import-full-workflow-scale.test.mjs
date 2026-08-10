import assert from "node:assert/strict";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { resolvePossibleDuplicateDecisions } from "../lib/import/jl-donation-review.ts";
import { buildRejectedRows, resolveRejectionDecisions } from "../lib/import/jl-donation-rejection-review.ts";
import { resolveDateDecisions, findStillUnresolvedDateFingerprints, findInvalidDateDecisions, isDateDecisionComplete, sanitizeDraftDateDecisions } from "../lib/import/jl-donation-date-review.ts";
import { chunkJsonRows } from "../lib/import/d1-json-chunks.ts";
import { reconstructRowsFromChunks, restoreDecisionsForCurrentFingerprints } from "../lib/import/preview-session.ts";
import { resolveAttemptCommitAction, classifyAttemptOutcome } from "../lib/import/import-attempt.ts";

// This is a true end-to-end reproduction of the workflow that failed live on
// a real 6,266-row / 5,625-review-decision import: classify -> preview ->
// (simulated) draft persistence -> thousands of duplicate/rejection/date
// decisions -> a deliberately malformed date correction (the actual proven
// root cause) -> draft sanitize/resume -> preview rebuild -> the same
// structural + semantic validation the commit route runs -> zero unresolved
// decisions. Nothing about fingerprinting, classification, or
// reclassification is mocked -- every function below is the real
// production implementation, exercised at a larger scale (6,400 rows /
// ~5,600 review decisions) than the incident that slipped past unit tests.

const now = new Date("2026-08-10");
const base = { "Total Due": "100", "Item Num": "GIFT", Desc: "Annual support", Campaign: "ANNUAL", Amount: "250.00", Paid: "250.00", "Balance Due": "0", Company: "" };
const KNOWN_CODE_COUNT = 100;
const households = Array.from({ length: KNOWN_CODE_COUNT }, (_, index) => ({ id: `donor-${index}`, external_id: `JL-${1000 + index}` }));

function knownCode(index) { return `JL-${1000 + (index % KNOWN_CODE_COUNT)}`; }

function buildRows() {
  const rows = [];

  // 800 clean, unique rows -- every field varies per row so each gets its
  // own fingerprint (group size 1) and needs no review at all.
  for (let i = 0; i < 800; i += 1) {
    rows.push({ ...base, Code: knownCode(i), Name: `Household ${i}`, "Due Date": `2025-0${1 + (i % 9) % 9}-1${i % 9}`, Amount: `${100 + i}.00`, Paid: `${100 + i}.00` });
  }

  // 2,600 duplicate pairs (5,200 rows) -- identical content, no stable
  // transaction id, so both members land in one content-group and both get
  // an occurrence-indexed fingerprint. Every one of these rows needs a
  // reviewDecision.
  for (let i = 0; i < 2600; i += 1) {
    const pairRow = { ...base, Code: knownCode(i), Name: `Duplicate Household ${i}`, "Due Date": "2025-03-15", Amount: "500.00", Paid: "500.00", Campaign: `DUP-${i}` };
    rows.push({ ...pairRow });
    rows.push({ ...pairRow });
  }

  // 100 unmatched JL codes.
  for (let i = 0; i < 100; i += 1) {
    rows.push({ ...base, Code: `JL-UNKNOWN-${i}`, Name: `Unmatched ${i}`, "Due Date": "2025-04-01", Amount: "75.00", Paid: "75.00" });
  }

  // 100 nonfinancial rows.
  for (let i = 0; i < 100; i += 1) {
    rows.push({ ...base, Code: knownCode(i), Name: `Nonfinancial ${i}`, "Item Num": "DINNER", Desc: "Complimentary reservation", "Due Date": "2025-05-01", Amount: "0", Paid: "0", "Balance Due": "0" });
  }

  // 100 invalid-date rows.
  for (let i = 0; i < 100; i += 1) {
    rows.push({ ...base, Code: knownCode(i), Name: `Invalid Date ${i}`, "Due Date": "not-a-date", Amount: "60.00", Paid: "60.00" });
  }

  // 100 suspicious-date rows (before 1980).
  for (let i = 0; i < 100; i += 1) {
    rows.push({ ...base, Code: knownCode(i), Name: `Suspicious Date ${i}`, "Due Date": "1899-01-01", Amount: "40.00", Paid: "40.00" });
  }

  return rows;
}

async function run() {
  const rows = buildRows();
  assert.ok(rows.length >= 6000, `fixture must have at least 6000 rows (has ${rows.length})`);

  // ---- Step 1: classification, timed. ----
  const classifyStart = Date.now();
  const initialPreview = await buildJlDonationPreview(rows, now);
  const classifyMs = Date.now() - classifyStart;
  assert.equal(initialPreview.activities.length, rows.length);

  const match = matchJlDonationActivities(initialPreview, households, []);
  const dateIssueActivities = initialPreview.activities.filter((a) => a.dateIssue !== null);
  const duplicateActivities = initialPreview.activities.filter((a) => a.duplicateStatus === "possible_duplicate");
  assert.equal(dateIssueActivities.length, 200, "100 invalid + 100 suspicious date rows");
  assert.equal(duplicateActivities.length, 5200, "every member of the 2,600 duplicate pairs must be flagged for review");
  assert.equal(match.unknownActivities.length, 100);
  assert.equal(match.nonfinancialActivities.length, 100);

  // ---- Step 2: build the full decision set a reviewer would make.
  // Half of each duplicate pair is approved, half skipped -- a realistic
  // mixed outcome, not a rubber stamp. ----
  const reviewDecisionsArray = duplicateActivities.map((activity, index) => ({ fingerprint: activity.fingerprint, action: index % 2 === 0 ? "import_anyway" : "skip", groupKey: activity.duplicateGroupKey }));
  assert.ok(reviewDecisionsArray.length >= 5000 || reviewDecisionsArray.length + dateIssueActivities.length + match.unknownActivities.length + match.nonfinancialActivities.length >= 5000);
  const totalDecisionCount = reviewDecisionsArray.length + dateIssueActivities.length + match.unknownActivities.length + match.nonfinancialActivities.length;
  assert.ok(totalDecisionCount >= 5000, `expected at least 5000 review decisions, got ${totalDecisionCount}`);

  const rejectionDecisionsArray = [
    ...match.unknownActivities.map((activity, index) => ({ fingerprint: activity.fingerprint, action: "match_donor", correctedJlCode: knownCode(index) })),
    ...match.nonfinancialActivities.map((activity) => ({ fingerprint: activity.fingerprint, action: "import_anyway" })),
  ];

  // 199 of the 200 date-issue rows get a valid decision; the 200th
  // reproduces the exact live failure: a "correct_date" decision whose
  // correctedDate is a malformed value a native <input type="date"> can
  // actually emit mid-edit (a 5-digit year), proven from the real stuck
  // production draft during this incident's investigation.
  const [malformedActivity, ...restDateActivities] = dateIssueActivities;
  const dateDecisionsArrayWithBug = [
    { fingerprint: malformedActivity.fingerprint, action: "correct_date", correctedDate: "20219-11-14" },
    ...restDateActivities.map((activity, index) => (
      activity.dateIssue === "invalid"
        ? { fingerprint: activity.fingerprint, action: "correct_date", correctedDate: `2024-0${1 + (index % 9) % 9}-1${(index % 9) + 1}` }
        : { fingerprint: activity.fingerprint, action: index % 2 === 0 ? "accept_as_is" : "correct_date", correctedDate: index % 2 === 0 ? undefined : `2023-0${1 + (index % 9) % 9}-1${(index % 9) + 1}` }
    )),
  ];

  // ---- Step 3: reproduce the exact observed failure. The structural gate
  // the commit route runs must reject this exact batch with the exact
  // malformed fingerprint identified, not a blanket, unattributed 422. ----
  const invalidBeforeFix = findInvalidDateDecisions(dateDecisionsArrayWithBug);
  assert.equal(invalidBeforeFix.length, 1, "exactly the one malformed entry must be flagged, not the whole batch opaquely");
  assert.equal(invalidBeforeFix[0].fingerprint, malformedActivity.fingerprint);
  assert.match(invalidBeforeFix[0].reason, /not a valid calendar date/);

  // The client-side pre-commit gate (isDateDecisionComplete, used by
  // unresolvedDateRows) must also catch it -- this is the actual bug that
  // shipped: a truthy-only check let this exact value through as
  // "resolved". A non-empty but malformed string must never look complete.
  assert.equal(isDateDecisionComplete({ action: "correct_date", correctedDate: "20219-11-14" }), false);
  assert.equal(isDateDecisionComplete({ action: "correct_date", correctedDate: "2024-01-15" }), true);
  assert.equal(isDateDecisionComplete({ action: "correct_date", correctedDate: undefined }), false);
  assert.equal(isDateDecisionComplete({ action: "correct_date", correctedDate: "" }), false);

  // The draft-save sanitizer must never durably persist the malformed value
  // as if the row were resolved -- it keeps the chosen action but drops the
  // bad date, matching the incomplete state.
  const draftShapeWithBug = { [malformedActivity.fingerprint]: { action: "correct_date", correctedDate: "20219-11-14" } };
  const sanitized = sanitizeDraftDateDecisions(draftShapeWithBug);
  assert.deepEqual(sanitized[malformedActivity.fingerprint], { action: "correct_date" }, "the malformed corrected date must be dropped, not silently persisted");

  // ---- Step 4: fix the one bad row (exactly what recovering the real
  // draft required -- nothing else needs to be redone) and confirm the full
  // pipeline now clears end to end. ----
  const dateDecisionsArrayFixed = dateDecisionsArrayWithBug.map((decision) => decision.fingerprint === malformedActivity.fingerprint ? { fingerprint: decision.fingerprint, action: "correct_date", correctedDate: "2021-11-14" } : decision);
  assert.deepEqual(findInvalidDateDecisions(dateDecisionsArrayFixed), [], "after fixing the one malformed entry, structural validation must pass cleanly");

  const dateResolution = resolveDateDecisions(rows, initialPreview.activities, dateDecisionsArrayFixed);
  assert.equal(dateResolution.unresolvedFingerprints.length, 0, "every date-issue row has a valid decision after the fix");
  const expectedEdits = dateDecisionsArrayFixed.filter((d) => d.action === "correct_date").length;
  assert.equal(dateResolution.edits.length, expectedEdits, "every correct_date decision must produce exactly one audit edit");

  // ---- Step 5: rebuild the preview from the corrected rows, exactly as
  // the commit route does, and prove no unrelated decision -- specifically
  // the 5,200 duplicate-pair reviewDecisions untouched by any date
  // correction -- silently breaks as a side effect (the "occurrence-index
  // reshuffle" risk this task calls out explicitly). ----
  const rebuildStart = Date.now();
  const rebuiltPreview = await buildJlDonationPreview(dateResolution.rows, now);
  const rebuildMs = Date.now() - rebuildStart;
  const stillUnresolvedDates = findStillUnresolvedDateFingerprints(dateResolution.appliedRowNumbers, rebuiltPreview.activities);
  assert.equal(stillUnresolvedDates.length, 0, "every corrected date must re-classify clean, not merely format-valid");

  const reviewResolution = resolvePossibleDuplicateDecisions(rebuiltPreview.activities, reviewDecisionsArray);
  assert.equal(reviewResolution.unresolvedFingerprints.length, 0, "correcting 200 date rows must never orphan any of the 5,200 unrelated duplicate-pair decisions");
  const expectedApproved = reviewDecisionsArray.filter((d) => d.action === "import_anyway").length;
  assert.equal(reviewResolution.approvedActivities.length, expectedApproved, "exactly the rows marked import_anyway are approved -- skip writes nothing");

  const rebuiltMatch = matchJlDonationActivities(rebuiltPreview, households, []);
  const rejectionResolution = resolveRejectionDecisions(rebuiltMatch.unknownActivities, rebuiltMatch.nonfinancialActivities, rejectionDecisionsArray, new Map(households.map((h) => [h.external_id.toLowerCase(), h.id])));
  assert.equal(rejectionResolution.unresolvedFingerprints.length, 0);
  assert.equal(rejectionResolution.approvedActivities.length, match.unknownActivities.length + match.nonfinancialActivities.length, "every unmatched/nonfinancial row was given a resolvable decision");

  // ---- Step 6: no row silently vanishes anywhere in the pipeline. ----
  const cleanRows = 800;
  const accountedFor = cleanRows + reviewResolution.approvedActivities.length + (reviewDecisionsArray.length - expectedApproved) /* skipped, intentionally excluded */ + rejectionResolution.approvedActivities.length + dateIssueActivities.length;
  assert.equal(accountedFor, rows.length, "every row must be accounted for as clean, approved, intentionally skipped, or resolved -- never unexplained");

  // ---- Step 7: draft persistence at scale round-trips exactly, and is
  // materially smaller than resending the full file. ----
  const chunkStart = Date.now();
  const chunks = chunkJsonRows(rows);
  const chunkMs = Date.now() - chunkStart;
  const reconstructed = reconstructRowsFromChunks(chunks);
  assert.deepEqual(reconstructed, rows, "chunked rows must reconstruct exactly at this scale");
  const draftBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  const fullFilePayloadBytes = Buffer.byteLength(JSON.stringify(rows));
  assert.ok(draftBytes <= fullFilePayloadBytes * 1.05, "chunked storage must not meaningfully inflate the raw row payload");

  // ---- Step 8: resume simulation. The saved fingerprint-keyed decision
  // maps survive a JSON round-trip (server draft save/reload) and, since
  // resume always rebuilds from the untouched original rows, every
  // fingerprint the client saved decisions against is still present --
  // reclassification only ever happens inside the commit route's own
  // two-pass rebuild, never persisted back into the draft. ----
  const savedReviewDecisions = Object.fromEntries(reviewDecisionsArray.map((d) => [d.fingerprint, { action: d.action }]));
  const savedRejectionDecisions = Object.fromEntries(rejectionDecisionsArray.map((d) => [d.fingerprint, { action: d.action, correctedJlCode: d.correctedJlCode }]));
  const savedDateDecisions = Object.fromEntries(dateDecisionsArrayFixed.map((d) => [d.fingerprint, { action: d.action, correctedDate: d.correctedDate }]));
  const roundTripped = JSON.parse(JSON.stringify({ reviewDecisions: savedReviewDecisions, rejectionDecisions: savedRejectionDecisions, dateDecisions: savedDateDecisions }));
  const currentFingerprints = new Set(initialPreview.activities.map((a) => a.fingerprint));
  const restoredReview = restoreDecisionsForCurrentFingerprints(roundTripped.reviewDecisions, currentFingerprints);
  const restoredRejection = restoreDecisionsForCurrentFingerprints(roundTripped.rejectionDecisions, currentFingerprints);
  const restoredDate = restoreDecisionsForCurrentFingerprints(roundTripped.dateDecisions, currentFingerprints);
  assert.equal(Object.keys(restoredReview).length, reviewDecisionsArray.length, "resuming an unmodified file must lose zero duplicate-review decisions, even at 5,200 of them");
  assert.equal(Object.keys(restoredRejection).length, rejectionDecisionsArray.length);
  assert.equal(Object.keys(restoredDate).length, dateDecisionsArrayFixed.length);

  // ---- Step 9: idempotency machinery (unchanged, but re-proven here in
  // the context of this exact scale/shape of attempt). ----
  assert.equal(resolveAttemptCommitAction(null), "run");
  assert.equal(resolveAttemptCommitAction({ id: "attempt-1", status: "completed", report_json: "{}", created_at: 0 }), "replay", "resubmitting the same attemptId after a completed commit must replay, never re-run, so a second submission creates no duplicates");
  assert.equal(classifyAttemptOutcome({ id: "attempt-1", status: "completed", report_json: "{}", created_at: 0 }, 0), "committed");

  const totalMs = classifyMs + rebuildMs;
  process.stdout.write(`full-workflow scale check: ${rows.length} rows, ${totalDecisionCount} review decisions (${reviewDecisionsArray.length} duplicate, ${rejectionDecisionsArray.length} rejection, ${dateDecisionsArrayFixed.length} date), classify ${classifyMs}ms, rebuild ${rebuildMs}ms (total ${totalMs}ms), chunk ${chunkMs}ms, draft bytes ${draftBytes}, full-file bytes ${fullFilePayloadBytes}, unresolved-before-commit: dates=${stillUnresolvedDates.length} review=${reviewResolution.unresolvedFingerprints.length} rejection=${rejectionResolution.unresolvedFingerprints.length}.\n`);
  assert.ok(totalMs < 15000, `classification + rebuild for ${rows.length} rows must comfortably fit in a single Worker request (took ${totalMs}ms)`);

  process.stdout.write("Full donation-import workflow scale/regression checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
