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
import { YAHRTZEIT_LEAD_WINDOW_DAYS } from "../relationships/recommendation-candidates.ts";

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
  hebrewDateLabel: string;
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

// Only a short, plain word/phrase (letters, spaces, apostrophes, hyphens) is
// safe to turn into possessive display grammar. Free-text relationship
// values that don't match (blank, punctuation-heavy, unexpectedly long) fall
// back to the noun alone -- "Yahrtzeit" rather than a broken phrase -- since
// this is display-only and must never presume to correct or reject the
// stored value itself.
const SAFE_POSSESSIVE_SUBJECT = /^[A-Za-z][A-Za-z '-]*$/;

// Natural possessive phrasing for display only, e.g. possessivePhrase("Mother",
// "yahrtzeit") -> "Mother's yahrtzeit". Never writes back to or normalizes
// the stored relationship value -- callers still pass the raw text through
// unchanged wherever it's needed (audit history, exports, etc.).
export function possessivePhrase(subject: string, noun: string): string {
  const trimmed = subject.trim();
  if (!trimmed || trimmed.length > 24 || !SAFE_POSSESSIVE_SUBJECT.test(trimmed)) return capitalize(noun);
  const normalized = capitalize(trimmed.toLowerCase());
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
    if (daysUntil(occurrence.primary.gregorianEpoch, now) > YAHRTZEIT_LEAD_WINDOW_DAYS) continue;
    events.push({
      id: `yahrtzeit:${row.id}`,
      type: "yahrtzeit",
      donorId: row.donorId,
      donorName: identity.donorName,
      initials: identity.initials,
      donorCode: identity.donorCode,
      label: "Yahrtzeit",
      relationshipPhrase: possessivePhrase(row.relationship, "yahrtzeit"),
      hebrewDateLabel: occurrence.primary.hebrewLabel,
      provenanceName: row.deceasedNameEnglish,
      provenanceNameHebrew: row.deceasedNameHebrew,
      dateLabel: new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000)),
      dateEpoch: occurrence.primary.gregorianEpoch,
      ambiguous: occurrence.ambiguous,
    });
  }
  return events.sort((a, b) => a.dateEpoch - b.dateEpoch);
}
