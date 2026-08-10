import type { Metadata } from "next";
import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { isoDate, suggestedDonationRange } from "../../../lib/import/jl-refresh";
import { IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL } from "../../../lib/data-health/queries";
import { countUnresolvedDecisions } from "../../../lib/import/preview-session";
import { ImportExperience, type RefreshOverview } from "./ImportExperience";

export const metadata: Metadata = { title: "Import donor data" };
export const dynamic = "force-dynamic";

type RefreshRow = { last_household_refresh_at: number | null; last_donation_refresh_at: number | null; last_donation_range_start: number | null; last_donation_range_end: number | null };
type HistoryRow = { id: string; file_name: string; status: string; completed_at: number | null; report_json: string };

export default async function ImportPage() {
  const identity = await requireChatGPTUser("/onboarding/import");
  const profile = await ensureUserProfile(identity);
  const [state, imports, sessions] = await Promise.all([
    env.DB.prepare("SELECT last_household_refresh_at, last_donation_refresh_at, last_donation_range_start, last_donation_range_end FROM jl_refresh_state WHERE user_id = ? LIMIT 1").bind(profile.id).first<RefreshRow>(),
    env.DB.prepare("SELECT id, file_name, status, completed_at, report_json FROM data_imports WHERE user_id = ? AND status IN ('completed','undone','rolled_back','failed') ORDER BY completed_at DESC, created_at DESC LIMIT 12").bind(profile.id).all<HistoryRow>(),
    // Same canonical, decisions_json-based review-state query Workspace
    // Health uses (lib/data-health/queries.ts) -- never a completed import's
    // frozen report_json, which stops meaning "still pending" the moment a
    // row is explicitly decided (see countUnresolvedDecisions).
    env.DB.prepare(IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL).bind(profile.id).all<{ status: string; decisions_json: string; expires_at: number }>(),
  ]);
  const suggestion = suggestedDonationRange(state?.last_donation_range_end ?? null);
  let latestCompletedDonationId: string | null = null;
  let latestCompletedHouseholdId: string | null = null;
  const parsedImports = (imports.results ?? []).map((row) => {
    let report: Record<string, unknown> = {};
    try { report = JSON.parse(row.report_json) as Record<string, unknown>; } catch { /* keep history readable */ }
    if (!latestCompletedDonationId && row.status === "completed" && report.profile === "JL Solutions Donations") latestCompletedDonationId = row.id;
    const refresh = report.refresh as { kind?: string } | undefined;
    const household = report.profile !== "JL Solutions Donations" && (refresh?.kind === "household" || report.profile === "JL Solutions" || report.profile === "General spreadsheet");
    if (!latestCompletedHouseholdId && row.status === "completed" && household) latestCompletedHouseholdId = row.id;
    return { row, report };
  });
  const history = parsedImports.map(({ row, report }) => {
    const donation = report.donation as { newActivities?: number; updatedPledges?: number; unchanged?: number } | undefined;
    const imported = report.imported as { donors?: number } | undefined;
    const undoKind = row.id === latestCompletedDonationId ? "donation" as const : row.id === latestCompletedHouseholdId ? "household" as const : null;
    return { id: row.id, fileName: row.file_name, status: row.status, canUndo: Boolean(undoKind), undoKind, completedAt: row.completed_at ? new Date(row.completed_at * 1000).toISOString() : null,
      kind: report.profile === "JL Solutions Donations" ? "Donation" : report.profile === "JL Solutions" ? "Household" : "Spreadsheet",
      summary: donation ? `${donation.newActivities ?? 0} new · ${donation.updatedPledges ?? 0} updated · ${donation.unchanged ?? 0} unchanged` : `${imported?.donors ?? 0} households processed` };
  });
  const now = Math.floor(Date.now() / 1000);
  // Only active, unexpired drafts can hold a genuinely unresolved decision --
  // a committed session's last-saved decisions_json can lag behind exactly
  // what was submitted at commit time (the debounced draft-save is not
  // guaranteed to have fired again after the final decision was made), and
  // every decision-driven review path already blocks commit on a real
  // unresolved fingerprint before anything is written. Counting a committed
  // session here would risk exactly the stale-count bug this fixes.
  const pendingReviews = (sessions.results ?? [])
    .filter((session) => session.status === "draft" && session.expires_at > now)
    .reduce((sum, session) => sum + countUnresolvedDecisions(session.decisions_json), 0);
  const refreshOverview: RefreshOverview = {
    lastHouseholdRefreshAt: state?.last_household_refresh_at ? new Date(state.last_household_refresh_at * 1000).toISOString() : null,
    lastDonationRefreshAt: state?.last_donation_refresh_at ? new Date(state.last_donation_refresh_at * 1000).toISOString() : null,
    lastDonationRangeStart: isoDate(state?.last_donation_range_start ?? null), lastDonationRangeEnd: isoDate(state?.last_donation_range_end ?? null),
    suggestedRangeStart: isoDate(suggestion.start), suggestedRangeEnd: isoDate(suggestion.end),
    pendingReviews,
    undoAvailable: history.filter((item) => item.canUndo).length,
    history,
  };
  return <ImportExperience refreshOverview={refreshOverview} initialReviewMode={profile.importReviewMode} />;
}
