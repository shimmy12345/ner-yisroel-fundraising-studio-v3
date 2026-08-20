// Date-driven relationship events for the homepage "Coming Up" section --
// deliberately independent of the canonical recommendation engine's
// ranking. A donor's upcoming yahrtzeit belongs here unconditionally, the
// moment it's inside its own lead window, regardless of whether it would
// win that donor's overall Suggested Action against a gift acknowledgment,
// pledge follow-up, or contact-gap candidate. The recommendation engine
// still computes yahrtzeit_outreach as a candidate (donor profile/Meeting
// Brief/Assistant still use it) -- this module is a second, unrelated
// consumer of the same underlying fact (a yahrtzeit inside its window),
// not a replacement for that candidate.
//
// The type is intentionally generic (RelationshipDateEventType, not just
// "yahrtzeit") so a future birthday/anniversary source can add its own
// builder function and merge into the same WorkspaceRelationshipDateEvent
// list Coming Up already renders, without another homepage architecture
// change -- see buildYahrtzeitRelationshipDateEvents below for the shape
// a birthday/anniversary builder would follow.
//
// Pure -- no D1 access, no write of any kind. Read-only by construction:
// there is nothing in this file that could create or mutate a reminder,
// recommendation, or interaction merely by a donor's yahrtzeit appearing
// here.

import { nextYahrtzeitOccurrence, type HebrewMonthName } from "../calendar/hebrew-date.ts";
import { nextGregorianRecurrence, yearsSinceForOccurrence } from "../calendar/gregorian-recurring-date.ts";
import { RELATIONSHIP_DATE_LEAD_WINDOW_DAYS } from "../relationships/recommendation-candidates.ts";
import type { ImportantDateType } from "../important-dates/validation.ts";
import { localDateOnlyEpoch } from "./local-time.ts";

export type RelationshipDateEventType = "yahrtzeit" | "birthday" | "anniversary";

// Fields are kept granular (rather than one concatenated "detail" string) so
// the compact Coming Up row can give each piece of information -- donor,
// relationship, deceased name, Hebrew date -- its own visual weight instead
// of flattening them into a single paragraph. A future birthday/anniversary
// builder would populate the same shape (relationshipPhrase e.g. "Mother's
// birthday", provenanceName left null when there's nothing analogous to a
// deceased name).
export type WorkspaceRelationshipDateEvent = {
  id: string;
  type: RelationshipDateEventType;
  donorId: string;
  donorName: string;
  initials: string;
  donorCode: string | null;
  label: string;
  relationshipPhrase: string;
  // Yahrtzeit's Hebrew date ("5 Elul") -- the only relationship-date type
  // with a second calendar system alongside the Gregorian one. Birthday/
  // anniversary have nothing to put here UNLESS a source year is known, in
  // which case it carries a display-only derived count ("Turning 45",
  // "25 years married") computed fresh from the occurrence's own year (see
  // lib/calendar/gregorian-recurring-date.ts) -- never stored. Null when
  // neither applies.
  secondaryDateLabel: string | null;
  provenanceName: string | null;
  provenanceNameHebrew: string | null;
  dateLabel: string;
  dateEpoch: number;
  ambiguous: boolean;
};

export type YahrtzeitEventRow = {
  id: string;
  donorId: string;
  deceasedNameEnglish: string;
  deceasedNameHebrew: string | null;
  relationship: string;
  hebrewMonth: HebrewMonthName;
  hebrewDay: number;
};

export type DonorIdentityForEvent = { donorName: string; initials: string; donorCode: string | null };

function daysUntil(laterEpoch: number, earlierEpoch: number): number {
  return Math.max(0, Math.floor((laterEpoch - earlierEpoch) / 86400));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Capitalizes each space-separated word (not just the string's first
// character) so a full person name ("David Cohen") displays correctly, not
// just a single relationship word ("Mother") -- both are valid subjects for
// possessivePhrase below.
function titleCaseWords(text: string): string {
  return text.split(" ").map(capitalize).join(" ");
}

// Only a plain word/phrase (letters, spaces, apostrophes, hyphens) is safe
// to turn into possessive display grammar. Free-text values that don't
// match (blank, punctuation-heavy, absurdly long) fall back to the noun
// alone -- "Yahrtzeit"/"Birthday" rather than a broken phrase -- since this
// is display-only and must never presume to correct or reject the stored
// value itself. The length cap is generous enough for a real full person
// name (birthday's personName), not just a short relationship word.
const SAFE_POSSESSIVE_SUBJECT = /^[A-Za-z][A-Za-z '-]*$/;
const MAX_POSSESSIVE_SUBJECT_LENGTH = 60;

// Natural possessive phrasing for display only, e.g. possessivePhrase("Mother",
// "yahrtzeit") -> "Mother's yahrtzeit", or possessivePhrase("David Cohen",
// "birthday") -> "David Cohen's birthday". Never writes back to or
// normalizes the stored relationship/name value -- callers still pass the
// raw text through unchanged wherever it's needed (audit history, exports,
// etc.).
export function possessivePhrase(subject: string, noun: string): string {
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > MAX_POSSESSIVE_SUBJECT_LENGTH || !SAFE_POSSESSIVE_SUBJECT.test(trimmed)) return capitalize(noun);
  const normalized = titleCaseWords(trimmed.toLowerCase());
  const possessive = normalized.endsWith("s") ? `${normalized}'` : `${normalized}'s`;
  return `${possessive} ${noun}`;
}

// Donors without an identity in identityByDonor (e.g. archived, or a data
// inconsistency) are silently skipped rather than surfaced with missing
// fields -- Coming Up never shows a card it can't fully populate.
export function buildYahrtzeitRelationshipDateEvents(
  rows: YahrtzeitEventRow[],
  identityByDonor: Map<string, DonorIdentityForEvent>,
  timezone: string,
  now: number,
): WorkspaceRelationshipDateEvent[] {
  const events: WorkspaceRelationshipDateEvent[] = [];
  for (const row of rows) {
    const identity = identityByDonor.get(row.donorId);
    if (!identity) continue;
    const occurrence = nextYahrtzeitOccurrence(row.hebrewMonth, row.hebrewDay, timezone, now);
    if (daysUntil(occurrence.primary.gregorianEpoch, now) > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) continue;
    events.push({
      id: `yahrtzeit:${row.id}`,
      type: "yahrtzeit",
      donorId: row.donorId,
      donorName: identity.donorName,
      initials: identity.initials,
      donorCode: identity.donorCode,
      label: "Yahrtzeit",
      relationshipPhrase: possessivePhrase(row.relationship, "yahrtzeit"),
      secondaryDateLabel: occurrence.primary.hebrewLabel,
      provenanceName: row.deceasedNameEnglish,
      provenanceNameHebrew: row.deceasedNameHebrew,
      dateLabel: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000)),
      dateEpoch: occurrence.primary.gregorianEpoch,
      ambiguous: occurrence.ambiguous,
    });
  }
  return events.sort((a, b) => a.dateEpoch - b.dateEpoch);
}

