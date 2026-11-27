'use strict';

/* =====================================================================
   PHANT STUDIO — Suivi & Gestion Projets  (v3.1.0)
   Données : localStorage (cet appareil) + data.json dans un dépôt
   GitHub PRIVÉ (synchronisation entre appareils).
   ===================================================================== */

const LS = {
    data: 'phant_data_v2',
    dirty: 'phant_dirty',
    lastSynced: 'phant_last_synced',
    timer: 'phant_timer',
    notesTarget: 'phant_notes_target',
    ghUser: 'phant_gh_user',
    ghRepo: 'phant_gh_repo',
    ghToken: 'phant_gh_token',
    geminiKey: 'phant_gemini_key',
    geminiModel: 'phant_gemini_model'
};
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_RATE = 35;
const FORGOTTEN_TIMER_SECS = 4 * 3600;
const QUOTE_FOLLOWUP_DAYS = 10;

const STATUSES = ['Devis envoyé', 'En cours', 'En pause', 'Terminé'];

const PROJECT_TYPES = {
    mariage: {
        label: 'Mariage & papeterie',
        steps: ['Brief & questionnaire', 'Moodboard / croquis', 'Proposition V1', 'Retours client', 'Textes validés', 'BAT', 'Impression', 'Livraison']
    },
    logo: {
        label: 'Logo & identité',
        steps: ['Brief', 'Recherches & croquis', 'Propositions', 'Retours client', 'Finalisation', 'Charte graphique', 'Livraison des fichiers']
    },
    affiche: {
        label: 'Affiche & événementiel',
        steps: ['Brief', 'Proposition V1', 'Retours client', 'Déclinaisons', 'BAT', 'Impression / diffusion']
    },
    illustration: {
        label: 'Illustration',
        steps: ['Brief', 'Croquis', 'Validation croquis', 'Encrage & couleur', 'Retours client', 'Livraison']
    },
    autre: {
        label: 'Autre',
        steps: ['Brief', 'Proposition V1', 'Retours client', 'Livraison']
    }
};

let appData = emptyData();
let ghConfig = { username: lsGet(LS.ghUser), repo: lsGet(LS.ghRepo), token: lsGet(LS.ghToken) };
let fileSha = null;
let repoPrivacyChecked = false;

let saveDebounce = null;
let saving = false;
let saveAgain = false;

let currentBase64Image = null;
let currentImageMime = 'image/png';
let lastAnalysis = null;   // { structured: objet | null, text: string }
let aiFlow = null;         // création client + projet depuis l'IA

let timerState = loadTimerState();
let currentNotesTarget = lsGet(LS.notesTarget) || 'general';
let openProjectDetailId = null;
let projectStatusFilter = 'actifs';
let calCursor = firstOfMonth(new Date());

/* ---------------------------------------------------------------------
   OUTILS
   --------------------------------------------------------------------- */
function lsGet(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { console.error('Stockage local impossible', e); } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* rien */ } }
function safeParse(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; } }

function emptyData() {
    return { clients: [], projects: [], sessions: [], notes: '', settings: { monthlyGoalHours: null }, updatedAt: null };
}

function normalizeProject(p) {
    return {
        ...p,
        type: PROJECT_TYPES[p.type] ? p.type : 'autre',
        status: STATUSES.includes(p.status) ? p.status : 'En cours',
        steps: Array.isArray(p.steps) ? p.steps : [],
        links: Array.isArray(p.links) ? p.links : [],
        notes: typeof p.notes === 'string' ? p.notes : ''
    };
}

function normalizeData(d) {
    d = d || {};
    return {
        clients: Array.isArray(d.clients) ? d.clients : [],
        projects: Array.isArray(d.projects) ? d.projects.map(normalizeProject) : [],
        sessions: Array.isArray(d.sessions) ? d.sessions : [],
        notes: typeof d.notes === 'string' ? d.notes : '',
        settings: { monthlyGoalHours: null, ...(d.settings || {}) },
        updatedAt: d.updatedAt || null
    };
}

function hasContent(d) {
    return !!(d && (d.clients.length || d.projects.length || d.sessions.length || (d.notes && d.notes.trim())));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u) {
    try {
        const url = new URL(String(u || '').trim());
        return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch (e) { return ''; }
}

function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function isoLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayLocal() { return isoLocal(new Date()); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function parseIsoDate(iso) { return new Date(iso + 'T00:00:00'); }
function daysBetween(fromIso, toIso) { return Math.round((parseIsoDate(toIso) - parseIsoDate(fromIso)) / 86400000); }
function addDaysIso(iso, n) { const d = parseIsoDate(iso); d.setDate(d.getDate() + n); return isoLocal(d); }

function formatDateFr(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}
function formatDateShort(iso) {
    return parseIsoDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}
function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
}

function formatHours(totalSecs) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return `${h}h${m.toString().padStart(2, '0')}`;
}
function formatEuro(n) { return (n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
function formatEuroRound(n) { return (n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }); }

// Appelé après chaque rendu : icônes + largeurs des barres (pas d'attribut style, interdit par la CSP)
function refreshIcons() {
    if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
    document.querySelectorAll('[data-pct]').forEach(el => { el.style.width = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0)) + '%'; });
    document.querySelectorAll('[data-left]').forEach(el => { el.style.left = Math.max(0, Math.min(100, Number(el.dataset.left) || 0)) + '%'; });
    document.querySelectorAll('[data-bg]').forEach(el => { if (/^#[0-9a-f]{6}$/i.test(el.dataset.bg)) el.style.background = el.dataset.bg; });
}

/* ---------------------------------------------------------------------
   ACTIONS : aucun code dans le HTML. Les boutons portent data-action
   (+ data-id, data-arg, data-arg2) ; seuls les noms listés ici répondent.
   --------------------------------------------------------------------- */
const ACTIONS = {
    switchTab, openConfigModal, exportDataCSV, quickStartTimer, toggleTimerPause, stopTimer, startTimer, pauseTimer,
    discardTimer, fixForgottenTimer, openSessionsModal, openDecompilerModal, openCurrentNotesProject, formatText, clearNotes,
    loadQuestionnaire, openProjectModal, exportICS, changeCalendarMonth, openClientModal, closeModal, clearSessionFilters,
    openManualSessionModal, closeAndOpenConfig, clickInput, analyzeImageWithGemini, copyAnalysisToEditor, createFromAnalysis,
    editProject, deleteProject, cancelClientModal, cancelProjectModal, suggestBudgetFromPrice, openLoginSetup, openVersionsModal,
    exportBackupJSON, logout, restoreVersion, openProjectDetailModal, editSession, deleteSession, startTimerForProject,
    openManualSessionForProject, addStep, moveStep, deleteStep, deleteLink, openNotesForProject, setProjectFilter,
    editClient, deleteClient,
    // champs (change / input)
    onTimerFieldChange, switchNotesTarget, renderProjects, renderClients, renderStats, renderSessions, saveMonthlyGoal,
    toggleBudgetInput, handleFileSelect, importBackupJSON, toggleStep, renameStep, setStepDate,
    // formulaires (submit)
    saveManualSession, saveClient, saveProject, handleLoginSubmit, handleAuthSubmit, addLink
};

function actionArgs(el) {
    return ['id', 'arg', 'arg2'].map(k => el.dataset[k]).filter(v => v !== undefined);
}

function runAction(name, args) {
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
    if (!fn) { console.warn('Action inconnue', name); return; }
    fn(...args);
}

function setupActions() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el || el.disabled) return;
        e.preventDefault();
        runAction(el.dataset.action, actionArgs(el));
    });
    // Garder la sélection dans l'éditeur quand on clique sur la barre d'outils
    document.addEventListener('mousedown', (e) => { if (e.target.closest('[data-keep-focus]')) e.preventDefault(); });
    const onField = (attr) => (e) => {
        const el = e.target.closest(`[data-${attr}]`);
        if (!el) return;
        const args = actionArgs(el);
        if ('withEvent' in el.dataset) args.unshift(e);
        else if ('withValue' in el.dataset || args.length) args.push(el.type === 'checkbox' ? el.checked : el.value);
        runAction(el.dataset[attr], args);
    };
    document.addEventListener('change', onField('change'));
    document.addEventListener('input', onField('input'));
    document.addEventListener('submit', (e) => {
        const form = e.target.closest('[data-submit]');
        if (!form) return;
        runAction(form.dataset.submit, [e, ...actionArgs(form)]);
    });
}

function clickInput(id) { const el = document.getElementById(id); if (el) el.click(); }
function closeAndOpenConfig(modalId) { closeModal(modalId); openConfigModal(); }
function openCurrentNotesProject() { if (currentNotesTarget !== 'general') openProjectDetailModal(currentNotesTarget); }

function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function b64EncodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
function b64DecodeUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function getProject(id) { return appData.projects.find(p => p.id === id); }
function getClient(id) { return appData.clients.find(c => c.id === id); }
function clientName(c) { return c ? `${c.firstname || ''} ${c.lastname || ''}`.trim() || 'Sans nom' : 'Client inconnu'; }
function projectSessions(pid) { return appData.sessions.filter(s => s.projectId === pid); }
function sumSecs(list) { return list.reduce((acc, s) => acc + (Number(s.durationSeconds) || 0), 0); }
function projectSecs(pid) { return sumSecs(projectSessions(pid)); }
function typeLabel(t) { return (PROJECT_TYPES[t] || PROJECT_TYPES.autre).label; }

/* ---------------------------------------------------------------------
   DÉMARRAGE
   --------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
    setupActions();
    loadLocalData();
    fillStaticSelects();
    updateAllViews();
    switchNotesTarget(currentNotesTarget, { silent: true });
    restoreTimerUI();
    switchTab(tabFromHash());
    setInterval(refreshTimerDisplay, 1000);

    setupEditor();
    setupDropZone();
    setupKeyboard();

    if (isConfigured()) syncFromGitHub();
    else {
        updateSyncBadge('warning', 'Local uniquement');
        fetchLoginBlob().then(b => { loginBlob = b; if (b && !isConfigured()) openLoginModal('login'); });
    }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker non installé', err));
    }
    refreshIcons();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveDebounce) {
        clearTimeout(saveDebounce);
        saveDebounce = null;
        pushToGitHub();
    }
    if (document.visibilityState === 'visible') renderDashboard();
});

window.addEventListener('beforeunload', (e) => {
    if (isConfigured() && (saving || saveDebounce)) {
        e.preventDefault();
        e.returnValue = '';
    }
});

function loadLocalData() {
    const stored = safeParse(lsGet(LS.data), null);
    if (stored) { appData = normalizeData(stored); return; }

    // Reprise des données de l'ancienne version (v2.0.0)
    const oldClients = safeParse(lsGet('phant_clients'), null);
    const oldProjects = safeParse(lsGet('phant_projects'), null);
    const oldSessions = safeParse(lsGet('phant_sessions'), null);
    if (oldClients || oldProjects || oldSessions) {
        appData = normalizeData({ clients: oldClients, projects: oldProjects, sessions: oldSessions });
        appData.updatedAt = new Date().toISOString();
        lsSet(LS.data, JSON.stringify(appData));
        lsSet(LS.dirty, '1');
    } else {
        appData = emptyData();
    }
}

function fillStaticSelects() {
    document.getElementById('project-type').innerHTML = Object.entries(PROJECT_TYPES)
        .map(([k, t]) => `<option value="${k}">${escapeHtml(t.label)}</option>`).join('');
    document.getElementById('project-status').innerHTML = STATUSES
        .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
}

/* ---------------------------------------------------------------------
   SYNCHRONISATION GITHUB
   --------------------------------------------------------------------- */
class GitHubError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function isConfigured() { return !!(ghConfig.token && ghConfig.username && ghConfig.repo); }
function repoUrl() { return `https://api.github.com/repos/${encodeURIComponent(ghConfig.username)}/${encodeURIComponent(ghConfig.repo)}`; }
function fileUrl() { return `${repoUrl()}/contents/data.json`; }
function ghHeaders(extra = {}) { return { 'Authorization': `Bearer ${ghConfig.token}`, 'Accept': 'application/vnd.github+json', ...extra }; }

function ghErrorText(status) {
    switch (status) {
        case 401: return 'Jeton invalide ou expiré';
        case 403: return 'Jeton sans droit d\'écriture (Contents)';
        case 404: return 'Dépôt introuvable ou non autorisé pour ce jeton';
        case 409:
        case 422: return 'Conflit de version, réessayez';
        default: return `Erreur GitHub (${status || 'réseau'})`;
    }
}

async function ghFetch(url, options = {}) {
    try {
        return await fetch(url, { cache: 'no-store', ...options, headers: ghHeaders(options.headers || {}) });
    } catch (e) {
        throw new GitHubError(0, 'Pas de connexion Internet');
    }
}

async function checkRepoPrivate() {
    const repoRes = await ghFetch(`${repoUrl()}?nocache=${Date.now()}`);
    if (!repoRes.ok) throw new GitHubError(repoRes.status, ghErrorText(repoRes.status));
    const repoInfo = await repoRes.json();
    if (repoInfo.private === false) throw new GitHubError(-1, 'Ce dépôt est PUBLIC ! Utilisez un dépôt privé');
    repoPrivacyChecked = true;
}

async function readFileJson(json, ref) {
    if (json.encoding === 'base64' && json.content) return b64DecodeUtf8(json.content);
    // Fichier > 1 Mo : récupération en brut
    const raw = await ghFetch(`${fileUrl()}?nocache=${Date.now()}${ref ? '&ref=' + encodeURIComponent(ref) : ''}`,
        { headers: { 'Accept': 'application/vnd.github.raw+json' } });
    if (!raw.ok) throw new GitHubError(raw.status, ghErrorText(raw.status));
    return raw.text();
}

