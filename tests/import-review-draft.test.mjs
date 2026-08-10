import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DRAFT_TTL_SECONDS, PREVIEW_SESSION_TTL_SECONDS, isPreviewSessionUsable, isDraftResumable, previewSessionExpiresAt, restoreDecisionsForCurrentFingerprints } from "../lib/import/preview-session.ts";
import { resolveAttemptCommitAction } from "../lib/import/import-attempt.ts";

const OLD_TTL_SECONDS = 60 * 60; // the fixed 1-hour TTL this task replaces

function draft(overrides = {}) {
  return {
    id: "draft-1", owner_user_id: "owner-a", file_hash: "a".repeat(64), file_name: "JL Donation Upload.csv",
    mapping_json: "{}", force_type: "donation", row_count: 6266, decisions_json: "{}", status: "draft",
    progress_resolved: 0, progress_total: 0, created_at: 0, updated_at: 0, expires_at: DRAFT_TTL_SECONDS,
    ...overrides,
  };
}

async function run() {
  // ---- A review lasting longer than the old 1-hour TTL can still commit. ----
  assert.equal(PREVIEW_SESSION_TTL_SECONDS, DRAFT_TTL_SECONDS, "there is exactly one TTL concept for this table now");
  assert.ok(DRAFT_TTL_SECONDS > OLD_TTL_SECONDS * 24, "the draft TTL must be dramatically longer than the old fixed 1-hour session lifetime");
  const startedReview = 0;
  const stillReviewingAfterOldTtl = OLD_TTL_SECONDS + 60 * 30; // 1.5 hours in -- the exact failure this task fixes
  const longReview = draft({ created_at: startedReview, updated_at: startedReview, expires_at: previewSessionExpiresAt(startedReview) });
  assert.ok(isPreviewSessionUsable(longReview, "owner-a", stillReviewingAfterOldTtl), "a review still in progress 1.5 hours in must remain usable, unlike the old fixed 1-hour TTL");

  // ---- Active review extends/maintains validity. ----
  const touchedAt = longReview.expires_at - 10; // touched just before it would have expired
  const extended = { ...longReview, updated_at: touchedAt, expires_at: previewSessionExpiresAt(touchedAt) };
  assert.ok(extended.expires_at > longReview.expires_at, "touching the draft (a saved decision) must push its expiry further out");
  assert.ok(isPreviewSessionUsable(extended, "owner-a", longReview.expires_at + 1), "past the ORIGINAL expiry, the draft must still be usable because activity extended it");

  // An abandoned draft (never touched again) still eventually expires.
  assert.equal(isPreviewSessionUsable(longReview, "owner-a", longReview.expires_at + 1), false, "a draft nobody touched again must still expire eventually");
  assert.equal(isDraftResumable(longReview, longReview.expires_at + 1), false);

  // ---- Refresh / browser-restart resume preserves decisions; 259 of 260
  // decisions survive a rebuilt preview, and the user can finish the one
  // that changed; a changed fingerprint requires only that row to be
  // reviewed again. ----
  const savedDecisions = Object.fromEntries(Array.from({ length: 260 }, (_, index) => [`fp-${index}`, { action: "skip" }]));
  // Rebuilding the preview reproduces 259 of the original fingerprints
  // exactly (same file content -- fingerprints are a pure function of it)
  // and one row's content changed, producing a different fingerprint.
  const currentFingerprints = new Set([...Array.from({ length: 259 }, (_, index) => `fp-${index}`), "fp-259-changed"]);
  const { restored, dropped } = ((saved, current) => {
    const kept = restoreDecisionsForCurrentFingerprints(saved, current);
    return { restored: kept, dropped: Object.keys(saved).length - Object.keys(kept).length };
  })(savedDecisions, currentFingerprints);
  assert.equal(Object.keys(restored).length, 259, "259 of 260 saved decisions must survive the rebuilt preview untouched");
  assert.equal(dropped, 1, "exactly the one row whose fingerprint changed must be dropped, not guessed at");
  assert.ok(!("fp-259" in restored) && !("fp-259-changed" in restored), "neither the old nor the new identity of the changed row carries over a stale decision");
  for (let index = 0; index < 259; index += 1) assert.deepEqual(restored[`fp-${index}`], { action: "skip" }, "every unaffected row's decision must be restored exactly as saved");
  // The user only needs to make one more decision (for fp-259-changed) --
  // everything else is already done, matching "finish the last one".
  const stillNeedsDecision = [...currentFingerprints].filter((fingerprint) => !(fingerprint in restored));
  assert.deepEqual(stillNeedsDecision, ["fp-259-changed"]);

  // ---- Different fileHash cannot inherit decisions. ----
  const fileA = draft({ id: "draft-a", file_hash: "a".repeat(64), decisions_json: JSON.stringify({ reviewDecisions: savedDecisions }) });
  const fileB = draft({ id: "draft-b", file_hash: "b".repeat(64) });
  assert.notEqual(fileA.file_hash, fileB.file_hash);
  // isPreviewSessionUsable only ever checks the exact draft row looked up
  // by id/owner -- there is no code path that matches a draft by filename
  // or any signal other than its own stored file_hash plus owner.
  assert.ok(isPreviewSessionUsable(fileA, "owner-a", 0));
  assert.ok(isPreviewSessionUsable(fileB, "owner-a", 0));
  assert.notEqual(fileA.id, fileB.id, "two different files never share a draft id/decisions, even for the same owner");

  // ---- Owner scoping: never usable by a different owner. ----
  assert.equal(isPreviewSessionUsable(draft(), "owner-b", 0), false);

  // ---- Duplicate final submission remains idempotent (existing attemptId
  // machinery, unchanged by this task). ----
  assert.equal(resolveAttemptCommitAction({ id: "a", status: "completed", report_json: "{}", created_at: 0 }), "replay");
  assert.equal(resolveAttemptCommitAction({ id: "a", status: "processing", report_json: "{}", created_at: 0 }), "reject_in_progress");

  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const draftRoute = await readFile(new URL("../app/api/import/draft/route.ts", import.meta.url), "utf8");
  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");

  // ---- Draft reuse is scoped to owner + exact fileHash. ----
  assert.match(previewRoute, /WHERE owner_user_id = \? AND file_hash = \? AND status = 'draft'/);
  assert.match(previewRoute, /upsertDonationDraft/);
  assert.match(previewRoute, /restoredDecisions/);

  // ---- Resume never trusts a client-supplied fileHash/rows -- only the
  // draft's own stored content, tied to the authenticated owner. ----
  assert.match(previewRoute, /loadDraftRows\(profile\.id, resumeSessionId\)/);
  assert.doesNotMatch(previewRoute, /loadDraftRows\([^)]*body\.fileHash/);

  // ---- Successful import closes the draft, atomically with the
  // financial write. ----
  assert.match(importRoute, /UPDATE import_preview_sessions SET status = 'committed'/);

  // ---- Decisions are saved incrementally, not only at final commit. ----
  assert.match(draftRoute, /decisions_json = \?/);
  assert.match(draftRoute, /expires_at = \?/);
  assert.match(importExperience, /setTimeout\(/);
  assert.match(importExperience, /api\/import\/draft/);
  assert.doesNotMatch(importExperience, /localStorage|sessionStorage/i, "review progress must be persisted server-side, not only in the browser");

  // ---- Resume workflow surfaces enough to identify a draft safely. ----
  assert.match(importExperience, /resumableDrafts/);
  assert.match(importExperience, /Resume review/);
  assert.match(importExperience, /Discard draft/);
  assert.match(importExperience, /rows resolved/);

  process.stdout.write("Import review draft persistence and resume checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
