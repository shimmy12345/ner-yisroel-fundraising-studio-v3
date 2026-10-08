import type { WorkspaceBrief } from "./live-data.ts";

// Plain-JSON reshaping of WorkspaceBrief for GET /api/morning-brief --
// pure, no D1, directly unit-testable. Never a second computation of the
// brief itself (loadWorkspaceBrief, the one shared source of truth, is
// the route's job to call) -- this only reshapes its already-computed
// output into the JSON a non-browser consumer needs, same content as
// app/components/BriefExperience.tsx's "Read full brief" panel shows.
export type MorningBriefPriority = { donorId: string; donorName: string; donorCode: string | null; reason: string; why: string; recommendedAction: string };
export type MorningBriefActivity = { id: string; donorId: string; donorName: string; donorCode: string | null; type: string; typeLabel: string; date: string; time: string; period: string; subject: string; note: string };
export type MorningBriefGift = { donorId: string; donorName: string; donorCode: string | null; amount: string; date: string | null };
export type MorningBriefResponse = {
  generatedAt: string;
  overview: string;
  recommendedFocus: string;
  priorities: MorningBriefPriority[];
  todaySchedule: MorningBriefActivity[];
  upcomingActivities: MorningBriefActivity[];
  recentGifts: MorningBriefGift[];
};

function activity(item: WorkspaceBrief["todaySchedule"][number]): MorningBriefActivity {
  return { id: item.id, donorId: item.donorId, donorName: item.donorName, donorCode: item.donorCode, type: item.type, typeLabel: item.typeLabel, date: item.date, time: item.time, period: item.period, subject: item.subject, note: item.note };
}

export function buildMorningBriefResponse(brief: WorkspaceBrief): MorningBriefResponse {
  return {
    generatedAt: new Date(brief.generatedAt * 1000).toISOString(),
    overview: brief.overview,
    recommendedFocus: brief.recommendation,
    // Gift amount/days-since are deliberately NOT split out as separate
    // structured fields here -- they are already embedded in `reason`/
    // `why`'s human-readable prose, the exact same text the Today page's
    // own priority cards show, and not every priority kind even has a
    // gift to report an amount for (e.g. a stale-contact reminder). See
    // docs/AI-HANDOFF.md's "Morning Brief API" entry for the explicit
    // product decision.
    priorities: brief.priorities.map((item) => ({ donorId: item.donorId, donorName: item.name, donorCode: item.donorCode, reason: item.reason, why: item.why, recommendedAction: item.action })),
    todaySchedule: brief.todaySchedule.map(activity),
    upcomingActivities: brief.upcomingActivities.map(activity),
    recentGifts: brief.gifts.map((item) => ({ donorId: item.donorId, donorName: item.name, donorCode: item.donorCode, amount: item.amount, date: item.activityDate ? new Date(item.activityDate * 1000).toISOString() : null })),
  };
}
