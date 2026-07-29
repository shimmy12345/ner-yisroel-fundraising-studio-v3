import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_EMPTY_VALUE,
  archivedDonorActionLabel,
  donorProfileViewModel,
  formatDonorAddress,
  profileValue
} from '../public/donor-profile.js';

test('profile display name follows the CRM donor fallback behavior', () => {
  assert.equal(donorProfileViewModel({ first_name: 'Ari', last_name: 'Cohen' }).displayName, 'Cohen, Ari');
  assert.equal(donorProfileViewModel({ first_name: 'Ari' }).displayName, 'Ari');
  assert.equal(donorProfileViewModel({ household_name: 'Cohen Family' }).displayName, 'Cohen Family');
  assert.equal(donorProfileViewModel({}).displayName, 'Unnamed donor');
});

test('formats complete and partial mailing addresses without blank lines', () => {
  assert.equal(
    formatDonorAddress({
      address: '400 Mount Wilson Lane',
      city: 'Baltimore',
      state: 'MD',
      zip: '21208',
      country: 'USA'
    }),
    '400 Mount Wilson Lane\nBaltimore, MD 21208\nUSA'
  );
  assert.equal(formatDonorAddress({ city: 'Baltimore', state: 'MD' }), 'Baltimore, MD');
  assert.equal(formatDonorAddress({}), '');
});

test('uses consistent empty states without inventing donor data', () => {
  assert.equal(profileValue(''), PROFILE_EMPTY_VALUE);
  const profile = donorProfileViewModel({});
  assert.equal(profile.primaryEmail, PROFILE_EMPTY_VALUE);
  assert.equal(profile.primaryPhone, PROFILE_EMPTY_VALUE);
  assert.equal(profile.address, PROFILE_EMPTY_VALUE);
  assert.equal(profile.notesEmpty, true);
  assert.equal(profile.nextAction, 'No next action');
});

test('preserves notes line breaks and assigns available phone fields', () => {
  const profile = donorProfileViewModel({
    mobile_phone: '410-555-0100',
    home_phone: '410-555-0199',
    notes: 'First line\nSecond line'
  });
  assert.equal(profile.primaryPhone, '410-555-0100');
  assert.equal(profile.secondaryPhone, '410-555-0199');
  assert.equal(profile.notes, 'First line\nSecond line');
});

test('uses the correct archive action for active and archived donors', () => {
  assert.equal(archivedDonorActionLabel({ is_archived: false }), 'Archive Donor');
  assert.equal(archivedDonorActionLabel({ is_archived: true }), 'Restore Donor');
});
