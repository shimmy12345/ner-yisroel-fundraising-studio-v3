import { JL_COLUMNS } from "./jl-solutions.ts";

// The canonical, distributed household-upload template (docs/AI-HANDOFF.md).
// Derived from JL_COLUMNS -- the importer's own full accepted-header list --
// rather than duplicated, so a header rename/add/remove there is
// automatically reflected here instead of silently drifting out of sync.
//
// "Wife Title" is the one JL_COLUMNS entry deliberately excluded: it is a
// real, importer-accepted, optional column (JL_MAPPING maps it to
// spouseTitle), but the org's approved distributed template omits it by
// design. isJlSolutionsExport() in jl-solutions.ts already anticipates and
// accepts a configurable export missing optional columns like this one, so
// leaving it out of the template does not make an uploaded file invalid.
export const HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS: readonly string[] = JL_COLUMNS.filter((column) => column !== "Wife Title");

export const HOUSEHOLD_IMPORT_TEMPLATE_FILENAME = "fundraising-os-household-import-template.csv";

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// A blank template: exactly one header row, no data rows.
export function buildHouseholdImportTemplateCsv(): string {
  return HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS.map(csvField).join(",") + "\n";
}
