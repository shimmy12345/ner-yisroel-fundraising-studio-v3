const DAY_MS = 86_400_000;

export const GIFT_PAGE_SIZE = 50;
export const FISCAL_YEAR_START_MONTH = 6; // July, zero-based.
export const GIFT_TYPES = Object.freeze({
  direct_gift: 'Direct Gift',
  daf: 'DAF',
  foundation: 'Foundation',
  stock: 'Stock',
  matching_gift: 'Matching Gift',
  pledge_payment: 'Pledge Payment',
  other: 'Other'
});

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

function clean(value) {
  return String(value ?? '').trim();
}

function validDate(value) {
  const input = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateValue(value) {
  return validDate(value) ? Date.parse(`${value}T00:00:00Z`) : null;
}

export function fiscalYearForDate(value, startMonth = FISCAL_YEAR_START_MONTH) {
  const timestamp = value instanceof Date ? value.getTime() : dateValue(clean(value).slice(0, 10));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return date.getUTCMonth() >= startMonth ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

export function fiscalYearLabel(year) {
  return Number.isInteger(year) ? `FY${year}` : '';
}

export function normalizeGiftPayload(input = {}, donorId) {
  const donor_id = clean(donorId || input.donor_id);
  const amount = Number(input.amount);
  const gift_date = clean(input.gift_date);
  const gift_type = clean(input.gift_type) || 'direct_gift';
  const sharedCreditInput = clean(input.shared_credit_amount);
  const shared_credit_amount = sharedCreditInput ? Number(sharedCreditInput) : null;

  if (!donor_id) throw new Error('Choose a donor.');
  if (!validDate(gift_date)) throw new Error('Enter a valid gift date.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Gift amount must be greater than zero.');
  if (!GIFT_TYPES[gift_type]) throw new Error('Choose a valid gift type.');
  if (shared_credit_amount !== null && (!Number.isFinite(shared_credit_amount) || shared_credit_amount < 0)) {
    throw new Error('Shared-credit amount must be zero or greater.');
  }

  return {
    donor_id,
    gift_date,
    amount,
    campaign: clean(input.campaign) || null,
    designation: clean(input.designation) || null,
    gift_type,
    payment_method: clean(input.payment_method) || null,
    solicitor: clean(input.solicitor) || null,
    shared_credit_amount,
    shared_credit_information: clean(input.shared_credit_information) || null,
    reference_number: clean(input.reference_number) || null,
    is_anonymous: Boolean(input.is_anonymous),
    tribute_information: clean(input.tribute_information) || null,
    notes: clean(input.notes) || null,
    receipt_status: clean(input.receipt_status) || 'not_required',
    thank_you_status: clean(input.thank_you_status) || 'pending'
  };
}

export function softDeleteGiftPayload(now = new Date()) {
  return { is_deleted: true, deleted_at: now.toISOString() };
}

export function giftSummary(gifts = [], now = new Date()) {
  const active = gifts.filter(gift => !gift.is_deleted && Number(gift.amount) > 0 && validDate(gift.gift_date));
  const currentFiscalYear = fiscalYearForDate(now);
  const previousFiscalYear = currentFiscalYear - 1;
  const sorted = [...active].sort((left, right) => dateValue(right.gift_date) - dateValue(left.gift_date));
  const amounts = active.map(gift => Number(gift.amount));
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const currentTotal = active
    .filter(gift => fiscalYearForDate(gift.gift_date) === currentFiscalYear)
    .reduce((sum, gift) => sum + Number(gift.amount), 0);
  const previousTotal = active
    .filter(gift => fiscalYearForDate(gift.gift_date) === previousFiscalYear)
    .reduce((sum, gift) => sum + Number(gift.amount), 0);
  const last = sorted[0] || null;
  const first = sorted.at(-1) || null;

  let momentum = 'Insufficient Data';
  if (currentTotal || previousTotal) {
    if (!previousTotal) momentum = 'Increasing';
    else {
      const change = (currentTotal - previousTotal) / previousTotal;
      momentum = change > 0.1 ? 'Increasing' : change < -0.1 ? 'Declining' : 'Stable';
    }
  }

  return {
    currentFiscalYear,
    previousFiscalYear,
    lifetimeGiving: total,
    currentFiscalYearGiving: currentTotal,
    previousFiscalYearGiving: previousTotal,
    lastGift: last,
    largestGift: amounts.length ? Math.max(...amounts) : null,
    averageGift: amounts.length ? total / amounts.length : null,
    giftCount: active.length,
    firstGiftDate: first?.gift_date || null,
    momentum
  };
}

export function annualGiving(gifts = []) {
  const years = new Map();
  gifts.filter(gift => !gift.is_deleted && Number(gift.amount) > 0).forEach(gift => {
    const year = fiscalYearForDate(gift.gift_date);
    if (!year) return;
    const row = years.get(year) || { fiscalYear: year, amount: 0, giftCount: 0 };
    row.amount += Number(gift.amount);
    row.giftCount += 1;
    years.set(year, row);
  });
  return [...years.values()]
    .sort((left, right) => left.fiscalYear - right.fiscalYear)
    .map(row => ({ ...row, averageGift: row.amount / row.giftCount }));
}

export function giftInsights(gifts = []) {
  const active = gifts.filter(gift => !gift.is_deleted && validDate(gift.gift_date));
  const annual = annualGiving(active);
  const campaignTotals = new Map();
  const monthCounts = new Map();
  active.forEach(gift => {
    const campaign = clean(gift.campaign);
    if (campaign) campaignTotals.set(campaign, (campaignTotals.get(campaign) || 0) + Number(gift.amount || 0));
    const month = Number(gift.gift_date.slice(5, 7));
    if (month) monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
  });
  const preferredCampaigns = [...campaignTotals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([name]) => name);
  const typicalMonths = [...monthCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([month]) => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2024, month - 1, 1))));
  const years = new Set(annual.map(row => row.fiscalYear));
  let consecutiveYears = 0;
  if (years.size) {
    let year = Math.max(...years);
    while (years.has(year)) {
      consecutiveYears += 1;
      year -= 1;
    }
  }
  return {
    consecutiveYears,
    preferredCampaigns,
    typicalMonths,
    averageAnnualGiving: annual.length
      ? annual.reduce((sum, row) => sum + row.amount, 0) / annual.length
      : null
  };
}

