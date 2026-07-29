import test from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import {
  automaticMappings,
  mappingErrors,
  normalizeHeader,
  validateDonorRows
} from '../public/donor-import.js';
import {
  importRowsForOwner,
  mergeForUpsert,
  normalizeImportRows
} from '../netlify/functions/_shared/donor-import.mjs';

test('normalizes headers and automatically maps every supported alias style', () => {
  assert.equal(normalizeHeader('\uFEFF Donor_Code '), 'donorcode');
  assert.deepEqual(
    automaticMappings([' Code ', 'Household-Name', 'FIRST_NAME', 'ZIP Code', 'Mobile Phone', 'Assigned Officer']),
    ['donor_code', 'household_name', 'first_name', 'zip', 'mobile_phone', 'assigned_officer']
  );
  const aliases = new Map([
    ['Code', 'donor_code'], ['Donor Code', 'donor_code'], ['ID Code', 'donor_code'],
    ['Name', 'household_name'], ['Household Name', 'household_name'], ['Display Name', 'household_name'],
    ['First Name', 'first_name'], ['Last Name', 'last_name'], ['Email', 'email'],
    ['Address', 'address'], ['Street Address', 'address'], ['City', 'city'], ['State', 'state'],
    ['Zip', 'zip'], ['ZIP', 'zip'], ['Zip Code', 'zip'], ['Postal Code', 'zip'],
    ['Country', 'country'], ['Home', 'home_phone'], ['Home Phone', 'home_phone'],
    ['Cell', 'mobile_phone'], ['Mobile', 'mobile_phone'], ['Mobile Phone', 'mobile_phone'],
    ['Assigned Officer', 'assigned_officer'], ['Stage', 'stage'], ['Lifetime Giving', 'lifetime_giving'],
    ['Last Gift Amount', 'last_gift_amount'], ['Last Gift Date', 'last_gift_date'],
    ['Last Contact Date', 'last_contact_date'], ['Next Action', 'next_action'],
    ['Next Action Date', 'next_action_date'], ['Notes', 'notes']
  ]);
  aliases.forEach((target, header) => assert.equal(automaticMappings([header])[0], target, header));
});

test('requires donor code mapping and rejects duplicate targets', () => {
  assert.match(mappingErrors(['household_name'])[0], /Donor Code/);
  assert.match(mappingErrors(['donor_code', 'email', 'email'])[0], /only once/);
});

test('Papa Parse handles quoted commas, escaped quotes, blank cells, BOM, and CRLF', () => {
  const csv = '\uFEFFCode,Name,Notes,City\r\n0012,"Smith, Family","Said ""hello""",Baltimore\r\n0013,Green,,';
  const result = Papa.parse(csv.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.data[1][1], 'Smith, Family');
  assert.equal(result.data[1][2], 'Said "hello"');
  assert.equal(result.data[2][2], '');
  assert.equal(result.data[2][3], '');
});

test('rejects rows with missing donor codes', () => {
  const result = validateDonorRows([['', 'No Code']], ['Code', 'Name'], ['donor_code', 'household_name']);
  assert.equal(result.validRows.length, 0);
  assert.match(result.rejectedRows[0].errors.join(' '), /Donor Code is required/);
});

test('rejects every duplicate donor code within one CSV', () => {
  const result = validateDonorRows(
    [['0042', 'First'], ['0042', 'Second'], ['0043', 'Third']],
    ['Code', 'Name'],
    ['donor_code', 'household_name']
  );
  assert.equal(result.validRows.length, 1);
  assert.equal(result.rejectedRows.length, 2);
  assert.ok(result.rejectedRows.every(row => row.errors.some(error => /duplicated/.test(error))));
});

test('preserves leading zeroes in donor codes', () => {
  const result = validateDonorRows([['000042']], ['Code'], ['donor_code']);
  assert.equal(result.validRows[0].donor_code, '000042');
});

test('blank incoming values preserve existing database values', () => {
  const normalized = normalizeImportRows([
    { row_number: 2, donor_code: 'A-1', household_name: null, city: '', notes: 'New note' }
  ]);
  const merged = mergeForUpsert(normalized.rows, [
    { donor_code: 'A-1', household_name: 'Existing Household', city: 'Baltimore', notes: 'Old note' }
  ]);
  assert.deepEqual(merged.rows[0].data, {
    donor_code: 'A-1',
    household_name: 'Existing Household',
    city: 'Baltimore',
    notes: 'New note'
  });
});

test('calculates inserted versus updated counts from existing donor codes', () => {
  const normalized = normalizeImportRows([
    { row_number: 2, donor_code: 'EXISTING', household_name: 'Updated Name' },
    { row_number: 3, donor_code: 'NEW', household_name: 'New Name' }
  ]);
  const merged = mergeForUpsert(normalized.rows, [
    { donor_code: 'EXISTING', household_name: 'Old Name' }
  ]);
  assert.equal(merged.inserted, 1);
  assert.equal(merged.updated, 1);
  assert.equal(merged.rows.find(row => row.data.donor_code === 'NEW').data.is_archived, false);
  assert.equal('is_archived' in merged.rows.find(row => row.data.donor_code === 'EXISTING').data, false);
});

test('adds the authenticated owner only after CSV normalization', () => {
  const normalized = normalizeImportRows([
    { row_number: 2, donor_code: 'SHARED-CODE', household_name: 'Current user donor' }
  ]);
  const owned = importRowsForOwner(normalized.rows, 'current-auth-user');
  assert.deepEqual(owned[0].data, {
    donor_code: 'SHARED-CODE',
    household_name: 'Current user donor',
    owner_user_id: 'current-auth-user'
  });
});

test('server normalization rejects unsupported fields and impossible dates', () => {
  const unexpected = normalizeImportRows([{ row_number: 2, donor_code: 'A', secret: 'not allowed' }]);
  const invalidDate = normalizeImportRows([{ row_number: 3, donor_code: 'B', last_gift_date: '2026-02-31' }]);
  assert.match(unexpected.errors[0].error, /Unsupported field/);
  assert.match(invalidDate.errors[0].error, /valid YYYY-MM-DD date/);
});
