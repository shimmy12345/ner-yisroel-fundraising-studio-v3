import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

test('Netlify publishes the root app and maps API paths to functions', async () => {
  const config = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(config, /publish\s*=\s*"public"/);
  assert.match(config, /functions\s*=\s*"netlify\/functions"/);
  assert.match(config, /command\s*=\s*"npm run build"/);
  assert.match(config, /from\s*=\s*"\/api\/\*"/);
  assert.match(config, /to\s*=\s*"\/\.netlify\/functions\/:splat"/);
  await access(new URL('../netlify/functions/generate.mjs', import.meta.url));
  await access(new URL('../netlify/functions/process-document.mjs', import.meta.url));
  await access(new URL('../netlify/functions/knowledge-document.mjs', import.meta.url));
  await access(new URL('../netlify/functions/import-donors.mjs', import.meta.url));
});

test('donor imports use only crm_donors and keep the service-role key server-side', async () => {
  const importFunction = await readFile(new URL('../netlify/functions/import-donors.mjs', import.meta.url), 'utf8');
  const authHelper = await readFile(new URL('../netlify/functions/_shared/auth.mjs', import.meta.url), 'utf8');
  assert.match(importFunction, /\.from\('crm_donors'\)/);
  assert.doesNotMatch(importFunction, /\.from\('donors'\)/);
  assert.match(authHelper, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
});

test('visible donor dashboard and CRUD use crm_donors without legacy donor queries', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\.from\('donors'\)/);
  assert.match(app, /\.from\('crm_donors'\)[\s\S]*\.select\(CRM_DONOR_FIELDS\.join\(','\)\)/);
  assert.match(app, /supabase\.from\('crm_donors'\)\.update\(row\)/);
  assert.match(app, /supabase\.from\('crm_donors'\)\.insert\(row\)/);
  assert.doesNotMatch(app, /relationship_type|dRelationship|dInterests/);
  assert.match(html, /id="donorSearch"/);
  assert.match(html, /id="donorStageFilter"/);
  assert.match(html, /id="donorOfficerFilter"/);
  assert.match(html, /id="donorStatusFilter"[\s\S]*value="active"[\s\S]*value="archived"[\s\S]*value="all"/);
  assert.match(html, /id="donorSort"[\s\S]*<option value="last-name-asc">Last Name \(A–Z\)<\/option>/);
  assert.doesNotMatch(app, /\.from\('crm_donors'\)\.delete\(/);
  assert.match(app, /\.from\('crm_donors'\)[\s\S]*\.update\(archiveDonorPayload\(!restoring\)\)/);
});

test('donor cards open the profile while the edit control keeps direct edit behavior', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="donorProfilePanel"/);
  assert.match(app, /article\.onclick = \(\) => openDonorProfile\(row\.id\)/);
  assert.match(
    app,
    /article\.querySelector\('\.edit-donor'\)\.onclick = event => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*openDonor\(row\)/
  );
});

test('profile navigation preserves dashboard state and refreshes donor mutations in place', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /donorDashboardScrollPosition = window\.scrollY/);
  assert.match(app, /function returnToDonors\(\)[\s\S]*window\.scrollTo\(\{ top: donorDashboardScrollPosition/);
  assert.match(app, /if \(editingFromProfile\) await loadDonorProfile\(modalRecord\.id, \{ showLoading: false \}\)/);
  assert.match(app, /if \(updatingFromProfile\) await loadDonorProfile\(donorId, \{ showLoading: false \}\)/);
  const returnBody = app.match(/function returnToDonors\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(returnBody, /loadDonors\(/);
});

test('donor profile introduces no URL routing or Netlify Function', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const config = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  const migrations = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const functions = (await readdir(new URL('../netlify/functions/', import.meta.url), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  assert.doesNotMatch(app, /pushState|popstate|hashchange|location\.hash/);
  assert.doesNotMatch(config, /from\s*=\s*"\/\*"/);
  assert.deepEqual(migrations.sort(), [
    '20260722_knowledge_base_uploads.sql',
    '20260729_crm_donor_archive.sql',
    '20260729_donor_activity_timeline.sql',
    '20260729_per_user_data_isolation.sql'
  ]);
  assert.deepEqual(functions, [
    'generate.mjs',
    'import-donors.mjs',
    'knowledge-document.mjs',
    'process-document.mjs'
  ]);
});

test('donor activity migration uses parent-donor RLS and never permits deletion', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260729_donor_activity_timeline.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table public\.donor_activities/i);
  assert.match(migration, /donor_id uuid not null references public\.crm_donors\(id\) on delete restrict/i);
  assert.match(migration, /activity_type in \([\s\S]*'phone_call'[\s\S]*'other'[\s\S]*\)/i);
  assert.doesNotMatch(migration, /'gift'/i);
  assert.match(migration, /alter table public\.donor_activities enable row level security/i);
  assert.match(migration, /for select\s+to authenticated[\s\S]*from public\.crm_donors/i);
  assert.match(migration, /for insert\s+to authenticated[\s\S]*from public\.crm_donors/i);
  assert.match(migration, /for update\s+to authenticated[\s\S]*from public\.crm_donors/i);
  assert.doesNotMatch(migration, /create policy[\s\S]{0,120}for delete/i);
  assert.match(migration, /new\.created_by := auth\.uid\(\)/i);
  assert.match(migration, /new\.created_by := old\.created_by/i);
  assert.match(migration, /grant select, insert, update on public\.donor_activities to authenticated/i);
  assert.match(migration, /revoke delete on public\.donor_activities from authenticated, public/i);
});

test('donor activity last-contact trigger advances only from active contact activities', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260729_donor_activity_timeline.sql', import.meta.url), 'utf8');
  assert.match(migration, /new\.activity_type not in \([\s\S]*'phone_call'[\s\S]*'event'[\s\S]*\) then\s+return new/i);
  assert.match(migration, /activity\.is_archived = false/i);
  assert.match(migration, /max\(\(activity\.occurred_at at time zone 'UTC'\)::date\)/i);
  assert.match(migration, /last_contact_date is null[\s\S]*last_contact_date < latest_contact_date/i);
  assert.doesNotMatch(migration, /set last_contact_date = null/i);
});

