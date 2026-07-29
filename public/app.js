import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  DONOR_FIELDS,
  automaticMappings,
  mappingErrors,
  rejectedRowsCsv,
  validateDonorRows
} from './donor-import.js';
import {
  archiveDonorPayload,
  CRM_DONOR_FIELDS,
  DONORS_PER_PAGE,
  DONOR_STATUS,
  UNASSIGNED_FILTER,
  donorDisplayName,
  donorMetrics,
  donorSecondaryHousehold,
  donorsForStatus,
  filterAndSortDonors,
  filterOptions,
  formatCrmDate,
  formatCurrency,
  isDueWithinSevenDays,
  isNotContactedInNinetyDays,
  isOverdueNextAction,
  normalizeCrmDonorPayload,
  paginateDonors
} from './crm-donors.js';
import {
  donorProfileViewModel
} from './donor-profile.js';
import {
  ACTIVITY_FIELDS,
  ACTIVITY_PAGE_SIZE,
  activityArchiveActionLabel,
  activityTimelineEmptyState,
  activityTimelineViewModel,
  nextActionGuidance,
  normalizeActivityPayload,
  toDateTimeLocalValue
} from './donor-activities.js';
import {
  buildDashboardViewModel,
  sampleDashboardViewModel
} from './dashboard.js';

const cfg = window.RUNTIME_CONFIG || {};
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_FILE = /\.(txt|csv|pdf|docx)$/i;
const PANEL_META = {
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Fundraising Command Center'
  },
  studio: {
    title: 'AI Studio',
    subtitle: 'AI-Powered Fundraising Communications'
  },
  knowledge: {
    title: 'Knowledge Base',
    subtitle: 'Private Institutional Knowledge'
  },
  donors: {
    title: 'Donors',
    subtitle: 'Relationship Management'
  },
  history: {
    title: 'History',
    subtitle: 'Previous AI Conversations'
  }
};
let supabase;
let session;
let authMode = 'signin';
let currentGeneration;
let modalType;
let modalRecord;
let knowledgeRows = [];
let donorImport = {};
let crmDonorRows = [];
let crmDonorPage = 1;
let crmDonorLoadError = null;
let donorProfileRecord = null;
let donorDashboardScrollPosition = 0;
let donorProfileRequestId = 0;
let donorActivities = [];
let donorActivityView = 'active';
let donorActivityHasMore = false;
let donorActivityLoading = false;
let donorActivityLoadError = false;
let donorActivityRequestId = 0;
let activityModalRecord = null;
let activityModalReturnFocus = null;
let userScopeVersion = 0;
let dashboardRequestId = 0;
let dashboardLoadedAt = 0;
let dashboardLoadedForUser = null;

function resetUserScopedState() {
  userScopeVersion += 1;
  currentGeneration = null;
  modalType = null;
  modalRecord = null;
  knowledgeRows = [];
  donorImport = {};
  crmDonorRows = [];
  crmDonorPage = 1;
  crmDonorLoadError = null;
  donorProfileRecord = null;
  donorDashboardScrollPosition = 0;
  donorProfileRequestId += 1;
  donorActivities = [];
  donorActivityView = 'active';
  donorActivityHasMore = false;
  donorActivityLoading = false;
  donorActivityLoadError = false;
  donorActivityRequestId += 1;
  activityModalRecord = null;
  activityModalReturnFocus = null;
  dashboardRequestId += 1;
  dashboardLoadedAt = 0;
  dashboardLoadedForUser = null;

  $('userEmail').textContent = '';
  $('userAvatar').textContent = '';
  $('donorSearch').value = '';
  $('donorStatusFilter').value = DONOR_STATUS.ACTIVE;
  $('donorStageFilter').innerHTML = '<option value="">All stages</option>';
  $('donorOfficerFilter').innerHTML = '<option value="">All officers</option>';
  $('donorSort').value = 'last-name-asc';
  $('donorList').innerHTML = '';
  $('donorKpis').innerHTML = '';
  $('donorCount').textContent = '';
  $('donorStatus').innerHTML = '';
  $('donorPagination').classList.add('hidden');
  $('donorProfileContent').innerHTML = '';
  $('donorProfileContent').classList.add('hidden');
  $('donorProfileState').innerHTML = '';
  $('knowledgeList').innerHTML = '';
  $('historyList').innerHTML = '';
  $('dashboardContent').classList.add('hidden');
  $('dashboardStatus').classList.remove('hidden');
  $('output').textContent = '';
  $('output').classList.add('hidden');
  $('resultEmpty').classList.remove('hidden');
  $('copyOutput').disabled = true;
  $('saveFavorite').disabled = true;
  $('modal').classList.add('hidden');
  $('archiveConfirmModal').classList.add('hidden');
  $('activityModal').classList.add('hidden');
  $('activityArchiveConfirmModal').classList.add('hidden');
  $('donorImportWizard').classList.add('hidden');
}

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
    const previousUserId = session?.user?.id || null;
    const nextUserId = nextSession?.user?.id || null;
    if (previousUserId !== nextUserId) resetUserScopedState();
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
    const email = session.user.email || '';
    $('userEmail').textContent = email;
    $('userAvatar').textContent = email.slice(0, 1).toUpperCase();
    showPanel('dashboard');
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
  const metadata = PANEL_META[name];
  if (!metadata) return;
  $$('.panel').forEach(panel => panel.classList.add('hidden'));
  $(`${name}Panel`).classList.remove('hidden');
  $$('.nav').forEach(button => button.classList.toggle('active', button.dataset.panel === name));
  $('pageTitle').textContent = metadata.title;
  $('pageSubtitle').textContent = metadata.subtitle;
  if (name === 'dashboard') loadDashboard();
  if (name === 'knowledge') loadKnowledge();
  if (name === 'donors') loadDonors();
  if (name === 'history') loadHistory();
}

function dashboardIcon(name) {
  const icons = {
    giving: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M17 6.2c-.9-1.2-2.4-2-4.2-2H10a3.5 3.5 0 0 0 0 7h4a3.5 3.5 0 0 1 0 7h-3c-1.9 0-3.5-.8-4.5-2.2"/></svg>',
    donors: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V20M16 5.5a3 3 0 0 1 0 5.8M17 14a4 4 0 0 1 3.5 4v2"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 1.5 1.5L12 8M14 9h3M8 15l1.5 1.5L12 14M14 15h3"/></svg>',
    gift: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h18v12H3zM2 5h20v4H2zM12 5v16M12 5H8.5a2.5 2.5 0 1 1 2.2-3.7L12 5Zm0 0h3.5a2.5 2.5 0 1 0-2.2-3.7L12 5Z"/></svg>'
  };
  return icons[name] || icons.tasks;
}

