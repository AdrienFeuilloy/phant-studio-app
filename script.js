'use strict';

/* =====================================================================
   PHANT STUDIO — Suivi & Gestion Projets  (v2.1.0)
   Données : localStorage (cet appareil) + data.json dans un dépôt
   GitHub PRIVÉ (synchronisation entre appareils).
   ===================================================================== */

const LS = {
    data: 'phant_data_v2',
    dirty: 'phant_dirty',            // '1' = modifications pas encore envoyées sur GitHub
    lastSynced: 'phant_last_synced', // updatedAt de la dernière version envoyée/reçue
    timer: 'phant_timer',
    ghUser: 'phant_gh_user',
    ghRepo: 'phant_gh_repo',
    ghToken: 'phant_gh_token',
    geminiKey: 'phant_gemini_key',
    geminiModel: 'phant_gemini_model'
};
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_RATE = 35;

let appData = emptyData();
let ghConfig = {
    username: lsGet(LS.ghUser),
    repo: lsGet(LS.ghRepo),
    token: lsGet(LS.ghToken)
};
let fileSha = null;
let repoPrivacyChecked = false;

// File d'attente des sauvegardes GitHub
let saveDebounce = null;
let saving = false;
let saveAgain = false;

// Décompilateur
let currentBase64Image = null;
let currentImageMime = 'image/png';

// Chrono
let timerState = loadTimerState();

/* ---------------------------------------------------------------------
   OUTILS
   --------------------------------------------------------------------- */
function lsGet(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { console.error('Stockage local impossible', e); } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* rien */ } }
function safeParse(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; } }

function emptyData() { return { clients: [], projects: [], sessions: [], notes: '', updatedAt: null }; }

