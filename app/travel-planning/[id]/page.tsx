import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getTrip, listTripProspects, listDonorsForTripSearch, listTripFinancialAttributions } from "../../../lib/relationships/trips-data";
import { summarizeTripFinancials } from "../../../lib/relationships/trip-financial-attribution";
import { TripDashboardExperience } from "./TripDashboardExperience";

export const metadata: Metadata = { title: "Trip" };
export const dynamic = "force-dynamic";

// Deliberate Prospect Selection (2026-10-18) -- initial tab/search/filter
// state is read from the URL, exactly like app/donors/page.tsx's own
// region/city filters, so a bookmarked or returned-to link (via
// donorNavigationHref's `from` round trip after visiting a donor
// profile) reopens the trip on the same tab with the same search and
// filters, never reset to the defaults.
function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function TripPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireChatGPTUser("/travel-planning");
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const requestedParams = await searchParams;

  const trip = await getTrip(profile.id, id);
  if (!trip) notFound();

  const [prospects, findProspectDonors, financialAttributions] = await Promise.all([
    listTripProspects(profile.id, id),
    // Every live donor, annotated with this trip's own selection state --
    // feeds "Find prospects" (region + text search, both client-side over
    // this same array) and "My trip prospects" (selection already
    // applied server-side above). One shared load, never a second,
    // competing donor query.
    listDonorsForTripSearch(profile.id, id),
    // Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
    listTripFinancialAttributions(profile.id, id),
  ]);
  // Pure summarization (lib/relationships/trip-financial-attribution.ts)
  // over the SAME, already-fetched attribution rows -- no second query,
  // no parallel ledger.
  const financialSummary = summarizeTripFinancials(financialAttributions, trip.goalCents);

  const initialTab = firstValue(requestedParams.tab) === "find" ? "find" : "mine";
  const initialProspectQuery = firstValue(requestedParams.q).trim().slice(0, 80);
  const initialStatusFilter = firstValue(requestedParams.status);
  const initialFindQuery = firstValue(requestedParams.findQ).trim().slice(0, 80);
  // Multi-Region Prospect Selection (2026-10-25, see docs/AI-HANDOFF.md):
  // `regions=all` or the legacy `allRegions=1` (a bookmarked/returned-to
  // link from before this round) both mean "every region"; a comma-
  // joined list of region ids narrows to exactly that combination;
  // absent means the trip's own single destination region, same as
  // before this round.
  const regionsParam = firstValue(requestedParams.regions);
  const initialRegionIds = regionsParam === "all" || firstValue(requestedParams.allRegions) === "1" ? "all" : regionsParam ? regionsParam.split(",").filter(Boolean) : null;

  return <AppShell active="today">
    <TripDashboardExperience
      trip={trip} prospects={prospects} findProspectDonors={findProspectDonors} fundraiserTimezone={profile.timezone}
      financialAttributions={financialAttributions} financialSummary={financialSummary}
      initialTab={initialTab} initialProspectQuery={initialProspectQuery} initialStatusFilter={initialStatusFilter}
      initialFindQuery={initialFindQuery} initialRegionIds={initialRegionIds}
    />
  </AppShell>;
}