async function fetchRemote() {
    const res = await ghFetch(`${fileUrl()}?nocache=${Date.now()}`);
    if (res.status === 404) {
        await checkRepoPrivate(); // distingue « fichier absent » de « dépôt inaccessible »
        return { exists: false, sha: null, data: null };
    }
    if (!res.ok) throw new GitHubError(res.status, ghErrorText(res.status));
    if (!repoPrivacyChecked) await checkRepoPrivate();

    const json = await res.json();
    const text = await readFileJson(json);
    return { exists: true, sha: json.sha, data: normalizeData(safeParse(text, {})) };
}

async function syncFromGitHub() {
    if (!isConfigured()) { updateSyncBadge('warning', 'Local uniquement'); return; }
    updateSyncBadge('loading', 'Chargement...');

    try {
        const remote = await fetchRemote();
        fileSha = remote.sha;

        const dirty = lsGet(LS.dirty) === '1';
        const lastSynced = lsGet(LS.lastSynced);

        let keepLocal = false;
        if (!remote.exists) {
            keepLocal = true;
        } else if (!hasContent(remote.data) && hasContent(appData)) {
            keepLocal = true;
        } else if (dirty) {
            const remoteChangedElsewhere = remote.data.updatedAt && remote.data.updatedAt !== lastSynced;
            keepLocal = remoteChangedElsewhere
                ? confirm('Attention : des modifications existent à la fois sur CET appareil (pas encore envoyées) ' +
                    'et dans le cloud (faites depuis un autre appareil).\n\n' +
                    'OK = garder la version de CET appareil\nAnnuler = garder la version du CLOUD')
                : true;
        }

        if (keepLocal) {
            if (!appData.updatedAt) appData.updatedAt = new Date().toISOString();
            lsSet(LS.data, JSON.stringify(appData));
            await pushToGitHub();
        } else {
            appData = remote.data;
            lsSet(LS.data, JSON.stringify(appData));
            lsDel(LS.dirty);
            lsSet(LS.lastSynced, appData.updatedAt || '');
            updateAllViews();
            switchNotesTarget(currentNotesTarget, { silent: true });
            updateSyncBadge('success', 'Synchronisé');
        }
    } catch (err) {
        console.error('Échec synchronisation GitHub :', err);
        updateSyncBadge('error', err.message || 'Erreur de synchronisation');
    }
}

// À appeler après CHAQUE modification de données
function commitChange({ rerender = true, skipDetail = false, delay = 1200 } = {}) {
    appData.updatedAt = new Date().toISOString();
    lsSet(LS.data, JSON.stringify(appData));
    lsSet(LS.dirty, '1');
    if (rerender) updateAllViews({ skipDetail });

    if (!isConfigured()) { updateSyncBadge('warning', 'Local uniquement'); return; }
    updateSyncBadge('loading', 'Modifications en attente...');
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => { saveDebounce = null; pushToGitHub(); }, delay);
}

async function pushToGitHub() {
    if (!isConfigured()) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    try {
        do {
            saveAgain = false;
            await pushOnce();
        } while (saveAgain);
    } catch (err) {
        console.error('Erreur enregistrement GitHub :', err);
        updateSyncBadge('error', `${err.message || 'Erreur'} — données gardées sur cet appareil`);
    } finally {
        saving = false;
    }
}

async function pushOnce() {
    updateSyncBadge('loading', 'Enregistrement...');
    const snapshot = JSON.stringify(appData, null, 2);
    const snapshotUpdatedAt = appData.updatedAt;

    for (let attempt = 0; attempt < 2; attempt++) {
        const body = {
            message: `Mise à jour ${new Date().toLocaleString('fr-FR')} — Phant Studio`,
            content: b64EncodeUtf8(snapshot)
        };
        if (fileSha) body.sha = fileSha;

        const res = await ghFetch(fileUrl(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            const resData = await res.json();
            fileSha = resData.content.sha;
            lsSet(LS.lastSynced, snapshotUpdatedAt || '');
            if (appData.updatedAt === snapshotUpdatedAt) lsDel(LS.dirty);
            updateSyncBadge('success', 'Synchronisé');
            return;
        }
        if ((res.status === 409 || res.status === 422) && attempt === 0) {
            const remote = await fetchRemote();
            fileSha = remote.sha;
            continue;
        }
        throw new GitHubError(res.status, ghErrorText(res.status));
    }
}

function updateSyncBadge(status, message) {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;
    badge.className = 'sync sync-' + (['success', 'loading', 'warning', 'error'].includes(status) ? status : 'error');
    badge.title = status === 'error' ? 'Ouvrez les Réglages pour vérifier vos informations' : '';
    badge.textContent = message;
}

/* ---------------------------------------------------------------------
   VERSIONS (historique GitHub)
   --------------------------------------------------------------------- */
async function openVersionsModal() {
    if (!isConfigured()) { alert('Connectez d\'abord GitHub (section 1).'); return; }
    const list = document.getElementById('versions-list');
    list.innerHTML = '<div class="pb grid gap-2" aria-label="Chargement"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    openModal('versions-modal');
    try {
        const res = await ghFetch(`${repoUrl()}/commits?path=data.json&per_page=40&nocache=${Date.now()}`);
        if (!res.ok) throw new GitHubError(res.status, ghErrorText(res.status));
        const commits = await res.json();
        if (!commits.length) { list.innerHTML = '<p class="empty">Aucune version pour le moment.</p>'; return; }
        list.innerHTML = commits.map((c, i) => {
            const date = new Date(c.commit.author.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
            return `
                <div class="flex items-center justify-between gap-2 px-4 py-2 min-h-[56px] border-t border-dashed border-[#1B1A18]/50 first:border-t-0">
                    <span class="font-semibold">${escapeHtml(date)}${i === 0 ? ' <span class="st st-cours ml-2">actuelle</span>' : ''}</span>
                    ${i === 0 ? '' : `<button type="button" data-action="restoreVersion" data-id="${escapeHtml(c.sha)}" data-arg="${escapeHtml(date)}" class="btn btn-sm">Restaurer</button>`}
                </div>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<p class="empty err">${escapeHtml(err.message)}<br><button type="button" data-action="openVersionsModal" class="link">Réessayer</button></p>`;
    }
}

async function restoreVersion(sha, label) {
    if (!confirm(`Remplacer toutes les données actuelles par la version du ${label} ?`)) return;
    try {
        const res = await ghFetch(`${fileUrl()}?ref=${encodeURIComponent(sha)}&nocache=${Date.now()}`);
        if (!res.ok) throw new GitHubError(res.status, ghErrorText(res.status));
        const json = await res.json();
        const data = normalizeData(safeParse(await readFileJson(json, sha), null));
        appData = data;
        commitChange({ delay: 0 });
        switchNotesTarget(currentNotesTarget, { silent: true });
        closeModal('versions-modal');
        closeModal('config-modal');
        alert('Version restaurée ✓');
    } catch (err) {
        alert('Restauration impossible : ' + err.message);
    }
}

/* ---------------------------------------------------------------------
   RÉGLAGES
   --------------------------------------------------------------------- */
function openConfigModal() {
    document.getElementById('gh-username-input').value = ghConfig.username;
    document.getElementById('gh-repo-input').value = ghConfig.repo;
    document.getElementById('gh-token-input').value = ghConfig.token;
    document.getElementById('gemini-key-input').value = lsGet(LS.geminiKey);
    document.getElementById('gemini-model-input').value = lsGet(LS.geminiModel) || DEFAULT_GEMINI_MODEL;
    openModal('config-modal');
}

function handleAuthSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('gh-username-input').value.trim();
    const repo = document.getElementById('gh-repo-input').value.trim().replace(/\.git$/, '');
    const token = document.getElementById('gh-token-input').value.trim();
    const geminiKey = document.getElementById('gemini-key-input').value.trim();
    const geminiModel = document.getElementById('gemini-model-input').value.trim() || DEFAULT_GEMINI_MODEL;

    if (!token || !username || !repo) { alert('Veuillez remplir les 3 champs GitHub.'); return; }

    const repoChanged = username !== ghConfig.username || repo !== ghConfig.repo;
    ghConfig = { username, repo, token };
    if (repoChanged) { fileSha = null; repoPrivacyChecked = false; }

    lsSet(LS.ghToken, token);
    lsSet(LS.ghUser, username);
    lsSet(LS.ghRepo, repo);
    if (geminiKey) lsSet(LS.geminiKey, geminiKey); else lsDel(LS.geminiKey);
    lsSet(LS.geminiModel, geminiModel);

    closeModal('config-modal');
    syncFromGitHub();
}

function logout() {
    if (!confirm('Oublier le jeton GitHub sur cet appareil ?\nVos données restent sur GitHub et sur cet appareil.')) return;
    lsDel(LS.ghToken);
    ghConfig.token = '';
    fileSha = null;
    document.getElementById('gh-token-input').value = '';
    updateSyncBadge('warning', 'Local uniquement');
    closeModal('config-modal');
}

/* ---------------------------------------------------------------------
   CONNEXION (identifiant + mot de passe, propre à Phant Studio)
   Le jeton est chiffré (PBKDF2 600 000 itérations + AES-GCM) avec un identifiant
   et un mot de passe choisis ici, puis publié dans acces.json à la racine de ce
   dépôt (seul le chiffré est public). Rien n'est partagé avec les autres applis.
   --------------------------------------------------------------------- */
const LOGIN_REPO = 'adrienfeuilloy/phant-studio-app';
const LOGIN_FILE = 'acces.json';
const LOGIN_ITER = 600000;
let loginBlob = null;
let loginMode = 'login';

const u64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const d64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function loginKey(id, pw, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(id.trim().toLowerCase() + '|' + pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: LOGIN_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function loginEncrypt(id, pw, data) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await loginKey(id, pw, salt), new TextEncoder().encode(JSON.stringify(data))));
    const all = new Uint8Array(28 + ct.length); all.set(salt); all.set(iv, 16); all.set(ct, 28);
    return u64(all);
}
async function loginDecrypt(id, pw, blob) {
    const all = d64(blob);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(16, 28) }, await loginKey(id, pw, all.slice(0, 16)), all.slice(28))));
}
async function fetchLoginBlob() {
    try {
        const r = await fetch(`${LOGIN_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return null;
        const j = await r.json();
        return /^[\w-]{40,}$/.test(j.data || '') ? j.data : null;
    } catch (e) { return null; }
}

function openLoginModal(mode) {
    loginMode = mode;
    const setup = mode === 'setup';
    document.getElementById('login-title').textContent = setup ? 'Activer le login' : 'Connexion';
    document.getElementById('login-intro').textContent = setup
        ? 'Choisissez un identifiant et un mot de passe propres à Phant Studio (pas ceux de GitHub). Sur un nouvel appareil, il suffira de les saisir.'
        : 'Votre identifiant et votre mot de passe Phant Studio pour retrouver vos projets sur cet appareil.';
    document.getElementById('login-confirm-wrap').classList.toggle('hidden', !setup);
    document.getElementById('login-token-link').classList.toggle('hidden', setup);
    document.getElementById('login-submit').textContent = setup ? 'Activer' : 'Se connecter';
    document.getElementById('login-password').setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
    ['login-id', 'login-password', 'login-confirm'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('login-msg').textContent = '';
    openModal('login-modal');
    setTimeout(() => document.getElementById('login-id').focus(), 100);
}

function openLoginSetup() {
    if (!isConfigured()) { alert('Enregistrez d\'abord le jeton GitHub dans les réglages.'); return; }
    closeModal('config-modal');
    openLoginModal('setup');
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('login-id').value.trim();
    const pw = document.getElementById('login-password').value;
    const msg = document.getElementById('login-msg');
    const btn = document.getElementById('login-submit');
    if (!id) { msg.textContent = 'Indiquez un identifiant.'; return; }

    if (loginMode === 'login') {
        btn.disabled = true; msg.textContent = 'Déchiffrement…';
        try {
            const d = await loginDecrypt(id, pw, loginBlob);
            ghConfig = { username: d.o, repo: d.r, token: d.k };
            lsSet(LS.ghToken, d.k); lsSet(LS.ghUser, d.o); lsSet(LS.ghRepo, d.r);
            fileSha = null; repoPrivacyChecked = false;
            closeModal('login-modal');
            syncFromGitHub();
        } catch (err) { msg.textContent = '✗ Identifiant ou mot de passe incorrect'; }
        btn.disabled = false;
        return;
    }

    if (pw.length < 12) { msg.textContent = 'Mot de passe trop court (12 caractères minimum).'; return; }
    if (pw !== document.getElementById('login-confirm').value) { msg.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
    btn.disabled = true; msg.textContent = 'Chiffrement…';
    try {
        const blob = await loginEncrypt(id, pw, { o: ghConfig.username, r: ghConfig.repo, k: ghConfig.token });
        const url = `https://api.github.com/repos/${LOGIN_REPO}/contents/${LOGIN_FILE}`;
        let sha;
        const r0 = await ghFetch(url);
        if (r0.ok) sha = (await r0.json()).sha;
        const r = await ghFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Accès chiffré', content: b64EncodeUtf8(JSON.stringify({ v: 1, data: blob }) + '\n'), ...(sha ? { sha } : {}) })
        });
        if (!r.ok) throw new GitHubError(r.status, ghErrorText(r.status));
        msg.textContent = '✓ Activé. Sur un nouvel appareil, ouvrez adrienfeuilloy.github.io/phant-studio-app et connectez-vous (disponible d\'ici une minute).';
    } catch (err) {
        msg.textContent = (err.status === 403 || err.status === 404)
            ? '✗ Le jeton n\'a pas accès au dépôt phant-studio-app. Ajoutez-le à votre jeton GitHub (Repository access, Contents : lecture et écriture), puis réessayez.'
            : '✗ Échec de la publication (' + err.message + '). Réessayez.';
    }
    btn.disabled = false;
}

/* ---------------------------------------------------------------------
   SAUVEGARDES & EXPORTS
   --------------------------------------------------------------------- */
function exportBackupJSON() {
    downloadBlob(JSON.stringify(appData, null, 2), `phant_studio_sauvegarde_${todayLocal()}.json`, 'application/json');
}

