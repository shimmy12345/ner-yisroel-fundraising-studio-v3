import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);
const stylesUrl = new URL('../public/styles.css', import.meta.url);

test('official branding replaces the placeholder on login and in the application shell', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  await access(new URL('../public/NIRC_logo.png', import.meta.url));

  assert.equal((html.match(/src="NIRC_logo\.png"/g) || []).length, 2);
  assert.match(html, /class="auth-logo"[\s\S]*alt="Ner Israel Rabbinical College"/);
  assert.match(html, /class="sidebar-logo"[\s\S]*alt="Ner Israel Rabbinical College"/);
  assert.match(html, /rel="icon" type="image\/png" href="NIRC_logo\.png"/);
  assert.doesNotMatch(html, />\s*נר\s*</);
  assert.doesNotMatch(html, /favicon\.svg/);
});

test('dashboard is the first navigation item and the default signed-in panel', async () => {
  const [html, app] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8')
  ]);

  const dashboardNav = html.indexOf('data-panel="dashboard"');
  const studioNav = html.indexOf('data-panel="studio"');
  assert.ok(dashboardNav >= 0 && dashboardNav < studioNav);
  assert.match(html, /id="dashboardPanel"[\s\S]*Today's Priorities[\s\S]*Recent Activity[\s\S]*AI Insights[\s\S]*Quick Actions/);
  assert.doesNotMatch(html, /Dashboard coming soon/);
  assert.match(app, /showPanel\('dashboard'\)/);
  assert.match(app, /if \(name === 'dashboard'\) loadDashboard\(\)/);
  assert.match(app, /dashboard:[\s\S]*title: 'Dashboard'[\s\S]*subtitle: 'Fundraising Command Center'/);
});

test('shared header owns account controls and exposes a title and subtitle for every page', async () => {
  const [html, app] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8')
  ]);
  const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)?.[0] || '';
  const header = html.match(/<header class="workspace-header"[\s\S]*?<\/header>/)?.[0] || '';

  assert.doesNotMatch(sidebar, /userEmail|signOut/);
  assert.match(header, /id="pageTitle"/);
  assert.match(header, /id="pageSubtitle"/);
  assert.match(header, /id="userEmail"/);
  assert.match(header, /id="signOut"/);
  for (const subtitle of [
    'Fundraising Command Center',
    'AI-Powered Fundraising Communications',
    'Private Institutional Knowledge',
    'Relationship Management',
    'Previous AI Conversations'
  ]) {
    assert.match(app, new RegExp(subtitle));
  }
});

test('responsive shell avoids fixed navigation and horizontal page scrolling', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  assert.match(styles, /body\{[\s\S]*overflow-x:hidden/);
  assert.match(styles, /@media\(max-width:950px\)[\s\S]*\.workspace-nav\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media\(max-width:720px\)[\s\S]*\.workspace-nav\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media\(max-width:520px\)[\s\S]*\.workspace-nav\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);

  const shellStyles = styles.slice(styles.indexOf('/* Phase 1 application shell */'));
  assert.doesNotMatch(shellStyles, /position:fixed/);
});
