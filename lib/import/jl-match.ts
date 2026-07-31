import type { ImportDonor } from "./recognition.ts";

export type ExistingJlDonor = {
  id: string;
  external_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  last_name: string | null;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  primary_title: string | null;
  spouse_title: string | null;
  alternate_mobile_phone: string | null;
  home_phone: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  source_snapshot: string | null;
};

export type JlConflict = { externalId: string; field: string; currentValue: string; jlValue: string };
export type JlMatch = { donor: ImportDonor; existing?: ExistingJlDonor; safeUpdates: Record<string, string | null>; conflicts: JlConflict[] };

const fields = {
  display_name: (donor: ImportDonor) => donor.name,
  email: (donor: ImportDonor) => donor.email,
  phone: (donor: ImportDonor) => donor.phone,
  address: (donor: ImportDonor) => donor.address,
  last_name: (donor: ImportDonor) => donor.contact?.lastName ?? null,
  primary_first_name: (donor: ImportDonor) => donor.contact?.primaryFirstName ?? null,
  spouse_first_name: (donor: ImportDonor) => donor.contact?.spouseFirstName ?? null,
  primary_title: (donor: ImportDonor) => donor.contact?.primaryTitle ?? null,
  spouse_title: (donor: ImportDonor) => donor.contact?.spouseTitle ?? null,
  alternate_mobile_phone: (donor: ImportDonor) => donor.contact?.alternateMobilePhone ?? null,
  home_phone: (donor: ImportDonor) => donor.contact?.homePhone ?? null,
  address_line_1: (donor: ImportDonor) => donor.contact?.addressLine1 ?? null,
  city: (donor: ImportDonor) => donor.contact?.city ?? null,
  state: (donor: ImportDonor) => donor.contact?.state ?? null,
  postal_code: (donor: ImportDonor) => donor.contact?.postalCode ?? null,
  country: (donor: ImportDonor) => donor.contact?.country ?? null,
} as const;

export function matchJlDonors(donors: ImportDonor[], existingRows: ExistingJlDonor[]): JlMatch[] {
  const existingByCode = new Map(existingRows.map((row) => [row.external_id.toLowerCase(), row]));
  return donors.map((donor) => {
    const externalId = donor.donorCode ?? "";
    const existing = existingByCode.get(externalId.toLowerCase());
    if (!existing) return { donor, safeUpdates: {}, conflicts: [] };
    let previous: Record<string, string | null> = {};
    try { previous = existing.source_snapshot ? JSON.parse(existing.source_snapshot) : {}; } catch { previous = {}; }
    const safeUpdates: Record<string, string | null> = {};
    const conflicts: JlConflict[] = [];
    for (const [field, getter] of Object.entries(fields)) {
      const jlValue = getter(donor) ?? null;
      const currentValue = existing[field as keyof ExistingJlDonor] as string | null;
      const previousValue = previous[field] ?? currentValue;
      if (jlValue === currentValue) continue;
      if (currentValue !== previousValue) conflicts.push({ externalId, field, currentValue: currentValue ?? "", jlValue: jlValue ?? "" });
      else safeUpdates[field] = jlValue;
    }
    return { donor, existing, safeUpdates, conflicts };
  });
}

export function sourceSnapshot(donor: ImportDonor) {
  return {
    ...Object.fromEntries(Object.entries(fields).map(([field, getter]) => [field, getter(donor) ?? null])),
    __original: donor.sourceValues ?? {},
  };
}
