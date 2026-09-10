export type DonorSearchRecord = {
  id: string;
  name: string;
  primaryFirstName?: string | null;
  lastName: string | null;
  spouse: string | null;
  code: string | null;
  email: string | null;
  phone: string | null;
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "rabbi", "rev", "reverend", "hon"]);

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function digits(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

export function effectiveDonorLastName(donor: Pick<DonorSearchRecord, "lastName" | "name">) {
  const explicit = donor.lastName?.trim();
  const explicitKey = normalized(explicit).replace(/[^\p{L}\p{N}]/gu, "");
  if (explicit && !HONORIFICS.has(explicitKey)) return explicit;
  const words = donor.name.trim().split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, "")).filter(Boolean);
  if (["family", "household"].includes(normalized(words.at(-1)))) words.pop();
  return words.at(-1) || donor.name;
}

export function compareDonorsByLastName(a: DonorSearchRecord, b: DonorSearchRecord) {
  const byLastName = collator.compare(effectiveDonorLastName(a), effectiveDonorLastName(b));
  return byLastName || collator.compare(a.name, b.name);
}

function matchesDonorQuery(donor: DonorSearchRecord, text: string, phoneQuery: string) {
  if (!text) return true;
  const textMatch = [donor.lastName, donor.name, donor.spouse, donor.code, donor.email, donor.phone]
    .some((value) => normalized(value).includes(text));
  return textMatch || (phoneQuery.length >= 3 && digits(donor.phone).includes(phoneQuery));
}

export function searchDonors(donors: DonorSearchRecord[], query: string, limit = 8) {
  const text = normalized(query);
  const phoneQuery = digits(query);
  return donors
    .filter((donor) => matchesDonorQuery(donor, text, phoneQuery))
    .sort(compareDonorsByLastName)
    .slice(0, limit);
}

// Donor directory browsing (Log Interaction -> Multiple donors). A-Z plus a
// single fallback bucket for anything that doesn't start with a plain A-Z
// letter once effectiveDonorLastName() resolves it -- a missing last name,
// or one starting with a digit/symbol/accented character. Always the same
// 27 buckets, in the same order, so the UI never has to hide letters
// unpredictably (see docs/AI-HANDOFF.md).
export const DIRECTORY_ALPHABET = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
export const DIRECTORY_OTHER_LETTER = "#";

export function donorDirectoryLetter(donor: Pick<DonorSearchRecord, "lastName" | "name">): string {
  const letter = effectiveDonorLastName(donor).trim().charAt(0).toLocaleUpperCase();
  return DIRECTORY_ALPHABET.includes(letter) ? letter : DIRECTORY_OTHER_LETTER;
}

// Which letters actually have at least one donor -- lets the UI disable an
// empty letter instead of showing it as a live, clickable dead end.
export function donorDirectoryNonEmptyLetters(donors: DonorSearchRecord[]): Set<string> {
  return new Set(donors.map((donor) => donorDirectoryLetter(donor)));
}

// letter: null or "all" browses every donor. Search then narrows within
// whatever the letter filter already produced -- "S" + "sch" only ever
// matches S donors containing "sch"; to match Schwartz regardless of
// letter, clear the letter back to All first. This is a deliberate,
// documented choice (docs/AI-HANDOFF.md), not the only valid one. Always
// sorted by canonical last name; never truncated -- this is the full browse
// list, not a bounded typeahead suggestion list.
export function filterDonorDirectory(donors: DonorSearchRecord[], letter: string | null, query: string): DonorSearchRecord[] {
  const text = normalized(query);
  const phoneQuery = digits(query);
  return donors
    .filter((donor) => !letter || letter === "all" || donorDirectoryLetter(donor) === letter)
    .filter((donor) => matchesDonorQuery(donor, text, phoneQuery))
    .sort(compareDonorsByLastName);
}
