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

export type RelationshipDateEventType = "yahrtzeit" | "birthday" | "anniversary" | "payment_plan_milestone" | "pledge_renewal" | "recurring_payment_behind";

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

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export type PaymentPlanMilestoneRow = {
  donorId: string;
  pledgeActivityId: string;
  balanceCents: number;
  finalExpectedPaymentAt: number;
  milestoneDaysBefore: 15 | 10 | 5;
};

// Payment-plan milestones -- deliberately NOT built the same way
// yahrtzeit/important-date events are (a lead-window countdown shown
// every day it's inside the window). A milestone is a single, discrete
// day (15/10/5 days before a plan's own final expected date, computed by
// evaluatePaymentPlan -- never re-derived here), so the event is only
// ever constructed AT ALL on that exact day; there is no window to
// filter. `dateEpoch` (used only for today-vs-upcoming bucketing, never
// rendered directly -- see app/page.tsx's RelationshipDateEventRow) is
// set to TODAY so the row always lands in Coming Up's "today" bucket via
// partitionRelationshipDateEventsByToday below, exactly like a same-day
// yahrtzeit. `dateLabel` (the prominent, actually-RENDERED date column)
// is instead the plan's real final expected date -- what this row is
// actually about. This is also why no Agenda post-filter change was
// needed: lib/agenda/agenda-model.ts's IMPORTANT DATES/STEWARDSHIP
// section already includes the full "today" bucket unconditionally.
export function buildPaymentPlanMilestoneEvents(
  rows: PaymentPlanMilestoneRow[],
  identityByDonor: Map<string, DonorIdentityForEvent>,
  timezone: string,
  now: number,
): WorkspaceRelationshipDateEvent[] {
  const todayEpoch = localDateOnlyEpoch(now, timezone);
  const events: WorkspaceRelationshipDateEvent[] = [];
  for (const row of rows) {
    const identity = identityByDonor.get(row.donorId);
    if (!identity) continue;
    events.push({
      id: `payment-plan-milestone:${row.pledgeActivityId}`,
      type: "payment_plan_milestone",
      donorId: row.donorId,
      donorName: identity.donorName,
      initials: identity.initials,
      donorCode: identity.donorCode,
      label: "Payment plan",
      relationshipPhrase: `Payment plan ending in ${row.milestoneDaysBefore} days`,
      secondaryDateLabel: `${money(row.balanceCents)} remaining`,
      provenanceName: null,
      provenanceNameHebrew: null,
      // The prominently-rendered date column (app/page.tsx's
      // RelationshipDateEventRow) -- the plan's real final expected date,
      // never `dateEpoch` (which is today, for bucketing only -- see the
      // function's own header comment).
      dateLabel: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(row.finalExpectedPaymentAt * 1000)),
      dateEpoch: todayEpoch,
      ambiguous: false,
    });
  }
  return events.sort((a, b) => a.donorName.localeCompare(b.donorName));
}

export type PledgeRenewalReminderRow = {
  donorId: string;
  planId: string;
  pledgeActivityId: string;
  originalPledgeDate: number;
  commitmentDurationMonths: number;
  originalPledgeAmountCents: number;
  balanceCents: number;
  campaign: string | null;
  renewalDate: number;
  fiveDayReminderDate: number;
  // Renewal Follow-Up (2026-10-09, see docs/AI-HANDOFF.md) -- already
  // computed once by evaluatePledgeRenewal, never re-derived here.
  isRenewalFollowUpNeeded: boolean;
};

