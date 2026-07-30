import { json, requireUser } from './_shared/auth.mjs';

async function findAsset(supabase, id) {
  const { data, error } = await supabase
    .from('media_assets')
    .select('*')
    .eq('id', id)
    .eq('is_deleted', false)
    .single();
  if (error || !data) throw Object.assign(new Error('Media asset not found.'), { status: 404 });
  return data;
}

export async function handler(event) {
  try {
    const { supabase } = await requireUser(event);
    if (event.httpMethod === 'GET') {
      const id = String(event.queryStringParameters?.id || '');
      if (!id) return json(400, { error: 'Media asset id is required.' });
      const asset = await findAsset(supabase, id);
      const { data, error } = await supabase.storage
        .from('media-assets')
        .createSignedUrl(asset.storage_path, 300, {
          download: event.queryStringParameters?.download === 'true'
            ? asset.original_filename
            : undefined
        });
      if (error) throw error;
      return json(200, { asset, url: data.signedUrl, expires_in: 300 });
    }
    if (event.httpMethod === 'DELETE') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Request body must be valid JSON.' }); }
      const id = String(body.id || '');
      if (!id) return json(400, { error: 'Media asset id is required.' });
      const asset = await findAsset(supabase, id);
      const { error: updateError } = await supabase
        .from('media_assets')
        .update({ is_deleted: true })
        .eq('id', id);
      if (updateError) throw updateError;
      const { error: storageError } = await supabase.storage.from('media-assets').remove([asset.storage_path]);
      if (storageError) {
        console.error('Media Storage cleanup failed');
        return json(200, { deleted: true, warning: 'Metadata was archived, but Storage cleanup must be retried.' });
      }
      return json(200, { deleted: true });
    }
    return json(405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error('Media asset request failed');
    return json(error.status || 500, { error: error.message || 'Media request failed.' });
  }
}
