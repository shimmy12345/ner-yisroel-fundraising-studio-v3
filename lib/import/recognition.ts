import { parseFinancialDate } from "../financial-date.ts";

export type ImportField =
  | "donorCode"
  | "donorName"
  | "firstName"
  | "lastName"
  | "household"
  | "spouse"
  | "primaryFirstName"
  | "spouseFirstName"
  | "primaryTitle"
  | "spouseTitle"
  | "email"
  | "phone"
  | "alternatePhone"
  | "homePhone"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "country"
  | "giftDate"
  | "giftAmount"
  | "designation"
  | "giftNote"
  | "interactionDate"
  | "interactionType"
  | "interactionNotes"
  | "reminderDate"
  | "reminderTitle"
  | "nextAction"
  | "reminderNotes";

export type ColumnMapping = Record<string, ImportField | "ignore">;
export type ImportRow = Record<string, string>;

export const FIELD_LABELS: Record<ImportField, string> = {
  donorCode: "Donor Code",
  donorName: "Donor Name",
  firstName: "First Name",
  lastName: "Last Name",
  household: "Household",
  spouse: "Spouse",
  primaryFirstName: "Primary First Name",
  spouseFirstName: "Spouse First Name",
  primaryTitle: "Primary Title",
  spouseTitle: "Spouse Title",
  email: "Email",
  phone: "Phone",
  alternatePhone: "Alternate Mobile Phone",
  homePhone: "Home Phone",
  address: "Address",
  city: "City",
  state: "State",
  zip: "Zip",
  country: "Country",
  giftDate: "Gift Date",
  giftAmount: "Gift Amount",
  designation: "Designation",
  giftNote: "Gift Note",
  interactionDate: "Interaction Date",
  interactionType: "Interaction Type",
  interactionNotes: "Interaction Notes",
  reminderDate: "Reminder Date",
  reminderTitle: "Reminder Title",
  nextAction: "Next Action",
  reminderNotes: "Reminder Notes",
};

type Alias = string | [string, number];

