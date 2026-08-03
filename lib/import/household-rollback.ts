export type HouseholdChangeRow = { donor_id: string; change_type: "insert" | "update" | "merge" | "consolidated"; before_json: string | null; after_json: string };
export type CurrentHouseholdRow = Record<string, string | number | null> & { id: string; display_name: string; dependency_count: number };

export const HOUSEHOLD_SNAPSHOT_FIELDS = [
  "owner_user_id", "data_source", "donor_code", "external_source", "external_id", "display_name", "spouse", "email", "phone", "address", "last_name", "primary_first_name", "spouse_first_name", "primary_title", "spouse_title", "alternate_mobile_phone", "home_phone", "address_line_1", "city", "state", "postal_code", "country", "contact_note", "source_snapshot",
] as const;

function parse(value: string | null) {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string | number | null> : null; } catch { return null; }
}

export function buildHouseholdRollbackPreview(changes: HouseholdChangeRow[], currentRows: CurrentHouseholdRow[]) {
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const blockers: string[] = [];
  const created: Array<{ donorId: string; donorName: string }> = [];
  const recreates: Array<{ donorId: string; donorName: string; snapshot: Record<string, unknown>; linked: Record<string, string[]>; mergedInto: string }> = [];
  const restores: Array<{ donorId: string; donorName: string; fields: Record<string, string | number | null>; preservedFields: string[]; changeType: "update" | "merge" }> = [];
  let preservedLaterEdits = 0;
  for (const change of changes) {
    const current = currentById.get(change.donor_id);
    const after = parse(change.after_json);
    const before = parse(change.before_json);
    if (change.change_type === "consolidated") {
      const rawBefore = parse(change.before_json) as (Record<string, string | number | null> & { linked?: Record<string, string[]> }) | null;
      const mergedInto = typeof after?.mergedInto === "string" ? after.mergedInto : "";
      if (!rawBefore || !mergedInto || !currentById.has(mergedInto)) blockers.push(`The consolidated donor ${change.donor_id} cannot be recreated safely.`);
      else { const { linked = {}, ...snapshot } = rawBefore; recreates.push({ donorId: change.donor_id, donorName: String(snapshot.display_name ?? change.donor_id), snapshot, linked, mergedInto }); }
      continue;
    }
    if (!current || !after) { blockers.push(`Donor ${change.donor_id} no longer matches the recorded batch state.`); continue; }
    if (change.change_type === "insert") {
      const changedAfterImport = HOUSEHOLD_SNAPSHOT_FIELDS.some((field) => (current[field] ?? null) !== (after[field] ?? null));
      if (current.dependency_count > 0) blockers.push(`${current.display_name} has relationship or giving history created after this import.`);
      else if (changedAfterImport) blockers.push(`${current.display_name} was edited after this import.`);
      else created.push({ donorId: current.id, donorName: current.display_name });
      continue;
    }
    if (!before) { blockers.push(`${current.display_name} is missing its before-values.`); continue; }
    const fields: Record<string, string | number | null> = {};
    const preservedFields: string[] = [];
    for (const field of Object.keys(before).filter((key) => (HOUSEHOLD_SNAPSHOT_FIELDS as readonly string[]).includes(key))) {
      if ((current[field] ?? null) === (after[field] ?? null)) fields[field] = before[field] ?? null;
      else { preservedFields.push(field); preservedLaterEdits += 1; }
    }
    if (Object.keys(fields).length || preservedFields.length) restores.push({ donorId: current.id, donorName: current.display_name, fields, preservedFields, changeType: change.change_type });
  }
  return { safe: blockers.length === 0, blockers, created, recreates, restores, totals: { householdsRemoved: created.length, householdsRecreated: recreates.length, householdsRestored: restores.filter((item) => Object.keys(item.fields).length > 0).length, laterEditsPreserved: preservedLaterEdits } };
}
