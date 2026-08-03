export type DonorContactInput = {
  householdName?: string;
  primaryFirstName?: string;
  spouseName?: string;
  email?: string;
  mobilePhone?: string;
  homePhone?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  note?: string;
};

export type NormalizedDonorContact = {
  householdName: string;
  primaryFirstName: string;
  spouseName: string;
  email: string;
  mobilePhone: string;
  homePhone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  note: string;
  lastName: string;
};

const limits: Record<Exclude<keyof NormalizedDonorContact, "lastName">, number> = {
  householdName: 200,
  primaryFirstName: 100,
  spouseName: 150,
  email: 254,
  mobilePhone: 50,
  homePhone: 50,
  address: 250,
  city: 100,
  state: 100,
  postalCode: 20,
  country: 100,
  note: 2000,
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function inferDonorLastName(name: string) {
  const withoutHouseholdSuffix = name.replace(/\b(household|family)\b\.?$/i, "").trim();
  const primarySide = withoutHouseholdSuffix.split(/\s+&\s+|\s+and\s+/i)[0]?.trim() ?? withoutHouseholdSuffix;
  return primarySide.split(/\s+/).filter(Boolean).at(-1) ?? name;
}

export function normalizeDonorContact(input: DonorContactInput) {
  const contact: NormalizedDonorContact = {
    householdName: clean(input.householdName),
    primaryFirstName: clean(input.primaryFirstName),
    spouseName: clean(input.spouseName),
    email: clean(input.email).toLowerCase(),
    mobilePhone: clean(input.mobilePhone),
    homePhone: clean(input.homePhone),
    address: clean(input.address),
    city: clean(input.city),
    state: clean(input.state),
    postalCode: clean(input.postalCode),
    country: clean(input.country),
    note: typeof input.note === "string" ? input.note.trim() : "",
    lastName: "",
  };
  contact.lastName = inferDonorLastName(contact.householdName);
  const errors: Record<string, string> = {};
  if (!contact.householdName) errors.householdName = "Household or donor name is required.";
  for (const [field, max] of Object.entries(limits)) if (contact[field as keyof NormalizedDonorContact].length > max) errors[field] = `Use ${max} characters or fewer.`;
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errors.email = "Enter a valid email address.";
  for (const field of ["mobilePhone", "homePhone"] as const) {
    const digits = contact[field].replace(/\D/g, "");
    if (contact[field] && (digits.length < 7 || digits.length > 15)) errors[field] = "Enter a valid phone number.";
  }
  return { contact, errors, valid: Object.keys(errors).length === 0 };
}

export function changedContactFields(before: NormalizedDonorContact | null, after: NormalizedDonorContact) {
  if (!before) return Object.keys(after).filter((field) => field !== "lastName");
  return Object.keys(after).filter((field) => before[field as keyof NormalizedDonorContact] !== after[field as keyof NormalizedDonorContact] && field !== "lastName");
}
