// Ask Fundraising OS -- portfolio-wide historical giving intelligence
// ("Fix AI Donor Prioritization and Giving-History Intelligence",
// 2026-10-16). The root cause this capability fixes: the assistant's only
// existing "who should I prioritize" capabilities (todays_priorities,
// this_week_priorities, lapsed_relationships) are all derived from
// lib/workspace/live-data.ts's relationshipQueue/priorities -- a queue of
// overdue follow-ups and contact gaps, never donors' actual giving
// amounts. Asking "which donors based on their giving history" had
// nothing better to select from that registry, so the planner kept
// re-selecting the same recency-driven list regardless of how the
// question was phrased or corrected. This module is the portfolio-wide
// ranking those questions actually need -- real lifetime/annual giving
// totals, multi-year trends, and frequency, computed directly from
// giving_activities (and the legacy gifts table, see below), never from
// the relationship/reminder queue.
//
// Split the same way fundraising-progress.ts and donor-authorization.ts
// are: the two SQL statements that retrieve raw, per-donor-per-year
// giving facts are exported as plain strings so a Node test can run them
// against a real synthetic multi-year, multi-user SQLite database; the
// actual trend/signal/ranking logic is a separate pure function
// (summarizeGivingHistory) so it is fully unit-testable with plain
// in-memory rows, no database needed at all. Neither this file nor its
// test imports `cloudflare:workers`.
//
// "Lifetime paid" here deliberately matches the EXACT definition the
// donor's own profile page / Meeting Brief already use
// (lib/relationships/meeting-brief-model.ts's lifetimePaidCents: every
// giving_activities row with paid_cents > 0, PLUS the legacy `gifts`
// table's amount_cents) -- not a narrower figure. This capability's own
// design rule (see every other file in lib/assistant/) is that an
// Ask AI answer can never disagree with what the rest of the app already
// shows for the same donor; inventing a second, different "lifetime
// paid" number here would violate that on day one.
//
// Every dollar is counted from exactly ONE place: a giving_activities
// row's CURRENT paid_cents (never per-payment-event rows -- this schema
// already stores a pledge as one row whose paid_cents is updated as
// payments arrive, confirmed across the five independent financial-
// integrity review rounds this file's sibling, fundraising-progress.ts,
// documents in full) or a legacy gifts row's amount_cents. Never both for
// the same real-world dollar, and never an open pledge's committed_cents
// counted as if it were paid.

export type YearlyGivingRow = { donor_id: string; year: number; paid_cents: number; gift_count: number; most_recent_date: number };
export type OpenCommitmentRow = { donor_id: string; balance_cents: number; committed_cents: number };

// Every giving_activities row that represents real money a donor
// actually paid, grouped by the calendar year the payment/gift's own
// activity_date falls in. activity_date is a UTC-midnight-anchored
// calendar day, never a real timezone-local instant (lib/financial-
// date.ts's own documented convention, used identically everywhere else
// this app reads it) -- strftime(...,'unixepoch') is UTC by default,
// so this extracts the calendar year the SAME way financialDateLabel
// would display it, never off by a day/year at a timezone boundary.
// needs_review/nonfinancial_entry/pending_gift are excluded for the
// identical reason meeting-brief.ts's own giving query excludes them:
// none of the three represents a real, confirmed paid dollar yet.
// UNION ALL's second branch is the legacy `gifts` table -- see this
// file's header comment for why it must be included, not a narrower
// giving_activities-only figure.
export const GIVING_BY_DONOR_YEAR_SQL = `
  SELECT donor_id, year, SUM(paid_cents) AS paid_cents, COUNT(*) AS gift_count, MAX(occurred_at) AS most_recent_date
  FROM (
    SELECT ga.donor_id AS donor_id, CAST(strftime('%Y', ga.activity_date, 'unixepoch') AS INTEGER) AS year, ga.paid_cents AS paid_cents, ga.activity_date AS occurred_at
    FROM giving_activities ga
    WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
      AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
      AND ga.paid_cents > 0 AND ga.activity_date IS NOT NULL
    UNION ALL
    SELECT g.donor_id AS donor_id, CAST(strftime('%Y', g.received_at, 'unixepoch') AS INTEGER) AS year, g.amount_cents AS paid_cents, g.received_at AS occurred_at
    FROM gifts g JOIN donors d ON d.id = g.donor_id
    WHERE d.owner_user_id = ? AND d.data_source = 'live' AND g.amount_cents > 0 AND g.received_at IS NOT NULL
  ) combined
  GROUP BY donor_id, year
`;

