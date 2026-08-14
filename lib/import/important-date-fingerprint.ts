// Same lightweight FNV-1a hash used by yahrtzeitFingerprint and
// mondaySourceFingerprint.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Identity rule, deliberately different per type:
//
// - birthday: keyed on (donorId, month, day, normalizedPersonName). A
//   second submission describing the same person's same birthday collides
//   into the same row (the manual-entry duplicate-prevention safety net
//   yahrtzeitFingerprint also provides) -- year/relationship/notes are
//   excluded so correcting any of them updates the existing row instead of
//   creating a second one, same reasoning as yahrtzeitFingerprint.
//
// - anniversary: keyed on the row's own id, so it is ALWAYS unique and
//   never collides with anything. An anniversary has no natural secondary
//   key the way a birthday has personName -- it is a household-level fact,
//   not a specific person's. Keying on (donorId, month, day) alone would
//   make "only one anniversary per household per calendar date" an
//   accidental side effect of the fingerprint, silently blocking a second,
//   genuinely distinct anniversary record (e.g. a remarriage) if that
//   situation ever arises -- without requiring any person/remarriage
//   modeling to avoid it, an anniversary simply opts out of duplicate
//   detection. The tradeoff: a double-submitted "Add" click could create
//   two identical anniversary rows; that's a rare, easily-deleted mistake,
//   preferred over silently refusing a legitimate second record.
export function importantDateFingerprint(input: { id: string; donorId: string; type: "birthday" | "anniversary"; month: number; day: number; personName: string | null }): string {
  if (input.type === "anniversary") return fnv1a(["important_date", "anniversary", input.donorId, input.id].join("|"));
  const normalizedName = (input.personName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return fnv1a(["important_date", "birthday", input.donorId, String(input.month), String(input.day), normalizedName].join("|"));
}
