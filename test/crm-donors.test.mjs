import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRM_DONOR_FIELDS,
  UNASSIGNED_FILTER,
  donorMetrics,
  filterAndSortDonors,
  formatCrmDate,
  formatCurrency,
  isDueWithinSevenDays,
  isNotContactedInNinetyDays,
  isOverdueNextAction,
  normalizeCrmDonorPayload,
  paginateDonors
} from '../public/crm-donors.js';

const donors = [
  {
    donor_code: '0003',
    household_name: 'Zimmerman Family',
    first_name: 'Ari',
    email: 'ari@example.org',
    city: 'Baltimore',
    state: 'MD',
    assigned_officer: 'Rachel',
    stage: 'Cultivation',
    lifetime_giving: 2500,
    last_gift_date: '2026-06-01',
    last_contact_date: '2026-01-01',
    next_action: 'Schedule a visit',
    next_action_date: '2026-07-31',
    notes: 'Interested in scholarships',
    updated_at: '2026-07-20T09:00:00Z'
  },
  {
    donor_code: '0001',
    household_name: 'Adler Family',
    last_name: 'Adler',
    city: 'Chicago',
    assigned_officer: '',
    stage: '',
    lifetime_giving: null,
    last_gift_date: null,
    last_contact_date: null,
    next_action: '',
    next_action_date: null,
    notes: 'Alumni family',
    updated_at: '2026-07-28T09:00:00Z'
  },
  {
    donor_code: '0002',
    household_name: 'Bernstein Family',
    assigned_officer: 'David',
    stage: 'Solicitation',
    lifetime_giving: 10000,
    last_gift_date: '2026-07-10',
    last_contact_date: '2026-07-20',
    next_action: 'Send proposal',
    next_action_date: '2026-08-03',
    updated_at: '2026-07-25T09:00:00Z'
  }
];

test('requests the complete CRM donor dashboard field set', () => {
  assert.deepEqual(CRM_DONOR_FIELDS, [
    'id', 'donor_code', 'household_name', 'first_name', 'last_name', 'email',
    'home_phone', 'mobile_phone', 'address', 'city', 'state', 'zip', 'country',
    'assigned_officer', 'stage', 'lifetime_giving', 'last_gift_amount',
    'last_gift_date', 'last_contact_date', 'next_action', 'next_action_date',
    'notes', 'created_at', 'updated_at'
  ]);
});

test('searches across CRM donor fields case-insensitively', () => {
  assert.deepEqual(filterAndSortDonors(donors, { search: 'SCHOLARSHIPS' }).map(row => row.donor_code), ['0003']);
  assert.deepEqual(filterAndSortDonors(donors, { search: 'chicago' }).map(row => row.donor_code), ['0001']);
  assert.deepEqual(filterAndSortDonors(donors, { search: 'david' }).map(row => row.donor_code), ['0002']);
  for (const query of ['Zimmerman', 'Ari', '0003', 'ari@example.org', 'MD', 'Schedule a visit']) {
    assert.deepEqual(filterAndSortDonors(donors, { search: query }).map(row => row.donor_code), ['0003'], query);
  }
});

test('filters assigned and unassigned stages and officers', () => {
  assert.deepEqual(filterAndSortDonors(donors, { stage: 'Cultivation' }).map(row => row.donor_code), ['0003']);
  assert.deepEqual(filterAndSortDonors(donors, { stage: UNASSIGNED_FILTER }).map(row => row.donor_code), ['0001']);
  assert.deepEqual(filterAndSortDonors(donors, { officer: 'David' }).map(row => row.donor_code), ['0002']);
  assert.deepEqual(filterAndSortDonors(donors, { officer: UNASSIGNED_FILTER }).map(row => row.donor_code), ['0001']);
});

