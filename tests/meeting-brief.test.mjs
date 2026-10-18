import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMeetingBrief, familyDateLine } from "../lib/relationships/meeting-brief-model.ts";
import { nextGregorianRecurrence } from "../lib/calendar/gregorian-recurring-date.ts";
import { nextYahrtzeitOccurrence } from "../lib/calendar/hebrew-date.ts";

const donor = {
  id: "donor-a",
  displayName: "Adler Household",
  donorCode: "JL-100",
  externalId: "JL-100",
  lastName: "Example",
  primaryFirstName: "Ari",
  primaryName: "Ari",
  spouseName: "Miriam",
  email: "adler@example.test",
  phone: "555-1000",
  homePhone: null,
  address: ["10 Cedar Lane"],
};
const brief = buildMeetingBrief(
  donor,
  [
    { id: "gift-old", occurredAt: 1700000000, paidCents: 50000, balanceCents: 0, description: "Annual gift" },
    { id: "gift-recent", occurredAt: 1750000000, paidCents: 25000, balanceCents: 10000, description: "Scholarship fund" },
  ],
  [{ id: "interaction-a", type: "call", occurredAt: 1740000000, summary: "Scholarship outcomes\nDiscussed scholarship outcomes with Maya Cohen and a campus visit." }],
  [{ id: "reminder-a", action: "Send the recorded materials", reason: "Committed during the last call", dueAt: 1760000000 }],
);

assert.equal(brief.donor.id, "donor-a");
assert.equal(brief.lifetimePaidCents, 75000);
assert.equal(brief.recentGift?.id, "gift-recent");
assert.equal(brief.largestGift?.id, "gift-old");
assert.equal(brief.openPledgeCents, 10000);
assert.equal(brief.lastMeaningfulContact?.id, "interaction-a");
// Real quoted fact from the note, not a generic category label -- Meeting
// Brief inherits the same extraction quality gate as the donor page's
// Relationship Snapshot (see specificFacts' doc comment in
// lib/capture/interaction.ts), so "Scholarship update"/"Impact update"
// (coarse category names that told a fundraiser nothing they didn't
// already know) are gone in favor of the actual sentence.
assert.deepEqual(brief.recentDiscussionTopics, ["Discussed scholarship outcomes with Maya Cohen and a campus visit"]);
assert.deepEqual(brief.peopleMentioned, ["Maya Cohen"]);
assert.equal(brief.discussionTopics.length, 3);
assert.equal(brief.followUpActions.length, 3);
assert.match(brief.discussionTopics.map((topic) => topic.detail).join(" "), /Scholarship fund/);
assert.doesNotMatch(JSON.stringify(brief), /hobby|interest|favorite|ask amount/i);

const empty = buildMeetingBrief(donor, [], [], []);
assert.equal(empty.recentGift, null);
assert.equal(empty.lastMeaningfulContact, null);
assert.equal(empty.discussionTopics.length, 3);
assert.match(empty.discussionTopics[0].detail, /No paid giving is recorded/);
assert.match(empty.discussionTopics[1].detail, /No prior interaction is recorded/);
assert.match(empty.discussionTopics[2].detail, /No open reminder or pledge commitment is recorded/);

const loader = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/donors/[id]/meeting-brief/page.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");

