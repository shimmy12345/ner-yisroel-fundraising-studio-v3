import assert from "node:assert/strict";
import { resolveDueDatePhrase } from "../lib/meeting-notes/due-date-resolver.ts";

// Meeting date used throughout: Thursday, 2026-10-15.
const MEETING_DATE = "2026-10-15";

// --- No due-date language at all ---

assert.deepEqual(resolveDueDatePhrase(null, MEETING_DATE), { kind: "none" });
assert.deepEqual(resolveDueDatePhrase(undefined, MEETING_DATE), { kind: "none" });
assert.deepEqual(resolveDueDatePhrase("", MEETING_DATE), { kind: "none" });
assert.deepEqual(resolveDueDatePhrase("   ", MEETING_DATE), { kind: "none" });

// --- Relative dates that CAN be resolved reliably ---

{
  const r = resolveDueDatePhrase("tomorrow", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-16");
  assert.equal(r.phrase, "tomorrow");
}
{
  const r = resolveDueDatePhrase("Tomorrow morning", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-16", "case-insensitive and tolerant of surrounding words");
}
{
  const r = resolveDueDatePhrase("next Monday", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19", "the next Monday strictly after the meeting date (Thursday)");
}
{
  // "next Monday" said ON a Monday must mean next week's Monday, not today.
  const r = resolveDueDatePhrase("next monday", "2026-10-19");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-26");
}

// --- "this <weekday>" / "on <weekday>" / bare "<weekday>" -- Production
// root-cause round (docs/AI-HANDOFF.md, "Fix Production AI Meeting Notes
// Follow-Up Scheduling"). Confirmed live that Workers AI returns these
// phrasings verbatim ("this Monday", "this Friday") or paraphrased down to
// a bare weekday ("on Monday" -> "Monday") -- none of which the resolver
// recognized before this round, so the date field silently stayed empty.
// Semantics are deliberately INCLUSIVE of today, unlike "next <weekday>"
// above, which is deliberately exclusive.
{
  const r = resolveDueDatePhrase("this Monday", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19", "the nearest Monday on/after the Thursday meeting date");
}
{
  // "this Monday" said ON a Monday means TODAY -- the defining difference
  // from "next Monday" (which the test above confirms means next week).
  const r = resolveDueDatePhrase("this Monday", "2026-10-19");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19", "this <weekday> is inclusive of today");
}
{
  const r = resolveDueDatePhrase("on Monday", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19");
}
{
  // The AI organizer paraphrases "on Monday" down to a bare "Monday" --
  // confirmed live -- so a bare weekday with no qualifier at all must
  // resolve the same way as "this"/"on".
  const r = resolveDueDatePhrase("Monday", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19");
}
{
  // Bare weekday said ON that weekday also means today.
  const r = resolveDueDatePhrase("on Monday", "2026-10-19");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-19");
}
{
  const r = resolveDueDatePhrase("this Friday", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-16", "the very next day, since the meeting is the Thursday before");
}
{
  // Month-boundary: "next Friday" said on Friday Oct 30 must cross into
  // November, not wrap incorrectly or land on the same date.
  const r = resolveDueDatePhrase("next Friday", "2026-10-30");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-11-06", "crosses the October/November boundary");
}
{
  // Year-boundary: "this Friday" said Wednesday Dec 30 must cross into
  // January of the following year.
  const r = resolveDueDatePhrase("this Friday", "2026-12-30");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2027-01-01", "crosses the 2026/2027 year boundary");
}
{
  const r = resolveDueDatePhrase("next Monday", "2026-12-30");
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2027-01-04", "next <weekday> also crosses a year boundary correctly");
}
{
  // A past-tense reference ("last Monday") must never be read as a future
  // due date by the bare-weekday fallback -- stays unresolved rather than
  // silently landing on the wrong week.
  const r = resolveDueDatePhrase("last Monday", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "a past reference must never become a future due date");
}

// --- Compound/qualified weekday phrases -- Final Follow-Up Date Safety
// Fix round (docs/AI-HANDOFF.md). Independent review found these could be
// silently mis-resolved by the plain weekday matchers above (each one
// confirmed live, pre-fix, to actually produce a wrong date rather than
// an error -- the dangerous kind of bug). None of these may ever resolve
// automatically; each must stay unresolved with the original wording
// preserved verbatim, requiring explicit manual confirmation.

{
  // Pre-fix, this silently resolved to the nearest Monday, ignoring "a
  // week from" entirely -- a full week off with no indication anything
  // was wrong.
  const r = resolveDueDatePhrase("a week from Monday", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
  assert.equal(r.phrase, "a week from Monday", "original wording must be preserved verbatim");
}
{
  // Pre-fix, this also silently resolved to the nearest Monday, ignoring
  // "after next" -- one week early with no indication anything was wrong.
  const r = resolveDueDatePhrase("the Monday after next", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}
{
  const r = resolveDueDatePhrase("the Friday before last", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "an ordinal stacked on next/last must never auto-resolve");
}
{
  // Already correctly unresolved before this round (plural "Mondays"
  // never matched the singular-weekday patterns) -- locked in here as a
  // regression test, and now also matched explicitly by the new
  // weekday-offset qualifier rather than by accident.
  const r = resolveDueDatePhrase("two Mondays from now", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}
{
  const r = resolveDueDatePhrase("the following Monday", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "\"the following <weekday>\" must never auto-resolve");
}
{
  // Negation -- the plain weekday matchers have no concept of "not," and
  // pre-fix would match whichever weekday phrase happened to appear in
  // the string regardless of which one was actually negated.
  const r = resolveDueDatePhrase("not this Monday, but next Monday", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}
{
  // The critical case: said ON a Monday, "this Monday" and "next Monday"
  // resolve to two DIFFERENT dates (today vs. a week later) -- so getting
  // negation wrong here cannot coincidentally land on the right answer
  // the way it might when the two phrases happen to agree.
  const onMonday = resolveDueDatePhrase("this Monday, not next Monday", "2026-10-19");
  assert.equal(onMonday.kind, "unresolved", "negation must block resolution even when the two weekday phrases would otherwise disagree");
  const reversed = resolveDueDatePhrase("next Monday, not this Monday", "2026-10-19");
  assert.equal(reversed.kind, "unresolved");
}
{
  // A compound qualifier must stay unresolved even across a month/year
  // boundary -- the qualifier check must run before, and independently
  // of, any date arithmetic.
  const r = resolveDueDatePhrase("the Monday after next", "2026-12-30");
  assert.equal(r.kind, "unresolved", "a compound qualifier is never resolved, even near a year boundary");
}

// --- Simple phrases must still resolve automatically -- the compound-
// qualifier guard must never over-match and block legitimate, unambiguous
// phrasing that was already working. ---

{
  const r = resolveDueDatePhrase("a week from now", MEETING_DATE);
  assert.equal(r.kind, "resolved", "no weekday name is present, so the new weekday-offset guard must not fire");
  assert.equal(r.date, "2026-10-22");
}
{
  const r = resolveDueDatePhrase("a few days from now", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-18");
}
{
  const r = resolveDueDatePhrase("this Monday", MEETING_DATE);
  assert.equal(r.kind, "resolved", "a plain weekday phrase with no qualifier must still auto-resolve");
  assert.equal(r.date, "2026-10-19");
}
{
  const r = resolveDueDatePhrase("in two weeks", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-29");
}
{
  const r = resolveDueDatePhrase("in 3 days", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-18");
}
{
  // The AI organizer paraphrases rather than quoting verbatim -- confirmed
  // live, a transcript saying "check back in two weeks" came back as
  // suggestedDueDate: "two weeks", with "in" dropped. Must still resolve.
  const r = resolveDueDatePhrase("two weeks", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-29");
}
{
  const r = resolveDueDatePhrase("a week", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, "2026-10-22");
}
{
  // A past-tense "ago" must never be read as a future due date.
  const r = resolveDueDatePhrase("two weeks ago", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "a past reference must never become a future due date");
}
{
  const r = resolveDueDatePhrase("today", MEETING_DATE);
  assert.equal(r.kind, "resolved");
  assert.equal(r.date, MEETING_DATE);
}

// --- Explicit calendar dates actually stated in the conversation ---

{
  const r = resolveDueDatePhrase("November 3rd", MEETING_DATE);
  assert.equal(r.kind, "explicit");
  assert.equal(r.date, "2026-11-03");
}
{
  // A month/day that has already passed this year relative to the
  // meeting date rolls forward to next year rather than landing in the
  // past -- a follow-up is always in the future.
  const r = resolveDueDatePhrase("January 5th", MEETING_DATE);
  assert.equal(r.kind, "explicit");
  assert.equal(r.date, "2027-01-05");
}
{
  const r = resolveDueDatePhrase("11/20", MEETING_DATE);
  assert.equal(r.kind, "explicit");
  assert.equal(r.date, "2026-11-20");
}
{
  const r = resolveDueDatePhrase("the 20th of November", MEETING_DATE);
  assert.equal(r.kind, "explicit");
  assert.equal(r.date, "2026-11-20");
}

// --- Ambiguous relative dates -- must NEVER invent a precise date ---

{
  const r = resolveDueDatePhrase("early next week", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "'early' does not name a specific day");
  assert.equal(r.phrase, "early next week", "original wording must be preserved verbatim");
}
{
  const r = resolveDueDatePhrase("next week", MEETING_DATE);
  assert.equal(r.kind, "unresolved", "a bare 'next week' does not name a specific day");
}
{
  const r = resolveDueDatePhrase("soon", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
  assert.match(r.reason, /vague/i);
}
{
  const r = resolveDueDatePhrase("sometime next month", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}

// --- Jewish calendar references -- never guess a Gregorian date ---

{
  const r = resolveDueDatePhrase("after Yom Tov", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
  assert.match(r.reason, /jewish calendar|hebrew calendar/i);
  assert.equal(r.phrase, "after Yom Tov");
}
{
  const r = resolveDueDatePhrase("after Pesach", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}
{
  const r = resolveDueDatePhrase("after Sukkos", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}
{
  // Even when stacked with an otherwise-resolvable-sounding qualifier,
  // the Hebrew-calendar dependency wins -- never computed.
  const r = resolveDueDatePhrase("two weeks after Pesach", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
  assert.match(r.reason, /jewish calendar|hebrew calendar/i);
}

// --- Invalid / unrecognized wording -- recognized as due-date language
// by the AI (non-null), but not parseable by this resolver at all ---

{
  const r = resolveDueDatePhrase("end of the month", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
  assert.equal(r.phrase, "end of the month");
}
{
  const r = resolveDueDatePhrase("gibberish not a date at all", MEETING_DATE);
  assert.equal(r.kind, "unresolved");
}

console.log("meeting-notes-due-date-resolver.test.mjs: all assertions passed");
