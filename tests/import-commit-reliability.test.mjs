import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { isPreviewSessionUsable, reconstructRowsFromChunks, PREVIEW_SESSION_TTL_SECONDS } from "../lib/import/preview-session.ts";
import { resolveAttemptCommitAction, classifyAttemptOutcome, ATTEMPT_STILL_PROCESSING_WINDOW_SECONDS } from "../lib/import/import-attempt.ts";
import { chunkJsonRows } from "../lib/import/d1-json-chunks.ts";

function syntheticRow(index) {
  // Every row is fictional/synthetic -- no real donor data anywhere in this
  // measurement. A mix of matched, unmatched-code, and nonfinancial rows to
  // approximate a realistic large reviewed file.
  const bucket = index % 20;
  const code = bucket === 0 ? `JL-UNMATCHED-${index}` : `JL-${1000 + (index % 300)}`;
  const isNonfinancial = bucket === 1;
  return {
    Code: code, Name: `Fictional Household ${index}`, "Total Due": "100", "Item Num": isNonfinancial ? "DINNER" : "GIFT",
    Desc: isNonfinancial ? "Complimentary reservation" : "Annual support", Campaign: "ANNUAL",
    "Due Date": `2026-0${1 + (index % 9) % 9}-1${index % 9}`, Amount: isNonfinancial ? "0" : "100.00",
    Paid: isNonfinancial ? "0" : "100.00", "Balance Due": "0", Company: "",
  };
}