function importBackupJSON(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const parsed = safeParse(reader.result, null);
        if (!parsed || !Array.isArray(parsed.clients) || !Array.isArray(parsed.projects)) {
            alert('Ce fichier n\'est pas une sauvegarde Phant Studio valide.');
            return;
        }
        if (!confirm('Remplacer TOUTES les données actuelles par celles de cette sauvegarde ?')) return;
        appData = normalizeData(parsed);
        commitChange({ delay: 0 });
        switchNotesTarget(currentNotesTarget, { silent: true });
        closeModal('config-modal');
    };
    reader.readAsText(file);
}

function exportDataCSV() {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const rows = [['Date', 'Projet', 'Type', 'Client', 'Catégorie', 'Durée (h)', 'Taux visé (€/h)', 'Valeur temps (€)', 'Notes']];
    sortedSessions(appData.sessions).forEach(s => {
        const p = getProject(s.projectId);
        const c = p ? getClient(p.clientId) : null;
        const hours = (Number(s.durationSeconds) || 0) / 3600;
        const rate = p ? (Number(p.hourlyRate) || 0) : 0;
        rows.push([
            formatDateFr(s.date), p ? p.name : 'Projet supprimé', p ? typeLabel(p.type) : '', c ? clientName(c) : '', s.category,
            hours.toFixed(2).replace('.', ','), String(rate).replace('.', ','),
            (hours * rate).toFixed(2).replace('.', ','), s.notes || ''
        ]);
    });
    const csv = '\uFEFF' + rows.map(r => r.map(cell).join(';')).join('\r\n');
    downloadBlob(csv, `phant_studio_sessions_${todayLocal()}.csv`, 'text/csv;charset=utf-8');
}

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
    const out = [];
    while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); }
    out.push(line);
    return out.join('\r\n');
}

function exportICS() {
    const events = allEvents();
    if (!events.length) { alert('Aucune date à exporter : ajoutez une deadline ou des dates d\'étapes à vos projets.'); return; }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Phant Studio//Suivi projets//FR', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Phant Studio'];
    events.forEach(ev => {
        const client = clientName(getClient(ev.project.clientId));
        const summary = ev.kind === 'deadline'
            ? `🔴 Deadline : ${ev.project.name} (${client})`
            : `${ev.done ? '✅' : '▫️'} ${ev.label} — ${ev.project.name}`;
        lines.push('BEGIN:VEVENT',
            `UID:${ev.uid}@phant-studio`,
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`,
            `DTEND;VALUE=DATE:${addDaysIso(ev.date, 1).replace(/-/g, '')}`,
            icsFold(`SUMMARY:${icsEscape(summary)}`),
            icsFold(`DESCRIPTION:${icsEscape(`Client : ${client}\nStatut : ${ev.project.status}`)}`),
            'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    downloadBlob(lines.join('\r\n'), `phant_studio_planning_${todayLocal()}.ics`, 'text/calendar;charset=utf-8');
}

/* ---------------------------------------------------------------------
   FENÊTRES & NAVIGATION
   --------------------------------------------------------------------- */
const modalOpeners = [];
function openModal(id) {
    const modal = document.getElementById(id);
    if (modal.classList.contains('hidden')) modalOpeners.push({ id, el: document.activeElement });
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    refreshIcons();
    const first = modal.querySelector('.sheet-body input:not([type=hidden]):not(.hidden), .sheet-body select, .sheet-body textarea, .sheet-body button, .sheet-head button');
    if (first && !first.disabled) setTimeout(() => first.focus({ preventScroll: true }), 30);
}
function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('hidden');
    if (id === 'project-detail-modal') openProjectDetailId = null;
    if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('overflow-hidden');
    const i = modalOpeners.map(o => o.id).lastIndexOf(id);
    if (i !== -1) {
        const { el } = modalOpeners.splice(i, 1)[0];
        if (el && document.contains(el) && el.offsetParent !== null) el.focus({ preventScroll: true });
    }
}

function topModal() {
    const open = [...document.querySelectorAll('.modal')].filter(m => !m.classList.contains('hidden')).reverse();
    return open.sort((a, b) => (parseInt(getComputedStyle(b).zIndex) || 0) - (parseInt(getComputedStyle(a).zIndex) || 0))[0];
}

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        const top = topModal();
        if (!top) return;
        if (e.key === 'Escape') {
            if (top.id === 'client-modal') cancelClientModal();
            else if (top.id === 'project-modal') cancelProjectModal();
            else closeModal(top.id);
            return;
        }
        if (e.key !== 'Tab') return;
        // Garder le clavier dans la fenêtre ouverte
        const items = [...top.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], summary')]
            .filter(el => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // Clic sur le fond sombre = fermer (sauf formulaires, pour ne rien perdre)
    document.addEventListener('mousedown', (e) => {
        const m = e.target.classList && e.target.classList.contains('modal') ? e.target : null;
        if (m && !m.querySelector('form')) closeModal(m.id);
    });
}

// Onglets : l'adresse garde l'onglet ouvert (#projets…), pour le rechargement et le bouton Retour
const TAB_SLUGS = { dashboard: '', timer: 'chrono', projects: 'projets', planning: 'planning', clients: 'clients', stats: 'stats' };
function tabFromHash() {
    const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
    return Object.keys(TAB_SLUGS).find(k => TAB_SLUGS[k] === slug) || 'dashboard';
}

function switchTab(tabId) {
    if (!(tabId in TAB_SLUGS)) tabId = 'dashboard';
    const panel = document.getElementById(`tab-${tabId}`);
    const wasHidden = panel.classList.contains('hidden');
    document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('hidden', el !== panel));
    document.querySelectorAll('.tab').forEach(btn => {
        if (btn.id === `btn-tab-${tabId}`) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });
    const slug = TAB_SLUGS[tabId];
    if (tabFromHash() !== tabId) {
        if (slug) location.hash = slug;
        else history.pushState(null, '', location.pathname + location.search);
    }
    if (wasHidden) window.scrollTo({ top: 0 });
    refreshIcons();
}
window.addEventListener('hashchange', () => switchTab(tabFromHash()));
window.addEventListener('popstate', () => switchTab(tabFromHash()));

function updateAllViews({ skipDetail = false } = {}) {
    populateSelects();
    renderDashboard();
    renderProjects();
    renderClients();
    renderSessions();
    renderPlanning();
    renderStats();
    if (!skipDetail) refreshProjectDetailIfOpen();
    refreshIcons();
}

function projectOptionsHtml() {
    return sortedProjects().map(p => {
        const label = `${p.name} (${clientName(getClient(p.clientId))})${p.status === 'Terminé' ? ' — terminé' : ''}`;
        return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    }).join('');
}

function populateSelects() {
    const options = projectOptionsHtml();
    ['timer-project-select', 'quick-project-select', 'manual-project-id'].forEach(selId => {
        const el = document.getElementById(selId);
        if (!el) return;
        const currentVal = el.value;
        el.innerHTML = '<option value="">-- Sélectionner un projet --</option>' + options;
        el.value = getProject(currentVal) ? currentVal : '';
    });

    const filterSel = document.getElementById('sessions-filter-project');
    const fVal = filterSel.value;
    filterSel.innerHTML = '<option value="">Tous les projets</option>' + options;
    filterSel.value = getProject(fVal) ? fVal : '';

    const notesSel = document.getElementById('notes-target');
    notesSel.innerHTML = '<option value="general">Notes générales</option>' + sortedProjects().map(p =>
        `<option value="${escapeHtml(p.id)}">Projet · ${escapeHtml(p.name)} — ${escapeHtml(clientName(getClient(p.clientId)))}</option>`).join('');
    if (currentNotesTarget !== 'general' && !getProject(currentNotesTarget)) switchNotesTarget('general', { silent: true });
    notesSel.value = currentNotesTarget;

    const clientSelect = document.getElementById('project-client-id');
    const currentClientVal = clientSelect.value;
    clientSelect.innerHTML = '<option value="">-- Sélectionner un client --</option>' +
        [...appData.clients].sort((a, b) => clientName(a).localeCompare(clientName(b), 'fr')).map(c =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(clientName(c))}${c.company ? ' (' + escapeHtml(c.company) + ')' : ''}</option>`
        ).join('');
    clientSelect.value = currentClientVal;

    const timerSel = document.getElementById('timer-project-select');
    if (timerState.projectId && getProject(timerState.projectId)) timerSel.value = timerState.projectId;
}

/* ---------------------------------------------------------------------
   CALCULS PROJETS (tri, deadlines, budgets, étapes)
   --------------------------------------------------------------------- */
function projectCreatedAt(p) {
    if (p.createdAt) return p.createdAt;
    const m = /^p_(\d{12,})$/.exec(p.id || '');
    return m ? new Date(Number(m[1])).toISOString() : '';
}

function projectLastActivity(p) {
    const dates = projectSessions(p.id).map(s => s.date || '');
    return [projectCreatedAt(p).slice(0, 10), (p.statusChangedAt || '').slice(0, 10), ...dates].sort().pop() || '';
}

function sortedProjects() {
    const order = { 'En cours': 0, 'Devis envoyé': 1, 'En pause': 2, 'Terminé': 3 };
    return [...appData.projects].sort((a, b) =>
        (order[a.status] ?? 4) - (order[b.status] ?? 4) || projectLastActivity(b).localeCompare(projectLastActivity(a)));
}

function sortedSessions(list) {
    return [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)));
}

function budgetPct(p) {
    if (!p.hasBudget || !p.hourBudget) return null;
    return Math.round((projectSecs(p.id) / 3600 / p.hourBudget) * 100);
}

function stepsProgress(p) {
    const total = p.steps.length;
    const done = p.steps.filter(s => s.done).length;
    return { total, done };
}

function lateSteps(p) {
    const today = todayLocal();
    return p.status === 'Terminé' ? [] : p.steps.filter(s => !s.done && s.date && s.date < today);
}

function nextStep(p) { return p.steps.find(s => !s.done); }

function deadlineInfo(p) {
    if (!p.deadline) return null;
    const days = daysBetween(todayLocal(), p.deadline);
    let level = 'normal';
    let txt = `Deadline : ${formatDateFr(p.deadline)}`;
    if (p.status !== 'Terminé') {
        if (days < 0) { level = 'late'; txt += ` (dépassée de ${-days} j)`; }
        else if (days === 0) { level = 'late'; txt += ' (aujourd\'hui !)'; }
        else if (days <= 7) { level = 'soon'; txt += ` (dans ${days} j)`; }
        else txt += ` (dans ${days} j)`;
    }
    return { days, level, txt };
}

function deadlineBadge(p) {
    const info = deadlineInfo(p);
    if (!info) return '';
    const cls = info.level === 'late' ? 'tag-late' : info.level === 'soon' ? 'tag-soon' : 'muted';
    return `<span class="tag ${cls}"><i data-lucide="calendar-clock" class="w-4 h-4" aria-hidden="true"></i> ${escapeHtml(info.txt)}</span>`;
}

const STATUS_CLASS = { 'Devis envoyé': 'st-devis', 'En cours': 'st-cours', 'En pause': 'st-pause', 'Terminé': 'st-fini' };
function statusBadge(status) {
    return `<span class="st ${STATUS_CLASS[status] || 'st-pause'}">${escapeHtml(status)}</span>`;
}

/* ---------------------------------------------------------------------
   TABLEAU DE BORD
   --------------------------------------------------------------------- */
function monthSecs(key) {
    return appData.sessions.filter(s => (s.date || '').startsWith(key) && getProject(s.projectId)).reduce((a, s) => a + (Number(s.durationSeconds) || 0), 0);
}

// Durée courte pour la colonne « quand » : −2 j, Auj., 6 j
function daysTag(days) { return days === 0 ? 'Auj.' : days < 0 ? `−${-days} j` : `${days} j`; }

function computeAlerts() {
    const alerts = [];
    const today = todayLocal();

    if (timerState.startedAt && timerElapsed() > FORGOTTEN_TIMER_SECS) {
        alerts.push({ level: 'late', when: '4 h+', title: 'Chrono oublié ?', sub: `Il tourne depuis ${formatHours(timerElapsed())}`, act: 'switchTab', arg: 'timer' });
    }

    appData.projects.forEach(p => {
        if (p.status === 'Terminé') return;
        const info = deadlineInfo(p);
        if (info && info.level !== 'normal') {
            alerts.push({ level: info.level, kind: 'deadline', pid: p.id, when: daysTag(info.days), title: info.days < 0 ? 'Deadline dépassée' : info.days === 0 ? 'Deadline aujourd’hui' : 'Deadline proche', sub: `${p.name} · ${formatDateShort(p.deadline)}`, act: 'openProjectDetailModal', id: p.id, sort: info.days });
        }
        const pct = budgetPct(p);
        if (pct !== null && pct >= 80) {
            alerts.push({ level: pct > 100 ? 'late' : 'soon', when: `${pct} %`, title: pct > 100 ? 'Budget d’heures dépassé' : 'Budget d’heures presque atteint', sub: p.name, act: 'openProjectDetailModal', id: p.id, sort: 100 - pct });
        }
        const late = lateSteps(p);
        if (late.length) {
            alerts.push({ level: 'soon', when: daysTag(daysBetween(today, late[0].date)), title: late.length > 1 ? `${late.length} étapes en retard` : 'Étape en retard', sub: `${p.name} · « ${late[0].label} »`, act: 'openProjectDetailModal', id: p.id, sort: 5 });
        }
        if (p.status === 'Devis envoyé') {
            const since = (p.statusChangedAt || projectCreatedAt(p) || '').slice(0, 10);
            const n = since ? daysBetween(since, today) : 0;
            if (since && n >= QUOTE_FOLLOWUP_DAYS) {
                alerts.push({ level: 'info', when: 'Auj.', title: 'Relancer le devis', sub: `${p.name} · envoyé il y a ${n} j`, act: 'openProjectDetailModal', id: p.id, sort: 50 });
            }
        }
    });
    const rank = { late: 0, soon: 1, info: 2 };
    return alerts.sort((a, b) => rank[a.level] - rank[b.level] || (a.sort ?? 0) - (b.sort ?? 0));
}

