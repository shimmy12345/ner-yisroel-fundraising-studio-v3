import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { env } from "cloudflare:workers";
import { logger } from "../../../lib/logger";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getDataMode } from "../../../lib/workspace/mode";
import { DONOR_GIVING_SQL } from "../../../lib/relationships/giving";
import { isCancelledActivity, isScheduledActivity, sanitizeScheduledRelationshipContext } from "../../../lib/workspace/scheduled-activity";
import { PendingGiftForm } from "./GivingManagement";
import { countsInGivingTotals } from "../../../lib/giving/management";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";
import { UnifiedRelationshipTimeline } from "./UnifiedRelationshipTimeline";
import { DonorBackNavigation } from "../../components/DonorNavigation";
import { donorBackLabel, donorNavigationHref, meetingBriefNavigationHref, safeDonorOrigin, safeInternalReturnPath } from "../../../lib/navigation/donor-navigation";
import { financialDateLabel } from "../../../lib/financial-date";
import { donorInitials, numericDonorCode } from "../../../lib/relationships/donor-identity";
import { DonorResearch, type IdentityCandidateView, type PendingEvidenceView, type ResearchFindingView, type ResearchSourceView } from "./DonorResearch";
import { buildRecommendationEvidence } from "../../../lib/relationships/recommendation-evidence";
import { buildDonorRecommendation, summarizeRecommendationForSnapshot } from "../../../lib/relationships/recommendation-rank";
import type { GiftAcknowledgmentStatus, GiftSource } from "../../../lib/giving/acknowledgment";
import { GiftAcknowledgmentActions } from "./GivingManagement";
import { ImportantDatesManagement, type ManagedDateItem } from "./ImportantDatesManagement";
import type { HebrewMonthName } from "../../../lib/calendar/hebrew-date.ts";
import type { ImportantDateType } from "../../../lib/important-dates/validation.ts";

export const metadata: Metadata = { title: "Donor relationship" };
export const dynamic = "force-dynamic";
type Donor = { id: string; display_name: string; donor_code: string | null; last_name: string | null; email: string | null; phone: string | null; home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null; primary_first_name: string | null; spouse: string | null; spouse_first_name: string | null; primary_title: string | null; spouse_title: string | null; external_id: string | null; external_source: string | null; contact_note: string | null; relationship_summary: string | null; institutional_memory: string | null; archived_at: number | null; merged_into_donor_id: string | null };
type Activity = { id: string; donor_id: string; external_source: string; activity_date: number | null; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; item_type: string | null; description: string | null; source_campaign: string | null; category: string; workspace_status: string; private_note: string | null; confirmed_by_activity_id: string | null; updated_at: number };
type PaymentEvent = { id: string; payment_date: number; applied_cents: number; remaining_balance_cents: number | null; pledge_activity_id: string; pledge_description: string | null; pledge_campaign: string | null };
type Gift = { id: string; received_at: number; amount_cents: number; fund: string };
type Interaction = { id: string; type: string; occurred_at: number; occurred_at_date_only: number; summary: string; source: string; created_at: number; status_changed_at: number | null; shared_activity_id: string | null; role: string | null; shared_activity_recipient_count: number | null; shared_activity_summary: string | null };
type Recommendation = { id: string; action: string; reason: string; status: string; due_at: number | null; due_at_date_only: number; created_at: number; updated_at: number };
type ContactAudit = { id: string; action: string; changed_fields: string; created_at: number };
type FindingRow = { id: string; category: string; claim: string; status: "current" | "unverified"; related_donor_id: string | null };
type HistoricalContextRow = { id: string; text: string; source_date: number | null; classification: string; source: string; created_at: number };
type SourceRow = { finding_id: string; url: string; title: string; publisher: string | null; published_at: number | null; source_tier: string };
type AcknowledgmentRow = { gift_source: GiftSource; gift_id: string; status: GiftAcknowledgmentStatus; created_at: number };
type YahrtzeitRow = { id: string; deceased_name_english: string; deceased_name_hebrew: string | null; relationship: string; hebrew_month: string; hebrew_day: number; hebrew_year: number | null };
type ImportantDateRow = { id: string; type: ImportantDateType; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null; notes: string | null };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const date = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
const dateTime = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000));

