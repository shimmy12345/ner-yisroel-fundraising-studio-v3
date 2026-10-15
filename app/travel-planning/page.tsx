import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { listTrips } from "../../lib/relationships/trips-data";
import { TRAVEL_REGIONS } from "../../lib/relationships/travel-regions";
import { TravelPlanningExperience } from "./TravelPlanningExperience";

export const metadata: Metadata = { title: "Travel Planning" };
export const dynamic = "force-dynamic";

// A secondary page reached via a Quick Actions link from Today
// (app/page.tsx), not a new primary-nav slot -- AppShell's `active` union
// has no precedent for a 5th item (confirmed by inspecting Portfolio
// Focus and Fundraising Intelligence, both of which borrow `active=
// "today"` the same way this page does), per the owner's own "without
// unnecessarily restructuring the primary navigation" instruction.
export default async function TravelPlanningPage() {
  const identity = await requireChatGPTUser("/travel-planning");
  const profile = await ensureUserProfile(identity);
  const trips = await listTrips(profile.id);

  return <AppShell active="today">
    <header className="page-header travel-planning-header">
      <div>
        <p className="eyebrow">FUNDRAISING TRAVEL</p>
        <h1>Travel Planning</h1>
        <p className="subhead">Plan a fundraising trip to a Travel Region, let Fundraising OS surface who&rsquo;s worth meeting while you&rsquo;re there, and keep each trip&rsquo;s own outreach history for later.</p>
      </div>
    </header>
    <TravelPlanningExperience trips={trips} regions={TRAVEL_REGIONS.map((region) => ({ id: region.id, label: region.label }))} />
  </AppShell>;
}
