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
// REWRITTEN ("Final Historical Giving Accuracy and AI Ranking Fix",
// 2026-10-16, independent review of the module above): the first version
// bucketed every dollar by giving_activities.activity_date -- which,
// exactly like fundraising-progress.ts's own ORIGINAL bug (see that
// file's header, item 1), is the JL export's "Due Date" column
// (lib/import/jl-donations.ts's classifyJlDonation: `row["Due Date"] ||
// row.Date`), never updated once a payment is later applied to that row
// (app/api/import/route.ts's pledgeUpdateStatements touches only
// paid_cents/balance_cents/category/source_snapshot/updated_at -- never
// activity_date). A pledge due/recorded in 2020 but paid off across
// 2021-2025 via the payment-review screen had its ENTIRE cumulative
// paid_cents attributed to 2020, which could fabricate a false "lapsed
// since 2020" or "declined after 2020" claim about a donor who in reality
// kept paying for years afterward. A second, related gap: a plain
// reimport can also bump an existing pledge's paid_cents directly (no
// payment-review decision at all, see lib/import/jl-donation-match.ts's
// proposedUpdates) with no payment date on file for that increment at
// all -- fundraising-progress.ts already established (its own header,
// "THE THREE HONEST CATEGORIES") that this gap can never be assigned to
// any period; this module's annual trend must honor the identical
// discipline, never reusing activity_date or an import timestamp as a
// stand-in for a real receipt date.
//
// THE FIX, reusing fundraising-progress.ts's own proven primitive
// (jl_payment_assignment_audits.payment_date -- a genuinely dated, per-
// payment-event record, see that file's Category A): every
// giving_activities row's annual-trend contribution is now one of four
// honest outcomes, decided per row:
//   1. RELIABLE -- the row was never touched by a payment-assignment
//      audit (lib/import/jl-payment-assignment.ts's apply_to_pledge path
//      never ran against it), never bumped by a plain reimport update
//      (giving_activity_import_changes has no 'update' row for its
//      fingerprint), AND its own activity_date is CONFIRMED to be a
//      genuine transaction date rather than a pledge due date -- its own
//      activity_date is then the only evidence that has ever existed for
//      this row, so it is used as-is.
//   1b. DUE DATE / UNCONFIRMED PROVENANCE ("Final Giving-Date Provenance
//      Fix Before Production," 2026-10-16, independent review): an
//      untouched row whose provenance CANNOT be confirmed as a genuine
//      transaction date -- almost always a full JL export pledge
//      (lib/import/jl-donations.ts's classifyJlDonation:
//      `row["Due Date"] || row.Date`), whose activity_date is the JL
//      export's "Due Date" column, a commitment date, never a receipt
//      date. The absence of an audit row or a reimport bump is NOT proof
//      that this date represents a payment -- it only proves the pledge
//      has never been *touched* since import, which says nothing about
//      when (or across how many years) it was actually paid off. Treated
//      identically to case 3 below: excluded from the annual trend,
//      donor marked UNRELIABLE, lifetime total unaffected. See
//      "Confirming genuine-transaction-date provenance" below for how
//      case 1 is distinguished from case 1b.
//   2. VERIFIED VIA AUDIT TRAIL -- the row DOES have linked
//      jl_payment_assignment_audits rows (decision_type='apply_to_pledge',
//      keyed by pledge_activity_id, never a content-hash fingerprint, so
//      no cross-owner join is even needed here -- a giving_activities id
//      is a real primary key). Each individually-dated, individually-
//      amounted audit row (payment_date, applied_cents) is used in place
//      of the row's own activity_date for however much of paid_cents it
//      actually accounts for. If every cent is accounted for (no
//      residual), the donor's annual trend is fully reliable; if any
//      residual remains (an undated application, or paid_cents exceeding
//      what any audit row explains), this donor's annual trend is marked
//      UNRELIABLE -- never guessed at, never silently folded into the
//      row's own due-date year.
//   3. UNVERIFIABLE -- the row has no audit rows at all, but DOES have a
//      plain-reimport 'update' change-log entry (paid_cents moved with no
//      payment-review decision behind it, exactly fundraising-progress.ts's
//      own disclosed gap) -- its entire paid_cents is excluded from the
//      annual trend and the donor is marked UNRELIABLE.
//
// Confirming genuine-transaction-date provenance (case 1 vs. 1b): traced
// the full import/storage schema (app/api/import/route.ts's INSERT,
// lib/import/jl-donations.ts's classifyJlDonation/sourceValues) to find
// that `giving_activities.source_snapshot` is `JSON.stringify` of the
// EXACT raw source row, under its ORIGINAL column headers, for every row
// this query can ever see paid_cents > 0 for (the only two insert sites,
// confirmed by exhaustive grep: app/api/import/route.ts's JL import,
// always external_source = 'JL Solutions'; and the Fundraising-OS-native
// pending-gift/pledge inserts, which hardcode paid_cents = 0 and can
// never later gain a paid_cents update outside that same JL import path
// -- so they never reach this query at all). JL_DONATION_COLUMNS (the
// full/pledge export) always includes a "Due Date" header and never a
// "Date" header; JL_COMPACT_DONATION_COLUMNS (the payment-only export)
// always includes a "Date" header and never "Due Date" -- the two
// formats are mutually exclusive by their own defining column sets, so a
// raw-text search for the literal JSON key `"Due Date":` vs. `"Date":`
// in source_snapshot reliably recovers which export produced the row,
// with no inference about donor behavior and no reliance on
// paid_cents > 0 ever meaning anything about the date. This is
// genuinely the only persisted field that can answer the question --
// activity_date itself cannot (it already lost the distinction by the
// time either format reaches it), and record_origin/category/
// workspace_status carry no format information at all. A row whose
// source_snapshot is null, empty, or contains neither marker (data that
// predates this field, or any future import path this review did not
// anticipate) is conservatively treated exactly like case 1b -- never
// assumed to be a genuine date for lack of evidence otherwise.
// A donor's LIFETIME total (and therefore their ranking/high_value
// status) is completely unaffected by any of this -- it is still the sum
// of every qualifying row's CURRENT paid_cents, exactly matching the
// donor profile's own figure, same as before. Only the YEAR-BY-YEAR shape
// (consistent/declined/lapsed) is gated on reliable evidence; an
// unreliable donor still ranks by their real lifetime total and is
// described honestly (GIVING_SIGNAL_LABELS.annual_trend_unknown in
// capabilities.ts) rather than losing their place on the shortlist or
// being given a fabricated trend.
//
// Split the same way fundraising-progress.ts and donor-authorization.ts
// are: the exported SQL statements are plain strings so a Node test can
// run them against a real synthetic multi-year, multi-user SQLite
// database; the actual trend/signal/ranking logic is a separate pure
// function (summarizeGivingHistory) so it is fully unit-testable with
// plain in-memory rows, no database needed at all. Neither this file nor
// its test imports `cloudflare:workers`.
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
// counted as if it were paid. jl_payment_assignment_audits rows are used
// ONLY to re-date an already-counted pledge's existing paid_cents by
// year, never to add a second, separate dollar on top of it.