// Temporary diagnostic instrumentation for Error 1102 investigation on this
// route (see incident 2026-08-17 18:56:41 UTC). Wraps an already-issued D1
// promise to record elapsed ms and row count into `marks` -- never a new
// query, never SQL/result content, only timings/counts. Safe to delete
// once the next incident has been diagnosed with real evidence.
function timedAll<T>(marks: Record<string, number>, key: string, promise: Promise<{ results: T[] }>): Promise<{ results: T[] }> {
  const start = Date.now();
  return promise.then((result) => {
    marks[`${key}Ms`] = Date.now() - start;
    marks[`${key}Rows`] = result.results.length;
    return result;
  });
}

export default async function DonorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; origin?: string }> }) {
  const renderStart = Date.now();
  const marks: Record<string, number> = {};
  let d1Calls = 0;
  // cf-ray is Cloudflare's own per-request identifier, set on the incoming
  // Request before it ever reaches this Worker -- reading it here (the same
  // next/headers API app/chatgpt-auth.ts already uses for other headers)
  // lets a future incident's screenshot Ray ID be matched directly against
  // this log line, with no separate correlation mechanism invented.
  const cfRay = (await headers()).get("cf-ray");
  const { id } = await params;
  const requestedNavigation = await searchParams;
  const returnTo = safeInternalReturnPath(requestedNavigation.from, "/donors");
  const origin = safeDonorOrigin(requestedNavigation.origin, returnTo);
  const currentHref = donorNavigationHref(id, returnTo, origin);
  const identity = await requireChatGPTUser(currentHref);
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const donorLookupStart = Date.now();
  const donor = await env.DB.prepare(`SELECT id, display_name, donor_code, last_name, email, phone, home_phone, address_line_1, city, state, postal_code, country, primary_first_name, spouse, spouse_first_name, primary_title, spouse_title, external_id, external_source, contact_note, relationship_summary, institutional_memory, archived_at, merged_into_donor_id FROM donors WHERE id = ? AND ${mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live'"} LIMIT 1`).bind(...(mode === "demo" ? [id] : [id, profile.id])).first<Donor>();
  marks.donorLookupMs = Date.now() - donorLookupStart;
  d1Calls += 1;
  if (!donor) notFound();
  if (mode === "live" && donor.archived_at && donor.merged_into_donor_id) redirect(donorNavigationHref(donor.merged_into_donor_id, returnTo, origin));
  if (mode === "live" && !donor.archived_at) {
    const donorViewsStart = Date.now();
    const viewedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO donor_views (user_id,donor_id,viewed_at) VALUES (?,?,?)
      ON CONFLICT(user_id,donor_id) DO UPDATE SET viewed_at=excluded.viewed_at`).bind(profile.id, donor.id, viewedAt).run();
    marks.donorViewsMs = Date.now() - donorViewsStart;
    d1Calls += 1;
  }
  const [activityResult, giftResult, interactionResult, recommendationResult, paymentEventResult, contactAuditResult, donorDirectoryResult, acknowledgmentResult] = await Promise.all([
    timedAll(marks, "giving", (mode === "demo" ? env.DB.prepare("SELECT id, donor_id, external_source, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, source_campaign, category, workspace_status, private_note, confirmed_by_activity_id, updated_at FROM giving_activities WHERE donor_id = ? AND record_origin = 'sample' ORDER BY activity_date DESC LIMIT 500").bind(id) : env.DB.prepare(DONOR_GIVING_SQL).bind(id, profile.id)).all<Activity>()),
    timedAll(marks, "gifts", env.DB.prepare("SELECT id, received_at, amount_cents, fund FROM gifts WHERE donor_id = ? ORDER BY received_at DESC LIMIT 500").bind(id).all<Gift>()),
    timedAll(marks, "interactions", env.DB.prepare(`SELECT interactions.id, interactions.type, interactions.occurred_at, interactions.occurred_at_date_only, interactions.summary, interactions.source, interactions.created_at, interactions.shared_activity_id, interactions.role, shared_activities.recipient_count AS shared_activity_recipient_count, shared_activities.summary AS shared_activity_summary, ${mode === "demo" ? "NULL" : "(SELECT created_at FROM activity_status_audits WHERE interaction_id=interactions.id AND user_id=? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1)"} AS status_changed_at
      FROM interactions
      LEFT JOIN shared_activities ON shared_activities.id = interactions.shared_activity_id
      WHERE interactions.donor_id = ? ${mode === "demo" ? "" : "AND interactions.user_id = ?"} AND interactions.source NOT LIKE 'archived:%' ORDER BY interactions.occurred_at DESC LIMIT 500`).bind(...(mode === "demo" ? [id] : [profile.id, id, profile.id])).all<Interaction>()),
    timedAll(marks, "reminders", env.DB.prepare(`SELECT id, action, reason, status, due_at, due_at_date_only, created_at, updated_at FROM recommendations WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND status IN ('open','completed') ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, due_at, updated_at DESC LIMIT 200`).bind(...(mode === "demo" ? [id] : [id, profile.id])).all<Recommendation>()),
    timedAll(marks, "paymentEvents", mode === "demo"
      ? Promise.resolve({ results: [] as PaymentEvent[] })
      : env.DB.prepare(`SELECT audit.id, audit.payment_date, audit.applied_cents, audit.remaining_balance_cents,
          audit.pledge_activity_id, pledge.description AS pledge_description, pledge.source_campaign AS pledge_campaign
        FROM jl_payment_assignment_audits audit
        INNER JOIN data_imports batch ON batch.id = audit.import_id AND batch.user_id = audit.user_id AND batch.status IN ('active','completed')
        INNER JOIN giving_activities pledge ON pledge.id = audit.pledge_activity_id AND pledge.owner_user_id = audit.user_id AND pledge.donor_id = audit.donor_id
        WHERE audit.user_id = ? AND audit.donor_id = ? AND audit.decision_type = 'apply_to_pledge'
          AND audit.applied_cents > 0 AND audit.payment_date IS NOT NULL
        ORDER BY audit.payment_date DESC, audit.created_at DESC`).bind(profile.id, id).all<PaymentEvent>()),
    timedAll(marks, "contactAudits", mode === "demo" ? Promise.resolve({ results: [] as ContactAudit[] }) : env.DB.prepare("SELECT id,action,changed_fields,created_at FROM donor_contact_audits WHERE donor_id=? AND user_id=? ORDER BY created_at DESC LIMIT 5").bind(id, profile.id).all<ContactAudit>()),
    timedAll(marks, "donorDirectory", mode === "demo" ? Promise.resolve({ results: [] as DonorSearchRecord[] }) : env.DB.prepare(`SELECT id,display_name AS name,primary_first_name AS primaryFirstName,last_name AS lastName,COALESCE(spouse,spouse_first_name) AS spouse,COALESCE(external_id,donor_code) AS code,email,COALESCE(phone,alternate_mobile_phone,home_phone) AS phone FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL ORDER BY COALESCE(NULLIF(last_name,''),display_name) COLLATE NOCASE,display_name COLLATE NOCASE LIMIT 1000`).bind(profile.id).all<DonorSearchRecord>()),
    // Every acknowledgment event for this donor's gifts, newest first --
    // never joined into giving_activities/gifts; "current status" is
    // computed client-side as the first (newest) row per (source, id).
    timedAll(marks, "acknowledgments", mode === "demo" ? Promise.resolve({ results: [] as AcknowledgmentRow[] }) : env.DB.prepare("SELECT gift_source, gift_id, status, created_at FROM gift_acknowledgments WHERE donor_id=? AND user_id=? ORDER BY created_at DESC LIMIT 2000").bind(id, profile.id).all<AcknowledgmentRow>()),
  ]);
  d1Calls += 4 + (mode === "live" ? 4 : 0);
  const activities = activityResult.results;
  const countedActivities = activities.filter(countsInGivingTotals);
  const paymentEvents = paymentEventResult.results;
  const legacyGifts = giftResult.results;
  const paid = countedActivities.reduce((sum, item) => sum + (item.paid_cents ?? 0), 0) + legacyGifts.reduce((sum, item) => sum + item.amount_cents, 0);
  const open = countedActivities.reduce((sum, item) => sum + Math.max(0, item.balance_cents ?? 0), 0);
  const pledgeIdsWithPaymentEvents = new Set(paymentEvents.map((event) => event.pledge_activity_id));
  const countedActivityIds = new Set(countedActivities.map((item) => item.id));
  const mostRecent = [
    ...paymentEvents.filter((event) => countedActivityIds.has(event.pledge_activity_id)).map((event) => ({ amount: event.applied_cents, occurredAt: event.payment_date })),
    ...countedActivities.filter((item) => !pledgeIdsWithPaymentEvents.has(item.id) && (item.paid_cents ?? 0) > 0 && item.activity_date).map((item) => ({ amount: item.paid_cents ?? 0, occurredAt: item.activity_date! })),
    ...legacyGifts.map((gift) => ({ amount: gift.amount_cents, occurredAt: gift.received_at })),
  ].sort((a, b) => b.occurredAt - a.occurredAt)[0];
  const people = [donor.primary_first_name && `${donor.primary_title ? `${donor.primary_title} ` : ""}${donor.primary_first_name}`, (donor.spouse || donor.spouse_first_name) && `${donor.spouse_title ? `${donor.spouse_title} ` : ""}${donor.spouse || donor.spouse_first_name}`].filter(Boolean).join(" & ");
  const address = [donor.address_line_1, [donor.city, donor.state, donor.postal_code].filter(Boolean).join(" "), donor.country].filter(Boolean);
  const next = recommendationResult.results.find((item) => item.status === "open");
  const completedInteractions = interactionResult.results.filter((item) => !isScheduledActivity(item.source, item.occurred_at, item.created_at) && !isCancelledActivity(item.source));
  const relationshipContext = sanitizeScheduledRelationshipContext(donor.relationship_summary, donor.institutional_memory, interactionResult.results.map((item) => ({ type: item.type, summary: item.summary, source: item.source, occurredAt: item.occurred_at, createdAt: item.created_at })));
  const donorDirectoryHref = returnTo === "/donors" || returnTo.startsWith("/donors?") ? returnTo : "/donors";
  const donorCode = numericDonorCode({ donorCode: donor.donor_code, externalId: donor.external_id });

  // Donor Research (Stage A): live-mode only, matching every other
  // write-capable feature on this page. Manual-entry only -- no outbound
  // network call is made anywhere in loading this section.
  let researchViewProps: { lastResearchedAt: number | null; openRun: { id: string; pendingEvidence: PendingEvidenceView[]; candidates: IdentityCandidateView[] } | null; findings: ResearchFindingView[] } = { lastResearchedAt: null, openRun: null, findings: [] };
  const donorResearchStart = Date.now();
  if (mode === "live") {
    const [lastRun, openRunRow, findingRows] = await Promise.all([
      env.DB.prepare("SELECT completed_at FROM donor_research_runs WHERE donor_id=? AND user_id=? AND status='completed' ORDER BY completed_at DESC LIMIT 1").bind(id, profile.id).first<{ completed_at: number }>(),
      env.DB.prepare("SELECT id FROM donor_research_runs WHERE donor_id=? AND user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").bind(id, profile.id).first<{ id: string }>(),
      env.DB.prepare("SELECT id, category, claim, status, related_donor_id FROM donor_research_findings WHERE donor_id=? AND user_id=? AND status IN ('current','unverified') ORDER BY created_at DESC").bind(id, profile.id).all<FindingRow>(),
    ]);
    const findings = findingRows.results;
    const [openRunDetail, sourceRows, relatedDonorRows] = await Promise.all([
      openRunRow ? Promise.all([
        env.DB.prepare("SELECT id, url, title FROM donor_research_pending_evidence WHERE run_id=? ORDER BY created_at").bind(openRunRow.id).all<PendingEvidenceView>(),
        env.DB.prepare("SELECT id, label, status FROM donor_research_identity_candidates WHERE run_id=? ORDER BY created_at DESC").bind(openRunRow.id).all<IdentityCandidateView>(),
      ]) : Promise.resolve(null),
      findings.length ? env.DB.prepare(`SELECT fs.finding_id, s.url, s.title, s.publisher, s.published_at, s.source_tier FROM donor_research_finding_sources fs JOIN donor_research_sources s ON s.id = fs.source_id WHERE fs.finding_id IN (${findings.map(() => "?").join(",")})`).bind(...findings.map((finding) => finding.id)).all<SourceRow>() : Promise.resolve({ results: [] as SourceRow[] }),
      findings.some((finding) => finding.related_donor_id) ? env.DB.prepare(`SELECT id, display_name FROM donors WHERE id IN (${[...new Set(findings.map((finding) => finding.related_donor_id).filter((value): value is string => Boolean(value)))].map(() => "?").join(",")})`).bind(...[...new Set(findings.map((finding) => finding.related_donor_id).filter((value): value is string => Boolean(value)))]).all<{ id: string; display_name: string }>() : Promise.resolve({ results: [] as Array<{ id: string; display_name: string }> }),
    ]);
    const relatedDonorNameById = new Map(relatedDonorRows.results.map((row) => [row.id, row.display_name]));
    const sourcesByFinding = new Map<string, ResearchSourceView[]>();
    for (const row of sourceRows.results) sourcesByFinding.set(row.finding_id, [...(sourcesByFinding.get(row.finding_id) ?? []), { url: row.url, title: row.title, publisher: row.publisher, publishedAt: row.published_at, sourceTier: row.source_tier }]);
    researchViewProps = {
      lastResearchedAt: lastRun?.completed_at ?? null,
      openRun: openRunRow && openRunDetail ? { id: openRunRow.id, pendingEvidence: openRunDetail[0].results, candidates: openRunDetail[1].results } : null,
      findings: findings.map((finding) => ({ id: finding.id, category: finding.category, claim: finding.claim, status: finding.status, relatedDonorName: finding.related_donor_id ? relatedDonorNameById.get(finding.related_donor_id) : null, sources: sourcesByFinding.get(finding.id) ?? [] })),
    };
    d1Calls += 3 + (openRunRow ? 2 : 0) + (findings.length ? 1 : 0) + (findings.some((finding) => finding.related_donor_id) ? 1 : 0);
  }
  marks.donorResearchMs = Date.now() - donorResearchStart;

  // Historical context: never queried by any interaction/recommendation
  // read path on this page (completedInteractions, next, recommendationResult
  // above are all built before this block and do not reference this table) --
  // kept structurally separate so it can never be mistaken for confirmed
  // relationship history. Only 'unconfirmed' rows are shown; there is no
  // 'confirmed' status to filter for (see db/schema.ts).
  const historicalContextStart = Date.now();
  const historicalContextRows = mode === "live"
    ? (await env.DB.prepare("SELECT id, text, source_date, classification, source, created_at FROM donor_historical_context WHERE donor_id=? AND user_id=? AND status='unconfirmed' ORDER BY created_at DESC LIMIT 200").bind(id, profile.id).all<HistoricalContextRow>()).results
    : [];
  marks.historicalContextMs = Date.now() - historicalContextStart;
  marks.historicalContextRows = historicalContextRows.length;
  if (mode === "live") d1Calls += 1;

  // Yahrtzeits: family background context, never an interaction, never
  // counted toward Last Contact, never part of relationship_summary/
  // institutional_memory generation -- kept structurally separate exactly
  // like historical context above.
  const yahrtzeitsStart = Date.now();
  const yahrtzeitRows = mode === "live"
    ? (await env.DB.prepare("SELECT id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day, hebrew_year FROM yahrtzeits WHERE donor_id=? AND user_id=? ORDER BY hebrew_month, hebrew_day").bind(id, profile.id).all<YahrtzeitRow>()).results
    : [];
  marks.yahrtzeitsMs = Date.now() - yahrtzeitsStart;
  marks.yahrtzeitsRows = yahrtzeitRows.length;
  if (mode === "live") d1Calls += 1;
  const importantDatesStart = Date.now();
  const importantDateRows = mode === "live"
    ? (await env.DB.prepare("SELECT id, type, person_name, relationship, month, day, year, notes FROM important_dates WHERE donor_id=? AND user_id=? ORDER BY month, day").bind(id, profile.id).all<ImportantDateRow>()).results
    : [];
  marks.importantDatesMs = Date.now() - importantDatesStart;
  marks.importantDatesRows = importantDateRows.length;
  if (mode === "live") d1Calls += 1;
  const managedDateItems: ManagedDateItem[] = [
    ...yahrtzeitRows.map((row): ManagedDateItem => ({
      id: row.id,
      kind: "yahrtzeit",
      deceasedNameEnglish: row.deceased_name_english,
      deceasedNameHebrew: row.deceased_name_hebrew,
      relationship: row.relationship,
      hebrewMonth: row.hebrew_month as HebrewMonthName,
      hebrewDay: row.hebrew_day,
      hebrewYear: row.hebrew_year,
    })),
    ...importantDateRows.map((row): ManagedDateItem => ({
      id: row.id,
      kind: row.type,
      personName: row.person_name,
      relationship: row.relationship,
      month: row.month,
      day: row.day,
      year: row.year,
      notes: row.notes,
    })),
  ];

  // Suggested Action: the one canonical, evidence-driven recommendation
  // for this donor, shared with Meeting Brief/Assistant/homepage via the
  // same lib/relationships/recommendation-* engine -- never derived
  // independently here. Reuses data already loaded above; no new queries.
  // Newest row per (gift_source, gift_id) wins since acknowledgmentResult
  // is already ordered newest-first -- this is "current status", with
  // every earlier mark preserved underneath it in the table itself.
  const acknowledgmentByGift = new Map<string, GiftAcknowledgmentStatus>();
  for (const row of acknowledgmentResult.results) {
    const key = `${row.gift_source}:${row.gift_id}`;
    if (!acknowledgmentByGift.has(key)) acknowledgmentByGift.set(key, row.status);
  }
  const acknowledgmentsRecord = Object.fromEntries(acknowledgmentByGift);
  const paidFromActivities = countedActivities.filter((item) => (item.paid_cents ?? 0) > 0 && item.activity_date !== null).map((item) => ({ giftSource: "giving_activity" as GiftSource, giftId: item.id, amountCents: item.paid_cents!, occurredAt: item.activity_date!, campaign: item.source_campaign, description: item.description || item.item_type, acknowledged: acknowledgmentByGift.has(`giving_activity:${item.id}`) }));
  const paidFromLegacy = legacyGifts.map((gift) => ({ giftSource: "gift" as GiftSource, giftId: gift.id, amountCents: gift.amount_cents, occurredAt: gift.received_at, campaign: gift.fund as string | null, description: null as string | null, acknowledged: acknowledgmentByGift.has(`gift:${gift.id}`) }));
  const mostRecentPaidGiftForEvidence = [...paidFromActivities, ...paidFromLegacy].sort((a, b) => b.occurredAt - a.occurredAt)[0] ?? null;
  const openPledgeSource = countedActivities.find((item) => (item.balance_cents ?? 0) > 0);
  const openPledgeForEvidence = openPledgeSource ? { balanceCents: openPledgeSource.balance_cents ?? 0, campaign: openPledgeSource.source_campaign, description: openPledgeSource.description || openPledgeSource.item_type, activityDate: openPledgeSource.activity_date } : null;
  const lastCompletedInteractionForEvidence = completedInteractions[0] ? { type: completedInteractions[0].type, summary: completedInteractions[0].summary, occurredAt: completedInteractions[0].occurred_at } : null;
  // Excludes role='recipient' -- see lastSubstantiveContactAt's doc comment
  // in recommendation-evidence.ts. lastContactAt below (Last Contact
  // display, and "Last meaningful contact" in the aside) is unaffected.
  const latestSubstantiveInteraction = completedInteractions.find((item) => item.role !== "recipient");
  const evidenceStart = Date.now();
  const recommendationEvidence = buildRecommendationEvidence({
    donorId: id,
    mostRecentPaidGift: mostRecentPaidGiftForEvidence,
    openPledge: openPledgeForEvidence,
    lastCompletedInteraction: lastCompletedInteractionForEvidence,
    lastContactAt: completedInteractions[0]?.occurred_at ?? null,
    lastSubstantiveContactAt: latestSubstantiveInteraction?.occurred_at ?? null,
    openReminder: next ? { action: next.action, reason: next.reason, dueAt: next.due_at } : null,
    relationshipSummary: donor.relationship_summary,
    institutionalMemory: donor.institutional_memory,
    historicalContext: historicalContextRows.map((row) => ({ text: row.text, source: row.source, sourceDate: row.source_date })),
    yahrtzeits: yahrtzeitRows.map((row) => ({ deceasedNameEnglish: row.deceased_name_english, deceasedNameHebrew: row.deceased_name_hebrew, relationship: row.relationship, hebrewMonth: row.hebrew_month as HebrewMonthName, hebrewDay: row.hebrew_day })),
    importantDates: importantDateRows.map((row) => ({ type: row.type, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year })),
  }, Math.floor(Date.now() / 1000), profile.timezone);
  const recommendation = buildDonorRecommendation(recommendationEvidence);
  const recommendationSummary = recommendation ? summarizeRecommendationForSnapshot(recommendation) : null;
  marks.evidenceMs = Date.now() - evidenceStart;

  // Single compact structured log line, timings/counts only -- no donor
  // name, email, phone, gift/interaction/note content, or query SQL.
  // donorId is truncated to 8 chars: enough to match a future screenshot's
  // Ray ID/donor ID against this line without logging the full identifier.
  logger.info("donor_page_render", {
    donorId: donor.id.slice(0, 8),
    mode,
    cfRay,
    d1Calls,
    totalMs: Date.now() - renderStart,
    ...marks,
  });

  return <AppShell active="donors"><div className="donor-breadcrumb"><a href="/">Workspace</a><span>/</span><a href={donorDirectoryHref}>Donors</a><span>/</span><strong>{donor.display_name}</strong></div>
    <DonorBackNavigation returnTo={returnTo} label={donorBackLabel(origin)} />
    <header className="donor-header"><div className="donor-identity"><div className="avatar donor-avatar">{donorInitials({ displayName: donor.display_name, primaryFirstName: donor.primary_first_name, lastName: donor.last_name })}</div><div><div className="identity-line"><div><h1>{donor.display_name}</h1>{donorCode && <span className="donor-code donor-header-code">{donorCode}</span>}</div>{mode === "demo" ? <span className="relationship-badge">Demo record</span> : <span className="relationship-badge">{donor.external_source === "Manual" ? "Manual" : "JL Solutions"}</span>}</div>{people && <p>{people}</p>}<div className="contact-row">{donor.email && <a href={`mailto:${donor.email}`}>✉ {donor.email}</a>}{donor.phone && <a href={`tel:${donor.phone.replace(/\D/g, "")}`}>☎ {donor.phone}</a>}</div></div></div>{mode === "live" && <div className="header-actions"><a href={`/donors/${encodeURIComponent(id)}/edit`}>Edit Contact Details</a><a href={`/donors/${encodeURIComponent(id)}/resolve-duplicate`}>Resolve Duplicate</a><a href={`/capture?donorId=${encodeURIComponent(id)}`}>＋ Log interaction</a></div>}</header>
    {mode === "live" && <nav className="meeting-brief-entry" aria-label="Meeting preparation"><div><strong>Meeting coming up?</strong><span>Review a concise brief built only from this donor’s live record.</span></div><a href={meetingBriefNavigationHref(id, currentHref, origin)}>Prepare for Meeting</a></nav>}
    <section className="donor-snapshot-grid"><article className="snapshot-card"><p>Lifetime paid</p><strong>{money(paid)}</strong><span>{countedActivities.length + legacyGifts.length} confirmed giving record{countedActivities.length + legacyGifts.length === 1 ? "" : "s"}</span></article><article className="snapshot-card"><p>Most recent paid gift</p><strong>{mostRecent ? money(mostRecent.amount) : "—"}</strong><span>{mostRecent ? financialDateLabel(mostRecent.occurredAt) : "No paid gift recorded"}</span></article><article className="snapshot-card"><p>Open commitments</p><strong>{money(open)}</strong><span>From included giving history</span></article><article className="snapshot-card"><p>Suggested action</p><strong>{recommendationSummary?.headline || "None available"}</strong>{recommendationSummary?.supporting && <span className="snapshot-supporting">{recommendationSummary.supporting}</span>}<span>{recommendation?.timing || "No dated urgency"}</span></article></section>
    <div className="relationship-grid"><main className="relationship-main">
      <section className="story-card ai-summary-card"><div className="card-heading"><div><p className="eyebrow">RELATIONSHIP SNAPSHOT</p><h2>{relationshipContext.summary ? "Prepare for the next interaction" : "No relationship snapshot yet"}</h2></div></div><p className="summary">{relationshipContext.summary || "Log a completed interaction to begin a practical snapshot from this household’s actual activity."}</p><div className="next-action"><div className="next-action-icon">→</div><div><p className="eyebrow">SUGGESTED ACTION</p><h3>{recommendation?.action || "No suggested action available"}</h3><p>{recommendation?.why || "Add a reminder, or log an interaction, to generate a suggested next step."}</p>{recommendation && <p className="recommendation-evidence">{recommendation.evidence.join(" ")}</p>}{recommendation?.timing && <p className="recommendation-meta">{recommendation.timing}</p>}{recommendation?.kind === "reconnect_contact_gap" && completedInteractions[0] && completedInteractions[0].occurred_at > Math.floor(Date.now() / 1000) - 90 * 86400 && <p className="recommendation-clarifier">Last Contact reflects every touch, including broadcast texts/emails sent to many donors at once. This suggestion looks at substantive, one-to-one contact only.</p>}{mode === "live" && recommendation?.kind === "acknowledge_gift" && recommendation.giftSource && recommendation.giftId && <GiftAcknowledgmentActions giftSource={recommendation.giftSource} giftId={recommendation.giftId} initialStatus={null} compact />}</div></div>{mode === "live" && historicalContextRows.length > 0 && <details className="historical-context-disclosure"><summary>Imported context ({historicalContextRows.length})</summary><p className="historical-context-lede">Notes imported from external sources. Not logged interactions — never counted as contact, and never assumed to have actually happened.</p><div className="historical-context-list">{historicalContextRows.map((row) => <article key={row.id} className="historical-context-entry"><p className="historical-context-text">“{row.text}”</p><p className="historical-context-provenance">{row.source === "import-monday" ? "Monday.com" : row.source}{row.source_date ? ` · ${date(row.source_date, profile.timezone)}` : ""} · Completion was never confirmed.</p></article>)}</div></details>}</section>
      <section className="story-card memory-card"><div className="card-heading"><div><p className="eyebrow">INSTITUTIONAL MEMORY</p><h2>{relationshipContext.memory ? "Recorded relationship context" : "No institutional memory recorded"}</h2></div></div>{relationshipContext.memory && <p className="summary">{relationshipContext.memory}</p>}</section>
      {mode === "live" && <DonorResearch donorId={id} lastResearchedAt={researchViewProps.lastResearchedAt} openRun={researchViewProps.openRun} findings={researchViewProps.findings} />}
      {mode === "live" && <section className="story-card yahrtzeit-card"><div className="card-heading"><div><p className="eyebrow">IMPORTANT DATES</p><h2>Birthdays, anniversaries, and remembrance dates</h2><p>Background context, not a logged interaction. Never counted as contact.</p></div></div><ImportantDatesManagement donorId={id} timezone={profile.timezone} items={managedDateItems} /></section>}
      <section className="story-card timeline unified-relationship-timeline"><div className="card-heading"><div><p className="eyebrow">UNIFIED RELATIONSHIP TIMELINE</p><h2>One chronological story</h2><p>Giving, conversations, reminders, and scheduled work—ordered by when each event happened or is due.</p></div>{mode === "live" && <PendingGiftForm donors={donorDirectoryResult.results} initialDonorId={id} />}</div><UnifiedRelationshipTimeline donorId={id} giving={activities} legacyGifts={legacyGifts} payments={paymentEvents} interactions={interactionResult.results} reminders={recommendationResult.results} donors={donorDirectoryResult.results} timezone={profile.timezone} live={mode === "live"} now={Math.floor(Date.now() / 1000)} acknowledgments={acknowledgmentsRecord} /></section>
    </main><aside className="relationship-rail"><section className="detail-card"><div className="detail-heading"><h2>Household</h2></div><dl className="at-a-glance"><div><dt>Members</dt><dd>{people || "Not supplied"}</dd></div><div><dt>{donor.external_source === "Manual" ? "Source" : "JL reference"}</dt><dd>{donor.external_source === "Manual" ? "Manual" : donor.external_id || donor.donor_code || "Not supplied"}</dd></div><div><dt>Last meaningful contact</dt><dd>{completedInteractions[0] ? date(completedInteractions[0].occurred_at, profile.timezone) : "None recorded"}</dd></div></dl></section><section className="detail-card"><div className="detail-heading"><h2>Contact</h2></div><div className="facts contact-facts">{donor.email && <div className="fact"><label>Email</label><a href={`mailto:${donor.email}`}>{donor.email}</a></div>}{donor.phone && <div className="fact"><label>Mobile</label><a href={`tel:${donor.phone.replace(/\D/g, "")}`}>{donor.phone}</a></div>}{donor.home_phone && <div className="fact"><label>Home</label><a href={`tel:${donor.home_phone.replace(/\D/g, "")}`}>{donor.home_phone}</a></div>}{address.length > 0 && <div className="fact"><label>Mailing address</label>{address.map((line) => <p key={line}>{line}</p>)}</div>}{donor.contact_note && <div className="fact"><label>Contact note</label><p>{donor.contact_note}</p></div>}</div></section>{contactAuditResult.results.length > 0 && <section className="detail-card contact-audit"><div className="detail-heading"><h2>Contact history</h2></div>{contactAuditResult.results.map((audit) => { let fields: string[] = []; try { fields = JSON.parse(audit.changed_fields); } catch { fields = []; } return <div key={audit.id}><strong>{audit.action === "created" ? "Contact created" : audit.action === "merged_with_jl" ? "Linked to JL record" : "Contact updated"}</strong><span>{dateTime(audit.created_at, profile.timezone)}</span>{fields.length > 0 && <small>{fields.join(", ")}</small>}</div>; })}</section>}</aside></div>
  </AppShell>;
}
