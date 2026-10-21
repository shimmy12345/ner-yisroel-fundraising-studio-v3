import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../../components/AppShell";
import { requireChatGPTUser } from "../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../lib/auth/profile";
import { getProspectMeetingNotesTarget } from "../../../../../../lib/relationships/trips-data";
import { MeetingNotesExperience } from "../../../../../donors/[id]/meeting-notes/MeetingNotesExperience";

export const metadata: Metadata = { title: "AI meeting notes" };
export const dynamic = "force-dynamic";

// AI meeting notes from Trip Planning (2026-10-21, see docs/AI-HANDOFF.md).
// Reuses the donor profile's own MeetingNotesExperience (same Organize-
// with-AI workflow, same /api/meeting-notes save route) rather than a
// separate trip-only notes UI -- only the target interaction and the
// return destination differ, via `tripContext`/`initialSummaryText`.
export default async function TripProspectMeetingNotesPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; prospectId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { id: tripId, prospectId } = await params;
  const identity = await requireChatGPTUser(`/travel-planning/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}/meeting-notes`);
  const profile = await ensureUserProfile(identity);

  // Never fabricates an interaction here -- a prospect whose meeting
  // hasn't been scheduled or completed yet has no reliable interaction
  // to attach AI notes to (see getProspectMeetingNotesTarget's own doc
  // comment in lib/relationships/trips-data.ts). The trip dashboard
  // itself never links to this page for such a prospect; this is a
  // defensive backstop against a stale/guessed/crafted URL.
  const target = await getProspectMeetingNotesTarget(profile.id, tripId, prospectId);
  if (!target.ok) notFound();

  // Only ever a path back into THIS trip -- never an arbitrary redirect
  // target -- so the fundraiser's tab/search/filter state on the trip
  // dashboard survives opening and closing this screen.
  const requestedReturnTo = (await searchParams).returnTo;
  const tripPath = `/travel-planning/${encodeURIComponent(tripId)}`;
  const returnTo = requestedReturnTo && requestedReturnTo.startsWith(tripPath) ? requestedReturnTo : tripPath;

  return <AppShell active="today">
    <MeetingNotesExperience
      donorId={target.donorId}
      donorName={target.donorDisplayName}
      returnTo={returnTo}
      initialNow={new Date().toISOString()}
      tripContext={{ tripId, prospectId }}
      initialSummaryText={target.existingSummary}
    />
  </AppShell>;
}