function normalizeData(d) {
    d = d || {};
    return {
        clients: Array.isArray(d.clients) ? d.clients : [],
        projects: Array.isArray(d.projects) ? d.projects : [],
        sessions: Array.isArray(d.sessions) ? d.sessions : [],
        notes: typeof d.notes === 'string' ? d.notes : '',
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

function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateFr(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

function formatHours(totalSecs) {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    return `${h}h${m.toString().padStart(2, '0')}`;
}

function formatEuro(n) { return (n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }

function refreshIcons() { if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons(); }

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

// Base64 <-> texte UTF-8 (accents compris)
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
function clientName(c) { return c ? `${c.firstname} ${c.lastname}`.trim() : 'Client inconnu'; }
function projectSessions(pid) { return appData.sessions.filter(s => s.projectId === pid); }
function sumSecs(list) { return list.reduce((acc, s) => acc + (Number(s.durationSeconds) || 0), 0); }

/* ---------------------------------------------------------------------
   DÉMARRAGE
   --------------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
    loadLocalData();
    updateAllViews();
    loadNotesIntoEditor();
    restoreTimerUI();
    setInterval(refreshTimerDisplay, 1000);

    setupEditor();
    setupDropZone();
    setupKeyboard();

    if (isConfigured()) {
        syncFromGitHub();
    } else {
        updateSyncBadge('warning', 'Local uniquement');
    }
    refreshIcons();
});

// Si des modifications attendent d'être envoyées, on les envoie dès que la page passe en arrière-plan
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveDebounce) {
        clearTimeout(saveDebounce);
        saveDebounce = null;
        pushToGitHub();
    }
});

// Avertir si on ferme la page pendant un envoi
window.addEventListener('beforeunload', (e) => {
    if (isConfigured() && (saving || saveDebounce)) {
        e.preventDefault();
        e.returnValue = '';
    }
});

function loadLocalData() {
    const stored = safeParse(lsGet(LS.data), null);
    if (stored) {
        appData = normalizeData(stored);
        return;
    }
    // Reprise des données de l'ancienne version (v2.0.0), si elles existent sur cet appareil
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

/* ---------------------------------------------------------------------
   SYNCHRONISATION GITHUB
   --------------------------------------------------------------------- */
class GitHubError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function isConfigured() { return !!(ghConfig.token && ghConfig.username && ghConfig.repo); }

function repoUrl() {
    return `https://api.github.com/repos/${encodeURIComponent(ghConfig.username)}/${encodeURIComponent(ghConfig.repo)}`;
}
function fileUrl() { return `${repoUrl()}/contents/data.json`; }

function ghHeaders(extra = {}) {
    return { 'Authorization': `Bearer ${ghConfig.token}`, 'Accept': 'application/vnd.github+json', ...extra };
}

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

async function fetchRemote() {
    let res;
    try {
        res = await fetch(`${fileUrl()}?nocache=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
    } catch (e) {
        throw new GitHubError(0, 'Pas de connexion Internet');
    }

    if (res.status === 404) {
        // Le fichier n'existe pas encore… ou le dépôt est inaccessible : on vérifie.
        const repoRes = await fetch(`${repoUrl()}?nocache=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
        if (!repoRes.ok) throw new GitHubError(repoRes.status, ghErrorText(repoRes.status));
        const repoInfo = await repoRes.json();
        if (repoInfo.private === false) {
            throw new GitHubError(-1, 'Ce dépôt est PUBLIC ! Utilisez un dépôt privé');
        }
        return { exists: false, sha: null, data: null };
    }
    if (!res.ok) throw new GitHubError(res.status, ghErrorText(res.status));

    if (!repoPrivacyChecked) {
        const repoRes = await fetch(`${repoUrl()}?nocache=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
        if (repoRes.ok) {
            const repoInfo = await repoRes.json();
            if (repoInfo.private === false) throw new GitHubError(-1, 'Ce dépôt est PUBLIC ! Rendez-le privé');
            repoPrivacyChecked = true;
        }
    }

    const json = await res.json();
    let text;
    if (json.encoding === 'base64' && json.content) {
        text = b64DecodeUtf8(json.content);
    } else {
        // Fichier > 1 Mo : on le récupère en brut
        const raw = await fetch(`${fileUrl()}?nocache=${Date.now()}`, {
            headers: ghHeaders({ 'Accept': 'application/vnd.github.raw+json' }), cache: 'no-store'
        });
        if (!raw.ok) throw new GitHubError(raw.status, ghErrorText(raw.status));
        text = await raw.text();
    }
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
            keepLocal = true; // premier envoi : on crée data.json
        } else if (!hasContent(remote.data) && hasContent(appData)) {
            keepLocal = true; // le cloud est vide mais pas cet appareil
        } else if (dirty) {
            const remoteChangedElsewhere = remote.data.updatedAt && remote.data.updatedAt !== lastSynced;
            if (remoteChangedElsewhere) {
                keepLocal = confirm(
                    'Attention : des modifications existent à la fois sur CET appareil (pas encore envoyées) ' +
                    'et dans le cloud (faites depuis un autre appareil).\n\n' +
                    'OK = garder la version de CET appareil\nAnnuler = garder la version du CLOUD'
                );
            } else {
                keepLocal = true;
            }
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
            loadNotesIntoEditor();
            updateSyncBadge('success', 'Synchronisé');
        }
    } catch (err) {
        console.error('Échec synchronisation GitHub :', err);
        updateSyncBadge('error', err.message || 'Erreur de synchronisation');
    }
}

// À appeler après CHAQUE modification de données
function commitChange({ rerender = true, delay = 1200 } = {}) {
    appData.updatedAt = new Date().toISOString();
    lsSet(LS.data, JSON.stringify(appData));
    lsSet(LS.dirty, '1');
    if (rerender) updateAllViews();

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

        let res;
        try {
            res = await fetch(fileUrl(), {
                method: 'PUT',
                headers: ghHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
            });
        } catch (e) {
            throw new GitHubError(0, 'Pas de connexion Internet');
        }

        if (res.ok) {
            const resData = await res.json();
            fileSha = resData.content.sha;
            lsSet(LS.lastSynced, snapshotUpdatedAt || '');
            if (appData.updatedAt === snapshotUpdatedAt) lsDel(LS.dirty);
            updateSyncBadge('success', 'Synchronisé');
            return;
        }

        // Version du fichier périmée : on récupère la bonne et on réessaie une fois
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
    const base = 'text-xs font-semibold px-2.5 py-1 rounded-[6px] border-2 border-[#1B1A18] flex items-center gap-1.5 shadow-[1px_1px_0px_#1B1A18] ';
    const styles = {
        success: ['bg-emerald-200 text-emerald-900', 'check-circle-2', ''],
        loading: ['bg-sky-200 text-sky-900', 'refresh-cw', 'animate-spin'],
        warning: ['bg-amber-200 text-amber-900', 'hard-drive', ''],
        error: ['bg-rose-200 text-rose-900', 'x-circle', '']
    };
    const [colors, icon, extra] = styles[status] || styles.error;
    badge.className = base + colors;
    badge.title = status === 'error' ? 'Cliquez sur « Réglages & Sync » pour vérifier vos informations' : '';
    badge.innerHTML = `<i data-lucide="${icon}" class="w-3.5 h-3.5 ${extra}"></i> ${escapeHtml(message)}`;
    refreshIcons();
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
   SAUVEGARDES (JSON) & EXPORT CSV
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
        loadNotesIntoEditor();
        closeModal('config-modal');
    };
    reader.readAsText(file);
}

function exportDataCSV() {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const rows = [['Date', 'Projet', 'Client', 'Catégorie', 'Durée (h)', 'Taux (€/h)', 'Montant (€)', 'Notes']];
    sortedSessions(appData.sessions).forEach(s => {
        const p = getProject(s.projectId);
        const c = p ? getClient(p.clientId) : null;
        const hours = (Number(s.durationSeconds) || 0) / 3600;
        const rate = p ? (Number(p.hourlyRate) || 0) : 0;
        rows.push([
            formatDateFr(s.date), p ? p.name : 'Projet supprimé', c ? clientName(c) : '', s.category,
            hours.toFixed(2).replace('.', ','), String(rate).replace('.', ','),
            (hours * rate).toFixed(2).replace('.', ','), s.notes || ''
        ]);
    });
    const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
    downloadBlob(csv, `phant_studio_sessions_${todayLocal()}.csv`, 'text/csv;charset=utf-8');
}

/* ---------------------------------------------------------------------
   FENÊTRES (MODALES) & NAVIGATION
   --------------------------------------------------------------------- */
function openModal(id) { document.getElementById(id).classList.remove('hidden'); refreshIcons(); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = [...document.querySelectorAll('.modal')].filter(m => !m.classList.contains('hidden'));
        if (open.length) open[open.length - 1].classList.add('hidden');
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('retro-btn');
        btn.classList.add('retro-btn-secondary');
    });
    document.getElementById(`tab-${tabId}`).classList.remove('hidden');
    const activeBtn = document.getElementById(`btn-tab-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.remove('retro-btn-secondary');
        activeBtn.classList.add('retro-btn');
    }
    window.scrollTo({ top: 0 });
    refreshIcons();
}

function updateAllViews() {
    populateSelects();
    renderDashboard();
    renderProjects();
    renderClients();
    renderSessions();
    refreshIcons();
}

function populateSelects() {
    const projectOptions = sortedProjects().map(p => {
        const label = `${p.name} (${clientName(getClient(p.clientId))})${p.status === 'Terminé' ? ' — terminé' : ''}`;
        return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    }).join('');

    ['timer-project-select', 'quick-project-select', 'manual-project-id'].forEach(selId => {
        const el = document.getElementById(selId);
        if (!el) return;
        const currentVal = el.value;
        el.innerHTML = '<option value="">-- Sélectionner un projet --</option>' + projectOptions;
        el.value = getProject(currentVal) ? currentVal : '';
    });

    const clientSelect = document.getElementById('project-client-id');
    if (clientSelect) {
        const currentClientVal = clientSelect.value;
        clientSelect.innerHTML = '<option value="">-- Sélectionner un client --</option>' +
            [...appData.clients].sort((a, b) => clientName(a).localeCompare(clientName(b), 'fr')).map(c =>
                `<option value="${escapeHtml(c.id)}">${escapeHtml(clientName(c))}${c.company ? ' (' + escapeHtml(c.company) + ')' : ''}</option>`
            ).join('');
        clientSelect.value = currentClientVal;
    }

    // Le chrono garde son projet même après un rafraîchissement des listes
    const timerSel = document.getElementById('timer-project-select');
    if (timerSel && timerState.projectId && getProject(timerState.projectId)) timerSel.value = timerState.projectId;
}

/* ---------------------------------------------------------------------
   TRI & DEADLINES
   --------------------------------------------------------------------- */
function projectCreatedAt(p) {
    if (p.createdAt) return p.createdAt;
    const m = /^p_(\d{12,})$/.exec(p.id || '');
    return m ? new Date(Number(m[1])).toISOString() : '';
}

function projectLastActivity(p) {
    const dates = projectSessions(p.id).map(s => s.date || '');
    const created = projectCreatedAt(p).slice(0, 10);
    return [created, ...dates].sort().pop() || '';
}

function sortedProjects() {
    const order = { 'En cours': 0, 'En pause': 1, 'Terminé': 2 };
    return [...appData.projects].sort((a, b) =>
        (order[a.status] ?? 3) - (order[b.status] ?? 3) || projectLastActivity(b).localeCompare(projectLastActivity(a))
    );
}

function sortedSessions(list) {
    return [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)));
}

function deadlineBadge(p) {
    if (!p.deadline) return '';
    const today = new Date(todayLocal() + 'T00:00:00');
    const dl = new Date(p.deadline + 'T00:00:00');
    const days = Math.round((dl - today) / 86400000);
    let cls = 'bg-[#EFEEEC]';
    let txt = `Deadline : ${formatDateFr(p.deadline)}`;
    if (p.status !== 'Terminé') {
        if (days < 0) { cls = 'bg-rose-200 text-rose-900'; txt += ` (dépassée de ${-days} j)`; }
        else if (days === 0) { cls = 'bg-rose-200 text-rose-900'; txt += ' (aujourd\'hui !)'; }
        else if (days <= 7) { cls = 'bg-amber-200 text-amber-900'; txt += ` (dans ${days} j)`; }
        else { txt += ` (dans ${days} j)`; }
    }
    return `<span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-[4px] border border-[#1B1A18] font-semibold ${cls}"><i data-lucide="calendar-clock" class="w-3 h-3"></i> ${escapeHtml(txt)}</span>`;
}

/* ---------------------------------------------------------------------
   TABLEAU DE BORD
   --------------------------------------------------------------------- */
function renderDashboard() {
    let totalSecs = 0;
    let totalRevenue = 0;

    appData.sessions.forEach(s => {
        const p = getProject(s.projectId);
        if (!p) return; // sessions orphelines ignorées
        const secs = Number(s.durationSeconds) || 0;
        totalSecs += secs;
        totalRevenue += (secs / 3600) * (Number(p.hourlyRate) || 0);
    });

    document.getElementById('dash-total-hours').innerText = formatHours(totalSecs);
    document.getElementById('dash-total-revenue').innerText = formatEuro(totalRevenue);
    document.getElementById('dash-active-projects').innerText = appData.projects.filter(p => p.status === 'En cours').length;
    document.getElementById('dash-total-clients').innerText = appData.clients.length;

    const dashList = document.getElementById('dash-projects-list');
    if (appData.projects.length === 0) {
        dashList.innerHTML = '<p class="text-xs text-[#1B1A18]/60 py-4 text-center">Aucun projet enregistré. Commencez par créer un client, puis un projet.</p>';
        return;
    }

    const recent = [...appData.projects]
        .sort((a, b) => projectLastActivity(b).localeCompare(projectLastActivity(a)))
        .slice(0, 4);

    dashList.innerHTML = recent.map(p => {
        const secs = sumSecs(projectSessions(p.id));
        return `
            <div onclick="openProjectDetailModal('${escapeHtml(p.id)}')" class="p-4 rounded-[6px] bg-white border-2 border-[#1B1A18] cursor-pointer hover:bg-[#EFEEEC] transition space-y-2 shadow-[2px_2px_0px_#1B1A18]">
                <div class="flex items-center justify-between gap-2">
                    <div>
                        <h4 class="font-heading text-lg text-[#1B1A18]">${escapeHtml(p.name)}</h4>
                        <p class="text-xs font-semibold text-[#1B1A18]/70">${escapeHtml(clientName(getClient(p.clientId)))}</p>
                    </div>
                    <span class="text-xs px-2 py-0.5 rounded-[4px] bg-[#CEB694] border border-[#1B1A18] font-bold shrink-0">${escapeHtml(p.status)}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <p class="text-xs font-semibold">Temps total : ${formatHours(secs)}</p>
                    ${deadlineBadge(p)}
                </div>
            </div>`;
    }).join('');
}

/* ---------------------------------------------------------------------
   CHRONO (basé sur l'heure réelle, survit à la fermeture de la page)
   --------------------------------------------------------------------- */
function loadTimerState() {
    const s = safeParse(lsGet(LS.timer), null) || {};
    return {
        projectId: s.projectId || '',
        category: s.category || 'Production',
        notes: s.notes || '',
        startedAt: typeof s.startedAt === 'number' ? s.startedAt : null, // ms, null = en pause / arrêté
        accumulated: Number(s.accumulated) || 0,                          // secondes déjà comptées
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
    if (timerState.projectId && getProject(timerState.projectId)) {
        document.getElementById('timer-project-select').value = timerState.projectId;
    }
    refreshTimerDisplay();
    if (timerElapsed() > 0) switchTab('timer');
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
    const display = document.getElementById('timer-display');
    if (display) display.innerText = `${hrs}:${mins}:${secs}`;

    const running = !!timerState.startedAt;
    const started = total > 0 || running;
    document.getElementById('btn-start-timer').disabled = running;
    document.getElementById('btn-start-timer').innerText = (!running && started) ? 'Reprendre' : 'Lancer';
    document.getElementById('btn-pause-timer').disabled = !running;
    document.getElementById('btn-stop-timer').disabled = !started;
    document.getElementById('btn-reset-timer').disabled = !started;
    document.getElementById('timer-project-select').disabled = started; // on ne change pas de projet en cours de route

    document.title = running ? `⏱ ${hrs}:${mins}:${secs} — Phant Studio` : 'Phant Studio — Suivi & Gestion Projets';
}

function startTimer() {
    const projId = document.getElementById('timer-project-select').value;
    if (!projId) { alert('Veuillez sélectionner un projet.'); return; }
    if (timerState.startedAt) return;
    onTimerFieldChange();
    if (!timerState.sessionDate) timerState.sessionDate = todayLocal();
    timerState.startedAt = Date.now();
    saveTimerState();
    refreshTimerDisplay();
}

function pauseTimer() {
    if (!timerState.startedAt) return;
    timerState.accumulated = timerElapsed();
    timerState.startedAt = null;
    saveTimerState();
    refreshTimerDisplay();
}

function stopTimer() {
    const secs = timerElapsed();
    if (secs <= 0) return;
    const projId = timerState.projectId || document.getElementById('timer-project-select').value;
    if (!getProject(projId)) { alert('Le projet de ce chrono n\'existe plus. Choisissez-en un autre.'); document.getElementById('timer-project-select').disabled = false; return; }
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
    timerState = {
        projectId: timerState.projectId,
        category: 'Production',
        notes: '',
        startedAt: null,
        accumulated: 0,
        sessionDate: ''
    };
    saveTimerState();
    document.getElementById('timer-category').value = 'Production';
    document.getElementById('timer-notes').value = '';
    refreshTimerDisplay();
}

function quickStartTimer() {
    const projId = document.getElementById('quick-project-select').value;
    switchTab('timer');
    if (timerElapsed() > 0) {
        alert('Un chrono est déjà en cours : enregistrez-le ou annulez-le avant d\'en lancer un autre.');
        return;
    }
    if (!projId) { alert('Choisissez d\'abord un projet dans la liste.'); return; }
    document.getElementById('timer-project-select').value = projId;
    startTimer();
}

/* ---------------------------------------------------------------------
   NOTES (enregistrées automatiquement)
   --------------------------------------------------------------------- */
function setupEditor() {
    const editor = document.getElementById('rich-text-editor');
    editor.addEventListener('input', onNotesChanged);
    editor.addEventListener('paste', (e) => {
        // Les images collées alourdiraient énormément data.json
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
            e.preventDefault();
            alert('Les images ne peuvent pas être collées dans les notes. Utilisez le Décompilateur IA pour les captures.');
        }
    });
}

function loadNotesIntoEditor() {
    const editor = document.getElementById('rich-text-editor');
    if (editor && document.activeElement !== editor) editor.innerHTML = appData.notes || '';
}

function onNotesChanged() {
    const editor = document.getElementById('rich-text-editor');
    // Un éditeur "vide" contient parfois un <br> tout seul
    appData.notes = editor.innerText.trim() ? editor.innerHTML : '';
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
    if (!confirm('Effacer toutes les notes ?')) return;
    document.getElementById('rich-text-editor').innerHTML = '';
    onNotesChanged();
}

function appendToEditor(html) {
    const editor = document.getElementById('rich-text-editor');
    editor.innerHTML += html;
    onNotesChanged();
}

function loadQuestionnaire(type) {
    const templates = {
        mariage: `<h2>QUESTIONNAIRE MARIAGE — BRIEF CRÉATIF</h2><h3>1. La Vision & L'Univers du Mariage</h3><p><strong>Date et lieu :</strong> </p><p><strong>Thème ou ambiance (3 mots) :</strong> </p><p><strong>Palette de couleurs :</strong> </p><p><strong>Histoire du couple :</strong> </p><p><strong>Inspirations / Pinterest :</strong> </p><h3>2. Les Besoins en Papeterie</h3><p><strong>Avant le jour J :</strong> Save the date, Faire-part, RSVP...</p><p><strong>Le jour J :</strong> Livrets, plan de table, menus, signalétique...</p><p><strong>Après le jour J :</strong> Remerciements.</p><h3>3. Aspects Techniques & Logistiques</h3><p><strong>Quantités (foyers) & Marge :</strong> </p><p><strong>Textes & Bilinguisme :</strong> </p><p><strong>Formats, Papiers & Finitions :</strong> </p><h3>4. Calendrier & Budget</h3><p><strong>Planning d'envoi :</strong> </p><p><strong>Budget global :</strong> </p>`,
        affiches: `<h2>BRIEF CRÉATIF — AFFICHE & ÉVÉNEMENTIEL</h2><h3>1. Objectif & Message Clé</h3><p><strong>Nom de l'événement / Produit :</strong> </p><p><strong>Message principal :</strong> </p><p><strong>Call To Action & Infos (Site, QR Code, Date, Lieu) :</strong> </p><h3>2. Ambiance & Direction Artistique</h3><p><strong>Style souhaité (Illustré, Photo, Typo, 2D/3D) :</strong> </p><p><strong>Palette de couleurs & Ton :</strong> </p><p><strong>Sponsors / Logos obligatoires :</strong> </p><h3>3. Formats & Technique</h3><p><strong>Dimensions Print (A3, A0, Abribus...) :</strong> </p><p><strong>Déclinaisons web (Post Insta, Story, Bannières) :</strong> </p><p><strong>Spécifications Imprimeur :</strong> </p><h3>4. Calendrier</h3><p><strong>Date validation BAT :</strong> </p><p><strong>Lancement campagne :</strong> </p>`,
        logo: `<h2>BRIEF CRÉATIF — LOGO & IDENTITÉ VISUELLE</h2><h3>1. Entreprise & Valeurs</h3><p><strong>Nom & Activité :</strong> </p><p><strong>Cible / Audience :</strong> </p><p><strong>Valeurs (3 à 5 mots clés) :</strong> </p><h3>2. Orientations Graphiques</h3><p><strong>Style visuel (Minimaliste, Illustré, Emblème...) :</strong> </p><p><strong>Préférences couleurs & typographies :</strong> </p><p><strong>Concurrence & Inspirations :</strong> </p><h3>3. Livrables & Supports</h3><p><strong>Déclinaisons logo (Principal, Secondaire, Picto) :</strong> </p><p><strong>Charte Graphique / Guide d'usage :</strong> </p><p><strong>Supports de communication prévus :</strong> </p><h3>4. Planning & Droits</h3><p><strong>Deadline de livraison :</strong> </p><p><strong>Périmètre des droits d'auteur :</strong> </p>`
    };
    if (templates[type]) appendToEditor(templates[type]);
}

/* ---------------------------------------------------------------------
   DÉCOMPILATEUR IA (Gemini — clé stockée uniquement dans ce navigateur)
   --------------------------------------------------------------------- */
function openDecompilerModal() {
    document.getElementById('decompiler-no-key').classList.toggle('hidden', !!lsGet(LS.geminiKey));
    openModal('decompiler-modal');
}

function setupDropZone() {
    const dropZone = document.getElementById('drop-zone');
    if (!dropZone) return;
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('bg-[#CEB694]/20'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('bg-[#CEB694]/20'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('bg-[#CEB694]/20');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
    });
}

function handleFileSelect(e) { if (e.target.files && e.target.files[0]) processFile(e.target.files[0]); }

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

async function analyzeImageWithGemini() {
    if (!currentBase64Image) return;
    const apiKey = lsGet(LS.geminiKey);
    if (!apiKey) {
        document.getElementById('decompiler-no-key').classList.remove('hidden');
        return;
    }
    const model = lsGet(LS.geminiModel) || DEFAULT_GEMINI_MODEL;

    const output = document.getElementById('analysis-text-output');
    const btn = document.getElementById('btn-analyze');
    document.getElementById('analysis-loading').classList.remove('hidden');
    document.getElementById('analysis-result-container').classList.add('hidden');
    btn.disabled = true;

    const prompt = `Tu es l'assistant de PhantStudio (studio de création graphique : illustration, papeterie mariage, faire-parts, logos, affiches).
Analyse cette capture d'écran de conversation ou note client et extrais les informations de manière structurée :

1. CLIENT : Nom, Prénom, Coordonnées (s'ils sont visibles)
2. PROJET & BESOINS : Type de projet (Papeterie, Logo, Affiche, etc.), Quantités, Formats, Finitions, Couleurs/Ambiance demandées.
3. DEADLINES & BUDGET : Dates mentionnées et budget.
4. COMPTE-RENDU RÉSUMÉ : Résumé synthétique de la demande sous forme de liste d'actions à exécuter.

Réponds en texte simple, sans mise en forme Markdown.`;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: currentImageMime, data: currentBase64Image } }
                    ]
                }]
            })
        });
        const result = await response.json();
        if (!response.ok) {
            const msg = result?.error?.message || `Erreur ${response.status}`;
            output.innerText = `L'IA a renvoyé une erreur :\n${msg}\n\nVérifiez la clé et le nom du modèle dans « Réglages & Sync ».`;
        } else {
            const parts = result?.candidates?.[0]?.content?.parts || [];
            output.innerText = parts.map(p => p.text || '').join('').trim() || 'Aucun texte renvoyé par l\'IA.';
        }
    } catch (err) {
        output.innerText = 'Impossible de joindre l\'IA (connexion Internet ?).';
    } finally {
        document.getElementById('analysis-loading').classList.add('hidden');
        document.getElementById('analysis-result-container').classList.remove('hidden');
        btn.disabled = false;
    }
}

