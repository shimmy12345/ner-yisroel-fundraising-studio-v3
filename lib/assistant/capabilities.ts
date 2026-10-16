// Ask Fundraising OS -- the assistant's entire data-access surface
// (docs/AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a Real AI
// Assistant"). This is the ONLY way the assistant ever touches donor data:
// a fixed, named set of read-only, authenticated, already-owner-scoped
// functions. The AI never sees a connection, never writes a WHERE clause,
// and never receives anything beyond what one of these functions actually
// returns -- there is no path from a model response to a raw SQL query.
//
// Every capability either reuses an existing, already-reviewed loader
// (loadWorkspaceBrief, loadMeetingBrief -- the exact same functions the
// Today page, donor page, and Meeting Brief page already use, so an
// answer here can never disagree with what those pages show) or a bounded
// query that mirrors an existing proven pattern (the Pledge Review page's
// own balance-correction JOIN) rather than inventing a new way to compute
// a financial figure. No capability performs an INSERT, UPDATE, or DELETE
// -- confirmed by this file containing none, and locked in by
// tests/assistant-capabilities.test.mjs's own no-write assertions.
//
// Result sizes are capped in every capability (never more than
// MAX_RESULT_ITEMS rows) -- both to keep the AI's context small (less for
// it to summarize badly, lower cost) and because no fundraiser conversation
// needs an unbounded dump of donors.

import { env } from "cloudflare:workers";
import { loadWorkspaceBrief, type WorkspacePriority } from "../workspace/live-data.ts";
import { loadMeetingBrief } from "../relationships/meeting-brief.ts";
import type { DataMode } from "../workspace/mode.ts";
import { financialDateLabel } from "../financial-date.ts";
import { localMonthBoundaries, localDateParts } from "../workspace/local-time.ts";
import {
  summarizeGivingHistory,
  GIVING_RECORDS_SQL,
  VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL,
  OPEN_COMMITMENTS_BY_DONOR_SQL,
  LAPSED_YEARS_THRESHOLD,
  type GivingRecordRow,
  type VerifiedPledgePaymentRow,
  type OpenCommitmentRow,
} from "./giving-history.ts";
import {
  summarizeFundraisingProgress,
  NEW_COMMITMENTS_SQL,
  RECORDED_PAID_BALANCE_ROWS_SQL,
  VERIFIED_DATED_PAYMENT_AUDITS_SQL,
  UNDATED_PAYMENT_AUDITS_SQL,
  DONORS_CONTACTED_SQL,
  type NewGivingRow,
  type PaymentAssignmentAuditRow,
} from "./fundraising-progress.ts";
import { donorHref, type DonorRef } from "./conversation-state.ts";
import { DONOR_SEARCH_SQL } from "./donor-authorization.ts";

export const MAX_RESULT_ITEMS = 8;
export const MAX_SEARCH_RESULTS = 6;

export type AssistantContext = {
  userId: string;
  timezone: string;
  mode: DataMode;
  now: number;
};

// Every donor this module ever hands back is wrapped in the shared
// DonorRef shape (../assistant/conversation-state.ts) -- an id, a display
// name, and the exact href the rest of the app already uses for that
// donor's profile. This is what builds the UI's "View donor" links and
// what a follow-up question's donor reference (../assistant/
// conversation.ts) resolves against -- never a bare string name the model
// could have paraphrased or invented.
export type { DonorRef };

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

// --- 1/2. Today's priorities / this week's priorities -- reuses
// loadWorkspaceBrief's own relationshipQueue, the exact same bucketing
// (relationshipQueueBucket) the home page's "Today's Agenda" and "Coming
// up" sections already use. Never re-derived here. ---

export type PriorityItem = { donorId: string; name: string; href: string; label: string; reason: string; why: string; dueLabel: string };

function toPriorityItem(p: WorkspacePriority): PriorityItem {
  return { donorId: p.donorId, name: p.name, href: p.href, label: p.label, reason: p.reason, why: p.why, dueLabel: p.dueLabel };
}

