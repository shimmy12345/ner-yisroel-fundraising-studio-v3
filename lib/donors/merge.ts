export const MERGE_FIELD_GROUPS = ["name", "spouse", "jlCode", "email", "phones", "address", "notes"] as const;
export type MergeFieldGroup = typeof MERGE_FIELD_GROUPS[number];

export type MergeDonorRow = {
  id: string; display_name: string; spouse: string | null; donor_code: string | null; external_source: string | null; external_id: string | null;
  email: string | null; phone: string | null; home_phone: string | null; alternate_mobile_phone: string | null;
  address: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null;
  contact_note: string | null; last_name: string | null; primary_first_name: string | null; spouse_first_name: string | null;
  primary_title: string | null; spouse_title: string | null; source_snapshot: string | null; owner_user_id: string; data_source: string;
  archived_at: number | null; merged_into_donor_id: string | null;
};

export const MERGE_DONOR_SELECT = `id,display_name,spouse,donor_code,external_source,external_id,email,phone,home_phone,alternate_mobile_phone,address,address_line_1,city,state,postal_code,country,contact_note,last_name,primary_first_name,spouse_first_name,primary_title,spouse_title,source_snapshot,owner_user_id,data_source,archived_at,merged_into_donor_id`;

export function mergeFieldValues(survivor: MergeDonorRow, duplicate: MergeDonorRow, choices: Record<MergeFieldGroup, string>) {
  const chosen = (group: MergeFieldGroup) => choices[group] === duplicate.id ? duplicate : survivor;
  const name = chosen("name"); const spouse = chosen("spouse"); const jl = chosen("jlCode"); const phones = chosen("phones"); const address = chosen("address");
  return {
    display_name: name.display_name, last_name: name.last_name, primary_first_name: name.primary_first_name, primary_title: name.primary_title,
    spouse: spouse.spouse, spouse_first_name: spouse.spouse_first_name, spouse_title: spouse.spouse_title,
    donor_code: jl.donor_code, external_source: jl.external_source, external_id: jl.external_id, source_snapshot: jl.source_snapshot,
    email: chosen("email").email,
    phone: phones.phone, home_phone: phones.home_phone, alternate_mobile_phone: phones.alternate_mobile_phone,
    address: address.address, address_line_1: address.address_line_1, city: address.city, state: address.state, postal_code: address.postal_code, country: address.country,
    contact_note: chosen("notes").contact_note,
  };
}

export function validateMergeChoices(survivorId: string, duplicateId: string, choices: unknown): choices is Record<MergeFieldGroup, string> {
  if (!choices || typeof choices !== "object") return false;
  return MERGE_FIELD_GROUPS.every((field) => [survivorId, duplicateId].includes((choices as Record<string, string>)[field]));
}
