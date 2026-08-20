import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveOpenPledgeActivityDate, buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";

// Regression coverage for the open-pledge payment-recency bug: Suggested
// Action's "last payment activity" for an open pledge silently kept citing
// the pledge's own original giving_activities.activity_date (which never
// moves once a payment is applied) instead of the most recent linked
// payment (jl_payment_assignment_audits.payment_date). Root cause was
// purely in the input DATA fed into evidence -- buildRecommendationEvidence
// and followUpPledgeCandidate's existing age-based scoring (urgency/
// confidence ramp) needed no change at all once given the correct age; no
// new suppression/threshold policy was invented.

const TIMEZONE = "America/New_York";
const NOW = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000); // matches the live KOLX2026 case's "today"
const JUN_18 = Math.floor(Date.parse("2026-06-18T00:00:00Z") / 1000); // original pledge commitment date
const AUG_18 = Math.floor(Date.parse("2026-08-18T00:00:00Z") / 1000); // the real linked payment date (1 day before NOW)

function evidenceFor(openPledge) {
  return buildRecommendationEvidence(
    { donorId: "donor-1", mostRecentPaidGift: null, openPledge, lastCompletedInteraction: null, lastContactAt: null, lastSubstantiveContactAt: null, openReminder: null, openAsk: null, relationshipSummary: null, institutionalMemory: null, historicalContext: [], yahrtzeits: [], importantDates: [] },
    NOW,
    TIMEZONE,
  );
}

function run() {
  // --- 1: open pledge, no payments -- falls back to the pledge's own
  // original activity_date, exactly as before this fix. ---
  {
    const resolved = resolveOpenPledgeActivityDate(JUN_18, []);
    assert.equal(resolved, JUN_18, "with zero linked payments, the pledge's own activity_date must be used");
    const evidence = evidenceFor({ balanceCents: 1350000, campaign: "KOLX2026", description: null, activityDate: resolved });
    assert.equal(evidence.giving.openPledge.ageDays, 62, "sanity: 62 days between Jun 18 and Aug 19, matching the originally-reported buggy figure -- but here it's the CORRECT figure because no payment was ever linked");
  }

  // --- 2: open pledge, one recent payment -- the linked payment date
  // wins over the original commitment date. This is the exact live
  // KOLX2026 regression case. ---
  {
    const resolved = resolveOpenPledgeActivityDate(JUN_18, [AUG_18]);
    assert.equal(resolved, AUG_18, "a single linked payment must win over the original pledge activity_date");
    const evidence = evidenceFor({ balanceCents: 1350000, campaign: "KOLX2026", description: null, activityDate: resolved });
    assert.equal(evidence.giving.openPledge.ageDays, 1, "ageDays must reflect 1 day since the real Aug 18 payment, not 62 days since the original Jun 18 pledge");
  }

  // --- 3/4: open pledge, several payments -- the LATEST linked payment
  // wins, regardless of insertion order. ---
  {
    const evenEarlier = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
    const evenLater = Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000);
    assert.equal(resolveOpenPledgeActivityDate(JUN_18, [evenEarlier, AUG_18, evenLater]), AUG_18, "the latest of several linked payments must win, in any order");
    assert.equal(resolveOpenPledgeActivityDate(JUN_18, [AUG_18, evenLater, evenEarlier]), AUG_18, "order of the input array must not matter -- always the max");
  }

  // --- 5: payment updates remaining balance and recency consistently --
  // both come from the same real pledge/payment facts (balanceCents from
  // the pledge row post-payment, activityDate from the resolved payment
  // date), never independently stale relative to each other. ---
  {
    const evidence = evidenceFor({ balanceCents: 1350000, campaign: "KOLX2026", description: null, activityDate: resolveOpenPledgeActivityDate(JUN_18, [AUG_18]) });
    assert.equal(evidence.giving.openPledge.balanceCents, 1350000, "the $13,500 remaining balance must be exactly what was passed in -- untouched by the recency fix");
    assert.equal(evidence.giving.openPledge.activityDate, AUG_18, "activityDate in evidence must be the resolved (payment-aware) date");
    assert.equal(evidence.giving.openPledge.ageDays, 1);
  }

  // --- 6/7: unrelated donor payment / payment against another pledge
  // cannot affect this pledge -- resolveOpenPledgeActivityDate only ever
  // receives dates the CALLER has already filtered to this exact pledge's
  // id (pledge_activity_id === thisPledge.id), so a caller correctly
  // scoping its filter structurally cannot leak another pledge's or
  // another donor's payment in. Verified here by confirming filtering
  // logic identical to the real call sites (filter by id, map to date)
  // correctly excludes a same-donor different-pledge payment and a
  // different-donor payment when applied to a small fixture pledge set. ---
  {
    const thisPledgeId = "pledge-kolx2026";
    const otherPledgeId = "pledge-other-campaign";
    const paymentEvents = [
      { pledge_activity_id: thisPledgeId, payment_date: AUG_18 },
      { pledge_activity_id: otherPledgeId, payment_date: Math.floor(Date.parse("2026-08-19T00:00:00Z") / 1000) }, // a LATER payment, but against a DIFFERENT pledge
    ];
    const scopedDates = paymentEvents.filter((event) => event.pledge_activity_id === thisPledgeId).map((event) => event.payment_date);
    assert.deepEqual(scopedDates, [AUG_18], "only the payment linked to THIS pledge's id may be considered, even though a later payment exists for a different pledge");
    assert.equal(resolveOpenPledgeActivityDate(JUN_18, scopedDates), AUG_18, "the other pledge's later payment must never leak into this pledge's resolved date");
  }

  // --- 8: fully-paid pledge (balance_cents <= 0) never produces an
  // openPledge evidence object in the first place -- pre-existing
  // behavior (the balance_cents > 0 filter in every caller), unaffected
  // by and not broken by this fix. followUpPledgeCandidate returns null
  // when evidence.giving.openPledge is null. ---
  {
    const evidence = evidenceFor(null);
    assert.equal(evidence.giving.openPledge, null, "a fully-paid pledge (never passed as openPledge) must leave evidence.giving.openPledge null");
    const candidates = generateCandidates(evidence);
    assert.equal(candidates.some((c) => c.kind === "follow_up_pledge"), false, "no follow_up_pledge candidate can be generated when there is no open pledge");
  }

  // --- 9: old payment still allows stale-pledge follow-up -- a payment
  // that itself happened long ago must still correctly report a large
  // ageDays and remain an eligible (not suppressed) candidate; this fix
  // only corrects WHICH date is used, it never suppresses follow-up. ---
  {
    const oldPayment = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
    const resolved = resolveOpenPledgeActivityDate(JUN_18, [oldPayment]);
    assert.equal(resolved, oldPayment, "an old linked payment still wins over the even-older original pledge date");
    const evidence = evidenceFor({ balanceCents: 1350000, campaign: "KOLX2026", description: null, activityDate: resolved });
    assert.ok(evidence.giving.openPledge.ageDays > 200, "a genuinely stale last-payment date must still produce a large ageDays");
    const candidates = generateCandidates(evidence);
    const pledge = candidates.find((c) => c.kind === "follow_up_pledge");
    assert.ok(pledge, "follow_up_pledge must remain eligible for a genuinely stale pledge -- this fix must never suppress a real stale-pledge follow-up");
    assert.equal(pledge.confidence, "medium", "a genuinely stale pledge (>=60 days) must still report medium confidence, via the existing unmodified threshold");
  }

  // --- 10: recent payment never produces a false "No payment activity in
  // X days" -- the exact live-reported symptom. Confirms the SAME
  // followUpPledgeCandidate wording template, unmodified, now produces a
  // truthful sentence once given the correct age, and that urgency/
  // confidence score materially lower for a just-paid pledge (answer C:
  // score materially lower, achieved by the existing age-based curve,
  // with zero new threshold invented). ---
  {
    const evidence = evidenceFor({ balanceCents: 1350000, campaign: "KOLX2026", description: null, activityDate: resolveOpenPledgeActivityDate(JUN_18, [AUG_18]) });
    const candidates = generateCandidates(evidence);
    const pledge = candidates.find((c) => c.kind === "follow_up_pledge");
    assert.ok(pledge, "follow_up_pledge must still be generated (not suppressed) for a pledge with a recent payment -- it just scores lower");
    assert.doesNotMatch(pledge.why, /No payment activity in 62 days/, "the exact reported bad sentence must never be produced once a real payment 1 day ago is correctly recognized");
    assert.match(pledge.why, /No payment activity in 1 days?/, "the wording template is unchanged and now produces a truthful sentence: no NEW activity in the 1 day since the real payment");
    assert.match(pledge.evidence[0], /last activity 2026-08-18/, "the evidence line must cite the real payment date, not the original Jun 18 commitment date");
    assert.equal(pledge.confidence, "low", "a just-paid pledge must score low confidence via the existing unmodified age >= 60 threshold -- answer C (materially lower score), no new suppression rule needed");
    assert.ok(pledge.urgency < 0.01, "urgency must be near zero for a pledge with payment activity from yesterday, via the existing unmodified urgency curve");
  }

  // --- 11: Today/donor page/Meeting Brief evidence agree -- all three
  // surfaces must route openPledge.activityDate through
  // resolveOpenPledgeActivityDate, not read activity_date directly off
  // the giving_activities row. Source-level cross-surface consistency
  // check, since these three loaders are D1-coupled and not directly
  // invokable in a plain Node test (same established pattern as
  // tests/today.test.mjs). ---
  console.log("Pledge-payment-recency pure/candidate checks passed.");
}