function actionAttrs(o) {
    return `data-action="${escapeHtml(o.act)}"${o.id !== undefined ? ` data-id="${escapeHtml(o.id)}"` : ''}${o.arg !== undefined ? ` data-arg="${escapeHtml(o.arg)}"` : ''}`;
}

function alertRowHtml(a) {
    return `
        <button type="button" class="row" ${actionAttrs(a)}>
            <span class="when ${a.level === 'late' ? 'late' : ''}">${escapeHtml(a.when)}</span>
            <span class="what"><b>${escapeHtml(a.title)}</b><span>${escapeHtml(a.sub)}</span></span>
        </button>`;
}

function renderDashboard() {
    let totalSecs = 0;
    let totalValue = 0;
    appData.sessions.forEach(s => {
        const p = getProject(s.projectId);
        if (!p) return;
        const secs = Number(s.durationSeconds) || 0;
        totalSecs += secs;
        totalValue += (secs / 3600) * (Number(p.hourlyRate) || 0);
    });
    // Totaux « depuis le début » : affichés dans Stats
    document.getElementById('dash-total-hours').innerText = formatHours(totalSecs);
    document.getElementById('dash-total-revenue').innerText = formatEuro(totalValue);

    // Le mois en cours
    const thisMonth = todayLocal().slice(0, 7);
    const mSecs = monthSecs(thisMonth);
    const monthName = new Date().toLocaleDateString('fr-FR', { month: 'long' });
    document.getElementById('dash-month-title').innerText = monthName;
    document.getElementById('dash-month-hours').innerText = formatHours(mSecs);
    const goal = Number(appData.settings.monthlyGoalHours) || 0;
    const pct = goal ? Math.round((mSecs / 3600 / goal) * 100) : 0;
    document.getElementById('dash-month-goal-label').innerText = goal ? `objectif ${goal} h` : '';
    document.getElementById('dash-month-pct').innerText = goal ? `soit ${pct} %` : '';
    const on = Math.min(20, Math.floor(pct / 5));
    document.getElementById('dash-month-goal').innerHTML = goal ? `
        <div class="ruler ${pct > 100 ? 'over' : ''}" role="img" aria-label="${pct} % de l'objectif de ${goal} heures">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>
        <div class="ruler-scale" aria-hidden="true"><span>0 h</span><span>${Math.round(goal / 2)} h</span><span>${goal} h</span></div>`
        : `<button type="button" data-action="switchTab" data-arg="stats" class="link">Fixer un objectif mensuel</button>`;
    document.getElementById('dash-active-projects').innerText = appData.projects.filter(p => p.status === 'En cours').length;
    document.getElementById('dash-total-clients').innerText = appData.clients.length;

    // À surveiller : alertes + échéances des 14 prochains jours, dans un seul bloc
    const alerts = computeAlerts();
    const today = todayLocal();
    const limit = addDaysIso(today, 14);
    const flagged = new Set(alerts.filter(a => a.kind === 'deadline').map(a => a.pid));
    const upcoming = allEvents().filter(e => !e.done && e.date >= today && e.date <= limit && e.project.status !== 'Terminé'
        && !(e.kind === 'deadline' && flagged.has(e.project.id))).slice(0, 6);
    document.getElementById('dash-alert-count').innerText = alerts.length || '';
    document.getElementById('dash-alerts').innerHTML =
        (alerts.length ? alerts.map(alertRowHtml).join('') : '<p class="empty"><strong>Rien à signaler.</strong>Pas de retard, pas de devis à relancer.</p>') +
        (upcoming.length ? '<div class="row-sub">À venir</div>' + upcoming.map(e => alertRowHtml({
            level: 'info', when: daysTag(daysBetween(today, e.date)),
            title: e.kind === 'deadline' ? 'Deadline' : e.label,
            sub: `${e.project.name} · ${formatDateShort(e.date)}`, act: 'openProjectDetailModal', id: e.project.id
        })).join('') : '');

    // Projets récents
    const dashList = document.getElementById('dash-projects-list');
    if (appData.projects.length === 0) {
        dashList.innerHTML = `<div class="empty grid gap-3"><p class="m-0"><strong>Aucun projet pour l’instant.</strong>Créez d’abord un client, puis son projet.</p>
            <div class="flex flex-wrap gap-2"><button type="button" data-action="openClientModal" class="btn btn-sm">Nouveau client</button><button type="button" data-action="openProjectModal" class="btn btn-sm btn-primary">Nouveau projet</button></div></div>`;
    } else {
        dashList.innerHTML = [...appData.projects]
            .sort((a, b) => projectLastActivity(b).localeCompare(projectLastActivity(a)))
            .slice(0, 4).map(p => {
                const { total, done } = stepsProgress(p);
                const ns = nextStep(p);
                const sub = [clientName(getClient(p.clientId)), total ? `${done}/${total} étapes${ns ? ` · prochaine : ${ns.label}` : ''}` : ''].filter(Boolean).join(' · ');
                return `
                <button type="button" class="row row-nowhen" data-action="openProjectDetailModal" data-id="${escapeHtml(p.id)}">
                    <span class="what"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(sub)}</span></span>
                    <span class="row-end flex items-center gap-4">${statusBadge(p.status)}<span class="hrs">${formatHours(projectSecs(p.id))}</span></span>
                </button>`;
            }).join('');
    }
    refreshTimerDisplay();
}

/* ---------------------------------------------------------------------
   PLANNING
   --------------------------------------------------------------------- */
function allEvents() {
    const events = [];
    appData.projects.forEach(p => {
        if (p.deadline) events.push({ uid: `dl-${p.id}`, kind: 'deadline', date: p.deadline, label: 'Deadline', project: p, done: p.status === 'Terminé' });
        p.steps.forEach(s => {
            if (s.date) events.push({ uid: `st-${p.id}-${s.id}`, kind: 'step', date: s.date, label: s.label, project: p, done: !!s.done });
        });
    });
    return events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'deadline' ? -1 : 1));
}

function eventLineHtml(e) {
    const today = todayLocal();
    const days = daysBetween(today, e.date);
    return alertRowHtml({
        level: !e.done && days < 0 ? 'late' : 'info', when: daysTag(days),
        title: e.kind === 'deadline' ? 'Deadline' : e.label,
        sub: `${e.project.name} · ${formatDateShort(e.date)}`, act: 'openProjectDetailModal', id: e.project.id
    });
}

function changeCalendarMonth(delta) {
    delta = Number(delta) || 0;
    calCursor = delta === 0 ? firstOfMonth(new Date()) : new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
    renderPlanning();
    refreshIcons();
}

function renderPlanning() {
    const grid = document.getElementById('calendar-grid');
    if (!grid) return;
    document.getElementById('cal-title').innerText = calCursor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    const events = allEvents();
    const byDate = {};
    events.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

    const start = new Date(calCursor);
    const offset = (start.getDay() + 6) % 7; // lundi = 0
    start.setDate(start.getDate() - offset);
    const today = todayLocal();
    const month = calCursor.getMonth();

    let html = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(d => `<div class="cal-dow">${d}</div>`).join('');
    const cur = new Date(start);
    for (let i = 0; i < 42; i++) {
        const iso = isoLocal(cur);
        const inMonth = cur.getMonth() === month;
        if (i >= 35 && !inMonth) break;
        const evs = byDate[iso] || [];
        const chips = evs.slice(0, 3).map(e => {
            const cls = e.kind === 'deadline' ? 'dl' : e.done ? 'done' : 'step';
            const label = e.kind === 'deadline' ? `Deadline · ${e.project.name}` : `${e.label} · ${e.project.name}`;
            return `<button type="button" data-action="openProjectDetailModal" data-id="${escapeHtml(e.project.id)}" title="${escapeHtml(label)}" class="cal-ev ${cls}">${escapeHtml(label)}</button>`;
        }).join('');
        const more = evs.length > 3 ? `<span class="text-[11px] font-semibold">+${evs.length - 3}</span>` : '';
        html += `
            <div class="cal-day ${inMonth ? '' : 'out'} ${iso === today ? 'today' : ''}"${iso === today ? ' aria-current="date"' : ''}>
                <span class="cal-num">${cur.getDate()}</span>
                ${chips}${more}
            </div>`;
        cur.setDate(cur.getDate() + 1);
    }
    grid.innerHTML = html;

    const limit = addDaysIso(today, 30);
    const upcoming = events.filter(e => !e.done && e.date >= today && e.date <= limit);
    const late = events.filter(e => !e.done && e.date < today && e.project.status !== 'Terminé');
    document.getElementById('planning-upcoming').innerHTML =
        (late.length ? `<div class="row-sub border-t-0">En retard</div>${late.map(eventLineHtml).join('')}<div class="row-sub">À venir</div>` : '') +
        (upcoming.length ? upcoming.map(eventLineHtml).join('') : '<p class="empty"><strong>Rien de prévu.</strong>Ajoutez des dates aux étapes depuis la fiche d’un projet.</p>');
}

/* ---------------------------------------------------------------------
   STATISTIQUES
   --------------------------------------------------------------------- */
function lastMonthKeys(n) {
    const keys = [];
    const d = firstOfMonth(new Date());
    for (let i = 0; i < n; i++) {
        keys.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        d.setMonth(d.getMonth() - 1);
    }
    return keys;
}

function sessionsForPeriod(period) {
    const valid = appData.sessions.filter(s => getProject(s.projectId));
    const keys = lastMonthKeys(12);
    const thisMonth = keys[11];
    const lastMonth = keys[10];
    switch (period) {
        case 'month': return valid.filter(s => (s.date || '').startsWith(thisMonth));
        case 'lastmonth': return valid.filter(s => (s.date || '').startsWith(lastMonth));
        case '12m': return valid.filter(s => (s.date || '') >= keys[0]);
        default: return valid;
    }
}

function saveMonthlyGoal(v) {
    const n = parseFloat(v);
    appData.settings.monthlyGoalHours = Number.isFinite(n) && n > 0 ? n : null;
    commitChange();
}

function renderStats() {
    const monthsEl = document.getElementById('stats-months');
    if (!monthsEl) return;
    const goal = Number(appData.settings.monthlyGoalHours) || 0;
    const goalInput = document.getElementById('goal-input');
    if (document.activeElement !== goalInput) goalInput.value = goal || '';

    // Barres mensuelles
    const keys = lastMonthKeys(12);
    const hours = keys.map(k => monthSecs(k) / 3600);
    const max = Math.max(goal, ...hours, 1);
    monthsEl.innerHTML = keys.map((k, i) => {
        const h = hours[i];
        const reached = goal && h >= goal;
        return `
            <div class="grid grid-cols-[64px_1fr_64px] items-center gap-3 text-sm" title="${escapeHtml(monthLabel(k))} : ${formatHours(h * 3600)}">
                <span class="font-semibold capitalize">${escapeHtml(monthLabel(k))}</span>
                <div class="bar h-[18px]">
                    <div class="fill ${reached ? '' : 'red'}" data-pct="${(h / max) * 100}"></div>
                    ${goal ? `<div class="bar-goal" data-left="${(goal / max) * 100}" title="Objectif ${goal} h"></div>` : ''}
                </div>
                <span class="num text-right text-[17px]">${formatHours(h * 3600)}</span>
            </div>`;
    }).join('') + (goal ? `<p class="hint m-0 pt-2">Trait noir : objectif de ${goal} h · barre verte : objectif atteint</p>` : `<p class="hint m-0 pt-2">Fixez un objectif mensuel en haut de la page pour le voir ici.</p>`);

    // Catégories
    const period = document.getElementById('stats-period').value;
    const list = sessionsForPeriod(period);
    const total = sumSecs(list);
    const cats = {};
    list.forEach(s => {
        const name = (s.category || 'Sans catégorie').trim();
        const key = name.toLowerCase();
        cats[key] = cats[key] || { name, secs: 0 };
        cats[key].secs += Number(s.durationSeconds) || 0;
    });
    const catList = Object.values(cats).sort((a, b) => b.secs - a.secs);
    const palette = ['#CC0C33', '#02968A', '#D1A802', '#1B1A18', '#8C6A43', '#5B7DB1', '#B5487A'];
    document.getElementById('stats-categories').innerHTML = catList.length ? catList.map((c, i) => {
        const pct = total ? Math.round((c.secs / total) * 100) : 0;
        return `
            <div class="grid gap-1">
                <div class="flex justify-between gap-3 text-sm font-semibold"><span>${escapeHtml(c.name)}</span><span class="whitespace-nowrap">${formatHours(c.secs)} · ${pct} %</span></div>
                <div class="bar"><div class="fill" data-pct="${pct}" data-bg="${palette[i % palette.length]}"></div></div>
            </div>`;
    }).join('') + `<p class="m-0 pt-2 font-semibold">Total : <span class="num text-[18px]">${formatHours(total)}</span></p>`
        : '<p class="empty p-0">Aucune session sur cette période.</p>';

    // Forfaits : taux réel
    const forfaits = appData.projects.filter(p => Number(p.price) > 0);
    document.getElementById('stats-forfaits').innerHTML = forfaits.length ? `
        <table class="table">
            <thead><tr><th>Projet</th><th>Temps</th><th>Forfait</th><th>Taux réel</th><th>Visé</th></tr></thead>
            ${forfaits.map(p => {
                const h = projectSecs(p.id) / 3600;
                const real = h > 0 ? p.price / h : null;
                const target = Number(p.hourlyRate) || 0;
                const cls = real === null ? '' : real >= target ? 'text-[#01675F]' : 'text-[#8E0824]';
                return `<tr>
                    <td><button type="button" class="link text-left" data-action="openProjectDetailModal" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button></td>
                    <td class="whitespace-nowrap">${formatHours(h * 3600)}</td>
                    <td class="whitespace-nowrap">${formatEuroRound(p.price)}</td>
                    <td class="whitespace-nowrap font-bold ${cls}">${real === null ? '—' : formatEuroRound(real) + '/h'}${real === null ? '' : real >= target ? ' ✓' : ' ↓'}</td>
                    <td class="whitespace-nowrap">${target ? formatEuroRound(target) + '/h' : '—'}</td>
                </tr>`;
            }).join('')}
        </table>`
        : '<p class="empty p-0">Aucun projet avec un prix de forfait pour l’instant.</p>';
}