// Every donor's CURRENT open/partially-paid pledge exposure, summed
// across however many such rows they have -- the exact same
// pledge_balance_corrections override join getOutstandingPledges (./
// capabilities.ts) and the Pledge Review page both already use, so this
// capability's own "they also have an open pledge of $X" context can
// never disagree with either. Committed and balance are kept separate
// from paid_cents above on purpose -- a pledge's committed amount is not
// money received, and this query never feeds lifetimePaidCents.
export const OPEN_COMMITMENTS_BY_DONOR_SQL = `
  SELECT ga.donor_id AS donor_id, SUM(COALESCE(pbc.corrected_balance_cents, ga.balance_cents)) AS balance_cents, SUM(ga.committed_cents) AS committed_cents
  FROM giving_activities ga
  LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
  WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
    AND ga.category IN ('open_pledge','partially_paid_pledge')
  GROUP BY ga.donor_id
`;

// A donor needs at least this many distinct giving years, or this many
// gifts, before any multi-year TREND claim (consistent/declined/lapsed)
// is made about them -- one single gift proves they gave once, nothing
// about a pattern. Below this bar, a donor can still appear (e.g. under
// "high value," if the one gift is large), but only ever described by
// what is literally true -- a single gift -- never framed as a trend.
const MIN_YEARS_FOR_TREND = 2;
const MIN_GIFTS_FOR_TREND = 2;

// A donor's most recent single-year total falling below this fraction of
// their own historical peak year counts as "declined" -- always compared
// to the donor's OWN prior peak, never a cross-donor or invented
// capacity figure.
export const DECLINE_RATIO_THRESHOLD = 0.5;

// No real paid gift in at least this many full calendar years since
// their last one counts as "lapsed." Below this, a donor who gave less
// recently than this year but still within the window is "declined,"
// not "lapsed" -- the two signals are mutually exclusive by construction
// (see classifyDonor below).
export const LAPSED_YEARS_THRESHOLD = 2;

// "Consistent annual supporter": at least this many distinct giving
// years, AND giving in at least this fraction of the calendar years
// since their first gift (a donor who gave in 6 of the last 8 years is
// consistent; one who gave twice in 8 years is not), AND no lapse.
export const CONSISTENT_MIN_YEARS = 3;
export const CONSISTENT_COVERAGE_THRESHOLD = 0.6;

// "Historically high-value" is deliberately RELATIVE to this donor's own
// portfolio, never a fixed dollar figure -- a fixed number would be
// meaningless across organizations of very different sizes, and a fixed
// number is exactly the kind of invented, un-derived threshold the task
// this module was built for explicitly warns against. The top fraction
// of donors (by their own real, recorded lifetime paid total) among
// everyone with at least one qualifying gift are flagged high_value; at
// least one donor always qualifies when any giving history exists at
// all.
export const HIGH_VALUE_TOP_FRACTION = 0.25;

// Shortlist-ranking boosts: a donor who is still a confirmed major donor
// but has drifted off course (declined) or gone quiet entirely (lapsed)
// is more ACTIONABLE for a fundraiser than one who is simply large and
// steady -- these multipliers make the shortlist surface the former
// ahead of an equally-large but already-engaged donor, without ever
// changing the underlying lifetime-paid figure itself.
export const DECLINED_SCORE_MULTIPLIER = 1.3;
export const LAPSED_SCORE_MULTIPLIER = 1.5;

export type GivingSignal = "high_value" | "consistent" | "declined" | "lapsed" | "insufficient_history";

export type HistoricalGivingCandidate = {
  donorId: string;
  lifetimePaidCents: number;
  giftCount: number;
  distinctGivingYears: number;
  firstGivingYear: number;
  lastGivingYear: number;
  mostRecentPaidDateEpoch: number;
  peakYear: number;
  peakYearCents: number;
  lastGivingYearCents: number;
  yearsSinceLastGift: number;
  signals: GivingSignal[];
  priorityScore: number;
};

type DonorYearTotals = {
  donorId: string;
  years: Map<number, { paidCents: number; giftCount: number; mostRecentDate: number }>;
};

function groupByDonor(rows: YearlyGivingRow[]): DonorYearTotals[] {
  const byDonor = new Map<string, DonorYearTotals>();
  for (const row of rows) {
    let entry = byDonor.get(row.donor_id);
    if (!entry) {
      entry = { donorId: row.donor_id, years: new Map() };
      byDonor.set(row.donor_id, entry);
    }
    const existing = entry.years.get(row.year);
    // Defensive, not expected: the SQL already GROUPs BY (donor_id,
    // year), so a caller feeding real query results never hits this
    // branch -- only a hand-built test fixture with a duplicate
    // (donor,year) pair could, and even then this merges rather than
    // silently dropping data.
    if (existing) {
      existing.paidCents += row.paid_cents;
      existing.giftCount += row.gift_count;
      existing.mostRecentDate = Math.max(existing.mostRecentDate, row.most_recent_date);
    } else {
      entry.years.set(row.year, { paidCents: row.paid_cents, giftCount: row.gift_count, mostRecentDate: row.most_recent_date });
    }
  }
  return [...byDonor.values()];
}

