import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DONOR_FIELDS,
  automaticMappings,
  mappingErrors,
  rejectedRowsCsv,
  validateDonorRows
} from './donor-import.js';

const cfg = window.RUNTIME_CONFIG || {};
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_FILE = /\.(txt|csv|pdf|docx)$/i;
let supabase;
let session;
let authMode = 'signin';
let currentGeneration;
let modalType;
let modalRecord;
let knowledgeRows = [];
let donorImport = {};

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 3500);
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '';
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function api(path, options = {}) {
  const token = session?.access_token;
  if (!token) throw new Error('Sign in required.');
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Server returned an unexpected response (${response.status}).`); }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
}

function uploadStorageObject(file, storagePath, onProgress) {
  return new Promise((resolve, reject) => {
    const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
    const request = new XMLHttpRequest();
    request.open('POST', `${cfg.supabaseUrl}/storage/v1/object/knowledge-files/${encodedPath}`);
    request.setRequestHeader('authorization', `Bearer ${session.access_token}`);
    request.setRequestHeader('apikey', cfg.supabaseAnonKey);
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.setRequestHeader('x-upsert', 'false');
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error('The upload could not reach Supabase Storage.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      let message = `Storage upload failed (${request.status}).`;
      try { message = JSON.parse(request.responseText).message || message; } catch {}
      reject(new Error(message));
    };
    request.send(file);
  });
}

async function boot() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    $('authMessage').textContent = 'Supabase settings are missing. Add SUPABASE_URL and SUPABASE_ANON_KEY in Netlify, then redeploy.';
    return;
  }
  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    renderAuth();
  });
  renderAuth();
}

function renderAuth() {
  const signedIn = Boolean(session);
  $('authView').classList.toggle('hidden', signedIn);
  $('appView').classList.toggle('hidden', !signedIn);
  if (signedIn) {
    $('userEmail').textContent = session.user.email;
    showPanel('studio');
  }
}

$$('[data-auth]').forEach(button => {
  button.onclick = () => {
    authMode = button.dataset.auth;
    $$('[data-auth]').forEach(item => item.classList.toggle('active', item === button));
    $('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
    $('authPassword').autocomplete = authMode === 'signin' ? 'current-password' : 'new-password';
    $('authMessage').textContent = '';
  };
});

$('authSubmit').onclick = async () => {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || password.length < 6) {
    $('authMessage').textContent = 'Enter an email and a password of at least six characters.';
    return;
  }
  try {
    const call = authMode === 'signin'
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password });
    const { data, error } = await call;
    if (error) throw error;
    if (authMode === 'signup' && !data.session) $('authMessage').textContent = 'Check your email to confirm your account.';
  } catch (error) {
    $('authMessage').textContent = error.message;
  }
};

$('signOut').onclick = () => supabase.auth.signOut();
$$('.nav').forEach(button => { button.onclick = () => showPanel(button.dataset.panel); });

function showPanel(name) {
  $$('.panel').forEach(panel => panel.classList.add('hidden'));
  $(`${name}Panel`).classList.remove('hidden');
  $$('.nav').forEach(button => button.classList.toggle('active', button.dataset.panel === name));
  $('pageTitle').textContent = { studio: 'AI Studio', knowledge: 'Knowledge Base', donors: 'Donors', history: 'History' }[name];
  if (name === 'knowledge') loadKnowledge();
  if (name === 'donors') loadDonors();
  if (name === 'history') loadHistory();
}

$('file').onchange = () => { $('fileName').textContent = $('file').files[0]?.name || 'No file selected'; };
const toBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

$('generate').onclick = async () => {
  const button = $('generate');
  button.disabled = true;
  button.textContent = 'Working...';
  $('resultEmpty').classList.remove('hidden');
  $('resultEmpty').textContent = 'Applying the fundraising playbook...';
  $('output').classList.add('hidden');
  try {
    const payload = {
      mode: $('mode').value,
      audience: $('audience').value,
      tone: $('tone').value,
      goal: $('goal').value,
      prompt: $('prompt').value,
      sourceText: $('sourceText').value
    };
    const file = $('file').files[0];
    if (file) payload.file = { name: file.name, type: file.type, base64: await toBase64(file) };
    const data = await api('/api/generate', { method: 'POST', body: JSON.stringify(payload) });
    currentGeneration = data.generation;
    $('output').textContent = data.output;
    $('resultEmpty').classList.add('hidden');
    $('output').classList.remove('hidden');
    $('copyOutput').disabled = false;
    $('saveFavorite').disabled = false;
    toast('Saved to history');
  } catch (error) {
    $('resultEmpty').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
};

$('copyOutput').onclick = async () => { await navigator.clipboard.writeText($('output').textContent); toast('Copied'); };
$('saveFavorite').onclick = async () => {
  if (!currentGeneration) return;
  const { error } = await supabase.from('generations').update({ favorite: true }).eq('id', currentGeneration.id);
  toast(error ? error.message : 'Added to favorites');
};

async function loadKnowledge() {
  const { data, error } = await supabase.from('knowledge_documents').select('*').order('updated_at', { ascending: false });
  if (error) return toast(error.message);
  knowledgeRows = data || [];
  renderKnowledge();
}

function renderKnowledge() {
  const query = $('knowledgeSearch').value.trim().toLowerCase();
  const filter = $('knowledgeFilter').value;
  const rows = knowledgeRows.filter(row => {
    const matchesQuery = !query || [row.title, row.content, ...(row.tags || [])].join(' ').toLowerCase().includes(query);
    const matchesFilter = filter === 'all'
      || (filter === 'favorites' && row.favorite)
      || (filter === 'uploads' && row.source_type === 'upload')
      || (filter === 'manual' && row.source_type === 'manual');
    return matchesQuery && matchesFilter;
  });
  $('knowledgeCount').textContent = `${rows.length} of ${knowledgeRows.length} document${knowledgeRows.length === 1 ? '' : 's'}`;
  const list = $('knowledgeList');
  list.innerHTML = rows.length ? '' : '<div class="empty compact">No matching documents.</div>';
  rows.forEach(row => {
    const tags = (row.tags || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
    const article = document.createElement('article');
    article.className = 'list-item knowledge-item';
    article.innerHTML = `<div class="knowledge-main"><div class="row title-row"><button class="star-button" title="${row.favorite ? 'Remove favorite' : 'Favorite'}" aria-label="${row.favorite ? 'Remove favorite' : 'Favorite'}">${row.favorite ? '★' : '☆'}</button><div><h4>${esc(row.title)}</h4><p>${esc(row.file_name || row.source_type)}${row.file_size ? ` · ${formatBytes(row.file_size)}` : ''} · Updated ${esc(formatDate(row.updated_at))}</p></div></div><div class="tag-row">${tags}</div><p class="snippet">${esc((row.content || '').slice(0, 260))}${(row.content || '').length > 260 ? '…' : ''}</p></div><div class="item-actions"><button class="secondary preview-button">Preview</button><button class="secondary edit-button">Edit</button></div>`;
    article.querySelector('.star-button').onclick = () => toggleKnowledgeFavorite(row);
    article.querySelector('.preview-button').onclick = () => previewKnowledge(row);
    article.querySelector('.edit-button').onclick = () => openKnowledge(row);
    list.appendChild(article);
  });
}

$('knowledgeSearch').oninput = renderKnowledge;
$('knowledgeFilter').onchange = renderKnowledge;
$('newKnowledge').onclick = () => openKnowledge(null);

function previewKnowledge(row) {
  modalType = 'preview';
  modalRecord = row;
  $('modalTitle').textContent = row.title;
  $('modalBody').innerHTML = `<div class="document-meta"><strong>${esc(row.file_name || row.source_type)}</strong><span>${row.file_size ? formatBytes(row.file_size) : ''}</span></div>${row.storage_path ? '<button id="downloadOriginal" class="secondary">Download original</button>' : ''}<pre class="document-preview">${esc(row.content || '')}</pre>`;
  if (row.storage_path) {
    $('downloadOriginal').onclick = async () => {
      try {
        const data = await api(`/api/knowledge-document?id=${encodeURIComponent(row.id)}`);
        if (data.url) window.location.assign(data.url);
      } catch (error) { toast(error.message); }
    };
  }
  $('deleteModal').classList.add('hidden');
  $('saveModal').classList.add('hidden');
  $('modal').classList.remove('hidden');
}

function openKnowledge(row) {
  modalType = 'knowledge';
  modalRecord = row;
  $('modalTitle').textContent = row ? 'Edit knowledge' : 'New knowledge';
  $('modalBody').innerHTML = `<label>Title<input id="mTitle" value="${esc(row?.title || '')}"></label><label>Tags<input id="mTags" value="${esc((row?.tags || []).join(', '))}" placeholder="campaign, scholarship, event"></label><label>Content<textarea id="mContent" rows="18">${esc(row?.content || '')}</textarea></label>`;
  $('deleteModal').classList.toggle('hidden', !row);
  $('saveModal').classList.remove('hidden');
  $('modal').classList.remove('hidden');
}

async function toggleKnowledgeFavorite(row) {
  const { error } = await supabase.from('knowledge_documents').update({ favorite: !row.favorite }).eq('id', row.id);
  if (error) return toast(error.message);
  row.favorite = !row.favorite;
  renderKnowledge();
}

const uploadZone = $('uploadZone');
$('browseKnowledge').onclick = event => { event.stopPropagation(); $('knowledgeFiles').click(); };
uploadZone.onclick = event => {
  if (!event.target.closest('input') && !event.target.closest('button') && !event.target.closest('label')) $('knowledgeFiles').click();
};
uploadZone.onkeydown = event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target === uploadZone) {
    event.preventDefault();
    $('knowledgeFiles').click();
  }
};
['dragenter', 'dragover'].forEach(type => uploadZone.addEventListener(type, event => { event.preventDefault(); uploadZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => uploadZone.addEventListener(type, event => { event.preventDefault(); uploadZone.classList.remove('dragging'); }));
uploadZone.ondrop = event => uploadKnowledgeFiles([...event.dataTransfer.files]);
$('knowledgeFiles').onchange = () => uploadKnowledgeFiles([...$('knowledgeFiles').files]);

async function uploadKnowledgeFiles(files) {
  if (!files.length) return;
  const tags = $('uploadTags').value.split(',').map(tag => tag.trim()).filter(Boolean);
  const queue = $('uploadQueue');
  queue.classList.remove('hidden');
  queue.innerHTML = '';
  let successes = 0;
  let failures = 0;

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `<div class="upload-copy"><strong>${esc(file.name)}</strong><span>${formatBytes(file.size)}</span><progress max="100" value="0"></progress></div><span class="upload-state">Waiting</span>`;
    queue.appendChild(item);
    const state = item.querySelector('.upload-state');
    const progress = item.querySelector('progress');
    let storagePath;
    try {
      if (!SUPPORTED_FILE.test(file.name)) throw new Error('Only TXT, CSV, PDF, and DOCX are supported.');
      if (!file.size) throw new Error('The file is empty.');
      if (file.size > MAX_FILE_BYTES) throw new Error('Files must be 25 MB or smaller.');
      state.textContent = 'Checking for duplicates…';
      const checksum = await sha256(file);
      const { data: duplicate, error: duplicateError } = await supabase.from('knowledge_documents').select('id,title').eq('checksum', checksum).maybeSingle();
      if (duplicateError) throw duplicateError;
      if (duplicate) throw new Error(`Already uploaded as “${duplicate.title}”.`);

      storagePath = `${session.user.id}/${crypto.randomUUID()}/${safeFileName(file.name)}`;
      state.textContent = 'Uploading 0%';
      await uploadStorageObject(file, storagePath, percent => {
        progress.value = percent;
        state.textContent = `Uploading ${percent}%`;
      });
      progress.value = 100;
      state.textContent = 'Extracting text…';
      await api('/api/process-document', {
        method: 'POST',
        body: JSON.stringify({ storagePath, fileName: file.name, mimeType: file.type, fileSize: file.size, checksum, tags })
      });
      state.textContent = 'Ready';
      item.classList.add('success');
      successes += 1;
    } catch (error) {
      if (storagePath) await supabase.storage.from('knowledge-files').remove([storagePath]);
      state.textContent = error.message;
      item.classList.add('failed');
      failures += 1;
    }
  }
  $('knowledgeFiles').value = '';
  await loadKnowledge();
  toast(`${successes} uploaded${failures ? `; ${failures} failed` : ''}.`);
}

async function loadDonors() {
  const { data, error } = await supabase.from('donors').select('*').order('name');
  if (error) return toast(error.message);
  const list = $('donorList');
  list.innerHTML = data.length ? '' : '<div class="empty compact">No donor profiles yet.</div>';
  data.forEach(row => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<div><h4>${esc(row.name)}</h4><p>${esc(row.relationship_type || '')} ${row.city ? `· ${esc(row.city)}` : ''}</p><p>${esc(row.next_action || row.notes || 'No notes')}</p></div><button class="secondary">Edit</button>`;
    div.querySelector('button').onclick = () => openDonor(row);
    list.appendChild(div);
  });
}