function dashboardEmpty(title, message) {
  return `<div class="dashboard-empty"><strong>${esc(title)}</strong><span>${esc(message)}</span></div>`;
}

function renderDashboard(viewModel, errors = []) {
  $('dashboardStatus').classList.add('hidden');
  $('dashboardContent').classList.remove('hidden');
  const notice = $('dashboardNotice');
  if (viewModel.isSample) {
    notice.innerHTML = '<strong>Example view</strong><span>Live workspace data is temporarily unavailable. The items below are clearly marked examples.</span>';
    notice.className = 'dashboard-notice sample';
  } else if (errors.length) {
    notice.innerHTML = `<strong>Some data could not be loaded</strong><span>${esc(errors.join(' '))} Available workspace information is shown below.</span>`;
    notice.className = 'dashboard-notice warning';
  } else {
    notice.className = 'dashboard-notice hidden';
    notice.innerHTML = '';
  }

  $('dashboardKpis').innerHTML = viewModel.kpis.map(kpi => `
    <article class="dashboard-kpi">
      <span class="dashboard-kpi-icon ${esc(kpi.tone)}">${dashboardIcon(kpi.icon)}</span>
      <div class="dashboard-kpi-heading"><span>${esc(kpi.title)}</span>${viewModel.isSample ? '<em>Example</em>' : ''}</div>
      <strong>${esc(kpi.value)}</strong>
      <small class="${esc(kpi.tone)}">${esc(kpi.trend)}</small>
    </article>`).join('');

  $('dashboardPriorityCount').textContent = viewModel.priorities.length
    ? `${viewModel.priorities.length} item${viewModel.priorities.length === 1 ? '' : 's'}`
    : 'All clear';
  $('dashboardPriorityList').innerHTML = viewModel.priorities.length
    ? viewModel.priorities.map(item => `
      <label class="dashboard-task ${esc(item.kind)}">
        <input type="checkbox" aria-label="Mark ${esc(item.title)} complete">
        <span class="dashboard-check" aria-hidden="true"></span>
        <span class="dashboard-task-copy">
          <strong>${esc(item.title)}</strong>
          <small>${esc(item.donor)} · ${esc(item.detail)}</small>
        </span>
        <time>${esc(item.dueLabel)}</time>
      </label>`).join('')
    : dashboardEmpty('Nothing needs attention today', 'Your recorded follow-ups and donor actions are up to date.');

  $$('#dashboardPriorityList .dashboard-task input').forEach(input => {
    input.onchange = () => {
      input.closest('.dashboard-task').classList.toggle('complete', input.checked);
      if (input.checked) toast('Marked complete for this session');
    };
  });

  $('dashboardUpcomingList').innerHTML = viewModel.upcoming.length
    ? viewModel.upcoming.map(item => `
      <article class="dashboard-upcoming-item">
        <span class="dashboard-date">${esc(item.dueLabel)}</span>
        <div><strong>${esc(item.title)}</strong><small>${esc(item.donor)} · ${esc(item.detail)}</small></div>
      </article>`).join('')
    : dashboardEmpty('No scheduled follow-ups', 'Future donor actions and meetings will appear here.');

  $('dashboardActivityList').innerHTML = viewModel.recentActivity.length
    ? viewModel.recentActivity.map(item => `
      <article class="dashboard-timeline-item">
        <span class="dashboard-timeline-marker ${esc(item.type)}" aria-hidden="true"></span>
        <div><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
        <time datetime="${esc(item.occurredAt)}">${esc(formatDate(item.occurredAt))}</time>
      </article>`).join('')
    : dashboardEmpty('No recent activity', 'New donors, interactions, knowledge, and AI generations will appear here.');

  const intelligenceLabel = document.querySelector('.dashboard-intelligence-label');
  intelligenceLabel.textContent = viewModel.isSample ? 'Example data' : 'Calculated from live data';
  $('dashboardInsightList').innerHTML = viewModel.insights.map(insight => `
    <article class="dashboard-insight ${esc(insight.tone)}">
      <strong>${esc(insight.value)}</strong>
      <div><h4>${esc(insight.title)}</h4><p>${esc(insight.detail)}</p></div>
    </article>`).join('');
}