function copyAnalysisToEditor() {
    const text = document.getElementById('analysis-text-output').innerText;
    appendToEditor(`<h2>DÉCOMPILATION IA — CONVERSATION CLIENT</h2><pre>${escapeHtml(text)}</pre>`);
    closeModal('decompiler-modal');
    switchTab('timer');
}

/* ---------------------------------------------------------------------
   HISTORIQUE & SESSIONS
   --------------------------------------------------------------------- */
function openSessionsModal() { renderSessions(); openModal('sessions-modal'); }

function renderSessions() {
    const tbody = document.getElementById('sessions-table-body');
    if (!tbody) return;
    if (appData.sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-[#1B1A18]/60">Aucune session enregistrée.</td></tr>';
        return;
    }
    tbody.innerHTML = sortedSessions(appData.sessions).map(s => {
        const p = getProject(s.projectId);
        return `
            <tr class="hover:bg-[#EFEEEC] transition border-b border-[#1B1A18]/20">
                <td class="py-3 px-4 text-xs font-semibold whitespace-nowrap">${escapeHtml(formatDateFr(s.date))}</td>
                <td class="py-3 px-4 font-bold">${p ? escapeHtml(p.name) : '<span class="text-[#CC0C33]">Projet supprimé</span>'}</td>
                <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-[4px] bg-[#CEB694] border border-[#1B1A18] text-xs font-semibold">${escapeHtml(s.category)}</span></td>
                <td class="py-3 px-4 font-extrabold text-[#CC0C33] whitespace-nowrap">${formatHours(Number(s.durationSeconds) || 0)}</td>
                <td class="py-3 px-4 text-xs">${escapeHtml(s.notes || '')}</td>
                <td class="py-3 px-4 text-right whitespace-nowrap space-x-2">
                    <button onclick="editSession('${escapeHtml(s.id)}')" class="text-xs underline font-bold hover:text-[#CC0C33]">Éditer</button>
                    <button onclick="deleteSession('${escapeHtml(s.id)}')" class="text-xs text-red-600 underline font-bold">Supprimer</button>
                </td>
            </tr>`;
    }).join('');
}

function deleteSession(id) {
    if (!confirm('Supprimer cette session ?')) return;
    const s = appData.sessions.find(x => x.id === id);
    appData.sessions = appData.sessions.filter(x => x.id !== id);
    commitChange();
    refreshProjectDetailIfOpen(s && s.projectId);
}

function openManualSessionModal(sessionId = null) {
    populateSelects();
    const form = document.getElementById('manual-session-form');
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
        form.reset();
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
    refreshProjectDetailIfOpen(sessionData.projectId);
}

/* ---------------------------------------------------------------------
   PROJETS
   --------------------------------------------------------------------- */
let openProjectDetailId = null;

function refreshProjectDetailIfOpen(projectId) {
    const modal = document.getElementById('project-detail-modal');
    if (!modal.classList.contains('hidden') && openProjectDetailId && (!projectId || projectId === openProjectDetailId)) {
        openProjectDetailModal(openProjectDetailId);
    }
}

function openProjectDetailModal(projectId) {
    const p = getProject(projectId);
    if (!p) return;
    openProjectDetailId = projectId;
    const client = getClient(p.clientId);
    const projSessions = sortedSessions(projectSessions(p.id));
    const totalSecs = sumSecs(projSessions);
    const revenue = (totalSecs / 3600) * (Number(p.hourlyRate) || 0);

    document.getElementById('modal-project-title').innerText = `Projet : ${p.name}`;

    const rows = projSessions.length === 0
        ? `<tr><td colspan="5" class="p-4 text-center text-gray-500">Aucune session enregistrée pour ce projet.</td></tr>`
        : projSessions.map(s => `
            <tr class="border-b border-gray-200 hover:bg-gray-50">
                <td class="p-2 whitespace-nowrap">${escapeHtml(formatDateFr(s.date))}</td>
                <td class="p-2">${escapeHtml(s.category)}</td>
                <td class="p-2 font-bold text-[#CC0C33] whitespace-nowrap">${formatHours(Number(s.durationSeconds) || 0)}</td>
                <td class="p-2">${escapeHtml(s.notes || '')}</td>
                <td class="p-2 text-right whitespace-nowrap space-x-2">
                    <button onclick="editSession('${escapeHtml(s.id)}')" class="underline font-bold">Éditer</button>
                    <button onclick="deleteSession('${escapeHtml(s.id)}')" class="underline font-bold text-red-600">Suppr.</button>
                </td>
            </tr>`).join('');

    document.getElementById('modal-project-content').innerHTML = `
        <div class="bg-white border-2 border-[#1B1A18] p-4 rounded-[6px] space-y-2 shadow-[2px_2px_0px_#1B1A18]">
            <p class="text-sm"><strong>Client :</strong> ${client ? escapeHtml(clientName(client)) + (client.company ? ' (' + escapeHtml(client.company) + ')' : '') : 'Inconnu'}</p>
            <p class="text-sm"><strong>Statut :</strong> ${escapeHtml(p.status)}</p>
            ${p.deadline ? `<p class="text-sm">${deadlineBadge(p)}</p>` : ''}
            <p class="text-sm"><strong>Taux horaire :</strong> ${escapeHtml(p.hourlyRate)} €/h</p>
            ${p.hasBudget && p.hourBudget ? `<p class="text-sm"><strong>Budget d'heures :</strong> ${escapeHtml(p.hourBudget)}h (${formatEuro(p.hourBudget * (Number(p.hourlyRate) || 0))})</p>` : ''}
            <p class="text-sm"><strong>Temps total passé :</strong> <span class="text-[#CC0C33] font-bold">${formatHours(totalSecs)}</span> (${formatEuro(revenue)})</p>
            <p class="text-sm"><strong>Description :</strong> ${escapeHtml(p.description || 'Aucune')}</p>
        </div>
        <div class="space-y-3 pt-3">
            <div class="flex items-center justify-between">
                <h4 class="font-heading text-xl">Sessions de travail associées</h4>
                <button onclick="openManualSessionForProject('${escapeHtml(p.id)}')" class="retro-btn px-3 py-1 text-xs">Ajouter une session</button>
            </div>
            <div class="bg-white border-2 border-[#1B1A18] rounded-[6px] overflow-x-auto">
                <table class="w-full text-left text-xs">
                    <tr class="bg-[#CEB694] font-heading border-b-2 border-[#1B1A18]">
                        <th class="p-2">Date</th><th class="p-2">Catégorie</th><th class="p-2">Durée</th><th class="p-2">Notes</th><th class="p-2 text-right">Action</th>
                    </tr>
                    ${rows}
                </table>
            </div>
        </div>`;
    openModal('project-detail-modal');
}

function openManualSessionForProject(projectId) {
    openManualSessionModal();
    document.getElementById('manual-project-id').value = projectId;
}

function renderProjects() {
    const grid = document.getElementById('projects-grid');
    if (appData.projects.length === 0) {
        grid.innerHTML = '<p class="text-[#1B1A18]/60 col-span-full text-center py-8">Aucun projet configuré.</p>';
        return;
    }

    grid.innerHTML = sortedProjects().map(p => {
        const secs = sumSecs(projectSessions(p.id));
        const pct = p.hasBudget && p.hourBudget ? Math.round(((secs / 3600) / p.hourBudget) * 100) : 0;
        const budgetHtml = p.hasBudget && p.hourBudget ? `
            <div class="space-y-1 pt-2 border-t border-[#1B1A18]/20 text-xs">
                <div class="flex justify-between">
                    <span>Temps / Budget</span>
                    <span class="font-bold ${pct > 100 ? 'text-[#CC0C33]' : ''}">${formatHours(secs)} / ${escapeHtml(p.hourBudget)}h${pct > 100 ? ' ⚠️' : ''}</span>
                </div>
                <div class="w-full bg-[#EFEEEC] border border-[#1B1A18] rounded-full h-2 overflow-hidden">
                    <div class="${pct > 100 ? 'bg-[#1B1A18]' : 'bg-[#CC0C33]'} h-2 rounded-full" style="width: ${Math.min(pct, 100)}%"></div>
                </div>
            </div>` : `
            <div class="pt-2 border-t border-[#1B1A18]/20 text-xs font-semibold">
                <span>Temps total : <span class="text-[#CC0C33] font-bold">${formatHours(secs)}</span></span>
            </div>`;

        return `
            <div class="retro-box p-5 space-y-4 flex flex-col justify-between bg-white cursor-pointer hover:bg-[#EFEEEC] transition ${p.status === 'Terminé' ? 'opacity-70' : ''}" onclick="openProjectDetailModal('${escapeHtml(p.id)}')">
                <div class="space-y-2">
                    <div class="flex items-start justify-between gap-2">
                        <h3 class="font-heading text-xl text-[#1B1A18]">${escapeHtml(p.name)}</h3>
                        <span class="text-xs px-2 py-0.5 rounded-[4px] bg-[#CEB694] border border-[#1B1A18] font-bold shrink-0">${escapeHtml(p.status)}</span>
                    </div>
                    <p class="text-xs font-semibold text-[#1B1A18]/70">Client : ${escapeHtml(clientName(getClient(p.clientId)))}</p>
                    ${deadlineBadge(p)}
                    <p class="text-xs line-clamp-2">${escapeHtml(p.description || 'Aucune description')}</p>
                </div>
                ${budgetHtml}
                <div class="flex justify-end gap-2 pt-2" onclick="event.stopPropagation()">
                    <button onclick="editProject('${escapeHtml(p.id)}')" class="retro-btn-secondary px-2.5 py-1 text-xs font-bold">Éditer</button>
                    <button onclick="deleteProject('${escapeHtml(p.id)}')" class="retro-btn px-2.5 py-1 text-xs font-bold">Supprimer</button>
                </div>
            </div>`;
    }).join('');
}

function toggleBudgetInput() {
    const hasBudget = document.getElementById('project-has-budget').checked;
    document.getElementById('budget-container').classList.toggle('hidden', !hasBudget);
}

function openProjectModal(id = null) {
    populateSelects();
    document.getElementById('project-no-client-hint').classList.toggle('hidden', appData.clients.length > 0);
    if (id) {
        const p = getProject(id);
        if (!p) return;
        document.getElementById('project-modal-title').innerText = 'Modifier le projet';
        document.getElementById('project-id').value = p.id;
        document.getElementById('project-name').value = p.name;
        document.getElementById('project-client-id').value = p.clientId;
        document.getElementById('project-has-budget').checked = !!p.hasBudget;
        document.getElementById('project-hour-budget').value = p.hourBudget || 10;
        document.getElementById('project-hourly-rate').value = p.hourlyRate ?? DEFAULT_RATE;
        document.getElementById('project-status').value = p.status;
        document.getElementById('project-deadline').value = p.deadline || '';
        document.getElementById('project-description').value = p.description || '';
    } else {
        document.getElementById('project-modal-title').innerText = 'Nouveau projet';
        document.getElementById('project-form').reset();
        document.getElementById('project-id').value = '';
        document.getElementById('project-has-budget').checked = false;
    }
    toggleBudgetInput();
    openModal('project-modal');
}

function saveProject(e) {
    e.preventDefault();
    const id = document.getElementById('project-id').value;
    const existing = id ? getProject(id) : null;
    const hasBudget = document.getElementById('project-has-budget').checked;
    const rateRaw = parseFloat(document.getElementById('project-hourly-rate').value);

    const projData = {
        id: id || uid('p_'),
        createdAt: existing ? projectCreatedAt(existing) || new Date().toISOString() : new Date().toISOString(),
        name: document.getElementById('project-name').value.trim(),
        clientId: document.getElementById('project-client-id').value,
        hasBudget: hasBudget,
        hourBudget: hasBudget ? (parseFloat(document.getElementById('project-hour-budget').value) || 10) : null,
        hourlyRate: Number.isFinite(rateRaw) ? rateRaw : DEFAULT_RATE,
        status: document.getElementById('project-status').value,
        deadline: document.getElementById('project-deadline').value,
        description: document.getElementById('project-description').value.trim()
    };

    const index = id ? appData.projects.findIndex(p => p.id === id) : -1;
    if (index !== -1) appData.projects[index] = projData;
    else appData.projects.push(projData);

    commitChange();
    closeModal('project-modal');
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
    const msg = `Supprimer le projet « ${p.name} » ?` + (n ? `\n\nSes ${n} session(s) de travail seront aussi supprimées.` : '');
    if (!confirm(msg)) return;
    appData.projects = appData.projects.filter(x => x.id !== id);
    appData.sessions = appData.sessions.filter(s => s.projectId !== id);
    closeModal('project-detail-modal');
    commitChange();
}

/* ---------------------------------------------------------------------
   CLIENTS
   --------------------------------------------------------------------- */
function renderClients() {
    const grid = document.getElementById('clients-grid');
    if (appData.clients.length === 0) {
        grid.innerHTML = '<p class="text-[#1B1A18]/60 col-span-full text-center py-8">Aucun client.</p>';
        return;
    }
    grid.innerHTML = [...appData.clients].sort((a, b) => clientName(a).localeCompare(clientName(b), 'fr')).map(c => {
        const nbProjects = appData.projects.filter(p => p.clientId === c.id).length;
        return `
            <div class="retro-box p-5 space-y-3 bg-white flex flex-col justify-between">
                <div class="space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <h3 class="font-heading text-xl text-[#1B1A18]">${escapeHtml(clientName(c))}</h3>
                        <span class="text-xs px-2 py-0.5 rounded-[4px] bg-[#CEB694] border border-[#1B1A18] font-bold shrink-0">${escapeHtml(c.company || 'Particulier')}</span>
                    </div>
                    <p class="text-xs flex items-center gap-1.5"><i data-lucide="mail" class="w-3.5 h-3.5 text-[#CC0C33]"></i> ${c.email ? `<a class="underline" href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : 'N/A'}</p>
                    <p class="text-xs flex items-center gap-1.5"><i data-lucide="phone" class="w-3.5 h-3.5 text-[#02968A]"></i> ${c.phone ? `<a class="underline" href="tel:${escapeHtml(c.phone.replace(/\s/g, ''))}">${escapeHtml(c.phone)}</a>` : 'N/A'}</p>
                    <p class="text-xs pt-1 border-t border-[#1B1A18]/20"><strong>Facturation :</strong> ${escapeHtml(c.address || 'N/A')}</p>
                    ${c.deliveryAddress ? `<p class="text-xs"><strong>Livraison :</strong> ${escapeHtml(c.deliveryAddress)}</p>` : ''}
                    <p class="text-xs font-semibold text-[#1B1A18]/70">${nbProjects} projet(s)</p>
                </div>
                <div class="flex justify-end gap-2 pt-2 border-t border-[#1B1A18]/20">
                    <button onclick="editClient('${escapeHtml(c.id)}')" class="retro-btn-secondary px-2.5 py-1 text-xs font-bold">Éditer</button>
                    <button onclick="deleteClient('${escapeHtml(c.id)}')" class="retro-btn px-2.5 py-1 text-xs font-bold">Supprimer</button>
                </div>
            </div>`;
    }).join('');
}

function openClientModal(id = null) {
    if (id) {
        const c = getClient(id);
        if (!c) return;
        document.getElementById('client-modal-title').innerText = 'Modifier le client';
        document.getElementById('client-id').value = c.id;
        document.getElementById('client-firstname').value = c.firstname || '';
        document.getElementById('client-lastname').value = c.lastname || '';
        document.getElementById('client-company').value = c.company || '';
        document.getElementById('client-email').value = c.email || '';
        document.getElementById('client-phone').value = c.phone || '';
        document.getElementById('client-address').value = c.address || '';
        document.getElementById('client-delivery-address').value = c.deliveryAddress || '';
    } else {
        document.getElementById('client-modal-title').innerText = 'Nouveau client';
        document.getElementById('client-form').reset();
        document.getElementById('client-id').value = '';
    }
    openModal('client-modal');
}

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
    if (projIds.length) msg += `\n\n⚠️ Cela supprimera aussi ses ${projIds.length} projet(s) et ${nbSessions} session(s) de travail.`;
    if (!confirm(msg)) return;

    appData.clients = appData.clients.filter(x => x.id !== id);
    appData.projects = appData.projects.filter(p => p.clientId !== id);
    appData.sessions = appData.sessions.filter(s => !projIds.includes(s.projectId));
    commitChange();
}