test('activity timeline uses donor-scoped browser queries and archive updates only', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /id="addDonorActivity"/);
  assert.match(html, /id="activityModal"/);
  assert.match(html, /id="activityArchiveConfirmModal"/);
  assert.match(app, /\$\('addDonorActivity'\)\.onclick = \(\) => openActivityModal\(\)/);
  assert.match(app, /function openActivityModal\(activity = null\)/);
  assert.match(app, /article\.querySelector\('\.edit-activity'\)\.onclick = \(\) => openActivityModal\(activity\)/);
  assert.match(app, /\.from\('donor_activities'\)[\s\S]*\.eq\('donor_id', donorProfileRecord\.id\)[\s\S]*\.eq\('is_archived', donorActivityView === 'archived'\)[\s\S]*\.order\('occurred_at', \{ ascending: false \}\)/);
  assert.match(app, /\.range\(from, from \+ ACTIVITY_PAGE_SIZE\)/);
  assert.match(app, /function openDonorProfile\(donorId\) \{[\s\S]*donorActivityView = 'active'/);
  assert.match(app, /activityModalRecord[\s\S]*\.from\('donor_activities'\)[\s\S]*\.update\(payload\)/);
  assert.match(app, /\.update\(\{ is_archived: !restoring \}\)/);
  assert.match(app, /Restore Activity/);
  assert.doesNotMatch(app, /\.from\('donor_activities'\)\.delete\(/);
  assert.match(app, /await loadDonorProfile\(donorId, \{ showLoading: false \}\)/);
  assert.match(app, /function returnToDonors\(\)[\s\S]*donorDashboardScrollPosition/);
  assert.match(styles, /@media\(max-width:650px\)\{[\s\S]*\.activity-item\{grid-template-columns:1fr\}[\s\S]*\.activity-details\{grid-template-columns:1fr\}/);
  assert.match(styles, /\.activity-content\{min-width:0\}/);
  assert.match(styles, /\.activity-notes\{[\s\S]*overflow-wrap:anywhere/);
});

test('CRM donor archive migration preserves rows and prohibits permanent deletion', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260729_crm_donor_archive.sql', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists is_archived boolean/i);
  assert.match(migration, /set is_archived = false[\s\S]*where is_archived is null/i);
  assert.match(migration, /alter column is_archived set default false/i);
  assert.match(migration, /alter column is_archived set not null/i);
  assert.doesNotMatch(migration, /\bdelete\b/i);
});

test('successful donor imports refresh the CRM dashboard in the background', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(totals\.inserted \+ totals\.updated > 0\) \{[\s\S]*await loadDonors\(\{ background: true \}\)/);
});

test('browser sources never reference the service-role key', async () => {
  const files = ['../public/index.html', '../public/app.js', '../public/donor-import.js', '../public/crm-donors.js', '../public/donor-profile.js', '../public/donor-activities.js', '../public/runtime-config.js', '../build.mjs'];
  const browserSource = (await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(browserSource, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
});

test('PDF support is serverless-safe and absent from the function startup path', async () => {
  const processing = await readFile(new URL('../netlify/functions/_shared/document-processing.mjs', import.meta.url), 'utf8');
  const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  assert.doesNotMatch(processing, /^import .*pdf-parse/m);
  assert.doesNotMatch(packageJson, /"pdf-parse"/);
  assert.match(processing, /await import\('unpdf'\)/);
});

test('npm deployment pins Supabase and Node without the broken tracing dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLockSource = await readFile(new URL('../package-lock.json', import.meta.url), 'utf8');
  const packageLock = JSON.parse(packageLockSource);
  assert.equal(packageJson.dependencies['@supabase/supabase-js'], '2.57.0');
  assert.equal(packageJson.engines.node, '22.x');
  assert.equal(packageLock.packages['node_modules/@supabase/supabase-js'].version, '2.57.0');
  assert.doesNotMatch(packageLockSource, /@supabase\/tracing/);
  await assert.rejects(access(new URL('../pnpm-lock.yaml', import.meta.url)));
});