export type ImportantDateEventRow = {
  id: string;
  donorId: string;
  type: ImportantDateType;
  personName: string | null;
  relationship: string | null;
  month: number;
  day: number;
  year: number | null;
};

// Birthday/Anniversary builder -- the same generic shape as
// buildYahrtzeitRelationshipDateEvents above, so Coming Up renders both
// through the exact same RelationshipDateEventRow with no per-type
// branching. provenanceName is deliberately left null for both: the
// celebrant/household is already named in relationshipPhrase ("Shimmy's
// birthday" / "Wedding anniversary"), so a second "who this is about" line
// would only repeat it -- unlike yahrtzeit, where the deceased's name is
// genuinely separate information from the relationship label.
export function buildImportantDateRelationshipEvents(
  rows: ImportantDateEventRow[],
  identityByDonor: Map<string, DonorIdentityForEvent>,
  timezone: string,
  now: number,
): WorkspaceRelationshipDateEvent[] {
  const events: WorkspaceRelationshipDateEvent[] = [];
  for (const row of rows) {
    const identity = identityByDonor.get(row.donorId);
    if (!identity) continue;
    const occurrence = nextGregorianRecurrence(row.month, row.day, timezone, now);
    if (daysUntil(occurrence.primary.gregorianEpoch, now) > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) continue;
    const isBirthday = row.type === "birthday";
    const derivedYears = row.year !== null ? yearsSinceForOccurrence(occurrence.primary.year, row.year) : null;
    events.push({
      id: `important-date:${row.id}`,
      type: row.type,
      donorId: row.donorId,
      donorName: identity.donorName,
      initials: identity.initials,
      donorCode: identity.donorCode,
      label: isBirthday ? "Birthday" : "Anniversary",
      relationshipPhrase: isBirthday ? possessivePhrase(row.personName ?? "", "birthday") : "Wedding anniversary",
      secondaryDateLabel: derivedYears === null ? null : isBirthday ? `Turning ${derivedYears}` : `${derivedYears} year${derivedYears === 1 ? "" : "s"} married`,
      provenanceName: null,
      provenanceNameHebrew: null,
      dateLabel: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000)),
      dateEpoch: occurrence.primary.gregorianEpoch,
      ambiguous: occurrence.ambiguous,
    });
  }
  return events.sort((a, b) => a.dateEpoch - b.dateEpoch);
}

// Splits a combined, sorted relationship-date-event list (yahrtzeits +
// important dates, as live-data.ts builds it) into "today" and "upcoming"
// buckets, so a same-day birthday/yahrtzeit/anniversary belongs in Today's
// Agenda rather than only Coming Up. Every event that qualified for the
// lead window in the first place lands in exactly one of the two returned
// lists -- nothing is dropped, nothing is duplicated.
//
// Compares each event's own dateEpoch against localDateOnlyEpoch(now,
// timezone) by EXACT equality, deliberately not dayKey(event.dateEpoch,
// timezone)/localDayKey(...): an event's dateEpoch is already a date-only,
// UTC-midnight-of-the-intended-LOCAL-date value (the same convention
// nextGregorianRecurrence/nextYahrtzeitOccurrence use internally to decide
// "today" when computing it) -- re-running it through a timezone-aware
// day-key function a second time would apply the timezone offset twice,
// silently shifting a real same-day event into the wrong bucket in any
// timezone behind UTC. localDateOnlyEpoch is the one correct way to
// compute "today" in that same date-only space, matching exactly how the
// occurrence itself decided it was today in the first place.
export function partitionRelationshipDateEventsByToday(
  events: WorkspaceRelationshipDateEvent[],
  now: number,
  timezone: string,
): { today: WorkspaceRelationshipDateEvent[]; upcoming: WorkspaceRelationshipDateEvent[] } {
  const todayEpoch = localDateOnlyEpoch(now, timezone);
  return {
    today: events.filter((event) => event.dateEpoch === todayEpoch),
    upcoming: events.filter((event) => event.dateEpoch !== todayEpoch),
  };
}
