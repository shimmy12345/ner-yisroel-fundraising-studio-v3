import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import {
  annualGiving,
  filterAndSortGifts,
  fiscalYearForDate,
  giftSummary,
  normalizeGiftPayload,
  softDeleteGiftPayload
} from '../public/gifts.js';
import {
  mediaKindForFile,
  normalizeMediaMetadata,
  validateMediaFile
} from '../public/media.js';
import { buildDashboardViewModel } from '../public/dashboard.js';
import {
  activityExportRow,
  createExportFile,
  csvForRows,
  donorExportRow,
  exportedDonorName,
  giftExportRow
} from '../netlify/functions/_shared/export-data.mjs';
import {
  buildGenerationText,
  classifyGenerationAttachment as classifyAiStudioAttachment,
  friendlyGenerationError
} from '../netlify/functions/generate.mjs';

const migrationUrl = new URL('../supabase/migrations/20260730_version_2_1_fundraising_workspace.sql', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);
const exportFunctionUrl = new URL('../netlify/functions/export-data.mjs', import.meta.url);
const mediaFunctionUrl = new URL('../netlify/functions/media-asset.mjs', import.meta.url);

function dashboardRows() {
  return {
    donors: [{
      id: 'donor-1',
      donor_code: '001',
      first_name: 'Ari',
      last_name: 'Cohen',
      is_archived: false,
      lifetime_giving: 25000,
      last_contact_date: '2026-01-01',
      next_action: 'Call about campaign',
      next_action_date: '2026-07-24'
    }],
    activities: [],
    gifts: []
  };
}

test('priority scoring explains overdue work and completion removes it', () => {
  const rows = dashboardRows();
  const open = buildDashboardViewModel(rows, new Date('2026-07-30T12:00:00Z'));
  assert.equal(open.priorities.length, 1);
  assert.match(open.priorities[0].reason, /6 days overdue/);
  assert.ok(open.priorities[0].score >= 100);

  rows.donors[0].next_action_completed_at = '2026-07-30T13:00:00Z';
  const completed = buildDashboardViewModel(rows, new Date('2026-07-30T14:00:00Z'));
  assert.equal(completed.priorities.length, 0);
  assert.equal(completed.completed.length, 1);
});

test('a genuinely new follow-up can appear after an older one was completed', () => {
  const rows = dashboardRows();
  rows.donors[0].next_action_completed_at = null;
  rows.donors[0].next_action = 'Send the new proposal';
  rows.donors[0].next_action_date = '2026-07-30';
  const dashboard = buildDashboardViewModel(rows, new Date('2026-07-30T12:00:00Z'));
  assert.equal(dashboard.priorities[0].title, 'Send the new proposal');
  assert.equal(dashboard.priorities[0].reason, 'Follow-up is due today');
});

test('completed standalone meetings stay out of active priorities', () => {
  const dashboard = buildDashboardViewModel({
    donors: [],
    gifts: [],
    activities: [{
      id: 'meeting-1',
      donor_id: 'donor-1',
      activity_type: 'meeting',
      occurred_at: '2026-07-30T15:00:00Z',
      subject: 'Campaign meeting',
      is_archived: false,
      next_action: null,
      next_action_completed_at: '2026-07-30T16:00:00Z'
    }]
  }, new Date('2026-07-30T12:00:00Z'));
  assert.equal(dashboard.priorities.length, 0);
  assert.equal(dashboard.completed[0].title, 'Campaign meeting');
});

test('persistent priority completion is stored on underlying owner-scoped records', async () => {
  const [migration, app] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(appUrl, 'utf8')
  ]);
  assert.match(migration, /next_action_completed_at timestamptz/);
  assert.match(migration, /next_action_completed_by uuid references auth\.users/);
  assert.match(migration, /reset_changed_follow_up_completion/);
  assert.match(migration, /before update of next_action, next_action_date, activity_type, occurred_at, subject/);
  assert.match(app, /next_action_completed_at: completedAt/);
  assert.match(app, /\.eq\('owner_user_id', session\.user\.id\)/);
  assert.doesNotMatch(app, /localStorage[\s\S]*priority/i);
});