assert.match(loader, /WHERE id = \? AND owner_user_id = \? AND data_source = 'live'/);
// Manual Pledge Balance Corrections (2026-10-09, see docs/AI-HANDOFF.md)
// aliased giving_activities as `ga` and added a LEFT JOIN to apply the
// effective-balance rule -- the donor/owner scoping itself is unchanged.
assert.match(loader, /ga\.donor_id = \? AND ga\.owner_user_id = \? AND ga\.record_origin = 'live'/);
assert.match(loader, /LEFT JOIN pledge_balance_corrections pbc ON pbc\.pledge_activity_id = ga\.id AND pbc\.reversed_at IS NULL/);
assert.match(loader, /COALESCE\(pbc\.corrected_balance_cents, ga\.balance_cents\) AS balance_cents/);
assert.match(loader, /i\.donor_id = \? AND i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(loader, /r\.donor_id = \? AND r\.user_id = \? AND d\.owner_user_id = \?/);
assert.doesNotMatch(loader, /data_source = 'sample'/);

// --- Date-only occurrence formatting (2026-10-18 fix): birthday/anniversary/
// yahrtzeit nextOccurrence epochs are date-only values at UTC midnight (see
// gregorian-recurring-date.ts/hebrew-date.ts's own "Date-only epoch seconds,
// UTC midnight" doc comments), never a real timestamp. Formatting them with
// the fundraiser's own timezone (like `dateLabel`, used for real timestamps
// such as historical-context source dates) shifts the displayed day
// backward for any fundraiser west of UTC -- the exact bug reported live
// ("Dovid's Birthday: Feb 15; next occurrence Feb 14, 2027" in
// America/New_York). The loader must format these three occurrence types
// with a UTC-pinned label, matching ImportantDatesManagement.tsx's
// established convention, never the timezone-aware `dateLabel`. ---
const occurrenceLabelFn = loader.match(/const occurrenceDateLabel = \(epoch: number\) => new Intl\.DateTimeFormat\("en-US", \{([^}]+)\}\)/);
assert.ok(occurrenceLabelFn, "meeting-brief.ts must define a dedicated occurrence-date formatter");
assert.match(occurrenceLabelFn[1], /timeZone:\s*"UTC"/, "the occurrence-date formatter must be pinned to UTC, never the fundraiser's own timezone");
assert.match(loader, /shortLabel: occurrence\.primary\.hebrewLabel,\s*\n\s*nextOccurrenceLabel: occurrenceDateLabel\(occurrence\.primary\.gregorianEpoch\)/, "yahrtzeit nextOccurrenceLabel must use the UTC-pinned occurrenceDateLabel");
assert.match(loader, /shortLabel: occurrence\.primary\.label,\s*\n\s*nextOccurrenceLabel: occurrenceDateLabel\(occurrence\.primary\.gregorianEpoch\)/, "birthday/anniversary nextOccurrenceLabel must use the UTC-pinned occurrenceDateLabel");
// dateLabel (timezone-aware) must still be used only for real timestamps
// (historical-context source dates), never reused for an occurrence epoch.
assert.doesNotMatch(loader, /nextOccurrenceLabel: dateLabel\(/, "nextOccurrenceLabel must never be formatted with the timezone-aware dateLabel");

// The exact formatter meeting-brief.ts now uses (UTC-pinned month/day/year),
// run against the real recurrence functions, must reproduce the donor page's
// ImportantDatesManagement.tsx reading of the same recorded date -- proving
// agreement between the two surfaces, not just independent correctness.
const occurrenceDateLabel = (epoch) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));
const donorPageOccurrenceLabel = (epoch) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(epoch * 1000));
// The buggy formatter the loader used to apply, kept here only to prove the
// regression fixture actually exercises the bug (i.e. the two formatters
// really do disagree for these fixtures, not that the test is vacuous).
const buggyTimezoneShiftedLabel = (epoch, timezone) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
// Only a timezone BEHIND UTC can shift a UTC-midnight date-only epoch
// backward to the previous calendar day -- a zone ahead of UTC (e.g.
// Asia/Jerusalem) displays the same day, just later in it, so it is
// included above for the agreement checks but excluded from the
// disagreement sanity checks below.
const WEST_OF_UTC = new Set(["America/New_York", "America/Los_Angeles"]);

for (const timezone of ["America/New_York", "America/Los_Angeles", "UTC", "Asia/Jerusalem"]) {
  // Birthday: reproduces the reported Feb 15 -> "Feb 14" regression.
  {
    const now = Math.floor(Date.parse("2026-10-18T00:00:00Z") / 1000);
    const occurrence = nextGregorianRecurrence(2, 15, timezone, now);
    const fixed = occurrenceDateLabel(occurrence.primary.gregorianEpoch);
    assert.equal(fixed, "Feb 15, 2027", `birthday occurrence must read Feb 15 regardless of fundraiser timezone (${timezone})`);
    assert.equal(fixed, donorPageOccurrenceLabel(occurrence.primary.gregorianEpoch), `Meeting Prep's birthday label must agree with the donor page's (${timezone})`);
    if (WEST_OF_UTC.has(timezone)) {
      assert.notEqual(buggyTimezoneShiftedLabel(occurrence.primary.gregorianEpoch, timezone), fixed, `sanity: the pre-fix timezone-shifted formatter must actually disagree for a west-of-UTC zone (${timezone}), or this fixture proves nothing`);
    }
  }
  // Anniversary, and a year-boundary case: a UTC-midnight Jan 1 epoch, which
  // a west-of-UTC zone (e.g. America/New_York, UTC-5) shifts back into Dec
  // 31 of the PRIOR year -- the most severe form of this bug class, since it
  // corrupts the year as well as the day.
  {
    const now = Math.floor(Date.parse("2026-12-20T00:00:00Z") / 1000);
    const occurrence = nextGregorianRecurrence(1, 1, timezone, now);
    const fixed = occurrenceDateLabel(occurrence.primary.gregorianEpoch);
    assert.equal(fixed, "Jan 1, 2027", `year-boundary anniversary occurrence must read Jan 1, 2027, never Dec 31, 2026 (${timezone})`);
    assert.equal(fixed, donorPageOccurrenceLabel(occurrence.primary.gregorianEpoch), `Meeting Prep's year-boundary label must agree with the donor page's (${timezone})`);
  }
  // Yahrtzeit: same UTC-midnight date-only convention (hebrew-date.ts), same
  // potential day/year shift.
  {
    const now = Math.floor(Date.parse("2026-10-18T00:00:00Z") / 1000);
    const occurrence = nextYahrtzeitOccurrence("Shevat", 1, timezone, now);
    const fixed = occurrenceDateLabel(occurrence.primary.gregorianEpoch);
    assert.equal(fixed, donorPageOccurrenceLabel(occurrence.primary.gregorianEpoch), `Meeting Prep's yahrtzeit label must agree with the donor page's (${timezone})`);
    if (WEST_OF_UTC.has(timezone)) {
      assert.notEqual(buggyTimezoneShiftedLabel(occurrence.primary.gregorianEpoch, timezone), fixed, `sanity: the pre-fix timezone-shifted formatter must actually disagree for yahrtzeit in a west-of-UTC zone (${timezone}), or this fixture proves nothing`);
    }
  }
}