async function loadDashboard({ force = false } = {}) {
  const userId = session?.user?.id;
  const scopeVersion = userScopeVersion;
  if (!userId) return;
  const hour = new Date().getHours();
  $('dashboardGreeting').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const cacheIsFresh = dashboardLoadedForUser === userId && Date.now() - dashboardLoadedAt < 60_000;
  if (!force && cacheIsFresh) return;

  const requestId = ++dashboardRequestId;
  $('dashboardStatus').classList.remove('hidden');
  $('dashboardContent').classList.add('hidden');
  $('dashboardStatus').innerHTML = '<span class="dashboard-loader" aria-hidden="true"></span><div><strong>Preparing your command center</strong><span>Loading current donor and workspace activity.</span></div>';

  const [donorsResult, activitiesResult, knowledgeResult, generationsResult] = await Promise.all([
    supabase.from('crm_donors').select(CRM_DONOR_FIELDS.join(',')).eq('owner_user_id', userId),
    supabase.from('donor_activities').select(ACTIVITY_FIELDS.join(',')).eq('owner_user_id', userId).order('occurred_at', { ascending: false }).limit(100),
    supabase.from('knowledge_documents').select('id,title,source_type,created_at,updated_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(50),
    supabase.from('generations').select('id,title,mode,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50)
  ]);

  if (requestId !== dashboardRequestId || scopeVersion !== userScopeVersion || session?.user?.id !== userId) return;
  const results = [donorsResult, activitiesResult, knowledgeResult, generationsResult];
  const labels = ['Donor data is unavailable.', 'Interaction data is unavailable.', 'Knowledge activity is unavailable.', 'AI history is unavailable.'];
  const errors = results.map((result, index) => result.error ? labels[index] : '').filter(Boolean);
  const allUnavailable = results.every(result => result.error);
  const viewModel = allUnavailable
    ? sampleDashboardViewModel()
    : buildDashboardViewModel({
        donors: donorsResult.data || [],
        activities: activitiesResult.data || [],
        knowledge: knowledgeResult.data || [],
        generations: generationsResult.data || []
      });

  renderDashboard(viewModel, errors);
  dashboardLoadedAt = Date.now();
  dashboardLoadedForUser = userId;
}

$('refreshDashboard').onclick = () => loadDashboard({ force: true });
$$('[data-dashboard-action]').forEach(button => {
  button.onclick = () => {
    const action = button.dataset.dashboardAction;
    if (action === 'draft-email') {
      showPanel('studio');
      $('mode').value = 'writer';
      $('prompt').focus();
    } else if (action === 'add-donor') {
      showPanel('donors');
      openDonor(null);
    } else if (action === 'log-interaction') {
      showPanel('donors');
      toast('Open a donor profile to log an interaction');
    } else if (action === 'upload-knowledge') {
      showPanel('knowledge');
      $('knowledgeFiles').click();
    } else if (action === 'open-studio') {
      showPanel('studio');
    }
  };
});

function showDonorProfileState(title, message, action = '') {
  $('donorProfileContent').classList.add('hidden');
  $('donorProfileState').classList.remove('hidden');
  $('donorProfileState').innerHTML = `
    <strong>${esc(title)}</strong>
    <span>${esc(message)}</span>
    ${action ? `<button id="donorProfileStateAction" class="secondary">${esc(action)}</button>` : ''}`;
  if (action) $('donorProfileStateAction').onclick = returnToDonors;
}

function syncDonorDashboardRow(row) {
  const index = crmDonorRows.findIndex(donor => donor.id === row.id);
  if (index >= 0) crmDonorRows[index] = row;
  else crmDonorRows.push(row);
  renderDonorFilters();
  renderDonorDashboard();
}

function renderDonorProfile(row) {
  const profile = donorProfileViewModel(row);
  $('donorProfileState').classList.add('hidden');
  $('donorProfileContent').classList.remove('hidden');
  $('donorProfileContent').innerHTML = `
    <div class="donor-profile-header">
      <button id="backToDonors" class="donor-profile-back">← Back to Donors</button>
      <div class="donor-profile-heading">
        <div>
          <div class="row donor-profile-title-row">
            <h2 id="donorProfileTitle">${esc(profile.displayName)}</h2>
            ${profile.isArchived ? '<span class="donor-flag archived">Archived</span>' : ''}
          </div>
          ${profile.householdName ? `<p class="donor-profile-household">${esc(profile.householdName)}</p>` : ''}
          <p class="donor-profile-code"><strong>Donor Code</strong> ${esc(profile.donorCode)}</p>
        </div>
        <div class="row donor-profile-actions">
          <button id="profileArchiveDonor" class="${profile.isArchived ? 'secondary restore-action' : 'danger'}">${esc(profile.archiveActionLabel)}</button>
          <button id="profileEditDonor" class="primary">Edit Donor</button>
        </div>
      </div>
    </div>
    <div class="donor-profile-grid">
      <section class="donor-profile-section donor-profile-relationship" aria-labelledby="relationshipSnapshotTitle">
        <h3 id="relationshipSnapshotTitle">Relationship Snapshot</h3>
        <dl class="donor-profile-summary">
          <div><dt>Stage</dt><dd><span class="stage-badge">${esc(profile.stage)}</span></dd></div>
          <div><dt>Assigned officer</dt><dd>${esc(profile.assignedOfficer)}</dd></div>
          <div><dt>Lifetime giving</dt><dd>${esc(profile.lifetimeGiving)}</dd></div>
          <div><dt>Last gift amount</dt><dd>${esc(profile.lastGiftAmount)}</dd></div>
          <div><dt>Last gift date</dt><dd>${esc(profile.lastGiftDate)}</dd></div>
          <div><dt>Last contact date</dt><dd>${esc(profile.lastContactDate)}</dd></div>
          <div class="profile-next-action"><dt>Next action</dt><dd>${esc(profile.nextAction)}</dd></div>
          <div><dt>Next action date</dt><dd>${esc(profile.nextActionDate)}</dd></div>
        </dl>
      </section>
      <section class="donor-profile-section" aria-labelledby="contactInformationTitle">
        <h3 id="contactInformationTitle">Contact Information</h3>
        <dl class="donor-profile-contact">
          <div><dt>Primary email</dt><dd>${esc(profile.primaryEmail)}</dd></div>
          <div><dt>Primary phone</dt><dd>${esc(profile.primaryPhone)}</dd></div>
          ${profile.secondaryPhone ? `<div><dt>Secondary phone</dt><dd>${esc(profile.secondaryPhone)}</dd></div>` : ''}
          <div class="profile-address-block"><dt>Mailing address</dt><dd>${esc(profile.address)}</dd></div>
        </dl>
      </section>
      <section class="donor-profile-section donor-profile-notes" aria-labelledby="donorNotesTitle">
        <h3 id="donorNotesTitle">Notes</h3>
        ${profile.notesEmpty
          ? '<p class="donor-profile-empty">No notes have been recorded for this donor.</p>'
          : `<p class="donor-profile-note-copy">${esc(profile.notes)}</p>`}
      </section>
      <section class="donor-profile-section donor-activity-section" aria-labelledby="donorActivityTitle">
        <div class="row between donor-activity-heading">
          <div><h3 id="donorActivityTitle">Activity Timeline</h3><p>Recent relationship activity, newest first.</p></div>
          <button id="addDonorActivity" class="primary">Add Activity</button>
        </div>
        <div class="activity-view-toggle" role="group" aria-label="Activity status">
          <button id="showActiveActivities" class="activity-view-button" aria-pressed="${donorActivityView === 'active'}">Active</button>
          <button id="showArchivedActivities" class="activity-view-button" aria-pressed="${donorActivityView === 'archived'}">Archived</button>
        </div>
        <div id="donorActivityState" class="activity-state" role="status" aria-live="polite"></div>
        <div id="donorActivityList" class="activity-list"></div>
        <button id="loadMoreActivities" class="secondary hidden">Load More</button>
      </section>
    </div>`;
  $('backToDonors').onclick = returnToDonors;
  $('profileEditDonor').onclick = () => openDonor(donorProfileRecord);
  $('profileArchiveDonor').onclick = () => openDonorArchiveConfirmation(donorProfileRecord);
  $('addDonorActivity').onclick = () => openActivityModal();
  $('showActiveActivities').onclick = () => setDonorActivityView('active');
  $('showArchivedActivities').onclick = () => setDonorActivityView('archived');
  $('loadMoreActivities').onclick = () => loadDonorActivities();
}

async function loadDonorProfile(donorId, { showLoading = true } = {}) {
  const requestId = ++donorProfileRequestId;
  const userId = session?.user?.id;
  if (!session) {
    showDonorProfileState('Sign in required', 'Sign in to view this donor.', 'Back to Donors');
    return;
  }
  if (showLoading) showDonorProfileState('Loading donor…', 'Retrieving the latest donor information.');
  const { data, error } = await supabase
    .from('crm_donors')
    .select(CRM_DONOR_FIELDS.join(','))
    .eq('owner_user_id', userId)
    .eq('id', donorId)
    .maybeSingle();
  if (requestId !== donorProfileRequestId || session?.user?.id !== userId) return;
  if (error) {
    const inaccessible = error.code === '42501' || /row.level|permission|policy|rls/i.test(error.message || '');
    showDonorProfileState(
      inaccessible ? 'Donor unavailable' : 'Unable to load donor',
      inaccessible
        ? 'This donor is unavailable or your account does not have access.'
        : 'The donor could not be loaded. Return to the dashboard and try again.',
      'Back to Donors'
    );
    return;
  }
  if (!data) {
    showDonorProfileState('Donor not found', 'This donor may no longer be available.', 'Back to Donors');
    return;
  }
  donorProfileRecord = data;
  syncDonorDashboardRow(data);
  renderDonorProfile(data);
  await loadDonorActivities({ reset: true });
}

function openDonorProfile(donorId) {
  donorDashboardScrollPosition = window.scrollY;
  donorActivityView = 'active';
  donorActivities = [];
  $$('.panel').forEach(panel => panel.classList.add('hidden'));
  $('donorProfilePanel').classList.remove('hidden');
  $$('.nav').forEach(button => button.classList.toggle('active', button.dataset.panel === 'donors'));
  $('pageTitle').textContent = 'Donor Profile';
  $('pageSubtitle').textContent = 'Relationship Management';
  window.scrollTo({ top: 0, behavior: 'auto' });
  loadDonorProfile(donorId);
}

function returnToDonors() {
  donorProfileRequestId += 1;
  donorActivityRequestId += 1;
  $('donorProfilePanel').classList.add('hidden');
  $('donorsPanel').classList.remove('hidden');
  $$('.nav').forEach(button => button.classList.toggle('active', button.dataset.panel === 'donors'));
  $('pageTitle').textContent = 'Donors';
  $('pageSubtitle').textContent = PANEL_META.donors.subtitle;
  requestAnimationFrame(() => window.scrollTo({ top: donorDashboardScrollPosition, behavior: 'auto' }));
}

function setDonorActivityView(view) {
  if (!['active', 'archived'].includes(view) || donorActivityView === view) return;
  donorActivityView = view;
  $('showActiveActivities').setAttribute('aria-pressed', String(view === 'active'));
  $('showArchivedActivities').setAttribute('aria-pressed', String(view === 'archived'));
  loadDonorActivities({ reset: true });
}

function activityTimelineItem(activity) {
  const view = activityTimelineViewModel(activity);
  const article = document.createElement('article');
  article.className = `activity-item${view.is_archived ? ' archived-activity' : ''}`;
  article.innerHTML = `
    <div class="activity-marker" aria-hidden="true">${esc(view.typeMarker)}</div>
    <div class="activity-content">
      <div class="row between activity-item-heading">
        <div class="activity-meta">
          <strong>${esc(view.typeLabel)}</strong>
          <time datetime="${esc(view.occurred_at)}">${esc(view.occurredLabel)}</time>
          ${view.is_archived ? '<span class="donor-flag archived">Archived</span>' : ''}
        </div>
        <button class="secondary edit-activity" aria-label="Edit activity: ${esc(view.subject)}">Edit</button>
      </div>
      <h4>${esc(view.subject)}</h4>
      <p class="activity-notes">${esc(view.notes)}</p>
      ${(view.outcome || view.next_action || view.next_action_date) ? `
        <dl class="activity-details">
          ${view.outcome ? `<div><dt>Outcome</dt><dd>${esc(view.outcome)}</dd></div>` : ''}
          ${view.next_action ? `<div><dt>Next action</dt><dd>${esc(view.next_action)}</dd></div>` : ''}
          ${view.next_action_date ? `<div><dt>Next action date</dt><dd>${esc(view.nextActionDateLabel || view.next_action_date)}</dd></div>` : ''}
        </dl>` : ''}
    </div>`;
  article.querySelector('.edit-activity').onclick = () => openActivityModal(activity);
  return article;
}

function renderDonorActivities() {
  if (!$('donorActivityList')) return;
  const state = $('donorActivityState');
  const list = $('donorActivityList');
  const loadMore = $('loadMoreActivities');
  $('showActiveActivities').setAttribute('aria-pressed', String(donorActivityView === 'active'));
  $('showArchivedActivities').setAttribute('aria-pressed', String(donorActivityView === 'archived'));
  loadMore.classList.toggle('hidden', !donorActivityHasMore || donorActivityLoading);

  if (donorActivityLoadError) {
    state.innerHTML = '<div class="activity-empty error-state"><strong>Unable to load activities</strong><span>The activity timeline is unavailable. Ask an administrator to verify the migration and your access.</span><button id="retryActivities" class="secondary">Try again</button></div>';
    list.innerHTML = '';
    $('retryActivities').onclick = () => loadDonorActivities({ reset: true });
    return;
  }
  if (donorActivityLoading && !donorActivities.length) {
    state.innerHTML = '<div class="activity-empty"><strong>Loading activities…</strong><span>Retrieving this donor’s recent activity.</span></div>';
    list.innerHTML = '';
    return;
  }
  if (!donorActivities.length) {
    const empty = activityTimelineEmptyState(donorActivityView === 'archived');
    state.innerHTML = `<div class="activity-empty"><strong>${esc(empty.title)}</strong><span>${esc(empty.message)}</span></div>`;
    list.innerHTML = '';
    return;
  }

  state.innerHTML = donorActivityLoading ? '<p class="activity-loading-more">Loading more activities…</p>' : '';
  list.innerHTML = '';
  donorActivities.forEach(activity => list.appendChild(activityTimelineItem(activity)));
}

async function loadDonorActivities({ reset = false } = {}) {
  if (!donorProfileRecord?.id || !$('donorActivityList')) return;
  const requestId = ++donorActivityRequestId;
  const userId = session?.user?.id;
  if (reset) {
    donorActivities = [];
    donorActivityHasMore = false;
  }
  donorActivityLoading = true;
  donorActivityLoadError = false;
  renderDonorActivities();
  const from = donorActivities.length;
  const { data, error } = await supabase
    .from('donor_activities')
    .select(ACTIVITY_FIELDS.join(','))
    .eq('owner_user_id', userId)
    .eq('donor_id', donorProfileRecord.id)
    .eq('is_archived', donorActivityView === 'archived')
    .order('occurred_at', { ascending: false })
    .range(from, from + ACTIVITY_PAGE_SIZE);
  if (requestId !== donorActivityRequestId || session?.user?.id !== userId) return;
  donorActivityLoading = false;
  if (error) {
    donorActivityLoadError = true;
    renderDonorActivities();
    return;
  }
  const rows = data || [];
  donorActivityHasMore = rows.length > ACTIVITY_PAGE_SIZE;
  donorActivities = reset
    ? rows.slice(0, ACTIVITY_PAGE_SIZE)
    : [...donorActivities, ...rows.slice(0, ACTIVITY_PAGE_SIZE)];
  renderDonorActivities();
}

function updateActivityGuidance() {
  $('activityNextActionGuidance').textContent = nextActionGuidance(
    $('activityNextAction').value,
    $('activityNextActionDate').value
  );
}

function openActivityModal(activity = null) {
  if (!donorProfileRecord) return;
  activityModalRecord = activity;
  activityModalReturnFocus = document.activeElement;
  $('activityModalTitle').textContent = activity ? 'Edit Activity' : 'Add Activity';
  $('activityModalArchived').classList.toggle('hidden', !activity?.is_archived);
  $('activityType').value = activity?.activity_type || 'phone_call';
  $('activityOccurredAt').value = toDateTimeLocalValue(activity?.occurred_at || new Date());
  $('activitySubject').value = activity?.subject || '';
  $('activityNotes').value = activity?.notes || '';
  $('activityOutcome').value = activity?.outcome || '';
  $('activityNextAction').value = activity?.next_action || '';
  $('activityNextActionDate').value = activity?.next_action_date || '';
  $('activityAdvanced').open = Boolean(activity?.outcome || activity?.next_action || activity?.next_action_date);
  $('activityFormError').textContent = '';
  updateActivityGuidance();
  $('archiveActivity').classList.toggle('hidden', !activity);
  $('archiveActivity').textContent = activity ? activityArchiveActionLabel(activity) : 'Archive Activity';
  $('archiveActivity').classList.toggle('restore-action', Boolean(activity?.is_archived));
  $('activityModal').classList.remove('hidden');
  requestAnimationFrame(() => (activity ? $('activitySubject') : $('activityType')).focus());
}

function closeActivityModal({ restoreFocus = true } = {}) {
  $('activityModal').classList.add('hidden');
  if (restoreFocus && activityModalReturnFocus?.isConnected) activityModalReturnFocus.focus();
  activityModalRecord = null;
}

async function refreshProfileAfterActivity() {
  const donorId = donorProfileRecord?.id;
  if (!donorId) return;
  await loadDonorProfile(donorId, { showLoading: false });
  requestAnimationFrame(() => $('addDonorActivity')?.focus());
}

$('closeActivityModal').onclick = () => closeActivityModal();
$('cancelActivity').onclick = () => closeActivityModal();
$('activityNextAction').oninput = updateActivityGuidance;
$('activityNextActionDate').onchange = updateActivityGuidance;
$('activityForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('saveActivity');
  button.disabled = true;
  $('activityFormError').textContent = '';
  try {
    const editing = Boolean(activityModalRecord);
    const payload = normalizeActivityPayload({
      activity_type: $('activityType').value,
      occurred_at: $('activityOccurredAt').value,
      subject: $('activitySubject').value,
      notes: $('activityNotes').value,
      outcome: $('activityOutcome').value,
      next_action: $('activityNextAction').value,
      next_action_date: $('activityNextActionDate').value
    }, donorProfileRecord.id);
    const query = activityModalRecord
      ? supabase
          .from('donor_activities')
          .update(payload)
          .eq('id', activityModalRecord.id)
          .eq('owner_user_id', session.user.id)
          .eq('donor_id', donorProfileRecord.id)
      : supabase.from('donor_activities').insert(payload);
    const { error } = await query;
    if (error) throw error;
    if (!activityModalRecord) donorActivityView = 'active';
    closeActivityModal({ restoreFocus: false });
    await refreshProfileAfterActivity();
    toast(editing ? 'Activity updated' : 'Activity added');
  } catch (error) {
    $('activityFormError').textContent = /required|valid|choose/i.test(error.message || '')
      ? error.message
      : 'The activity could not be saved. Check your access and try again.';
  } finally {
    button.disabled = false;
  }
};

$('archiveActivity').onclick = () => {
  if (!activityModalRecord) return;
  const restoring = Boolean(activityModalRecord.is_archived);
  $('activityArchiveConfirmTitle').textContent = restoring ? 'Restore activity?' : 'Archive activity?';
  $('activityArchiveConfirmBody').textContent = restoring
    ? 'This activity will return to the active donor timeline.'
    : 'This activity will be removed from the active timeline but will remain in the database.';
  $('confirmArchiveActivity').textContent = restoring ? 'Restore Activity' : 'Archive Activity';
  $('confirmArchiveActivity').classList.toggle('restore-action', restoring);
  $('activityArchiveConfirmModal').classList.remove('hidden');
  $('confirmArchiveActivity').focus();
};

$('cancelArchiveActivity').onclick = () => {
  $('activityArchiveConfirmModal').classList.add('hidden');
  $('archiveActivity').focus();
};

$('confirmArchiveActivity').onclick = async () => {
  if (!activityModalRecord || !donorProfileRecord) return;
  const restoring = Boolean(activityModalRecord.is_archived);
  const button = $('confirmArchiveActivity');
  button.disabled = true;
  try {
    const { error } = await supabase
      .from('donor_activities')
      .update({ is_archived: !restoring })
      .eq('id', activityModalRecord.id)
      .eq('owner_user_id', session.user.id)
      .eq('donor_id', donorProfileRecord.id);
    if (error) throw error;
    donorActivityView = 'active';
    $('activityArchiveConfirmModal').classList.add('hidden');
    closeActivityModal({ restoreFocus: false });
    await refreshProfileAfterActivity();
    toast(restoring ? 'Activity restored' : 'Activity archived');
  } catch {
    toast('The activity status could not be changed. Check your access and try again.');
  } finally {
    button.disabled = false;
  }
};

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
  const userId = session?.user?.id;
  const scopeVersion = userScopeVersion;
  if (!userId) return;
  const { data, error } = await supabase.from('knowledge_documents').select('*').order('updated_at', { ascending: false });
  if (scopeVersion !== userScopeVersion || session?.user?.id !== userId) return;
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
  $('deleteModal').textContent = 'Delete';
  $('deleteModal').classList.remove('restore-action');
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

async function loadDonors({ background = false } = {}) {
  const list = $('donorList');
  const userId = session?.user?.id;
  const scopeVersion = userScopeVersion;
  if (!userId) return;
  crmDonorLoadError = null;
  if (!background) {
    list.innerHTML = '<div class="donor-state"><strong>Loading donors…</strong><span>Retrieving the latest CRM records.</span></div>';
    $('donorStatus').innerHTML = '';
  }
  const { data, error } = await supabase
    .from('crm_donors')
    .select(CRM_DONOR_FIELDS.join(','))
    .eq('owner_user_id', userId)
    .order('household_name', { ascending: true });
  if (scopeVersion !== userScopeVersion || session?.user?.id !== userId) return;
  if (error) {
    crmDonorRows = [];
    crmDonorLoadError = error;
    renderDonorFilters();
    renderDonorDashboard();
    return;
  }
  crmDonorRows = data || [];
  crmDonorPage = 1;
  renderDonorFilters();
  renderDonorDashboard();
}

$('newDonor').onclick = () => openDonor(null);
$('refreshDonors').onclick = () => loadDonors();
$('donorSearch').oninput = resetAndRenderDonors;
$('donorStatusFilter').onchange = () => {
  crmDonorPage = 1;
  renderDonorFilters();
  renderDonorDashboard();
};
$('donorStageFilter').onchange = resetAndRenderDonors;
$('donorOfficerFilter').onchange = resetAndRenderDonors;
$('donorSort').onchange = resetAndRenderDonors;
$('previousDonorPage').onclick = () => {
  crmDonorPage -= 1;
  renderDonorDashboard();
  $('donorCount').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('nextDonorPage').onclick = () => {
  crmDonorPage += 1;
  renderDonorDashboard();
  $('donorCount').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function resetAndRenderDonors() {
  crmDonorPage = 1;
  renderDonorDashboard();
}

function updateFilterOptions(select, options, allLabel) {
  const selected = select.value;
  const values = [`<option value="">${allLabel}</option>`];
  if (options.hasUnassigned) values.push(`<option value="${UNASSIGNED_FILTER}">Unassigned</option>`);
  values.push(...options.values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`));
  select.innerHTML = values.join('');
  select.value = [...select.options].some(option => option.value === selected) ? selected : '';
}

function renderDonorFilters() {
  const statusRows = donorsForStatus(crmDonorRows, $('donorStatusFilter').value);
  updateFilterOptions($('donorStageFilter'), filterOptions(statusRows, 'stage'), 'All stages');
  updateFilterOptions($('donorOfficerFilter'), filterOptions(statusRows, 'assigned_officer'), 'All officers');
}

function renderDonorMetrics() {
  const metrics = donorMetrics(donorsForStatus(crmDonorRows, $('donorStatusFilter').value));
  $('donorKpis').innerHTML = `
    <article><span>Total Donors</span><strong>${metrics.totalDonors.toLocaleString()}</strong></article>
    <article><span>Total Lifetime Giving</span><strong>${metrics.hasLifetimeGiving ? esc(formatCurrency(metrics.totalLifetimeGiving)) : 'No giving data'}</strong><small>${metrics.missingLifetimeGiving.toLocaleString()} without giving data</small></article>
    <article><span>Donors With Next Actions</span><strong>${metrics.withNextActions.toLocaleString()}</strong></article>
    <article><span>Overdue Next Actions</span><strong>${metrics.overdueNextActions.toLocaleString()}</strong></article>
    <article><span>Not Contacted in 90+ Days</span><strong>${metrics.notContactedNinetyDays.toLocaleString()}</strong><small>${metrics.missingContactDates.toLocaleString()} without a contact date</small></article>`;
}

function donorLoadErrorMessage(error) {
  const permissionError = error?.code === '42501' || /row.level|permission|policy|rls/i.test(error?.message || '');
  return permissionError
    ? 'Your account does not have permission to read CRM donor records. Ask an administrator to verify Supabase access.'
    : 'Donor records could not be loaded. Check the connection and try again.';
}

function donorCard(row) {
  const location = [row.city, row.state].filter(Boolean).join(', ') || 'Location not recorded';
  const displayName = donorDisplayName(row);
  const secondaryHousehold = donorSecondaryHousehold(row);
  const lifetimeGiving = formatCurrency(row.lifetime_giving);
  const lastGiftAmount = formatCurrency(row.last_gift_amount);
  const lastGiftDate = formatCrmDate(row.last_gift_date);
  const lastContactDate = formatCrmDate(row.last_contact_date);
  const nextActionDate = formatCrmDate(row.next_action_date);
  const overdue = isOverdueNextAction(row);
  const dueSoon = !overdue && isDueWithinSevenDays(row);
  const staleContact = isNotContactedInNinetyDays(row);
  const statusFlags = [
    row.is_archived ? '<span class="donor-flag archived">Archived</span>' : '',
    overdue ? '<span class="donor-flag overdue">Overdue next action</span>' : '',
    dueSoon ? '<span class="donor-flag due-soon">Due within 7 days</span>' : '',
    staleContact ? '<span class="donor-flag stale-contact">90+ days since contact</span>' : ''
  ].filter(Boolean).join('');
  const article = document.createElement('article');
  article.className = `donor-card${overdue ? ' has-overdue-action' : ''}${dueSoon ? ' has-due-soon-action' : ''}`;
  article.innerHTML = `
    <a class="donor-card-open" href="#" aria-label="Open ${esc(displayName)}">
      <div class="donor-card-heading">
        <div class="donor-identity">
          <h3>${esc(displayName)}</h3>
          ${secondaryHousehold ? `<p class="donor-household">${esc(secondaryHousehold)}</p>` : ''}
          <p><strong>Donor Code</strong> ${esc(row.donor_code || 'No donor code')}</p>
          <p>${esc(location)}</p>
        </div>
      </div>
      <div class="donor-stage-row"><span class="stage-badge">${esc(row.stage?.trim() || 'No stage')}</span></div>
      <div class="donor-flags">${statusFlags}</div>
      <dl class="donor-details">
        <div><dt>Assigned officer</dt><dd>${esc(row.assigned_officer?.trim() || 'Unassigned')}</dd></div>
        <div><dt>Lifetime giving</dt><dd>${lifetimeGiving ? esc(lifetimeGiving) : 'No giving recorded'}</dd></div>
        <div><dt>Last gift</dt><dd>${lastGiftAmount ? esc(lastGiftAmount) : 'No gift amount recorded'}${lastGiftDate ? ` · ${esc(lastGiftDate)}` : ''}</dd></div>
        <div><dt>Last contact</dt><dd>${lastContactDate ? esc(lastContactDate) : 'No contact recorded'}</dd></div>
        <div class="next-action-detail"><dt>Next action</dt><dd>${esc(row.next_action?.trim() || 'No next action')}${nextActionDate ? ` · ${esc(nextActionDate)}` : ''}</dd></div>
      </dl>
    </a>
    <button class="edit-donor" aria-label="Edit ${esc(displayName)}" title="Edit donor"><span aria-hidden="true">✎</span></button>`;
  article.onclick = () => openDonorProfile(row.id);
  article.querySelector('.donor-card-open').onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    openDonorProfile(row.id);
  };
  article.querySelector('.edit-donor').onclick = event => {
    event.stopPropagation();
    openDonor(row);
  };
  return article;
}

function renderDonorDashboard() {
  renderDonorMetrics();
  const status = $('donorStatus');
  const list = $('donorList');
  const pagination = $('donorPagination');
  if (crmDonorLoadError) {
    $('donorCount').textContent = '0 matching donors';
    status.innerHTML = `<div class="donor-state error-state"><strong>Unable to load donors</strong><span>${esc(donorLoadErrorMessage(crmDonorLoadError))}</span><button id="retryDonors" class="secondary">Try again</button></div>`;
    list.innerHTML = '';
    pagination.classList.add('hidden');
    $('retryDonors').onclick = () => loadDonors();
    return;
  }
  status.innerHTML = '';
  const rows = filterAndSortDonors(crmDonorRows, {
    search: $('donorSearch').value,
    stage: $('donorStageFilter').value,
    officer: $('donorOfficerFilter').value,
    sort: $('donorSort').value,
    status: $('donorStatusFilter').value
  });
  const statusRows = donorsForStatus(crmDonorRows, $('donorStatusFilter').value);
  const statusLabel = $('donorStatusFilter').selectedOptions[0].textContent.toLocaleLowerCase('en-US');
  const page = paginateDonors(rows, crmDonorPage, DONORS_PER_PAGE);
  crmDonorPage = page.page;
  $('donorCount').textContent = rows.length
    ? `Showing ${page.start + 1}–${page.end} of ${rows.length.toLocaleString()} matching donors · ${statusRows.length.toLocaleString()} ${statusLabel} donors`
    : `0 matching donors · ${statusRows.length.toLocaleString()} ${statusLabel} donors`;
  list.innerHTML = '';
  if (!statusRows.length) {
    const emptyTitle = $('donorStatusFilter').value === DONOR_STATUS.ACTIVE ? 'No active donors' : `No ${statusLabel} donors`;
    const emptyCopy = crmDonorRows.length ? 'Choose another status to view other donor records.' : 'Create a donor or import a CSV to get started.';
    list.innerHTML = `<div class="donor-state"><strong>${emptyTitle}</strong><span>${emptyCopy}</span></div>`;
  } else if (!rows.length) {
    list.innerHTML = '<div class="donor-state"><strong>No matching donors</strong><span>Try changing the search or filters.</span></div>';
  } else {
    page.rows.forEach(row => list.appendChild(donorCard(row)));
  }
  pagination.classList.toggle('hidden', rows.length <= DONORS_PER_PAGE);
  $('donorPageStatus').textContent = `Page ${page.page} of ${page.totalPages}`;
  $('previousDonorPage').disabled = page.page <= 1;
  $('nextDonorPage').disabled = page.page >= page.totalPages;
}

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
  const importScopeVersion = userScopeVersion;
  const importUserId = session?.user?.id;
  if (!importUserId) return;
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
        if (importScopeVersion !== userScopeVersion || session?.user?.id !== importUserId) return;
        totals.inserted += result.inserted;
        totals.updated += result.updated;
        totals.rejected += result.rejected;
        serverErrors.push(...result.errors);
      } catch (error) {
        chunk.forEach(row => serverErrors.push({ row: row.row_number, error: error.message }));
        totals.rejected += chunk.length;
      }
    }
    if (importScopeVersion !== userScopeVersion || session?.user?.id !== importUserId) return;
    for (const failure of serverErrors) {
      const original = donorImport.validation.rows.find(row => row.rowNumber === failure.row);
      if (original) rejectedRows.push({ ...original, errors: [failure.error] });
    }
    donorImport.rejectedRows = rejectedRows;
    renderImportResults(totals, serverErrors);
    setDonorImportStep(4);
    if (totals.inserted + totals.updated > 0) {
      $('donorSearch').value = '';
      $('donorStageFilter').value = '';
      $('donorOfficerFilter').value = '';
      await loadDonors({ background: true });
    }
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
  $('modalBody').innerHTML = `<div class="crm-donor-form">
    <p id="dFormError" class="message error-text" role="alert"></p>
    <div class="form-grid">
      <label>Donor Code<input id="dDonorCode" required value="${esc(row?.donor_code || '')}" autocomplete="off"></label>
      <label>Household Name<input id="dHouseholdName" required value="${esc(row?.household_name || '')}" autocomplete="organization"></label>
      <label>First Name<input id="dFirstName" value="${esc(row?.first_name || '')}" autocomplete="given-name"></label>
      <label>Last Name<input id="dLastName" value="${esc(row?.last_name || '')}" autocomplete="family-name"></label>
      <label>Email<input id="dEmail" type="email" value="${esc(row?.email || '')}" autocomplete="email"></label>
      <label>Home Phone<input id="dHomePhone" type="tel" value="${esc(row?.home_phone || '')}" autocomplete="tel"></label>
      <label>Mobile Phone<input id="dMobilePhone" type="tel" value="${esc(row?.mobile_phone || '')}" autocomplete="tel"></label>
      <label>Assigned Officer<input id="dAssignedOfficer" value="${esc(row?.assigned_officer || '')}"></label>
      <label>Address<input id="dAddress" value="${esc(row?.address || '')}" autocomplete="street-address"></label>
      <label>City<input id="dCity" value="${esc(row?.city || '')}" autocomplete="address-level2"></label>
      <label>State<input id="dState" value="${esc(row?.state || '')}" autocomplete="address-level1"></label>
      <label>ZIP<input id="dZip" value="${esc(row?.zip || '')}" autocomplete="postal-code"></label>
      <label>Country<input id="dCountry" value="${esc(row?.country || '')}" autocomplete="country-name"></label>
      <label>Stage<input id="dStage" value="${esc(row?.stage || '')}"></label>
      <label>Lifetime Giving<input id="dLifetimeGiving" type="number" step="0.01" value="${row?.lifetime_giving ?? ''}"></label>
      <label>Last Gift Amount<input id="dLastGiftAmount" type="number" step="0.01" value="${row?.last_gift_amount ?? ''}"></label>
      <label>Last Gift Date<input id="dLastGiftDate" type="date" value="${esc(row?.last_gift_date || '')}"></label>
      <label>Last Contact Date<input id="dLastContactDate" type="date" value="${esc(row?.last_contact_date || '')}"></label>
      <label>Next Action Date<input id="dNextActionDate" type="date" value="${esc(row?.next_action_date || '')}"></label>
    </div>
    <label>Next Action<textarea id="dNextAction" rows="3">${esc(row?.next_action || '')}</textarea></label>
    <label>Notes<textarea id="dNotes" rows="5">${esc(row?.notes || '')}</textarea></label>
  </div>`;
  $('deleteModal').classList.toggle('hidden', !row);
  if (row) {
    $('deleteModal').textContent = row.is_archived ? 'Restore Donor' : 'Archive Donor';
    $('deleteModal').classList.toggle('restore-action', Boolean(row.is_archived));
  }
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
      const editingFromProfile = !($('donorProfilePanel').classList.contains('hidden'))
        && Boolean(modalRecord?.id)
        && donorProfileRecord?.id === modalRecord.id;
      const row = normalizeCrmDonorPayload({
        donor_code: $('dDonorCode').value,
        household_name: $('dHouseholdName').value,
        first_name: $('dFirstName').value,
        last_name: $('dLastName').value,
        email: $('dEmail').value,
        home_phone: $('dHomePhone').value,
        mobile_phone: $('dMobilePhone').value,
        address: $('dAddress').value,
        city: $('dCity').value,
        state: $('dState').value,
        zip: $('dZip').value,
        country: $('dCountry').value,
        assigned_officer: $('dAssignedOfficer').value,
        stage: $('dStage').value,
        lifetime_giving: $('dLifetimeGiving').value,
        last_gift_amount: $('dLastGiftAmount').value,
        last_gift_date: $('dLastGiftDate').value,
        last_contact_date: $('dLastContactDate').value,
        next_action: $('dNextAction').value,
        next_action_date: $('dNextActionDate').value,
        notes: $('dNotes').value,
      });
      const query = modalRecord
        ? supabase.from('crm_donors').update(row).eq('id', modalRecord.id).eq('owner_user_id', session.user.id)
        : supabase.from('crm_donors').insert(row);
      const { error } = await query;
      if (error?.code === '23505' || /duplicate|unique.*donor_code/i.test(error?.message || '')) {
        throw new Error('A donor with this Donor Code already exists.');
      }
      if (error) throw error;
      if (editingFromProfile) await loadDonorProfile(modalRecord.id, { showLoading: false });
      else await loadDonors();
    }
    $('modal').classList.add('hidden');
    toast('Saved');
  } catch (error) {
    if (modalType === 'donor' && $('dFormError')) $('dFormError').textContent = error.message;
    else toast(error.message);
  }
};

function openDonorArchiveConfirmation(row) {
  if (!row) return;
  modalType = 'donor';
  modalRecord = row;
  const restoring = Boolean(row.is_archived);
  $('archiveConfirmTitle').textContent = restoring ? 'Restore donor?' : 'Archive donor?';
  $('archiveConfirmBody').innerHTML = restoring
    ? '<p>This donor will return to the active donor list.</p>'
    : '<p>This donor will be removed from the active donor list but will remain in the database.</p><p>You can restore this donor at any time.</p>';
  $('confirmArchiveDonor').textContent = restoring ? 'Restore Donor' : 'Archive Donor';
  $('confirmArchiveDonor').classList.toggle('restore-action', restoring);
  $('archiveConfirmModal').classList.remove('hidden');
  $('confirmArchiveDonor').focus();
}

$('deleteModal').onclick = async () => {
  if (!modalRecord) return;
  if (modalType === 'donor') {
    openDonorArchiveConfirmation(modalRecord);
    return;
  }
  if (modalType !== 'knowledge' || !confirm('Delete this record?')) return;
  try {
    const result = await api('/api/knowledge-document', { method: 'DELETE', body: JSON.stringify({ id: modalRecord.id }) });
    await loadKnowledge();
    toast(result.warning || 'Deleted');
    $('modal').classList.add('hidden');
  } catch (error) { toast(error.message); }
};

$('cancelArchiveDonor').onclick = () => $('archiveConfirmModal').classList.add('hidden');
$('confirmArchiveDonor').onclick = async () => {
  if (!modalRecord || modalType !== 'donor') return;
  const restoring = Boolean(modalRecord.is_archived);
  const donorId = modalRecord.id;
  const updatingFromProfile = !($('donorProfilePanel').classList.contains('hidden'))
    && donorProfileRecord?.id === donorId;
  const button = $('confirmArchiveDonor');
  button.disabled = true;
  try {
    const { error } = await supabase
      .from('crm_donors')
      .update(archiveDonorPayload(!restoring))
      .eq('id', modalRecord.id)
      .eq('owner_user_id', session.user.id);
    if (error) throw error;
    $('archiveConfirmModal').classList.add('hidden');
    $('modal').classList.add('hidden');
    if (updatingFromProfile) await loadDonorProfile(donorId, { showLoading: false });
    else await loadDonors();
    toast(restoring ? 'Donor restored' : 'Donor archived');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};

async function loadHistory() {
  const userId = session?.user?.id;
  const scopeVersion = userScopeVersion;
  if (!userId) return;
  const { data, error } = await supabase.from('generations').select('*').order('created_at', { ascending: false }).limit(100);
  if (scopeVersion !== userScopeVersion || session?.user?.id !== userId) return;
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