export async function getTodaysPriorities(ctx: AssistantContext): Promise<{ items: PriorityItem[]; donorRefs: DonorRef[] }> {
  const brief = await loadWorkspaceBrief(ctx.userId, ctx.timezone, ctx.mode, ctx.now, undefined, "assistant_capability");
  const items = [...brief.relationshipQueue.overdue, ...brief.relationshipQueue.today].slice(0, MAX_RESULT_ITEMS).map(toPriorityItem);
  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

export async function getThisWeekPriorities(ctx: AssistantContext): Promise<{ items: PriorityItem[]; donorRefs: DonorRef[] }> {
  const brief = await loadWorkspaceBrief(ctx.userId, ctx.timezone, ctx.mode, ctx.now, undefined, "assistant_capability");
  const items = [...brief.relationshipQueue.overdue, ...brief.relationshipQueue.today, ...brief.relationshipQueue.thisWeek].slice(0, MAX_RESULT_ITEMS).map(toPriorityItem);
  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

// --- 3. Lapsed relationships -- the exact same filter the prior
// rule-based Assistant already used (label/reason matching a contact-gap
// phrase), now applied to real priorities instead of being the whole
// answer by itself. ---

export async function getLapsedRelationships(ctx: AssistantContext): Promise<{ items: PriorityItem[]; donorRefs: DonorRef[] }> {
  const brief = await loadWorkspaceBrief(ctx.userId, ctx.timezone, ctx.mode, ctx.now, undefined, "assistant_capability");
  const items = brief.priorities
    .filter((p) => p.label === "Contact gap" || /contact|lapsed|days since/i.test(`${p.label} ${p.reason}`))
    .slice(0, MAX_RESULT_ITEMS)
    .map(toPriorityItem);
  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

// --- 4. Outstanding pledges -- mirrors app/pledge-review/page.tsx's own
// query verbatim (same table JOIN, same pledge_balance_corrections
// override, same category filter): every real, owner-scoped,
// currently-active open/partially-paid pledge with a positive effective
// balance. Deliberately NOT limited to the one recommendation that won
// each donor's single priorities slot (see getPaymentPlansAttention
// below for that, narrower, question) -- "which donors have outstanding
// pledges" means all of them. ---

type OutstandingPledgeRow = { donor_id: string; display_name: string; balance_cents: number; committed_cents: number; description: string | null; activity_date: number | null };

export type OutstandingPledgeItem = { donorId: string; name: string; href: string; balance: string; committed: string; description: string | null; activityDateLabel: string | null };

export async function getOutstandingPledges(ctx: AssistantContext): Promise<{ items: OutstandingPledgeItem[]; donorRefs: DonorRef[] }> {
  if (ctx.mode !== "live") return { items: [], donorRefs: [] };
  const rows = await env.DB.prepare(`
    SELECT ga.donor_id, d.display_name, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents, ga.committed_cents, ga.description, ga.activity_date
    FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.workspace_status = 'active' AND ga.record_origin = 'live' AND ga.owner_user_id = ?
      AND ga.category IN ('open_pledge','partially_paid_pledge')
      AND COALESCE(pbc.corrected_balance_cents, ga.balance_cents) > 0
    ORDER BY COALESCE(pbc.corrected_balance_cents, ga.balance_cents) DESC
    LIMIT ?
  `).bind(ctx.userId, MAX_RESULT_ITEMS).all<OutstandingPledgeRow>();

  const items = rows.results.map((row) => ({
    donorId: row.donor_id,
    name: row.display_name,
    href: donorHref(row.donor_id),
    balance: money(row.balance_cents),
    committed: money(row.committed_cents),
    description: row.description,
    activityDateLabel: row.activity_date ? financialDateLabel(row.activity_date) : null,
  }));
  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

// --- 5. Payment plans needing attention -- reuses brief.priorities'
// "Open commitment" entries, which are only populated via
// isOpenPledgeActionable/evaluateOpenPledgePlanStatus
// (lib/relationships/pledge-payment-plan.ts). This is the load-bearing
// safeguard the task explicitly calls out: a donor with a valid, on-track
// upcoming payment is already excluded by that function, regardless of
// how old the original pledge date is -- never re-decided here. ---

export async function getPaymentPlansAttention(ctx: AssistantContext): Promise<{ items: PriorityItem[]; donorRefs: DonorRef[] }> {
  const brief = await loadWorkspaceBrief(ctx.userId, ctx.timezone, ctx.mode, ctx.now, undefined, "assistant_capability");
  const items = brief.priorities.filter((p) => p.label === "Open commitment").slice(0, MAX_RESULT_ITEMS).map(toPriorityItem);
  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

// --- 5b. Historical giving priorities -- portfolio-wide ranking by real
// lifetime/annual giving history, not the relationship/reminder queue
// (see lib/assistant/giving-history.ts's own header comment for the full
// root-cause story -- "Fix AI Donor Prioritization and Giving-History
// Intelligence," 2026-10-16). Two portfolio-wide, owner-scoped queries
// (never N+1 per donor), then a pure, fully-tested ranking function does
// the actual trend/signal/shortlist work with no AI and no further
// database access. ---

const GIVING_SIGNAL_LABELS: Record<string, string> = {
  high_value: "Historically high-value donor (top quarter of this portfolio by lifetime giving)",
  consistent: "Consistent annual supporter",
  declined: "Giving has declined from this donor's own prior peak year",
  lapsed: `Lapsed -- no recorded gift in the last ${LAPSED_YEARS_THRESHOLD}+ years`,
  insufficient_history: "Not enough giving history yet to judge a trend (based on a single gift or single year)",
  // Set when a donor's lifetime giving is real and substantial but this
  // system cannot verify WHEN each dollar of it actually arrived (see
  // lib/assistant/giving-history.ts's own header) -- a pledge's due date
  // was never a payment date, and a plain reimport can bump a pledge's
  // paid_cents with no payment-review decision, and therefore no date,
  // behind it at all. Deliberately never phrased as "declined" or
  // "lapsed" or "consistent" -- this module has no verified evidence for
  // any of those claims about this donor, only that they have given
  // significantly over time.
  annual_trend_unknown: "Historically significant donor; annual payment trend cannot be reliably determined from available records",
};

export type HistoricalGivingItem = {
  donorId: string;
  name: string;
  href: string;
  lifetimePaid: string;
  giftCount: number;
  annualTrendReliable: boolean;
  distinctGivingYears: number | null;
  firstGivingYear: number | null;
  lastGivingYear: number | null;
  mostRecentPaidDateLabel: string | null;
  peakYear: number | null;
  peakYearAmount: string | null;
  lastGivingYearAmount: string | null;
  yearsSinceLastGift: number | null;
  signals: string[];
  openPledgeBalance: string | null;
  openPledgeCommitted: string | null;
};

export async function getHistoricalGivingPriorities(ctx: AssistantContext): Promise<{ items: HistoricalGivingItem[]; donorRefs: DonorRef[] }> {
  if (ctx.mode !== "live") return { items: [], donorRefs: [] };
  const currentYear = localDateParts(ctx.now, ctx.timezone).year;

  const [givingRecords, verifiedPledgePayments, openCommitmentRows, donorRows] = await Promise.all([
    env.DB.prepare(GIVING_RECORDS_SQL).bind(ctx.userId, ctx.userId).all<GivingRecordRow>(),
    env.DB.prepare(VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL).bind(ctx.userId).all<VerifiedPledgePaymentRow>(),
    env.DB.prepare(OPEN_COMMITMENTS_BY_DONOR_SQL).bind(ctx.userId).all<OpenCommitmentRow>(),
    // archived_at IS NULL: a merged/archived donor record is never a
    // valid cultivation recommendation target, even if their historical
    // giving rows still exist under that id -- this is a deliberately
    // tighter scope than getOutstandingPledges' own name lookup, which
    // has no reason to exclude one (that capability isn't recommending
    // anyone, only explaining an existing balance).
    env.DB.prepare(`SELECT id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL`).bind(ctx.userId).all<{ id: string; display_name: string }>(),
  ]);

  // Over-fetch before the archived-donor filter below so a few filtered-
  // out candidates never silently shrink the final shortlist below
  // MAX_RESULT_ITEMS.
  const candidates = summarizeGivingHistory({ records: givingRecords.results, verifiedPledgePayments: verifiedPledgePayments.results, currentYear, limit: MAX_RESULT_ITEMS * 3 });

  const nameById = new Map(donorRows.results.map((d) => [d.id, d.display_name]));
  const commitmentById = new Map(openCommitmentRows.results.map((r) => [r.donor_id, r]));

  const items: HistoricalGivingItem[] = candidates
    .filter((c) => nameById.has(c.donorId))
    .slice(0, MAX_RESULT_ITEMS)
    .map((c) => {
      const commitment = commitmentById.get(c.donorId);
      return {
        donorId: c.donorId,
        name: nameById.get(c.donorId)!,
        href: donorHref(c.donorId),
        lifetimePaid: money(c.lifetimePaidCents),
        giftCount: c.giftCount,
        annualTrendReliable: c.annualTrendReliable,
        distinctGivingYears: c.distinctGivingYears,
        firstGivingYear: c.firstGivingYear,
        lastGivingYear: c.lastGivingYear,
        mostRecentPaidDateLabel: c.mostRecentPaidDateEpoch !== null ? financialDateLabel(c.mostRecentPaidDateEpoch) : null,
        peakYear: c.peakYear,
        peakYearAmount: c.peakYearCents !== null ? money(c.peakYearCents) : null,
        lastGivingYearAmount: c.lastGivingYearCents !== null ? money(c.lastGivingYearCents) : null,
        yearsSinceLastGift: c.yearsSinceLastGift,
        signals: c.signals.map((s) => GIVING_SIGNAL_LABELS[s]),
        openPledgeBalance: commitment && commitment.balance_cents > 0 ? money(commitment.balance_cents) : null,
        openPledgeCommitted: commitment && commitment.committed_cents > 0 ? money(commitment.committed_cents) : null,
      };
    });

  return { items, donorRefs: items.map((i) => ({ donorId: i.donorId, name: i.name, href: i.href })) };
}

// The deterministic, server-rendered shortlist the final answer ALWAYS
// shows verbatim, regardless of whether the compose model's own prose
// happens to mention every donor ("Final Historical Giving Accuracy and
// AI Ranking Fix," 2026-10-16: a prior Staging test found the ranking
// engine correctly selected the highest-ranked donor, but the small
// Workers AI compose model, working under a 900-token budget, omitted
// that donor from its OWN narrative -- which, before this fix, meant
// the donor's pill was dropped too, since orchestrator.ts only ever
// showed pills for ids the model itself echoed back). Every name, rank,
// lifetime amount, and signal here comes directly from this capability's
// own already-verified, already-ranked `items` -- never re-derived or
// re-worded by the AI. orchestrator.ts appends this (see
// verifiedGivingShortlistFrom) through the same guaranteed-to-survive
// appendFinancialLimitations budget reservation already used for
// mandatory financial disclosures, and separately force-includes every
// one of these donor ids into the turn's referencedDonors so their
// profile-link pills can never be silently dropped either.
export function formatHistoricalGivingShortlist(items: HistoricalGivingItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item, index) => {
    const signalText = item.signals.length > 0 ? ` -- ${item.signals.join("; ")}` : "";
    return `${index + 1}. ${item.name}: ${item.lifetimePaid} lifetime given${signalText}`;
  });
  return ["Verified ranked shortlist by real giving history (complete, server-computed -- always shown in full regardless of the summary above):", ...lines].join("\n");
}

// --- 6/7. Donor summary -- one real, already-owner-scoped donor, using
// loadMeetingBrief (the exact same loader the donor page's "Prepare for
// Meeting" button and the prior rule-based Assistant's meeting-brief task
// both already use). Covers "summarize my relationship," "prepare me for
// a meeting," "what happened recently," and (via lastMeaningfulContact /
// recentInteractions) is also what draftFollowUp below is grounded in. ---

export type DonorSummary = {
  donorId: string;
  name: string;
  href: string;
  relationshipSummary: string | null;
  institutionalMemory: string | null;
  lifetimePaid: string;
  openPledge: string;
  recentGift: { amount: string; dateLabel: string | null; description: string | null } | null;
  lastMeaningfulContact: { type: string; occurredAt: string; summary: string } | null;
  recentInteractions: Array<{ type: string; occurredAt: string; summary: string }>;
  openReminders: Array<{ action: string; reason: string; dueLabel: string | null }>;
  openAsks: Array<{ amount: string | null; purpose: string | null; askedAt: string }>;
  familyImportantDates: Array<{ type: string; label: string; nextOccurrence: string }>;
  suggestedAction: { action: string; why: string } | null;
  unconfirmedHistoricalContext: string[];
};

export async function getDonorSummary(ctx: AssistantContext, donorId: string): Promise<DonorSummary | null> {
  if (ctx.mode !== "live") return null;
  const brief = await loadMeetingBrief(ctx.userId, donorId, ctx.timezone, ctx.now);
  if (!brief) return null;
  return {
    donorId: brief.donor.id,
    name: brief.donor.displayName,
    href: donorHref(brief.donor.id),
    relationshipSummary: brief.relationshipSnapshot.relationshipSummary,
    institutionalMemory: brief.relationshipSnapshot.institutionalMemory,
    lifetimePaid: money(brief.lifetimePaidCents),
    openPledge: money(brief.openPledgeCents),
    recentGift: brief.recentGift ? { amount: money(brief.recentGift.paidCents), dateLabel: brief.recentGift.occurredAt ? financialDateLabel(brief.recentGift.occurredAt) : null, description: brief.recentGift.description } : null,
    lastMeaningfulContact: brief.lastMeaningfulContact ? { type: brief.lastMeaningfulContact.type, occurredAt: financialDateLabel(brief.lastMeaningfulContact.occurredAt), summary: brief.lastMeaningfulContact.summary } : null,
    recentInteractions: brief.recentInteractions.slice(0, MAX_RESULT_ITEMS).map((i) => ({ type: i.type, occurredAt: financialDateLabel(i.occurredAt), summary: i.summary })),
    openReminders: brief.openReminders.slice(0, MAX_RESULT_ITEMS).map((r) => ({ action: r.action, reason: r.reason, dueLabel: r.dueAt ? financialDateLabel(r.dueAt) : null })),
    openAsks: brief.openAsks.slice(0, MAX_RESULT_ITEMS).map((a) => ({ amount: a.amountCents != null ? money(a.amountCents) : null, purpose: a.purpose, askedAt: financialDateLabel(a.askedAt) })),
    familyImportantDates: brief.familyImportantDates.slice(0, MAX_RESULT_ITEMS).map((d) => ({ type: d.type, label: d.shortLabel, nextOccurrence: d.nextOccurrenceLabel })),
    suggestedAction: brief.recommendation ? { action: brief.recommendation.action, why: brief.recommendation.why } : null,
    unconfirmedHistoricalContext: brief.unconfirmedHistoricalContext.slice(0, MAX_RESULT_ITEMS),
  };
}

// --- 8. Fundraising progress this month. There is no "goal" or target concept
// anywhere in this schema (confirmed by review, docs/AI-HANDOFF.md).
//
// Rebuilt across four independent review rounds (2026-10-16) -- see
// lib/assistant/fundraising-progress.ts's own header comment for the
// complete history (an activity_date/due-date bug, two different
// cumulative-balance stability bugs that each fixed the other's defect
// while introducing their own, and finally a mislabeling + a cross-owner
// isolation gap). This capability now reports three EXPLICITLY SEPARATE,
// never-conflated categories, never summed into one undifferentiated
// "total raised" figure:
//   A. Verified dated payments -- a real, individually-dated transaction
//      confirmed through the payment-review screen. Never the import/
//      processing timestamp standing in for a missing payment date.
//   B. Recorded paid balance -- what a pledge/gift first recorded this
//      period shows as paid, as of this period's own end. A fact about
//      the RECORD (reconstructed from giving_activity_import_changes,
//      isolated per-owner via a join through data_imports -- that
//      change-log table has no owner_user_id column of its own, and
//      source_fingerprint is a pure content hash with no user/donor
//      identity folded in, so this isolation is load-bearing, not
//      incidental), never a claim about when the underlying cash was
//      actually received.
//   C. New commitments -- committed_cents of a row first recorded this
//      period, by committed amount, regardless of payment status.
// A payment applied to a PRE-EXISTING pledge through an ordinary
// reimport refresh, with no payment-review decision, remains the one
// gap nothing here can verify -- always disclosed, never guessed at.

export type FundraisingProgress = {
  periodLabel: string;
  // Category A.
  verifiedDatedPaymentsTotal: string;
  // A count of payment-review decisions, never distinct donors --
  // deliberately named so neither this code nor the AI composing an
  // answer from it can relabel it "N donors" (see fundraising-progress.ts's
  // own header comment on this field for why that distinction is
  // load-bearing -- this exact mistake happened live on Staging twice,
  // against two different count fields).
  verifiedDatedPaymentsTransactionCount: number;
  newGiftsViaReviewTotal: string;
  paymentsOnExistingPledgesTotal: string;
  // Category B -- a record-keeping fact, never "received"/"verified."
  recordedPaidBalanceTotal: string;
  // Category C.
  newCommitmentsTotal: string;
  newCommitmentsCount: number;
  donorsContacted: number;
  limitations: string[];
};

function emptyFundraisingProgress(periodLabel: string): FundraisingProgress {
  return { periodLabel, verifiedDatedPaymentsTotal: money(0), verifiedDatedPaymentsTransactionCount: 0, newGiftsViaReviewTotal: money(0), paymentsOnExistingPledgesTotal: money(0), recordedPaidBalanceTotal: money(0), newCommitmentsTotal: money(0), newCommitmentsCount: 0, donorsContacted: 0, limitations: [] };
}

export async function getFundraisingProgress(ctx: AssistantContext): Promise<FundraisingProgress> {
  // The month boundary must be the FUNDRAISER'S local calendar month, not
  // whatever month it happens to be in UTC right now, and must have BOTH
  // an inclusive start and an EXCLUSIVE end -- every column this
  // capability now reads (created_at, payment_date, occurred_at) is a
  // true moment-in-time, so every query uses the instant boundaries, not
  // the date-only ones (independent code review, monthly fundraising
  // totals and timezone boundaries, 2026-10-16).
  const { instantStartEpoch, instantEndEpoch, periodLabel } = localMonthBoundaries(ctx.now, ctx.timezone);

  if (ctx.mode !== "live") return emptyFundraisingProgress(periodLabel);

  const [commitments, recordedPaidBalanceRows, verifiedDatedAuditRows, undatedAuditRows, contacts] = await Promise.all([
    env.DB.prepare(NEW_COMMITMENTS_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).first<{ n: number; total: number }>(),
    // Bind order matches the SQL's own `?` order: periodEnd (the
    // subquery's "first update at/after period end" threshold) first,
    // then userId, then periodStart, then periodEnd again for the
    // outer created_at upper bound -- see RECORDED_PAID_BALANCE_ROWS_SQL's
    // own comment in fundraising-progress.ts.
    env.DB.prepare(RECORDED_PAID_BALANCE_ROWS_SQL).bind(instantEndEpoch, ctx.userId, instantStartEpoch, instantEndEpoch).all<NewGivingRow>(),
    env.DB.prepare(VERIFIED_DATED_PAYMENT_AUDITS_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).all<PaymentAssignmentAuditRow>(),
    // Not period-bound -- a missing payment_date is a data-quality fact
    // about the record, never something to search for within one month.
    // One row per matching audit entry (never pre-aggregated in SQL --
    // see UNDATED_PAYMENT_AUDITS_SQL's own comment).
    env.DB.prepare(UNDATED_PAYMENT_AUDITS_SQL).bind(ctx.userId).all<{ cents: number; paymentFingerprint: string }>(),
    env.DB.prepare(DONORS_CONTACTED_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).first<{ n: number }>(),
  ]);

  const summary = summarizeFundraisingProgress({
    periodLabel,
    recordedPaidBalanceRows: recordedPaidBalanceRows.results,
    verifiedDatedPaymentAuditRows: verifiedDatedAuditRows.results,
    undatedPaymentAudits: {
      count: undatedAuditRows.results.length,
      cents: undatedAuditRows.results.reduce((sum, row) => sum + row.cents, 0),
      fingerprints: undatedAuditRows.results.map((row) => row.paymentFingerprint),
    },
    newCommitments: { count: commitments?.n ?? 0, committedCents: commitments?.total ?? 0 },
    donorsContacted: contacts?.n ?? 0,
  });

  return {
    periodLabel: summary.periodLabel,
    verifiedDatedPaymentsTotal: money(summary.verifiedDatedPaymentsCents),
    verifiedDatedPaymentsTransactionCount: summary.verifiedDatedPaymentsTransactionCount,
    newGiftsViaReviewTotal: money(summary.newGiftsViaReviewCents),
    paymentsOnExistingPledgesTotal: money(summary.paymentsOnExistingPledgesCents),
    recordedPaidBalanceTotal: money(summary.recordedPaidBalanceCents),
    newCommitmentsTotal: money(summary.newCommitmentsCents),
    newCommitmentsCount: summary.newCommitmentsCount,
    donorsContacted: summary.donorsContacted,
    limitations: summary.limitations,
  };
}

// --- 9. Donor search -- a bounded, owner-scoped name search. Used both
// directly (the fundraiser asking to find a donor by name) and internally
// by ../assistant/conversation.ts to resolve a named donor reference in a
// question into a real, owned donor id -- the AI never invents or
// guesses an id itself. ---

export async function searchDonors(ctx: AssistantContext, query: string): Promise<DonorRef[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || ctx.mode !== "live") return [];
  const rows = await env.DB.prepare(DONOR_SEARCH_SQL).bind(ctx.userId, `%${trimmed}%`, MAX_SEARCH_RESULTS).all<{ id: string; display_name: string }>();
  return rows.results.map((row) => ({ donorId: row.id, name: row.display_name, href: donorHref(row.id) }));
}

// The fixed capability registry -- names and one-line descriptions the
// planning prompt (../assistant/orchestrator.ts) shows the model, so new
// capabilities are discoverable without duplicating this list by hand
// elsewhere. The model selects names from here; it is never shown, and
// can never construct, anything else.
export const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  todays_priorities: "Who to contact today or that is overdue -- the exact same list as the home page's Today's Agenda. This is about overdue FOLLOW-UPS and reminders, never about giving amounts or giving history -- do NOT use this for 'which donors should I focus on' or 'prioritize' questions that mention past giving, giving levels, giving history, or donor significance; use historical_giving_priorities for those instead.",
  this_week_priorities: "The most important follow-ups and priorities for this week, including anything overdue or due today. Same scope as todays_priorities, just a wider time window -- never a giving-history ranking. Do NOT use for a question about past giving amounts, giving levels, or which donors are historically significant.",
  lapsed_relationships: "Donors who have not been contacted in a while and have a relationship CONTACT gap (no recent phone call, meeting, or email) -- this is about communication recency, never about giving amounts. A donor who gives generously every year but hasn't been personally contacted belongs here; a donor who used to give a lot but has stopped giving belongs in historical_giving_priorities instead (its own 'lapsed' signal), not here.",
  outstanding_pledges: "Every donor with a real, currently open or partially-paid pledge balance.",
  payment_plans_attention: "Donors whose payment plan is behind and genuinely needs attention right now (a plan with a valid upcoming payment is never included here).",
  donor_summary: "A full relationship summary for one specific named donor: giving history, recent contact, open asks, family dates, and the current suggested action. Also use this to prepare for a meeting with a donor, to summarize recent history with a donor, or to gather what's needed to draft a follow-up message.",
  historical_giving_priorities: "Portfolio-WIDE ranking of donors by their REAL, ACTUAL past giving -- lifetime total given, how many years they have given, their single best year, and whether their giving has stayed consistent, declined from their own prior peak, or lapsed entirely (no gift in 2+ years). THIS is the right capability whenever the fundraiser's question is about giving history, giving levels, giving amounts, lifetime giving, biggest/most significant/major donors, donors whose support has dropped off, previously-generous donors who have gone quiet, or general cultivation priorities based on past support -- including a correction like 'no, based on giving history' or 'based on what they've given, not recent activity.' Every donor it returns comes with real evidence (lifetime total, years giving, trend) -- it never estimates a donor's wealth, capacity, or likelihood to give, only what they have actually, historically given. Never confuse this with todays_priorities/this_week_priorities (those are about overdue follow-ups, not giving amounts) or lapsed_relationships (that is about contact recency, not giving).",
  fundraising_progress: "Reconciled totals for this month, kept as THREE SEPARATE categories, never summed into one 'total raised' figure: (A) verifiedDatedPaymentsTotal -- real, individually-dated payments only, split into new gifts vs. payments on existing pledges; (B) recordedPaidBalanceTotal -- what pledges/gifts first recorded this month show as paid, as of month-end, which is a fact about the RECORD, not proof of when that cash was actually received (always describe it as 'recorded as paid,' never as 'received'); (C) new pledge/gift commitments created this month regardless of payment status. Also donors contacted. Use this for 'how much did we raise' (answer with A, and mention B separately as a recorded balance, not a receipt), 'what's new this month' (C), or 'how much came from existing pledges' (A's paymentsOnExistingPledgesTotal). There is no fundraising goal/target tracked in this system. This is a MONTHLY total, never a donor-level lifetime-giving ranking -- for 'which donors have given the most' use historical_giving_priorities instead. Always relay every disclosed limitation -- never imply any total is complete, and never describe a historical comparison (e.g. a different month) this capability was not actually asked to retrieve.",
  search_donors: "Find donors by name when the fundraiser names someone and which specific donor they mean is not yet clear.",
};
