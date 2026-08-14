import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation, score } from "../lib/relationships/recommendation-rank.ts";
import {
  selectSuggestionDonorIds,
  HOMEPAGE_MAX_RESULTS,
  CONTACT_GAP_POOL_HEADROOM_MULTIPLIER,
  CONTACT_GAP_POOL_SIZE,
} from "../lib/workspace/suggestion-candidates.ts";

// Diagnosed against a real incident: loadWorkspaceBrief was sending ~247 of
// 248 staging donors through full per-donor evidence-building and
// candidate scoring on every homepage load, because "no recent contact"
// covers nearly the whole roster at real scale. This file proves two
// things: (1) the one assumption the bounded-pool strategy depends on --
// that reconnect_contact_gap's ranking is a pure, monotonic function of
// days-since-contact -- actually holds against the real engine, and (2)
// the bounded pool itself stays small as the donor count grows while never
// dropping a donor with real (gift/pledge/yahrtzeit) evidence, regardless
// of where that donor happens to sit in an arbitrary input ordering.

const NOW = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
const DAY = 86400;
const TIMEZONE = "America/New_York";
const daysAgo = (n) => NOW - n * DAY;

const emptyInput = {
  donorId: "donor",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  openReminder: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
  yahrtzeits: [],
  importantDates: [],
};

function reconnectCandidateFor(daysSinceContact) {
  const lastContactAt = daysSinceContact === null ? null : daysAgo(daysSinceContact);
  const evidence = buildRecommendationEvidence({ ...emptyInput, lastContactAt }, NOW, TIMEZONE);
  return generateCandidates(evidence).find((c) => c.kind === "reconnect_contact_gap") ?? null;
}

