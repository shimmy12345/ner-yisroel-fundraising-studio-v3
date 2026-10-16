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
import { localMonthBoundaries } from "../workspace/local-time.ts";
import {
  summarizeFundraisingProgress,
  NEW_COMMITMENTS_SQL,
  NEW_GIVING_ROWS_SQL,
  PAYMENT_ASSIGNMENT_AUDITS_SQL,
  DONORS_CONTACTED_SQL,
  type NewGivingRow,
  type PaymentAssignmentAuditRow,
} from "./fundraising-progress.ts";
import { donorHref, type DonorRef } from "./conversation-state.ts";

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

// --- 8. Fundraising progress this month -- real, reconciled totals only.
// There is no "goal" or target concept anywhere in this schema (confirmed
// by review, docs/AI-HANDOFF.md).
//
// Rebuilt from first principles (independent code review, "Final
// Financial Accuracy Fix for Ask Fundraising OS", 2026-10-16) after the
// original version was found to: have no upper month boundary (so it
// silently swept in every later month too); exclude only 'open_pledge'
// (so needs_review/nonfinancial_entry/pending_gift/pending_pledge rows
// could be counted as real donations); and filter by activity_date, which
// lib/import/jl-refresh.ts's own doc comment establishes is a pledge's
// DUE DATE, never updated once a payment is applied -- meaning the old
// query could count an old pledge's entire historical paid_cents as
// "this month's" money the instant any one new payment nudged it, or
// miss a genuine same-month payment entirely, depending on where that
// frozen date happened to fall.
//
// The fix: "new commitments" is now gated on created_at (set once at
// insert, never touched by any payment update -- see
// lib/assistant/fundraising-progress.ts's own header comment for the
// full data-model investigation), using the exact same
// REAL_COMMITMENT_CATEGORIES set the Trip Fundraising Results Dashboard
// already uses for "what counts as a real commitment"
// (lib/relationships/trip-financial-attribution.ts), so this capability
// can never disagree with that dashboard about which categories count.
// "Money received" is reconciled by lib/assistant/fundraising-progress.ts's
// summarizeFundraisingProgress against jl_payment_assignment_audits -- the
// one place a payment applied to a pre-existing pledge has an actual
// recorded date -- with an explicit, always-disclosed limitation for the
// payments that do not go through that audited path (see that module).
// event_or_ad (event/ad revenue) is deliberately excluded from both
// figures here, consistent with the Trip Dashboard's own existing
// treatment of that category, not a new decision invented for this
// capability.

export type FundraisingProgress = {
  periodLabel: string;
  moneyReceivedTotal: string;
  // A count of giving/payment ROWS, never distinct donors -- deliberately
  // named so neither this code nor the AI composing an answer from it can
  // relabel it "N donors" (see fundraising-progress.ts's own header
  // comment on this field for why that distinction is load-bearing).
  moneyReceivedTransactionCount: number;
  newGiftsReceivedTotal: string;
  paymentsOnExistingPledgesTotal: string;
  newCommitmentsTotal: string;
  newCommitmentsCount: number;
  donorsContacted: number;
  limitations: string[];
};

function emptyFundraisingProgress(periodLabel: string): FundraisingProgress {
  return { periodLabel, moneyReceivedTotal: money(0), moneyReceivedTransactionCount: 0, newGiftsReceivedTotal: money(0), paymentsOnExistingPledgesTotal: money(0), newCommitmentsTotal: money(0), newCommitmentsCount: 0, donorsContacted: 0, limitations: [] };
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

  const [commitments, newGivingRows, auditRows, contacts] = await Promise.all([
    env.DB.prepare(NEW_COMMITMENTS_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).first<{ n: number; total: number }>(),
    env.DB.prepare(NEW_GIVING_ROWS_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).all<NewGivingRow>(),
    env.DB.prepare(PAYMENT_ASSIGNMENT_AUDITS_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).all<PaymentAssignmentAuditRow>(),
    env.DB.prepare(DONORS_CONTACTED_SQL).bind(ctx.userId, instantStartEpoch, instantEndEpoch).first<{ n: number }>(),
  ]);

  const summary = summarizeFundraisingProgress({
    periodLabel,
    newGivingRows: newGivingRows.results,
    paymentAssignmentAuditRows: auditRows.results,
    newCommitments: { count: commitments?.n ?? 0, committedCents: commitments?.total ?? 0 },
    donorsContacted: contacts?.n ?? 0,
  });

  return {
    periodLabel: summary.periodLabel,
    moneyReceivedTotal: money(summary.moneyReceivedCents),
    moneyReceivedTransactionCount: summary.moneyReceivedTransactionCount,
    newGiftsReceivedTotal: money(summary.newGiftsReceivedCents),
    paymentsOnExistingPledgesTotal: money(summary.paymentsOnExistingPledgesCents),
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
  const rows = await env.DB.prepare(`
    SELECT id, display_name FROM donors
    WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND display_name LIKE ?
    ORDER BY display_name LIMIT ?
  `).bind(ctx.userId, `%${trimmed}%`, MAX_SEARCH_RESULTS).all<{ id: string; display_name: string }>();
  return rows.results.map((row) => ({ donorId: row.id, name: row.display_name, href: donorHref(row.id) }));
}

// The fixed capability registry -- names and one-line descriptions the
// planning prompt (../assistant/orchestrator.ts) shows the model, so new
// capabilities are discoverable without duplicating this list by hand
// elsewhere. The model selects names from here; it is never shown, and
// can never construct, anything else.
export const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  todays_priorities: "Who to contact today or that is overdue -- the exact same list as the home page's Today's Agenda.",
  this_week_priorities: "The most important follow-ups and priorities for this week, including anything overdue or due today.",
  lapsed_relationships: "Donors who have not been contacted in a while and have a relationship contact gap.",
  outstanding_pledges: "Every donor with a real, currently open or partially-paid pledge balance.",
  payment_plans_attention: "Donors whose payment plan is behind and genuinely needs attention right now (a plan with a valid upcoming payment is never included here).",
  donor_summary: "A full relationship summary for one specific named donor: giving history, recent contact, open asks, family dates, and the current suggested action. Also use this to prepare for a meeting with a donor, to summarize recent history with a donor, or to gather what's needed to draft a follow-up message.",
  fundraising_progress: "Real, reconciled totals for this month: money actually received (split into new gifts vs. payments on existing pledges, counted once), new pledge/gift commitments created this month regardless of payment status, and donors contacted. Use this for 'how much did we raise', 'what's new this month', or 'how much came from existing pledges'. There is no fundraising goal/target tracked in this system. May include a disclosed limitation about payments that lack a recorded date -- always relay it if present.",
  search_donors: "Find donors by name when the fundraiser names someone and which specific donor they mean is not yet clear.",
};
