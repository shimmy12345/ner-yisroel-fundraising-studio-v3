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

export type JlFieldChange = { externalId: string; field: string; currentValue: string; jlValue: string; requiresDecision: boolean };
export type JlFieldComparison = JlFieldChange & { changed: boolean };
export type JlConflict = JlFieldChange;
export type JlFieldDecision = { externalId: string; field: string; action: "keep_local" | "use_jl" };
export type JlMatch = { donor: ImportDonor; existing?: ExistingJlDonor; safeUpdates: Record<string, string | null>; conflicts: JlConflict[]; changes: JlFieldChange[]; comparisons: JlFieldComparison[] };

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

const sourceColumns: Record<keyof typeof fields, string[]> = {
  display_name: ["Name"], email: ["Fathers E-mail"], phone: ["Fathers Cell"],
  address: ["Address", "City", "State", "Zip Code", "Country"], last_name: ["Last Name"],
  primary_first_name: ["Husband First Name"], spouse_first_name: ["Wife First Name"],
  primary_title: ["Husband Title"], spouse_title: ["Wife Title"], alternate_mobile_phone: ["Cell"],
  home_phone: ["Home"], address_line_1: ["Address"], city: ["City"], state: ["State"],
  postal_code: ["Zip Code"], country: ["Country"],
};

export function matchJlDonors(donors: ImportDonor[], existingRows: ExistingJlDonor[]): JlMatch[] {
  const existingByCode = new Map(existingRows.map((row) => [row.external_id.toLowerCase(), row]));
  return donors.map((donor) => {
    const externalId = donor.donorCode ?? "";
    const existing = existingByCode.get(externalId.toLowerCase());
    if (!existing) return { donor, safeUpdates: {}, conflicts: [], changes: [], comparisons: [] };
    let previous: Record<string, string | null> = {};
    let hasTrustedSnapshot = false;
    try {
      const parsed = existing.source_snapshot ? JSON.parse(existing.source_snapshot) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        previous = parsed;
        hasTrustedSnapshot = true;
      }
    } catch { previous = {}; }
    const safeUpdates: Record<string, string | null> = {};
    const conflicts: JlConflict[] = [];
    const changes: JlFieldChange[] = [];
    const comparisons: JlFieldComparison[] = [];
    for (const [field, getter] of Object.entries(fields)) {
      if (donor.sourceProfile === "jl-solutions" && donor.sourceValues && !sourceColumns[field as keyof typeof fields].some((column) => Object.hasOwn(donor.sourceValues!, column))) continue;
      const jlValue = getter(donor) ?? null;
      const currentValue = existing[field as keyof ExistingJlDonor] as string | null;
      if (jlValue === currentValue) {
        comparisons.push({ externalId, field, currentValue: currentValue ?? "", jlValue: jlValue ?? "", requiresDecision: false, changed: false });
        continue;
      }
      const previousValue = Object.hasOwn(previous, field) ? previous[field] : undefined;
      const requiresDecision = !hasTrustedSnapshot || previousValue === undefined || currentValue !== previousValue;
      const change = { externalId, field, currentValue: currentValue ?? "", jlValue: jlValue ?? "", requiresDecision };
      changes.push(change);
      comparisons.push({ ...change, changed: true });
      if (requiresDecision) conflicts.push(change);
      else safeUpdates[field] = jlValue;
    }
    return { donor, existing, safeUpdates, conflicts, changes, comparisons };
  });
}

export function resolveJlUpdates(match: JlMatch, decisions: JlFieldDecision[]) {
  const byField = new Map(decisions.filter((decision) => decision.externalId.toLowerCase() === (match.donor.donorCode ?? "").toLowerCase()).map((decision) => [decision.field, decision.action]));
  const missing = match.conflicts.filter((conflict) => !byField.has(conflict.field));
  const updates = { ...match.safeUpdates };
  for (const conflict of match.conflicts) if (byField.get(conflict.field) === "use_jl") updates[conflict.field] = conflict.jlValue || null;
  return { updates, missing };
}

export type JlCodeOwner = { id: string; external_source: string | null; external_id: string | null; donor_code: string | null };
export function findJlCodeCollisions(owners: JlCodeOwner[]) {
  const grouped = new Map<string, JlCodeOwner[]>();
  for (const owner of owners) {
    const code = (owner.external_id || owner.donor_code || "").trim().toLowerCase();
    if (code) grouped.set(code, [...(grouped.get(code) ?? []), owner]);
  }
  return [...grouped.entries()].filter(([, rows]) => new Set(rows.map((row) => row.id)).size > 1).map(([externalId, rows]) => ({ externalId, donorIds: [...new Set(rows.map((row) => row.id))] }));
}

export function findUnresolvableJlCodeOwners(owners: JlCodeOwner[], resolvableManualIds: Set<string>) {
  return owners.filter((owner) => owner.external_source !== "JL Solutions" && !resolvableManualIds.has(owner.id)).map((owner) => ({ externalId: (owner.external_id || owner.donor_code || "").trim().toLowerCase(), donorIds: [owner.id] })).filter((item) => item.externalId);
}

export function sourceSnapshot(donor: ImportDonor) {
  return {
    ...Object.fromEntries(Object.entries(fields).map(([field, getter]) => [field, getter(donor) ?? null])),
    __original: donor.sourceValues ?? {},
  };
}