$('newDonor').onclick = () => openDonor(null);

$('importDonors').onclick = openDonorImport;
$('closeDonorImport').onclick = closeDonorImport;
$('browseDonorCsv').onclick = event => { event.stopPropagation(); $('donorCsvFile').click(); };
$('donorCsvDrop').onclick = event => {
  if (!event.target.closest('button') && !event.target.closest('input')) $('donorCsvFile').click();
};
$('donorCsvDrop').onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('donorCsvFile').click();
  }
};
['dragenter', 'dragover'].forEach(type => $('donorCsvDrop').addEventListener(type, event => {
  event.preventDefault();
  $('donorCsvDrop').classList.add('dragging');
}));
['dragleave', 'drop'].forEach(type => $('donorCsvDrop').addEventListener(type, event => {
  event.preventDefault();
  $('donorCsvDrop').classList.remove('dragging');
}));
$('donorCsvDrop').ondrop = event => selectDonorCsv(event.dataTransfer.files[0]);
$('donorCsvFile').onchange = () => selectDonorCsv($('donorCsvFile').files[0]);
$('donorImportBack').onclick = () => setDonorImportStep(Math.max(1, donorImport.step - 1));
$('donorImportNext').onclick = advanceDonorImport;
$('runDonorImport').onclick = runDonorImport;
$('finishDonorImport').onclick = closeDonorImport;
$('downloadRejectedDonors').onclick = downloadRejectedDonors;

