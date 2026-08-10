import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countUnresolvedDecisions, countReviewLaterDecisions } from "../lib/import/preview-session.ts";

// Live bug: after a completed 5,625-row donation import (5,171 imported,
// 240 possible-duplicate rows explicitly marked Skip, 214 rejected), the
// Import Center page still showed "Pending reviews: 240 / Rows needing a
// decision". Workspace Health had already been fixed (commits 6dd5923,
// 21188da) to stop treating those same 240 Skip decisions as pending, but
// the Import Center's own card (app/onboarding/import/page.tsx) was a
// completely separate, untouched code path reading
// report.results.rowsRequiringReview / report.donation.needsReview -- the
// exact same retired, undifferentiated historical field, just in a
// different file. Proven here by reproducing the real draft's exact shape:
// a committed session whose decisions_json has 370 reviewDecisions (240
// skip + 130 import_anyway) and, due to the draft-save debounce lagging
// behind the exact decision set submitted at final commit, one leftover
// "needs_decision" entry that was never re-saved after being resolved for
// real at commit time.

async function run() {
  // ---- 1. The exact historical shape: a COMMITTED session with 240 skip
  // decisions (proven, from the forensic audit, to be the entire "Pending
  // reviews: 240" figure) plus one stale leftover "needs_decision" entry
  // that the draft-save debounce never got a chance to overwrite after it
  // was actually resolved before the commit succeeded. ----
  const historicalReviewDecisions = Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`fp-skip-${index}`.padStart(64, "0"), { action: "skip" }]));
  const historicalRejectionDecisions = {
    ...Object.fromEntries(Array.from({ length: 213 }, (_, index) => [`fp-rejected-${index}`.padStart(64, "0"), { action: "match_donor", correctedJlCode: "JL-1" }])),
    // The one stale leftover -- present in the last-saved draft snapshot,
    // but the row itself was actually decided before the commit that
    // succeeded (594 total decisions, 593 resolved at save time).
    [`fp-stale-needs-decision`.padStart(64, "0")]: { action: "needs_decision" },
  };
  const historicalDecisionsJson = JSON.stringify({
    reviewDecisions: historicalReviewDecisions,
    rejectionDecisions: historicalRejectionDecisions,
    dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {},
  });

  // The raw decision content alone (ignoring session status) does contain
  // one "needs_decision" -- proving the bug is specifically about *which*
  // sessions may ever be summed, not that the counting logic is naive.
  assert.equal(countUnresolvedDecisions(historicalDecisionsJson), 1, "the raw decisions_json genuinely contains one needs_decision entry -- the fix must exclude it by session status, not by ignoring real data");

  // ---- 2. The actual page.tsx computation: only status='draft',
  // unexpired sessions are ever summed. A committed session -- regardless
  // of what stale value its last-saved decisions_json happens to carry --
  // must never contribute. ----
  const now = 1_786_400_000;
  const committedSession = { status: "committed", decisions_json: historicalDecisionsJson, expires_at: now + 1_000_000 };
  const sessions = [committedSession];
  const pendingReviews = sessions
    .filter((session) => session.status === "draft" && session.expires_at > now)
    .reduce((sum, session) => sum + countUnresolvedDecisions(session.decisions_json), 0);
  assert.equal(pendingReviews, 0, "Pending Reviews must be 0, not 240 (or 1), for a completed import -- a committed session can never contribute regardless of its last-saved decisions_json");

  // ---- 3. None of the 240 explicit Skip decisions ever counts, by
  // construction: skip is not in the unresolved sentinel set. ----
  const skipOnlyJson = JSON.stringify({ reviewDecisions: historicalReviewDecisions, rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {} });
  assert.equal(countUnresolvedDecisions(skipOnlyJson), 0, "240 explicit Skip decisions must never register as unresolved, in any session");

  // ---- 4. Resolved decisions of every other kind (import_anyway,
  // corrected dates, accepted suspicious dates, match_donor, applied
  // payments/pledges, kept-separate pending gifts) also never count. ----
  const everyResolvedKindJson = JSON.stringify({
    reviewDecisions: { [`fp-1`.padStart(64, "0")]: { action: "import_anyway" } },
    rejectionDecisions: { [`fp-2`.padStart(64, "0")]: { action: "match_donor", correctedJlCode: "JL-2" } },
    dateDecisions: {
      [`fp-3`.padStart(64, "0")]: { action: "correct_date", correctedDate: "2025-01-01" },
      [`fp-4`.padStart(64, "0")]: { action: "accept_as_is" },
    },
    crossImportDecisions: { [`fp-5`.padStart(64, "0")]: { action: "skip" } },
    paymentDecisions: { [`fp-6`.padStart(64, "0")]: { action: "apply_to_pledge", pledgeId: "pledge-1" }, [`fp-7`.padStart(64, "0")]: { action: "new_gift" } },
    pendingGiftDecisions: { [`fp-8`.padStart(64, "0")]: { action: "keep_separate" } },
  });
  assert.equal(countUnresolvedDecisions(everyResolvedKindJson), 0, "every fully-resolved decision kind across all six decision maps must be excluded");

  // ---- 5. Review Later is distinguished: intentionally deferred, not
  // "still needs a decision right now". ----
  const reviewLaterJson = JSON.stringify({
    reviewDecisions: { [`fp-later`.padStart(64, "0")]: { action: "review_later" } },
    rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {},
  });
  assert.equal(countUnresolvedDecisions(reviewLaterJson), 0, "an explicit review_later choice is resolved-but-deferred, never counted as unresolved");
  assert.equal(countReviewLaterDecisions(reviewLaterJson), 1, "the same row must still be visible under Saved for Later, distinguishing it from genuinely unresolved work");

  // ---- 6. Genuinely unresolved decisions -- in an active, unexpired
  // draft -- do count, across every decision type: possible duplicates,
  // rejected/reviewable rows, date review, cross-import duplicates,
  // payment/pledge assignments, and pending-gift matches. ----
  const genuinelyUnresolvedJson = JSON.stringify({
    reviewDecisions: { [`fp-a`.padStart(64, "0")]: { action: "needs_decision" } },
    rejectionDecisions: { [`fp-b`.padStart(64, "0")]: { action: "needs_decision" } },
    dateDecisions: { [`fp-c`.padStart(64, "0")]: { action: "needs_decision" } },
    crossImportDecisions: { [`fp-d`.padStart(64, "0")]: { action: "needs_decision" } },
    paymentDecisions: { [`fp-e`.padStart(64, "0")]: { action: "needs_review" } },
    pendingGiftDecisions: { [`fp-f`.padStart(64, "0")]: { action: "needs_decision" } },
  });
  assert.equal(countUnresolvedDecisions(genuinelyUnresolvedJson), 6, "one genuinely unresolved row in each of the six decision maps must all be counted");
  const activeDraftSession = { status: "draft", decisions_json: genuinelyUnresolvedJson, expires_at: now + 1_000_000 };
  const expiredDraftSession = { status: "draft", decisions_json: genuinelyUnresolvedJson, expires_at: now - 1 };
  const mixedSessions = [committedSession, activeDraftSession, expiredDraftSession];
  const realPendingReviews = mixedSessions
    .filter((session) => session.status === "draft" && session.expires_at > now)
    .reduce((sum, session) => sum + countUnresolvedDecisions(session.decisions_json), 0);
  assert.equal(realPendingReviews, 6, "an active, unexpired draft's genuinely unresolved rows must still surface -- fixing the false positive must never produce a false negative; an expired draft with the identical content must not count");

  // ---- 7. Hard-rejected rows never appear in any decision map at all
  // (they have no decision path, per resolveRejectionDecisions), so they
  // can never be miscounted as unresolved either way. ----
  assert.equal(countUnresolvedDecisions(JSON.stringify({ reviewDecisions: {}, rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {} })), 0);

  // ---- 8. Source wiring: the Import Center page no longer reads
  // report_json for this card at all, and reuses the same canonical query
  // Workspace Health uses rather than a second, independent interpretation. ----
  const pageSource = await readFile(new URL("../app/onboarding/import/page.tsx", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(pageSource, /rowsRequiringReview|\.needsReview/, "the Import Center page must never read the retired historical review-count fields again");
  assert.match(pageSource, /IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL/, "must reuse the same canonical query Workspace Health uses, not a second independent one");
  assert.match(pageSource, /countUnresolvedDecisions/);
  assert.match(pageSource, /status === "draft" && session\.expires_at > now/, "must scope to active, unexpired drafts only, matching Workspace Health's pending-pledge-assignments semantics");

  // The commit route's own report generation was also still writing the
  // same retired, undifferentiated meaning into donation.needsReview and
  // reconciliation.donationRowsRequiringReview even after results.rowsRequiringReview
  // was fixed -- every field describing "still needs review" within one
  // report object must agree.
  assert.doesNotMatch(importRoute, /needsReview: reviewRows\.length/, "donation.needsReview must no longer use the undifferentiated reviewRows count");
  assert.doesNotMatch(importRoute, /donationRowsRequiringReview: reviewRows\.length/, "reconciliation.donationRowsRequiringReview must no longer use the undifferentiated reviewRows count");
  assert.match(importRoute, /needsReview: genuinelyUnresolvedRows\.length/);
  assert.match(importRoute, /donationRowsRequiringReview: genuinelyUnresolvedRows\.length/);

  process.stdout.write("Import Center pending-reviews checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
