import { json, requireUser } from './_shared/auth.mjs';
import {
  ACTIVITY_EXPORT_COLUMNS,
  CAMPAIGN_EXPORT_COLUMNS,
  DONOR_EXPORT_COLUMNS,
  GIFT_EXPORT_COLUMNS,
  activityExportRow,
  createExportFile,
  donorExportRow,
  exportedDonorName,
  giftExportRow
} from './_shared/export-data.mjs';

const PAGE_SIZE = 1_000;
const MAX_ROWS_PER_DATASET = 25_000;
const SCOPES = new Set([
  'all',
  'donors',
  'selected_donors',
  'gifts',
  'activities',
  'pledges',
  'relationships',
  'campaigns',
  'donor_profile',
  'donor_gifts'
]);
const FORMATS = new Set(['csv', 'xlsx', 'json']);

function clean(value) {
  return String(value ?? '').trim();
}

async function collect(queryFactory) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS_PER_DATASET; from += PAGE_SIZE) {
    const { data, error } = await queryFactory().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw Object.assign(new Error(`Export exceeds the ${MAX_ROWS_PER_DATASET.toLocaleString()}-row safety limit.`), { status: 413 });
}

function applyDonorFilters(query, filters) {
  if (filters.donorId) query = query.eq('id', filters.donorId);
  if (filters.donorIds.length) query = query.in('id', filters.donorIds);
  if (filters.officer) query = query.ilike('assigned_officer', filters.officer);
  return query;
}

function applyRelatedFilters(query, filters) {
  if (filters.donorId) query = query.eq('donor_id', filters.donorId);
  if (filters.donorIds.length) query = query.in('donor_id', filters.donorIds);
  if (filters.dateFrom) query = query.gte('gift_date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('gift_date', filters.dateTo);
  if (filters.campaign) query = query.ilike('campaign', filters.campaign);
  return query;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const { user, supabase } = await requireUser(event);
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Request body must be valid JSON.' }); }
    const scope = clean(body.scope) || 'all';
    const format = clean(body.format) || 'csv';
    if (!SCOPES.has(scope)) return json(400, { error: 'Choose a valid export scope.' });
    if (!FORMATS.has(format)) return json(400, { error: 'Choose CSV, Excel, or JSON.' });
    const filters = {
      donorId: clean(body.filters?.donor_id),
      donorIds: Array.isArray(body.filters?.donor_ids)
        ? [...new Set(body.filters.donor_ids.map(clean).filter(Boolean))].slice(0, 1_000)
        : [],
      dateFrom: clean(body.filters?.date_from),
      dateTo: clean(body.filters?.date_to),
      campaign: clean(body.filters?.campaign),
      officer: clean(body.filters?.assigned_officer)
    };
    if (['donor_profile', 'donor_gifts'].includes(scope) && !filters.donorId) {
      return json(400, { error: 'Choose a donor for this export.' });
    }

    const wantDonors = ['all', 'donors', 'selected_donors', 'donor_profile'].includes(scope);
    const wantGifts = ['all', 'gifts', 'donor_profile', 'donor_gifts', 'campaigns'].includes(scope);
    const wantActivities = ['all', 'activities', 'donor_profile'].includes(scope);
    const datasets = [];
    let donorRows = [];
    const needsDonorLookup = wantDonors || wantGifts || wantActivities || ['pledges', 'relationships'].includes(scope);
    if (needsDonorLookup) {
      donorRows = await collect(() => applyDonorFilters(
        supabase.from('crm_donors').select('*').eq('owner_user_id', user.id).order('id'),
        filters
      ));
    }
    const donorsById = new Map(donorRows.map(row => [row.id, row]));

    if (wantDonors) {
      datasets.push({ key: 'donors', name: 'Donors', columns: DONOR_EXPORT_COLUMNS, rows: donorRows.map(donorExportRow) });
    }
    let gifts = [];
    if (wantGifts) {
      gifts = await collect(() => applyRelatedFilters(
        supabase.from('donor_gifts').select('*').eq('owner_user_id', user.id).eq('is_deleted', false).order('gift_date', { ascending: false }),
        filters
      ));
      if (scope !== 'campaigns') {
        datasets.push({
          key: 'gifts',
          name: 'Gifts',
          columns: GIFT_EXPORT_COLUMNS,
          rows: gifts.map(gift => giftExportRow(gift, donorsById))
        });
      }
    }
    if (wantActivities) {
      const activities = await collect(() => {
        let query = supabase.from('donor_activities').select('*').eq('owner_user_id', user.id).order('occurred_at', { ascending: false });
        if (filters.donorId) query = query.eq('donor_id', filters.donorId);
        if (filters.donorIds.length) query = query.in('donor_id', filters.donorIds);
        if (filters.dateFrom) query = query.gte('occurred_at', `${filters.dateFrom}T00:00:00Z`);
        if (filters.dateTo) query = query.lte('occurred_at', `${filters.dateTo}T23:59:59Z`);
        return query;
      });
      datasets.push({
        key: 'activities',
        name: 'Activities',
        columns: ACTIVITY_EXPORT_COLUMNS,
        rows: activities.map(activity => activityExportRow(activity, donorsById))
      });
    }
    if (['all', 'pledges'].includes(scope)) datasets.push({ key: 'pledges', name: 'Pledges', columns: ['pledge_id', 'donor_id', 'donor_name'], rows: [] });
    if (['all', 'relationships'].includes(scope)) datasets.push({ key: 'relationships', name: 'Relationships', columns: ['relationship_id', 'donor_id', 'donor_name', 'related_donor_id', 'related_donor_name'], rows: [] });
    if (['all', 'campaigns'].includes(scope)) {
      datasets.push({
        key: 'campaign_participation',
        name: 'Campaign Participation',
        columns: CAMPAIGN_EXPORT_COLUMNS,
        rows: gifts.filter(gift => gift.campaign).map(gift => ({
          gift_id: gift.id,
          donor_id: gift.donor_id,
          donor_name: exportedDonorName(donorsById.get(gift.donor_id)),
          campaign: gift.campaign,
          gift_date: gift.gift_date,
          amount: gift.amount
        }))
      });
    }

    const file = await createExportFile(datasets, format, {
      owner_user_id: user.id,
      scope,
      filters
    });
    const date = new Date().toISOString().slice(0, 10);
    return json(200, {
      filename: `ner-yisroel-${scope.replaceAll('_', '-')}-${date}.${file.extension}`,
      content_type: file.contentType,
      base64: file.buffer.toString('base64'),
      record_count: datasets.reduce((sum, dataset) => sum + dataset.rows.length, 0)
    });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error('Export generation failed');
    return json(error.status || 500, { error: error.message || 'Export generation failed.' });
  }
}