function openDonorImport() {
  donorImport = {
    step: 1,
    file: null,
    headers: [],
    dataRows: [],
    mappings: [],
    validation: null,
    rejectedRows: []
  };
  $('donorCsvFile').value = '';
  $('donorCsvSelection').classList.add('hidden');
  $('donorCsvSelection').textContent = '';
  $('donorCsvMessage').textContent = '';
  $('mappingMessage').textContent = '';
  $('donorImportWizard').classList.remove('hidden');
  setDonorImportStep(1);
}

function closeDonorImport() {
  $('donorImportWizard').classList.add('hidden');
}

function setDonorImportStep(step) {
  donorImport.step = step;
  ['Select', 'Map', 'Preview', 'Results'].forEach((name, index) => {
    $(`importStep${name}`).classList.toggle('hidden', index + 1 !== step);
  });
  $$('[data-import-step]').forEach(item => {
    const itemStep = Number(item.dataset.importStep);
    item.classList.toggle('active', itemStep === step);
    item.classList.toggle('complete', itemStep < step);
  });
  $('donorImportBack').classList.toggle('hidden', step === 1 || step === 4);
  $('donorImportNext').classList.toggle('hidden', step >= 3);
  $('runDonorImport').classList.toggle('hidden', step !== 3);
  $('finishDonorImport').classList.toggle('hidden', step !== 4);
}

