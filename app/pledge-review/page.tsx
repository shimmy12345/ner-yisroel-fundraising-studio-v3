import { env } from "cloudflare:workers";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { buildPledgeReviewQueue, type PledgeReviewSourceRow, type PledgePlanSourceRow, type PaymentSourceRow, type PersistedPledgeReviewStatus } from "../../lib/relationships/pledge-review";
import { PledgeReviewList } from "./PledgeReviewList";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ReviewRow = { pledge_activity_id: string; review_status: PersistedPledgeReviewStatus };

// Narrow, temporary cleanup-review surface for the pledges identified in
// docs/PLEDGE-PAYMENT-PLAN-CLEANUP-AUDIT.md -- NOT a CRM-style ongoing
// pledge-management screen, and NOT linked from the main nav (reached by
// direct URL only, same treatment as /health and /rebbeim). The pledge
// queue queries below are read-only SELECTs; the one write path (saving/
// clearing a review decision) lives entirely in
// /api/pledge-payment-plan-reviews/[pledgeActivityId] -- D1 is the
// authoritative store for review decisions, never sessionStorage (see
// PledgeReviewList.tsx's own comment for why sessionStorage still has a
// narrow, non-authoritative role there).
export default async function PledgeReviewPage() {
  const identity = await requireChatGPTUser("/pledge-review");
  const profile = await ensureUserProfile(identity);
  const now = Math.floor(Date.now() / 1000);

  const [pledgesResult, plansResult, paymentsResult, reviewsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT ga.id, ga.donor_id, ga.activity_date, ga.committed_cents, ga.paid_cents, ga.balance_cents,
             ga.description, ga.source_campaign, ga.category, d.donor_code, d.display_name
      FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
      WHERE ga.workspace_status = 'active' AND ga.record_origin = 'live' AND ga.owner_user_id = ?
        AND ga.category IN ('open_pledge','partially_paid_pledge')
    `).bind(profile.id).all<PledgeReviewSourceRow>(),
    env.DB.prepare(`SELECT pledge_activity_id, ended_at FROM pledge_payment_plans WHERE user_id = ?`).bind(profile.id).all<PledgePlanSourceRow>(),
    env.DB.prepare(`SELECT pledge_activity_id, payment_date, applied_cents FROM jl_payment_assignment_audits WHERE user_id = ? AND pledge_activity_id IS NOT NULL`).bind(profile.id).all<PaymentSourceRow>(),
    env.DB.prepare(`SELECT pledge_activity_id, review_status FROM pledge_payment_plan_reviews WHERE user_id = ?`).bind(profile.id).all<ReviewRow>(),
  ]);

  const items = buildPledgeReviewQueue(pledgesResult.results, plansResult.results, paymentsResult.results, now);
  const distinctDonors = new Set(items.map((i) => i.donorId)).size;
  const totalOutstandingCents = items.reduce((sum, i) => sum + i.balanceCents, 0);
  const initialReviews: Record<string, PersistedPledgeReviewStatus> = Object.fromEntries(reviewsResult.results.map((r) => [r.pledge_activity_id, r.review_status]));

  return <AppShell active="donors"><main className="donor-directory pledge-review-page">
    <header className="directory-heading">
      <div>
        <p className="eyebrow">CLEANUP REVIEW</p>
        <h1>Pledge payment-plan review</h1>
        <p>
          {items.length} open/partially-paid pledge{items.length === 1 ? "" : "s"} across {distinctDonors} donor{distinctDonors === 1 ? "" : "s"} with
          no current payment plan, dated within the last 2 years. Total outstanding: {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totalOutstandingCents / 100)}.
        </p>
        <p className="pledge-review-subtext">
          This is a one-time manual triage of the set identified in the payment-plan cleanup audit --
          not an ongoing pledge-management dashboard. Your review choice below is saved (so it survives a
          refresh, a closed browser, or signing in from another device) but it is only a recorded human
          decision -- it never creates a payment plan or changes any pledge, donor, or payment record. A
          separate, already-active payment plan (donor 68231) that has passed its own final expected date
          with balance remaining is intentionally excluded here -- it is documented separately for the
          planned &quot;ending soon&quot; alert feature.
        </p>
      </div>
      <nav className="directory-actions" aria-label="Pledge review actions"><a href="/donors">Back to donors</a></nav>
    </header>
    {items.length === 0
      ? <p className="rebbeim-empty-state">No qualifying pledges right now.</p>
      : <PledgeReviewList items={items} initialReviews={initialReviews} />}
  </main></AppShell>;
}
