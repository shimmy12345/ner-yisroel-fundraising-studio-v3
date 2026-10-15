import type { Metadata } from "next";
import { env } from "cloudflare:workers";
import { notFound } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getTrip, listTripProspects, findNewlyMatchingProspects } from "../../../lib/relationships/trips-data";
import { TripDashboardExperience } from "./TripDashboardExperience";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";

export const metadata: Metadata = { title: "Trip" };
export const dynamic = "force-dynamic";

type DonorRow = { id: string; display_name: string; primary_first_name: string | null; last_name: string | null; spouse: string | null; spouse_first_name: string | null; donor_code: string | null; external_id: string | null; email: string | null; phone: string | null };

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireChatGPTUser("/travel-planning");
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) notFound();

  // All live donors, lightweight fields only -- feeds the "add manually
  // from anywhere in the CRM" search below, reusing DonorAutocomplete
  // (app/capture/DonorAutocomplete.tsx) exactly as the donor directory
  // and Capture already do, never a second search index.
  const [prospects, newlyMatchingDonors, donorRows] = await Promise.all([
    listTripProspects(profile.id, id),
    findNewlyMatchingProspects(profile.id, id),
    env.DB.prepare("SELECT id, display_name, primary_first_name, last_name, spouse, spouse_first_name, donor_code, external_id, email, phone FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL ORDER BY display_name")
      .bind(profile.id).all<DonorRow>(),
  ]);
  const allDonors: DonorSearchRecord[] = donorRows.results.map((row) => ({
    id: row.id, name: row.display_name, primaryFirstName: row.primary_first_name, lastName: row.last_name,
    spouse: row.spouse || row.spouse_first_name, code: row.external_id || row.donor_code, email: row.email, phone: row.phone,
  }));

  return <AppShell active="today">
    <TripDashboardExperience trip={trip} prospects={prospects} newlyMatchingDonors={newlyMatchingDonors} allDonors={allDonors} />
  </AppShell>;
}