async function selectDonorCsv(file) {
  $('donorCsvMessage').textContent = '';
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    $('donorCsvMessage').textContent = 'Choose a file with a .csv extension.';
    return;
  }
  if (!window.Papa) {
    $('donorCsvMessage').textContent = 'The CSV parser did not load. Reload the page and try again.';
    return;
  }
  try {
    const text = (await file.text()).replace(/^\uFEFF/, '');
    const parsed = window.Papa.parse(text, { skipEmptyLines: 'greedy' });
    const fatalErrors = parsed.errors.filter(error => error.code !== 'UndetectableDelimiter');
    if (fatalErrors.length) throw new Error(`CSV parsing failed: ${fatalErrors[0].message}`);
    if (parsed.data.length < 2) throw new Error('The CSV must contain a header row and at least one data row.');
    const headers = parsed.data[0].map(value => String(value).replace(/^\uFEFF/, '').trim());
    if (headers.some(header => !header)) throw new Error('Every CSV column must have a header.');
    donorImport = {
      ...donorImport,
      file,
      headers,
      dataRows: parsed.data.slice(1),
      mappings: automaticMappings(headers),
      validation: null,
      rejectedRows: []
    };
    $('donorCsvSelection').innerHTML = `<strong>${esc(file.name)}</strong><span>${donorImport.dataRows.length.toLocaleString()} rows · ${formatBytes(file.size)}</span>`;
    $('donorCsvSelection').classList.remove('hidden');
  } catch (error) {
    donorImport.file = null;
    $('donorCsvSelection').classList.add('hidden');
    $('donorCsvMessage').textContent = error.message;
  }
}

