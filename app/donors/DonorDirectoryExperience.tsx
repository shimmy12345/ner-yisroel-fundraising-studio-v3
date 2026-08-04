"use client";

import { useMemo, useState } from "react";
import { DonorDirectorySearch } from "./DonorDirectorySearch";
import { DonorOriginLink } from "../components/DonorNavigation";
import { effectiveDonorLastName, searchDonors, type DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorNavigationHref } from "../../lib/navigation/donor-navigation";

export type DirectoryRelationship = {
  id: string;
  display_name: string;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  spouse: string | null;
  last_name: string | null;
  donor_code: string | null;
  external_id: string | null;
  email: string | null;
  phone: string | null;
  home_phone: string | null;
  alternate_mobile_phone: string | null;
  city: string | null;
  state: string | null;
  external_source: string | null;
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export function DonorDirectoryExperience({ relationships, initialQuery, initialReturnPath }: { relationships: DirectoryRelationship[]; initialQuery: string; initialReturnPath: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [returnPath, setReturnPath] = useState(initialReturnPath);
  const relationshipById = useMemo(() => new Map(relationships.map((relationship) => [relationship.id, relationship])), [relationships]);
  const donors = useMemo<DonorSearchRecord[]>(() => searchDonors(relationships.map((relationship) => ({
    id: relationship.id,
    name: relationship.display_name,
    lastName: relationship.last_name,
    spouse: relationship.spouse || relationship.spouse_first_name,
    code: relationship.external_id || relationship.donor_code,
    email: relationship.email,
    phone: relationship.phone || relationship.alternate_mobile_phone || relationship.home_phone,
  })), "", Number.MAX_SAFE_INTEGER), [relationships]);
  const visible = useMemo(() => searchDonors(donors, query, Number.MAX_SAFE_INTEGER).map((donor) => relationshipById.get(donor.id)!).filter(Boolean), [donors, query, relationshipById]);
  const searching = Boolean(query);
  const origin = query.trim() ? "search" : "donors";

  return <>
    <DonorDirectorySearch donors={donors} initialQuery={query} resultCount={visible.length} totalCount={relationships.length} onSearchChange={(nextQuery, nextReturnPath) => { setQuery(nextQuery); setReturnPath(nextReturnPath); }} />
    {visible.length ? <section className="directory-list" aria-label="Donor relationships">{visible.map((relationship) => {
      const members = [relationship.primary_first_name, relationship.spouse_first_name].filter(Boolean).join(" & ");
      const location = [relationship.city, relationship.state].filter(Boolean).join(", ");
      const effectiveLastName = effectiveDonorLastName({ name: relationship.display_name, lastName: relationship.last_name });
      return <DonorOriginLink className="directory-row" href={donorNavigationHref(relationship.id, returnPath, origin)} key={relationship.id}>
        <span className="directory-avatar">{initials(relationship.display_name)}</span><span className="directory-identity"><strong>{relationship.display_name}</strong><small>{[`Last name: ${effectiveLastName}`, members, location].filter(Boolean).join(" · ")}</small></span><span className="directory-contact">{relationship.email || relationship.phone || "No primary contact supplied"}</span>{relationship.external_source && <span className="directory-source">{relationship.external_source === "JL Solutions" ? "JL Solutions" : "Manual"}</span>}<b aria-hidden="true">→</b>
      </DonorOriginLink>;
    })}</section> : <section className="directory-empty"><h2>No relationships found</h2><p>{searching ? "Try a different household, person, code, email, or phone, or clear the search to see everyone." : "Import your donor data to begin building your relationship workspace."}</p>{!searching && <a href="/onboarding/import">Import donor data</a>}</section>}
  </>;
}
