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
});

test('browser sources never reference the service-role key', async () => {
  const files = ['../public/index.html', '../public/app.js', '../public/runtime-config.js', '../build.mjs'];
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