function classifyDonor(donor: DonorYearTotals, currentYear: number): Omit<HistoricalGivingCandidate, "signals" | "priorityScore"> {
  const years = [...donor.years.keys()].sort((a, b) => a - b);
  const firstGivingYear = years[0];
  const lastGivingYear = years[years.length - 1];
  const distinctGivingYears = years.length;
  const giftCount = [...donor.years.values()].reduce((sum, y) => sum + y.giftCount, 0);
  const lifetimePaidCents = [...donor.years.values()].reduce((sum, y) => sum + y.paidCents, 0);
  const mostRecentPaidDateEpoch = Math.max(...[...donor.years.values()].map((y) => y.mostRecentDate));

  let peakYear = firstGivingYear;
  let peakYearCents = -1;
  for (const [year, totals] of donor.years) {
    if (totals.paidCents > peakYearCents) {
      peakYearCents = totals.paidCents;
      peakYear = year;
    }
  }

  const lastGivingYearCents = donor.years.get(lastGivingYear)!.paidCents;
  const yearsSinceLastGift = Math.max(0, currentYear - lastGivingYear);

  return { donorId: donor.donorId, lifetimePaidCents, giftCount, distinctGivingYears, firstGivingYear, lastGivingYear, mostRecentPaidDateEpoch, peakYear, peakYearCents, lastGivingYearCents, yearsSinceLastGift };
}

// Computes the deterministic signal set for one already-classified donor.
// lapsed and declined are mutually exclusive by construction (checked in
// that order -- a donor who hasn't given in LAPSED_YEARS_THRESHOLD+ years
// is "lapsed," full stop, never also "declined," which describes someone
// still giving, just less than their own peak).
function signalsFor(donor: Omit<HistoricalGivingCandidate, "signals" | "priorityScore">, highValueDonorIds: Set<string>): GivingSignal[] {
  const signals: GivingSignal[] = [];
  const hasEnoughForTrend = donor.distinctGivingYears >= MIN_YEARS_FOR_TREND || donor.giftCount >= MIN_GIFTS_FOR_TREND;

  if (highValueDonorIds.has(donor.donorId)) signals.push("high_value");

  if (!hasEnoughForTrend) {
    signals.push("insufficient_history");
    return signals;
  }

  if (donor.yearsSinceLastGift >= LAPSED_YEARS_THRESHOLD) {
    signals.push("lapsed");
  } else if (donor.peakYearCents > 0 && donor.lastGivingYearCents < donor.peakYearCents * DECLINE_RATIO_THRESHOLD && donor.lastGivingYear !== donor.peakYear) {
    signals.push("declined");
  } else {
    const yearsSinceFirst = donor.lastGivingYear - donor.firstGivingYear + 1;
    const coverage = donor.distinctGivingYears / yearsSinceFirst;
    if (donor.distinctGivingYears >= CONSISTENT_MIN_YEARS && coverage >= CONSISTENT_COVERAGE_THRESHOLD) {
      signals.push("consistent");
    }
  }

  return signals;
}

// A lapsed or declined donor who was genuinely significant is the most
// actionable cultivation opportunity this data can support without
// inventing anything -- their OWN past giving already proves what they
// are capable of; this is simply surfacing that fact, never predicting
// a future gift. priorityScore exists only to rank the shortlist; it is
// never shown to the fundraiser or the AI as a figure in its own right.
function priorityScoreFor(signals: GivingSignal[], lifetimePaidCents: number): number {
  if (signals.includes("lapsed")) return lifetimePaidCents * LAPSED_SCORE_MULTIPLIER;
  if (signals.includes("declined")) return lifetimePaidCents * DECLINED_SCORE_MULTIPLIER;
  return lifetimePaidCents;
}

// The one entry point: raw per-donor-per-year rows in, a ranked,
// signal-labeled, bounded shortlist out. Pure and synchronous -- no
// database, no AI, fully deterministic given the same rows and
// currentYear, so a test can assert on an exact shortlist and exact
// signal set for a hand-built scenario.
export function summarizeGivingHistory(params: { rows: YearlyGivingRow[]; currentYear: number; limit: number }): HistoricalGivingCandidate[] {
  const donors = groupByDonor(params.rows);
  if (donors.length === 0) return [];

  const classified = donors.map((d) => classifyDonor(d, params.currentYear));

  // HIGH_VALUE_TOP_FRACTION of ALL donors with any qualifying giving
  // history (not just the ones that will ultimately survive into the
  // shortlist) -- a donor's high_value status describes where they sit
  // in the WHOLE portfolio, not just among the few already selected for
  // other reasons.
  const byLifetimeDesc = [...classified].sort((a, b) => b.lifetimePaidCents - a.lifetimePaidCents);
  const highValueCount = Math.max(1, Math.ceil(byLifetimeDesc.length * HIGH_VALUE_TOP_FRACTION));
  const highValueDonorIds = new Set(byLifetimeDesc.slice(0, highValueCount).map((d) => d.donorId));

  const withSignals = classified.map((d) => {
    const signals = signalsFor(d, highValueDonorIds);
    return { ...d, signals, priorityScore: priorityScoreFor(signals, d.lifetimePaidCents) };
  });

  return withSignals.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, params.limit);
}
