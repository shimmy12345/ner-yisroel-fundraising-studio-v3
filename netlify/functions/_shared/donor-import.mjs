export const DONOR_FIELDS = [
  'donor_code',
  'household_name',
  'first_name',
  'last_name',
  'email',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'home_phone',
  'mobile_phone',
  'assigned_officer',
  'stage',
  'lifetime_giving',
  'last_gift_amount',
  'last_gift_date',
  'last_contact_date',
  'next_action',
  'next_action_date',
  'notes'
];

const NUMERIC_FIELDS = new Set(['lifetime_giving', 'last_gift_amount']);
const DATE_FIELDS = new Set(['last_gift_date', 'last_contact_date', 'next_action_date']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function rowError(row, message) {
  return { row: Number.isInteger(row?.row_number) ? row.row_number : null, error: message };
}

export function normalizeImportRows(rows) {
  if (!Array.isArray(rows)) return { rows: [], errors: [{ row: null, error: 'Rows must be an array.' }] };
  const accepted = [];
  const errors = [];
  const seen = new Set();

  rows.forEach(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      errors.push(rowError(input, 'Row must be an object.'));
      return;
    }
    const unexpected = Object.keys(input).filter(key => key !== 'row_number' && !DONOR_FIELDS.includes(key));
    if (unexpected.length) {
      errors.push(rowError(input, `Unsupported field: ${unexpected[0]}.`));
      return;
    }
    const normalized = {};
    for (const field of DONOR_FIELDS) {
      if (!(field in input)) continue;
      const value = input[field];
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
        normalized[field] = null;
      } else if (NUMERIC_FIELDS.has(field)) {
        const number = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(number)) {
          errors.push(rowError(input, `${field} must be numeric.`));
          return;
        }
        normalized[field] = number;
      } else {
        normalized[field] = String(value).trim();
      }
      if (DATE_FIELDS.has(field) && normalized[field] !== null && !validDate(normalized[field])) {
        errors.push(rowError(input, `${field} must be a valid YYYY-MM-DD date.`));
        return;
      }
    }
    if (!normalized.donor_code) {
      errors.push(rowError(input, 'donor_code is required.'));
      return;
    }
    if (seen.has(normalized.donor_code)) {
      errors.push(rowError(input, 'donor_code is duplicated in this request.'));
      return;
    }
    seen.add(normalized.donor_code);
    accepted.push({ rowNumber: Number.isInteger(input.row_number) ? input.row_number : null, data: normalized });
  });
  return { rows: accepted, errors };
}

export function mergeForUpsert(importRows, existingRows = []) {
  const existingByCode = new Map(existingRows.map(row => [String(row.donor_code), row]));
  let inserted = 0;
  let updated = 0;
  const rows = importRows.map(item => {
    const existing = existingByCode.get(item.data.donor_code);
    if (existing) updated += 1;
    else inserted += 1;
    const merged = existing ? { ...existing } : {};
    for (const [field, value] of Object.entries(item.data)) {
      if (value !== null) merged[field] = value;
    }
    return { rowNumber: item.rowNumber, data: merged };
  });
  return { rows, inserted, updated };
}
