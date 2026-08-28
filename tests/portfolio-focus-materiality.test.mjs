import assert from "node:assert/strict";
import { absoluteMateriality, materiality, recencyDecay } from "../lib/portfolio-focus/materiality.ts";

// Portfolio Focus Phase 1 -- the Round 3 frozen materiality model
// (docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md "Opportunity magnitude
// redesign"). Fixed real-dollar brackets ($500 negligible, $100,000
// maximal), NOT a scale relative to the portfolio's own current largest
// pledge -- this is exactly what Round 2's version got wrong.

const dollars = (d) => d * 100;

async function run() {
  // --- Absolute-dollar sensitivity curve (own-peak case isolates the
  // absolute+portfolio terms from the donor-relative one) -- must be
  // monotonically increasing and roughly match the calibrated table. ---
  {
    const cases = [500, 1000, 2500, 5000, 10000, 18000, 36000, 75000, 100000];
    let previous = -1;
    for (const d of cases) {
      const cents = dollars(d);
      const m = materiality(cents, cents, [cents]);
      assert.ok(m > previous, `materiality must be strictly increasing with dollar amount ($${d} scored ${m}, previous was ${previous})`);
      previous = m;
    }
    // Fixed calibrated endpoints (own-peak, single-item portfolio so
    // percentile=1 for every case -- isolates the absolute curve):
    assert.equal(absoluteMateriality(dollars(500)), 0, "$500 is the floor -- zero absolute materiality");
    assert.equal(absoluteMateriality(dollars(100000)), 1, "$100,000 is the ceiling -- maximal absolute materiality");
    assert.ok(Math.abs(absoluteMateriality(dollars(75000)) - 0.9457) < 0.001, "\$75,000 must match the calibrated ~0.9457 absolute materiality");
    assert.ok(Math.abs(absoluteMateriality(dollars(18000)) - 0.6764) < 0.001, "\$18,000 must match the calibrated ~0.6764 absolute materiality");
    assert.ok(Math.abs(absoluteMateriality(dollars(5000)) - 0.4346) < 0.001, "\$5,000 must match the calibrated ~0.4346 absolute materiality");
    assert.ok(Math.abs(absoluteMateriality(dollars(1000)) - 0.1308) < 0.001, "\$1,000 must match the calibrated ~0.1308 absolute materiality");
  }

  // --- Below the floor and above the ceiling clamp, never go negative or exceed 1 ---
  {
    assert.equal(absoluteMateriality(dollars(100)), 0, "below-floor amounts clamp to 0, never negative");
    assert.equal(absoluteMateriality(dollars(500000)), 1, "above-ceiling amounts clamp to 1, never exceed it");
    assert.equal(absoluteMateriality(0), 0, "zero amount is zero materiality");
    assert.equal(absoluteMateriality(null), 0, "null amount is zero materiality, never a crash");
  }

  // --- Donor-relative sensitivity: the SAME dollar amount must score
  // higher on a smaller-history donor, but the difference must be
  // bounded -- donor-relative significance cannot overwhelm absolute
  // significance (Round 3 Section 3/4's explicit principle). ---
  {
    const smallHistory = materiality(dollars(5000), dollars(7500), [dollars(5000)]);
    const largeHistory = materiality(dollars(5000), dollars(2000000) /* $20,000 peak on a $100k lifetime */, [dollars(5000)]);
    assert.ok(smallHistory > largeHistory, "the identical $5,000 pledge must score higher on the smaller-history donor");
    assert.ok(smallHistory - largeHistory < 0.15, `donor-relative context must be a bounded nudge, not a dominant swing (gap was ${(smallHistory - largeHistory).toFixed(4)})`);
  }
  {
    const smallHistory = materiality(dollars(25000), dollars(25000), [dollars(25000)]);
    const largeHistory = materiality(dollars(25000), dollars(5000000) /* $50,000 peak on a $250k lifetime */, [dollars(25000)]);
    assert.ok(smallHistory > largeHistory, "the identical $25,000 pledge must score higher on the smaller-history donor");
    assert.ok(smallHistory - largeHistory < 0.15, `donor-relative context must remain bounded at the larger dollar amount too (gap was ${(smallHistory - largeHistory).toFixed(4)})`);
    // Both must still read as solidly material regardless of context --
    // a real $25,000 gift is never "trivial" merely because the donor is
    // also capable of larger amounts.
    assert.ok(largeHistory > 0.6, "a $25,000 pledge must remain solidly material even on a large-history donor");
  }

  // --- The Round 1/2 regression this fix exists to prevent: a modest
  // pledge must NOT score nearly as high as a major one merely because
  // it happens to be the donor's own only-ever pledge. ---
  {
    const allEvents = [dollars(1500), dollars(75000)];
    const modestPledgeOwnPeak = materiality(dollars(1500), dollars(1500), allEvents);
    const majorPledgeOwnPeak = materiality(dollars(75000), dollars(75000), allEvents);
    assert.ok(majorPledgeOwnPeak - modestPledgeOwnPeak > 0.3, `a $75,000 pledge must score meaningfully higher than a $1,500 pledge even when both are the donor's own peak (gap was ${(majorPledgeOwnPeak - modestPledgeOwnPeak).toFixed(4)})`);
  }

  // --- Recency decay: continuous, no cliff, 1.0 at day 0, 0 at/after day 365 ---
  {
    assert.equal(recencyDecay(0), 1);
    assert.equal(recencyDecay(365), 0);
    assert.equal(recencyDecay(730), 0, "never negative past the 365-day horizon");
    assert.equal(recencyDecay(null), 0, "unknown recency is treated as zero, never as \"recent\"");
    assert.ok(recencyDecay(180) > recencyDecay(270), "recency decay must be monotonically decreasing");
  }

  console.log("portfolio-focus-materiality: ok");
}

await run();