function advanceDonorImport() {
  if (donorImport.step === 1) {
    if (!donorImport.file) {
      $('donorCsvMessage').textContent = 'Choose a valid CSV file to continue.';
      return;
    }
    renderMappingRows();
    setDonorImportStep(2);
    return;
  }
  if (donorImport.step === 2) {
    const errors = mappingErrors(donorImport.mappings);
    $('mappingMessage').textContent = errors.join(' ');
    if (errors.length) return;
    donorImport.validation = validateDonorRows(donorImport.dataRows, donorImport.headers, donorImport.mappings);
    renderDonorPreview();
    setDonorImportStep(3);
  }
}

function renderMappingRows() {
  $('mappingRowCount').textContent = `${donorImport.dataRows.length.toLocaleString()} rows`;
  const tbody = $('mappingRows');
  tbody.innerHTML = '';
  donorImport.headers.forEach((header, index) => {
    const tr = document.createElement('tr');
    const options = ['<option value="">Do not import</option>', ...DONOR_FIELDS.map(field =>
      `<option value="${field.value}">${esc(field.label)}</option>`
    )].join('');
    tr.innerHTML = `<td><strong>${esc(header)}</strong></td><td><select aria-label="Map ${esc(header)}">${options}</select></td>`;
    const select = tr.querySelector('select');
    select.value = donorImport.mappings[index] || '';
    select.onchange = () => {
      donorImport.mappings[index] = select.value;
      $('mappingMessage').textContent = '';
      refreshMappingOptions();
    };
    tbody.appendChild(tr);
  });
  refreshMappingOptions();
}

function refreshMappingOptions() {
  const selects = [...$('mappingRows').querySelectorAll('select')];
  selects.forEach((select, selectIndex) => {
    const selectedElsewhere = new Set(donorImport.mappings.filter((_value, index) => index !== selectIndex));
    [...select.options].forEach(option => {
      option.disabled = Boolean(option.value && selectedElsewhere.has(option.value));
    });
  });
}

