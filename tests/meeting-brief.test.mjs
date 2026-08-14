import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMeetingBrief, familyDateLine } from "../lib/relationships/meeting-brief-model.ts";

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
assert.deepEqual(brief.recentDiscussionTopics, ["Scholarship update", "Impact update"]);
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
assert.match(loader, /donor_id = \? AND owner_user_id = \? AND record_origin = 'live'/);
assert.match(loader, /i\.donor_id = \? AND i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(loader, /r\.donor_id = \? AND r\.user_id = \? AND d\.owner_user_id = \?/);
assert.doesNotMatch(loader, /data_source = 'sample'/);
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
