// Portfolio Focus -- D1 data-loading layer. THE ONLY file in this
// module that touches the database. Every WHERE clause below is copied
// from lib/workspace/live-data.ts's own live-mode query set (traced
// 2026-08-28) so Portfolio Focus scopes to exactly the same donor
// population every other live surface does -- never a second, looser or
// stricter scoping rule. Read-only: every statement here is a SELECT.
//
// Live data only (owner_user_id/user_id-scoped, data_source='live') --
// Portfolio Focus's entire premise (real financial modeling) has no
// meaning against the sample/demo dataset, so there is no demo branch
// here, unlike lib/workspace/live-data.ts.
//
// Batched via one Promise.all -- a FIXED 12 queries regardless of donor
// count (see docs/AI-HANDOFF.md's Portfolio Focus Phase 1 entry for the
// before/after query-count accounting). No query is issued per-donor.
import { env } from "cloudflare:workers";
import type {
  PortfolioFocusRawData, RawAcknowledgmentRow, RawAskRow, RawDonorRow, RawGivingRow, RawHistoricalContextRow,
  RawImportantDateRow, RawInteractionRow, RawPaymentPlanRow, RawPledgePaymentRow, RawReminderRow, RawRelationshipFactRow, RawYahrtzeitRow,
} from "./aggregate.ts";

export async function loadPortfolioFocusRawData(userId: string): Promise<PortfolioFocusRawData> {
  const [donors, giving, asks, interactions, reminders, yahrtzeits, importantDates, pledgePayments, paymentPlans, relationshipFacts, acknowledgments, historicalContext] = await Promise.all([
    env.DB.prepare(`SELECT id, display_name, donor_code, relationship_summary, institutional_memory FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL`).bind(userId).all<RawDonorRow>(),
    env.DB.prepare(`SELECT id, donor_id, paid_cents, balance_cents, activity_date, category, item_type, description FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')`).bind(userId).all<RawGivingRow>(),
    env.DB.prepare(`SELECT id, donor_id, amount_cents, purpose, status, asked_at, source_interaction_id FROM asks WHERE user_id = ?`).bind(userId).all<RawAskRow>(),
    env.DB.prepare(`SELECT donor_id, type, occurred_at, role FROM interactions WHERE user_id = ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))`).bind(userId).all<RawInteractionRow>(),
    env.DB.prepare(`SELECT id AS recommendation_id, donor_id, action, reason, due_at FROM recommendations WHERE user_id = ? AND status = 'open'`).bind(userId).all<RawReminderRow>(),
    env.DB.prepare(`SELECT donor_id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day FROM yahrtzeits WHERE user_id = ?`).bind(userId).all<RawYahrtzeitRow>(),
    env.DB.prepare(`SELECT donor_id, type, person_name, relationship, month, day, year FROM important_dates WHERE user_id = ?`).bind(userId).all<RawImportantDateRow>(),
    env.DB.prepare(`SELECT pledge_activity_id, payment_date, applied_cents FROM jl_payment_assignment_audits WHERE user_id = ? AND decision_type = 'apply_to_pledge' AND applied_cents > 0 AND payment_date IS NOT NULL`).bind(userId).all<RawPledgePaymentRow>(),
    env.DB.prepare(`SELECT donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at FROM pledge_payment_plans WHERE user_id = ? AND ended_at IS NULL`).bind(userId).all<RawPaymentPlanRow>(),
    env.DB.prepare(`SELECT donor_id, category, lifecycle, status, fact_text, source_interaction_id, source_interaction_occurred_at FROM donor_relationship_facts WHERE user_id = ? AND status = 'current'`).bind(userId).all<RawRelationshipFactRow>(),
    env.DB.prepare(`SELECT donor_id, gift_source, gift_id, status FROM gift_acknowledgments WHERE user_id = ?`).bind(userId).all<RawAcknowledgmentRow>(),
    env.DB.prepare(`SELECT donor_id FROM donor_historical_context WHERE user_id = ? AND status = 'unconfirmed'`).bind(userId).all<RawHistoricalContextRow>(),
  ]);

  return {
    donors: donors.results,
    giving: giving.results,
    asks: asks.results,
    interactions: interactions.results,
    reminders: reminders.results,
    yahrtzeits: yahrtzeits.results,
    importantDates: importantDates.results,
    pledgePayments: pledgePayments.results,
    paymentPlans: paymentPlans.results,
    relationshipFacts: relationshipFacts.results,
    acknowledgments: acknowledgments.results,
    historicalContext: historicalContext.results,
  };
}
