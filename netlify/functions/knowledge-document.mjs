import { requireUser, json } from './_shared/auth.mjs';

async function findDocument(supabase, id) {
  const { data, error } = await supabase.from('knowledge_documents').select('id,title,file_name,storage_path').eq('id', id).single();
  if (error || !data) throw Object.assign(new Error('Document not found.'), { status: 404 });
  return data;
}

export async function handler(event) {
  try {
    const { supabase } = await requireUser(event);
    if (event.httpMethod === 'GET') {
      const id = String(event.queryStringParameters?.id || '');
      if (!id) return json(400, { error: 'Document id is required.' });
      const document = await findDocument(supabase, id);
      if (!document.storage_path) return json(200, { url: null });
      const { data, error } = await supabase.storage.from('knowledge-files').createSignedUrl(document.storage_path, 300, { download: document.file_name || document.title });
      if (error) throw error;
      return json(200, { url: data.signedUrl, expiresIn: 300 });
    }

    if (event.httpMethod === 'DELETE') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Request body must be valid JSON.' }); }
      const id = String(body.id || '');
      if (!id) return json(400, { error: 'Document id is required.' });
      const document = await findDocument(supabase, id);
      const { error: deleteError } = await supabase.from('knowledge_documents').delete().eq('id', id);
      if (deleteError) throw deleteError;
      let storageWarning = null;
      if (document.storage_path) {
        const { error } = await supabase.storage.from('knowledge-files').remove([document.storage_path]);
        if (error) {
          console.error('Orphaned knowledge file', error);
          storageWarning = 'The database record was deleted, but Storage cleanup must be retried.';
        }
      }
      return json(200, { deleted: true, warning: storageWarning });
    }
    return json(405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!error.status || error.status >= 500) console.error(error);
    return json(error.status || 500, { error: error.message || 'Knowledge document request failed.' });
  }
}