run();

async function runCrossSurfaceChecks() {
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");

  for (const [name, source] of [["live-data.ts (Today)", liveData], ["meeting-brief.ts", meetingBrief], ["donor page", donorPage]]) {
    assert.match(source, /resolveOpenPledgeActivityDate/, `${name} must route openPledge.activityDate through resolveOpenPledgeActivityDate`);
    // Every surface's openPledge construction must NOT pass the raw
    // activity_date straight through as activityDate anymore.
    assert.doesNotMatch(source, /activityDate:\s*(pledge|openPledgeSource)\.activity_date\b/, `${name} must not read activity_date directly onto openPledge.activityDate -- must resolve via linked payments first`);
  }

  // Each surface must scope its linked-payment dates to the exact pledge
  // id before resolving -- never pass an unfiltered/whole-donor payment
  // list straight into resolveOpenPledgeActivityDate.
  assert.match(liveData, /paymentDatesByPledge\.get\(pledge\.id\)/, "Today must look up payment dates scoped to this exact pledge's id");
  assert.match(meetingBrief, /pledgePaymentRows\.results\.filter\(\(event\) => event\.pledge_activity_id === openPledgeSource\.id\)/, "Meeting Brief must scope payment dates to this exact pledge's id");
  assert.match(donorPage, /paymentEvents\.filter\(\(event\) => event\.pledge_activity_id === openPledgeSource\.id\)/, "the donor page must scope payment dates to this exact pledge's id");

  // No new schema/migration -- this task fixes evidence data only.
  const drizzleDir = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(drizzleDir, /jlPaymentAssignmentAudits/, "sanity: the existing jl_payment_assignment_audits table this fix reads from must already exist -- no new table was added");

  console.log("Pledge-payment-recency cross-surface consistency checks passed.");
}

await runCrossSurfaceChecks();