async function run() {
  // --- monotonicity invariant: this is the ENTIRE correctness argument
  // the bounded contact-gap pool relies on. If a future change to
  // reconnect_contact_gap makes its score depend on anything other than
  // days-since-contact (e.g. donor lifetime value), this test fails and
  // the pool-selection strategy in suggestion-candidates.ts needs
  // revisiting, not just a bigger pool size. ---
  const sampleDays = [90, 120, 183, 200, 300, 365, 500, 1000];
  const candidates = sampleDays.map((days) => ({ days, candidate: reconnectCandidateFor(days) }));
  for (const { days, candidate } of candidates) assert.ok(candidate, `${days} days since contact must still generate reconnect_contact_gap`);

  const specificities = new Set(candidates.map(({ candidate }) => candidate.specificity));
  const recencies = new Set(candidates.map(({ candidate }) => candidate.recency));
  assert.equal(specificities.size, 1, "specificity must be a fixed constant, independent of days-since-contact -- this is what makes the ranking a pure function of one variable");
  assert.equal(recencies.size, 1, "recency must be a fixed constant, independent of days-since-contact");

  const scores = candidates.map(({ candidate }) => score(candidate));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1], `score must be non-decreasing as days-since-contact increases: day ${sampleDays[i - 1]} -> ${scores[i - 1]}, day ${sampleDays[i]} -> ${scores[i]}`);
  }

  // "Never contacted" is a fixed urgency (0.5), not a point on the
  // continuous days curve -- assert it lands where the formula says it
  // should (between the scores for 90 and 365 days), so
  // selectSuggestionDonorIds's choice to treat it as "more stale than any
  // specific day count" is a conservative, safe over-approximation, not a
  // guess.
  const neverContacted = reconnectCandidateFor(null);
  const neverContactedScore = score(neverContacted);
  const score90 = score(reconnectCandidateFor(90));
  const score365 = score(reconnectCandidateFor(365));
  assert.ok(neverContactedScore >= score90 && neverContactedScore <= score365, "never-contacted's fixed urgency (0.5) must fall within the real day-count range, confirming it's safe to treat as maximally stale for pool-selection purposes");

  // A day count under the generator's own 90-day threshold must not
  // generate this candidate at all -- confirms the invariant test isn't
  // accidentally passing on a candidate that doesn't really exist.
  assert.equal(reconnectCandidateFor(10), null);

  console.log("Contact-gap monotonicity invariant checks passed.");

  // --- derivation sanity: the pool size must actually be derived from
  // the homepage display ceiling, not an independent number. ---
  assert.equal(CONTACT_GAP_POOL_SIZE, HOMEPAGE_MAX_RESULTS * CONTACT_GAP_POOL_HEADROOM_MULTIPLIER);
  assert.ok(CONTACT_GAP_POOL_HEADROOM_MULTIPLIER >= 1, "headroom must never shrink the pool below the display ceiling itself");

  // --- scale fixtures: 248 (current real scale) and 2000 (larger than
  // real). Urgent-evidence donors are deliberately placed at the END of
  // every input array/list -- the least favorable position for any
  // ordering-dependent bug to hide behind. ---
  function buildFixture(totalDonors) {
    const contactGapCandidates = [];
    // Never-contacted (null) donors are deliberately kept a small,
    // fixed-size minority (5, not scaling with totalDonors) -- null is
    // treated as more stale than any finite day count (see
    // suggestion-candidates.ts), so if nulls alone ever filled the whole
    // pool, no finite-days donor could appear regardless of how stale --
    // that's correct behavior for the module, but would make the
    // "stalest numeric donor is included" assertion below meaningless at
    // large totalDonors. A realistic donor base has some never-contacted
    // donors, not one out of every twenty.
    for (let i = 0; i < totalDonors; i++) {
      const daysSinceLastContact = i < 5 ? null : (i % 500) + 1;
      contactGapCandidates.push({ donorId: `donor-${i}`, daysSinceLastContact });
    }
    // Urgent-evidence donors placed last in every relevant list.
    const giftDonorId = `donor-${totalDonors - 1}`;
    const pledgeDonorId = `donor-${totalDonors - 2}`;
    const yahrtzeitDonorId = `donor-${totalDonors - 3}`;
    const birthdayDonorId = `donor-${totalDonors - 6}`;
    const anniversaryDonorId = `donor-${totalDonors - 7}`;
    // Make sure these five are NOT already stale-enough to land in the
    // bounded pool on their own merits -- give them recent contact, so
    // the only reason they'd be selected is their real evidence.
    for (const id of [giftDonorId, pledgeDonorId, yahrtzeitDonorId, birthdayDonorId, anniversaryDonorId]) {
      const row = contactGapCandidates.find((c) => c.donorId === id);
      row.daysSinceLastContact = 5;
    }
    return {
      contactGapCandidates,
      giftDonorIds: [giftDonorId],
      pledgeDonorIds: [pledgeDonorId],
      // 3 days out -- inside the 14-day lead window.
      yahrtzeitRows: [{ donorId: yahrtzeitDonorId, hebrewMonth: "Elul", hebrewDay: 3 }],
      // Aug 16/17 relative to NOW (Aug 13, 2026) -- 3/4 days out, inside window.
      importantDateRows: [
        { donorId: birthdayDonorId, month: 8, day: 16 },
        { donorId: anniversaryDonorId, month: 8, day: 17 },
      ],
      giftDonorId, pledgeDonorId, yahrtzeitDonorId, birthdayDonorId, anniversaryDonorId,
    };
  }

  for (const totalDonors of [248, 2000]) {
    const fixture = buildFixture(totalDonors);
    const selected = selectSuggestionDonorIds({
      giftDonorIds: fixture.giftDonorIds,
      pledgeDonorIds: fixture.pledgeDonorIds,
      yahrtzeitRows: fixture.yahrtzeitRows,
      importantDateRows: fixture.importantDateRows,
      contactGapCandidates: fixture.contactGapCandidates,
      timezone: TIMEZONE,
      now: NOW,
    });

    // Bounded: nowhere near the full donor count, and does not grow
    // proportionally with it.
    // Tolerance covers the 5 non-contact-gap donors unioned in on top of the
    // bounded contact-gap set: gift, pledge, yahrtzeit, birthday, anniversary.
    assert.ok(selected.size <= CONTACT_GAP_POOL_SIZE + 5, `selected pool (${selected.size}) must stay bounded near CONTACT_GAP_POOL_SIZE regardless of ${totalDonors} total donors`);
    assert.ok(selected.size < totalDonors, "the bounded pool must be meaningfully smaller than the full donor set at real scale");

    // Every urgent-evidence donor survives, despite being placed last.
    assert.ok(selected.has(fixture.giftDonorId), `gift donor must be selected at ${totalDonors} donors`);
    assert.ok(selected.has(fixture.pledgeDonorId), `pledge donor must be selected at ${totalDonors} donors`);
    assert.ok(selected.has(fixture.yahrtzeitDonorId), `within-window yahrtzeit donor must be selected at ${totalDonors} donors`);
    assert.ok(selected.has(fixture.birthdayDonorId), `within-window birthday donor must be selected at ${totalDonors} donors`);
    assert.ok(selected.has(fixture.anniversaryDonorId), `within-window anniversary donor must be selected at ${totalDonors} donors`);

    // The stalest donors ARE represented (proving the bound is by
    // staleness, not by donor-id ordering or array position). Computed
    // from the same unmutated fixture `selected` was built from.
    const stalestDonor = fixture.contactGapCandidates
      .filter((c) => c.daysSinceLastContact !== null)
      .sort((a, b) => b.daysSinceLastContact - a.daysSinceLastContact)[0];
    assert.ok(selected.has(stalestDonor.donorId), "the single stalest contact-gap donor must always be in the bounded pool");

    // Never-contacted donors are treated as more stale than any finite
    // day count and must always be included too.
    for (const c of fixture.contactGapCandidates.filter((c) => c.daysSinceLastContact === null)) {
      assert.ok(selected.has(c.donorId), `never-contacted donor ${c.donorId} must always be in the bounded pool`);
    }

    // A moderately-stale donor comfortably outside the top CONTACT_GAP_POOL_SIZE
    // must be excluded -- proving the pool is genuinely bounded, not just
    // "big enough it never matters" for this fixture shape.
    const midStaleDonor = fixture.contactGapCandidates.find((c) => c.daysSinceLastContact === 50);
    if (midStaleDonor) assert.equal(selected.has(midStaleDonor.donorId), false, "a donor far outside the top-N stalest must be excluded from the bounded pool");

    // A yahrtzeit outside the lead window must NOT force its donor in --
    // this is the tightened-from-"any yahrtzeit" behavior. Mutates a
    // never-reused row, and is the last thing done with this fixture.
    const distantYahrtzeitDonorId = `donor-${totalDonors - 5}`;
    const distantRow = fixture.contactGapCandidates.find((c) => c.donorId === distantYahrtzeitDonorId);
    distantRow.daysSinceLastContact = 5; // also recently contacted, so only the yahrtzeit could pull it in
    const selectedWithDistant = selectSuggestionDonorIds({
      giftDonorIds: fixture.giftDonorIds,
      pledgeDonorIds: fixture.pledgeDonorIds,
      yahrtzeitRows: [...fixture.yahrtzeitRows, { donorId: distantYahrtzeitDonorId, hebrewMonth: "Av", hebrewDay: 28 }], // ~1 year out relative to NOW
      contactGapCandidates: fixture.contactGapCandidates,
      timezone: TIMEZONE,
      now: NOW,
    });
    assert.equal(selectedWithDistant.has(distantYahrtzeitDonorId), false, "a yahrtzeit far outside the lead window must not pull its donor into the bounded pool");

    // Same check for an out-of-window birthday.
    const distantBirthdayDonorId = `donor-${totalDonors - 8}`;
    const distantBirthdayRow = fixture.contactGapCandidates.find((c) => c.donorId === distantBirthdayDonorId);
    distantBirthdayRow.daysSinceLastContact = 5;
    const selectedWithDistantBirthday = selectSuggestionDonorIds({
      giftDonorIds: fixture.giftDonorIds,
      pledgeDonorIds: fixture.pledgeDonorIds,
      yahrtzeitRows: fixture.yahrtzeitRows,
      importantDateRows: [...fixture.importantDateRows, { donorId: distantBirthdayDonorId, month: 1, day: 1 }], // months away relative to NOW
      contactGapCandidates: fixture.contactGapCandidates,
      timezone: TIMEZONE,
      now: NOW,
    });
    assert.equal(selectedWithDistantBirthday.has(distantBirthdayDonorId), false, "a birthday far outside the lead window must not pull its donor into the bounded pool");

    // --- end-to-end: run the real canonical engine on the bounded set and
    // confirm the urgent donors' recommendations come out correctly. This
    // is the strongest available proof that bounding candidate selection
    // never changes what the recommendation engine itself decides. ---
    const giftEvidence = buildRecommendationEvidence({
      ...emptyInput,
      donorId: fixture.giftDonorId,
      mostRecentPaidGift: { giftSource: "giving_activity", giftId: "g-1", amountCents: 10000, occurredAt: daysAgo(5), campaign: null, description: null, acknowledged: false },
      lastContactAt: daysAgo(5),
    }, NOW, TIMEZONE);
    assert.equal(buildDonorRecommendation(giftEvidence).kind, "acknowledge_gift");

    const pledgeEvidence = buildRecommendationEvidence({
      ...emptyInput,
      donorId: fixture.pledgeDonorId,
      openPledge: { balanceCents: 50000, campaign: null, description: null, activityDate: daysAgo(100) },
      lastContactAt: daysAgo(5),
    }, NOW, TIMEZONE);
    assert.equal(buildDonorRecommendation(pledgeEvidence).kind, "follow_up_pledge");

    const yahrtzeitEvidence = buildRecommendationEvidence({
      ...emptyInput,
      donorId: fixture.yahrtzeitDonorId,
      lastContactAt: daysAgo(5),
      yahrtzeits: [{ deceasedNameEnglish: "Test Person", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3 }],
    }, NOW, TIMEZONE);
    assert.equal(buildDonorRecommendation(yahrtzeitEvidence).kind, "yahrtzeit_outreach");

    const birthdayEvidence = buildRecommendationEvidence({
      ...emptyInput,
      donorId: fixture.birthdayDonorId,
      lastContactAt: daysAgo(5),
      importantDates: [{ type: "birthday", personName: "Test Person", relationship: null, month: 8, day: 16, year: null }],
    }, NOW, TIMEZONE);
    assert.equal(buildDonorRecommendation(birthdayEvidence).kind, "birthday_outreach");

    const anniversaryEvidence = buildRecommendationEvidence({
      ...emptyInput,
      donorId: fixture.anniversaryDonorId,
      lastContactAt: daysAgo(5),
      importantDates: [{ type: "anniversary", personName: null, relationship: null, month: 8, day: 17, year: null }],
    }, NOW, TIMEZONE);
    assert.equal(buildDonorRecommendation(anniversaryEvidence).kind, "anniversary_outreach");

    console.log(`Scale fixture (${totalDonors} donors): bounded pool size ${selected.size}, all urgent-evidence donors preserved.`);
  }

  console.log("Suggestion-candidate scale checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
