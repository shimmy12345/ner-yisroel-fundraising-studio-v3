"use client";

import { DonorAutocomplete } from "../capture/DonorAutocomplete";
import type { DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorDirectorySearchPath, donorNavigationHref } from "../../lib/navigation/donor-navigation";
import { rememberDonorOrigin } from "../components/DonorNavigation";

export function DonorDirectorySearch({ donors, initialQuery = "", resultCount, totalCount, onSearchChange }: { donors: DonorSearchRecord[]; initialQuery?: string; resultCount: number; totalCount: number; onSearchChange: (query: string, returnPath: string) => void }) {
  return <div className="directory-search shared-directory-search">
    <DonorAutocomplete
      donors={donors}
      selectedId=""
      initialQuery={initialQuery}
      clearable
      onQueryChange={(query) => {
        const returnPath = donorDirectorySearchPath(`${window.location.pathname}${window.location.search}${window.location.hash}`, query);
        window.history.replaceState(window.history.state, "", returnPath);
        onSearchChange(query, returnPath);
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
    <p className="directory-search-count" aria-live="polite">{initialQuery ? `${resultCount} of ${totalCount} relationships` : `${totalCount} relationships`}</p>
  </div>;
}