const FIELD_ALIASES: Record<ImportField, Alias[]> = {
  donorCode: ["donor id", "constituent id", "constituent code", "supporter id", "record id"],
  donorName: ["full name", "name", "constituent name", "supporter name"],
  firstName: ["first", "given name"],
  lastName: ["last", "surname", "family name"],
  household: ["household name", "family", "family name"],
  spouse: ["spouse name", "partner", "partner name"],
  primaryFirstName: ["husband first name"],
  spouseFirstName: ["wife first name"],
  primaryTitle: ["husband title"],
  spouseTitle: ["wife title"],
  email: ["email address", "primary email", "personal email"],
  phone: ["phone number", "mobile", "mobile phone", "primary phone"],
  alternatePhone: ["alternate mobile", "secondary mobile"],
  homePhone: ["home", "home phone"],
  address: ["street", "street address", "address 1", "address line 1"],
  city: ["town"],
  state: ["province", "region"],
  zip: ["zip code", "postal code", "postcode"],
  country: ["nation"],
  giftDate: [["contribution date", 0.78], "donation date", "received date", "date received"],
  giftAmount: ["amount", "donation amount", "contribution amount", "gift total"],
  designation: ["fund", "gift fund", "allocation", "purpose"],
  giftNote: ["gift notes", "contribution note", "donation note"],
  interactionDate: ["contact date", "activity date", "touchpoint date"],
  interactionType: ["contact type", "activity type", "interaction kind"],
  interactionNotes: ["interaction note", "contact notes", "activity notes", "conversation notes"],
  reminderDate: ["due date", "follow up date", "follow-up date", "task due date"],
  reminderTitle: ["reminder", "task", "task title", "follow up"],
  nextAction: ["next step", "recommended action", "follow-up action"],
  reminderNotes: ["reminder note", "task notes", "follow up notes", "follow-up notes"],
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export type ColumnSuggestion = {
  column: string;
  field: ImportField | "ignore";
  confidence: number;
  requiresReview: boolean;
};

export function recognizeColumns(columns: string[]): ColumnSuggestion[] {
  return columns.map((column) => {
    const normalized = normalize(column);
    let best: { field: ImportField | "ignore"; confidence: number } = { field: "ignore", confidence: 0 };

    for (const [field, label] of Object.entries(FIELD_LABELS) as Array<[ImportField, string]>) {
      if (normalized === normalize(label)) best = { field, confidence: 0.99 };
      for (const aliasEntry of FIELD_ALIASES[field]) {
        const [alias, confidence] = Array.isArray(aliasEntry) ? aliasEntry : [aliasEntry, 0.91];
        if (normalized === normalize(alias) && confidence > best.confidence) best = { field, confidence };
      }
    }

    if (best.field === "ignore" && normalized) {
      const tokens = new Set(normalized.split(" "));
      for (const [field, label] of Object.entries(FIELD_LABELS) as Array<[ImportField, string]>) {
        const labelTokens = normalize(label).split(" ");
        const overlap = labelTokens.filter((token) => tokens.has(token)).length / labelTokens.length;
        if (overlap >= 0.5 && overlap * 0.72 > best.confidence) best = { field, confidence: overlap * 0.72 };
      }
    }

    return {
      column,
      field: best.field,
      confidence: Math.round(best.confidence * 100) / 100,
      requiresReview: best.confidence < 0.85,
    };
  });
}

export type ImportDonor = {
  id: string;
  donorCode: string | null;
  name: string;
  spouse: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  sourceProfile?: "jl-solutions";
  sourceValues?: Record<string, string>;
  contact?: {
    lastName: string | null;
    primaryFirstName: string | null;
    spouseFirstName: string | null;
    primaryTitle: string | null;
    spouseTitle: string | null;
    mobilePhone: string | null;
    alternateMobilePhone: string | null;
    homePhone: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
};

export type ImportGift = { id: string; donorId: string; date: number; amountCents: number; designation: string; note: string | null };
export type ImportInteraction = { id: string; donorId: string; date: number; type: string; notes: string };
export type ImportReminder = { id: string; donorId: string; dueDate: number; title: string; notes: string | null };
export type RejectedRow = { row: number; reason: string; values: ImportRow };

export type ImportPreview = {
  donors: ImportDonor[];
  gifts: ImportGift[];
  interactions: ImportInteraction[];
  reminders: ImportReminder[];
  rejectedRows: RejectedRow[];
  warnings: string[];
};

function valueFor(row: ImportRow, mapping: ColumnMapping, field: ImportField) {
  for (const [column, mappedField] of Object.entries(mapping)) {
    if (mappedField === field && row[column]?.trim()) return row[column].trim();
  }
  return "";
}

function slug(value: string) {
  const normalized = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 72) || "donor";
}

function timestamp(value: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function amountInCents(value: string) {
  if (!value) return null;
  const normalized = value.replace(/[$,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
}

function donorName(row: ImportRow, mapping: ColumnMapping) {
  return valueFor(row, mapping, "donorName")
    || valueFor(row, mapping, "household")
    || [valueFor(row, mapping, "firstName"), valueFor(row, mapping, "lastName")].filter(Boolean).join(" ");
}

function addressFor(row: ImportRow, mapping: ColumnMapping) {
  const street = valueFor(row, mapping, "address");
  const locality = [valueFor(row, mapping, "city"), valueFor(row, mapping, "state"), valueFor(row, mapping, "zip")].filter(Boolean).join(" ");
  return [street, locality].filter(Boolean).join(", ");
}

const US_STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);

export function buildImportPreview(rows: ImportRow[], mapping: ColumnMapping, fileHash: string): ImportPreview {
  const donors = new Map<string, ImportDonor>();
  const codeNames = new Map<string, Set<string>>();
  const codeDisplayNames = new Map<string, string>();
  const rejectedRows: RejectedRow[] = [];
  const warnings: string[] = [];

  rows.forEach((row) => {
    const code = valueFor(row, mapping, "donorCode").toLowerCase();
    const name = donorName(row, mapping);
    if (code && name) {
      const names = codeNames.get(code) ?? new Set<string>();
      names.add(name.toLowerCase());
      codeNames.set(code, names);
      if (!codeDisplayNames.has(code)) codeDisplayNames.set(code, name);
    }
  });

  const conflictingCodes = new Set([...codeNames.entries()].filter(([, names]) => names.size > 1).map(([code]) => code));
  if (conflictingCodes.size) warnings.push(`${conflictingCodes.size} duplicate donor code${conflictingCodes.size === 1 ? "" : "s"} linked to different names`);

  const gifts: ImportGift[] = [];
  const interactions: ImportInteraction[] = [];
  const reminders: ImportReminder[] = [];
  let missingNames = 0;
  let unmatchedGifts = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const code = valueFor(row, mapping, "donorCode");
    const codeKey = code.toLowerCase();
    const inferredName = codeKey && codeNames.get(codeKey)?.size === 1 ? codeDisplayNames.get(codeKey) ?? "" : "";
    const name = donorName(row, mapping) || inferredName;
    if (!name || (codeKey && conflictingCodes.has(codeKey))) {
      missingNames += name ? 0 : 1;
      rejectedRows.push({ row: rowNumber, reason: name ? "Duplicate donor code is linked to multiple names" : "Missing donor name", values: row });
      if (valueFor(row, mapping, "giftAmount") || valueFor(row, mapping, "giftDate")) unmatchedGifts += 1;
      return;
    }

    const identity = code ? `code-${slug(code)}` : valueFor(row, mapping, "email") ? `email-${slug(valueFor(row, mapping, "email"))}` : `name-${slug(name)}`;
    const donorId = `imported-${identity}`;
    if (!donors.has(donorId)) {
      donors.set(donorId, {
        id: donorId,
        donorCode: code || null,
        name,
        spouse: valueFor(row, mapping, "spouse") || null,
        email: valueFor(row, mapping, "email") || null,
        phone: valueFor(row, mapping, "phone") || null,
        address: addressFor(row, mapping) || null,
        contact: {
          lastName: valueFor(row, mapping, "lastName") || null,
          primaryFirstName: valueFor(row, mapping, "primaryFirstName") || valueFor(row, mapping, "firstName") || null,
          spouseFirstName: valueFor(row, mapping, "spouseFirstName") || valueFor(row, mapping, "spouse") || null,
          primaryTitle: valueFor(row, mapping, "primaryTitle") || null,
          spouseTitle: valueFor(row, mapping, "spouseTitle") || null,
          mobilePhone: valueFor(row, mapping, "phone") || null,
          alternateMobilePhone: valueFor(row, mapping, "alternatePhone") || null,
          homePhone: valueFor(row, mapping, "homePhone") || null,
          addressLine1: valueFor(row, mapping, "address") || null,
          city: valueFor(row, mapping, "city") || null,
          state: valueFor(row, mapping, "state") || null,
          postalCode: valueFor(row, mapping, "zip") || null,
          country: valueFor(row, mapping, "country") || (US_STATES.has(valueFor(row, mapping, "state").toUpperCase()) ? "United States" : null),
        },
      });
    }

    const giftDateValue = valueFor(row, mapping, "giftDate");
    const giftAmountValue = valueFor(row, mapping, "giftAmount");
    if (giftDateValue || giftAmountValue) {
      const date = parseFinancialDate(giftDateValue);
      const amountCents = amountInCents(giftAmountValue);
      if (date === null || amountCents === null) {
        rejectedRows.push({ row: rowNumber, reason: "Gift requires a valid date and non-negative amount", values: row });
      } else {
        gifts.push({
          id: `import-gift-${fileHash.slice(0, 12)}-${rowNumber}`,
          donorId,
          date,
          amountCents,
          designation: valueFor(row, mapping, "designation") || "General",
          note: valueFor(row, mapping, "giftNote") || null,
        });
      }
    }

    const interactionDateValue = valueFor(row, mapping, "interactionDate");
    const interactionNotes = valueFor(row, mapping, "interactionNotes");
    if (interactionDateValue || interactionNotes) {
      const date = timestamp(interactionDateValue);
      if (date === null || !interactionNotes) {
        rejectedRows.push({ row: rowNumber, reason: "Interaction requires a valid date and notes", values: row });
      } else {
        interactions.push({
          id: `import-interaction-${fileHash.slice(0, 12)}-${rowNumber}`,
          donorId,
          date,
          type: valueFor(row, mapping, "interactionType").toLowerCase() || "note",
          notes: interactionNotes,
        });
      }
    }

    const reminderDateValue = valueFor(row, mapping, "reminderDate");
    const reminderTitle = valueFor(row, mapping, "reminderTitle") || valueFor(row, mapping, "nextAction");
    if (reminderDateValue || reminderTitle) {
      const dueDate = timestamp(reminderDateValue);
      if (dueDate === null || !reminderTitle) {
        rejectedRows.push({ row: rowNumber, reason: "Reminder requires a valid due date and title", values: row });
      } else {
        reminders.push({
          id: `import-reminder-${fileHash.slice(0, 12)}-${rowNumber}`,
          donorId,
          dueDate,
          title: reminderTitle,
          notes: valueFor(row, mapping, "reminderNotes") || null,
        });
      }
    }
  });

  if (missingNames) warnings.push(`${missingNames} row${missingNames === 1 ? "" : "s"} missing a donor name`);
  if (unmatchedGifts) warnings.push(`${unmatchedGifts} gift${unmatchedGifts === 1 ? "" : "s"} without a matching donor`);
  if (rejectedRows.length) warnings.push(`${rejectedRows.length} row issue${rejectedRows.length === 1 ? "" : "s"} will be included in the error report`);

  return { donors: [...donors.values()], gifts, interactions, reminders, rejectedRows, warnings };
}
