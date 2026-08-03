export type DonorSearchRecord = {
  id: string;
  name: string;
  lastName: string | null;
  spouse: string | null;
  code: string | null;
  email: string | null;
  phone: string | null;
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}

function digits(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

export function compareDonorsByLastName(a: DonorSearchRecord, b: DonorSearchRecord) {
  const byLastName = collator.compare(a.lastName?.trim() || a.name, b.lastName?.trim() || b.name);
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
