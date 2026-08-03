"use client";

import { DonorAutocomplete } from "../capture/DonorAutocomplete";
import type { DonorSearchRecord } from "../../lib/relationships/donor-search";

export function DonorDirectorySearch({ donors }: { donors: DonorSearchRecord[] }) {
  return <div className="directory-search shared-directory-search">
    <DonorAutocomplete
      donors={donors}
      selectedId=""
      onSelect={(id) => { if (id) window.location.assign(`/donors/${encodeURIComponent(id)}`); }}
      inputId="directory-donor-search"
      label="Find a household"
      placeholder="Search last name, household, spouse, JL code, email, or phone"
    />
  </div>;
}