test('gift validation preserves numeric values and rejects invalid input', () => {
  const gift = normalizeGiftPayload({
    gift_date: '2026-07-30',
    amount: '2500.50',
    gift_type: 'daf',
    shared_credit_amount: '500'
  }, 'donor-1');
  assert.equal(gift.amount, 2500.5);
  assert.equal(gift.shared_credit_amount, 500);
  assert.throws(() => normalizeGiftPayload({ gift_date: '2026-07-30', amount: 0 }, 'donor-1'), /greater than zero/);
  assert.throws(() => normalizeGiftPayload({ gift_date: '2026-02-30', amount: 10 }, 'donor-1'), /valid gift date/);
});

test('fiscal-year totals, donor totals, and annual giving recalculate deterministically', () => {
  const gifts = [
    { id: '1', gift_date: '2025-07-01', amount: 100, is_deleted: false },
    { id: '2', gift_date: '2026-06-30', amount: 200, is_deleted: false },
    { id: '3', gift_date: '2026-07-01', amount: 400, is_deleted: false },
    { id: '4', gift_date: '2026-07-02', amount: 999, is_deleted: true }
  ];
  assert.equal(fiscalYearForDate('2026-06-30'), 2026);
  assert.equal(fiscalYearForDate('2026-07-01'), 2027);
  const summary = giftSummary(gifts, new Date('2026-07-30T12:00:00Z'));
  assert.equal(summary.lifetimeGiving, 700);
  assert.equal(summary.currentFiscalYearGiving, 400);
  assert.equal(summary.previousFiscalYearGiving, 300);
  assert.deepEqual(annualGiving(gifts).map(row => [row.fiscalYear, row.amount]), [[2026, 300], [2027, 400]]);
});

test('donation-history filters support dates, campaigns, types, search, and amount sorting', () => {
  const gifts = [
    { id: '1', gift_date: '2026-01-01', amount: 50, campaign: 'Annual', gift_type: 'direct_gift', notes: 'Scholarship', is_deleted: false },
    { id: '2', gift_date: '2026-03-01', amount: 500, campaign: 'Capital', gift_type: 'daf', notes: '', is_deleted: false },
    { id: '3', gift_date: '2026-04-01', amount: 900, campaign: 'Annual', gift_type: 'stock', is_deleted: true }
  ];
  assert.deepEqual(filterAndSortGifts(gifts, { campaign: 'Annual' }).map(row => row.id), ['1']);
  assert.deepEqual(filterAndSortGifts(gifts, { giftType: 'daf' }).map(row => row.id), ['2']);
  assert.deepEqual(filterAndSortGifts(gifts, { search: 'scholarship' }).map(row => row.id), ['1']);
  assert.deepEqual(filterAndSortGifts(gifts, { dateFrom: '2026-02-01', sort: 'amount-desc' }).map(row => row.id), ['2']);
});

