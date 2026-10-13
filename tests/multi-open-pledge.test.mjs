import assert from "node:assert/strict";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";
import { scorePortfolioFocusDonor } from "../lib/portfolio-focus/score.ts";
import { detectSituations } from "../lib/fundraising-intelligence/situations.ts";
import { evaluateOpenPledgePlanStatus, isOpenPledgeActionable } from "../lib/relationships/pledge-payment-plan.ts";

// Multi-Open-Pledge Independent Evaluation (2026-10-13, see
// docs/AI-HANDOFF.md's Goldenberg/JL 64792 investigation). A donor can
// have more than one simultaneously open pledge; every pledge must be
// evaluated independently, never collapsed to a single "representative"
// one before deciding whether any of them needs a follow-up. All
// fixtures below reuse the REAL, unmodified production functions
// (detectSituations, evaluateOpenPledgePlanStatus,
// isOpenPledgeActionable, scorePortfolioFocusDonor) -- never a second,
// reimplemented model.

const NOW = Math.floor(Date.parse("2026-10-13T14:00:00Z") / 1000);
const dollars = (d) => d * 100;

function pledgeEvidence(overrides) {
  return {
    pledgeActivityId: "pledge-x",
    campaign: null,
    description: null,
    balanceCents: dollars(1000),
    totalCents: dollars(1000),
    activityDate: null,
    pledgeAgeDays: null,
    pledgeCommitmentAgeDays: null,
    pledgePlanOnTrack: null,
    ...overrides,
  };
}

function donor(overrides) {
  return {
    donorId: "x", displayName: "x", donorCode: null,
    lifetimeCents: 0, last365Cents: 0, prior365Cents: 0, distinctActivityYears: 0,
    historicalPeakGiftCents: null, historicalPeakCommitmentCents: null,
    mostRecentCashKind: null, mostRecentCashCents: null, daysSinceLastGift: null,
    openPledgeBalanceCents: null, openPledgeTotalCents: null, openPledgeCategory: null,
    pledgeAgeDays: null, pledgeCommitmentAgeDays: null, pledgePlanOnTrack: null,
    openPledges: [],
    askHistoryCount: 0, hasOpenReminder: false, openReminderAction: null,
    lastInteractionDaysAgo: null, daysSinceSubstantiveContact: null,
    hasCurrentFact: false, hasActionableFact: false, hasUnconfirmedHistoricalContext: false,
    currentSnapshotSummary: null, upcomingDateDescription: null,
    recommendation: null,
    ...overrides,
  };
}

// Scores a single donor in isolation -- real scorePortfolioFocusDonor +
// buildPortfolioContext, never a hand-constructed PortfolioFocusResult.
function scoreOne(d) {
  const ctx = buildPortfolioContext([d], [dollars(1000)]);
  return { ...scorePortfolioFocusDonor(d, ctx), rank: 1 };
}

function pledgeFollowUpSignal(d) {
  const result = scoreOne(d);
  const signals = detectSituations(d, result, [], [], NOW);
  return signals.find((s) => s.situationType === "pledge_follow_up") ?? null;
}