// Pledge renewal reminders (2026-10-08, extended 2026-10-08 to appear in
// Coming Up before their trigger date; corrected 2026-10-08 to require a
// verified COMMITMENT DURATION rather than assuming every commitment
// lasts 12 months -- see docs/AI-HANDOFF.md). "Annual" was dropped from
// every name/label here (type, id prefix, phrase text) once duration
// became a real, variable, fundraiser-verified fact -- a 6-month or
// 18-month commitment is never "annual."
//
// UNLIKE buildPaymentPlanMilestoneEvents above (which has no lead window
// at all -- a milestone is only ever constructed on its exact firing
// day), this builder follows the SAME lead-window pattern
// buildYahrtzeitRelationshipDateEvents/buildImportantDateRelationshipEvents
// use: each row carries BOTH of the plan's fixed stage dates
// (fiveDayReminderDate, renewalDate -- both already computed once by
// lib/relationships/pledge-payment-plan.ts's evaluatePledgeRenewal, never
// re-derived here), and this function independently checks each stage's
// own date against `daysUntil(...) <= RELATIONSHIP_DATE_LEAD_WINDOW_DAYS`
// (and not already in the past), emitting 0, 1, or 2 events per row
// depending on which stage(s) currently fall inside the window. A stage
// whose date is today gets `dateEpoch` equal to today, so
// partitionRelationshipDateEventsByToday's exact-equality check correctly
// routes it to the "today" bucket (Today/Daily Agenda); a stage still
// days away gets its own real future `dateEpoch`, so it lands in
// "upcoming" (Coming Up) instead -- never both, since a WorkspaceRelationshipDateEvent
// can only belong to one of the two partitioned lists its own dateEpoch
// determines. The two stages' ids (`:approaching`/`:renewal`) never
// collide, so both can legitimately appear at once (e.g. "approaching"
// in Today while "renewal" is still a few days out in Coming Up) -- that
// is two distinct real events about the same plan, not a duplicate of
// one event.
//
// `dateLabel` is always the renewal date itself -- what the fundraiser
// is preparing for or acting on -- for BOTH stages, matching
// buildPaymentPlanMilestoneEvents' own precedent of showing the target
// date being counted down to rather than the reminder's own firing date,
// with "approaching" vs. "opportunity" distinguished by
// `relationshipPhrase` alone. `dateEpoch` is the one place the two
// stages actually differ, since it alone drives windowing/bucketing/sort
// order, never what's rendered.
//
// `relationshipPhrase` carries the exact required title text verbatim
// ("Pledge renewal approaching" / "Pledge renewal opportunity") -- both
// titles ARE the suggested fundraising action (prepare vs. contact the
// donor), matching how every other event type in this file folds its
// action into the phrase rather than a separate field.
// `secondaryDateLabel` packs the original pledge amount, campaign (when
// known), verified commitment duration, and current outstanding balance
// into one line -- the same compact-row convention
// buildPaymentPlanMilestoneEvents already uses for balance alone.
// Relevant newer pledges are deliberately NOT included here -- that
// context is per-donor and best shown with full giving-history context
// on the donor page itself (app/donors/[id]/page.tsx), not crammed into
// this one-line compact row.
export function buildPledgeRenewalReminderEvents(
  rows: PledgeRenewalReminderRow[],
  identityByDonor: Map<string, DonorIdentityForEvent>,
  timezone: string,
  now: number,
): WorkspaceRelationshipDateEvent[] {
  const todayEpoch = localDateOnlyEpoch(now, timezone);
  const events: WorkspaceRelationshipDateEvent[] = [];
  for (const row of rows) {
    const identity = identityByDonor.get(row.donorId);
    if (!identity) continue;
    const campaignLabel = row.campaign ? ` (${row.campaign})` : "";
    const secondaryDateLabel = `${money(row.originalPledgeAmountCents)} pledged${campaignLabel} · ${row.commitmentDurationMonths}-month commitment · ${money(row.balanceCents)} balance remaining`;
    const renewalLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(row.renewalDate * 1000));
    const stages: Array<{ stage: "approaching" | "renewal"; date: number; phrase: string }> = [
      { stage: "approaching", date: row.fiveDayReminderDate, phrase: "Pledge renewal approaching" },
      { stage: "renewal", date: row.renewalDate, phrase: "Pledge renewal opportunity" },
    ];
    for (const { stage, date, phrase } of stages) {
      if (date < todayEpoch) continue;
      if (daysUntil(date, todayEpoch) > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) continue;
      events.push({
        id: `pledge-renewal:${row.planId}:${stage}`,
        type: "pledge_renewal",
        donorId: row.donorId,
        donorName: identity.donorName,
        initials: identity.initials,
        donorCode: identity.donorCode,
        label: "Pledge renewal",
        relationshipPhrase: phrase,
        secondaryDateLabel,
        provenanceName: null,
        provenanceNameHebrew: null,
        dateLabel: renewalLabel,
        dateEpoch: date,
        ambiguous: false,
      });
    }
    // Renewal Follow-Up (2026-10-09, see docs/AI-HANDOFF.md's Spetner
    // (2689) investigation) -- deliberately NOT part of the `stages`
    // loop above: unlike "approaching"/"renewal" (each a one-day pulse,
    // bounded by RELATIONSHIP_DATE_LEAD_WINDOW_DAYS, dateEpoch = its own
    // fixed trigger date), this is a STANDING need with no upper bound
    // and no fixed trigger date of its own -- dateEpoch is deliberately
    // set to `todayEpoch` (not row.renewalDate, which is now in the
    // past) so partitionRelationshipDateEventsByToday's exact-equality
    // check always routes it to the "today" bucket, every single day it
    // remains true, rather than "upcoming" (where a past date would
    // never belong) or nowhere at all. Mutually exclusive with the
    // "renewal" stage above by construction (isRenewalFollowUpNeeded is
    // only ever true the day AFTER renewalDate, never on it), so this
    // never duplicates that one-day event.
    if (row.isRenewalFollowUpNeeded) {
      events.push({
        id: `pledge-renewal:${row.planId}:follow_up`,
        type: "pledge_renewal",
        donorId: row.donorId,
        donorName: identity.donorName,
        initials: identity.initials,
        donorCode: identity.donorCode,
        label: "Pledge renewal",
        relationshipPhrase: "Renewal follow-up needed",
        secondaryDateLabel,
        provenanceName: null,
        provenanceNameHebrew: null,
        dateLabel: renewalLabel,
        dateEpoch: todayEpoch,
        ambiguous: false,
      });
    }
  }
  return events.sort((a, b) => a.dateEpoch - b.dateEpoch || a.donorName.localeCompare(b.donorName));
}

