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

export function searchDonors(donors: DonorSearchRecord[], query: string, limit = 8) {
  const text = normalized(query);
  const phoneQuery = digits(query);
  return donors
    .filter((donor) => {
      if (!text) return true;
      const textMatch = [donor.lastName, donor.name, donor.spouse, donor.code, donor.email, donor.phone]
        .some((value) => normalized(value).includes(text));
      return textMatch || (phoneQuery.length >= 3 && digits(donor.phone).includes(phoneQuery));
    })
    .sort(compareDonorsByLastName)
    .slice(0, limit);
}