test('gift writes use insert, update, and auditable soft deletion', async () => {
  const [migration, app] = await Promise.all([readFile(migrationUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.match(app, /\.from\('donor_gifts'\)\.insert\(payload\)/);
  assert.match(app, /\.from\('donor_gifts'\)\.update\(payload\)/);
  assert.deepEqual(softDeleteGiftPayload(new Date('2026-07-30T12:00:00Z')).is_deleted, true);
  assert.match(migration, /create trigger donor_gifts_recalculate_donor/);
  assert.match(migration, /create trigger donor_gifts_activity_log/);
  assert.match(migration, /revoke delete on public\.donor_gifts/);
});

test('media validation accepts supported documents, images, and videos with size limits', () => {
  assert.equal(mediaKindForFile({ name: 'brief.pdf', type: 'application/pdf' }), 'document');
  assert.equal(mediaKindForFile({ name: 'photo.heic', type: 'image/heic' }), 'image');
  assert.equal(mediaKindForFile({ name: 'event.mov', type: 'video/quicktime' }), 'video');
  assert.equal(validateMediaFile({ name: 'event.mp4', type: 'video/mp4', size: 10_000 }), 'video');
  assert.throws(() => validateMediaFile({ name: 'script.exe', type: '', size: 10 }), /not a supported/);
});

test('media metadata is normalized and storage access remains owner isolated', async () => {
  const metadata = normalizeMediaMetadata({
    tags: 'campaign, alumni, campaign',
    related_donor_id: 'donor-1'
  }, { name: 'photo.jpg', type: 'image/jpeg', size: 1200 });
  assert.deepEqual(metadata.tags, ['campaign', 'alumni']);
  assert.equal(metadata.related_donor_id, 'donor-1');
  const [migration, mediaFunction] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(mediaFunctionUrl, 'utf8')
  ]);
  assert.match(migration, /create policy "media assets select own"/);
  assert.match(migration, /split_part\(name, '\/', 1\) = \(select auth\.uid\(\)\)::text/);
  assert.match(mediaFunction, /requireUser\(event\)/);
  assert.doesNotMatch(mediaFunction, /serviceClient|SUPABASE_SERVICE_ROLE_KEY/);
});

test('AI Studio routes images separately from document context stuffing', async () => {
  const source = await readFile(new URL('../netlify/functions/generate.mjs', import.meta.url), 'utf8');
  assert.equal(classifyAiStudioAttachment({ name: 'pledge-card.jpg', type: 'image/jpeg' }), 'image');
  assert.equal(classifyAiStudioAttachment({ name: 'campus.PNG', type: 'image/png' }), 'image');
  assert.equal(classifyAiStudioAttachment({ name: 'brief.pdf', type: 'application/pdf' }), 'document');
  assert.equal(classifyAiStudioAttachment({ name: 'recording.mp4', type: 'video/mp4' }), 'video');
  assert.equal(classifyAiStudioAttachment({ name: 'archive.zip', type: 'application/zip' }), null);
  assert.match(source, /type:'input_image'/);
  assert.match(source, /image_url:`data:\$\{mime\};base64,\$\{body\.file\.base64\}`/);
  assert.match(source, /type:'input_file'/);
});

test('AI Studio generation text keeps instructions and source notes with image requests', () => {
  const text = buildGenerationText({
    audience: 'Parents',
    tone: 'Warm',
    goal: 'Create a message based on this image.',
    prompt: 'Write an appeal from the attached photo.',
    sourceText: 'Mention the scholarship dinner.'
  }, 'Campaign facts', 'writer');
  assert.match(text, /Audience: Parents/);
  assert.match(text, /Tone: Warm/);
  assert.match(text, /Desired outcome: Create a message based on this image\./);
  assert.match(text, /Instructions:\nWrite an appeal from the attached photo\./);
  assert.match(text, /Source material and notes:\nMention the scholarship dinner\./);
});

test('AI Studio returns friendly messages for image capability and video limitations', () => {
  assert.match(
    friendlyGenerationError(new Error('Invalid input: model does not support input_image')),
    /cannot analyze that attachment format/
  );
  assert.match(
    friendlyGenerationError(new Error('video/mp4 is not supported')),
    /Video analysis is not configured/
  );
});

test('exports use authenticated RLS queries, stable IDs, and bounded pagination', async () => {
  const source = await readFile(exportFunctionUrl, 'utf8');
  assert.match(source, /requireUser\(event\)/);
  assert.match(source, /PAGE_SIZE = 1_000/);
  assert.match(source, /MAX_ROWS_PER_DATASET = 25_000/);
  assert.match(source, /\.eq\('owner_user_id', user\.id\)/);
  assert.match(source, /gift_id: gift\.id/);
  assert.match(source, /donor_id: gift\.donor_id/);
  assert.doesNotMatch(source, /serviceClient|SUPABASE_SERVICE_ROLE_KEY/);
});

test('donor export rows use crm_donors primary key and readable names', () => {
  const row = donorExportRow({
    id: 'crm-donor-uuid',
    owner_user_id: 'owner-user-id',
    donor_code: '001',
    first_name: 'Ari',
    last_name: 'Cohen',
    preferred_name: 'Aryeh',
    household_name: 'Rabbi Ari Cohen Household'
  });
  assert.equal(row.donor_id, 'crm-donor-uuid');
  assert.equal(row.full_name, 'Cohen, Aryeh');
  assert.equal(row.household_name, 'Rabbi Ari Cohen Household');
  assert.equal(Object.hasOwn(row, 'owner_user_id'), false);
  assert.equal(exportedDonorName({ first_name: '', last_name: '', household_name: 'Goldstein Family' }), 'Goldstein Family');
});

test('gift and activity exports join stable donor IDs to readable donor names', () => {
  const donorsById = new Map([['donor-uuid-1', {
    id: 'donor-uuid-1',
    first_name: 'Ari',
    last_name: 'Cohen',
    household_name: 'Cohen Household'
  }]]);
  const gift = giftExportRow({ id: 'gift-uuid-1', donor_id: 'donor-uuid-1', amount: 180 }, donorsById);
  const activity = activityExportRow({ id: 'activity-uuid-1', donor_id: 'donor-uuid-1', subject: 'Call' }, donorsById);
  assert.equal(gift.gift_id, 'gift-uuid-1');
  assert.equal(gift.donor_id, 'donor-uuid-1');
  assert.equal(gift.donor_name, 'Cohen, Ari');
  assert.equal(activity.activity_id, 'activity-uuid-1');
  assert.equal(activity.donor_id, 'donor-uuid-1');
  assert.equal(activity.donor_name, 'Cohen, Ari');
});

test('CSV exports use readable headers, stable values, escaping, and numeric amounts', () => {
  const csv = csvForRows([{
    donor_id: 'donor-1',
    donor_name: 'Cohen, Ari',
    amount: 2500.5,
    notes: 'Said "thank you"'
  }], ['donor_id', 'donor_name', 'amount', 'notes']);
  assert.equal(
    csv,
    '"Donor Id","Donor Name","Amount","Notes"\r\n"donor-1","Cohen, Ari","2500.5","Said ""thank you"""'
  );
});

test('Excel exports generate separate valid worksheet parts', async () => {
  const file = await createExportFile([
    { key: 'donors', name: 'Donors', rows: [{ donor_id: 'donor-1', name: 'Ari Cohen' }] },
    { key: 'gifts', name: 'Gifts', rows: [{ gift_id: 'gift-1', amount: 100 }] }
  ], 'xlsx');
  assert.equal(file.extension, 'xlsx');
  const workbook = await JSZip.loadAsync(file.buffer);
  assert.ok(workbook.file('xl/worksheets/sheet1.xml'));
  assert.ok(workbook.file('xl/worksheets/sheet2.xml'));
  assert.match(await workbook.file('xl/workbook.xml').async('string'), /name="Donors"[\s\S]*name="Gifts"/);
});

test('JSON backup exports retain metadata, stable IDs, and separate datasets', async () => {
  const file = await createExportFile([
    { key: 'donors', name: 'Donors', rows: [{ donor_id: 'donor-1' }] },
    { key: 'gifts', name: 'Gifts', rows: [{ gift_id: 'gift-1', donor_id: 'donor-1' }] }
  ], 'json', { scope: 'all' });
  const parsed = JSON.parse(file.buffer.toString('utf8'));
  assert.equal(parsed.export_version, '2.1');
  assert.equal(parsed.scope, 'all');
  assert.equal(parsed.data.donors[0].donor_id, 'donor-1');
  assert.equal(parsed.data.gifts[0].gift_id, 'gift-1');
});