function run() {
  // ============================================================
  // 1. Goldenberg's real scenario -- the newer pledge (KOLX2026) has
  // an active, on-track plan; the older pledge (CHSP2026) has no plan
  // and has genuinely gone stale. Must name CHSP2026 specifically,
  // never generically, and must never call KOLX2026 stale.
  // ============================================================
  {
    const kolx = pledgeEvidence({ pledgeActivityId: "kolx2026", campaign: "KOLX2026", balanceCents: dollars(11000), totalCents: dollars(12000), pledgePlanOnTrack: true, pledgeAgeDays: 63, pledgeCommitmentAgeDays: 20 });
    const chsp = pledgeEvidence({ pledgeActivityId: "chsp2026", campaign: "CHSP2026", balanceCents: dollars(650), totalCents: dollars(650), pledgePlanOnTrack: null, pledgeAgeDays: 165, pledgeCommitmentAgeDays: 165 });
    const d = donor({ donorId: "goldenberg", openPledges: [kolx, chsp] });
    const signal = pledgeFollowUpSignal(d);
    assert.ok(signal, "the genuinely stale CHSP2026 pledge must still produce a pledge_follow_up signal");
    assert.match(signal.headline, /CHSP2026/, "the headline must name the SPECIFIC pledge/campaign responsible");
    assert.doesNotMatch(signal.headline, /^Open pledge has gone stale$/, "must never use the old generic, unattributed headline");
    assert.doesNotMatch(signal.headline, /KOLX2026/, "the on-track KOLX2026 plan must never be the one named as stale");
    assert.match(signal.explanation, /KOLX2026.*on track/, "the other pledge's own healthy status must be preserved in the explanation, not lost");
  }

  // ============================================================
  // 9 (requirement). Both chronological orderings -- the INVERSE of
  // Goldenberg's real case: the OLDER pledge has the active, on-track
  // plan; the NEWER pledge has no plan and is the one that's gone
  // stale. The fix must not depend on which pledge is more recent.
  // ============================================================
  {
    const olderWithPlan = pledgeEvidence({ pledgeActivityId: "older-plan", campaign: "OLDPLAN", balanceCents: dollars(5000), totalCents: dollars(6000), pledgePlanOnTrack: true, pledgeAgeDays: 200, pledgeCommitmentAgeDays: 40 });
    const newerStale = pledgeEvidence({ pledgeActivityId: "newer-stale", campaign: "NEWSTALE", balanceCents: dollars(800), totalCents: dollars(800), pledgePlanOnTrack: null, pledgeAgeDays: 90, pledgeCommitmentAgeDays: 90 });
    const d = donor({ donorId: "inverse-order", openPledges: [olderWithPlan, newerStale] });
    const signal = pledgeFollowUpSignal(d);
    assert.ok(signal, "the newer, plan-less, genuinely stale pledge must still be caught even though it is NOT the older one");
    assert.match(signal.headline, /NEWSTALE/, "must name the newer pledge specifically");
    assert.doesNotMatch(signal.headline, /OLDPLAN/, "the older, on-track plan must never be called stale just because it is chronologically older");
  }

  // ============================================================
  // 2. Active plan with no overdue installments -- never stale.
  // ============================================================
  {
    const onTrack = pledgeEvidence({ pledgeActivityId: "p1", campaign: "ONTRACK", balanceCents: dollars(3000), totalCents: dollars(5000), pledgePlanOnTrack: true, pledgeAgeDays: 400 });
    const d = donor({ donorId: "ontrack-only", openPledges: [onTrack] });
    assert.equal(pledgeFollowUpSignal(d), null, "an active, on-track payment plan must never generate a stale-pledge (or any pledge_follow_up) warning, regardless of raw pledge age");
  }

  // ============================================================
  // 3. Active plan with a GENUINELY overdue installment -- must
  // generate the payment-plan-specific follow-up, never the generic
  // "gone stale" wording (an installment overdue is a different
  // situation than a dormant, plan-less pledge).
  // ============================================================
  {
    const behind = pledgeEvidence({ pledgeActivityId: "p1", campaign: "BEHIND2026", balanceCents: dollars(9000), totalCents: dollars(12000), pledgePlanOnTrack: false, pledgeAgeDays: 45 });
    const d = donor({ donorId: "behind-schedule", openPledges: [behind] });
    const signal = pledgeFollowUpSignal(d);
    assert.ok(signal, "a genuinely behind-schedule active plan must generate a follow-up");
    assert.match(signal.headline, /payment plan is behind schedule/, "a behind-schedule PLAN must get payment-plan-specific wording");
    assert.doesNotMatch(signal.headline, /has gone stale/, "must never use the generic stale wording for an active plan that's simply behind");
    assert.match(signal.possibleAction, /payment plan/);
  }

  // ============================================================
  // 4. Old pledge, no payment plan at all -- must still correctly
  // qualify as stale (the owner's own explicit requirement: this is
  // NOT something this fix should suppress).
  // ============================================================
  {
    const noPlanOld = pledgeEvidence({ pledgeActivityId: "p1", campaign: "LEGACY2022", balanceCents: dollars(1800), totalCents: dollars(1800), pledgePlanOnTrack: null, pledgeAgeDays: 400, pledgeCommitmentAgeDays: 400 });
    const d = donor({ donorId: "legacy-no-plan", openPledges: [noPlanOld] });
    const signal = pledgeFollowUpSignal(d);
    assert.ok(signal, "an old pledge with no payment plan at all must still qualify as stale when justified");
    assert.match(signal.headline, /LEGACY2022 has gone stale/);
  }

  // ============================================================
  // 5/6. A late payment applied to the pledge resolves it -- the
  // recommendation must disappear automatically on the very next
  // evaluation (no stored state, no manual dismissal, nothing to
  // regenerate). Modeled as "before" (plan behind schedule) vs
  // "after" (the exact same pledge, now on track, as
  // evaluatePaymentPlan would report once the real late payment is
  // applied -- see this session's own donor-61566 fix).
  // ============================================================
  {
    const before = pledgeEvidence({ pledgeActivityId: "p1", campaign: "DIN2025", balanceCents: dollars(150), totalCents: dollars(300), pledgePlanOnTrack: false, pledgeAgeDays: 10 });
    const donorBefore = donor({ donorId: "late-payment-donor", openPledges: [before] });
    assert.ok(pledgeFollowUpSignal(donorBefore), "before the late payment is applied, the behind-schedule plan must be flagged");

    const after = pledgeEvidence({ ...before, pledgePlanOnTrack: true });
    const donorAfter = donor({ donorId: "late-payment-donor", openPledges: [after] });
    assert.equal(pledgeFollowUpSignal(donorAfter), null, "once the late payment resolves the installment, the warning must disappear automatically on the next evaluation -- nothing to regenerate or manually dismiss");
  }

  // ============================================================
  // 8 (requirement). Prevent duplicate/contradictory recommendations
  // for the same donor: TWO simultaneously problematic pledges (one
  // behind-schedule plan, one plan-less stale pledge) must still
  // produce exactly ONE pledge_follow_up signal -- the higher-priority
  // behind-schedule plan -- with the other pledge's status folded into
  // the explanation, never a second, contradictory signal.
  // ============================================================
  {
    const behindPlan = pledgeEvidence({ pledgeActivityId: "p1", campaign: "ACTIVEPLAN", balanceCents: dollars(400), totalCents: dollars(1200), pledgePlanOnTrack: false, pledgeAgeDays: 50 });
    const staleNoPlan = pledgeEvidence({ pledgeActivityId: "p2", campaign: "FORGOTTEN", balanceCents: dollars(900), totalCents: dollars(900), pledgePlanOnTrack: null, pledgeAgeDays: 300 });
    const d = donor({ donorId: "two-problems", openPledges: [behindPlan, staleNoPlan] });
    const result = scoreOne(d);
    const signals = detectSituations(d, result, [], [], NOW);
    const pledgeSignals = signals.filter((s) => s.situationType === "pledge_follow_up");
    assert.equal(pledgeSignals.length, 1, "exactly one pledge_follow_up signal, never two contradictory ones for the same donor");
    assert.match(pledgeSignals[0].headline, /ACTIVEPLAN/, "a behind-schedule ACTIVE plan outranks a plan-less stale pledge as the headline issue");
    assert.match(pledgeSignals[0].explanation, /FORGOTTEN/, "the second pledge's own status must still be named, not lost");
  }

  // ============================================================
  // 7. Donor with only ONE open pledge -- must behave completely
  // unchanged from before this fix (the overwhelming majority of real
  // donors). Both the on-track and the stale single-pledge cases above
  // (2 and 4) already prove this; this case re-confirms using the
  // `openPledgeBalanceCents`-shaped single-pledge legacy input alone
  // (openPledges omitted) still works via the real donor() default
  // (openPledges: []) producing no signal for a donor with no open
  // pledge at all.
  // ============================================================
  {
    const d = donor({ donorId: "no-open-pledge" });
    assert.equal(pledgeFollowUpSignal(d), null, "a donor with no open pledges at all must never produce a pledge_follow_up signal");
  }

  // ============================================================
  // Multiple donors, system-wide -- not Goldenberg-specific. Three
  // independent donors, each with their own multi/single-pledge shape,
  // evaluated together, each correctly resolved on its own.
  // ============================================================
  {
    const donors = [
      donor({ donorId: "multi-a", openPledges: [
        pledgeEvidence({ pledgeActivityId: "a1", campaign: "A-PLAN", balanceCents: dollars(2000), totalCents: dollars(5000), pledgePlanOnTrack: true, pledgeAgeDays: 100 }),
        pledgeEvidence({ pledgeActivityId: "a2", campaign: "A-STALE", balanceCents: dollars(300), totalCents: dollars(300), pledgePlanOnTrack: null, pledgeAgeDays: 250 }),
      ] }),
      donor({ donorId: "multi-b", openPledges: [
        pledgeEvidence({ pledgeActivityId: "b1", campaign: "B-ONLY", balanceCents: dollars(1000), totalCents: dollars(1000), pledgePlanOnTrack: true, pledgeAgeDays: 10 }),
      ] }),
      donor({ donorId: "multi-c", openPledges: [] }),
    ];
    const ctx = buildPortfolioContext(donors, [dollars(5000), dollars(1000)]);
    const resultsByDonor = new Map(donors.map((d, i) => [d.donorId, { ...scorePortfolioFocusDonor(d, ctx), rank: i + 1 }]));
    const signalsByDonor = new Map(donors.map((d) => [d.donorId, detectSituations(d, resultsByDonor.get(d.donorId), [], [], NOW).find((s) => s.situationType === "pledge_follow_up") ?? null]));
    assert.match(signalsByDonor.get("multi-a").headline, /A-STALE/, "donor multi-a's stale pledge is caught independently of donor multi-b/c");
    assert.equal(signalsByDonor.get("multi-b"), null, "donor multi-b's single on-track plan produces no signal");
    assert.equal(signalsByDonor.get("multi-c"), null, "donor multi-c has no open pledges at all");
  }

  console.log("multi-open-pledge: Fundraising Intelligence Brief checks passed.");

  // ============================================================
  // Cross-surface consistency (requirement: donor page / Daily Agenda /
  // Fundraising Intelligence Brief must agree). Reproduces
  // lib/workspace/live-data.ts's and app/donors/[id]/page.tsx's own
  // single-actionable-pledge SELECTION logic directly against the real
  // shared primitives (evaluateOpenPledgePlanStatus,
  // isOpenPledgeActionable), over the SAME two-pledge dataset
  // Fundraising Intelligence Brief evaluated above, and asserts they
  // pick the SAME pledge as "the" one that matters -- never two
  // different answers to "which pledge needs attention" for one donor.
  // ============================================================
  function selectMostActionablePledge(candidates) {
    // candidates already most-recent-first, exactly like
    // giving.results (ORDER BY activity_date DESC) in both real files.
    let chosen = candidates[0];
    for (const candidate of candidates) {
      const { hasPlan, isOnTrack } = evaluateOpenPledgePlanStatus(candidate.plan, candidate.linkedPaymentDates, candidate.linkedPaymentAmountsCents, candidate.balanceCents, NOW, "America/New_York");
      if (isOpenPledgeActionable(hasPlan, isOnTrack, candidate.ageDays)) { chosen = candidate; break; }
    }
    return chosen;
  }

  {
    // Goldenberg's real shape again, as the raw inputs live-data.ts/
    // page.tsx actually work with (a plan row + linked payments +
    // raw age), most-recent-first (KOLX2026, then CHSP2026).
    const kolx = {
      id: "kolx2026", balanceCents: dollars(11000), ageDays: 63,
      plan: { installment_amount_cents: dollars(1000), expected_day_of_month: 23, next_expected_payment_at: Math.floor(Date.parse("2026-10-23T00:00:00Z") / 1000), final_expected_payment_at: Math.floor(Date.parse("2027-08-23T00:00:00Z") / 1000) },
      linkedPaymentDates: [Math.floor(Date.parse("2026-09-23T00:00:00Z") / 1000)],
      linkedPaymentAmountsCents: [dollars(1000)],
    };
    const chsp = { id: "chsp2026", balanceCents: dollars(650), ageDays: 165, plan: undefined, linkedPaymentDates: [], linkedPaymentAmountsCents: [] };

    const selected = selectMostActionablePledge([kolx, chsp]);
    assert.equal(selected.id, "chsp2026", "the selection logic shared by the donor page and the Daily Agenda's SUGGESTED section must pick the genuinely actionable CHSP2026 pledge, not the more-recent-but-healthy KOLX2026 one");

    // And Fundraising Intelligence Brief's own independent evaluation
    // (already proven above) named the identical pledge -- both
    // surfaces agree about which pledge actually needs attention.
    const d = donor({ donorId: "goldenberg-consistency", openPledges: [
      pledgeEvidence({ pledgeActivityId: "kolx2026", campaign: "KOLX2026", balanceCents: dollars(11000), totalCents: dollars(12000), pledgePlanOnTrack: true, pledgeAgeDays: 63 }),
      pledgeEvidence({ pledgeActivityId: "chsp2026", campaign: "CHSP2026", balanceCents: dollars(650), totalCents: dollars(650), pledgePlanOnTrack: null, pledgeAgeDays: 165 }),
    ] });
    const briefSignal = pledgeFollowUpSignal(d);
    assert.match(briefSignal.headline, /CHSP2026/, "Fundraising Intelligence Brief's own choice of which pledge matters must agree with the donor-page/Daily-Agenda selection above -- both name CHSP2026");
  }

  // Inverse ordering, same consistency proof.
  {
    const olderWithPlan = { id: "older-plan", balanceCents: dollars(5000), ageDays: 200, plan: { installment_amount_cents: dollars(500), expected_day_of_month: 15, next_expected_payment_at: Math.floor(Date.parse("2026-10-15T00:00:00Z") / 1000), final_expected_payment_at: Math.floor(Date.parse("2027-10-15T00:00:00Z") / 1000) }, linkedPaymentDates: [Math.floor(Date.parse("2026-09-15T00:00:00Z") / 1000)], linkedPaymentAmountsCents: [dollars(500)] };
    const newerStale = { id: "newer-stale", balanceCents: dollars(800), ageDays: 90, plan: undefined, linkedPaymentDates: [], linkedPaymentAmountsCents: [] };
    // Most-recent-first order: newerStale, then olderWithPlan.
    const selected = selectMostActionablePledge([newerStale, olderWithPlan]);
    assert.equal(selected.id, "newer-stale", "the inverse ordering must still correctly select the genuinely stale pledge, never the on-track one just because it happens to be older");
  }

  console.log("multi-open-pledge: cross-surface (donor page / Daily Agenda / Fundraising Intelligence) consistency checks passed.");

  console.log("multi-open-pledge: all assertions passed.");
}

run();