/* ---------------------------------------------------------------------
   CHRONO
   --------------------------------------------------------------------- */
function loadTimerState() {
    const s = safeParse(lsGet(LS.timer), null) || {};
    return {
        projectId: s.projectId || '',
        category: s.category || 'Production',
        notes: s.notes || '',
        startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
        accumulated: Number(s.accumulated) || 0,
        sessionDate: s.sessionDate || ''
    };
}
function saveTimerState() { lsSet(LS.timer, JSON.stringify(timerState)); }

function timerElapsed() {
    const running = timerState.startedAt ? Math.max(0, Math.floor((Date.now() - timerState.startedAt) / 1000)) : 0;
    return timerState.accumulated + running;
}

function restoreTimerUI() {
    document.getElementById('timer-category').value = timerState.category;
    document.getElementById('timer-notes').value = timerState.notes;
    if (timerState.projectId && getProject(timerState.projectId)) document.getElementById('timer-project-select').value = timerState.projectId;
    refreshTimerDisplay();
}

function onTimerFieldChange() {
    timerState.projectId = document.getElementById('timer-project-select').value;
    timerState.category = document.getElementById('timer-category').value;
    timerState.notes = document.getElementById('timer-notes').value;
    saveTimerState();
}

function refreshTimerDisplay() {
    const total = timerElapsed();
    const hrs = Math.floor(total / 3600).toString().padStart(2, '0');
    const mins = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
    const secs = (total % 60).toString().padStart(2, '0');
    const txt = `${hrs}:${mins}:${secs}`;
    document.getElementById('timer-display').innerText = txt;

    const running = !!timerState.startedAt;
    const started = total > 0 || running;
    document.getElementById('btn-start-timer').disabled = running;
    document.getElementById('btn-start-timer').innerText = (!running && started) ? 'Reprendre' : 'Lancer';
    document.getElementById('btn-pause-timer').disabled = !running;
    document.getElementById('btn-stop-timer').disabled = !started;
    document.getElementById('btn-reset-timer').disabled = !started;
    document.getElementById('timer-project-select').disabled = started;
    document.getElementById('timer-forgot-banner').classList.toggle('hidden', !(running && total > FORGOTTEN_TIMER_SECS));

    // Pastille de l'en-tête (h:mm, la mire tourne tant que le chrono tourne)
    const chip = document.getElementById('header-timer-chip');
    chip.classList.toggle('hidden', !started);
    chip.classList.toggle('is-running', running);
    chip.classList.toggle('is-paused', started && !running);
    document.getElementById('header-timer-text').innerText = `${Math.floor(total / 3600)}:${mins}${running ? '' : ' · pause'}`;

    // Bloc chrono du tableau de bord
    document.getElementById('dash-chrono-running').classList.toggle('hidden', !started);
    document.getElementById('dash-chrono-idle').classList.toggle('hidden', started);
    if (started) {
        const p = getProject(timerState.projectId);
        const c = p ? getClient(p.clientId) : null;
        document.getElementById('dash-timer-display').innerText = txt;
        document.getElementById('dash-timer-project').innerText = p ? p.name : 'Projet supprimé';
        document.getElementById('dash-timer-client').innerText = p ? [clientName(c), c && c.company, typeLabel(p.type)].filter(Boolean).join(' · ') : '';
        const pause = document.getElementById('dash-btn-pause');
        pause.querySelector('span').innerText = running ? 'Pause' : 'Reprendre';
        const slug = [
            running ? `Démarré à ${new Date(timerState.startedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'En pause',
            timerState.category || 'Production',
            timerState.notes
        ].filter(Boolean);
        const slugEl = document.getElementById('dash-timer-slug');
        const slugHtml = slug.map(t => `<span>${escapeHtml(t)}</span>`).join('');
        if (slugEl.innerHTML !== slugHtml) slugEl.innerHTML = slugHtml;
    }

    document.title = running ? `${txt} — Phant Studio` : 'Phant Studio — Suivi & Gestion Projets';
}

function toggleTimerPause() { if (timerState.startedAt) pauseTimer(); else startTimer(); }

function startTimer() {
    const projId = document.getElementById('timer-project-select').value;
    if (!projId) { alert('Veuillez sélectionner un projet.'); return; }
    if (timerState.startedAt) return;
    onTimerFieldChange();
    if (!timerState.sessionDate) timerState.sessionDate = todayLocal();
    timerState.startedAt = Date.now();
    saveTimerState();
    refreshTimerDisplay();
    if (currentNotesTarget !== projId) switchNotesTarget(projId);
}

function pauseTimer() {
    if (!timerState.startedAt) return;
    timerState.accumulated = timerElapsed();
    timerState.startedAt = null;
    saveTimerState();
    refreshTimerDisplay();
}

function fixForgottenTimer() {
    const answer = prompt('Combien d\'heures avez-vous réellement travaillé sur cette session ? (ex : 2.5)');
    if (answer === null) return;
    const h = parseFloat(String(answer).replace(',', '.'));
    if (!Number.isFinite(h) || h < 0) { alert('Nombre invalide.'); return; }
    timerState.accumulated = Math.round(h * 3600);
    timerState.startedAt = null;
    saveTimerState();
    refreshTimerDisplay();
    renderDashboard();
}

function stopTimer() {
    const secs = timerElapsed();
    if (secs <= 0) return;
    const projId = timerState.projectId || document.getElementById('timer-project-select').value;
    if (!getProject(projId)) {
        alert('Le projet de ce chrono n\'existe plus. Choisissez-en un autre.');
        document.getElementById('timer-project-select').disabled = false;
        return;
    }
    if (secs < 60 && !confirm('Cette session dure moins d\'une minute. L\'enregistrer quand même ?')) return;

    appData.sessions.unshift({
        id: uid('s_'),
        projectId: projId,
        date: timerState.sessionDate || todayLocal(),
        durationSeconds: secs,
        category: document.getElementById('timer-category').value.trim() || 'Production',
        notes: document.getElementById('timer-notes').value.trim()
    });
    commitChange();
    resetTimerState();
    openSessionsModal();
}

function discardTimer() {
    if (!confirm('Supprimer ce chrono sans l\'enregistrer ?')) return;
    resetTimerState();
}

function resetTimerState() {
    timerState = { projectId: timerState.projectId, category: 'Production', notes: '', startedAt: null, accumulated: 0, sessionDate: '' };
    saveTimerState();
    document.getElementById('timer-category').value = 'Production';
    document.getElementById('timer-notes').value = '';
    refreshTimerDisplay();
    renderDashboard();
}

function quickStartTimer() {
    const projId = document.getElementById('quick-project-select').value;
    if (timerElapsed() > 0) { alert('Un chrono est déjà en cours : enregistrez-le ou annulez-le avant d\'en lancer un autre.'); return; }
    if (!projId) { alert('Choisissez d\'abord un projet dans la liste.'); return; }
    document.getElementById('timer-project-select').value = projId;
    startTimer();
}

/* ---------------------------------------------------------------------
   CARNETS DE NOTES (général + un par projet)
   --------------------------------------------------------------------- */
function getNotesFor(target) {
    if (target === 'general') return appData.notes || '';
    const p = getProject(target);
    return p ? (p.notes || '') : '';
}

function setNotesFor(target, html) {
    if (target === 'general') appData.notes = html;
    else { const p = getProject(target); if (p) p.notes = html; }
}

function switchNotesTarget(target, { silent = false } = {}) {
    if (target !== 'general' && !getProject(target)) target = 'general';
    currentNotesTarget = target;
    lsSet(LS.notesTarget, target);
    const sel = document.getElementById('notes-target');
    if (sel) sel.value = target;
    const editor = document.getElementById('rich-text-editor');
    if (editor && !(silent && document.activeElement === editor)) editor.innerHTML = getNotesFor(target);
    document.getElementById('notes-open-project').classList.toggle('hidden', target === 'general');
    const status = document.getElementById('notes-save-status');
    if (status && !silent) status.innerText = target === 'general' ? 'Carnet général · enregistrement automatique' : 'Carnet du projet · enregistrement automatique';
}

function openNotesForProject(pid) {
    closeModal('project-detail-modal');
    switchTab('timer');
    switchNotesTarget(pid);
    document.getElementById('rich-text-editor').focus();
}

function setupEditor() {
    const editor = document.getElementById('rich-text-editor');
    editor.addEventListener('input', onNotesChanged);
    editor.addEventListener('paste', (e) => {
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
            e.preventDefault();
            alert('Les images ne peuvent pas être collées dans les notes (trop lourdes). Utilisez plutôt un lien dans la fiche projet.');
        }
    });
}

function onNotesChanged() {
    const editor = document.getElementById('rich-text-editor');
    setNotesFor(currentNotesTarget, editor.innerText.trim() ? editor.innerHTML : '');
    const status = document.getElementById('notes-save-status');
    if (status) status.innerText = 'Enregistré ✓ ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    commitChange({ rerender: false, delay: 3000 });
}

function formatText(command, value = null) {
    document.getElementById('rich-text-editor').focus();
    document.execCommand(command, false, value);
    onNotesChanged();
}

function clearNotes() {
    if (!confirm('Effacer tout le contenu de ce carnet ?')) return;
    document.getElementById('rich-text-editor').innerHTML = '';
    onNotesChanged();
}

function appendToEditor(html) {
    const editor = document.getElementById('rich-text-editor');
    editor.innerHTML += html;
    onNotesChanged();
}

const QUESTIONNAIRES = {
    mariage: `<h2>QUESTIONNAIRE MARIAGE — BRIEF CRÉATIF</h2><h3>1. La Vision & L'Univers du Mariage</h3><p><strong>Date et lieu :</strong> </p><p><strong>Thème ou ambiance (3 mots) :</strong> </p><p><strong>Palette de couleurs :</strong> </p><p><strong>Histoire du couple :</strong> </p><p><strong>Inspirations / Pinterest :</strong> </p><h3>2. Les Besoins en Papeterie</h3><p><strong>Avant le jour J :</strong> Save the date, Faire-part, RSVP...</p><p><strong>Le jour J :</strong> Livrets, plan de table, menus, signalétique...</p><p><strong>Après le jour J :</strong> Remerciements.</p><h3>3. Aspects Techniques & Logistiques</h3><p><strong>Quantités (foyers) & Marge :</strong> </p><p><strong>Textes & Bilinguisme :</strong> </p><p><strong>Formats, Papiers & Finitions :</strong> </p><h3>4. Calendrier & Budget</h3><p><strong>Planning d'envoi :</strong> </p><p><strong>Budget global :</strong> </p>`,
    affiches: `<h2>BRIEF CRÉATIF — AFFICHE & ÉVÉNEMENTIEL</h2><h3>1. Objectif & Message Clé</h3><p><strong>Nom de l'événement / Produit :</strong> </p><p><strong>Message principal :</strong> </p><p><strong>Call To Action & Infos (Site, QR Code, Date, Lieu) :</strong> </p><h3>2. Ambiance & Direction Artistique</h3><p><strong>Style souhaité (Illustré, Photo, Typo, 2D/3D) :</strong> </p><p><strong>Palette de couleurs & Ton :</strong> </p><p><strong>Sponsors / Logos obligatoires :</strong> </p><h3>3. Formats & Technique</h3><p><strong>Dimensions Print (A3, A0, Abribus...) :</strong> </p><p><strong>Déclinaisons web (Post Insta, Story, Bannières) :</strong> </p><p><strong>Spécifications Imprimeur :</strong> </p><h3>4. Calendrier</h3><p><strong>Date validation BAT :</strong> </p><p><strong>Lancement campagne :</strong> </p>`,
    logo: `<h2>BRIEF CRÉATIF — LOGO & IDENTITÉ VISUELLE</h2><h3>1. Entreprise & Valeurs</h3><p><strong>Nom & Activité :</strong> </p><p><strong>Cible / Audience :</strong> </p><p><strong>Valeurs (3 à 5 mots clés) :</strong> </p><h3>2. Orientations Graphiques</h3><p><strong>Style visuel (Minimaliste, Illustré, Emblème...) :</strong> </p><p><strong>Préférences couleurs & typographies :</strong> </p><p><strong>Concurrence & Inspirations :</strong> </p><h3>3. Livrables & Supports</h3><p><strong>Déclinaisons logo (Principal, Secondaire, Picto) :</strong> </p><p><strong>Charte Graphique / Guide d'usage :</strong> </p><p><strong>Supports de communication prévus :</strong> </p><h3>4. Planning & Droits</h3><p><strong>Deadline de livraison :</strong> </p><p><strong>Périmètre des droits d'auteur :</strong> </p>`
};

function loadQuestionnaire(type) { if (QUESTIONNAIRES[type]) appendToEditor(QUESTIONNAIRES[type]); }

/* ---------------------------------------------------------------------
   DÉCOMPILATEUR IA
   --------------------------------------------------------------------- */
function openDecompilerModal() {
    document.getElementById('decompiler-no-key').classList.toggle('hidden', !!lsGet(LS.geminiKey));
    openModal('decompiler-modal');
}

function setupDropZone() {
    const dropZone = document.getElementById('drop-zone');
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('bg-[#CEB694]/40'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('bg-[#CEB694]/40'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('bg-[#CEB694]/40');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
    });
}

function handleFileSelect(e) { if (e.target.files && e.target.files[0]) processFile(e.target.files[0]); e.target.value = ''; }

function processFile(file) {
    if (!file.type.startsWith('image/')) { alert('Merci de choisir une image (PNG, JPG...).'); return; }
    const reader = new FileReader();
    reader.onload = function (ev) {
        currentImageMime = file.type || 'image/png';
        currentBase64Image = ev.target.result.split(',')[1];
        document.getElementById('image-preview').src = ev.target.result;
        document.getElementById('image-preview-container').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

const AI_PROMPT = `Tu es l'assistant de PhantStudio (studio de création graphique : illustration, papeterie mariage, faire-parts, logos, affiches).
Analyse cette capture d'écran de conversation ou note client et réponds UNIQUEMENT avec un objet JSON (sans texte autour) de cette forme :
{
  "client": { "prenom": "", "nom": "", "entreprise": "", "email": "", "telephone": "", "adresse": "" },
  "projet": { "nom": "nom court du projet", "type": "mariage | logo | affiche | illustration | autre", "description": "une phrase", "deadline": "AAAA-MM-JJ ou vide" },
  "besoins": ["quantités, formats, finitions, couleurs, ambiance..."],
  "dates": ["toutes les dates mentionnées, avec leur signification"],
  "budget": "budget mentionné ou vide",
  "actions": ["liste d'actions concrètes à faire"],
  "resume": "résumé en 2 ou 3 phrases"
}
Laisse vide ("") ce qui n'est pas visible. N'invente rien. Nous sommes le ${new Date().toLocaleDateString('fr-FR')}.`;

function parseAiJson(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const obj = safeParse(cleaned, null);
    return obj && typeof obj === 'object' ? obj : null;
}

function analysisToText(a) {
    const c = a.client || {}, p = a.projet || {};
    const list = arr => (Array.isArray(arr) && arr.length ? arr.map(x => `• ${x}`).join('\n') : '—');
    return [
        `CLIENT : ${[c.prenom, c.nom].filter(Boolean).join(' ') || '—'}${c.entreprise ? ' (' + c.entreprise + ')' : ''}`,
        c.email ? `Email : ${c.email}` : '', c.telephone ? `Tél : ${c.telephone}` : '', c.adresse ? `Adresse : ${c.adresse}` : '',
        '', `PROJET : ${p.nom || '—'} — ${typeLabel(p.type)}`, p.description || '',
        p.deadline ? `Deadline : ${formatDateFr(p.deadline)}` : '',
        '', 'BESOINS :', list(a.besoins),
        '', 'DATES :', list(a.dates),
        a.budget ? `\nBUDGET : ${a.budget}` : '',
        '', 'ACTIONS :', list(a.actions),
        '', `RÉSUMÉ : ${a.resume || '—'}`
    ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').trim();
}

function analysisToHtml(a) {
    const ul = arr => Array.isArray(arr) && arr.length ? `<ul>${arr.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<p>—</p>';
    return `<h2>BRIEF DÉCOMPILÉ PAR L'IA — ${escapeHtml(formatDateFr(todayLocal()))}</h2>
        <p><strong>Résumé :</strong> ${escapeHtml(a.resume || '—')}</p>
        <h3>Besoins</h3>${ul(a.besoins)}
        <h3>Dates mentionnées</h3>${ul(a.dates)}
        ${a.budget ? `<p><strong>Budget évoqué :</strong> ${escapeHtml(a.budget)}</p>` : ''}
        <h3>Actions à faire</h3>${ul(a.actions)}`;
}

async function analyzeImageWithGemini() {
    if (!currentBase64Image) return;
    const apiKey = lsGet(LS.geminiKey);
    if (!apiKey) { document.getElementById('decompiler-no-key').classList.remove('hidden'); return; }
    const model = lsGet(LS.geminiModel) || DEFAULT_GEMINI_MODEL;

    const output = document.getElementById('analysis-text-output');
    const btn = document.getElementById('btn-analyze');
    document.getElementById('analysis-loading').classList.remove('hidden');
    document.getElementById('analysis-result-container').classList.add('hidden');
    btn.disabled = true;
    lastAnalysis = null;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: AI_PROMPT }, { inlineData: { mimeType: currentImageMime, data: currentBase64Image } }] }],
                generationConfig: { responseMimeType: 'application/json' }
            })
        });
        const result = await response.json();
        if (!response.ok) {
            const msg = result?.error?.message || `Erreur ${response.status}`;
            output.innerText = `L'IA a renvoyé une erreur :\n${msg}\n\nVérifiez la clé et le nom du modèle dans « Réglages & Sync ».`;
        } else {
            const raw = (result?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
            const structured = parseAiJson(raw);
            lastAnalysis = { structured, text: structured ? analysisToText(structured) : (raw || 'Aucun texte renvoyé par l\'IA.') };
            output.innerText = lastAnalysis.text;
        }
    } catch (err) {
        output.innerText = 'Impossible de joindre l\'IA (connexion Internet ?).';
    } finally {
        document.getElementById('analysis-loading').classList.add('hidden');
        document.getElementById('analysis-result-container').classList.remove('hidden');
        document.getElementById('btn-ai-create').disabled = !(lastAnalysis && lastAnalysis.structured);
        btn.disabled = false;
    }
}

function copyAnalysisToEditor() {
    if (!lastAnalysis) return;
    appendToEditor(lastAnalysis.structured ? analysisToHtml(lastAnalysis.structured)
        : `<h2>DÉCOMPILATION IA — CONVERSATION CLIENT</h2><pre>${escapeHtml(lastAnalysis.text)}</pre>`);
    closeModal('decompiler-modal');
    switchTab('timer');
}

function findExistingClient(c) {
    const email = (c.email || '').trim().toLowerCase();
    const full = `${c.prenom || ''} ${c.nom || ''}`.trim().toLowerCase();
    return appData.clients.find(x =>
        (email && (x.email || '').toLowerCase() === email) ||
        (full && clientName(x).toLowerCase() === full));
}

function createFromAnalysis() {
    if (!lastAnalysis || !lastAnalysis.structured) return;
    const a = lastAnalysis.structured;
    const c = a.client || {};
    closeModal('decompiler-modal');
    aiFlow = { analysis: a, clientId: null };

    const existing = findExistingClient(c);
    if (existing && confirm(`Le client « ${clientName(existing)} » existe déjà. L'utiliser pour ce nouveau projet ?`)) {
        aiFlow.clientId = existing.id;
        openProjectModalFromAI();
        return;
    }
    openClientModal(null, {
        firstname: c.prenom, lastname: c.nom, company: c.entreprise, email: c.email, phone: c.telephone, address: c.adresse
    });
    document.getElementById('client-ai-hint').classList.remove('hidden');
}

function openProjectModalFromAI() {
    const p = (aiFlow && aiFlow.analysis.projet) || {};
    openProjectModal(null);
    document.getElementById('project-name').value = p.nom || '';
    document.getElementById('project-type').value = PROJECT_TYPES[p.type] ? p.type : 'autre';
    document.getElementById('project-description').value = p.description || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '')) document.getElementById('project-deadline').value = p.deadline;
    document.getElementById('project-client-id').value = aiFlow.clientId || '';
    document.getElementById('project-status').value = 'Devis envoyé';
    document.getElementById('project-ai-hint').classList.remove('hidden');
}

/* ---------------------------------------------------------------------
   HISTORIQUE DES SESSIONS
   --------------------------------------------------------------------- */
function openSessionsModal() { renderSessions(); openModal('sessions-modal'); }

function clearSessionFilters() {
    document.getElementById('sessions-filter-month').value = '';
    document.getElementById('sessions-filter-project').value = '';
    renderSessions();
}

function renderSessions() {
    const tbody = document.getElementById('sessions-table-body');
    const month = document.getElementById('sessions-filter-month').value;
    const proj = document.getElementById('sessions-filter-project').value;
    const list = sortedSessions(appData.sessions.filter(s =>
        (!month || (s.date || '').startsWith(month)) && (!proj || s.projectId === proj)));

    document.getElementById('sessions-total').innerText = list.length
        ? `${list.length} session(s) · ${formatHours(sumSecs(list))} au total` : '';

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">${appData.sessions.length ? 'Aucune session pour ces filtres.' : 'Aucune session enregistrée. Lancez le chrono ou ajoutez une session manuelle.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(s => {
        const p = getProject(s.projectId);
        return `
            <tr>
                <td class="whitespace-nowrap font-semibold">${escapeHtml(formatDateFr(s.date))}</td>
                <td class="t-num text-right sm:hidden">${formatHours(Number(s.durationSeconds) || 0)}</td>
                <td class="t-wide">${p ? `<button type="button" class="link text-left py-0" data-action="openProjectDetailModal" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>` : '<span class="err">Projet supprimé</span>'}</td>
                <td class="t-wide muted">${escapeHtml(s.category)}</td>
                <td class="t-num hidden sm:table-cell">${formatHours(Number(s.durationSeconds) || 0)}</td>
                <td class="t-wide">${escapeHtml(s.notes || '')}</td>
                <td class="t-actions text-right whitespace-nowrap">
                    <button type="button" data-action="editSession" data-id="${escapeHtml(s.id)}" class="link">Éditer</button>
                    <button type="button" data-action="deleteSession" data-id="${escapeHtml(s.id)}" class="link link-danger ml-3">Supprimer</button>
                </td>
            </tr>`;
    }).join('');
}

