export const CRM_DONOR_FIELDS = [
  'id',
  'donor_code',
  'household_name',
  'first_name',
  'last_name',
  'email',
  'home_phone',
  'mobile_phone',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'assigned_officer',
  'stage',
  'lifetime_giving',
  'last_gift_amount',
  'last_gift_date',
  'last_contact_date',
  'next_action',
  'next_action_date',
  'notes',
  'created_at',
  'updated_at'
];

export const UNASSIGNED_FILTER = '__unassigned__';
export const DONORS_PER_PAGE = 50;

const SEARCH_FIELDS = [
  'household_name',
  'first_name',
  'last_name',
  'donor_code',
  'email',
  'city',
  'state',
  'assigned_officer',
  'next_action',
  'notes'
];
const TEXT_FIELDS = [
  'donor_code',
  'household_name',
  'first_name',
  'last_name',
  'email',
  'home_phone',
  'mobile_phone',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'assigned_officer',
  'stage',
  'next_action',
  'notes'
];
const NUMBER_FIELDS = ['lifetime_giving', 'last_gift_amount'];
const DATE_FIELDS = ['last_gift_date', 'last_contact_date', 'next_action_date'];

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
});

function text(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase('en-US');
}

function dateTimestamp(value) {
  const input = text(value);
  const dateOnly = input.slice(0, 10);
  if (!validDateInput(dateOnly)) return null;
  const timestamp = Date.parse(`${dateOnly}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function todayTimestamp(today = new Date()) {
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

function validDateInput(value) {
  const input = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function compareText(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, 'en-US');
}

function compareTextDescending(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a, 'en-US');
}

function compareNumber(left, right, direction = 'desc') {
  const a = left === null || left === undefined || left === '' ? null : Number(left);
  const b = right === null || right === undefined || right === '' ? null : Number(right);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
  if (!Number.isFinite(a)) return 1;
  if (!Number.isFinite(b)) return -1;
  return direction === 'asc' ? a - b : b - a;
}

function compareDate(left, right, direction = 'asc') {
  const a = dateTimestamp(left);
  const b = dateTimestamp(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}

function compareDateTime(left, right, direction = 'desc') {
  const a = Date.parse(text(left));
  const b = Date.parse(text(right));
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
  if (!Number.isFinite(a)) return 1;
  if (!Number.isFinite(b)) return -1;
  return direction === 'asc' ? a - b : b - a;
}

export function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? currencyFormatter.format(number) : '';
}

export function formatCrmDate(value) {
  const timestamp = dateTimestamp(value);
  return timestamp === null ? '' : dateFormatter.format(new Date(timestamp));
}

export function isOverdueNextAction(row, today = new Date()) {
  const due = dateTimestamp(row?.next_action_date);
  return due !== null && due < todayTimestamp(today);
}

export function isDueWithinSevenDays(row, today = new Date()) {
  const due = dateTimestamp(row?.next_action_date);
  if (due === null) return false;
  const start = todayTimestamp(today);
  return due >= start && due <= start + (7 * 86_400_000);
}

export function isNotContactedInNinetyDays(row, today = new Date()) {
  const contact = dateTimestamp(row?.last_contact_date);
  return contact !== null && contact < todayTimestamp(today) - (90 * 86_400_000);
}

export function donorMetrics(rows = [], today = new Date()) {
  const validGiving = rows
    .map(row => row.lifetime_giving)
    .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
    .map(Number);
  return {
    totalDonors: rows.length,
    totalLifetimeGiving: validGiving.reduce((sum, value) => sum + value, 0),
    hasLifetimeGiving: validGiving.length > 0,
    missingLifetimeGiving: rows.length - validGiving.length,
    withNextActions: rows.filter(row => text(row.next_action) || dateTimestamp(row.next_action_date) !== null).length,
    overdueNextActions: rows.filter(row => isOverdueNextAction(row, today)).length,
    notContactedNinetyDays: rows.filter(row => isNotContactedInNinetyDays(row, today)).length,
    missingContactDates: rows.filter(row => dateTimestamp(row.last_contact_date) === null).length
  };
}

export function filterAndSortDonors(rows = [], {
  search = '',
  stage = '',
  officer = '',
  sort = 'household-asc'
} = {}) {
  const query = normalized(search);
  const filtered = rows.filter(row => {
    const matchesSearch = !query || SEARCH_FIELDS.some(field => normalized(row[field]).includes(query));
    const stageValue = text(row.stage);
    const officerValue = text(row.assigned_officer);
    const matchesStage = !stage
      || (stage === UNASSIGNED_FILTER ? !stageValue : normalized(stageValue) === normalized(stage));
    const matchesOfficer = !officer
      || (officer === UNASSIGNED_FILTER ? !officerValue : normalized(officerValue) === normalized(officer));
    return matchesSearch && matchesStage && matchesOfficer;
  });

  const sorted = [...filtered];
  sorted.sort((left, right) => {
    let result;
    if (sort === 'household-desc') result = compareTextDescending(left.household_name, right.household_name);
    else if (sort === 'lifetime-desc') result = compareNumber(left.lifetime_giving, right.lifetime_giving, 'desc');
    else if (sort === 'last-gift-newest') result = compareDate(left.last_gift_date, right.last_gift_date, 'desc');
    else if (sort === 'last-contact-oldest') result = compareDate(left.last_contact_date, right.last_contact_date, 'asc');
    else if (sort === 'next-action-soonest') result = compareDate(left.next_action_date, right.next_action_date, 'asc');
    else if (sort === 'recently-updated') result = compareDateTime(left.updated_at, right.updated_at, 'desc');
    else result = compareText(left.household_name, right.household_name);
    return result || compareText(left.household_name, right.household_name) || compareText(left.donor_code, right.donor_code);
  });
  return sorted;
}

export function filterOptions(rows = [], field) {
  const options = new Map();
  let hasUnassigned = false;
  rows.forEach(row => {
    const value = text(row[field]);
    if (!value) {
      hasUnassigned = true;
      return;
    }
    const key = normalized(value);
    if (!options.has(key)) options.set(key, value);
  });
  return {
    values: [...options.values()].sort((a, b) => a.localeCompare(b, 'en-US')),
    hasUnassigned
  };
}

export function paginateDonors(rows = [], page = 1, pageSize = DONORS_PER_PAGE) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    page: currentPage,
    pageSize,
    totalPages,
    start,
    end: Math.min(start + pageSize, rows.length),
    rows: rows.slice(start, start + pageSize)
  };
}

export function normalizeCrmDonorPayload(input = {}) {
  const payload = {};
  TEXT_FIELDS.forEach(field => {
    const value = text(input[field]);
    payload[field] = value || null;
  });
  if (!payload.donor_code) throw new Error('Donor Code is required.');
  if (!payload.household_name) throw new Error('Household Name is required.');

  NUMBER_FIELDS.forEach(field => {
    const value = text(input[field]);
    if (!value) {
      payload[field] = null;
      return;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field === 'lifetime_giving' ? 'Lifetime Giving' : 'Last Gift Amount'} must be a number.`);
    payload[field] = number;
  });
  DATE_FIELDS.forEach(field => {
    const value = text(input[field]);
    if (!value) {
      payload[field] = null;
      return;
    }
    if (!validDateInput(value)) throw new Error('Enter a valid date.');
    payload[field] = value;
  });
  return payload;
}
