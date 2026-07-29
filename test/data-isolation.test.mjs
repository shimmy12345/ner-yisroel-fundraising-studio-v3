import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { donorMetrics, normalizeCrmDonorPayload } from '../public/crm-donors.js';
import {
  importRowsForOwner,
  normalizeImportRows
} from '../netlify/functions/_shared/donor-import.mjs';

const migrationUrl = new URL('../supabase/migrations/20260729_per_user_data_isolation.sql', import.meta.url);

test('ownership migration backfills donors and activities before enforcing non-null owners', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /alter table public\.crm_donors[\s\S]*add column if not exists owner_user_id uuid/i);
  assert.match(migration, /alter table public\.donor_activities[\s\S]*add column if not exists owner_user_id uuid/i);
  assert.match(migration, /foreign key \(owner_user_id\) references auth\.users\(id\) on delete restrict/gi);
  assert.match(migration, /production_owner_text constant text := 'YOUR_EXISTING_AUTH_USER_UUID'/i);
  assert.match(migration, /if production_owner_text = \('YOUR_EXISTING_AUTH_USER_' \|\| 'UUID'\) then[\s\S]*raise exception/i);
  assert.equal(migration.match(/YOUR_EXISTING_AUTH_USER_UUID/g)?.length, 1);
  assert.match(migration, /select 1 from auth\.users where id = production_owner/i);
  assert.match(migration, /update public\.crm_donors[\s\S]*set owner_user_id = production_owner[\s\S]*where owner_user_id is null/i);
  assert.match(migration, /update public\.donor_activities as activity[\s\S]*set owner_user_id = donor\.owner_user_id[\s\S]*from public\.crm_donors as donor/i);
  assert.match(migration, /activity\.owner_user_id <> donor\.owner_user_id/i);
  assert.match(migration, /alter table public\.crm_donors[\s\S]*alter column owner_user_id set default auth\.uid\(\)[\s\S]*alter column owner_user_id set not null/i);
  assert.match(migration, /alter table public\.donor_activities[\s\S]*alter column owner_user_id set default auth\.uid\(\)[\s\S]*alter column owner_user_id set not null/i);
});

