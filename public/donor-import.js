export const DONOR_FIELDS = [
  { value: 'donor_code', label: 'Donor Code', type: 'text' },
  { value: 'household_name', label: 'Household Name', type: 'text' },
  { value: 'first_name', label: 'First Name', type: 'text' },
  { value: 'last_name', label: 'Last Name', type: 'text' },
  { value: 'email', label: 'Email', type: 'text' },
  { value: 'address', label: 'Address', type: 'text' },
  { value: 'city', label: 'City', type: 'text' },
  { value: 'state', label: 'State', type: 'text' },
  { value: 'zip', label: 'ZIP', type: 'text' },
  { value: 'country', label: 'Country', type: 'text' },
  { value: 'home_phone', label: 'Home Phone', type: 'text' },
  { value: 'mobile_phone', label: 'Mobile Phone', type: 'text' },
  { value: 'assigned_officer', label: 'Assigned Officer', type: 'text' },
  { value: 'stage', label: 'Stage', type: 'text' },
  { value: 'lifetime_giving', label: 'Lifetime Giving', type: 'number' },
  { value: 'last_gift_amount', label: 'Last Gift Amount', type: 'number' },
  { value: 'last_gift_date', label: 'Last Gift Date', type: 'date' },
  { value: 'last_contact_date', label: 'Last Contact Date', type: 'date' },
  { value: 'next_action', label: 'Next Action', type: 'text' },
  { value: 'next_action_date', label: 'Next Action Date', type: 'date' },
  { value: 'notes', label: 'Notes', type: 'text' }
];

const FIELD_TYPES = new Map(DONOR_FIELDS.map(field => [field.value, field.type]));
const HEADER_ALIASES = {
  code: 'donor_code',
  donorcode: 'donor_code',
  idcode: 'donor_code',
  name: 'household_name',
  householdname: 'household_name',
  displayname: 'household_name',
  firstname: 'first_name',
  lastname: 'last_name',
  email: 'email',
  address: 'address',
  streetaddress: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  zipcode: 'zip',
  postalcode: 'zip',
  country: 'country',
  home: 'home_phone',
  homephone: 'home_phone',
  cell: 'mobile_phone',
  mobile: 'mobile_phone',
  mobilephone: 'mobile_phone',
  assignedofficer: 'assigned_officer',
  stage: 'stage',
  lifetimegiving: 'lifetime_giving',
  lastgiftamount: 'last_gift_amount',
  lastgiftdate: 'last_gift_date',
  lastcontactdate: 'last_contact_date',
  nextaction: 'next_action',
  nextactiondate: 'next_action_date',
  notes: 'notes'
};

export function normalizeHeader(value = '') {
  return String(value).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function automaticMappings(headers = []) {
  const used = new Set();
  return headers.map(header => {
    const target = HEADER_ALIASES[normalizeHeader(header)] || '';
    if (!target || used.has(target)) return '';
    used.add(target);
    return target;
  });
}

export function mappingErrors(mappings = []) {
  const selected = mappings.filter(Boolean);
  const duplicates = selected.filter((value, index) => selected.indexOf(value) !== index);
  const errors = [];
  if (!selected.includes('donor_code')) errors.push('Map one CSV column to Donor Code.');
  if (duplicates.length) errors.push('Each donor field can be mapped only once.');
  return errors;
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeDate(value) {
  const input = String(value).trim();
  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    if (!validCalendarDate(year, month, day)) return null;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!validCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizedValue(value, field, errors) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const type = FIELD_TYPES.get(field);
  if (type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed) || !Number.isFinite(Number(trimmed))) {
      errors.push(`${DONOR_FIELDS.find(item => item.value === field).label} must be a number.`);
      return null;
    }
    return Number(trimmed);
  }
  if (type === 'date') {
    const date = normalizeDate(trimmed);
    if (!date) errors.push(`${DONOR_FIELDS.find(item => item.value === field).label} must be YYYY-MM-DD or M/D/YYYY.`);
    return date;
  }
  return trimmed;
}

export function validateDonorRows(dataRows = [], headers = [], mappings = []) {
  const codeIndex = mappings.indexOf('donor_code');
  const codeCounts = new Map();
  for (const values of dataRows) {
    const code = codeIndex >= 0 ? String(values[codeIndex] ?? '').trim() : '';
    if (code) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
  }

  const rows = dataRows.map((sourceValues, index) => {
    const errors = [];
    const donor = {};
    mappings.forEach((field, columnIndex) => {
      if (field) donor[field] = normalizedValue(sourceValues[columnIndex], field, errors);
    });
    const donorCode = donor.donor_code;
    if (!donorCode) errors.push('Donor Code is required.');
    else if (codeCounts.get(donorCode) > 1) errors.push('Donor Code is duplicated in this file.');
    return {
      rowNumber: index + 2,
      sourceValues: headers.map((_header, columnIndex) => String(sourceValues[columnIndex] ?? '')),
      donor,
      errors
    };
  });

  return {
    rows,
    preview: rows.slice(0, 10),
    validRows: rows.filter(row => !row.errors.length).map(row => ({ row_number: row.rowNumber, ...row.donor })),
    rejectedRows: rows.filter(row => row.errors.length)
  };
}

export function rejectedRowsCsv(headers, rejectedRows, unparse) {
  const data = rejectedRows.map(row => [
    ...headers.map((_header, index) => row.sourceValues[index] ?? ''),
    row.errors.join(' ')
  ]);
  return unparse({ fields: [...headers, 'import_error'], data });
}