function renderDonorPreview() {
  const validation = donorImport.validation;
  const valid = validation.validRows.length;
  const rejected = validation.rejectedRows.length;
  $('validationSummary').innerHTML = `
    <div><strong>${validation.rows.length.toLocaleString()}</strong><span>Total rows</span></div>
    <div class="success-stat"><strong>${valid.toLocaleString()}</strong><span>Ready to import</span></div>
    <div class="${rejected ? 'error-stat' : ''}"><strong>${rejected.toLocaleString()}</strong><span>Rejected</span></div>`;
  $('runDonorImport').disabled = valid === 0;
  const table = $('donorPreviewTable');
  table.innerHTML = `<thead><tr><th>Row</th>${donorImport.headers.map(header => `<th>${esc(header)}</th>`).join('')}<th>Validation</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector('tbody');
  validation.preview.forEach(row => {
    const tr = document.createElement('tr');
    if (row.errors.length) tr.className = 'invalid-row';
    tr.innerHTML = `<td>${row.rowNumber}</td>${row.sourceValues.map(value => `<td>${esc(value)}</td>`).join('')}<td class="validation-cell">${row.errors.length ? esc(row.errors.join(' ')) : 'Ready'}</td>`;
    body.appendChild(tr);
  });
}

async function runDonorImport() {
  const button = $('runDonorImport');
  const validRows = donorImport.validation.validRows;
  const rejectedRows = [...donorImport.validation.rejectedRows];
  const totals = { total_received: donorImport.validation.rows.length, inserted: 0, updated: 0, rejected: rejectedRows.length };
  const serverErrors = [];
  button.disabled = true;
  try {
    const chunkSize = 1_000;
    for (let index = 0; index < validRows.length; index += chunkSize) {
      const chunk = validRows.slice(index, index + chunkSize);
      button.textContent = `Importing ${Math.min(index + chunk.length, validRows.length).toLocaleString()} of ${validRows.length.toLocaleString()}…`;
      try {
        const result = await api('/api/import-donors', { method: 'POST', body: JSON.stringify({ rows: chunk }) });
        totals.inserted += result.inserted;
        totals.updated += result.updated;
        totals.rejected += result.rejected;
        serverErrors.push(...result.errors);
      } catch (error) {
        chunk.forEach(row => serverErrors.push({ row: row.row_number, error: error.message }));
        totals.rejected += chunk.length;
      }
    }
    for (const failure of serverErrors) {
      const original = donorImport.validation.rows.find(row => row.rowNumber === failure.row);
      if (original) rejectedRows.push({ ...original, errors: [failure.error] });
    }
    donorImport.rejectedRows = rejectedRows;
    renderImportResults(totals, serverErrors);
    setDonorImportStep(4);
  } finally {
    button.disabled = false;
    button.textContent = 'Import valid rows';
  }
}

function renderImportResults(totals, serverErrors) {
  $('importResultSummary').innerHTML = `
    <div><strong>${totals.total_received.toLocaleString()}</strong><span>Total processed</span></div>
    <div class="success-stat"><strong>${totals.inserted.toLocaleString()}</strong><span>Inserted</span></div>
    <div><strong>${totals.updated.toLocaleString()}</strong><span>Updated</span></div>
    <div class="${totals.rejected ? 'error-stat' : ''}"><strong>${totals.rejected.toLocaleString()}</strong><span>Rejected</span></div>
    <div class="${serverErrors.length ? 'error-stat' : ''}"><strong>${serverErrors.length.toLocaleString()}</strong><span>Errors</span></div>`;
  $('downloadRejectedDonors').classList.toggle('hidden', donorImport.rejectedRows.length === 0);
  const errorList = $('importErrorList');
  errorList.classList.toggle('hidden', serverErrors.length === 0);
  errorList.innerHTML = serverErrors.length
    ? `<h4>Import errors</h4><ul>${serverErrors.slice(0, 100).map(error => `<li>Row ${error.row ?? 'unknown'}: ${esc(error.error)}</li>`).join('')}</ul>${serverErrors.length > 100 ? '<p>Download rejected rows for the complete list.</p>' : ''}`
    : '';
}

function downloadRejectedDonors() {
  const csv = rejectedRowsCsv(donorImport.headers, donorImport.rejectedRows, window.Papa.unparse);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `donor-import-rejected-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function openDonor(row) {
  modalType = 'donor';
  modalRecord = row;
  $('modalTitle').textContent = row ? 'Edit donor' : 'New donor';
  $('modalBody').innerHTML = `<div class="form-grid"><label>Name<input id="dName" value="${esc(row?.name || '')}"></label><label>Relationship<input id="dRelationship" value="${esc(row?.relationship_type || '')}"></label><label>Email<input id="dEmail" value="${esc(row?.email || '')}"></label><label>Phone<input id="dPhone" value="${esc(row?.phone || '')}"></label><label>City<input id="dCity" value="${esc(row?.city || '')}"></label><label>Lifetime giving<input id="dLifetime" type="number" value="${row?.lifetime_giving ?? ''}"></label><label>Last gift amount<input id="dLastAmount" type="number" value="${row?.last_gift_amount ?? ''}"></label><label>Last gift date<input id="dLastDate" type="date" value="${row?.last_gift_date || ''}"></label></div><label>Interests<textarea id="dInterests" rows="3">${esc(row?.interests || '')}</textarea></label><label>Notes<textarea id="dNotes" rows="5">${esc(row?.notes || '')}</textarea></label><label>Next action<textarea id="dNext" rows="3">${esc(row?.next_action || '')}</textarea></label><label>Next action date<input id="dNextDate" type="date" value="${row?.next_action_date || ''}"></label>`;
  $('deleteModal').classList.toggle('hidden', !row);
  $('saveModal').classList.remove('hidden');
  $('modal').classList.remove('hidden');
}

$('closeModal').onclick = () => $('modal').classList.add('hidden');
$('saveModal').onclick = async () => {
  try {
    if (modalType === 'knowledge') {
      const row = {
        user_id: session.user.id,
        title: $('mTitle').value.trim(),
        tags: $('mTags').value.split(',').map(tag => tag.trim()).filter(Boolean),
        content: $('mContent').value,
        source_type: modalRecord?.source_type || 'manual'
      };
      if (!row.title) throw new Error('Title is required.');
      const query = modalRecord
        ? supabase.from('knowledge_documents').update(row).eq('id', modalRecord.id)
        : supabase.from('knowledge_documents').insert(row);
      const { error } = await query;
      if (error) throw error;
      await loadKnowledge();
    } else if (modalType === 'donor') {
      const row = {
        user_id: session.user.id,
        name: $('dName').value.trim(),
        relationship_type: $('dRelationship').value,
        email: $('dEmail').value,
        phone: $('dPhone').value,
        city: $('dCity').value,
        lifetime_giving: $('dLifetime').value || null,
        last_gift_amount: $('dLastAmount').value || null,
        last_gift_date: $('dLastDate').value || null,
        interests: $('dInterests').value,
        notes: $('dNotes').value,
        next_action: $('dNext').value,
        next_action_date: $('dNextDate').value || null
      };
      if (!row.name) throw new Error('Name is required.');
      const query = modalRecord ? supabase.from('donors').update(row).eq('id', modalRecord.id) : supabase.from('donors').insert(row);
      const { error } = await query;
      if (error) throw error;
      await loadDonors();
    }
    $('modal').classList.add('hidden');
    toast('Saved');
  } catch (error) { toast(error.message); }
};

$('deleteModal').onclick = async () => {
  if (!modalRecord || !confirm('Delete this record?')) return;
  try {
    if (modalType === 'knowledge') {
      const result = await api('/api/knowledge-document', { method: 'DELETE', body: JSON.stringify({ id: modalRecord.id }) });
      await loadKnowledge();
      toast(result.warning || 'Deleted');
    } else {
      const { error } = await supabase.from('donors').delete().eq('id', modalRecord.id);
      if (error) throw error;
      await loadDonors();
      toast('Deleted');
    }
    $('modal').classList.add('hidden');
  } catch (error) { toast(error.message); }
};

async function loadHistory() {
  const { data, error } = await supabase.from('generations').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return toast(error.message);
  const list = $('historyList');
  list.innerHTML = data.length ? '' : '<div class="empty compact">No generations yet.</div>';
  data.forEach(row => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<div><h4>${row.favorite ? '★ ' : ''}${esc(row.title || row.mode)}</h4><p>${esc(row.mode)} · ${esc(formatDate(row.created_at))}</p><p>${esc(row.output.slice(0, 200))}…</p></div><button class="secondary">Open</button>`;
    div.querySelector('button').onclick = () => {
      showPanel('studio');
      currentGeneration = row;
      $('output').textContent = row.output;
      $('output').classList.remove('hidden');
      $('resultEmpty').classList.add('hidden');
      $('copyOutput').disabled = false;
      $('saveFavorite').disabled = false;
    };
    list.appendChild(div);
  });
}

boot();
