import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildDashboardViewModel,
  sampleDashboardViewModel
} from '../public/dashboard.js';

const now = new Date('2026-07-29T14:00:00Z');

function liveRows() {
  return {
    donors: [
      {
        id: 'donor-1',
        donor_code: '001',
        first_name: 'Ari',
        last_name: 'Cohen',
        is_archived: false,
        last_gift_amount: 500,
        last_gift_date: '2026-07-01',
        next_action: 'Call about scholarship campaign',
        next_action_date: '2026-07-29',
        last_contact_date: '2026-03-01',
        notes: '',
        created_at: '2026-07-20T12:00:00Z'
      },
      {
        id: 'donor-2',
        donor_code: '002',
        household_name: 'Archived Household',
        is_archived: true,
        last_gift_amount: 9000,
        last_gift_date: '2026-07-10',
        created_at: '2026-07-21T12:00:00Z'
      },
      {
        id: 'donor-3',
        donor_code: '003',
        first_name: 'Leah',
        last_name: 'Rosen',
        is_archived: false,
        last_gift_amount: 1000,
        last_gift_date: '2026-07-15',
        last_contact_date: '2026-07-22',
        notes: 'Longtime supporter',
        created_at: '2025-01-05T12:00:00Z'
      }
    ],
    activities: [
      {
        id: 'activity-1',
        donor_id: 'donor-1',
        activity_type: 'meeting',
        subject: 'Campaign meeting',
        occurred_at: '2026-07-28T16:00:00Z',
        next_action: 'Send meeting recap',
        next_action_date: '2026-07-29',
        is_archived: false
      }
    ],
    knowledge: [
      {
        id: 'knowledge-1',
        title: 'Campaign brief',
        source_type: 'upload',
        updated_at: '2026-07-29T12:00:00Z'
      }
    ],
    generations: [
      {
        id: 'generation-1',
        title: 'Stewardship email',
        mode: 'writer',
        created_at: '2026-07-29T13:00:00Z'
      }
    ]
  };
}

test('dashboard calculates actionable KPIs from active live donor data', () => {
  const dashboard = buildDashboardViewModel(liveRows(), now);
  assert.equal(dashboard.isSample, false);
  assert.deepEqual(dashboard.kpis.map(kpi => kpi.value), ['$1,500', '2', '2', '2']);
  assert.match(dashboard.kpis[0].trend, /2 recorded gifts/);
  assert.equal(dashboard.priorities.length, 2);
  assert.ok(dashboard.priorities.every(item => item.kind === 'today'));
});

test('dashboard insights and timeline use existing CRM workspace records', () => {
  const dashboard = buildDashboardViewModel(liveRows(), now);
  const insights = Object.fromEntries(dashboard.insights.map(item => [item.title, item.value]));
  assert.equal(insights['Donors needing follow-up'], 0);
  assert.equal(insights['Stale relationships'], 1);
  assert.equal(insights['Stewardship opportunities'], 1);
  assert.equal(insights['Recently active donors'], 1);
  assert.equal(insights['Missing donor notes'], 1);
  assert.equal(dashboard.recentActivity[0].title, 'Stewardship email');
  assert.ok(dashboard.recentActivity.some(item => item.detail === 'Knowledge document uploaded'));
});

test('upcoming actions remain separate from today priorities', () => {
  const rows = liveRows();
  rows.donors[0].next_action_date = '2026-08-02';
  rows.activities[0].next_action_date = '2026-08-03';
  const dashboard = buildDashboardViewModel(rows, now);
  assert.equal(dashboard.priorities.length, 0);
  assert.deepEqual(dashboard.upcoming.map(item => item.dueLabel), ['Aug 2', 'Aug 3']);
});

test('sample dashboard content is explicitly labeled', () => {
  const dashboard = sampleDashboardViewModel();
  assert.equal(dashboard.isSample, true);
  assert.ok(dashboard.kpis.every(kpi => kpi.trend.startsWith('Example')));
  assert.match(dashboard.priorities[0].detail, /Example/);
});

test('dashboard preserves existing data sources and exposes the Version 2.1 quick actions', async () => {
  const [app, html] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  ]);

  for (const table of ['crm_donors', 'donor_activities', 'knowledge_documents', 'generations']) {
    assert.match(app, new RegExp(`\\.from\\('${table}'\\)`));
  }
  assert.match(app, /Promise\.all\(\[/);
  assert.match(html, /data-dashboard-action="add-donor"/);
  assert.match(html, /data-dashboard-action="add-gift"/);
  assert.match(html, /data-dashboard-action="log-interaction"/);
  assert.match(html, /data-dashboard-action="add-follow-up"/);
  assert.match(html, /data-dashboard-action="export-data"/);
  assert.match(html, /data-dashboard-action="open-studio"/);
});