export function filterAndSortGifts(gifts = [], {
  search = '',
  campaign = '',
  giftType = '',
  dateFrom = '',
  dateTo = '',
  sort = 'date-desc'
} = {}) {
  const query = clean(search).toLowerCase();
  const from = dateValue(dateFrom);
  const to = dateValue(dateTo);
  const filtered = gifts.filter(gift => {
    if (gift.is_deleted) return false;
    const giftDate = dateValue(gift.gift_date);
    if (from !== null && (giftDate === null || giftDate < from)) return false;
    if (to !== null && (giftDate === null || giftDate > to)) return false;
    if (campaign && clean(gift.campaign).toLowerCase() !== clean(campaign).toLowerCase()) return false;
    if (giftType && gift.gift_type !== giftType) return false;
    if (!query) return true;
    return [
      gift.campaign,
      gift.designation,
      GIFT_TYPES[gift.gift_type],
      gift.payment_method,
      gift.solicitor,
      gift.shared_credit_information,
      gift.reference_number,
      gift.notes
    ].some(value => clean(value).toLowerCase().includes(query));
  });
  return [...filtered].sort((left, right) => {
    if (sort === 'date-asc') return dateValue(left.gift_date) - dateValue(right.gift_date);
    if (sort === 'amount-desc') return Number(right.amount) - Number(left.amount);
    if (sort === 'amount-asc') return Number(left.amount) - Number(right.amount);
    return dateValue(right.gift_date) - dateValue(left.gift_date);
  });
}

export function giftCampaignOptions(gifts = []) {
  return [...new Set(gifts.map(gift => clean(gift.campaign)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function formatGiftCurrency(value) {
  const number = Number(value);
  return Number.isFinite(number) ? currencyFormatter.format(number) : '';
}

export function formatGiftDate(value) {
  const timestamp = dateValue(value);
  return timestamp === null ? '' : dateFormatter.format(new Date(timestamp));
}

export function giftsCsv(gifts = []) {
  const headers = [
    'gift_id', 'donor_id', 'gift_date', 'amount', 'campaign', 'designation',
    'gift_type', 'payment_method', 'solicitor', 'shared_credit_amount',
    'shared_credit_information', 'reference_number', 'anonymous',
    'tribute_information', 'notes', 'receipt_status', 'thank_you_status'
  ];
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    headers.join(','),
    ...gifts.filter(gift => !gift.is_deleted).map(gift => headers.map(header => {
      const field = header === 'gift_id' ? 'id'
        : header === 'anonymous' ? 'is_anonymous'
          : header;
      return quote(gift[field]);
    }).join(','))
  ].join('\r\n');
}
