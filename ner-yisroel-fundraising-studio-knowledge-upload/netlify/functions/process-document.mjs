import OpenAI, { toFile } from 'openai';
import { requireUser, json } from './_shared/auth.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'html', 'htm', 'rtf']);
const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'htm', 'rtf', 'xlsx', 'xls', 'pptx', 'ppt']);

function extension(name = '') {
  return name.toLowerCase().split('.').pop() || '';
}

function cleanExtractedText(text = '') {
  return text
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\u0000/g, '')
    .trim();
}

async function extractWithOpenAI(buffer, name, mimeType) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let openAIFile;
  try {
    openAIFile = await client.files.create({
      file: await toFile(buffer, name, { type: mimeType || 'application/octet-stream' }),
      purpose: 'user_data'
    });
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      instructions: 'Extract the complete readable text from the attached document. Preserve headings, paragraph order, lists, table labels, and important numbers. Do not summarize, interpret, or add commentary. Return plain text only.',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Extract all readable text from this file.' },
          { type: 'input_file', file_id: openAIFile.id }
        ]
      }],
      store: false
    });
    return cleanExtractedText(response.output_text || '');
  } finally {
    if (openAIFile?.id) {
      try { await client.files.delete(openAIFile.id); } catch {}
    }
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const { user, supabase } = await requireUser(event);
    const body = JSON.parse(event.body || '{}');
    const storagePath = String(body.storagePath || '');
    const fileName = String(body.fileName || '').trim();
    const mimeType = String(body.mimeType || 'application/octet-stream');
    const fileSize = Number(body.fileSize || 0);
    const checksum = String(body.checksum || '').trim() || null;
    const tags = Array.isArray(body.tags) ? body.tags.map(v => String(v).trim()).filter(Boolean).slice(0, 20) : [];

    if (!fileName || !storagePath) return json(400, { error: 'File information is missing.' });
    if (!storagePath.startsWith(`${user.id}/`)) return json(403, { error: 'Invalid storage path.' });
    if (fileSize > MAX_BYTES) return json(413, { error: 'Files must be 25 MB or smaller.' });

    const ext = extension(fileName);
    if (!SUPPORTED_EXTENSIONS.has(ext)) return json(415, { error: `.${ext || 'unknown'} files are not supported yet.` });

    if (checksum) {
      const { data: duplicate, error: duplicateError } = await supabase
        .from('knowledge_documents')
        .select('id,title')
        .eq('user_id', user.id)
        .eq('checksum', checksum)
        .maybeSingle();
      if (duplicateError) throw duplicateError;
      if (duplicate) {
        await supabase.storage.from('knowledge-files').remove([storagePath]);
        return json(409, { error: `This file already exists as “${duplicate.title}”.`, duplicateId: duplicate.id });
      }
    }

    const { data: downloaded, error: downloadError } = await supabase.storage
      .from('knowledge-files')
      .download(storagePath);
    if (downloadError) throw downloadError;

    const buffer = Buffer.from(await downloaded.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Files must be 25 MB or smaller.'), { status: 413 });

    let content = '';
    if (TEXT_EXTENSIONS.has(ext)) {
      content = cleanExtractedText(buffer.toString('utf8'));
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required to extract this file type.');
      content = await extractWithOpenAI(buffer, fileName, mimeType);
    }

    if (!content) throw new Error('No readable text could be extracted from this file.');

    const title = fileName.replace(/\.[^.]+$/, '') || fileName;
    const { data: row, error: insertError } = await supabase
      .from('knowledge_documents')
      .insert({
        user_id: user.id,
        title,
        content,
        source_type: 'upload',
        file_name: fileName,
        mime_type: mimeType,
        file_size: buffer.length,
        storage_path: storagePath,
        checksum,
        tags,
        favorite: false,
        extraction_status: 'ready',
        metadata: { extracted_at: new Date().toISOString(), extension: ext }
      })
      .select()
      .single();
    if (insertError) throw insertError;

    return json(200, { document: row });
  } catch (error) {
    console.error(error);
    return json(error.status || 500, { error: error.message || 'Document processing failed.' });
  }
}