function deleteSession(id) {
    if (!confirm('Supprimer cette session ?')) return;
    appData.sessions = appData.sessions.filter(x => x.id !== id);
    commitChange();
}

function openManualSessionModal(sessionId = null) {
    populateSelects();
    if (sessionId) {
        const s = appData.sessions.find(item => item.id === sessionId);
        if (!s) return;
        document.getElementById('manual-session-modal-title').innerText = 'Éditer la session';
        document.getElementById('manual-session-id').value = s.id;
        document.getElementById('manual-project-id').value = s.projectId;
        document.getElementById('manual-date').value = s.date;
        document.getElementById('manual-hours').value = ((Number(s.durationSeconds) || 0) / 3600).toFixed(2);
        document.getElementById('manual-category').value = s.category || '';
        document.getElementById('manual-notes').value = s.notes || '';
    } else {
        document.getElementById('manual-session-modal-title').innerText = 'Ajouter une session manuelle';
        document.getElementById('manual-session-form').reset();
        document.getElementById('manual-session-id').value = '';
        document.getElementById('manual-date').value = todayLocal();
    }
    openModal('manual-session-modal');
}

function editSession(id) { openManualSessionModal(id); }

function saveManualSession(e) {
    e.preventDefault();
    const id = document.getElementById('manual-session-id').value;
    const hours = parseFloat(String(document.getElementById('manual-hours').value).replace(',', '.')) || 0;
    if (hours <= 0) { alert('La durée doit être supérieure à 0.'); return; }

    const sessionData = {
        id: id || uid('s_'),
        projectId: document.getElementById('manual-project-id').value,
        date: document.getElementById('manual-date').value,
        durationSeconds: Math.round(hours * 3600),
        category: document.getElementById('manual-category').value.trim() || 'Production',
        notes: document.getElementById('manual-notes').value.trim()
    };
    const index = id ? appData.sessions.findIndex(s => s.id === id) : -1;
    if (index !== -1) appData.sessions[index] = sessionData;
    else appData.sessions.unshift(sessionData);

    commitChange();
    closeModal('manual-session-modal');
}

/* ---------------------------------------------------------------------
   FICHE PROJET (étapes, liens, notes, sessions)
   --------------------------------------------------------------------- */
function refreshProjectDetailIfOpen() {
    const modal = document.getElementById('project-detail-modal');
    if (modal.classList.contains('hidden') || !openProjectDetailId) return;
    if (!getProject(openProjectDetailId)) { closeModal('project-detail-modal'); return; }
    const scroller = document.getElementById('project-detail-scroll');
    const top = scroller.scrollTop;
    renderProjectDetail(openProjectDetailId);
    scroller.scrollTop = top;
}

function openProjectDetailModal(projectId) {
    if (!getProject(projectId)) return;
    const wasOpen = openProjectDetailId === projectId && !document.getElementById('project-detail-modal').classList.contains('hidden');
    openProjectDetailId = projectId;
    renderProjectDetail(projectId);
    if (!wasOpen) document.getElementById('project-detail-scroll').scrollTop = 0;
    openModal('project-detail-modal');
}

