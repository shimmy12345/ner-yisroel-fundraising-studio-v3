"use client";

import { DonorAutocomplete } from "../capture/DonorAutocomplete";
import type { DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorNavigationHref } from "../../lib/navigation/donor-navigation";
import { rememberDonorOrigin } from "../components/DonorNavigation";

export function DonorDirectorySearch({ donors, initialQuery = "" }: { donors: DonorSearchRecord[]; initialQuery?: string }) {
  return <div className="directory-search shared-directory-search">
    <DonorAutocomplete
      donors={donors}
      selectedId=""
      initialQuery={initialQuery}
      onQueryChange={(query) => {
        const next = new URL(window.location.href);
        if (query.trim()) next.searchParams.set("q", query.slice(0, 80)); else next.searchParams.delete("q");
        window.history.replaceState(window.history.state, "", `${next.pathname}${next.search}${next.hash}`);
      }}
      onSelect={(id) => {
        if (!id) return;
        const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        rememberDonorOrigin(returnTo);
        window.location.assign(donorNavigationHref(id, returnTo, returnTo.includes("?") ? "search" : "donors"));
      }}
      inputId="directory-donor-search"
      label="Find a household"
      placeholder="Search last name, household, spouse, JL code, email, or phone"
    />
  </div>;
}
