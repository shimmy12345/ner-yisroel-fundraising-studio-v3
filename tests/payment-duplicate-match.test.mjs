import assert from "node:assert/strict";
import { findPaymentDuplicateMatch } from "../lib/import/jl-payment-duplicate-match.ts";

// Giving Import Reconciliation -- confidence-aware duplicate detection
// (docs/AI-HANDOFF.md). Pure function, no I/O -- matches this repo's
// established pure-decision-function convention.

const SEP_7_2026 = Math.floor(Date.UTC(2026, 8, 7) / 1000);
const SEP_8_2026 = Math.floor(Date.UTC(2026, 8, 8) / 1000);

function existingGift(overrides = {}) {
  return {
    id: "gift-1",
    donor_id: "donor-schwartz",
    activity_date: SEP_7_2026,
    committed_cents: 967000,
    source_campaign: "CT2026",
    description: "Annual gift",
    source_snapshot: "{}",
    created_at: 1000,
    ...overrides,
  };
}

// ---- A. Exact/strong match: same donor + date + amount + campaign -> "likely" ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift()]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 967000, "CT2026", existingByDonor);
  assert.ok(match, "the Schwartz-shaped payment must surface a duplicate match");
  assert.equal(match.confidence, "likely");
  assert.equal(match.existingActivityId, "gift-1");
  assert.equal(match.existingAmountCents, 967000);
  assert.equal(match.existingCampaign, "CT2026");
}

// ---- Stable ID present on both sides -> "confirmed", regardless of date/amount agreement ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift({ source_snapshot: JSON.stringify({ "Transaction ID": "TXN-555" }) })]]]);
  const match = findPaymentDuplicateMatch("TXN-555", "donor-schwartz", SEP_7_2026, 967000, "CT2026", existingByDonor);
  assert.equal(match.confidence, "confirmed");
  assert.match(match.reason, /TXN-555/);
}
{
  // A confirmed match is proof of identity even if the date happens to be
  // reported differently between the two exports -- the stable ID alone
  // is definitive.
  const existingByDonor = new Map([["donor-schwartz", [existingGift({ activity_date: SEP_8_2026, source_snapshot: JSON.stringify({ "Reference": "REF-9" }) })]]]);
  const match = findPaymentDuplicateMatch("ref-9", "donor-schwartz", SEP_7_2026, 967000, "CT2026", existingByDonor);
  assert.equal(match.confidence, "confirmed", "stable ID matching must be case-insensitive");
}

// ---- B. Same donor/date/amount, different campaign -> surfaced, but "possible" (never silently skipped) ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift({ source_campaign: "ANNUAL" })]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 967000, "CT2026", existingByDonor);
  assert.ok(match, "a campaign mismatch must not hide the evidence entirely");
  assert.equal(match.confidence, "possible", "a campaign mismatch must never reach 'likely' or 'confirmed'");
}
// Missing campaign on either side is treated the same as a mismatch --
// never assumed to match.
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift({ source_campaign: null })]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 967000, "", existingByDonor);
  assert.equal(match.confidence, "possible");
}

// ---- C. Same donor/date/amount twice legitimately: multiple existing candidates -> ambiguous, never "likely" ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift({ id: "gift-1" }), existingGift({ id: "gift-2" })]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 967000, "CT2026", existingByDonor);
  assert.equal(match.confidence, "possible", "two equally-matching existing gifts must never be treated as a single confident match");
}

// ---- D. Same amount, different date -> no match ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift()]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_8_2026, 967000, "CT2026", existingByDonor);
  assert.equal(match, null);
}

// ---- E. Same date, different amount -> no match ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift()]]]);
  const match = findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 500000, "CT2026", existingByDonor);
  assert.equal(match, null);
}

// ---- No existing gifts for this donor at all -> no match, never throws ----
{
  const match = findPaymentDuplicateMatch(null, "donor-unknown", SEP_7_2026, 967000, "CT2026", new Map());
  assert.equal(match, null);
}

// ---- Null/invalid date or amount -> no match (never a false positive from incomplete data) ----
{
  const existingByDonor = new Map([["donor-schwartz", [existingGift()]]]);
  assert.equal(findPaymentDuplicateMatch(null, "donor-schwartz", null, 967000, "CT2026", existingByDonor), null);
  assert.equal(findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, null, "CT2026", existingByDonor), null);
  assert.equal(findPaymentDuplicateMatch(null, "donor-schwartz", SEP_7_2026, 0, "CT2026", existingByDonor), null);
}

process.stdout.write("Payment duplicate-match checks passed.\n");