export type GivingRecordRow = {
  donor_id: string;
  // UTC-midnight-anchored calendar day (lib/financial-date.ts's own
  // documented convention) -- the row's own activity_date (a JL "Due
  // Date"/record date, see this file's header) or the legacy gifts
  // table's received_at. Only trustworthy as a YEAR of giving when
  // audit_row_count = 0 AND unaudited_update_count = 0 AND
  // genuine_transaction_date = 1 -- see aggregateDonors below.
  activity_date: number;
  paid_cents: number;
  // 1 when this row's activity_date is CONFIRMED to be a genuine
  // transaction/payment date rather than a pledge due date -- a compact
  // JL export's own "Date" column, or a legacy gifts row's received_at
  // (always 1, hardcoded in the second UNION ALL branch below). 0 for a
  // full JL export (the "Due Date" column) or any row whose
  // source_snapshot provenance cannot be confirmed either way -- see
  // this file's header, "Confirming genuine-transaction-date
  // provenance." Consulted ONLY when audit_row_count = 0 AND
  // unaudited_update_count = 0; an audited or reimport-bumped row is
  // already judged by its own evidence instead.
  genuine_transaction_date: number;
  // How many jl_payment_assignment_audits rows (decision_type =
  // 'apply_to_pledge') point at this giving_activities row via
  // pledge_activity_id -- a real foreign key, not a content hash, so no
  // cross-owner ambiguity is possible here the way it is for
  // giving_activity_import_changes below.
  audit_row_count: number;
  // SUM(applied_cents) across every one of those audit rows, dated or
  // not -- compared against paid_cents to find any residual this row's
  // own audit trail does not fully explain.
  audited_applied_cents: number;
  // How many giving_activity_import_changes rows exist for this row's
  // own source_fingerprint, owner-scoped via a join through data_imports
  // (that change-log table has no owner_user_id column of its own, and a
  // fingerprint is a pure content hash -- see fundraising-progress.ts's
  // header, item 4b, for why this join is load-bearing, not incidental).
  // Only consulted when audit_row_count = 0; a row with audit rows is
  // judged by its own audit trail instead, never this flag.
  unaudited_update_count: number;
};