test('sorts donors with missing values last', () => {
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'household-desc' }).map(row => row.donor_code), ['0003', '0002', '0001']);
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'lifetime-desc' }).map(row => row.donor_code), ['0002', '0003', '0001']);
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'last-gift-newest' }).map(row => row.donor_code), ['0002', '0003', '0001']);
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'last-contact-oldest' }).map(row => row.donor_code), ['0003', '0002', '0001']);
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'next-action-soonest' }).map(row => row.donor_code), ['0003', '0002', '0001']);
  assert.deepEqual(filterAndSortDonors(donors, { sort: 'recently-updated' }).map(row => row.donor_code), ['0001', '0002', '0003']);
  const withMissingName = [...donors, { donor_code: '0004', household_name: null }];
  assert.equal(filterAndSortDonors(withMissingName, { sort: 'household-desc' }).at(-1).donor_code, '0004');
});

test('formats CRM currency and dates without inventing missing values', () => {
  assert.equal(formatCurrency(1234.5), '$1,234.50');
  assert.equal(formatCurrency(null), '');
  assert.equal(formatCrmDate('2026-07-04'), 'Jul 4, 2026');
  assert.equal(formatCrmDate(''), '');
  assert.equal(formatCrmDate('2026-02-31'), '');
});

test('detects overdue, due-soon, and 90-day contact statuses', () => {
  const today = new Date('2026-07-29T12:00:00Z');
  assert.equal(isOverdueNextAction({ next_action_date: '2026-07-28' }, today), true);
  assert.equal(isOverdueNextAction({ next_action_date: '2026-07-29' }, today), false);
  assert.equal(isDueWithinSevenDays({ next_action_date: '2026-08-05' }, today), true);
  assert.equal(isDueWithinSevenDays({ next_action_date: '2026-08-06' }, today), false);
  assert.equal(isNotContactedInNinetyDays({ last_contact_date: '2026-04-29' }, today), true);
  assert.equal(isNotContactedInNinetyDays({ last_contact_date: '2026-04-30' }, today), false);
  assert.equal(isNotContactedInNinetyDays({ last_contact_date: null }, today), false);
});

test('calculates metrics while reporting missing contact dates separately', () => {
  const metrics = donorMetrics(donors, new Date('2026-07-29T12:00:00Z'));
  assert.equal(metrics.totalDonors, 3);
  assert.equal(metrics.totalLifetimeGiving, 12500);
  assert.equal(metrics.hasLifetimeGiving, true);
  assert.equal(metrics.missingLifetimeGiving, 1);
  assert.equal(metrics.withNextActions, 2);
  assert.equal(metrics.overdueNextActions, 0);
  assert.equal(metrics.notContactedNinetyDays, 1);
  assert.equal(metrics.missingContactDates, 1);
});

test('paginates matching donors in groups of 50', () => {
  const rows = Array.from({ length: 125 }, (_value, index) => ({ donor_code: String(index + 1) }));
  const first = paginateDonors(rows, 1);
  const third = paginateDonors(rows, 3);
  assert.equal(first.rows.length, 50);
  assert.equal(first.totalPages, 3);
  assert.equal(third.rows.length, 25);
  assert.equal(third.start, 100);
  assert.equal(paginateDonors(rows, 99).page, 3);
});

test('normalizes CRM donor payloads, nulls blanks, and preserves leading zeroes', () => {
  const payload = normalizeCrmDonorPayload({
    donor_code: ' 000042 ',
    household_name: ' Smith Family ',
    first_name: '  Sarah ',
    lifetime_giving: '',
    last_gift_amount: '125.50',
    last_gift_date: '',
    last_contact_date: '2026-07-20',
    next_action_date: ' '
  });
  assert.equal(payload.donor_code, '000042');
  assert.equal(payload.household_name, 'Smith Family');
  assert.equal(payload.first_name, 'Sarah');
  assert.equal(payload.lifetime_giving, null);
  assert.equal(payload.last_gift_amount, 125.5);
  assert.equal(payload.last_gift_date, null);
  assert.equal(payload.last_contact_date, '2026-07-20');
  assert.equal(payload.next_action_date, null);
  assert.equal('user_id' in payload, false);
});

test('requires donor code and household name in CRM payloads', () => {
  assert.throws(() => normalizeCrmDonorPayload({ household_name: 'Family' }), /Donor Code/);
  assert.throws(() => normalizeCrmDonorPayload({ donor_code: '001' }), /Household Name/);
});