export type RecurringPaymentAlertStatus = "verify_import" | "follow_up_needed";

const RECURRING_PAYMENT_ALERT_PHRASES: Record<RecurringPaymentAlertStatus, string> = {
  verify_import: "Verify latest payment import",
  follow_up_needed: "Payment follow-up needed",
};

export type RecurringPaymentAlertRow = {
  donorId: string;
  planId: string;
  status: RecurringPaymentAlertStatus;
  expectedPaymentAt: number;
  expectedAmountCents: number | null;
  daysBehind: number;
};

// Recurring Payments Behind Schedule (2026-10-09, see docs/AI-HANDOFF.md).
// Built the SAME way as buildPaymentPlanMilestoneEvents above -- a
// standing condition, not a lead-window countdown, so `dateEpoch` is
// pinned to TODAY (always lands in the "today" bucket via
// partitionRelationshipDateEventsByToday below, every day it remains
// true -- no upper bound, since this is the status quo until the
// underlying payment is recorded/reconciled, not a date to count down
// to) while `dateLabel` shows the plan's own real expected-payment date
// for context. One row per plan (rows are already pre-filtered to "this
// plan currently needs an alert" by the caller, via
// evaluateRecurringPaymentAlert -- never recomputed here), so `id` is
// keyed on `planId` alone and can structurally never duplicate.
//
// Deliberately only two statuses are ever rendered here
// ("verify_import"/"follow_up_needed") -- "Payment declined -- contact
// donor" is reserved for the day a real, imported decline signal exists
// (see evaluateRecurringPaymentAlert's own doc comment: no such signal
// exists in this app's data today), and nothing in this function invents
// one.
export function buildRecurringPaymentAlertEvents(
  rows: RecurringPaymentAlertRow[],
  identityByDonor: Map<string, DonorIdentityForEvent>,
  timezone: string,
  now: number,
): WorkspaceRelationshipDateEvent[] {
  const todayEpoch = localDateOnlyEpoch(now, timezone);
  const events: WorkspaceRelationshipDateEvent[] = [];
  for (const row of rows) {
    const identity = identityByDonor.get(row.donorId);
    if (!identity) continue;
    const amountLabel = row.expectedAmountCents !== null ? `${money(row.expectedAmountCents)} expected` : "Amount not set";
    events.push({
      id: `recurring-payment:${row.planId}`,
      type: "recurring_payment_behind",
      donorId: row.donorId,
      donorName: identity.donorName,
      initials: identity.initials,
      donorCode: identity.donorCode,
      label: "Recurring payment",
      relationshipPhrase: RECURRING_PAYMENT_ALERT_PHRASES[row.status],
      secondaryDateLabel: `${amountLabel} · ${row.daysBehind} day${row.daysBehind === 1 ? "" : "s"} behind`,
      provenanceName: null,
      provenanceNameHebrew: null,
      dateLabel: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(row.expectedPaymentAt * 1000)),
      dateEpoch: todayEpoch,
      ambiguous: false,
    });
  }
  return events.sort((a, b) => a.donorName.localeCompare(b.donorName));
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
