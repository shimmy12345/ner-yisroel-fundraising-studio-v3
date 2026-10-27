import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregatePortfolioFocusInputs } from "../lib/portfolio-focus/aggregate.ts";

// Production Homepage Sections Missing investigation (2026-10-27, see
// docs/AI-HANDOFF.md): "Fundraising Intelligence" ("Right Now") and
// "Portfolio Focus" ("This Month") both silently disappeared from the
// Production homepage. Root cause: lib/portfolio-focus/data.ts's own
// giving_activities SQL exclusion list predates the 'pending_pledge'
// category (added 2026-10-16, Trip Fundraising Results Dashboard --
// lib/giving/management.ts's COUNTED_GIVING_SQL) and was never updated
// to match it. aggregatePortfolioFocusInputs's own KNOWN_GIVING_
// CATEGORIES allowlist deliberately throws on any category it doesn't
// recognize (fail-closed, by design) -- so a real 'pending_pledge' row
// (reproduced against real Production data during this investigation:
// exactly 2 such rows, from real recorded trip pledges) crashed the
// ENTIRE shared Portfolio Focus + Fundraising Intelligence computation
// for that user. app/page.tsx's Today-page caller swallows that
// exception and degrades BOTH homepage sections to empty -- explaining
// why they vanished together, and why Staging (which had zero
// 'pending_pledge' rows at the time) never showed the bug.
//
// data.ts itself imports "cloudflare:workers" and so cannot be
// unit-tested directly outside a Workers runtime -- matching this
// codebase's established pure/impure split (see e.g.
// tests/agenda-safety.test.mjs's own comment on the same constraint).
// This file instead: (1) source-inspects data.ts's SQL text for the
// actual shipped fix, and (2) exercises aggregatePortfolioFocusInputs
// itself -- a pure function, no D1 -- to prove both that the fail-closed
// guard it relies on is still intact (so a FUTURE unrecognized category
// still fails loudly, not silently) and that a normal, fully-excluded
// giving set still aggregates correctly.

const dataSource = await readFile(new URL("../lib/portfolio-focus/data.ts", import.meta.url), "utf8");

function emptyRaw(overrides) {
  return {
    donors: [], giving: [], asks: [], interactions: [], reminders: [],
    yahrtzeits: [], importantDates: [], pledgePayments: [], paymentPlans: [],
    relationshipFacts: [], acknowledgments: [], historicalContext: [],
    ...overrides,
  };
}

function run() {
  // --- The actual shipped fix: data.ts's giving_activities query must
  // exclude 'pending_pledge' from the raw pull, alongside the three
  // categories it already excluded. ---
  assert.match(
    dataSource,
    /category NOT IN \('needs_review','nonfinancial_entry','pending_gift','pending_pledge'\)/,
    "the giving_activities raw-pull query must exclude 'pending_pledge', matching lib/giving/management.ts's canonical COUNTED_GIVING_SQL exclusion list",
  );

  const now = Math.floor(Date.now() / 1000);

  // --- Regression proof: a 'pending_pledge' row, if it ever reached
  // aggregatePortfolioFocusInputs again (e.g. the SQL exclusion above
  // were ever reverted), must still crash loudly -- the fail-closed
  // KNOWN_GIVING_CATEGORIES guard this bug exposed must remain intact,
  // not be loosened as part of this fix. ---
  {
    const raw = emptyRaw({
      donors: [{ id: "donor-1", display_name: "Test Donor", donor_code: null, relationship_summary: null, institutional_memory: null }],
      giving: [{ id: "ga-1", donor_id: "donor-1", paid_cents: 0, balance_cents: 500000, activity_date: now, category: "pending_pledge", item_type: null, description: null }],
    });
    assert.throws(
      () => aggregatePortfolioFocusInputs(raw, now, "America/New_York"),
      /unexpected giving_activities category "pending_pledge"/,
      "a 'pending_pledge' row must still crash aggregatePortfolioFocusInputs directly -- this fix relies on data.ts excluding it at the SQL layer, never on loosening this allowlist",
    );
  }

  // --- The fix in effect: with 'pending_pledge' excluded from the pull
  // (as data.ts now does), the SAME donor aggregates normally -- proving
  // the fix actually restores the computation rather than merely
  // changing the error message. ---
  {
    const raw = emptyRaw({
      donors: [{ id: "donor-1", display_name: "Test Donor", donor_code: null, relationship_summary: null, institutional_memory: null }],
      giving: [{ id: "ga-2", donor_id: "donor-1", paid_cents: 500000, balance_cents: 0, activity_date: now, category: "completed_gift", item_type: null, description: null }],
    });
    const result = aggregatePortfolioFocusInputs(raw, now, "America/New_York");
    assert.equal(result.donorInputs.length, 1, "with pending_pledge excluded, the donor's remaining (recognized-category) giving aggregates without throwing");
    assert.equal(result.donorInputs[0].donorId, "donor-1");
  }

  console.log("portfolio-focus-pending-pledge-exclusion: all assertions passed");
}

run();