test('ownership migration adds owner indexes and scopes donor-code uniqueness per user', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  for (const indexName of [
    'crm_donors_owner_user_id_idx',
    'crm_donors_owner_archive_idx',
    'donor_activities_owner_user_id_idx',
    'donor_activities_owner_donor_occurred_idx'
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${indexName}`, 'i'));
  }
  assert.match(migration, /constraint_name\.contype = 'u'[\s\S]*constraint_name\.conkey\[1\][\s\S]*donor_code_column\.attname = 'donor_code'/i);
  assert.match(migration, /create unique index if not exists crm_donors_owner_donor_code_key[\s\S]*\(owner_user_id, donor_code\)/i);
});

test('database triggers assign authenticated owners and prevent ownership transfer or donor mismatch', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  assert.match(migration, /function public\.enforce_crm_donor_owner\(\)[\s\S]*new\.owner_user_id := request_user/i);
  assert.match(migration, /new\.owner_user_id is distinct from old\.owner_user_id[\s\S]*Donor ownership cannot be changed/i);
  assert.match(migration, /function public\.enforce_donor_activity_owner\(\)[\s\S]*new\.owner_user_id := request_user/i);
  assert.match(migration, /select donor\.owner_user_id[\s\S]*where donor\.id = new\.donor_id/i);
  assert.match(migration, /donor_owner is null or donor_owner <> new\.owner_user_id/i);
  assert.match(migration, /Activity ownership cannot be changed/i);
});

test('donor and activity RLS policies require auth.uid ownership and provide no delete path', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  for (const policy of [
    'donor activities select visible donors',
    'donor activities insert visible donors',
    'donor activities update visible donors',
    'Authenticated users can view CRM donors',
    'Authenticated users can insert CRM donors',
    'Authenticated users can update CRM donors',
    'crm donors select own',
    'crm donors insert own',
    'crm donors update own',
    'donor activities select own donor',
    'donor activities insert own donor',
    'donor activities update own donor'
  ]) {
    assert.match(migration, new RegExp(`drop policy if exists "${policy}"`, 'i'));
  }
  assert.doesNotMatch(migration, /for policy_record|drop policy %I/i);
  assert.match(migration, /Unrecognized CRM policies remain:[\s\S]*explicitly drop each intended legacy policy/i);
  assert.match(migration, /create policy "crm donors select own"[\s\S]*using \(owner_user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(migration, /create policy "crm donors insert own"[\s\S]*with check \(owner_user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(migration, /create policy "crm donors update own"[\s\S]*using \(owner_user_id = \(select auth\.uid\(\)\)\)[\s\S]*with check \(owner_user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(migration, /create policy "donor activities select own donor"[\s\S]*owner_user_id = \(select auth\.uid\(\)\)[\s\S]*donor\.owner_user_id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /create policy "donor activities insert own donor"[\s\S]*owner_user_id = \(select auth\.uid\(\)\)[\s\S]*donor\.owner_user_id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /create policy "donor activities update own donor"[\s\S]*using \([\s\S]*with check \(/i);
  assert.doesNotMatch(migration, /create policy[\s\S]{0,160}for delete/i);
  assert.doesNotMatch(migration, /auth\.role\(\)\s*=\s*'authenticated'|using\s*\(\s*true\s*\)/i);
  assert.match(migration, /revoke delete on public\.crm_donors from authenticated, public/i);
  assert.match(migration, /revoke delete on public\.donor_activities from authenticated, public/i);
});

test('browser CRM queries are owner-scoped while create payloads never accept an owner', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const donorImport = await readFile(new URL('../public/donor-import.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(app, /\.from\('crm_donors'\)[\s\S]*\.eq\('owner_user_id', userId\)/);
  assert.match(app, /\.from\('donor_activities'\)[\s\S]*\.eq\('owner_user_id', userId\)[\s\S]*\.eq\('donor_id', donorProfileRecord\.id\)/);
  assert.match(app, /supabase\.from\('crm_donors'\)\.insert\(row\)/);
  assert.match(app, /supabase\.from\('donor_activities'\)\.insert\(payload\)/);
  assert.doesNotMatch(donorImport, /value:\s*'owner_user_id'/);
  assert.doesNotMatch(html, /owner_user_id/i);
  assert.doesNotMatch(app, /localStorage|sessionStorage/);

  const payload = normalizeCrmDonorPayload({
    donor_code: 'A-1',
    household_name: 'Account A',
    owner_user_id: 'attacker-controlled'
  });
  assert.equal('owner_user_id' in payload, false);
});

test('account changes clear user-scoped CRM state and invalidate stale requests', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function resetUserScopedState\(\) \{[\s\S]*crmDonorRows = \[\][\s\S]*donorProfileRecord = null[\s\S]*donorActivities = \[\]/);
  assert.match(app, /previousUserId !== nextUserId\) resetUserScopedState\(\)/);
  assert.match(app, /donorProfileRequestId \+= 1/);
  assert.match(app, /donorActivityRequestId \+= 1/);
  assert.match(app, /scopeVersion !== userScopeVersion \|\| session\?\.user\?\.id !== userId/);
  assert.deepEqual(donorMetrics([]), {
    totalDonors: 0,
    totalLifetimeGiving: 0,
    hasLifetimeGiving: false,
    missingLifetimeGiving: 0,
    withNextActions: 0,
    overdueNextActions: 0,
    notContactedNinetyDays: 0,
    missingContactDates: 0
  });
});

test('CSV normalization rejects ownership input and server rows are stamped with the authenticated owner', () => {
  const malicious = normalizeImportRows([
    { row_number: 2, donor_code: 'A-1', owner_user_id: 'another-user' }
  ]);
  assert.equal(malicious.rows.length, 0);
  assert.match(malicious.errors[0].error, /Unsupported field: owner_user_id/);

  const owned = importRowsForOwner([
    { rowNumber: 2, data: { donor_code: 'A-1', household_name: 'Owned donor' } }
  ], 'authenticated-user-id');
  assert.equal(owned[0].data.owner_user_id, 'authenticated-user-id');
  assert.throws(() => importRowsForOwner([], ''), /authenticated import owner/i);
});

test('service-role importer scopes duplicate checks and upserts to the authenticated user', async () => {
  const source = await readFile(new URL('../netlify/functions/import-donors.mjs', import.meta.url), 'utf8');
  assert.match(source, /const \{ user \} = await requireUser\(event\)/);
  assert.match(source, /\.eq\('owner_user_id', user\.id\)[\s\S]*\.in\('donor_code', codeBatch\)/);
  assert.match(source, /importRowsForOwner\(itemBatch, user\.id\)/);
  assert.match(source, /onConflict: 'owner_user_id,donor_code'/);
  assert.doesNotMatch(source, /onConflict: 'donor_code'/);
});

test('CRM browser code has no donor or activity permanent-delete calls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\.from\('crm_donors'\)\.delete\(/);
  assert.doesNotMatch(app, /\.from\('donor_activities'\)\.delete\(/);
});
