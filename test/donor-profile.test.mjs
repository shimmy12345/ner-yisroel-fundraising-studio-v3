import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PROFILE_EMPTY_VALUE,
  archivedDonorActionLabel,
  donorFundraisingSnapshot,
  donorGivingSummary,
  donorProfileViewModel,
  donorUnifiedTimeline,
  filterUnifiedTimeline,
  formatDonorAddress,
  profileValue
} from '../public/donor-profile.js';

const appUrl = new URL('../public/app.js', import.meta.url);

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

test('Donor 360 giving summary calculates gift ledger metrics', () => {
  const summary = donorGivingSummary({ lifetime_giving: 9999 }, [
    { id: 'g1', gift_date: '2026-07-15', amount: 100, campaign: 'Annual' },
    { id: 'g2', gift_date: '2026-06-30', amount: 300 },
    { id: 'g3', gift_date: '2025-08-01', amount: 200 }
  ], new Date('2026-07-30T12:00:00Z'));
  assert.equal(summary.lifetimeGiving, '$600.00');
  assert.equal(summary.currentFiscalYearGiving, '$100.00');
  assert.equal(summary.previousFiscalYearGiving, '$500.00');
  assert.equal(summary.mostRecentGift, '$100.00 · Jul 15, 2026');
  assert.equal(summary.largestGift, '$300.00');
  assert.equal(summary.averageGift, '$200.00');
  assert.equal(summary.numberOfGifts, '3');
});

test('Donor 360 giving summary falls back to donor record fields when gift ledger is unavailable', () => {
  const summary = donorGivingSummary({ lifetime_giving: 1800, last_gift_amount: 250, last_gift_date: '2026-05-01' }, []);
  assert.equal(summary.lifetimeGiving, '$1,800.00');
  assert.equal(summary.currentFiscalYearGiving, PROFILE_EMPTY_VALUE);
  assert.equal(summary.previousFiscalYearGiving, PROFILE_EMPTY_VALUE);
  assert.equal(summary.mostRecentGift, '$250.00 · May 1, 2026');
  assert.equal(summary.numberOfGifts, '1');
});

test('Donor 360 timeline sorts gifts, activities, notes, and campaign participation newest first', () => {
  const timeline = donorUnifiedTimeline({
    donor: { id: 'd1', notes: 'Profile note', updated_at: '2026-07-01T12:00:00Z' },
    gifts: [{ id: 'gift1', gift_date: '2026-07-20', amount: 180, campaign: 'Scholarship Dinner' }],
    activities: [{ id: 'activity1', activity_type: 'meeting', occurred_at: '2026-07-25T10:00:00Z', subject: 'Lunch meeting', notes: 'Discussed ask' }]
  });
  assert.deepEqual(timeline.map(item => item.type), ['activity', 'gift', 'campaign', 'note']);
  assert.equal(timeline[0].description, 'Lunch meeting');
  assert.equal(timeline[1].amount, 180);
});

test('Donor 360 timeline filtering returns only the selected type', () => {
  const timeline = [
    { type: 'gift', date: '2026-07-01' },
    { type: 'activity', date: '2026-07-02' },
    { type: 'note', date: '2026-07-03' }
  ];
  assert.deepEqual(filterUnifiedTimeline(timeline, 'gift').map(item => item.type), ['gift']);
  assert.equal(filterUnifiedTimeline(timeline, 'all').length, 3);
  assert.equal(filterUnifiedTimeline(timeline, 'unknown').length, 3);
});

test('Donor 360 snapshot identifies overdue follow-up and open activities', () => {
  const snapshot = donorFundraisingSnapshot({
    next_action: 'Call donor',
    next_action_date: '2026-07-01',
    last_contact_date: '2026-06-01'
  }, [
    { id: 'a1', activity_type: 'phone_call', occurred_at: '2026-07-20T12:00:00Z', subject: 'Call', notes: 'Talked' },
    { id: 'a2', is_archived: true, occurred_at: '2026-07-21T12:00:00Z', subject: 'Archived' }
  ], [{ id: 'g1', gift_date: '2026-07-15', campaign: 'Annual', amount: 100 }], new Date('2026-07-30T12:00:00Z'));
  assert.equal(snapshot.currentCampaign, 'Annual');
  assert.equal(donorFundraisingSnapshot({}, [], []).currentAskAmount, '');
  assert.equal(donorFundraisingSnapshot({}, [], []).currentCampaign, '');
  assert.equal(snapshot.overdueFollowUp, true);
  assert.equal(snapshot.openActivities, 1);
  assert.match(snapshot.lastMeaningfulInteraction, /Call/);
});

test('Donor 360 UI displays donor code and wires quick actions to existing flows', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /Donor Overview/);
  assert.match(app, /Donor code/);
  assert.match(app, /profileAddGift'\)\.onclick = openGiftQuickAction/);
  assert.match(app, /Gift Entry will be available in a future update\./);
  assert.doesNotMatch(app, /function openGiftQuickAction\(\) \{[\s\S]*openDonor\(donorProfileRecord\)/);
  assert.match(app, /profileAddActivity'\)\.onclick = \(\) => openActivityModal\(\)/);
  assert.match(app, /profileAddNote'\)\.onclick = \(\) => openActivityModalWithDefaults\(\{ activity_type: 'note'/);
  assert.match(app, /profileScheduleFollowUp'\)\.onclick = \(\) => openActivityModalWithDefaults\(\{ activity_type: 'other'/);
});

test('Donor 360 omits unsupported fundraising snapshot rows instead of showing placeholders', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /snapshot\.currentAskAmount \? profileMetric\('Current ask amount', snapshot\.currentAskAmount\) : ''/);
  assert.match(app, /snapshot\.currentCampaign \? profileMetric\('Campaign or opportunity', snapshot\.currentCampaign\) : ''/);
  assert.match(app, /\]\.filter\(Boolean\)\.join\(''\)/);
});

test('Donor 360 queries remain tenant-isolated and non-destructive', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /\.from\('crm_donors'\)[\s\S]*\.eq\('owner_user_id', userId\)[\s\S]*\.eq\('id', donorId\)/);
  assert.match(app, /\.from\('donor_activities'\)[\s\S]*\.eq\('owner_user_id', userId\)[\s\S]*\.eq\('donor_id', donorProfileRecord\.id\)/);
  assert.match(app, /\.from\('donor_gifts'\)[\s\S]*\.eq\('owner_user_id', userId\)[\s\S]*\.eq\('donor_id', donorProfileRecord\.id\)/);
  assert.doesNotMatch(app, /\.from\('donor_gifts'\)[\s\S]*\.delete\(/);
});
