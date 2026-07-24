import { requireUser, json } from './_shared/auth.mjs';
import { extractDocumentText, validateDocumentRequest } from './_shared/document-processing.mjs';

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(value => String(value).trim()).filter(Boolean))].slice(0, 20);
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  let cleanup;
  try {
    const { user, supabase } = await requireUser(event);
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Request body must be valid JSON.' }); }

    const storagePath = String(body.storagePath || '');
    const fileName = String(body.fileName || '').trim();
    const mimeType = String(body.mimeType || '');
    const fileSize = Number(body.fileSize);
    const checksum = String(body.checksum || '').trim() || null;
    const tags = normalizeTags(body.tags);
    const { ext } = validateDocumentRequest({ fileName, mimeType, fileSize, storagePath, userId: user.id });
    cleanup = () => supabase.storage.from('knowledge-files').remove([storagePath]);

    if (checksum) {
      const { data: duplicate, error } = await supabase
        .from('knowledge_documents')
        .select('id,title')
        .eq('checksum', checksum)
        .maybeSingle();
      if (error) throw error;
      if (duplicate) {
        await cleanup();
        cleanup = null;
        return json(409, { error: `This file already exists as “${duplicate.title}”.`, duplicateId: duplicate.id });
      }
    }

    const { data: downloaded, error: downloadError } = await supabase.storage.from('knowledge-files').download(storagePath);
    if (downloadError) throw downloadError;
    const buffer = Buffer.from(await downloaded.arrayBuffer());
    const extracted = await extractDocumentText(buffer, ext);
    const title = fileName.replace(/\.[^.]+$/, '') || fileName;

    const { data: document, error: insertError } = await supabase
      .from('knowledge_documents')
      .insert({
        user_id: user.id,
        title,
        content: extracted.content,
        source_type: 'upload',
        file_name: fileName,
        mime_type: mimeType || 'application/octet-stream',
        file_size: buffer.length,
        storage_path: storagePath,
        checksum,
        tags,
        favorite: false,
        extraction_status: 'ready',
        metadata: {
          extension: ext,
          extracted_at: new Date().toISOString(),
          original_character_count: extracted.originalCharacterCount,
          text_truncated: extracted.truncated
        }
      })
      .select()
      .single();
    if (insertError) throw insertError;
    cleanup = null;
    return json(200, { document });
  } catch (error) {
    if (cleanup) {
      try { await cleanup(); } catch (cleanupError) { console.error('Upload cleanup failed', cleanupError); }
    }
    if (!error.status || error.status >= 500) console.error(error);
    return json(error.status || 500, { error: error.message || 'Document processing failed.' });
  }
}