// A real, individually-dated payment event applied to a PRE-EXISTING
// pledge through the payment-review screen -- fundraising-progress.ts's
// own Category A primitive, reused here for the identical reason: this
// is the one place a date more trustworthy than a pledge's own due date
// has ever been recorded. donor_id comes directly off the audit row
// itself (jl_payment_assignment_audits.donor_id), not a join -- no
// giving_activities lookup is needed to attribute these to a donor.
export type VerifiedPledgePaymentRow = { donor_id: string; payment_date: number; applied_cents: number };

export type OpenCommitmentRow = { donor_id: string; balance_cents: number; committed_cents: number };

// Every giving_activities row that represents real money a donor
// actually paid, ROW-LEVEL (never pre-aggregated by year in SQL -- see
// this file's header for why the annual attribution now has to happen in
// the pure layer, where a row's audit trail can be consulted first).
// needs_review/nonfinancial_entry/pending_gift are excluded for the
// identical reason meeting-brief.ts's own giving query excludes them:
// none of the three represents a real, confirmed paid dollar yet.
// UNION ALL's second branch is the legacy `gifts` table -- see this
// file's header comment for why it must be included, not a narrower
// giving_activities-only figure. Legacy gifts never go through this
// app's own JL import/payment-assignment machinery at all, so they are
// always audit_row_count = 0, unaudited_update_count = 0 -- received_at
// is simply trusted, exactly as every other part of this app (e.g.
// meeting-brief.ts) already trusts it.
// genuine_transaction_date: a plain substring search on the raw JSON
// text, not json_extract -- robust across SQLite/D1 versions and avoids
// any JSON-path quoting ambiguity over the space in "Due Date", and the
// two literal key markers ('"Due Date":' and '"Date":') can never
// collide (the former is not a substring occurrence of the latter --
// "Date\":" only appears preceded by a '"', never by "Due "). NULL/empty
// source_snapshot makes both LIKEs false, landing on 0 (unconfirmed),
// exactly the documented conservative default.
export const GIVING_RECORDS_SQL = `
  SELECT ga.donor_id AS donor_id, ga.activity_date AS activity_date, ga.paid_cents AS paid_cents,
    (SELECT COUNT(*) FROM jl_payment_assignment_audits a WHERE a.pledge_activity_id = ga.id AND a.decision_type = 'apply_to_pledge') AS audit_row_count,
    (SELECT COALESCE(SUM(a.applied_cents), 0) FROM jl_payment_assignment_audits a WHERE a.pledge_activity_id = ga.id AND a.decision_type = 'apply_to_pledge') AS audited_applied_cents,
    (SELECT COUNT(*) FROM giving_activity_import_changes c JOIN data_imports di ON di.id = c.import_id WHERE c.source_fingerprint = ga.source_fingerprint AND di.user_id = ga.owner_user_id AND c.change_type = 'update') AS unaudited_update_count,
    (CASE WHEN ga.source_snapshot LIKE '%"Date":%' AND ga.source_snapshot NOT LIKE '%"Due Date":%' THEN 1 ELSE 0 END) AS genuine_transaction_date
  FROM giving_activities ga
  WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
    AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
    AND ga.paid_cents > 0 AND ga.activity_date IS NOT NULL
  UNION ALL
  SELECT g.donor_id AS donor_id, g.received_at AS activity_date, g.amount_cents AS paid_cents, 0 AS audit_row_count, 0 AS audited_applied_cents, 0 AS unaudited_update_count, 1 AS genuine_transaction_date
  FROM gifts g JOIN donors d ON d.id = g.donor_id
  WHERE d.owner_user_id = ? AND d.data_source = 'live' AND g.amount_cents > 0 AND g.received_at IS NOT NULL
`;