assert.match(page, /Log Meeting Outcome/);
assert.match(page, /type=meeting/);
for (const section of ["SUGGESTED ACTION", "LAST INTERACTION", "RECENT DISCUSSION TOPICS", "OPEN COMMITMENTS", "LAST GIFT", "PEOPLE MENTIONED", "SUGGESTED PREPARATION"]) assert.match(page, new RegExp(section));
// "confidence" is deliberately allowed here (unlike the other internal-
// jargon terms below) -- it's one of the five required Suggested Action
// fields (action/why/evidence/confidence/timing), not implementation detail.
assert.doesNotMatch(page, /LIVE DATA|authenticated relationship record|data-backed|implementation|classification/i);
assert.match(donorPage, /Prepare for Meeting/);
assert.match(today, /activity\.prepareHref/);
assert.match(today, />Prepare</);
assert.match(capturePage, /allowedKinds\.has\(requestedParams\.type/);

// --- familyImportantDates: one unified collection, type-specific fields
// preserved (Hebrew date, deceased name, relationship, ambiguity), never
// implying outreach already occurred. ---
const yahrtzeitLine = familyDateLine({ type: "yahrtzeit", deceasedNameEnglish: "Sarah Cohen", deceasedNameHebrew: "שרה", personName: null, relationship: "Mother", shortLabel: "5 Elul", nextOccurrenceLabel: "Aug 18, 2026", ambiguous: false, ambiguityNote: null });
assert.equal(yahrtzeitLine, "Mother's yahrtzeit is 5 Elul; next occurrence Aug 18, 2026.");
const birthdayLine = familyDateLine({ type: "birthday", deceasedNameEnglish: null, deceasedNameHebrew: null, personName: "David Cohen", relationship: "Donor", shortLabel: "Aug 24", nextOccurrenceLabel: "Aug 24, 2026", ambiguous: false, ambiguityNote: null });
assert.equal(birthdayLine, "David Cohen's Birthday: Aug 24; next occurrence Aug 24, 2026.");
const anniversaryLine = familyDateLine({ type: "anniversary", deceasedNameEnglish: null, deceasedNameHebrew: null, personName: null, relationship: null, shortLabel: "Jun 12", nextOccurrenceLabel: "Jun 12, 2027", ambiguous: false, ambiguityNote: null });
assert.equal(anniversaryLine, "Wedding anniversary: Jun 12; next occurrence Jun 12, 2027.");
// Never describes an upcoming date as if outreach already happened.
for (const line of [yahrtzeitLine, birthdayLine, anniversaryLine]) assert.doesNotMatch(line, /\b(sent|reached out|contacted|called|wished)\b/i);
// Ambiguity note (Feb 29 fallback / Adar leap year) is surfaced, never hidden.
const ambiguousBirthdayLine = familyDateLine({ type: "birthday", deceasedNameEnglish: null, deceasedNameHebrew: null, personName: "Leap Person", relationship: null, shortLabel: "Feb 28", nextOccurrenceLabel: "Feb 28, 2027", ambiguous: true, ambiguityNote: "Recorded as Feb 29; 2027 isn't a leap year, so Feb 28 is shown." });
assert.match(ambiguousBirthdayLine, /isn't a leap year/);

// familyImportantDates passes through buildMeetingBrief unchanged, holding
// a mix of all three types with type-specific fields intact.
const mixedDates = [
  { type: "yahrtzeit", deceasedNameEnglish: "Sarah Cohen", deceasedNameHebrew: "שרה", personName: null, relationship: "Mother", shortLabel: "5 Elul", nextOccurrenceLabel: "Aug 18, 2026", ambiguous: false, ambiguityNote: null },
  { type: "birthday", deceasedNameEnglish: null, deceasedNameHebrew: null, personName: "David Cohen", relationship: "Donor", shortLabel: "Aug 24", nextOccurrenceLabel: "Aug 24, 2026", ambiguous: false, ambiguityNote: null },
  { type: "anniversary", deceasedNameEnglish: null, deceasedNameHebrew: null, personName: null, relationship: null, shortLabel: "Jun 12", nextOccurrenceLabel: "Jun 12, 2027", ambiguous: false, ambiguityNote: null },
];
const briefWithDates = buildMeetingBrief(donor, [], [], [], [], 0, null, mixedDates);
assert.equal(briefWithDates.familyImportantDates.length, 3);
assert.deepEqual(briefWithDates.familyImportantDates, mixedDates, "familyImportantDates must pass through unchanged -- yahrtzeit-specific fields (Hebrew date, deceased name) must survive alongside birthday/anniversary entries");

process.stdout.write("Meeting brief checks passed.\n");
