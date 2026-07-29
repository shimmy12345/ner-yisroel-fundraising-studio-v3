import { json, requireUser, serviceClient } from './_shared/auth.mjs';
import {
  DONOR_FIELDS,
  importRowsForOwner,
  mergeForUpsert,
  normalizeImportRows
} from './_shared/donor-import.mjs';

const MAX_ROWS = 5_000;
const QUERY_BATCH_SIZE = 500;
const UPSERT_BATCH_SIZE = 250;

function batches(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const { user } = await requireUser(event);
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Request body must be valid JSON.' }); }
    if (!Array.isArray(body.rows)) return json(400, { error: 'rows must be an array.' });
    if (body.rows.length > MAX_ROWS) return json(413, { error: `A request may contain at most ${MAX_ROWS} rows.` });

    const totalReceived = body.rows.length;
    const normalized = normalizeImportRows(body.rows);
    const client = serviceClient();
    const existingRows = [];
    for (const codeBatch of batches(normalized.rows.map(row => row.data.donor_code), QUERY_BATCH_SIZE)) {
      if (!codeBatch.length) continue;
      const { data, error } = await client
        .from('crm_donors')
        .select(DONOR_FIELDS.join(','))
        .eq('owner_user_id', user.id)
        .in('donor_code', codeBatch);
      if (error) throw error;
      existingRows.push(...(data || []));
    }

    const prepared = mergeForUpsert(normalized.rows, existingRows);
    let inserted = 0;
    let updated = 0;
    const errors = [...normalized.errors];
    const existingCodes = new Set(existingRows.map(row => String(row.donor_code)));

    for (const itemBatch of batches(prepared.rows, UPSERT_BATCH_SIZE)) {
      const ownedBatch = importRowsForOwner(itemBatch, user.id);
      const { error } = await client
        .from('crm_donors')
        .upsert(ownedBatch.map(item => item.data), { onConflict: 'owner_user_id,donor_code' });
      if (error) {
        itemBatch.forEach(item => errors.push({
          row: item.rowNumber,
          error: 'The database rejected this import batch.'
        }));
        continue;
      }
      itemBatch.forEach(item => {
        if (existingCodes.has(item.data.donor_code)) updated += 1;
        else inserted += 1;
      });
    }

    return json(200, {
      total_received: totalReceived,
      inserted,
      updated,
      rejected: errors.length,
      errors
    });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error('Donor import failed');
    return json(error.status || 500, { error: error.message || 'Donor import failed.' });
  }
}