// The real, dated payment-event ledger for annual re-attribution --
// deliberately requiring payment_date IS NOT NULL, exactly like
// fundraising-progress.ts's own VERIFIED_DATED_PAYMENT_AUDITS_SQL (never
// COALESCE-ing to a processing timestamp as a stand-in for a missing real
// date). user_id scoping is direct -- jl_payment_assignment_audits.user_id
// is the workspace owner, not a content hash, so no join is needed to
// stay owner-isolated the way GIVING_RECORDS_SQL's unaudited_update_count
// subquery does.
export const VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL = `
  SELECT donor_id, payment_date, applied_cents
  FROM jl_payment_assignment_audits
  WHERE user_id = ? AND decision_type = 'apply_to_pledge' AND pledge_activity_id IS NOT NULL
    AND payment_date IS NOT NULL AND applied_cents > 0
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
// Also doubles as the bar between "insufficient_history" and
// "annual_trend_unknown" when a donor's annual evidence is unreliable
// (see signalsFor) -- a donor judged only by giftCount here because their
// per-year shape cannot be trusted at all.
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
// all. Computed from lifetimePaidCents only, so it is never affected by
// whether a donor's ANNUAL trend evidence happens to be reliable.
export const HIGH_VALUE_TOP_FRACTION = 0.25;

// Shortlist-ranking boosts: a donor who is still a confirmed major donor
// but has drifted off course (declined) or gone quiet entirely (lapsed)
// is more ACTIONABLE for a fundraiser than one who is simply large and
// steady -- these multipliers make the shortlist surface the former
// ahead of an equally-large but already-engaged donor, without ever
// changing the underlying lifetime-paid figure itself. Never applied to
// a donor whose annual trend is unreliable -- this module has no basis
// to claim they declined or lapsed, so they are ranked by their plain
// lifetime total instead (see priorityScoreFor).
export const DECLINED_SCORE_MULTIPLIER = 1.3;
export const LAPSED_SCORE_MULTIPLIER = 1.5;

export type GivingSignal = "high_value" | "consistent" | "declined" | "lapsed" | "insufficient_history" | "annual_trend_unknown";

export type HistoricalGivingCandidate = {
  donorId: string;
  lifetimePaidCents: number;
  giftCount: number;
  // False whenever ANY of this donor's giving records has an unresolved
  // residual (an audited pledge with money the audit trail does not
  // fully explain) or was bumped by a plain reimport with no payment-
  // review decision behind it at all. Every field below is null when
  // this is false -- never a guessed/partial year-level claim built from
  // incomplete evidence (see this file's header).
  annualTrendReliable: boolean;
  distinctGivingYears: number | null;
  firstGivingYear: number | null;
  lastGivingYear: number | null;
  mostRecentPaidDateEpoch: number | null;
  peakYear: number | null;
  peakYearCents: number | null;
  lastGivingYearCents: number | null;
  yearsSinceLastGift: number | null;
  signals: GivingSignal[];
  priorityScore: number;
};

type DonorAggregate = {
  donorId: string;
  lifetimePaidCents: number;
  giftCount: number;
  annualTrendReliable: boolean;
  annualYears: Map<number, { paidCents: number; mostRecentDate: number }>;
};

function utcYear(epochSeconds: number): number {
  return new Date(epochSeconds * 1000).getUTCFullYear();
}

function getOrCreate(byDonor: Map<string, DonorAggregate>, donorId: string): DonorAggregate {
  let entry = byDonor.get(donorId);
  if (!entry) {
    entry = { donorId, lifetimePaidCents: 0, giftCount: 0, annualTrendReliable: true, annualYears: new Map() };
    byDonor.set(donorId, entry);
  }
  return entry;
}

function addToYear(entry: DonorAggregate, year: number, cents: number, dateEpoch: number) {
  const existing = entry.annualYears.get(year);
  if (existing) {
    existing.paidCents += cents;
    existing.mostRecentDate = Math.max(existing.mostRecentDate, dateEpoch);
  } else {
    entry.annualYears.set(year, { paidCents: cents, mostRecentDate: dateEpoch });
  }
}

// The core reconciliation (see this file's header for the full story):
// each giving_activities/legacy-gift row always contributes its full
// paid_cents to lifetime giving, unconditionally. Only its contribution
// to the YEAR-BY-YEAR trend differs by how it was paid:
//   - never touched by payment-assignment or a plain reimport, AND
//     confirmed to be a genuine transaction date (not a pledge due date)
//     -> its own activity_date year.
//   - never touched by either, but its date provenance is a due date or
//     cannot be confirmed -> excluded from the trend, donor marked
//     UNRELIABLE (case 1b, "Final Giving-Date Provenance Fix Before
//     Production," 2026-10-16 -- an untouched pledge is not evidence
//     that its due date is a payment date).
//   - has an audit trail that fully explains its paid_cents -> excluded
//     here (the dated VerifiedPledgePaymentRow events below cover it
//     instead), reliability untouched.
//   - has an audit trail with an unexplained residual, or was bumped by
//     a plain reimport with no audit trail at all -> excluded from the
//     trend entirely, and the donor's annualTrendReliable flag is
//     permanently cleared.
function aggregateDonors(records: GivingRecordRow[], verifiedEvents: VerifiedPledgePaymentRow[]): DonorAggregate[] {
  const byDonor = new Map<string, DonorAggregate>();

  for (const row of records) {
    const entry = getOrCreate(byDonor, row.donor_id);
    entry.lifetimePaidCents += row.paid_cents;
    entry.giftCount += 1;

    if (row.audit_row_count > 0) {
      if (row.paid_cents > row.audited_applied_cents) entry.annualTrendReliable = false;
      // Fully explained (residual = 0): the dated audit events below
      // already cover every cent of this row -- never also bucket it by
      // its own activity_date, which would both double-count the money
      // and reintroduce the exact due-date bug this rewrite fixes.
    } else if (row.unaudited_update_count > 0) {
      entry.annualTrendReliable = false;
      // No audit trail AND no reliable creation-time date for however
      // much of paid_cents arrived after that reimport -- excluded
      // entirely, never approximated from the row's own due date.
    } else if (row.genuine_transaction_date) {
      addToYear(entry, utcYear(row.activity_date), row.paid_cents, row.activity_date);
    } else {
      entry.annualTrendReliable = false;
      // Untouched since import, but its own date is a pledge due date
      // (or its provenance cannot be confirmed) -- the absence of an
      // audit row or a reimport bump proves only that nobody has
      // recorded a payment event against it, never that its due date IS
      // a payment date. Never bucketed by activity_date.
    }
  }

  for (const event of verifiedEvents) {
    const entry = getOrCreate(byDonor, event.donor_id);
    addToYear(entry, utcYear(event.payment_date), event.applied_cents, event.payment_date);
  }

  return [...byDonor.values()];
}

function classifyDonor(agg: DonorAggregate, currentYear: number): Omit<HistoricalGivingCandidate, "signals" | "priorityScore"> {
  const base = { donorId: agg.donorId, lifetimePaidCents: agg.lifetimePaidCents, giftCount: agg.giftCount };

  if (!agg.annualTrendReliable || agg.annualYears.size === 0) {
    // annualYears can be empty even when annualTrendReliable is still
    // true only if every one of this donor's rows was fully explained by
    // an audit trail whose own dated events somehow never arrived in
    // verifiedEvents (not expected from real data, but never divide by
    // zero or crash on it) -- treated the same as unreliable: no
    // year-level claim without actual year evidence behind it.
    return { ...base, annualTrendReliable: false, distinctGivingYears: null, firstGivingYear: null, lastGivingYear: null, mostRecentPaidDateEpoch: null, peakYear: null, peakYearCents: null, lastGivingYearCents: null, yearsSinceLastGift: null };
  }

  const years = [...agg.annualYears.keys()].sort((a, b) => a - b);
  const firstGivingYear = years[0];
  const lastGivingYear = years[years.length - 1];
  const distinctGivingYears = years.length;
  const mostRecentPaidDateEpoch = Math.max(...[...agg.annualYears.values()].map((y) => y.mostRecentDate));

  let peakYear = firstGivingYear;
  let peakYearCents = -1;
  for (const [year, totals] of agg.annualYears) {
    if (totals.paidCents > peakYearCents) {
      peakYearCents = totals.paidCents;
      peakYear = year;
    }
  }

  const lastGivingYearCents = agg.annualYears.get(lastGivingYear)!.paidCents;
  const yearsSinceLastGift = Math.max(0, currentYear - lastGivingYear);

  return { ...base, annualTrendReliable: true, distinctGivingYears, firstGivingYear, lastGivingYear, mostRecentPaidDateEpoch, peakYear, peakYearCents, lastGivingYearCents, yearsSinceLastGift };
}

// Computes the deterministic signal set for one already-classified donor.
// lapsed and declined are mutually exclusive by construction (checked in
// that order -- a donor who hasn't given in LAPSED_YEARS_THRESHOLD+ years
// is "lapsed," full stop, never also "declined," which describes someone
// still giving, just less than their own peak).
function signalsFor(donor: Omit<HistoricalGivingCandidate, "signals" | "priorityScore">, highValueDonorIds: Set<string>): GivingSignal[] {
  const signals: GivingSignal[] = [];
  if (highValueDonorIds.has(donor.donorId)) signals.push("high_value");

  if (!donor.annualTrendReliable) {
    // A donor with real, substantial giving history whose YEAR-BY-YEAR
    // shape this system cannot verify (see this file's header) --
    // "Historically significant donor; annual payment trend cannot be
    // reliably determined from available records," never a fabricated
    // consistent/declined/lapsed claim. "Significant" is judged the same
    // two ways a donor can matter here: already high_value by lifetime
    // total (a single large, unreliably-dated pledge still counts -- one
    // record is not "too little history" when it is a $75,000 pledge),
    // or at least MIN_GIFTS_FOR_TREND separate qualifying records. Below
    // both bars, there is not enough evidence to call them "significant"
    // at all -- plain insufficient_history, same bar as the reliable
    // path below.
    const isSignificant = signals.includes("high_value") || donor.giftCount >= MIN_GIFTS_FOR_TREND;
    signals.push(isSignificant ? "annual_trend_unknown" : "insufficient_history");
    return signals;
  }

  const hasEnoughForTrend = donor.distinctGivingYears! >= MIN_YEARS_FOR_TREND || donor.giftCount >= MIN_GIFTS_FOR_TREND;
  if (!hasEnoughForTrend) {
    signals.push("insufficient_history");
    return signals;
  }

  if (donor.yearsSinceLastGift! >= LAPSED_YEARS_THRESHOLD) {
    signals.push("lapsed");
  } else if (donor.peakYearCents! > 0 && donor.lastGivingYearCents! < donor.peakYearCents! * DECLINE_RATIO_THRESHOLD && donor.lastGivingYear !== donor.peakYear) {
    signals.push("declined");
  } else {
    const yearsSinceFirst = donor.lastGivingYear! - donor.firstGivingYear! + 1;
    const coverage = donor.distinctGivingYears! / yearsSinceFirst;
    if (donor.distinctGivingYears! >= CONSISTENT_MIN_YEARS && coverage >= CONSISTENT_COVERAGE_THRESHOLD) {
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
// A donor with an unreliable annual trend is never boosted this way --
// this module has no verified basis for calling them lapsed or declined,
// so they rank on their plain, real lifetime total alone.
function priorityScoreFor(signals: GivingSignal[], lifetimePaidCents: number): number {
  if (signals.includes("lapsed")) return lifetimePaidCents * LAPSED_SCORE_MULTIPLIER;
  if (signals.includes("declined")) return lifetimePaidCents * DECLINED_SCORE_MULTIPLIER;
  return lifetimePaidCents;
}

// The one entry point: raw per-record rows and verified payment events
// in, a ranked, signal-labeled, bounded shortlist out. Pure and
// synchronous -- no database, no AI, fully deterministic given the same
// inputs and currentYear, so a test can assert on an exact shortlist and
// exact signal set for a hand-built scenario.
export function summarizeGivingHistory(params: { records: GivingRecordRow[]; verifiedPledgePayments: VerifiedPledgePaymentRow[]; currentYear: number; limit: number }): HistoricalGivingCandidate[] {
  const donors = aggregateDonors(params.records, params.verifiedPledgePayments);
  if (donors.length === 0) return [];

  const classified = donors.map((d) => classifyDonor(d, params.currentYear));

  // HIGH_VALUE_TOP_FRACTION of ALL donors with any qualifying giving
  // history (not just the ones that will ultimately survive into the
  // shortlist) -- a donor's high_value status describes where they sit
  // in the WHOLE portfolio, not just among the few already selected for
  // other reasons. Based on lifetimePaidCents only -- see this constant's
  // own doc comment above.
  const byLifetimeDesc = [...classified].sort((a, b) => b.lifetimePaidCents - a.lifetimePaidCents);
  const highValueCount = Math.max(1, Math.ceil(byLifetimeDesc.length * HIGH_VALUE_TOP_FRACTION));
  const highValueDonorIds = new Set(byLifetimeDesc.slice(0, highValueCount).map((d) => d.donorId));

  const withSignals = classified.map((d) => {
    const signals = signalsFor(d, highValueDonorIds);
    return { ...d, signals, priorityScore: priorityScoreFor(signals, d.lifetimePaidCents) };
  });

  return withSignals.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, params.limit);
}