function renderProjectDetail(projectId) {
    const p = getProject(projectId);
    const pid = escapeHtml(p.id);
    const client = getClient(p.clientId);
    const projSessions = sortedSessions(projectSessions(p.id));
    const totalSecs = sumSecs(projSessions);
    const hours = totalSecs / 3600;
    const rate = Number(p.hourlyRate) || 0;
    const pct = budgetPct(p);
    const { total, done } = stepsProgress(p);
    const invoice = safeUrl(p.invoiceUrl);

    document.getElementById('modal-project-title').innerText = p.name;
    document.getElementById('detail-edit-btn').dataset.id = p.id;

    const notesText = (() => { const d = document.createElement('div'); d.innerHTML = p.notes || ''; return d.innerText.trim(); })();

    const stepsHtml = p.steps.length ? p.steps.map((s, i) => {
        const sid = escapeHtml(s.id);
        const late = !s.done && s.date && s.date < todayLocal();
        return `
            <div class="flex flex-wrap sm:flex-nowrap items-center gap-2 py-2 border-t border-dashed border-[#1B1A18]/40 first:border-t-0">
                <input type="checkbox" ${s.done ? 'checked' : ''} data-change="toggleStep" data-id="${pid}" data-arg="${sid}" class="check" aria-label="Étape faite : ${escapeHtml(s.label)}">
                <input type="text" value="${escapeHtml(s.label)}" data-change="renameStep" data-id="${pid}" data-arg="${sid}" aria-label="Nom de l'étape" class="field flex-1 min-w-[140px] min-h-[40px] py-1 bg-transparent border-transparent hover:border-[#1B1A18]/40 ${s.done ? 'line-through text-[#57514A]' : 'font-semibold'}">
                <input type="date" value="${escapeHtml(s.date || '')}" data-change="setStepDate" data-id="${pid}" data-arg="${sid}" aria-label="Date de l'étape" class="field field-inline min-h-[40px] py-1 text-[15px] ${late ? 'border-[#CC0C33] text-[#8E0824]' : ''}">
                <span class="flex gap-1">
                    <button type="button" data-action="moveStep" data-id="${pid}" data-arg="${sid}" data-arg2="-1" class="btn btn-icon btn-ghost btn-sm" ${i === 0 ? 'disabled' : ''} aria-label="Monter l'étape"><i data-lucide="arrow-up" aria-hidden="true"></i></button>
                    <button type="button" data-action="moveStep" data-id="${pid}" data-arg="${sid}" data-arg2="1" class="btn btn-icon btn-ghost btn-sm" ${i === p.steps.length - 1 ? 'disabled' : ''} aria-label="Descendre l'étape"><i data-lucide="arrow-down" aria-hidden="true"></i></button>
                    <button type="button" data-action="deleteStep" data-id="${pid}" data-arg="${sid}" class="btn btn-icon btn-ghost btn-sm btn-danger" aria-label="Supprimer l'étape"><i data-lucide="trash-2" aria-hidden="true"></i></button>
                </span>
            </div>`;
    }).join('') : '<p class="hint m-0">Aucune étape.</p>';

    const linksHtml = p.links.length ? p.links.map(l => {
        const url = safeUrl(l.url);
        return `
            <div class="flex items-center gap-2 py-1">
                <i data-lucide="link" class="w-4 h-4 text-[#01675F] shrink-0" aria-hidden="true"></i>
                ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="underline font-semibold truncate">${escapeHtml(l.label || url)}</a>` : `<span>${escapeHtml(l.label)}</span>`}
                <button type="button" data-action="deleteLink" data-id="${pid}" data-arg="${escapeHtml(l.id)}" class="btn btn-icon btn-ghost btn-sm btn-danger ml-auto" aria-label="Supprimer le lien"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>`;
    }).join('') : '<p class="hint m-0">Aucun lien (Drive, WeTransfer, Canva, Pinterest…).</p>';

    const sessionRows = projSessions.length === 0
        ? `<tr><td colspan="5" class="empty">Aucune session enregistrée pour ce projet.</td></tr>`
        : projSessions.map(s => `
            <tr>
                <td class="whitespace-nowrap font-semibold">${escapeHtml(formatDateFr(s.date))}</td>
                <td class="t-num text-right">${formatHours(Number(s.durationSeconds) || 0)}</td>
                <td class="t-wide muted">${escapeHtml(s.category)}</td>
                <td class="t-wide">${escapeHtml(s.notes || '')}</td>
                <td class="t-actions text-right whitespace-nowrap">
                    <button type="button" data-action="editSession" data-id="${escapeHtml(s.id)}" class="link">Éditer</button>
                    <button type="button" data-action="deleteSession" data-id="${escapeHtml(s.id)}" class="link link-danger ml-3">Supprimer</button>
                </td>
            </tr>`).join('');

    const budgetCls = pct === null ? '' : pct > 100 ? 'over' : pct >= 80 ? 'warn' : '';
    document.getElementById('modal-project-content').innerHTML = `
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">${statusBadge(p.status)} <span class="muted text-sm font-semibold">${escapeHtml(typeLabel(p.type))}</span> ${p.deadline ? deadlineBadge(p) : ''}</div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="panel pb grid gap-2 content-start text-[15px] bg-[#FBFAF8]">
                <p class="m-0"><span class="label inline">Client</span><br>${client ? escapeHtml(clientName(client)) + (client.company ? ' · ' + escapeHtml(client.company) : '') : 'Inconnu'}</p>
                ${client && (client.email || client.phone) ? `<p class="m-0 text-sm">${client.email ? `<a class="underline" href="mailto:${escapeHtml(client.email)}">${escapeHtml(client.email)}</a>` : ''}${client.email && client.phone ? ' · ' : ''}${client.phone ? `<a class="underline" href="tel:${escapeHtml(client.phone.replace(/\s/g, ''))}">${escapeHtml(client.phone)}</a>` : ''}</p>` : ''}
                <p class="m-0"><span class="label inline">Description</span><br>${escapeHtml(p.description || 'Aucune')}</p>
                ${invoice ? `<a href="${escapeHtml(invoice)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm justify-self-start"><i data-lucide="receipt" aria-hidden="true"></i> Ouvrir le devis / la facture</a>` : ''}
            </div>
            <div class="panel pb grid gap-3 content-start text-[15px] bg-[#FBFAF8]">
                <div class="flex items-baseline gap-3 flex-wrap"><span class="num text-[40px] leading-none">${formatHours(totalSecs)}</span><span class="muted text-sm">${rate ? `${formatEuro(hours * rate)} à ${rate} €/h` : 'passées sur ce projet'}</span></div>
                ${pct !== null ? `
                    <div class="grid gap-1">
                        <p class="m-0 text-sm font-semibold">Budget : ${escapeHtml(p.hourBudget)} h · ${pct} % utilisé${pct > 100 ? ' (dépassé)' : ''}</p>
                        <div class="bar"><div class="fill ${budgetCls}" data-pct="${pct}"></div></div>
                    </div>` : ''}
                ${Number(p.price) > 0 ? `<p class="m-0 text-sm"><strong>Forfait :</strong> ${formatEuroRound(p.price)} → <strong class="${hours > 0 && p.price / hours < rate ? 'text-[#8E0824]' : 'text-[#01675F]'}">${hours > 0 ? formatEuroRound(p.price / hours) + '/h réels' : 'pas encore de temps'}</strong>${rate ? ` (visé : ${rate} €/h)` : ''}</p>` : ''}
                <div class="flex flex-wrap gap-2 pt-1">
                    <button type="button" data-action="startTimerForProject" data-id="${pid}" class="btn btn-primary"><i data-lucide="play" aria-hidden="true"></i> Lancer le chrono</button>
                    <button type="button" data-action="openManualSessionForProject" data-id="${pid}" class="btn"><i data-lucide="plus" aria-hidden="true"></i> Session</button>
                </div>
            </div>
        </div>

        <section class="sheet-section">
            <div class="flex items-center justify-between gap-2">
                <h4 class="sheet-section-title">Étapes ${total ? `<span class="muted">· ${done}/${total}</span>` : ''}</h4>
                <button type="button" data-action="addStep" data-id="${pid}" class="btn btn-sm"><i data-lucide="plus" aria-hidden="true"></i> Étape</button>
            </div>
            ${total ? `<div class="bar"><div class="fill" data-pct="${Math.round((done / total) * 100)}"></div></div>` : ''}
            <div>${stepsHtml}</div>
        </section>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <section class="sheet-section content-start">
                <h4 class="sheet-section-title">Liens & fichiers</h4>
                <div>${linksHtml}</div>
                <form data-submit="addLink" data-id="${pid}" class="flex flex-wrap gap-2">
                    <input type="text" name="label" placeholder="Nom (ex : Moodboard)" aria-label="Nom du lien" class="field flex-1 min-w-[120px]">
                    <input type="url" name="url" required placeholder="https://…" aria-label="Adresse du lien" class="field flex-1 min-w-[160px]">
                    <button type="submit" class="btn">Ajouter</button>
                </form>
            </section>
            <section class="sheet-section content-start">
                <div class="flex items-center justify-between gap-2">
                    <h4 class="sheet-section-title">Carnet de notes</h4>
                    <button type="button" data-action="openNotesForProject" data-id="${pid}" class="btn btn-sm">Ouvrir</button>
                </div>
                <p class="m-0 text-sm whitespace-pre-line line-clamp-6 ${notesText ? '' : 'hint'}">${notesText ? escapeHtml(notesText.slice(0, 500)) : 'Carnet vide. Brief, questionnaire, comptes-rendus…'}</p>
            </section>
        </div>

        <section class="sheet-section">
            <h4 class="sheet-section-title">Sessions de travail</h4>
            <div class="table-wrap">
                <table class="table table-stack">
                    <thead><tr><th>Date</th><th>Durée</th><th>Catégorie</th><th>Notes</th><th class="text-right">Actions</th></tr></thead>
                    <tbody>${sessionRows}</tbody>
                </table>
            </div>
        </section>

        <div class="sheet-section justify-items-start">
            <button type="button" data-action="deleteProject" data-id="${pid}" class="btn btn-danger"><i data-lucide="trash-2" aria-hidden="true"></i> Supprimer ce projet</button>
        </div>`;
    refreshIcons();
}

function startTimerForProject(pid) {
    closeModal('project-detail-modal');
    switchTab('dashboard');
    document.getElementById('quick-project-select').value = pid;
    quickStartTimer();
}

function openManualSessionForProject(projectId) {
    openManualSessionModal();
    document.getElementById('manual-project-id').value = projectId;
}

// Étapes
function findStep(pid, sid) { const p = getProject(pid); return p ? { p, s: p.steps.find(x => x.id === sid) } : {}; }
function toggleStep(pid, sid, checked) { const { s } = findStep(pid, sid); if (!s) return; s.done = checked; commitChange(); }
function renameStep(pid, sid, label) { const { s } = findStep(pid, sid); if (!s || !label.trim()) return; s.label = label.trim(); commitChange({ skipDetail: true }); }
function setStepDate(pid, sid, date) { const { s } = findStep(pid, sid); if (!s) return; s.date = date; commitChange(); }
function deleteStep(pid, sid) {
    const { p, s } = findStep(pid, sid);
    if (!s || !confirm(`Supprimer l'étape « ${s.label} » ?`)) return;
    p.steps = p.steps.filter(x => x.id !== sid);
    commitChange();
}
function moveStep(pid, sid, dir) {
    const p = getProject(pid);
    const i = p.steps.findIndex(x => x.id === sid);
    const j = i + Number(dir);
    if (i < 0 || j < 0 || j >= p.steps.length) return;
    [p.steps[i], p.steps[j]] = [p.steps[j], p.steps[i]];
    commitChange();
}
function addStep(pid) {
    const label = prompt('Nom de la nouvelle étape :');
    if (!label || !label.trim()) return;
    getProject(pid).steps.push({ id: uid('st_'), label: label.trim(), date: '', done: false });
    commitChange();
}

// Liens
function addLink(e, pid) {
    e.preventDefault();
    const form = e.target;
    const url = safeUrl(form.url.value);
    if (!url) { alert('Lien invalide : il doit commencer par https://'); return; }
    const label = form.label.value.trim() || new URL(url).hostname.replace(/^www\./, '');
    getProject(pid).links.push({ id: uid('l_'), label, url });
    commitChange();
}
function deleteLink(pid, lid) {
    const p = getProject(pid);
    if (!confirm('Supprimer ce lien ?')) return;
    p.links = p.links.filter(l => l.id !== lid);
    commitChange();
}

/* ---------------------------------------------------------------------
   PROJETS (liste & formulaire)
   --------------------------------------------------------------------- */
function setProjectFilter(f) { projectStatusFilter = f; renderProjects(); refreshIcons(); }

function renderProjects() {
    const filters = [['actifs', 'Actifs'], ...STATUSES.map(s => [s, s]), ['tous', 'Tous']];
    document.getElementById('project-status-filters').innerHTML = filters.map(([k, label]) => {
        const count = k === 'tous' ? appData.projects.length : k === 'actifs'
            ? appData.projects.filter(p => p.status !== 'Terminé').length
            : appData.projects.filter(p => p.status === k).length;
        return `<button type="button" data-action="setProjectFilter" data-id="${escapeHtml(k)}" class="chip" aria-pressed="${projectStatusFilter === k}">${escapeHtml(label)} <span class="n">${count}</span></button>`;
    }).join('');

    const q = (document.getElementById('project-search').value || '').trim().toLowerCase();
    const list = sortedProjects().filter(p => {
        if (projectStatusFilter === 'actifs' && p.status === 'Terminé') return false;
        if (!['actifs', 'tous'].includes(projectStatusFilter) && p.status !== projectStatusFilter) return false;
        if (!q) return true;
        const c = getClient(p.clientId);
        return [p.name, p.description, clientName(c), c && c.company, typeLabel(p.type)].join(' ').toLowerCase().includes(q);
    });

    const grid = document.getElementById('projects-grid');
    if (list.length === 0) {
        grid.innerHTML = appData.projects.length
            ? `<p class="empty col-span-full"><strong>Aucun projet ne correspond.</strong>Changez la recherche ou le filtre de statut.</p>`
            : `<div class="empty col-span-full grid gap-3"><p class="m-0"><strong>Aucun projet pour l’instant.</strong>Un projet est rattaché à un client : créez d’abord le client.</p><div class="flex flex-wrap gap-2"><button type="button" data-action="openClientModal" class="btn">Nouveau client</button><button type="button" data-action="openProjectModal" class="btn btn-primary">Nouveau projet</button></div></div>`;
        return;
    }

    grid.innerHTML = list.map(p => {
        const secs = projectSecs(p.id);
        const pct = budgetPct(p);
        const { total, done } = stepsProgress(p);
        const ns = nextStep(p);
        const budgetHtml = pct !== null ? `
            <div class="grid gap-1 text-sm">
                <div class="flex justify-between gap-2"><span class="muted">Temps / budget</span><span class="font-semibold ${pct > 100 ? 'text-[#8E0824]' : ''}">${formatHours(secs)} / ${escapeHtml(p.hourBudget)} h</span></div>
                <div class="bar"><div class="fill ${pct > 100 ? 'over' : pct >= 80 ? 'warn' : ''}" data-pct="${pct}"></div></div>
            </div>` : '';

        return `
            <article class="card ${p.status === 'Terminé' ? 'is-done' : ''}">
                <button type="button" class="card-main grid gap-2" data-action="openProjectDetailModal" data-id="${escapeHtml(p.id)}">
                    <span class="flex items-start justify-between gap-3">
                        <span class="card-title">${escapeHtml(p.name)}</span>
                        <span class="num text-[22px] leading-none whitespace-nowrap">${formatHours(secs)}</span>
                    </span>
                    <span class="card-meta">${escapeHtml(clientName(getClient(p.clientId)))} · ${escapeHtml(typeLabel(p.type))}</span>
                    <span class="flex flex-wrap items-center gap-x-4 gap-y-1">${statusBadge(p.status)}${deadlineBadge(p)}</span>
                    <span class="pc-only grid gap-2">
                        ${p.description ? `<span class="text-sm line-clamp-2">${escapeHtml(p.description)}</span>` : ''}
                        ${total ? `<span class="text-sm"><span class="muted">Étapes</span> <strong>${done}/${total}</strong>${ns ? ` · prochaine : ${escapeHtml(ns.label)}${ns.date ? ' (' + escapeHtml(formatDateShort(ns.date)) + ')' : ''}` : ''}</span>` : ''}
                        ${budgetHtml}
                    </span>
                </button>
                <div class="card-foot pc-only">
                    <button type="button" data-action="editProject" data-id="${escapeHtml(p.id)}" class="btn btn-sm">Éditer</button>
                    <button type="button" data-action="deleteProject" data-id="${escapeHtml(p.id)}" class="btn btn-sm btn-danger">Supprimer</button>
                </div>
            </article>`;
    }).join('');
    refreshIcons();
}

function toggleBudgetInput() {
    document.getElementById('budget-container').classList.toggle('hidden', !document.getElementById('project-has-budget').checked);
}

function suggestBudgetFromPrice() {
    const price = parseFloat(document.getElementById('project-price').value);
    const rate = parseFloat(document.getElementById('project-hourly-rate').value);
    if (!(price > 0) || !(rate > 0)) { alert('Renseignez d\'abord le prix du forfait et le taux horaire visé.'); return; }
    document.getElementById('project-hour-budget').value = Math.max(0.5, Math.round((price / rate) * 2) / 2);
}

function openProjectModal(id = null) {
    populateSelects();
    document.getElementById('project-no-client-hint').classList.toggle('hidden', appData.clients.length > 0);
    document.getElementById('project-ai-hint').classList.add('hidden');
    if (id) {
        const p = getProject(id);
        if (!p) return;
        document.getElementById('project-modal-title').innerText = 'Modifier le projet';
        document.getElementById('project-id').value = p.id;
        document.getElementById('project-name').value = p.name;
        document.getElementById('project-client-id').value = p.clientId;
        document.getElementById('project-type').value = p.type;
        document.getElementById('project-has-budget').checked = !!p.hasBudget;
        document.getElementById('project-hour-budget').value = p.hourBudget || 10;
        document.getElementById('project-hourly-rate').value = p.hourlyRate ?? DEFAULT_RATE;
        document.getElementById('project-price').value = p.price || '';
        document.getElementById('project-status').value = p.status;
        document.getElementById('project-deadline').value = p.deadline || '';
        document.getElementById('project-invoice-url').value = p.invoiceUrl || '';
        document.getElementById('project-description').value = p.description || '';
        document.getElementById('project-steps-hint').classList.add('hidden');
    } else {
        document.getElementById('project-modal-title').innerText = 'Nouveau projet';
        document.getElementById('project-form').reset();
        document.getElementById('project-id').value = '';
        document.getElementById('project-has-budget').checked = false;
        document.getElementById('project-status').value = 'En cours';
        document.getElementById('project-type').value = 'autre';
        document.getElementById('project-steps-hint').classList.remove('hidden');
    }
    toggleBudgetInput();
    openModal('project-modal');
}

function cancelProjectModal() { aiFlow = null; closeModal('project-modal'); }

function saveProject(e) {
    e.preventDefault();
    const id = document.getElementById('project-id').value;
    const existing = id ? getProject(id) : null;
    const hasBudget = document.getElementById('project-has-budget').checked;
    const rateRaw = parseFloat(document.getElementById('project-hourly-rate').value);
    const priceRaw = parseFloat(document.getElementById('project-price').value);
    const type = document.getElementById('project-type').value;
    const status = document.getElementById('project-status').value;
    const invoiceRaw = document.getElementById('project-invoice-url').value.trim();
    if (invoiceRaw && !safeUrl(invoiceRaw)) { alert('Le lien devis / facture doit commencer par https://'); return; }

    const projData = {
        ...(existing || {}),
        id: id || uid('p_'),
        createdAt: existing ? (projectCreatedAt(existing) || new Date().toISOString()) : new Date().toISOString(),
        name: document.getElementById('project-name').value.trim(),
        clientId: document.getElementById('project-client-id').value,
        type,
        hasBudget,
        hourBudget: hasBudget ? (parseFloat(document.getElementById('project-hour-budget').value) || 10) : null,
        hourlyRate: Number.isFinite(rateRaw) ? rateRaw : DEFAULT_RATE,
        price: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
        status,
        statusChangedAt: (!existing || existing.status !== status) ? new Date().toISOString() : (existing.statusChangedAt || ''),
        deadline: document.getElementById('project-deadline').value,
        invoiceUrl: invoiceRaw ? safeUrl(invoiceRaw) : '',
        description: document.getElementById('project-description').value.trim(),
        steps: existing ? existing.steps : (PROJECT_TYPES[type] || PROJECT_TYPES.autre).steps.map(label => ({ id: uid('st_'), label, date: '', done: false })),
        links: existing ? existing.links : [],
        notes: existing ? existing.notes : ''
    };

    if (!existing && aiFlow) {
        projData.notes = analysisToHtml(aiFlow.analysis);
        const c = aiFlow.analysis.client || {};
        const cl = getClient(projData.clientId);
        if (cl && c.adresse && !cl.address) cl.address = c.adresse;
    }
    const fromAI = !existing && !!aiFlow;
    aiFlow = null;

    const index = existing ? appData.projects.findIndex(p => p.id === id) : -1;
    if (index !== -1) appData.projects[index] = normalizeProject(projData);
    else appData.projects.push(normalizeProject(projData));

    commitChange();
    closeModal('project-modal');
    if (!existing) openProjectDetailModal(projData.id);
    if (fromAI) switchNotesTarget(projData.id);
}

function editProject(id) { openProjectModal(id); }

function deleteProject(id) {
    const p = getProject(id);
    if (!p) return;
    if (timerState.projectId === id && timerElapsed() > 0) {
        alert('Un chrono est en cours sur ce projet : enregistrez-le ou annulez-le d\'abord.');
        return;
    }
    const n = projectSessions(id).length;
    let msg = `Supprimer le projet « ${p.name} » ?`;
    if (n || (p.notes && p.notes.trim())) msg += `\n\nSes ${n} session(s), ses étapes, ses liens et son carnet de notes seront aussi supprimés.`;
    if (!confirm(msg)) return;
    appData.projects = appData.projects.filter(x => x.id !== id);
    appData.sessions = appData.sessions.filter(s => s.projectId !== id);
    closeModal('project-detail-modal');
    if (currentNotesTarget === id) switchNotesTarget('general');
    commitChange();
}

/* ---------------------------------------------------------------------
   CLIENTS
   --------------------------------------------------------------------- */
function renderClients() {
    const grid = document.getElementById('clients-grid');
    const q = (document.getElementById('client-search').value || '').trim().toLowerCase();
    const list = [...appData.clients]
        .filter(c => !q || [clientName(c), c.company, c.email, c.phone, c.address].join(' ').toLowerCase().includes(q))
        .sort((a, b) => clientName(a).localeCompare(clientName(b), 'fr'));

    if (list.length === 0) {
        grid.innerHTML = appData.clients.length
            ? `<p class="empty col-span-full"><strong>Aucun client ne correspond.</strong>Essayez un autre nom, une entreprise ou un email.</p>`
            : `<div class="empty col-span-full grid gap-3"><p class="m-0"><strong>Aucun client pour l’instant.</strong>Ajoutez votre premier client pour pouvoir créer ses projets.</p><div><button type="button" data-action="openClientModal" class="btn btn-primary">Nouveau client</button></div></div>`;
        return;
    }
    grid.innerHTML = list.map(c => {
        const projects = appData.projects.filter(p => p.clientId === c.id);
        const secs = projects.reduce((a, p) => a + projectSecs(p.id), 0);
        return `
            <article class="card">
                <div class="card-body">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <h3 class="card-title m-0">${escapeHtml(clientName(c))}</h3>
                            <p class="card-meta m-0">${escapeHtml(c.company || 'Particulier')}</p>
                        </div>
                        ${projects.length ? `<span class="num text-[22px] leading-none whitespace-nowrap">${formatHours(secs)}</span>` : ''}
                    </div>
                    <p class="m-0 flex items-center gap-2"><i data-lucide="mail" class="w-4 h-4 shrink-0 text-[#57514A]" aria-hidden="true"></i> ${c.email ? `<a class="underline truncate" href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : '<span class="muted">Pas d’email</span>'}</p>
                    <p class="m-0 flex items-center gap-2"><i data-lucide="phone" class="w-4 h-4 shrink-0 text-[#57514A]" aria-hidden="true"></i> ${c.phone ? `<a class="underline" href="tel:${escapeHtml(c.phone.replace(/\s/g, ''))}">${escapeHtml(c.phone)}</a>` : '<span class="muted">Pas de téléphone</span>'}</p>
                    <div class="pc-only grid gap-1 pt-2 border-t border-dashed border-[#1B1A18]/40">
                        <p class="m-0"><span class="muted">Facturation :</span> ${escapeHtml(c.address || '—')}</p>
                        ${c.deliveryAddress ? `<p class="m-0"><span class="muted">Livraison :</span> ${escapeHtml(c.deliveryAddress)}</p>` : ''}
                    </div>
                    ${projects.length ? `<div class="grid gap-1 pt-2 border-t border-dashed border-[#1B1A18]/40">
                        <p class="m-0 label">${projects.length} projet${projects.length > 1 ? 's' : ''}</p>
                        ${projects.map(p => `<button type="button" data-action="openProjectDetailModal" data-id="${escapeHtml(p.id)}" class="flex items-center justify-between gap-3 w-full text-left py-1 min-h-[36px] hover:underline"><span class="truncate font-semibold">${escapeHtml(p.name)}</span>${statusBadge(p.status)}</button>`).join('')}
                    </div>` : '<p class="m-0 hint">Aucun projet</p>'}
                </div>
                <div class="card-foot">
                    <button type="button" data-action="editClient" data-id="${escapeHtml(c.id)}" class="btn btn-sm">Éditer</button>
                    <button type="button" data-action="deleteClient" data-id="${escapeHtml(c.id)}" class="btn btn-sm btn-danger">Supprimer</button>
                </div>
            </article>`;
    }).join('');
    refreshIcons();
}

function openClientModal(id = null, prefill = null) {
    document.getElementById('client-ai-hint').classList.add('hidden');
    const set = (field, v) => { document.getElementById(field).value = v || ''; };
    if (id) {
        const c = getClient(id);
        if (!c) return;
        document.getElementById('client-modal-title').innerText = 'Modifier le client';
        set('client-id', c.id);
        set('client-firstname', c.firstname); set('client-lastname', c.lastname); set('client-company', c.company);
        set('client-email', c.email); set('client-phone', c.phone); set('client-address', c.address);
        set('client-delivery-address', c.deliveryAddress);
    } else {
        document.getElementById('client-modal-title').innerText = 'Nouveau client';
        document.getElementById('client-form').reset();
        set('client-id', '');
        if (prefill) {
            set('client-firstname', prefill.firstname); set('client-lastname', prefill.lastname); set('client-company', prefill.company);
            set('client-email', prefill.email); set('client-phone', prefill.phone); set('client-address', prefill.address);
        }
    }
    openModal('client-modal');
}

function cancelClientModal() { aiFlow = null; closeModal('client-modal'); }

function saveClient(e) {
    e.preventDefault();
    const id = document.getElementById('client-id').value;
    const clientData = {
        id: id || uid('c_'),
        firstname: document.getElementById('client-firstname').value.trim(),
        lastname: document.getElementById('client-lastname').value.trim(),
        company: document.getElementById('client-company').value.trim(),
        email: document.getElementById('client-email').value.trim(),
        phone: document.getElementById('client-phone').value.trim(),
        address: document.getElementById('client-address').value.trim(),
        deliveryAddress: document.getElementById('client-delivery-address').value.trim()
    };
    const index = id ? appData.clients.findIndex(c => c.id === id) : -1;
    if (index !== -1) appData.clients[index] = clientData;
    else appData.clients.push(clientData);

    commitChange();
    closeModal('client-modal');

    if (!id && aiFlow && !aiFlow.clientId) {
        aiFlow.clientId = clientData.id;
        openProjectModalFromAI();
    }
}

function editClient(id) { openClientModal(id); }

function deleteClient(id) {
    const c = getClient(id);
    if (!c) return;
    const projIds = appData.projects.filter(p => p.clientId === id).map(p => p.id);
    if (timerElapsed() > 0 && projIds.includes(timerState.projectId)) {
        alert('Un chrono est en cours sur un projet de ce client : enregistrez-le ou annulez-le d\'abord.');
        return;
    }
    const nbSessions = appData.sessions.filter(s => projIds.includes(s.projectId)).length;
    let msg = `Supprimer le client « ${clientName(c)} » ?`;
    if (projIds.length) msg += `\n\n⚠️ Cela supprimera aussi ses ${projIds.length} projet(s) (avec étapes, liens et notes) et ${nbSessions} session(s) de travail.`;
    if (!confirm(msg)) return;

    appData.clients = appData.clients.filter(x => x.id !== id);
    appData.projects = appData.projects.filter(p => p.clientId !== id);
    appData.sessions = appData.sessions.filter(s => !projIds.includes(s.projectId));
    if (projIds.includes(currentNotesTarget)) switchNotesTarget('general');
    commitChange();
}
