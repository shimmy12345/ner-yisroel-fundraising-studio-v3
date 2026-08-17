import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

// Noon UTC, not midnight -- midnight UTC on this date is still the
// previous evening in America/New_York (used below for yahrtzeit
// fixtures), which would shift which Hebrew calendar day "today" resolves
// to. Noon UTC is safely inside the same calendar day for every real-world
// timezone this app supports.
const NOW = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const DAY = 86400;
const daysAgo = (n) => NOW - n * DAY;
const TIMEZONE = "America/New_York";

const emptyInput = {
  donorId: "donor-empty",
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

// NOW (2026-08-12) is 29 Av 5786. "3 Elul" is 3 days out (inside the
// 14-day lead window, unambiguous); "28 Av" is over a year out (well
// outside it). Verified directly against lib/calendar/hebrew-date.ts
// rather than assumed, so this fixture can't silently drift out of sync
// with the calendar library's own leap-year placement.
const yahrtzeit = (overrides = {}) => ({ deceasedNameEnglish: "Sarah Cohen", deceasedNameHebrew: "שרה בת אברהם", relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3, ...overrides });

// A "new gift" defaults to unacknowledged unless explicitly overridden --
// this matches the gift_acknowledgments table's own design: absence of any
// row for a gift IS "not yet acknowledged", never inferred from anything else.
const gift = (overrides = {}) => ({ giftSource: "giving_activity", giftId: "activity-1", amountCents: 5000, occurredAt: daysAgo(10), campaign: "Fund", description: null, acknowledged: false, ...overrides });

async function run() {
  // --- evidence builder: derived fields ---
  // 1. A new/unmarked gift is unacknowledged by default.
  const withUnacknowledgedGift = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: gift({ acknowledged: false }), lastContactAt: daysAgo(3) }, NOW, TIMEZONE);
  assert.equal(withUnacknowledgedGift.giving.mostRecentPaidGift.acknowledged, false);
  // An unrelated interaction after the gift date must NOT, by itself,
  // count as acknowledgment -- only the explicit flag does. This is the
  // exact behavior the old date-comparison inference used to get wrong.
  const withGiftAndLaterInteraction = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: gift({ acknowledged: false }), lastContactAt: daysAgo(1) }, NOW, TIMEZONE);
  assert.ok(generateCandidates(withGiftAndLaterInteraction).find((c) => c.kind === "acknowledge_gift"), "a later, unrelated interaction must never silently count as a thank-you");
  // 2/3/4. Marking any of the three statuses (thank_you_sent/
  // thank_you_call/no_acknowledgment_needed) suppresses the candidate --
  // the evidence layer only cares about the boolean, not which status;
  // tests/gift-acknowledgment-safety.test.mjs covers that the API route
  // itself accepts and stores all three distinct values.
  const markedAcknowledged = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: gift({ acknowledged: true }) }, NOW, TIMEZONE);
  assert.equal(generateCandidates(markedAcknowledged).find((c) => c.kind === "acknowledge_gift"), undefined, "any acknowledgment status must suppress the recommendation");
  const withPledge = buildRecommendationEvidence({ ...emptyInput, openPledge: { balanceCents: 1000, campaign: null, description: null, activityDate: daysAgo(45) } }, NOW, TIMEZONE);
  assert.equal(withPledge.giving.openPledge.ageDays, 45);
  const withReminder = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: daysAgo(2) } }, NOW, TIMEZONE);
  assert.equal(withReminder.reminder.isOverdue, true, "a due date in the past must be overdue");
  const withFutureReminder = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: NOW + 5 * DAY } }, NOW, TIMEZONE);
  assert.equal(withFutureReminder.reminder.isOverdue, false);

  // --- overdue semantics: calendar-day, not raw-instant -- and unified
  // timeline / recommendation evidence must always agree ---
  // Each case: [dueAt, now, timezone, expectedOverdue, description].
  // America/New_York is behind UTC; Asia/Jerusalem is ahead of UTC -- using
  // both proves the fix reads the LOCAL calendar day, never the UTC one.
  const overdueBoundaryCases = [
    [Date.UTC(2026, 7, 16, 12, 0, 0) / 1000, Date.UTC(2026, 7, 17, 15, 0, 0) / 1000, "America/New_York", true, "due yesterday (local) -> overdue"],
    [Date.UTC(2026, 7, 17, 12, 0, 0) / 1000, Date.UTC(2026, 7, 17, 15, 0, 0) / 1000, "America/New_York", false, "due today, UTC-noon anchor, checked after that instant has passed -> not overdue"],
    [Date.UTC(2026, 7, 18, 12, 0, 0) / 1000, Date.UTC(2026, 7, 17, 15, 0, 0) / 1000, "America/New_York", false, "due tomorrow (local) -> not overdue"],
    [Date.UTC(2026, 7, 17, 12, 0, 0) / 1000, Date.UTC(2026, 7, 18, 3, 30, 0) / 1000, "America/New_York", false, "due today, checked at 23:30 local (immediately before local midnight) -> not overdue"],
    [Date.UTC(2026, 7, 17, 12, 0, 0) / 1000, Date.UTC(2026, 7, 18, 4, 30, 0) / 1000, "America/New_York", true, "same due date, checked at 00:30 local the next day (just after local midnight) -> overdue"],
    [Date.UTC(2026, 7, 17, 10, 0, 0) / 1000, Date.UTC(2026, 7, 17, 22, 0, 0) / 1000, "Asia/Jerusalem", true, "UTC calendar date identical for due date and now (both Aug 17 UTC), but local dates differ (Aug 17 vs Aug 18 in Jerusalem) -> overdue"],
  ];
  for (const [dueAt, now, timezone, expected, description] of overdueBoundaryCases) {
    const evidence = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Follow up", reason: "r", dueAt } }, now, timezone);
    assert.equal(evidence.reminder.isOverdue, expected, `recommendation-evidence: ${description}`);

    const timeline = buildUnifiedTimeline({
      giving: [], legacyGifts: [], payments: [], interactions: [],
      reminders: [{ id: "boundary-reminder", action: "Follow up", reason: "r", status: "open", due_at: dueAt, created_at: dueAt, updated_at: dueAt }],
      now, timezone,
    });
    const timelineOverdue = timeline.find((item) => item.key === "reminder:boundary-reminder").status === "overdue";
    assert.equal(timelineOverdue, expected, `unified-timeline: ${description}`);
    assert.equal(timelineOverdue, evidence.reminder.isOverdue, `unified timeline and recommendation evidence must agree: ${description}`);
  }

  const noContactEver = buildRecommendationEvidence(emptyInput, NOW, TIMEZONE);
  assert.equal(noContactEver.contact.daysSinceLastContact, null);

  // --- candidate generators: only fire on their own precondition ---
  assert.equal(generateCandidates(buildRecommendationEvidence(emptyInput, NOW, TIMEZONE)).find((c) => c.kind === "honor_reminder"), undefined);
  assert.ok(generateCandidates(withReminder).find((c) => c.kind === "honor_reminder"), "an open reminder must generate honor_reminder");
  assert.ok(generateCandidates(withUnacknowledgedGift).find((c) => c.kind === "acknowledge_gift"), "an unacknowledged paid gift must generate acknowledge_gift");
  assert.ok(generateCandidates(withPledge).find((c) => c.kind === "follow_up_pledge"));
  const gapEvidence = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(120) }, NOW, TIMEZONE);
  assert.ok(generateCandidates(gapEvidence).find((c) => c.kind === "reconnect_contact_gap"));
  const noGapEvidence = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(10) }, NOW, TIMEZONE);
  assert.equal(generateCandidates(noGapEvidence).find((c) => c.kind === "reconnect_contact_gap"), undefined, "a recent contact must not generate a contact-gap candidate");
  const narrativeEvidence = buildRecommendationEvidence({ ...emptyInput, relationshipSummary: "Loves the annual gala" }, NOW, TIMEZONE);
  assert.ok(generateCandidates(narrativeEvidence).find((c) => c.kind === "relationship_opportunity"));
  // No data at all (donor never contacted, nothing else on file) still
  // honestly falls back to reconnect_contact_gap -- "no contact ever
  // recorded" is itself real evidence, not a fabricated suggestion.
  const trulyEmpty = generateCandidates(buildRecommendationEvidence(emptyInput, NOW, TIMEZONE));
  assert.deepEqual(trulyEmpty.map((c) => c.kind), ["reconnect_contact_gap"]);
  // A donor contacted recently, with nothing else on file at all, has
  // genuinely nothing to suggest.
  assert.equal(generateCandidates(noGapEvidence).length, 0, "a recently-contacted donor with no other signal must generate zero candidates");

  // --- hard constraint 1: reminder suppresses the next-touchpoint family,
  // never the money-stewardship family ---
  const reminderPlusGift = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: null }, mostRecentPaidGift: gift({ amountCents: 1000, occurredAt: daysAgo(3) }), lastContactAt: daysAgo(10) }, NOW, TIMEZONE);
  const reminderPlusGap = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: null }, lastContactAt: daysAgo(200) }, NOW, TIMEZONE);
  const afterReminderWithGift = buildDonorRecommendation(reminderPlusGift);
  assert.ok(["honor_reminder", "acknowledge_gift"].includes(afterReminderWithGift.kind), "a reminder must not eliminate a competing gift-acknowledgment candidate");
  const afterReminderWithGap = buildDonorRecommendation(reminderPlusGap);
  assert.equal(afterReminderWithGap.kind, "honor_reminder", "a reminder must suppress a competing contact-gap candidate, not just outscore it");

  // --- hard constraint 2: open pledge vetoes solicit unless evidence postdates it ---
  const solicitBlockedByPledge = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 3000, campaign: "Building Fund", description: null, activityDate: daysAgo(90) },
    historicalContext: [{ text: "Solicit for $18k -- corporate sponsorship", source: "import-monday", sourceDate: daysAgo(120) }],
  }, NOW, TIMEZONE);
  const blockedCandidates = generateCandidates(solicitBlockedByPledge);
  assert.ok(blockedCandidates.find((c) => c.kind === "solicit"), "sanity: the raw candidate must exist before the veto is applied");
  const blockedResult = buildDonorRecommendation(solicitBlockedByPledge);
  assert.equal(blockedResult.kind, "follow_up_pledge", "an unconfirmed solicitation note predating the pledge must be vetoed entirely, not merely outranked");

  // Pledge activity is recent here (low urgency for follow_up_pledge) so
  // this isolates "did the veto lift" from "did it also win on score" --
  // both must be true for this assertion to hold.
  const solicitAllowedAfterPledge = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 3000, campaign: "Building Fund", description: null, activityDate: daysAgo(20) },
    relationshipSummary: "Solicit for a new corporate sponsorship opportunity that came up after the pledge",
  }, NOW, TIMEZONE);
  const allowedResult = buildDonorRecommendation(solicitAllowedAfterPledge);
  assert.equal(allowedResult.kind, "solicit", "solicitation evidence postdating the pledge must survive the veto and be free to compete");

  // --- hard constraint 3: unconfirmed-historical evidence is capped, never "high" ---
  const historicalOnly = buildRecommendationEvidence({ ...emptyInput, historicalContext: [{ text: "Solicit for $10k", source: "import-monday", sourceDate: daysAgo(30) }] }, NOW, TIMEZONE);
  const historicalWinner = buildDonorRecommendation(historicalOnly);
  assert.equal(historicalWinner.kind, "solicit");
  assert.notEqual(historicalWinner.confidence, "high", "a candidate sourced only from unconfirmed historical context must never be high confidence");
  assert.match(historicalWinner.evidence.join(" "), /never confirmed/i, "unconfirmed historical evidence must carry explicit uncertainty language");

  // Confirmed evidence must outrank an unconfirmed-historical candidate
  // describing a similar opportunity when both are present.
  const confirmedBeatsHistorical = buildRecommendationEvidence({
    ...emptyInput,
    mostRecentPaidGift: gift({ amountCents: 1000, occurredAt: daysAgo(2) }),
    lastContactAt: daysAgo(20),
    historicalContext: [{ text: "Solicit for $10k", source: "import-monday", sourceDate: daysAgo(300) }],
  }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(confirmedBeatsHistorical).kind, "acknowledge_gift", "a confirmed recent gift must outrank an unconfirmed historical solicitation note");

  // --- the three documented competing cases ---
  // Case 1: recent gift vs. aging pledge -- recency+specificity wins over raw staleness.
  const case1 = buildRecommendationEvidence({
    ...emptyInput,
    mostRecentPaidGift: gift({ amountCents: 200000, occurredAt: daysAgo(5), campaign: "Annual Campaign" }),
    openPledge: { balanceCents: 800000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(200) },
    lastContactAt: daysAgo(200),
  }, NOW, TIMEZONE);
  const case1Result = buildDonorRecommendation(case1);
  assert.equal(case1Result.kind, "acknowledge_gift");
  // 5. The recommendation carries the exact gift identity, so a caller
  // can wire a direct "Mark thank-you sent" action without re-deriving it.
  assert.equal(case1Result.giftSource, "giving_activity");
  assert.equal(case1Result.giftId, "activity-1");
  // Once that specific gift is marked acknowledged, the recommendation
  // for this donor must disappear entirely (assuming nothing else
  // qualifies) -- proving suppression is keyed to the correct gift, not
  // just "some gift exists".
  const case1Acknowledged = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: gift({ amountCents: 200000, occurredAt: daysAgo(5), campaign: "Annual Campaign", acknowledged: true }), openPledge: case1.giving.openPledge, lastContactAt: daysAgo(200) }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(case1Acknowledged).kind, "follow_up_pledge", "acknowledging the gift must remove it from contention, leaving the next-best candidate");
  // 10. Acknowledgment on a DIFFERENT gift (different giftId) must never
  // suppress this one -- status is tied to the specific gift, not the donor.
  const differentGiftAcknowledged = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: gift({ amountCents: 200000, occurredAt: daysAgo(5), campaign: "Annual Campaign", giftId: "activity-2", acknowledged: false }) }, NOW, TIMEZONE);
  assert.ok(generateCandidates(differentGiftAcknowledged).find((c) => c.kind === "acknowledge_gift" && c.giftId === "activity-2"), "acknowledging one gift must never affect a different gift's own state");

  // Case 2: unconfirmed historical solicitation predating an open pledge -- vetoed.
  const case2 = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 300000, campaign: "Building Fund", description: null, activityDate: daysAgo(90) },
    lastContactAt: daysAgo(90),
    historicalContext: [{ text: "Solicit for $18k -- corporate sponsorship", source: "import-monday", sourceDate: daysAgo(120) }],
  }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(case2).kind, "follow_up_pledge");

  // Case 3: long contact gap vs. specific relationship narrative -- specificity wins over raw urgency.
  const case3 = buildRecommendationEvidence({
    ...emptyInput,
    lastContactAt: daysAgo(150),
    relationshipSummary: "Interested in funding a new scholarship track; wants to discuss after his daughter's wedding in September.",
  }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(case3).kind, "relationship_opportunity");
  // With no narrative at all, the same contact gap must fall back honestly.
  const case3NoNarrative = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(150) }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(case3NoNarrative).kind, "reconnect_contact_gap");

  // --- yahrtzeit_outreach: awareness vs. action urgency ---
  // A yahrtzeit within the lead window (3 days out here) generates a
  // candidate and it's the only evidence, so it wins outright.
  const withUpcomingYahrtzeit = buildRecommendationEvidence({ ...emptyInput, yahrtzeits: [yahrtzeit()] }, NOW, TIMEZONE);
  const yahrtzeitCandidates = generateCandidates(withUpcomingYahrtzeit);
  assert.ok(yahrtzeitCandidates.find((c) => c.kind === "yahrtzeit_outreach"), "a yahrtzeit inside the lead window must generate yahrtzeit_outreach");
  const yahrtzeitWinner = buildDonorRecommendation(withUpcomingYahrtzeit);
  assert.equal(yahrtzeitWinner.kind, "yahrtzeit_outreach");
  assert.match(yahrtzeitWinner.evidence.join(" "), /Mother/, "evidence must name the relationship");
  assert.match(yahrtzeitWinner.evidence.join(" "), /Sarah Cohen/, "evidence must name the deceased");
  assert.match(yahrtzeitWinner.evidence.join(" "), /Elul/, "evidence must name the Hebrew date");

  // A yahrtzeit far outside the lead window (over a year away, "28 Av")
  // must not even generate a candidate -- this is the "action urgency"
  // half; the separate "awareness" half (always showing it on the donor
  // profile/Meeting Brief) is verified below at the source level, since
  // it deliberately bypasses this candidate/evidence gate entirely.
  const withDistantYahrtzeit = buildRecommendationEvidence({ ...emptyInput, yahrtzeits: [yahrtzeit({ hebrewMonth: "Av", hebrewDay: 28 })] }, NOW, TIMEZONE);
  assert.equal(generateCandidates(withDistantYahrtzeit).find((c) => c.kind === "yahrtzeit_outreach"), undefined, "a yahrtzeit far outside the lead window must not generate a candidate");

  // An unrelated open reminder must never suppress yahrtzeit_outreach --
  // the reminder-suppression hard constraint deliberately excludes it (see
  // recommendation-rank.ts's REMINDER_SUPPRESSES set), and there is no
  // name-matching dedup in this version.
  const yahrtzeitPlusUnrelatedReminder = buildRecommendationEvidence({ ...emptyInput, yahrtzeits: [yahrtzeit()], openReminder: { action: "Call about something unrelated", reason: "r", dueAt: NOW + 30 * DAY } }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(yahrtzeitPlusUnrelatedReminder).kind, "yahrtzeit_outreach", "an unrelated open reminder must not suppress yahrtzeit_outreach");

  // Only the soonest yahrtzeit is considered when a donor has several.
  const withMultipleYahrtzeits = buildRecommendationEvidence({ ...emptyInput, yahrtzeits: [yahrtzeit({ deceasedNameEnglish: "Distant Relative", hebrewMonth: "Av", hebrewDay: 28 }), yahrtzeit({ deceasedNameEnglish: "Sarah Cohen" })] }, NOW, TIMEZONE);
  const multiWinner = buildDonorRecommendation(withMultipleYahrtzeits);
  assert.equal(multiWinner.kind, "yahrtzeit_outreach");
  assert.match(multiWinner.evidence.join(" "), /Sarah Cohen/, "the soonest yahrtzeit must win, not an arbitrary one");

  // --- birthday_outreach / anniversary_outreach: same awareness-vs-action
  // shape as yahrtzeit_outreach, sharing the same lead window and the same
  // "never suppressed by an unrelated reminder" behavior. ---
  const withUpcomingBirthday = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "David Cohen", relationship: "Donor", month: 8, day: 15, year: 1985 }] }, NOW, TIMEZONE);
  const birthdayCandidates = generateCandidates(withUpcomingBirthday);
  assert.ok(birthdayCandidates.find((c) => c.kind === "birthday_outreach"), "a birthday inside the lead window must generate birthday_outreach");
  const birthdayWinner = buildDonorRecommendation(withUpcomingBirthday);
  assert.equal(birthdayWinner.kind, "birthday_outreach");
  assert.match(birthdayWinner.action, /David/, "action text must name the celebrant");
  assert.match(birthdayWinner.action, /Aug 15/, "action text must name the date");
  assert.match(birthdayWinner.evidence.join(" "), /turning 41/i, "evidence must state the derived age when the birth year is known");

  const withDistantBirthday = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "David Cohen", relationship: null, month: 1, day: 1, year: null }] }, NOW, TIMEZONE);
  assert.equal(generateCandidates(withDistantBirthday).find((c) => c.kind === "birthday_outreach"), undefined, "a birthday far outside the lead window must not generate a candidate");

  const birthdayPlusUnrelatedReminder = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "David Cohen", relationship: null, month: 8, day: 15, year: null }], openReminder: { action: "Call about something unrelated", reason: "r", dueAt: NOW + 30 * DAY } }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(birthdayPlusUnrelatedReminder).kind, "birthday_outreach", "an unrelated open reminder must not suppress birthday_outreach");

  const withUpcomingAnniversary = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "anniversary", personName: null, relationship: null, month: 8, day: 15, year: 2010 }] }, NOW, TIMEZONE);
  const anniversaryWinner = buildDonorRecommendation(withUpcomingAnniversary);
  assert.equal(anniversaryWinner.kind, "anniversary_outreach");
  assert.match(anniversaryWinner.action, /anniversary/i);
  assert.match(anniversaryWinner.evidence.join(" "), /16 years married/i, "evidence must state the derived years-married when the wedding year is known");

  // Never invents an age/years-married figure when the source year is unknown.
  const birthdayNoYear = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "David Cohen", relationship: null, month: 8, day: 15, year: null }] }, NOW, TIMEZONE);
  const birthdayNoYearWinner = buildDonorRecommendation(birthdayNoYear);
  assert.doesNotMatch(birthdayNoYearWinner.evidence.join(" "), /turning \d/i, "must never invent an age when the birth year is unknown");

  // Wording correctness (design decision #8): the derived age must be
  // computed from the UPCOMING OCCURRENCE's year, not today's calendar
  // year. NOW is 2026-08-12; a birthday on Jan 1 has already passed this
  // year, so its next occurrence is Jan 1 2027 -- someone born in 1990
  // should be described as turning 37 (2027-1990), never 36 (2026-1990).
  const yearBoundaryBirthday = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "New Year Person", relationship: null, month: 1, day: 1, year: 1990 }] }, NOW, TIMEZONE);
  const yearBoundaryCandidate = generateCandidates(yearBoundaryBirthday).find((c) => c.kind === "birthday_outreach");
  assert.equal(yearBoundaryCandidate, undefined, "Jan 1 is far outside the 14-day lead window from Aug 12, so no candidate should exist to check wording on -- confirms the window gate, not the age math, is what's exercised by the in-window cases above");

  // Feb 29 ambiguity flows into the candidate's confidence/evidence, same
  // as yahrtzeit's Adar-leap-year ambiguity.
  const feb29Now = Math.floor(Date.parse("2027-02-20T12:00:00Z") / 1000);
  const feb29Evidence = buildRecommendationEvidence({ ...emptyInput, importantDates: [{ type: "birthday", personName: "Leap Person", relationship: null, month: 2, day: 29, year: null }] }, feb29Now, TIMEZONE);
  const feb29Candidate = generateCandidates(feb29Evidence).find((c) => c.kind === "birthday_outreach");
  assert.equal(feb29Candidate.confidence, "medium", "a Feb 29 birthday landing on the Feb 28 fallback in a non-leap year must be flagged medium confidence, same as an ambiguous yahrtzeit");
  assert.match(feb29Candidate.evidence.join(" "), /isn't a leap year/, "the ambiguity note must be surfaced in the evidence");

  // --- output shape: every winning recommendation has the 5 required fields ---
  for (const evidence of [case1, case2, case3]) {
    const result = buildDonorRecommendation(evidence);
    assert.equal(typeof result.action, "string");
    assert.equal(typeof result.why, "string");
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
    assert.ok(["high", "medium", "low"].includes(result.confidence));
    assert.ok(result.timing === null || typeof result.timing === "string");
  }

  // --- never invents facts: action/evidence text only ever echoes fields
  // that were actually present in the input, never a placeholder like
  // "some campaign" or a guessed amount. ---
  assert.doesNotMatch(JSON.stringify(buildDonorRecommendation(case1)), /some campaign|approximately|around \$|TBD/i);

  // --- cross-surface consistency: the donor page, Meeting Brief,
  // Assistant, and the homepage/Today queue must all resolve a donor's
  // suggested action through this exact same engine -- never a
  // surface-local re-derivation that could disagree with the others.
  // (D1-backed code can't run outside a Workers runtime -- this checks
  // the actual wiring at the source level, matching the convention
  // already established in tests/monday-import-safety.test.mjs.) ---
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
  const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const ruleBased = await readFile(new URL("../lib/ai/rule-based.ts", import.meta.url), "utf8");
  for (const [name, source] of [["donor page", donorPage], ["Meeting Brief", meetingBrief], ["homepage/Today queue", liveData]]) {
    assert.match(source, /buildRecommendationEvidence\(/, `${name} must build evidence through the shared engine`);
    assert.match(source, /buildDonorRecommendation\(/, `${name} must rank through the shared engine`);
  }
  // Assistant reuses Meeting Brief's own loader for the primary donor
  // rather than re-deriving evidence itself -- so it can never diverge
  // from what the Meeting Brief page shows for that same donor.
  assert.match(assistantRoute, /loadMeetingBrief\(/, "Assistant must reuse the Meeting Brief loader for the primary donor, not a separate evidence path");
  // rule-based.ts must format s.donor.recommendation as-is, never
  // reconstruct next-action text from raw recommendations/reasons itself.
  assert.match(ruleBased, /s\.donor\.recommendation/);
  assert.doesNotMatch(ruleBased, /s\.recommendations\[0\]\.action/, "the meeting-brief task must not fall back to re-deriving text from the raw recommendations list");

  // --- yahrtzeit awareness: always available on the donor profile and
  // Meeting Brief, independent of the separate yahrtzeit_outreach
  // candidate's lead window. Meeting Brief/Assistant must feed evidence
  // through the same `yahrtzeits` field, not a parallel path. ---
  const meetingBriefModel = await readFile(new URL("../lib/relationships/meeting-brief-model.ts", import.meta.url), "utf8");
  assert.match(donorPage, /yahrtzeits:/, "the donor page must feed yahrtzeit rows into the shared evidence, not a separate suggestion path");
  assert.match(meetingBrief, /yahrtzeits:/, "Meeting Brief must feed yahrtzeit rows into the shared evidence");
  assert.match(meetingBrief, /familyImportantDates/, "Meeting Brief must expose family important dates unconditionally, separate from the gated recommendation");
  assert.match(meetingBriefModel, /familyImportantDates/, "the MeetingBrief type must carry unconditional relationship-date awareness");
  assert.match(liveData, /yahrtzeits:/, "the homepage/Today queue must feed yahrtzeit rows into the shared evidence");
  assert.match(assistantRoute, /familyImportantDates/, "Assistant must surface family important-date awareness, not just the gated recommendation");
  // Never described as an interaction or implying outreach occurred.
  assert.doesNotMatch(meetingBrief.match(/familyImportantDates[\s\S]{0,400}/)?.[0] ?? "", /INSERT INTO interactions/);

  // --- birthday/anniversary evidence must feed through the exact same
  // shared engine as yahrtzeit -- never a parallel path. ---
  assert.match(donorPage, /importantDates:/, "the donor page must feed important-date rows into the shared evidence");
  assert.match(meetingBrief, /importantDates:/, "Meeting Brief must feed important-date rows into the shared evidence");
  assert.match(liveData, /importantDates:/, "the homepage/Today queue must feed important-date rows into the shared evidence");

  console.log("Recommendation engine checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
