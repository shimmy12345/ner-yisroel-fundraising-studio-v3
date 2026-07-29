import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

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
  const files = ['../public/index.html', '../public/app.js', '../public/donor-import.js', '../public/crm-donors.js', '../public/runtime-config.js', '../build.mjs'];
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
