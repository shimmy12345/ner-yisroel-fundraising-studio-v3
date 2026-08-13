// Same lightweight FNV-1a hash used by mondaySourceFingerprint and
// lib/research/fingerprint.ts.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Identifies "the same yahrtzeit record" across re-imports of the same (or
// a refreshed) workbook, AND across a manual entry that happens to describe
// the same fact -- either path lands on the same row. Deliberately keyed on
// donorId (not the source donor code) so a manual entry and a later import
// of the same relative naturally collide into one record rather than
// duplicating. hebrewYear and relationship are excluded on purpose: a later
// correction to either (the workbook gains a year that was previously
// blank, a relationship label gets fixed) should update the existing row,
// not create a second one for "the same" deceased relative.
export function yahrtzeitFingerprint(input: { donorId: string; hebrewMonth: string; hebrewDay: number; deceasedNameEnglish: string }): string {
  const normalizedName = input.deceasedNameEnglish.trim().toLowerCase().replace(/\s+/g, " ");
  return fnv1a(["yahrtzeit", input.donorId, input.hebrewMonth, String(input.hebrewDay), normalizedName].join("|"));
}