async function run() {
  const rowCount = 1200;
  const rows = Array.from({ length: rowCount }, (_, index) => syntheticRow(index));

  // ---- Measure: the CPU-bound pipeline for a large reviewed file
  // completes, and completes quickly. ----
  const pipelineStart = Date.now();
  const preview = await buildJlDonationPreview(rows, new Date("2026-08-08"));
  const households = [...new Set(rows.map((row) => row.Code))].filter((code) => !code.startsWith("JL-UNMATCHED")).map((code) => ({ id: `donor-${code}`, external_id: code }));
  const match = matchJlDonationActivities(preview, households, []);
  const pipelineMs = Date.now() - pipelineStart;
  assert.equal(preview.activities.length, rowCount, "every synthetic row classifies into an activity");
  assert.ok(match.unknownActivities.length > 0, "the synthetic file includes intentionally unmatched rows to review");
  assert.ok(match.nonfinancialActivities.length > 0, "the synthetic file includes intentionally nonfinancial rows to review");
  assert.ok(pipelineMs < 5000, `the classification/matching pipeline for ${rowCount} rows must complete well within a Worker request (took ${pipelineMs}ms)`);

  // ---- Final payload is materially smaller than the current full-file
  // POST. Reviewable rows all get a decision, approximating "fully
  // reviewed hundreds of rows". ----
  const reviewDecisions = match.unknownActivities.map((activity) => ({ fingerprint: activity.fingerprint, action: "skip" }));
  const rejectionDecisions = match.nonfinancialActivities.map((activity) => ({ fingerprint: activity.fingerprint, action: "skip" }));
  const commonFields = { fileName: "large-reviewed-import.csv", fileHash: "a".repeat(64), updateExisting: false, mode: "first", reviewMode: "review_every", forceType: "donation", paymentDecisions: [], pendingGiftDecisions: [], crossImportDecisions: [], mergeDecisions: [], existingDonorDecisions: [], fieldDecisions: [], forceReprocess: false };
  const oldStylePayload = JSON.stringify({ ...commonFields, rows, mapping: {}, reviewDecisions, rejectionDecisions });
  const newStylePayload = JSON.stringify({ ...commonFields, previewSessionId: "11111111-1111-1111-1111-111111111111", attemptId: "22222222-2222-2222-2222-222222222222", reviewDecisions, rejectionDecisions });
  const oldBytes = Buffer.byteLength(oldStylePayload);
  const newBytes = Buffer.byteLength(newStylePayload);
  assert.ok(newBytes < oldBytes * 0.1, `the session-based commit payload (${newBytes}B) must be materially smaller than resending the full file (${oldBytes}B)`);
  process.stdout.write(`measured: ${rowCount} rows, ${reviewDecisions.length + rejectionDecisions.length} decisions, pipeline ${pipelineMs}ms, old payload ${oldBytes}B, new payload ${newBytes}B (${((newBytes / oldBytes) * 100).toFixed(1)}%).\n`);

  // ---- Preview state is owner-scoped and expires. ----
  const now = 1_800_000_000;
  const session = { id: "session-1", owner_user_id: "owner-a", file_hash: "a".repeat(64), file_name: "f.csv", mapping_json: "{}", force_type: "donation", row_count: rowCount, created_at: now, expires_at: now + PREVIEW_SESSION_TTL_SECONDS };
  assert.equal(isPreviewSessionUsable(session, "owner-a", now), true);
  assert.equal(isPreviewSessionUsable(session, "owner-b", now), false, "a session must never be usable by a different owner");
  assert.equal(isPreviewSessionUsable(session, "owner-a", session.expires_at), false, "a session must not be usable at or after its expiry");
  assert.equal(isPreviewSessionUsable(session, "owner-a", session.expires_at + 1), false, "a session must not be usable after it expires");
  assert.equal(isPreviewSessionUsable(null, "owner-a", now), false);
  const chunks = chunkJsonRows(rows);
  assert.deepEqual(reconstructRowsFromChunks(chunks), rows, "chunked session rows must reconstruct exactly");

  // ---- Same attempt cannot commit twice; a lost response can be
  // reconciled by attempt id. ----
  assert.equal(resolveAttemptCommitAction(null), "run", "a brand-new attemptId is safe to run");
  assert.equal(resolveAttemptCommitAction({ id: "a", status: "failed", report_json: "{}", created_at: now }), "run", "a cleanly failed attempt wrote nothing and may be re-run under the same id");
  assert.equal(resolveAttemptCommitAction({ id: "a", status: "processing", report_json: "{}", created_at: now }), "reject_in_progress", "an attempt already in flight must never be run a second time concurrently");
  assert.equal(resolveAttemptCommitAction({ id: "a", status: "completed", report_json: "{\"ok\":true}", created_at: now }), "replay", "a completed attempt must be replayed, never re-executed");

  assert.equal(classifyAttemptOutcome(null, now), "not_committed", "no record at all means nothing was written");
  assert.equal(classifyAttemptOutcome({ id: "a", status: "completed", report_json: "{}", created_at: now }, now), "committed");
  assert.equal(classifyAttemptOutcome({ id: "a", status: "failed", report_json: "{}", created_at: now }, now), "not_committed");
  assert.equal(classifyAttemptOutcome({ id: "a", status: "processing", report_json: "{}", created_at: now }, now + 5), "processing", "a very recent processing marker is plausibly still running");
  assert.equal(classifyAttemptOutcome({ id: "a", status: "processing", report_json: "{}", created_at: now }, now + ATTEMPT_STILL_PROCESSING_WINDOW_SECONDS + 1), "unknown", "a processing marker far past the plausible window is unknown, never assumed failed");

  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const statusRoute = await readFile(new URL("../app/api/import/status/route.ts", import.meta.url), "utf8");

  // ---- Session preflight: expired auth must fail before the real commit,
  // without discarding decisions. ----
  assert.match(importExperience, /fetch\("\/api\/profile"\)/, "importData must call a lightweight authenticated endpoint before committing");
  assert.match(importExperience, /Your session expired\. Sign in again before importing\./);
  assert.match(importExperience, /sessionCheck\.status === 401/);

  // ---- Idempotency wiring on the commit route. ----
  assert.match(importRoute, /resolveAttemptCommitAction\(/);
  assert.match(importRoute, /reject_in_progress/);
  assert.match(importRoute, /status = 'processing'/);
  assert.match(importRoute, /status != 'completed'/);
  assert.match(importRoute, /import_preview_sessions/);
  assert.match(importRoute, /isPreviewSessionUsable\(/);

  // ---- Status endpoint reconciles a lost response, owner-scoped. ----
  assert.match(statusRoute, /classifyAttemptOutcome\(/);
  assert.match(statusRoute, /WHERE id = \? AND user_id = \?/);
  assert.match(importExperience, /reconcileLostCommitResponse/);
  assert.match(importExperience, /api\/import\/status\?attemptId=/);

  // ---- Preview persists session state, never mutating financial tables. ----
  assert.match(previewRoute, /saveDonationPreviewSession/);
  assert.match(previewRoute, /previewSessionId/);

  // ---- Never claim a lost-response import failed when the outcome is
  // merely unknown or still processing. ----
  assert.match(importExperience, /outcomeStatus === "processing"/);
  assert.match(importExperience, /outcomeStatus === "unknown"/);
  assert.match(importExperience, /Do not retry blindly/);

  // ---- No donor PII or financial values in the commit-received log line. ----
  const logCallMatch = importRoute.match(/logger\.info\("jl_donation_import_commit_received",\s*\{([\s\S]*?)\}\);/);
  assert.ok(logCallMatch, "expected a jl_donation_import_commit_received log call");
  const logFields = logCallMatch[1];
  assert.doesNotMatch(logFields, /donor|amount|committedCents|externalHouseholdId|sourceValues|Name|Campaign/i);
  assert.match(logFields, /rows: rows\.length/);
  assert.match(logFields, /requestBytes/);

  process.stdout.write("Large reviewed-import commit reliability checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
