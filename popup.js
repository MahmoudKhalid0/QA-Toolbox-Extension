let profiles = [];
let currentFields = [];
let isRecording = false;

// The pull timer runs every minute at best - opening the panel is also a
// good moment to ask, so a change made on another device shows up sooner.
chrome.runtime.sendMessage({ action: 'pullNow' }).catch(() => { });

// Make sure the content script is alive in the tab. Content scripts die whenever
// the extension is reloaded, so pages opened before the reload need re-injection.
async function ensureContentScript(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'getRecordingStatus' });
        return true;
    } catch (e) {
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            await new Promise(resolve => setTimeout(resolve, 150));
            return true;
        } catch (err) {
            console.warn('Could not inject content script:', err);
            return false;
        }
    }
}
let appendToId = null;
let expandedCategories = new Set();
let availableCategories = []; // Global list of category names
let userExpandedCategories = new Set(); // To remember state before search
let currentTabUrl = '';

// Open one of our own pages BESIDE the tab the user is looking at, in that same
// window. chrome.tabs.create with no index sends it to the far end of the strip -
// with a row of tabs open, the editor or the gallery you just asked for turns up
// somewhere off to the right and you have to go and find it. openerTabId also means
// closing it returns you to where you were, instead of dumping you anywhere.
async function qaOpenTabBeside(path) {
    const url = /^https?:/i.test(path) ? path : chrome.runtime.getURL(path);
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t && typeof t.index === 'number') {
        chrome.tabs.create({ url, index: t.index + 1, windowId: t.windowId, openerTabId: t.id });
    } else {
        chrome.tabs.create({ url });     // no active tab to sit beside - let Chrome decide
    }
}
let smartFilterActive = true;

// ── Reusable in-panel confirm / prompt ──────────────────────────────────────
// Use these EVERYWHERE instead of the browser's confirm()/prompt()/alert(),
// which render as a jarring "The extension … says" system box. Both return a
// Promise (confirm -> boolean, prompt -> string|null). Exposed as globals so the
// other panel scripts (tempmail.js, sessions.js …) can call them directly, the
// same way they already call showToastMessage. See memory: in-panel dialogs.
function qaDialog({ mode = 'confirm', title = 'Are you sure?', message = '', okText, cancelText = 'Cancel', danger = false, value = '', placeholder = '', icon } = {}) {
    return new Promise((resolve) => {
        const root = document.getElementById('qaDialog');
        if (!root) { // markup missing - fail safe to the native path rather than hang
            if (mode === 'prompt') resolve(window.prompt(title, value));
            else resolve(window.confirm(message || title));
            return;
        }
        const box = root.querySelector('.qa-dialog-box');
        const titleEl = document.getElementById('qaDialogTitle');
        const msgEl = document.getElementById('qaDialogMsg');
        const input = document.getElementById('qaDialogInput');
        const okBtn = document.getElementById('qaDialogOk');
        const cancelBtn = document.getElementById('qaDialogCancel');
        const iconEl = document.getElementById('qaDialogIc');

        titleEl.textContent = title;
        msgEl.textContent = message;
        msgEl.style.display = message ? '' : 'none';
        okBtn.textContent = okText || (mode === 'prompt' ? 'Save' : 'OK');
        cancelBtn.textContent = cancelText;
        root.classList.toggle('danger', !!danger);
        iconEl.innerHTML = `<i class="fas ${icon || (danger ? 'fa-triangle-exclamation' : (mode === 'prompt' ? 'fa-pen' : 'fa-circle-question'))}"></i>`;

        if (mode === 'prompt') {
            input.style.display = '';
            input.value = value;
            input.placeholder = placeholder;
        } else {
            input.style.display = 'none';
        }

        // One close path for every exit (button, Esc, overlay click), so listeners
        // never leak across successive dialogs.
        function close(result) {
            root.classList.remove('show');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            root.removeEventListener('mousedown', onOverlay);
            document.removeEventListener('keydown', onKey);
            input.removeEventListener('keydown', onInputKey);
            resolve(result);
        }
        const onOk = () => close(mode === 'prompt' ? input.value.trim() : true);
        const onCancel = () => close(mode === 'prompt' ? null : false);
        const onOverlay = (e) => { if (e.target === root) onCancel(); };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            else if (e.key === 'Enter' && mode === 'confirm') { e.preventDefault(); onOk(); }
        };
        const onInputKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        root.addEventListener('mousedown', onOverlay);
        document.addEventListener('keydown', onKey);
        if (mode === 'prompt') input.addEventListener('keydown', onInputKey);

        root.classList.add('show');
        // Focus after paint: the input for a prompt, the OK button otherwise.
        setTimeout(() => { (mode === 'prompt' ? input : okBtn).focus(); if (mode === 'prompt') input.select(); }, 30);
    });
}
function qaConfirm(opts) { return qaDialog({ ...opts, mode: 'confirm' }); }
function qaPrompt(opts) { return qaDialog({ ...opts, mode: 'prompt' }); }

// Load profiles
document.addEventListener('DOMContentLoaded', async () => {
    // Get current tab URL for smart filtering
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tabs[0]?.url || '';

    await loadProfiles();
    await loadCategories();

    // Settings Button - Open separate tab
    document.getElementById('settingsBtn').addEventListener('click', () => {
        qaOpenTabBeside('settings.html');
    });

    // Header Login button: opens settings and starts the Google sign-in there
    document.getElementById('loginBtn').addEventListener('click', () => {
        qaOpenTabBeside('settings.html?signin=1');
    });

    // Smart Filter "Show All"
    document.getElementById('showAllBtn').addEventListener('click', () => {
        smartFilterActive = false;
        renderProfiles();
    });

    // Check if already recording - first from storage, then from content script
    const storageResult = await chrome.storage.sync.get(['appendToProfileId', 'isRecordingActive']);
    appendToId = storageResult.appendToProfileId || null;
    isRecording = storageResult.isRecordingActive || false;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // First check storage for recording state
    if (storageResult.isRecordingActive) {
        isRecording = true;
        updateRecordButton();
    } else {
        // Then try to get status from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getRecordingStatus' });
            if (response && response.isRecording) {
                isRecording = true;
                updateRecordButton();
            } else {
                // Not recording, clean up
                if (appendToId) {
                    await chrome.storage.sync.remove('appendToProfileId');
                    appendToId = null;
                }
                isRecording = false;
                updateRecordButton();
            }
        } catch (e) {
            // Content script not available - check storage to determine state
            if (storageResult.isRecordingActive) {
                isRecording = true;
                updateRecordButton();
            } else {
                // Clean up stale state
                if (appendToId) {
                    await chrome.storage.sync.remove('appendToProfileId');
                    appendToId = null;
                }
                isRecording = false;
            }
        }
    }

    renderProfiles();

    // Search input handler
    document.getElementById('searchInput').addEventListener('input', () => {
        renderProfiles();
    });

    // Category filter handler
    document.getElementById('categoryFilter').addEventListener('change', () => {
        renderProfiles();
    });
});

// Record button
document.getElementById('recordBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first to record', 'error');
        return;
    }

    if (!isRecording) {
        // Limit: max 5 profiles per exact URL - block before recording even starts
        try {
            const normalizeUrl = (u) => String(u || '').split('#')[0].trim().replace(/\/+$/, '');
            const currentUrl = normalizeUrl(tab.url);
            const sameUrlCount = (profiles || []).filter(p => p && p.url && normalizeUrl(p.url) === currentUrl).length;
            if (sameUrlCount >= 5) {
                showToastMessage('Limit reached: 5 profiles already exist for this page', 'error');
                return;
            }
        } catch (e) { }

        await ensureContentScript(tab.id);

        try {
            appendToId = null;
            await chrome.storage.sync.remove('appendToProfileId');
            await chrome.storage.sync.set({ isRecordingActive: true });

            await chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
            isRecording = true;
            updateRecordButton();
            renderProfiles();
            // Side panel stays open - the user stops recording from here
        } catch (e) {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            setTimeout(async () => {
                appendToId = null;
                await chrome.storage.sync.remove('appendToProfileId');
                await chrome.storage.sync.set({ isRecordingActive: true });
                await chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
                isRecording = true;
                updateRecordButton();
                renderProfiles();
            }, 100);
        }
    } else {
        // Try to stop recording
        let fields = null;
        let recordedUrl = '';

        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'stopRecording' });
            if (response && response.fields) {
                fields = response.fields;
                recordedUrl = response.url || '';
            }
        } catch (e) {
            // Content script not available - try to get fields from storage
            console.log('Content script not available, checking storage...');
            try {
                const storageData = await chrome.storage.local.get(['recordedFields', 'recordedUrl']);
                if (storageData.recordedFields && storageData.recordedFields.length > 0) {
                    fields = storageData.recordedFields;
                    recordedUrl = storageData.recordedUrl || '';
                }
            } catch (storageErr) {
                console.log('Storage check failed:', storageErr);
            }
        }

        // Clean up recording state
        isRecording = false;
        updateRecordButton();

        // Get appendToProfileId before removing it
        const result = await chrome.storage.sync.get(['appendToProfileId']);
        const activeAppendId = appendToId || result.appendToProfileId;

        // Check if there are failed field selectors (replacement mode)
        const storageData = await chrome.storage.local.get(['failedFieldSelectors']);
        const hasFailedSelectors = storageData.failedFieldSelectors && storageData.failedFieldSelectors.length > 0;

        if (fields && fields.length > 0) {
            // Send to background to handle (supports replacement mode)
            chrome.runtime.sendMessage({
                action: 'handleStopRecording',
                fields: fields,
                url: recordedUrl,
                appendToProfileId: activeAppendId,
                isReplacementMode: hasFailedSelectors && activeAppendId ? true : false
            }, async (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Background error:', chrome.runtime.lastError);
                    showToastMessage('Error saving fields', 'error');
                } else {
                    if (response && response.success) {
                        if (activeAppendId && response.replacedCount !== undefined) {
                            showToastMessage(`Replaced ${response.replacedCount} field(s)`, 'success');
                        } else if (activeAppendId && response.addedCount !== undefined) {
                            showToastMessage(`Added ${response.addedCount} new field(s)`, 'success');
                        } else if (response.noNewFields) {
                            showToastMessage('No new fields to add', 'error');
                        } else if (response.newProfile) {
                            showToastMessage('New profile created', 'success');
                        }
                    }
                }

                // Clean up
                await chrome.storage.sync.remove(['isRecordingActive', 'appendToProfileId']);
                await chrome.storage.local.remove(['recordedFields', 'recordedUrl', 'failedFieldSelectors', 'profileIdForReplacement']);
                appendToId = null;
                renderProfiles();
            });
        } else {
            showToastMessage('No fields recorded', 'error');
            // Tell background even with 0 fields so its in-memory recording state clears
            chrome.runtime.sendMessage({ action: 'handleStopRecording', fields: [], url: '', appendToProfileId: activeAppendId });
            await chrome.storage.sync.remove(['isRecordingActive', 'appendToProfileId']);
            await chrome.storage.local.remove(['recordedFields', 'recordedUrl', 'failedFieldSelectors', 'profileIdForReplacement']);
            appendToId = null;
            renderProfiles();
        }
    }
});

// Tab navigation (Profiles / Tools) - remembers the last open tab
function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + name));
    try { localStorage.setItem('qaToolboxActiveTab', name); } catch (e) { }
    if (name === 'tools') qaRefreshImagesBadge();
}

// Shows how many images are on the page the moment the Tools tab is visible
// - a read-only count, not the full "Page Images" scan/panel, so it never
// waits for (or requires) the user to click the tool first.
async function qaRefreshImagesBadge() {
    const badge = document.getElementById('imagesCountBadge');
    if (!badge) return;
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) return;
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'countPageImages' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        badge.textContent = String(resp.count);
        badge.style.display = resp.count > 0 ? '' : 'none';
    });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

try {
    const savedTab = localStorage.getItem('qaToolboxActiveTab');
    if (['tools', 'debug', 'mail', 'sessions'].includes(savedTab)) switchTab(savedTab);
} catch (e) { }

// The side panel stays open across tab switches - keep the smart filter and
// recording state in sync with whatever tab the user is looking at
async function refreshCurrentTabContext() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const newUrl = tabs[0]?.url || '';
        if (newUrl !== currentTabUrl) {
            currentTabUrl = newUrl;
            smartFilterActive = true;
            renderProfiles();
        }
    } catch (e) { }
}

// Recording was stopped from the on-page indicator - sync the panel UI
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'recordingStopped' && isRecording) {
        isRecording = false;
        appendToId = null;
        updateRecordButton();
        renderProfiles();
    }
    // Recording started elsewhere (e.g. the on-page re-record modal) - reflect it
    if (request.action === 'recordingUiSync' && request.isRecording) {
        isRecording = true;
        appendToId = request.appendToProfileId || null;
        updateRecordButton();
        renderProfiles();
    }
    // Profiles changed elsewhere (recording saved, editor, AI, cloud sync) -
    // reload so the open panel always shows fresh data
    if (request.action === 'profilesUpdated') {
        (async () => {
            await loadProfiles();
            await loadCategories();
            renderProfiles();
        })();
    }
    // Cloud sync activity - reflect it in the header indicator
    if (request.action === 'syncStateChanged') {
        updateSyncIndicator(request.state);
    }
});

function updateSyncIndicator(state) {
    const el = document.getElementById('syncIndicator');
    const loginBtn = document.getElementById('loginBtn');
    if (!el) return;
    if (state === 'signedout' || state === 'hidden') {
        el.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'inline-flex';
        return;
    }
    if (loginBtn) loginBtn.style.display = 'none';
    el.style.display = 'inline-flex';
    el.classList.toggle('syncing', state === 'syncing');
    el.classList.toggle('error', state === 'error');
    el.querySelector('i').className = state === 'syncing' ? 'fas fa-arrows-rotate' : 'fas fa-cloud';
    el.title = state === 'syncing' ? 'Syncing...'
        : state === 'error' ? 'Sync failed - check Settings'
            : state === 'done' ? 'Synced just now' : 'Cloud sync is on';
}

// Show the cloud icon if already signed in to sync, or the Login button if not
chrome.runtime.sendMessage({ action: 'syncStatus' }, (meta) => {
    if (chrome.runtime.lastError) return;
    if (meta && meta.signedIn) updateSyncIndicator(meta.lastError ? 'error' : 'idle');
    else updateSyncIndicator('signedout');
});

if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(refreshCurrentTabContext);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (tab && tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
            refreshCurrentTabContext();
        }
    });
}

function updateRecordButton() {
    const btn = document.getElementById('recordBtn');
    if (isRecording) {
        btn.innerHTML = '<i class="fas fa-stop"></i><span class="btn-label">Stop</span>';
        btn.title = 'Stop Recording';
        btn.classList.add('recording');
    } else {
        btn.innerHTML = '<i class="fas fa-circle"></i><span class="btn-label">Record</span>';
        btn.title = 'Record Form';
        btn.classList.remove('recording');
    }
}

document.getElementById('addBtn').addEventListener('click', () => {
    qaOpenTabBeside('editor.html?new=true');
});

// Tools tab accordion: opening one expandable tool collapses the others
const TOOL_SECTIONS = [
    { card: 'capToolBtn', panel: 'capOptions' },
    { card: 'inspectorToolBtn', panel: 'inspectorOptions' },
    { card: 'autoToolBtn', panel: 'autoOptions' },
    { card: 'autorefreshToolBtn', panel: 'autorefreshOptions' }
];
function toggleToolSection(cardId, panelId) {
    const willOpen = document.getElementById(panelId).classList.contains('hidden');
    TOOL_SECTIONS.forEach(s => {
        const open = s.panel === panelId && willOpen;
        document.getElementById(s.card).classList.toggle('open', open);
        document.getElementById(s.panel).classList.toggle('hidden', !open);
    });
}

// Open one outright, rather than toggling it. Used when a recording starts: its
// Stop button must not be sitting behind a fold.
function openToolSection(panelId) {
    TOOL_SECTIONS.forEach(s => {
        const open = s.panel === panelId;
        document.getElementById(s.card).classList.toggle('open', open);
        document.getElementById(s.panel).classList.toggle('hidden', !open);
    });
}

// Highlight which inspect tool is currently picking; cleared when picking ends
const INSPECT_TOOL_IDS = ['inspectBtn', 'xpathBtn', 'aiXpathBtn', 'ocrBtn'];
let inspectStartingGuard = false;

// Every tool across every family (picking-mode, panel-based, and the
// "opens its own on-page panel" tools) - exactly one of these, or none, is
// ever the single active/highlighted one at a time. Extend this list when a
// new tool is added instead of wiring its own one-off clearing logic.
const ALL_TOOL_BTN_IDS = [
    'inspectBtn', 'xpathBtn', 'aiXpathBtn', 'ocrBtn', 'measureBtn', 'autoToolBtn',
    'linksToolBtn', 'perfToolBtn', 'imagesToolBtn',
    'storageToolBtn', 'responsiveToolBtn', 'textMatchToolBtn', 'apiExportToolBtn', 'timeMachineToolBtn'
];

// Which accordion (if any) must stay open for a given tool button - derived
// from the actual DOM, so a sub-tool like Measure that lives INSIDE the
// Inspector accordion keeps that accordion open instead of collapsing the
// very panel it sits in. An accordion's own header card keeps itself open;
// a tool that lives in no accordion returns null (collapse them all).
function accordionCardToKeepFor(id) {
    if (!id) return null;
    const section = TOOL_SECTIONS.find(s => s.card === id);
    if (section) return section.card;                 // the accordion header itself
    const el = document.getElementById(id);
    const panel = el && el.closest('.tool-options');  // a sub-option inside an accordion panel
    if (!panel) return null;
    return (TOOL_SECTIONS.find(s => s.panel === panel.id) || {}).card || null;
}

function collapseAccordionsExcept(keepCardId) {
    TOOL_SECTIONS.forEach((s) => {
        if (s.card === keepCardId) return;
        document.getElementById(s.card)?.classList.remove('open');
        document.getElementById(s.panel)?.classList.add('hidden');
    });
}

// Marks exactly one tool (by button id) as the active one, clearing every
// other tool AND collapsing whichever accordion the active tool doesn't
// belong to. Pass null/undefined to mean "nothing is active".
function qaSetOnlyActive(id) {
    ALL_TOOL_BTN_IDS.forEach((t) => {
        const el = document.getElementById(t);
        if (el) el.classList.toggle('active', t === id);
    });
    collapseAccordionsExcept(accordionCardToKeepFor(id));
}

// Safety net, independent of any single handler remembering to call
// qaSetOnlyActive(): the instant ANY tool card/option is clicked, clear
// every OTHER tool immediately (capture phase, before the async round trip
// to content.js even starts) - several tools (Storage, Responsive Viewer,
// Text Match, API Export, Time Machine) had no active-state wiring at all
// until now precisely because this used to be done by hand, tool by tool.
document.getElementById('tab-tools')?.addEventListener('click', (e) => {
    const card = e.target.closest('.tool-card, .tool-option');
    if (!card || !card.id) return;
    ALL_TOOL_BTN_IDS.forEach((t) => { if (t !== card.id) document.getElementById(t)?.classList.remove('active'); });
    collapseAccordionsExcept(accordionCardToKeepFor(card.id));
}, true);

function markActiveTool(id) {
    qaSetOnlyActive(id);
    // Ignore the immediate "ended" that fires from the content script's internal reset
    inspectStartingGuard = true;
    setTimeout(() => { inspectStartingGuard = false; }, 500);
}
function clearActiveTool() {
    INSPECT_TOOL_IDS.forEach(t => {
        const el = document.getElementById(t);
        if (el) el.classList.remove('active');
    });
}
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'inspectModeEnded' && !inspectStartingGuard) clearActiveTool();
    if (request.action === 'measureEnded') {
        const m = document.getElementById('measureBtn');
        if (m) m.classList.remove('active');
    }
});

// Element Inspector button - hover-highlight picking, then a properties/style panel
// Inspector card: expand/collapse the three inspect-tool options
document.getElementById('inspectorToolBtn').addEventListener('click', () => {
    toggleToolSection('inspectorToolBtn', 'inspectorOptions');
});

// ── Auto Refresh card ──
(function setupAutoRefresh() {
    const card = document.getElementById('autorefreshToolBtn');
    if (!card) return;
    const secInput = document.getElementById('arSeconds');
    const startBtn = document.getElementById('arStartBtn');
    const msg = document.getElementById('arStatusMsg');
    const listEl = document.getElementById('arList');

    const hostOf = (u) => { try { return new URL(u).host || u; } catch (e) { return u || ''; } };
    function renderList() {
        chrome.runtime.sendMessage({ action: 'arList' }, (r) => {
            const items = (r && r.items) || [];
            if (!items.length) { listEl.innerHTML = '<div style="font-size:11.5px;color:#64748b;padding:4px 2px;">No tabs are auto-refreshing.</div>'; return; }
            listEl.innerHTML = '<div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin:4px 2px;">Active</div>'
                + items.map(it => `<div class="ar-item" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border-radius:8px;padding:7px 10px;margin-bottom:4px;font-size:12px;">
                    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(it.url || '')}">${escapeHtml(hostOf(it.url))}</span>
                    <span style="color:#fbbf24;flex-shrink:0;">${it.seconds}s</span>
                    <button class="dbg-btn" data-arstop="${it.tabId}" style="padding:3px 8px;">Stop</button>
                </div>`).join('');
        });
    }

    const isOpen = () => { const p = document.getElementById('autorefreshOptions'); return p && !p.classList.contains('hidden'); };
    async function refreshUI() {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (msg.style.color !== 'rgb(248, 113, 113)') { // don't clobber an error message
            msg.style.color = '#94a3b8';
            msg.textContent = t && t.url ? 'This tab: ' + hostOf(t.url) : '';
        }
        renderList();
    }

    card.addEventListener('click', () => { toggleToolSection('autorefreshToolBtn', 'autorefreshOptions'); if (isOpen()) refreshUI(); });
    startBtn.addEventListener('click', async () => {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!t || t.id == null) return;
        const s = Math.max(2, parseInt(secInput.value, 10) || 0);
        if (!s) { msg.style.color = '#f87171'; msg.textContent = 'Enter seconds (min 2)'; return; }
        secInput.value = s;
        chrome.runtime.sendMessage({ action: 'arSet', tabId: t.id, seconds: s }, () => refreshUI());
    });
    listEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-arstop]'); if (!b) return;
        chrome.runtime.sendMessage({ action: 'arStop', tabId: +b.dataset.arstop }, () => renderList());
    });
    // Keep "This tab" + the list live while the card is open (tab switches,
    // or stopping from the on-page badge)
    chrome.tabs.onActivated.addListener(() => { if (isOpen()) refreshUI(); });
    setInterval(() => { if (isOpen()) refreshUI(); }, 2000);
})();

// ── Cookies & Storage card → opens the viewer/editor panel on the page ──
document.getElementById('storageToolBtn').addEventListener('click', async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'openStorage' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'storageToolBtn' : null);
    });
});

// ── Responsive Viewer card → opens an overlay on the current page (same-origin
// iframes so cookies/login work and it renders exactly like the browser) ──
document.getElementById('responsiveToolBtn').addEventListener('click', async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'openResponsive' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'responsiveToolBtn' : null);
    });
});

// ── Text Match card → opens an on-page panel to check pasted text against the page ──
document.getElementById('textMatchToolBtn').addEventListener('click', async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'openTextMatch' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'textMatchToolBtn' : null);
    });
});

// ── API Data Export card → opens an on-page panel that replays a fetch & exports CSV ──
document.getElementById('apiExportToolBtn').addEventListener('click', async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'openApiExport' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'apiExportToolBtn' : null);
    });
});

document.getElementById('timeMachineToolBtn').addEventListener('click', async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'openTimeMachine' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'timeMachineToolBtn' : null);
    });
});

// ── Link Health card → runs in the page (content.js checks, colours links & shows the panel) ──
document.getElementById('linksToolBtn').addEventListener('click', async () => {
    const card = document.getElementById('linksToolBtn');
    if (card.classList.contains('scanning')) return;
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    card.classList.add('scanning');
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'runLinkHealth' }, () => {
        if (chrome.runtime.lastError) { card.classList.remove('scanning'); showToastMessage('Could not run on this page (reload it)', 'error'); }
        // otherwise keep "scanning" until content.js reports it finished (toolScanDone)
    });
});

// ── Page Images card → runs in the page (content.js finds img/svg, shows the panel) ──
document.getElementById('imagesToolBtn').addEventListener('click', async () => {
    const card = document.getElementById('imagesToolBtn');
    if (card.classList.contains('scanning')) return;
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
        showToastMessage('Open a website first', 'error'); return;
    }
    card.classList.add('scanning');
    await ensureContentScript(t.id);
    chrome.tabs.sendMessage(t.id, { action: 'runImagesFinder' }, () => {
        if (chrome.runtime.lastError) { card.classList.remove('scanning'); showToastMessage('Could not run on this page (reload it)', 'error'); }
        // otherwise keep "scanning" until content.js reports it finished (toolScanDone)
    });
});

document.getElementById('inspectBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }

    await ensureContentScript(tab.id);
    markActiveTool('inspectBtn');
    await chrome.tabs.sendMessage(tab.id, { action: 'startInspectMode' }).catch(() => { });

    showToastMessage('Pick an element on the page (Esc to cancel)', 'success');
});

// XPath Finder tools (extension-generated / AI-generated)
async function startXPathFinder(mode) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }

    await ensureContentScript(tab.id);
    markActiveTool(mode === 'ai' ? 'aiXpathBtn' : 'xpathBtn');
    await chrome.tabs.sendMessage(tab.id, { action: 'startXPathFinder', mode }).catch(() => { });

    showToastMessage('Pick an element on the page (Esc to cancel)', 'success');
}

document.getElementById('xpathBtn').addEventListener('click', () => startXPathFinder('extension'));
document.getElementById('aiXpathBtn').addEventListener('click', () => startXPathFinder('ai'));

// ── AI Automation Code ──────────────────────────────────────────────────────
// The framework decides which languages even exist (Java for Cypress is not a
// thing), so the language list is rebuilt from the framework rather than being a
// fixed list the user can put into an impossible state.
(function setupAutomationTool() {
    const A = window.AutomationGen;
    const card = document.getElementById('autoToolBtn');
    const fwSel = document.getElementById('autoFramework');
    const langSel = document.getElementById('autoLanguage');
    const pom = document.getElementById('autoPom');
    if (!A || !card || !fwSel) return;

    card.addEventListener('click', () => toggleToolSection('autoToolBtn', 'autoOptions'));

    for (const [id, f] of Object.entries(A.FRAMEWORKS)) {
        fwSel.appendChild(new Option(f.label, id));
    }

    const paintLanguages = (want) => {
        const langs = A.languagesFor(fwSel.value);
        langSel.innerHTML = '';
        for (const l of langs) langSel.appendChild(new Option(l.label, l.id));
        // Keep the language if the new framework can still be written in it -
        // switching Selenium->Playwright should not silently throw away "Python".
        langSel.value = langs.some(l => l.id === want) ? want : langs[0].id;
    };

    const save = () => chrome.storage.local.set({
        autoFramework: fwSel.value, autoLanguage: langSel.value, autoPom: pom.checked
    });

    chrome.storage.local.get(['autoFramework', 'autoLanguage', 'autoPom'], (r) => {
        fwSel.value = A.FRAMEWORKS[r.autoFramework] ? r.autoFramework : 'playwright';
        paintLanguages(r.autoLanguage);
        pom.checked = !!r.autoPom;
    });

    fwSel.addEventListener('change', () => { paintLanguages(langSel.value); save(); });
    langSel.addEventListener('change', save);
    pom.addEventListener('change', save);

    document.getElementById('autoPickBtn').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || /^(chrome|chrome-extension|edge|about):/i.test(tab.url)) {
            showToastMessage('Open a website first', 'error');
            return;
        }
        await ensureContentScript(tab.id);
        markActiveTool('autoToolBtn');
        // The settings ride along with the pick, so the page panel already knows
        // what it is generating for before the user has typed a word.
        // The labels ride along rather than the page loading automation.js just to
        // read two strings - the content script is injected into every page, and
        // this keeps it that much lighter.
        await chrome.tabs.sendMessage(tab.id, {
            action: 'startAutomationPicker',
            framework: fwSel.value,
            language: langSel.value,
            pom: pom.checked,
            frameworkLabel: A.FRAMEWORKS[fwSel.value].label,
            languageLabel: A.LANGUAGES[langSel.value].label,
        }).catch(() => { });
        // The panel stays open, exactly as it does for the Inspector and the XPath
        // finder. Only the capture tools close it, and only because they would
        // otherwise be in the shot.
        showToastMessage('Pick an element on the page (Esc to cancel)', 'success');
    });
})();

// Image Text Extractor (OCR) - pick an image, AI reads its text
document.getElementById('ocrBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }
    await ensureContentScript(tab.id);
    markActiveTool('ocrBtn');
    await chrome.tabs.sendMessage(tab.id, { action: 'startImageOcr' }).catch(() => { });
    showToastMessage('Pick an image on the page (Esc to cancel)', 'success');
});

// Measure - on-page overlay: sizes, padding/margin, gap between two elements
document.getElementById('measureBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'openMeasure' }, (resp) => {
        if (chrome.runtime.lastError) { showToastMessage('Could not open here (reload the page)', 'error'); return; }
        qaSetOnlyActive(resp && resp.open ? 'measureBtn' : null);
    });
});

// reflect the real overlay state on the Measure card when the panel (re)opens
(async function syncMeasureActive() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { action: 'measureStatus' }, (resp) => {
            if (chrome.runtime.lastError) return;
            const m = document.getElementById('measureBtn');
            if (m) m.classList.toggle('active', !!(resp && resp.open));
        });
    } catch (e) { }
})();

// ── Debug tab: Console logs (in-memory, capped) + AI explain ──
(function setupDebug() {
    let currentLevel = 'all';
    let logsCache = [];
    let viewingFindings = false;

    let mode = 'console';            // 'console' | 'network'
    let netCache = [];
    let netFilter = 'xhr';           // 'all' | 'failed' | 'xhr' | 'other' | 'saved'
    let netQuery = '';               // the search box
    let netSaved = [];               // saved requests (chrome.storage.local.qaSavedRequests)
    let netCompareA = null;          // first request picked for Compare
    // the list is re-read from the worker as new objects, so a request is known by its key
    const netKey = (r) => r ? `${r.ts}|${r.method}|${r.url}` : '';
    const isCompareA = (r) => !!netCompareA && netKey(netCompareA) === netKey(r);
    let netFilteredCache = [];
    let netViewingFindings = false;
    let lastConsoleSig = '';
    let lastNetSig = '';
    // A resource (img/js/css/font) captured via timing has status 0 when it is cross-origin
    // and opaque - that is UNKNOWN, not a failure. Only fetch/XHR treat status 0 as an error.
    const isResource = (r) => r.kind === 'resource';
    const isFailed = (r) => isResource(r) ? r.status >= 400 : (r.status === 0 || r.status >= 400);
    // A request that "worked" (HTTP 200) but whose ANSWER says it failed: IsSuccess: false,
    // success: false, or a non-empty error / errors / exception / errorMessage. Read from the
    // raw text, so a body that was cut short still counts. Returns the reason, or ''.
    function softFailReason(r) {
        if (isResource(r) || isFailed(r) || !r.resBody) return '';
        const t = String(r.resBody);
        let m = t.match(/"((?:is)?success|succeeded)"\s*:\s*false/i);
        if (m) return `${m[1]}: false`;
        m = t.match(/"(error|errors|exception|errormessage|errordescription)"\s*:\s*(?!null\b|""|\[\s*\]|\{\s*\}|false\b|0\b)("(?:\\.|[^"\\]){0,60}|[\[{\dt])/i);
        if (m) return m[1] + (m[2][0] === '"' ? ': ' + m[2].slice(1) : '');
        return '';
    }
    const isAnyFail = (r) => isFailed(r) || !!softFailReason(r);
    const sigOf = (arr) => { const l = arr[arr.length - 1]; return arr.length + ':' + (l ? (l.ts || '') + ':' + (l.count || '') : ''); };

    const dEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

    // Reduce a message to the "type" it belongs to, by blanking the parts that vary between
    // otherwise-identical errors: URLs, ids, and every number (line numbers, counts, timestamps).
    // So `... at dashboard:3939:40` and `... at dashboard:4068:40` become ONE type. This is
    // what lets a page throwing thousands of the same error collapse to a handful of kinds.
    function dbgTypeKey(msg) {
        return String(msg || '')
            .split('\n')[0]
            .replace(/https?:\/\/[^\s'")]+/gi, '«site»')
            .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '«id»')
            .replace(/0x[0-9a-f]+/gi, '«hex»')
            .replace(/\d+/g, '#')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140) || '(empty)';
    }

    const list = () => document.getElementById('dbgList');
    const status = () => document.getElementById('dbgStatus');
    async function activeTabId() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t ? t.id : null; }

    let filteredCache = [];

    function updateCounts() {
        const counts = { error: 0, warn: 0, log: 0 };
        logsCache.forEach(l => { counts[l.level] = (counts[l.level] || 0) + 1; });
        document.getElementById('dbg-c-all').textContent = logsCache.length;
        document.getElementById('dbg-c-error').textContent = counts.error;
        document.getElementById('dbg-c-warn').textContent = counts.warn;
        document.getElementById('dbg-c-log').textContent = counts.log;
        // Console mode badge (error count)
        const cb = document.getElementById('dbgConsoleBadge');
        if (cb) { cb.textContent = counts.error || ''; cb.classList.toggle('show', counts.error > 0); }
        updateTabBadge();
    }

    // The Debug tab button badge = console errors + failed network requests
    function updateTabBadge() {
        const consoleErrors = logsCache.filter(l => l.level === 'error').length;
        const netFailed = netCache.filter(isFailed).length;
        const total = consoleErrors + netFailed;
        const badge = document.getElementById('dbgTabBadge');
        if (badge) {
            badge.textContent = total ? total : '';
            badge.style.display = total ? 'inline-flex' : 'none';
        }
    }

    function render() {
        viewingFindings = false;
        lastConsoleSig = sigOf(logsCache);
        updateCounts();
        const filtered = currentLevel === 'all' ? logsCache : logsCache.filter(l => l.level === currentLevel);
        // Newest first
        filteredCache = filtered.slice().reverse();
        renderTypeSummary(filteredCache);
        if (!filteredCache.length) {
            list().innerHTML = '<div class="dbg-empty">No console messages captured yet.<br>Interact with the page and they\'ll show here.</div>';
            return;
        }
        const RENDER_CAP = 300; // keep the DOM light no matter how many were captured
        const note = filteredCache.length > RENDER_CAP
            ? `<div class="dbg-empty" style="padding:8px;">Showing newest ${RENDER_CAP} of ${filteredCache.length}.</div>` : '';
        list().innerHTML = note + filteredCache.slice(0, RENDER_CAP).map((l, i) =>
            `<div class="dbg-row ${dEsc(l.level)}" data-type="${dEsc(dbgTypeKey(l.message))}">
                <span class="dbg-msg">${dEsc(l.message)}</span>
                ${l.count > 1 ? `<span class="dbg-count">×${l.count}</span>` : ''}
                ${l.source ? `<span class="dbg-src" data-src="${dEsc(l.source)}" title="Click to copy location">${dEsc(l.source)}</span>` : ''}
                <button class="dbg-copy" data-i="${i}" title="Copy"><i class="fas fa-copy"></i></button>
            </div>`).join('');
    }

    // Group the visible messages by type and show one chip per distinct kind, most-frequent
    // first, so the user can see WHAT the flood is made of instead of scrolling thousands of
    // near-identical lines. Only shown when grouping actually helps (more than one type, and
    // fewer types than messages).
    const MAX_TYPES = 15;
    function renderTypeSummary(rows) {
        const box = document.getElementById('dbgTypes');
        if (!box) return;
        const groups = new Map();
        for (const l of rows) {
            const key = dbgTypeKey(l.message);
            const g = groups.get(key) || { key, level: l.level, count: 0 };
            g.count += (l.count || 1);
            // an error anywhere in the group colours the whole group
            if (l.level === 'error') g.level = 'error';
            else if (l.level === 'warn' && g.level !== 'error') g.level = 'warn';
            groups.set(key, g);
        }
        const types = [...groups.values()].sort((a, b) => b.count - a.count);
        if (types.length < 2 || types.length >= rows.length) { box.innerHTML = ''; return; }

        const shown = types.slice(0, MAX_TYPES);
        const hiddenCount = types.length - shown.length;
        box.innerHTML =
            `<div class="dbg-types-head">${types.length} distinct type${types.length === 1 ? '' : 's'}`
            + (hiddenCount > 0 ? ` &middot; showing top ${shown.length}` : '') + `</div>`
            + shown.map(t =>
                `<button class="dbg-type t-${dEsc(t.level)}" data-type="${dEsc(t.key)}">
                    <span class="dbg-type-msg">${dEsc(t.key)}</span>
                    <span class="dbg-type-count">${t.count}</span>
                    <i class="fas fa-arrow-down dbg-type-go"></i>
                </button>`).join('');
    }

    // Click a type chip -> scroll to its newest example in the list and flash it.
    function flashRow(row) {
        row.classList.remove('dbg-flash');
        void row.offsetWidth;            // restart the animation if the same chip is clicked twice
        row.classList.add('dbg-flash');
    }
    document.getElementById('dbgTypes').addEventListener('click', (e) => {
        const chip = e.target.closest('.dbg-type');
        if (!chip) return;
        const key = chip.dataset.type;
        const row = [...list().querySelectorAll('.dbg-row')].find(r => r.dataset.type === key);
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Flash only once the row is actually IN VIEW. With a smooth scroll to a row far down
        // the list, the animation used to play (and finish) while the list was still scrolling,
        // so by the time the row arrived the highlight was already gone. Wait for it to land.
        if ('IntersectionObserver' in window) {
            let done = false;
            const io = new IntersectionObserver((entries) => {
                if (done) return;
                if (entries.some(en => en.isIntersecting && en.intersectionRatio > 0.5)) {
                    done = true; io.disconnect(); flashRow(row);
                }
            }, { threshold: [0.5] });
            io.observe(row);
            // Safety net for the "already visible, observer may not fire" case ONLY: flash on a
            // timer, but just if the row is actually on screen by then. A long smooth scroll can
            // still be running at this point, so flashing unconditionally would fire it off-screen.
            setTimeout(() => {
                if (done) return;
                const r = row.getBoundingClientRect();
                if (r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight)) {
                    done = true; io.disconnect(); flashRow(row);
                }
            }, 700);
        } else {
            flashRow(row);
        }
    });

    // Click the file:line location to copy just the location
    list().addEventListener('click', (e) => {
        const src = e.target.closest('.dbg-src');
        if (!src) return;
        navigator.clipboard.writeText(src.dataset.src || src.textContent).then(() => {
            const o = src.textContent;
            src.textContent = 'copied!';
            setTimeout(() => { src.textContent = o; }, 1000);
        }).catch(() => { });
    });

    // Copy a single row (message + source)
    list().addEventListener('click', (e) => {
        const btn = e.target.closest('.dbg-copy');
        if (!btn) return;
        const l = filteredCache[+btn.dataset.i];
        if (!l) return;
        const txt = l.message + (l.source ? '\n@ ' + l.source : '');
        navigator.clipboard.writeText(txt).then(() => {
            const o = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => { btn.innerHTML = o; }, 1200);
        }).catch(() => { });
    });

    function refresh() {
        activeTabId().then(id => {
            if (id == null) return;
            const visible = !document.getElementById('tab-debug').classList.contains('hidden');
            chrome.runtime.sendMessage({ action: 'getConsoleLogs', tabId: id }, (resp) => {
                if (chrome.runtime.lastError || !resp) return;
                logsCache = resp.logs || [];
                updateCounts(); // keep the tab badge live even when not on the Debug tab
                const sig = sigOf(logsCache);
                // Re-render only when the data actually changed, so clicks/selection survive the poll.
                // Only advance the signature when we actually render — otherwise data captured while
                // the panel is hidden would be marked "seen" and never show when it becomes visible.
                if (visible && mode === 'console' && !viewingFindings && sig !== lastConsoleSig) { lastConsoleSig = sig; render(); }
            });
            chrome.runtime.sendMessage({ action: 'getNetworkReqs', tabId: id }, (resp) => {
                if (chrome.runtime.lastError || !resp) return;
                netCache = resp.reqs || [];
                netUpdateCounts();
                const sig = sigOf(netCache);
                if (visible && mode === 'network' && !netViewingFindings && sig !== lastNetSig) { lastNetSig = sig; netRender(); }
            });
        });
    }

    document.querySelectorAll('.dbg-filter').forEach(b => b.addEventListener('click', () => {
        currentLevel = b.dataset.level;
        document.querySelectorAll('.dbg-filter').forEach(x => x.classList.toggle('active', x === b));
        if (!viewingFindings) render();
    }));

    document.getElementById('dbgClearBtn').addEventListener('click', async () => {
        const id = await activeTabId(); if (id == null) return;
        chrome.runtime.sendMessage({ action: 'clearConsoleLogs', tabId: id }, () => {
            logsCache = []; status().textContent = ''; render();
        });
    });

    document.getElementById('dbgExplainBtn').addEventListener('click', async () => {
        const ew = logsCache.filter(l => l.level === 'error' || l.level === 'warn');
        if (!ew.length) { status().style.color = '#f87171'; status().textContent = 'No errors or warnings to explain.'; return; }
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        const btn = document.getElementById('dbgExplainBtn');
        btn.disabled = true;
        status().style.color = '#94a3b8';
        status().innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing ' + ew.length + ' issue(s) with AI…';
        chrome.runtime.sendMessage({ action: 'aiExplainConsole', logs: logsCache, url: t && t.url }, (resp) => {
            btn.disabled = false;
            if (chrome.runtime.lastError || !resp || resp.error) {
                status().style.color = '#f87171';
                status().textContent = (resp && resp.error === 'no_api_key') ? 'AI key not configured' : 'Failed: ' + ((resp && resp.error) || 'error');
                return;
            }
            status().textContent = '';
            renderFindings(resp.findings || []);
        });
    });

    function renderFindings(findings) {
        viewingFindings = true;
        const head = '<div style="margin-bottom:8px;"><button class="dbg-btn" id="dbgBackBtn"><i class="fas fa-arrow-left"></i> Back to logs</button></div>';
        if (!findings.length) {
            list().innerHTML = head + '<div class="dbg-empty">The AI found nothing actionable.</div>';
        } else {
            list().innerHTML = head + findings.map(f =>
                `<div class="dbg-finding">
                    <h5>${dEsc(f.title)} <span class="sev ${dEsc(f.severity)}">${dEsc(f.severity)}</span></h5>
                    <p>${dEsc(f.cause)}</p>
                    <p class="fix"><i class="fas fa-lightbulb"></i> ${dEsc(f.fix)}</p>
                </div>`).join('');
        }
        document.getElementById('dbgBackBtn').addEventListener('click', () => {
            viewingFindings = false;
            render();        // show the logs we already have immediately
            refresh();       // and pull any that arrived during analysis
        });
    }

    // ── Network panel ──
    const netList = () => document.getElementById('netList');
    const netStatus = () => document.getElementById('netStatus');

    function statusClass(r) {
        // A resource with no status (opaque cross-origin) is unknown, not an error - stay neutral.
        if (r.status === 0) return isResource(r) ? 'sneutral' : 'serr';
        if (r.status >= 500) return 's5xx';
        if (r.status >= 400) return 's4xx';
        if (r.status >= 300) return 's3xx';
        return 's2xx';
    }

    function netUpdateCounts() {
        const failed = netCache.filter(isFailed).length;
        const other = netCache.filter(isResource).length;
        document.getElementById('net-c-all').textContent = netCache.length;
        document.getElementById('net-c-failed').textContent = netCache.filter(isAnyFail).length;   // incl. "200 but failed"
        const sc = document.getElementById('net-c-saved');
        if (sc) sc.textContent = netSaved.length;
        document.getElementById('net-c-xhr').textContent = netCache.length - other;
        const oc = document.getElementById('net-c-other');
        if (oc) oc.textContent = other;
        const nb = document.getElementById('dbgNetBadge');
        if (nb) { nb.textContent = failed || ''; nb.classList.toggle('show', failed > 0); }
        updateTabBadge();
    }

    // A request's NAME, like DevTools' Name column: the last part of the path
    // (DataActionGetMyRequests), not the whole URL - the full URL is on hover.
    function netName(url) {
        try {
            const u = new URL(url);
            const last = u.pathname.split('/').filter(Boolean).pop();
            return last ? decodeURIComponent(last) : u.host;
        } catch (e) { return url || ''; }
    }

    // ── Search: a request matches when the text is in its URL, headers, request body or
    // answer (any case) - so a RequestId or a transaction number finds every call that
    // carried it.
    function netMatches(r, q) {
        q = q.toLowerCase();
        const hay = [r.url, r.method, r.reqBody, r.resBody, JSON.stringify(r.reqHeaders || {}), JSON.stringify(r.resHeaders || {})];
        return hay.some((x) => x && String(x).toLowerCase().includes(q));
    }
    // WHERE in a request the search text is - shown on its row, so you know where to look
    function netMatchWhere(r, q) {
        q = q.toLowerCase();
        const has = (x) => x != null && String(x).toLowerCase().includes(q);
        return [has(r.resBody) && 'Response', has(r.reqBody) && 'Request body', has(r.url) && 'URL',
            (has(JSON.stringify(r.reqHeaders || {})) || has(JSON.stringify(r.resHeaders || {}))) && 'Headers'].filter(Boolean);
    }

    // Opened while searching: every hit inside the request is marked, the section with the
    // first one opens, and ↑ ↓ walk through them (opening their section as they go).
    function netMarkHits(detail, q) {
        if (!q) return;
        const ql = q.toLowerCase();
        const roots = [...detail.querySelectorAll('.nd-url, .nd-fold')].filter((el) => !(el.matches('.nd-fold') && /^Response Preview/.test(el.querySelector('summary').textContent.trim())));
        roots.forEach((root) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('summary') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
            const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
            nodes.forEach((node) => {
                const t = node.nodeValue, tl = t.toLowerCase();
                let i = tl.indexOf(ql); if (i < 0) return;
                const frag = document.createDocumentFragment(); let last = 0;
                while (i >= 0) {
                    frag.appendChild(document.createTextNode(t.slice(last, i)));
                    const m = document.createElement('mark'); m.className = 'nd-hit'; m.textContent = t.slice(i, i + q.length);
                    frag.appendChild(m);
                    last = i + q.length; i = tl.indexOf(ql, last);
                }
                frag.appendChild(document.createTextNode(t.slice(last)));
                node.parentNode.replaceChild(frag, node);
            });
        });
        const hits = [...detail.querySelectorAll('mark.nd-hit')];
        if (!hits.length) return;
        detail.insertAdjacentHTML('afterbegin', `<div class="nd-hitbar"><i class="fas fa-magnifying-glass"></i> <span class="nd-hitpos"></span>
            <button class="nd-hitnav" data-d="-1" title="Previous match"><i class="fas fa-chevron-up"></i></button><button class="nd-hitnav" data-d="1" title="Next match"><i class="fas fa-chevron-down"></i></button></div>`);
        let k = 0;
        const go = (to) => {
            k = (to + hits.length) % hits.length;
            hits.forEach((h) => h.classList.remove('cur'));
            const h = hits[k]; h.classList.add('cur');
            const fold = h.closest('details'); if (fold && !fold.open) fold.open = true;   // exclusive: the others close
            h.scrollIntoView({ block: 'center' });
            detail.querySelector('.nd-hitpos').textContent = `${k + 1} of ${hits.length}`;
        };
        detail.querySelector('.nd-hitbar').addEventListener('click', (e) => { const b = e.target.closest('.nd-hitnav'); if (b) { e.stopPropagation(); go(k + +b.dataset.d); } });
        go(0);
    }

    // ── Saved requests (chrome.storage.local.qaSavedRequests) ──
    // A request kept under a name, to open and send again later without pasting it.
    const NET_SAVED_KEY = 'qaSavedRequests';
    function netLoadSaved() {
        chrome.storage.local.get([NET_SAVED_KEY], (r) => {
            netSaved = (r && r[NET_SAVED_KEY]) || [];
            netUpdateCounts();
            if (netFilter === 'saved' && !netViewingFindings) netRender();
        });
    }
    const netStoreSaved = () => new Promise((res) => chrome.storage.local.set({ [NET_SAVED_KEY]: netSaved }, res));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[NET_SAVED_KEY]) netLoadSaved(); });
    netLoadSaved();

    function netRenderSaved() {
        netFilteredCache = [];
        let list = netSaved.slice().reverse();   // newest first
        if (netQuery) list = list.filter((r) => (r.name || '').toLowerCase().includes(netQuery.toLowerCase()) || netMatches(r, netQuery));
        if (!list.length) {
            netList().innerHTML = `<div class="dbg-empty">${netQuery ? `No saved request contains “${dEsc(netQuery)}”.` : 'No saved requests yet.<br>Open a request with ✈️ (or Paste one) and press <b>Save</b>.'}</div>`;
            return;
        }
        netList().innerHTML = list.map((r) => {
            let host = ''; try { host = new URL(r.url).host; } catch (e) { }
            return `<div class="net-row net-saved-row" data-sid="${dEsc(r.id)}">
                <span class="net-method">${dEsc(r.method || 'GET')}</span>
                <span class="net-url" title="${dEsc(r.name || netName(r.url))}" data-url="${dEsc(r.url || '')}"><b class="net-saved-name">${dEsc(r.name || netName(r.url))}</b> <span class="net-saved-host">${dEsc(netName(r.url))} · ${dEsc(host)}</span></span>
                <button class="net-copy net-saved-open" data-sid="${dEsc(r.id)}" title="Open, edit and send"><i class="fas fa-paper-plane"></i></button>
                <button class="net-copy net-saved-del" data-sid="${dEsc(r.id)}" title="Delete"><i class="fas fa-trash"></i></button>
            </div>`;
        }).join('');
    }

    async function netSaveRequest(req, current) {
        const name = await qaPrompt({ title: current && current.savedId ? 'Update saved request' : 'Save request', message: 'A name to find it again (e.g. "Approve - wrong ID")', value: (current && current.savedName) || netName(req.url), placeholder: 'Name' });
        if (!name) return null;
        const item = { id: (current && current.savedId) || ('sr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), name, method: req.method, url: req.url, reqHeaders: req.headers, reqBody: req.body, savedAt: Date.now() };
        const i = netSaved.findIndex((x) => x.id === item.id);
        if (i >= 0) netSaved[i] = item; else netSaved.push(item);
        await netStoreSaved();
        netUpdateCounts();
        return item;
    }

    // ── Compare two answers ──
    // JSON answers are compared value by value (path → A / B), only the differences listed;
    // anything else line by line.
    function netDiffHtml(a, b) {
        const head = (r, tag) => `<div class="cmp-head"><span class="cmp-tag cmp-${tag}">${tag.toUpperCase()}</span>
            <span class="net-method">${dEsc(r.method || 'GET')}</span><span class="net-status ${statusClass(r)}">${r.status === 0 ? 'ERR' : r.status}</span>
            <span class="cmp-name" title="${dEsc(netName(r.url))}">${dEsc(netName(r.url))}</span><span class="net-dur">${r.duration != null ? Math.round(r.duration) + 'ms' : ''}</span></div>`;
        let ja, jb; try { ja = JSON.parse(a.resBody); } catch (e) { } try { jb = JSON.parse(b.resBody); } catch (e) { }
        let body = '';
        if (ja !== undefined && jb !== undefined && typeof ja === 'object' && typeof jb === 'object') {
            const flat = (v) => { const m = new Map(); rsFlatten(v, [], []).forEach((f) => m.set(rsPathLabel(f.path), rsShow(f.value, f.type))); return m; };
            const fa = flat(ja), fb = flat(jb);
            const keys = [...new Set([...fa.keys(), ...fb.keys()])];
            const diffs = keys.filter((k) => fa.get(k) !== fb.get(k));
            const same = keys.length - diffs.length;
            body = diffs.length ? `<div class="cmp-grid"><span class="cmp-h">Value</span><span class="cmp-h">A</span><span class="cmp-h">B</span>` + diffs.map((k) => {
                const kind = !fa.has(k) ? 'add' : !fb.has(k) ? 'del' : 'chg';
                return `<span class="cmp-k cmp-${kind}" title="${dEsc(k)}">${dEsc(k)}</span><span class="cmp-v">${fa.has(k) ? dEsc(fa.get(k)) : '<i>—</i>'}</span><span class="cmp-v">${fb.has(k) ? dEsc(fb.get(k)) : '<i>—</i>'}</span>`;
            }).join('') + `</div>` : '';
            body = `<div class="cmp-sum">${diffs.length ? `<b>${diffs.length}</b> different value${diffs.length === 1 ? '' : 's'}` : '<b>The two answers are identical</b>'}${same ? ` · ${same} the same (hidden)` : ''}</div>` + body;
        } else {
            const la = String(a.resBody || '').split('\n'), lb = String(b.resBody || '').split('\n');
            const n = Math.max(la.length, lb.length), rows = [];
            for (let i = 0; i < n && rows.length < 400; i++) if (la[i] !== lb[i]) rows.push(`<span class="cmp-k">line ${i + 1}</span><span class="cmp-v">${la[i] != null ? dEsc(la[i]) : '<i>—</i>'}</span><span class="cmp-v">${lb[i] != null ? dEsc(lb[i]) : '<i>—</i>'}</span>`);
            body = `<div class="cmp-sum">${rows.length ? `<b>${rows.length}</b> different line${rows.length === 1 ? '' : 's'}` : '<b>The two answers are identical</b>'}</div>`
                + (rows.length ? `<div class="cmp-grid"><span class="cmp-h">Line</span><span class="cmp-h">A</span><span class="cmp-h">B</span>${rows.join('')}</div>` : '');
        }
        const cut = [a, b].some((r) => /… \(truncated\)$/.test(String(r.resBody || '')));
        return head(a, 'a') + head(b, 'b') + body
            + (cut ? '<div class="rs-note"><i class="fas fa-triangle-exclamation"></i> One answer was too big to keep in full - only its first part is compared.</div>' : '');
    }
    function netCompare(b) {
        const a = netCompareA;
        netCompareA = null;
        netStatus().textContent = '';
        document.getElementById('rsTitle').innerHTML = '<i class="fas fa-code-compare"></i> Compare answers';
        document.getElementById('rsBody').innerHTML = netDiffHtml(a, b);
        rsModal().classList.remove('hidden');
        netRender();
    }

    function netRender() {
        netViewingFindings = false;
        lastNetSig = sigOf(netCache);
        if (netFilter === 'saved') return netRenderSaved();
        let filtered = netCache;
        if (netQuery) filtered = filtered.filter((r) => netMatches(r, netQuery));
        if (netFilter === 'failed') filtered = filtered.filter(isAnyFail);
        else if (netFilter === 'xhr') filtered = filtered.filter(r => !isResource(r));
        else if (netFilter === 'other') filtered = filtered.filter(isResource);
        netFilteredCache = filtered.slice().reverse(); // newest first
        if (!netFilteredCache.length) {
            if (netQuery) { netList().innerHTML = `<div class="dbg-empty">No request contains “${dEsc(netQuery)}”.</div>`; return; }
            const msg = netFilter === 'other'
                ? 'No document/script/style/image requests captured yet.'
                : 'No fetch/XHR requests captured yet.';
            netList().innerHTML = `<div class="dbg-empty">${msg}<br>Interact with the page and they\'ll show here.</div>`;
            return;
        }
        const RENDER_CAP = 300; // keep the DOM light no matter how many were captured
        const note = netFilteredCache.length > RENDER_CAP
            ? `<div class="dbg-empty" style="padding:8px;">Showing newest ${RENDER_CAP} of ${netFilteredCache.length}.</div>` : '';
        netList().innerHTML = note + netFilteredCache.slice(0, RENDER_CAP).map((r, i) => {
            const dur = r.duration != null ? Math.round(r.duration) + 'ms' : '';
            // A resource has no real HTTP status when cross-origin (opaque) - show its TYPE
            // (doc/js/css/img/font) instead of a bare 0, so the row still says what it is.
            const statusLabel = isResource(r)
                ? (r.status ? r.status : (r.resType || 'res').toUpperCase())
                : (r.status === 0 ? (r.error || 'ERR') : r.status);
            // Every row gets a kind badge so none looks "unclassified": resources show their
            // type (js/css/img…), API calls show FETCH or XHR.
            const badgeType = isResource(r) ? (r.resType || 'other') : (r.kind === 'xhr' ? 'xhr' : 'fetch');
            const typeBadge = `<span class="net-type net-type-${dEsc(badgeType)}">${dEsc(badgeType)}</span>`;
            const soft = softFailReason(r);
            const softBadge = soft ? `<span class="net-soft" title="HTTP ${r.status}, but the answer says it failed - ${dEsc(soft)}"><i class="fas fa-triangle-exclamation"></i></span>` : '';
            const picked = isCompareA(r) ? ' compare-a' : '';
            return `<div class="net-row ${isFailed(r) ? 'failed' : soft ? 'soft-failed' : ''}${picked}" data-i="${i}">
                <span class="net-method">${dEsc(r.method || 'GET')}</span>
                <span class="net-status ${statusClass(r)}">${dEsc(statusLabel)}</span>${softBadge}${typeBadge}
                <span class="net-url" title="${dEsc(netName(r.url))}" data-url="${dEsc(r.url || '')}">${dEsc(netName(r.url))}</span>
                ${netQuery ? `<span class="net-where">${netMatchWhere(r, netQuery).map(dEsc).join(' · ')}</span>` : ''}
                <span class="net-dur">${dEsc(dur)}</span>
                ${isResource(r) ? '' : `<button class="net-copy net-resend" data-i="${i}" title="Edit & Resend"><i class="fas fa-paper-plane"></i></button>`}
                <button class="net-copy" data-i="${i}" title="Copy"><i class="fas fa-copy"></i></button>
            </div>
            <div class="net-detail hidden" data-detail="${i}"></div>`;
        }).join('');
    }

    const looksJson = (t) => typeof t === 'string' && /^\s*[\[{]/.test(t);
    function prettyJson(str) {
        if (!str || typeof str !== 'string') return '';
        const t = str.trim();
        if (t[0] !== '{' && t[0] !== '[') return '';
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return ''; }
    }

    // Syntax-highlight a JSON string (input is raw text; returns safe HTML)
    function highlightJson(json) {
        // Tokens are found in the RAW text and each piece escaped on its own - escaping first
        // turned every " into &quot;, so keys and strings were never matched (never coloured).
        const re = /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
        const src = String(json == null ? '' : json);
        let out = '', last = 0, m;
        while ((m = re.exec(src))) {
            const t = m[0];
            let cls = 'j-num';
            if (t[0] === '"') cls = /:\s*$/.test(t) ? 'j-key' : 'j-str';
            else if (t === 'true' || t === 'false') cls = 'j-bool';
            else if (t === 'null') cls = 'j-null';
            // a key's ":" stays plain, like an editor shows it
            const word = cls === 'j-key' ? t.slice(0, t.length - m[2].length) : t;
            out += dEsc(src.slice(last, m.index)) + `<span class="${cls}">${dEsc(word)}</span>` + (cls === 'j-key' ? dEsc(m[2]) : '');
            last = m.index + t.length;
        }
        return out + dEsc(src.slice(last));
    }

    let netDetailSeq = 0;
    function netDetailHtml(r) {
        // Every section after the URL is a fold whose title says what is inside (status
        // code, header count, body size). Only ONE is open at a time - opening another
        // closes it (same details "name" = an exclusive accordion) - and the Response Body
        // starts open, since that is what you came for.
        const group = 'nd-' + (++netDetailSeq);
        const fold = (label, inner, open) => `<details class="nd-fold" name="${group}"${open ? ' open' : ''}><summary class="nd-sum">${label}</summary>${inner}</details>`;
        const size = (b) => b ? ` <span class="nd-hint">${b.length >= 1024 ? (b.length / 1024).toFixed(1) + ' KB' : b.length + ' chars'}</span>` : '';
        const count = (h) => h && Object.keys(h).length ? ` <span class="nd-hint">${Object.keys(h).length}</span>` : '';
        const secH = (label, html, open) => html ? fold(label, `<pre>${html}</pre>`, open) : '';
        // A section whose body is already block-level markup (a grid), not preformatted text.
        const secBlock = (label, html) => html ? fold(label, html) : '';
        const headersH = (h) => h && Object.keys(h).length
            ? `<div class="nd-headers">` + Object.entries(h).map(([k, v]) =>
                `<span class="nd-key">${dEsc(k)}</span><span class="nd-val">${dEsc(v)}</span>`).join('') + `</div>` : '';
        // A body cut short (over the capture limit) is no longer valid JSON, but it is still
        // JSON text - colour it as it is instead of showing it plain.
        const bodyH = (b) => { const p = prettyJson(b); return p ? highlightJson(p) : looksJson(b) ? highlightJson(b) : dEsc(b || ''); };
        const statusH = r.status === 0
            ? `<span class="net-status serr">Failed</span>${r.error ? ' — <span class="nd-err">' + dEsc(r.error) + '</span>' : ''}`
            : `<span class="net-status ${statusClass(r)}">${r.status}</span> ${dEsc(r.statusText || '')}`;
        const preview = prettyJson(r.resBody);
        const code = r.status === 0 ? '<span class="net-status serr">Failed</span>' : `<span class="net-status ${statusClass(r)}">${r.status}</span>`;
        return `<div class="nd-sec">URL</div><pre class="nd-url">${dEsc(r.url || '')}</pre>`
            + secH(`Status ${code}`, statusH)
            + secBlock('Request Headers' + count(r.reqHeaders), headersH(r.reqHeaders))
            + secH('Request Body' + size(r.reqBody), bodyH(r.reqBody))
            + secBlock('Response Headers' + count(r.resHeaders), headersH(r.resHeaders))
            + (preview ? secH('Response Preview (JSON)', highlightJson(preview)) : '')
            + secH('Response Body' + size(r.resBody), bodyH(r.resBody), true)
            + (r.initiator ? secBlock('Initiator (what sent it)', `<div class="nd-init">${dEsc(r.initiator)}</div>`) : '');
    }

    // A request as a "Copy as fetch" snippet - the same text DevTools gives, so it can be
    // pasted back into Network → Paste (or into the console).
    function netAsFetch(r) {
        const opts = { headers: r.reqHeaders || {}, method: (r.method || 'GET').toUpperCase() };
        if (r.reqBody != null && !/^(GET|HEAD)$/.test(opts.method)) opts.body = String(r.reqBody);
        opts.mode = 'cors'; opts.credentials = 'include';
        return `fetch(${JSON.stringify(r.url || '')}, ${JSON.stringify(opts, null, 2)});`;
    }
    // 📋 opens a small menu: copy the request (to paste it back later) or the response.
    function netCopyMenu(btn, r) {
        document.querySelectorAll('.net-copy-menu').forEach((m) => m.remove());
        const m = document.createElement('div');
        m.className = 'net-copy-menu';
        const cmp = netCompareA && !isCompareA(r)
            ? `<button data-c="cmp"><i class="fas fa-code-compare"></i> Compare with A</button>`
            : isCompareA(r) ? '' : `<button data-c="cmp"><i class="fas fa-code-compare"></i> Compare…</button>`;
        m.innerHTML = `<button data-c="fetch"><i class="fas fa-code"></i> Copy as fetch</button>
            <button data-c="res"><i class="fas fa-reply"></i> Copy response</button>${cmp}`;
        document.body.appendChild(m);
        const b = btn.getBoundingClientRect();
        m.style.top = Math.min(b.bottom + 4, window.innerHeight - m.offsetHeight - 6) + 'px';
        m.style.left = Math.max(6, b.right - m.offsetWidth) + 'px';
        const close = () => { m.remove(); document.removeEventListener('click', close, true); };
        setTimeout(() => document.addEventListener('click', close, true), 0);
        m.addEventListener('click', (ev) => {
            const c = ev.target.closest('[data-c]'); if (!c) return;
            if (c.dataset.c === 'cmp') {
                if (netCompareA && !isCompareA(r)) { netCompare(r); return; }
                // first pick: mark it "A" and ask for the second one
                netCompareA = r;
                netStatus().style.color = '#a5b4fc';
                netStatus().innerHTML = `<i class="fas fa-code-compare"></i> <b>A</b> = ${dEsc(netName(r.url))}. Now press 📋 on another request → <b>Compare with A</b>. <button class="rs-add" id="netCmpCancel">Cancel</button>`;
                netRender();
                return;
            }
            const txt = c.dataset.c === 'fetch' ? netAsFetch(r)
                : `${r.method} ${r.url}\nStatus: ${r.status === 0 ? 'Failed ' + (r.error || '') : r.status + ' ' + (r.statusText || '')}\n\nResponse:\n${r.resBody || ''}`;
            navigator.clipboard.writeText(txt).then(() => {
                const o = btn.innerHTML; btn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => { btn.innerHTML = o; }, 1200);
            }).catch(() => { });
        });
    }

    netStatus().addEventListener('click', (e) => {
        if (e.target.closest('#netCmpCancel')) { netCompareA = null; netStatus().textContent = ''; netRender(); }
    });

    netList().addEventListener('click', async (e) => {
        // saved requests: open / delete
        const sdel = e.target.closest('.net-saved-del');
        if (sdel) {
            e.stopPropagation();
            const it = netSaved.find((x) => x.id === sdel.dataset.sid); if (!it) return;
            if (!(await qaConfirm({ title: 'Delete saved request?', message: `"${it.name}" will be removed.`, okText: 'Delete', danger: true }))) return;
            netSaved = netSaved.filter((x) => x.id !== it.id);
            await netStoreSaved(); netUpdateCounts(); netRender();
            return;
        }
        const srow = e.target.closest('.net-saved-row');
        if (srow) {
            const it = netSaved.find((x) => x.id === srow.dataset.sid);
            if (it) rsOpen({ method: it.method, url: it.url, reqHeaders: it.reqHeaders, reqBody: it.reqBody, savedId: it.id, savedName: it.name });
            return;
        }
        const resend = e.target.closest('.net-resend');
        if (resend) { e.stopPropagation(); const r = netFilteredCache[+resend.dataset.i]; if (r) rsOpen(r); return; }
        const copy = e.target.closest('.net-copy');
        if (copy) {
            e.stopPropagation();
            const r = netFilteredCache[+copy.dataset.i];
            if (r) netCopyMenu(copy, r);
            return;
        }
        const row = e.target.closest('.net-row');
        if (!row) return;
        const i = +row.dataset.i;
        const detail = netList().querySelector(`[data-detail="${i}"]`);
        if (!detail) return;
        if (detail.classList.contains('hidden')) {
            // one request open at a time: opening this one closes the one before
            netList().querySelectorAll('.net-detail:not(.hidden)').forEach((d) => { d.classList.add('hidden'); d.innerHTML = ''; });
            netList().querySelectorAll('.net-row.open').forEach((r) => r.classList.remove('open'));
            detail.innerHTML = netDetailHtml(netFilteredCache[i]);
            detail.classList.remove('hidden');
            row.classList.add('open');       // highlighted while open - you see where you are
            netMarkHits(detail, netQuery);
        } else {
            detail.classList.add('hidden');
            row.classList.remove('open');
        }
    });

    // ── Edit & Resend ──
    // A captured request opens as plain fields: every URL parameter and every value of a
    // JSON / form body is its own box, so changing a value needs no JSON editing. It is
    // sent from INSIDE the page (its cookies, session and CORS apply - like pasting
    // "Copy as fetch" into the console) and the answer shows right below.
    const rsModal = () => document.getElementById('rsModal');
    let rs = null;   // { r, kind: 'json'|'form'|'text'|'none', json, fields }

    // JSON body -> its leaf values [{ path: ['a', 0, 'b'], value, type }]
    // OutSystems sends its whole screen state - hundreds of values - so the limit is high
    const RS_MAX_FIELDS = 3000;
    function rsFlatten(v, path, out) {
        if (out.length > RS_MAX_FIELDS) return out;
        if (v && typeof v === 'object' && Object.keys(v).length) {
            Object.keys(v).forEach((k) => rsFlatten(v[k], path.concat(Array.isArray(v) ? +k : k), out));
        } else out.push({ path, value: v, type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v });
        return out;
    }
    const rsPathLabel = (p) => p.map((k, i) => typeof k === 'number' ? `[${k}]` : (i ? '.' : '') + k).join('') || '(value)';
    const rsShow = (v, type) => type === 'null' ? 'null' : (type === 'object' || type === 'array') ? JSON.stringify(v) : String(v);
    // The edited text goes back as the ORIGINAL type: 5 stays a number, true a boolean.
    function rsParse(text, type) {
        if (type === 'number') return text.trim() !== '' && !isNaN(+text) ? +text : text;
        if (type === 'boolean') return text === 'true' ? true : text === 'false' ? false : text;
        if (type === 'null') return text === 'null' ? null : text;
        if (type === 'object' || type === 'array') { try { return JSON.parse(text); } catch (e) { return text; } }
        return text;
    }

    function rsRow(key, val, opts = {}) {
        const keyH = opts.editKey
            ? `<input class="rs-in rs-k" value="${dEsc(key)}" placeholder="name">`
            : `<span class="rs-key${opts.indent ? ' rs-indent' : ''}" title="${dEsc(opts.title || key)}">${dEsc(key)}</span>`;
        return `${keyH}<input class="rs-in rs-v" value="${dEsc(val)}" ${opts.isNew ? '' : `data-orig="${dEsc(val)}"`} ${opts.attrs || ''}>`
            + `<button class="rs-x" title="Remove"><i class="fas fa-xmark"></i></button>`;
    }

    // Long paths are grouped: the shared part (screenData › variables) is one small
    // heading, each box shows only its last name; the full path is on hover.
    function rsJsonGrid(fields) {
        let group = null;
        return `<div class="rs-grid" id="rsBodyGrid">` + fields.map((f, i) => {
            const parent = f.path.slice(0, -1);
            const g = parent.map((k) => typeof k === 'number' ? `[${k}]` : k).join(' › ');
            const head = g !== group ? (group = g, g ? `<div class="rs-group" title="${dEsc(rsPathLabel(parent))}">${dEsc(g)}</div>` : '') : '';
            const last = f.path[f.path.length - 1];
            const name = !f.path.length ? '(value)' : typeof last === 'number' ? `[${last}]` : last;
            return head + rsRow(name, rsShow(f.value, f.type), { attrs: `data-f="${i}"`, title: rsPathLabel(f.path), indent: !!g });
        }).join('') + `</div>`;
    }

    function rsOpen(r) {
        let u = null; try { u = new URL(r.url); } catch (e) { }
        const body = r.reqBody == null ? '' : String(r.reqBody);
        const truncated = /… \(truncated\)$/.test(body) || /^\[(Blob|body|unserializable)/.test(body);
        const ct = Object.entries(r.reqHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type');
        rs = { r, kind: body ? 'text' : 'none', json: null, fields: [] };
        if (body && !truncated) {
            try { const j = JSON.parse(body); if (j && typeof j === 'object') { rs.kind = 'json'; rs.json = j; } } catch (e) { }
            if (rs.kind === 'text' && ((ct && /x-www-form-urlencoded/i.test(ct[1])) || /^[^=&\s{}\[\]]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body))) rs.kind = 'form';
        }
        if (rs.kind === 'json') {
            rs.fields = rsFlatten(rs.json, [], []);
            if (rs.fields.length > RS_MAX_FIELDS) rs.kind = 'text';   // too many values for boxes
        }
        let bodyH = '';
        if (rs.kind === 'json') bodyH = rsJsonGrid(rs.fields);
        else if (rs.kind === 'form') bodyH = `<div class="rs-grid" id="rsBodyGrid">` + [...new URLSearchParams(body).entries()].map(([k, v]) => rsRow(k, v, { editKey: true })).join('') + `</div>`;
        else if (rs.kind === 'text') bodyH = rsCodeArea('rsBodyText', body);
        // a text body that IS JSON can always go to the fields (and back)
        let jsonText = false;
        if (rs.kind === 'text') { try { const j = JSON.parse(body); jsonText = !!j && typeof j === 'object'; } catch (e) { } }
        const bodyBtn = rs.kind === 'json' ? '<button id="rsAsText">Edit as text</button>' : jsonText ? '<button id="rsAsFields">Edit as fields</button>' : rs.kind === 'form' ? '<button class="rs-add" data-add="rsBodyGrid">+ Add</button>' : '';
        const bodySec = rs.kind === 'none' ? '' : `<div class="rs-sec"><span>Body</span>${bodyBtn}</div>${bodyH}`
            + (truncated ? '<div class="rs-note"><i class="fas fa-triangle-exclamation"></i> This body was not captured in full - check it before sending.</div>' : '');
        const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        const m = (r.method || 'GET').toUpperCase();
        if (!methods.includes(m)) methods.push(m);
        const params = u ? [...u.searchParams.entries()] : [];
        const hdrs = Object.entries(r.reqHeaders || {});
        document.getElementById('rsTitle').innerHTML = '<i class="fas fa-paper-plane"></i> Edit &amp; Resend';
        document.getElementById('rsBody').innerHTML = `
            <div class="rs-line">
                <select id="rsMethod">${methods.map((x) => `<option${x === m ? ' selected' : ''}>${x}</option>`).join('')}</select>
                <input class="rs-in rs-url" id="rsUrl" value="${dEsc(u ? u.origin + u.pathname : r.url || '')}">
            </div>
            <div class="rs-sec"><span>URL parameters</span><button class="rs-add" data-add="rsParams">+ Add</button></div>
            <div class="rs-grid" id="rsParams">${params.map(([k, v]) => rsRow(k, v, { editKey: true })).join('')}</div>
            ${params.length ? '' : '<div class="rs-empty">None</div>'}
            ${bodySec}
            <details class="rs-hdrs"><summary>Headers (${hdrs.length})</summary>
                <div class="rs-grid" id="rsHeaders">${hdrs.map(([k, v]) => rsRow(k, v, { editKey: true })).join('')}</div>
                <div style="text-align:right;margin-top:4px;"><button class="rs-add" data-add="rsHeaders">+ Add header</button></div>
            </details>
            <div class="rs-actions">
                <button class="rs-send" id="rsSend" title="Send it from here and show the answer below"><i class="fas fa-paper-plane"></i> Send</button>
                <button class="dbg-btn" id="rsSave" title="Keep this request (with your edits) under a name - Network → Saved"><i class="fas fa-bookmark"></i> ${r.savedId ? 'Update' : 'Save'}</button>
                <button class="dbg-btn" id="rsReset" title="Back to the original values"><i class="fas fa-rotate-left"></i> Reset</button>
            </div>
            <div id="rsResult"></div>`;
        rsModal().classList.remove('hidden');
    }

    // [key, value] pairs of a box grid (rows with an empty name are skipped)
    const rsPairs = (id) => [...document.querySelectorAll(`#${id} .rs-v`)].map((v) => {
        const k = v.previousElementSibling;
        return [k.tagName === 'INPUT' ? k.value.trim() : k.textContent, v.value];
    }).filter(([k]) => k);

    function rsBuild() {
        const method = document.getElementById('rsMethod').value;
        let url = document.getElementById('rsUrl').value.trim();
        try { const u = new URL(url); u.search = ''; rsPairs('rsParams').forEach(([k, v]) => u.searchParams.append(k, v)); url = u.href; } catch (e) { throw new Error('The URL is not valid'); }
        const headers = {};
        rsPairs('rsHeaders').forEach(([k, v]) => { headers[k] = v; });
        let body = null;
        const textEl = document.getElementById('rsBodyText');
        if (textEl) body = textEl.value;
        else if (rs.kind === 'json') {
            const out = JSON.parse(JSON.stringify(rs.json));
            const kept = new Set();
            let root;
            document.querySelectorAll('#rsBodyGrid .rs-v').forEach((inp) => {
                const i = +inp.dataset.f, f = rs.fields[i]; kept.add(i);
                const val = rsParse(inp.value, f.type);
                if (!f.path.length) { root = val; return; }
                let o = out; f.path.slice(0, -1).forEach((k) => { o = o[k]; });
                o[f.path[f.path.length - 1]] = val;
            });
            // a removed box removes that value from the body (array items last-to-first)
            rs.fields.map((f, i) => [f, i]).filter(([, i]) => !kept.has(i)).reverse().forEach(([f]) => {
                if (!f.path.length) return;
                let o = out; f.path.slice(0, -1).forEach((k) => { o = o && o[k]; });
                if (!o) return;
                const last = f.path[f.path.length - 1];
                if (Array.isArray(o)) o.splice(last, 1); else delete o[last];
            });
            body = JSON.stringify(root !== undefined ? root : out);
        } else if (rs.kind === 'form') body = new URLSearchParams(rsPairs('rsBodyGrid')).toString();
        if (/^(GET|HEAD)$/i.test(method)) body = null;
        return { method, url, headers, body };
    }

    function rsResultHtml(out, ms) {
        if (!out) return `<div class="rs-res"><span class="nd-err">Could not send the request from this page.</span></div>`;
        if (out.status === 0) return `<div class="rs-res"><div class="rs-res-head"><span class="net-status serr">Failed</span> ${ms}ms</div><pre class="nd-err">${dEsc(out.error || 'Network error')}</pre></div>`;
        const p = prettyJson(out.text);
        return `<div class="rs-res"><div class="rs-res-head"><span class="net-status ${statusClass({ status: out.status })}">${out.status}</span> ${dEsc(out.statusText || '')} · ${ms}ms
            <button class="net-copy" id="rsCopyRes" title="Copy response" style="margin-left:auto;"><i class="fas fa-copy"></i></button></div>
            <pre>${p ? highlightJson(p) : looksJson(out.text) ? highlightJson(out.text) : dEsc(out.text || '(empty)')}</pre></div>`;
    }

    // ── Paste a request ──
    // DevTools → Network → right-click → Copy → "Copy as fetch" or "Copy as cURL" (bash or
    // cmd). It opens in the same Edit & Resend window, with every detail filled in.
    // Headers the browser sets by itself (cookie, host, sec-*…) are dropped - a page fetch
    // can't set them anyway, and the page's own cookies go along on their own.
    const RS_SKIP = /^(host|connection|content-length|cookie|origin|referer|user-agent|accept-encoding|te|priority|dnt|upgrade-insecure-requests|sec-.*)$/i;

    function rsParseFetch(text) {
        const m = text.match(/fetch\(\s*(["'`])([\s\S]*?)\1\s*(,\s*([\s\S]*?))?\)\s*;?\s*$/);
        if (!m) return null;
        let opts = {};
        if (m[4]) { try { opts = JSON.parse(m[4]); } catch (e) { throw new Error('Could not read the fetch options - paste the exact "Copy as fetch" text.'); } }
        return { url: m[2], method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body != null ? String(opts.body) : null };
    }

    // shell words of a cURL command: '...', "...", $'...', \-newline (bash) and ^ (cmd)
    function rsShellWords(text) {
        const cmd = /\^\s*\r?\n/.test(text) || /\^"/.test(text);
        text = cmd ? text.replace(/\^\s*\r?\n/g, ' ').replace(/\^(.)/g, '$1') : text.replace(/\\\r?\n/g, ' ');
        const out = []; let i = 0;
        while (i < text.length) {
            while (i < text.length && /\s/.test(text[i])) i++;
            if (i >= text.length) break;
            let w = '';
            while (i < text.length && !/\s/.test(text[i])) {
                const c = text[i];
                if (c === "'" ) { const j = text.indexOf("'", i + 1); w += text.slice(i + 1, j < 0 ? text.length : j); i = j < 0 ? text.length : j + 1; }
                else if (c === '$' && text[i + 1] === "'") {
                    i += 2;
                    while (i < text.length && text[i] !== "'") {
                        if (text[i] === '\\' && i + 1 < text.length) {
                            const n = text[i + 1]; const map = { n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\', '"': '"' };
                            if (n === 'u' || n === 'x') { const len = n === 'u' ? 4 : 2; w += String.fromCharCode(parseInt(text.substr(i + 2, len), 16)); i += 2 + len; }
                            else { w += map[n] != null ? map[n] : n; i += 2; }
                        } else w += text[i++];
                    }
                    i++;
                }
                else if (c === '"') {
                    i++;
                    while (i < text.length && text[i] !== '"') { if (text[i] === '\\' && (cmd ? text[i + 1] === '"' : /["\\$`]/.test(text[i + 1]))) i++; w += text[i++]; }
                    i++;
                }
                else { w += c; i++; }
            }
            out.push(w);
        }
        return out;
    }

    function rsParseCurl(text) {
        if (!/^\s*curl(\.exe)?\s/i.test(text)) return null;
        const w = rsShellWords(text.trim());
        let url = '', method = '', body = null; const headers = {};
        for (let i = 1; i < w.length; i++) {
            const a = w[i];
            if (a === '-H' || a === '--header') { const h = w[++i] || ''; const k = h.indexOf(':'); if (k > 0) headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
            else if (a === '-X' || a === '--request') method = (w[++i] || '').toUpperCase();
            else if (/^(--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|-d)$/.test(a)) { const d = w[++i] || ''; body = body == null ? d : body + '&' + d; }
            else if (a === '-b' || a === '--cookie' || a === '-A' || a === '--user-agent' || a === '-e' || a === '--referer' || a === '-u' || a === '--user') i++;
            else if (a === '--url') url = w[++i] || '';
            else if (!a.startsWith('-') && !url) url = a;
        }
        if (!url) throw new Error('No URL found in the cURL command.');
        return { url, method: method || (body != null ? 'POST' : 'GET'), headers, body };
    }

    function rsParsePasted(text) {
        text = (text || '').trim();
        if (!text) throw new Error('Paste a request first.');
        const p = rsParseFetch(text) || rsParseCurl(text)
            || (/^https?:\/\/\S+$/i.test(text) ? { url: text, method: 'GET', headers: {}, body: null } : null);
        if (!p) throw new Error('Not recognized. In DevTools → Network, right-click the request → Copy → "Copy as fetch" or "Copy as cURL".');
        try { new URL(p.url); } catch (e) { throw new Error('The URL in it is not a full address (https://…).'); }
        const reqHeaders = {};
        Object.entries(p.headers || {}).forEach(([k, v]) => { if (!RS_SKIP.test(k)) reqHeaders[k] = String(v); });
        return { method: p.method, url: p.url, reqHeaders, reqBody: p.body, pasted: true };
    }

    // A text box with JSON colours: the coloured copy sits right behind a transparent
    // textarea (same font, padding and wrapping), redrawn on every keystroke.
    function rsCodeArea(id, value, attrs = '') {
        return `<div class="rs-code"><pre class="rs-hl" aria-hidden="true">${highlightJson(value || '')}\n</pre>`
            + `<textarea class="rs-text rs-code-in" id="${id}" spellcheck="false" ${attrs}>${dEsc(value || '')}</textarea></div>`;
    }
    const rsHlSync = (ta) => { const pre = ta.previousElementSibling; pre.innerHTML = highlightJson(ta.value) + '\n'; pre.scrollTop = ta.scrollTop; };

    function rsPasteView() {
        document.getElementById('rsTitle').innerHTML = '<i class="fas fa-paste"></i> Paste a request';
        document.getElementById('rsBody').innerHTML = `
            <div class="rs-sec" style="margin-top:0;"><span>Paste the request</span></div>
            ${rsCodeArea('rsPasteIn', '', `style="min-height:170px;" placeholder='DevTools → Network → right-click the request → Copy → "Copy as fetch" (or "Copy as cURL") - then paste it here'`)}
            <div class="rs-actions"><button class="rs-send" id="rsPasteGo"><i class="fas fa-arrow-right"></i> Open</button></div>
            <div id="rsPasteErr"></div>`;
        rsModal().classList.remove('hidden');
        setTimeout(() => { const t = document.getElementById('rsPasteIn'); if (t) t.focus(); }, 0);
    }
    document.getElementById('netPasteBtn').addEventListener('click', rsPasteView);

    rsModal().addEventListener('click', async (e) => {
        if (e.target.closest('#rsPasteGo')) {
            try { rsOpen(rsParsePasted(document.getElementById('rsPasteIn').value)); }
            catch (err) { document.getElementById('rsPasteErr').innerHTML = `<div class="rs-res"><span class="nd-err">${dEsc(err.message)}</span></div>`; }
            return;
        }
        if (e.target.id === 'rsModal' || e.target.closest('#rsClose')) { rsModal().classList.add('hidden'); return; }
        const x = e.target.closest('.rs-x');
        if (x) { const v = x.previousElementSibling, k = v.previousElementSibling; [k, v, x].forEach((n) => n.remove()); return; }
        const add = e.target.closest('.rs-add');
        if (add) {
            const g = document.getElementById(add.dataset.add);
            g.insertAdjacentHTML('beforeend', rsRow('', '', { editKey: true, isNew: true }));
            g.querySelectorAll('.rs-k')[g.querySelectorAll('.rs-k').length - 1].focus();
            return;
        }
        if (e.target.closest('#rsReset')) return rsOpen(rs.r);
        if (e.target.closest('#rsSave')) {
            let req;
            try { req = rsBuild(); } catch (err) { document.getElementById('rsResult').innerHTML = `<div class="rs-res"><span class="nd-err">${dEsc(err.message)}</span></div>`; return; }
            const it = await netSaveRequest(req, rs.r);
            if (!it) return;
            rs.r = { ...rs.r, savedId: it.id, savedName: it.name };
            const b = document.getElementById('rsSave');
            b.innerHTML = '<i class="fas fa-check"></i> Saved';
            setTimeout(() => { if (b.isConnected) b.innerHTML = '<i class="fas fa-bookmark"></i> Update'; }, 1400);
            return;
        }
        if (e.target.closest('#rsAsText')) {
            let txt;
            try { txt = JSON.stringify(JSON.parse(rsBuild().body || JSON.stringify(rs.json)), null, 2); } catch (err) { txt = JSON.stringify(rs.json, null, 2); }
            rs.kind = 'text';
            document.getElementById('rsBodyGrid').outerHTML = rsCodeArea('rsBodyText', txt);
            e.target.closest('#rsAsText').outerHTML = '<button id="rsAsFields">Edit as fields</button>';
            return;
        }
        // back from text to the boxes - the text (with its edits) becomes the new body
        if (e.target.closest('#rsAsFields')) {
            const ta = document.getElementById('rsBodyText');
            let j;
            try { j = JSON.parse(ta.value); } catch (err) { j = null; }
            const note = document.getElementById('rsJsonErr');
            if (!j || typeof j !== 'object') {
                if (!note) ta.closest('.rs-code').insertAdjacentHTML('afterend', '<div class="rs-note" id="rsJsonErr"><i class="fas fa-triangle-exclamation"></i> The text is not valid JSON - fix it to go back to the fields.</div>');
                return;
            }
            if (note) note.remove();
            const fields = rsFlatten(j, [], []);
            if (fields.length > RS_MAX_FIELDS) {
                if (!note) ta.closest('.rs-code').insertAdjacentHTML('afterend', `<div class="rs-note" id="rsJsonErr"><i class="fas fa-triangle-exclamation"></i> Too many values to show as fields (over ${RS_MAX_FIELDS}) - edit it as text.</div>`);
                return;
            }
            rs.kind = 'json'; rs.json = j; rs.fields = fields;
            ta.closest('.rs-code').outerHTML = rsJsonGrid(rs.fields);
            e.target.closest('#rsAsFields').outerHTML = '<button id="rsAsText">Edit as text</button>';
            return;
        }
        if (e.target.closest('#rsCopyRes')) {
            const pre = document.querySelector('#rsResult pre');
            navigator.clipboard.writeText(pre ? pre.textContent : '').catch(() => { });
            return;
        }
        if (e.target.closest('#rsSend')) {
            const btn = document.getElementById('rsSend'), res = document.getElementById('rsResult');
            let req;
            try { req = rsBuild(); } catch (err) { res.innerHTML = `<div class="rs-res"><span class="nd-err">${dEsc(err.message)}</span></div>`; return; }
            const id = await activeTabId(); if (id == null) return;
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
            const t0 = Date.now();
            chrome.runtime.sendMessage({ action: 'netResend', tabId: id, ...req }, (out) => {
                void chrome.runtime.lastError;
                btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send';
                res.innerHTML = rsResultHtml(out, Date.now() - t0);
            });
        }
    });
    // keep a coloured box's colours in step with its text and its scrolling
    rsModal().addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('rs-code-in')) e.target.previousElementSibling.scrollTop = e.target.scrollTop; }, true);
    // a changed value is outlined, so it's clear what differs from the original request
    rsModal().addEventListener('input', (e) => {
        if (e.target.classList.contains('rs-code-in')) { rsHlSync(e.target); return; }
        const v = e.target.closest('.rs-v');
        if (v && v.dataset.orig != null) v.classList.toggle('changed', v.value !== v.dataset.orig);
    });

    let netSearchTimer = null;
    document.getElementById('netSearch').addEventListener('input', (e) => {
        clearTimeout(netSearchTimer);
        netSearchTimer = setTimeout(() => { netQuery = e.target.value.trim(); if (!netViewingFindings) netRender(); }, 150);
    });

    document.querySelectorAll('.net-filter').forEach(b => b.addEventListener('click', () => {
        netFilter = b.dataset.nf;
        document.querySelectorAll('.net-filter').forEach(x => x.classList.toggle('active', x === b));
        if (!netViewingFindings) netRender();
    }));

    document.getElementById('netClearBtn').addEventListener('click', async () => {
        const id = await activeTabId(); if (id == null) return;
        chrome.runtime.sendMessage({ action: 'clearNetworkReqs', tabId: id }, () => {
            netCache = []; netStatus().textContent = ''; netUpdateCounts(); netRender();
        });
    });

    document.getElementById('netExplainBtn').addEventListener('click', async () => {
        const failed = netCache.filter(isFailed);
        if (!failed.length) { netStatus().style.color = '#f87171'; netStatus().textContent = 'No failed requests to explain.'; return; }
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        const btn = document.getElementById('netExplainBtn');
        btn.disabled = true;
        netStatus().style.color = '#94a3b8';
        netStatus().innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing ' + failed.length + ' failed request(s) with AI…';
        chrome.runtime.sendMessage({ action: 'aiExplainNetwork', reqs: netCache, url: t && t.url }, (resp) => {
            btn.disabled = false;
            if (chrome.runtime.lastError || !resp || resp.error) {
                netStatus().style.color = '#f87171';
                netStatus().textContent = (resp && resp.error === 'no_api_key') ? 'AI key not configured' : 'Failed: ' + ((resp && resp.error) || 'error');
                return;
            }
            netStatus().textContent = '';
            netRenderFindings(resp.findings || []);
        });
    });

    function netRenderFindings(findings) {
        netViewingFindings = true;
        const head = '<div style="margin-bottom:8px;"><button class="dbg-btn" id="netBackBtn"><i class="fas fa-arrow-left"></i> Back to requests</button></div>';
        if (!findings.length) {
            netList().innerHTML = head + '<div class="dbg-empty">The AI found nothing actionable.</div>';
        } else {
            netList().innerHTML = head + findings.map(f =>
                `<div class="dbg-finding">
                    <h5>${dEsc(f.title)} <span class="sev ${dEsc(f.severity)}">${dEsc(f.severity)}</span></h5>
                    <p>${dEsc(f.cause)}</p>
                    <p class="fix"><i class="fas fa-lightbulb"></i> ${dEsc(f.fix)}</p>
                </div>`).join('');
        }
        document.getElementById('netBackBtn').addEventListener('click', () => {
            netViewingFindings = false; netRender(); refresh();
        });
    }

    // ── Performance card → runs in the page (content.js shows the panel) ──
    const perfCard = document.getElementById('perfToolBtn');
    perfCard.addEventListener('click', async () => {
        if (perfCard.classList.contains('scanning')) return;
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!t || !t.url || /^(chrome|chrome-extension|about|edge|file):/i.test(t.url)) {
            showToastMessage('Open a website first', 'error'); return;
        }
        perfCard.classList.add('scanning');
        await ensureContentScript(t.id);
        chrome.tabs.sendMessage(t.id, { action: 'runPerformance' }, () => {
            if (chrome.runtime.lastError) { perfCard.classList.remove('scanning'); showToastMessage('Could not run on this page (reload it)', 'error'); }
        });
    });

    // ── Console/Network/Security mode switcher ──
    document.querySelectorAll('.dbg-mode').forEach(b => b.addEventListener('click', () => {
        mode = b.dataset.mode;
        document.querySelectorAll('.dbg-mode').forEach(x => x.classList.toggle('active', x === b));
        document.getElementById('dbg-console-panel').classList.toggle('hidden', mode !== 'console');
        document.getElementById('dbg-network-panel').classList.toggle('hidden', mode !== 'network');
        if (mode === 'console') { if (!viewingFindings) render(); }
        else if (mode === 'network') { if (!netViewingFindings) netRender(); }
    }));

    // Poll always (lightweight) so the tab badge stays live; list re-renders only
    // when the Debug tab is visible
    setInterval(refresh, 1500);
    refresh();
    const dtab = document.querySelector('.tab-btn[data-tab="debug"]');
    if (dtab) dtab.addEventListener('click', () => { viewingFindings = false; netViewingFindings = false; refresh(); });
})();

// AI Create Profile button - scans the form, generates data via Claude, saves and fills
document.getElementById('aiBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }

    const btn = document.getElementById('aiBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner"></i><span class="btn-label">Working</span>';
    showToastMessage('AI is analyzing the form...', 'success');

    await ensureContentScript(tab.id);

    chrome.runtime.sendMessage({ action: 'aiCreateProfile', tabId: tab.id }, async (response) => {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i><span class="btn-label">AI Fill</span>';

        if (chrome.runtime.lastError || !response) {
            showToastMessage('AI profile failed: ' + (chrome.runtime.lastError?.message || 'no response'), 'error');
            return;
        }

        if (response.success) {
            await loadProfiles();
            renderProfiles();
            if (response.saved) {
                showToastMessage(`"${truncateName(response.profileName)}" created & filled (${response.fieldCount} fields)`, 'success');
            } else if (response.prompted) {
                showToastMessage(`Form filled (${response.fieldCount} fields) — confirm saving on the page`, 'success');
            } else {
                showToastMessage(`Form filled (${response.fieldCount} fields)`, 'success');
            }
        } else {
            const messages = {
                no_api_key: 'AI is not configured in this build of the extension',
                no_fields: 'No form fields found on this page',
                no_form: 'No fillable form detected on this page',
                no_values: 'AI could not generate values for this form',
                profile_limit: 'Limit reached: 5 profiles already exist for this page',
                // Legacy code from an older service worker (cleared by reloading the extension)
                profile_exists: 'A profile for this page already exists'
            };
            showToastMessage(messages[response.error] || ('AI failed: ' + (response.error || 'unknown error') + ' — try reloading the extension'), 'error');
        }
    });
});

async function loadProfiles() {
    try {
        // Try to migrate from local storage first
        await FormFillerDB.migrateFromLocalStorage();
        // Load from IndexedDB
        profiles = await FormFillerDB.getAllProfiles();
    } catch (err) {
        console.error('Error loading profiles:', err);
        // Fallback to local storage
        const result = await chrome.storage.local.get(['formFillerProfiles']);
        profiles = result.formFillerProfiles || [];
    }
}

async function saveProfiles() {
    try {
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'saveProfiles', profiles }, (response) => {
                if (response && response.success) resolve();
                else reject(new Error(response?.error || 'Failed to save profiles'));
            });
        });
    } catch (err) {
        console.error('Error saving profiles:', err);
        // Fallback to local storage
        await chrome.storage.local.set({ formFillerProfiles: profiles });
    }
}

async function loadCategories() {
    const result = await chrome.storage.sync.get(['formFillerCategories']);
    availableCategories = result.formFillerCategories || [];
}


function renderProfiles() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const categoryFilter = document.getElementById('categoryFilter').value;
    const container = document.getElementById('profilesList');
    const banner = document.getElementById('smartFilterBanner');
    const bannerText = document.getElementById('smartFilterText');

    profiles.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

    // 1. URL-Aware Filtering Logic
    let matchingProfiles = [];
    if (currentTabUrl) {
        let matching = profiles.filter(p => {
            if (!p.url) return false;
            try {
                return FormFillerDB.isUrlMatch(currentTabUrl, p.url);
            } catch (e) {
                return currentTabUrl.startsWith(p.url);
            }
        });

        // Collect parent IDs of matching profiles to ensure structure remains
        const parentIds = new Set(matching.filter(p => p.parentProfileId).map(p => p.parentProfileId));

        // Add parents if they aren't already in the matching list
        parentIds.forEach(parentId => {
            if (!matching.some(p => String(p.id) === String(parentId))) {
                const parent = profiles.find(p => String(p.id) === String(parentId));
                if (parent) matching.push(parent);
            }
        });

        matchingProfiles = matching;
    }

    let isFilteringSmartly = smartFilterActive && matchingProfiles.length > 0 && !searchTerm && categoryFilter === 'all';

    if (isFilteringSmartly) {
        banner.classList.add('active');
        bannerText.textContent = `Showing ${matchingProfiles.length} profile${matchingProfiles.length > 1 ? 's' : ''} for this page`;
    } else {
        banner.classList.remove('active');
    }

    let baseProfiles = isFilteringSmartly ? matchingProfiles : profiles;

    let filteredProfiles = baseProfiles.filter(p => {
        const nameMatch = p.name.toLowerCase().includes(searchTerm);
        const categoryMatch = categoryFilter === 'all' || p.category === categoryFilter;
        return nameMatch && categoryMatch;
    });

    const categorySelect = document.getElementById('categoryFilter');
    const currentSelection = categorySelect.value;
    categorySelect.innerHTML = '<option value="all">All Categories</option>' +
        availableCategories.sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    categorySelect.value = availableCategories.includes(currentSelection) ? currentSelection : 'all';

    if (profiles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-user-plus"></i></div>
                <h3>No profiles yet</h3>
                <p>Press the red button to record a form,<br>or click + to add manually.</p>
            </div>
        `;
        return;
    }

    if (filteredProfiles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-search"></i></div>
                <h3>No results</h3>
                <p>No profiles match your search</p>
            </div>
        `;
        return;
    }

    const groups = {};
    filteredProfiles.forEach(p => {
        const cat = p.category || 'General';
        if (!groups[cat]) groups[cat] = { profiles: [], lastModified: 0 };
        groups[cat].profiles.push(p);
        groups[cat].lastModified = Math.max(groups[cat].lastModified, p.lastModified || 0);
    });

    const sortedCategories = Object.keys(groups).sort((a, b) => groups[b].lastModified - groups[a].lastModified);

    // Accordion Logic
    if (searchTerm || categoryFilter !== 'all' || isFilteringSmartly) {
        // Expand all categories when searching, filtering by category, or in Smart Mode
        expandedCategories = new Set(sortedCategories);
    } else {
        if (userExpandedCategories.size > 0) {
            expandedCategories = new Set(userExpandedCategories);
        } else if (expandedCategories.size === 0 && sortedCategories.length > 0) {
            expandedCategories.add(sortedCategories[0]);
            userExpandedCategories.add(sortedCategories[0]);
        }
    }

    container.innerHTML = sortedCategories.map(catName => {
        const group = groups[catName];
        const isExpanded = expandedCategories.has(catName);

        // Separate parent profiles (no parent) and sub-profiles
        const parentProfiles = group.profiles.filter(p => !p.parentProfileId);
        const subProfiles = group.profiles.filter(p => p.parentProfileId);

        // Build hierarchical structure
        const renderHierarchy = () => {
            let html = '';
            parentProfiles.forEach(parent => {
                // Render parent profile
                html += renderProfileCard(parent);

                // Find and render children of this parent
                const children = subProfiles.filter(sp => sp.parentProfileId === parent.id);
                if (children.length > 0) {
                    html += `<div class="sub-profiles-container" style="margin-left: 20px; border-left: 2px solid rgba(102, 126, 234, 0.3); padding-left: 12px;">`;
                    children.forEach(child => {
                        html += renderProfileCard(child, true);
                    });
                    html += `</div>`;
                }
            });

            // Render orphan sub-profiles (parent deleted or not in this category)
            const orphanSubProfiles = subProfiles.filter(sp => !parentProfiles.find(p => p.id === sp.parentProfileId));
            orphanSubProfiles.forEach(orphan => {
                html += renderProfileCard(orphan, true);
            });

            return html;
        };

        return `
            <div class="category-group ${isExpanded ? 'expanded' : ''}" data-category="${escapeHtml(catName)}">
                <div class="category-header">
                    <div class="category-title-container">
                        <div class="category-icon"><i class="fas fa-folder"></i></div>
                        <span class="category-title">${escapeHtml(catName)}</span>
                        <span class="category-count">${group.profiles.length}</span>
                    </div>
                    <i class="fas fa-chevron-down category-chevron"></i>
                </div>
                <div class="category-content">
                    ${renderHierarchy()}
                </div>
            </div>
        `;
    }).join('');

    attachProfileListeners(container);

    container.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('click', () => {
            const group = header.closest('.category-group');
            const catName = group.dataset.category;

            if (searchTerm) {
                if (expandedCategories.has(catName)) {
                    expandedCategories.delete(catName);
                    group.classList.remove('expanded');
                } else {
                    expandedCategories.add(catName);
                    group.classList.add('expanded');
                }
                return;
            }

            if (expandedCategories.has(catName)) {
                expandedCategories.clear();
                userExpandedCategories.clear();
                group.classList.remove('expanded');
            } else {
                // Collapse current and expand new manually to avoid full re-render jump
                container.querySelectorAll('.category-group').forEach(g => {
                    g.classList.remove('expanded');
                });

                expandedCategories.clear();
                userExpandedCategories.clear();

                expandedCategories.add(catName);
                userExpandedCategories.add(catName);
                group.classList.add('expanded');
            }
        });
    });
}

function truncateName(name, maxLength = 20) {
    if (!name) return '';
    return name.length > maxLength ? name.substring(0, maxLength) + '...' : name;
}

function renderProfileCard(profile, isSubProfile = false) {
    const isThisRecording = isRecording && appendToId === profile.id;
    const isOtherRecording = isRecording && appendToId !== profile.id && appendToId !== null;
    const isGeneralRecording = isRecording && appendToId === null;

    // Find parent profile name if this is a sub-profile
    let parentName = '';
    if (profile.parentProfileId) {
        const parent = profiles.find(p => p.id === profile.parentProfileId);
        parentName = parent ? parent.name : '';
    }

    const subProfileStyle = isSubProfile ? 'background: linear-gradient(135deg, #1a1a2e 0%, #1e2945 100%); border-left: 3px solid #667eea;' : '';
    const avatarStyle = isSubProfile
        ? 'width:28px;height:28px;background:linear-gradient(135deg,#764ba2 0%,#667eea 100%);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:white;'
        : 'width:36px;height:36px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:white;';

    return `
        <div class="profile-card ${isThisRecording ? 'recording-active' : ''} ${isSubProfile ? 'sub-profile-card' : ''}" style="padding:${isSubProfile ? '12px' : '16px'}; opacity: ${isOtherRecording || isGeneralRecording ? '0.6' : '1'}; ${subProfileStyle}">
            <div class="profile-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${isSubProfile ? '10px' : '14px'};">
                <div style="display:flex;align-items:center;gap:${isSubProfile ? '8px' : '12px'};">
                    ${isSubProfile ? '<i class="fas fa-level-up-alt" style="color:#667eea;font-size:10px;transform:rotate(90deg);margin-right:4px;"></i>' : ''}
                    <div class="profile-avatar" style="${avatarStyle}">${(profile.name || '?').charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="profile-name" title="${escapeHtml(profile.name)}" style="font-size:${isSubProfile ? '13px' : '14px'};font-weight:600;color:white;">${escapeHtml(truncateName(profile.name))}</div>
                        ${isSubProfile && parentName ? `<div title="${escapeHtml(parentName)}" style="font-size:10px;color:#667eea;margin-top:2px;"><i class="fas fa-link" style="margin-right:4px;"></i>تابع لـ: ${escapeHtml(truncateName(parentName))}</div>` : ''}
                    </div>
                </div>
                <div class="profile-meta" style="font-size:${isSubProfile ? '10px' : '11px'};color:#666;background:rgba(255,255,255,0.03);padding:3px 8px;border-radius:6px;">${profile.fields?.length || 0} fields</div>
            </div>
            <div class="profile-actions" style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">
                <div class="toggle-container" title="Auto-fill form on page reload" style="padding: 3px 8px; font-size: 10px;">
                    <span>On Reload</span>
                    <label class="switch" style="transform: scale(${isSubProfile ? '0.75' : '0.85'});">
                        <input type="checkbox" class="on-reload-toggle" data-id="${profile.id}" ${profile.onReload ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <button class="action-btn btn-fill" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="height:${isSubProfile ? '28px' : '32px'}; font-size:${isSubProfile ? '10px' : '11px'}; padding:0 ${isSubProfile ? '10px' : '12px'};">
                    <i class="fas fa-magic"></i> Fill
                </button>
                <button class="action-btn btn-record-more ${isThisRecording ? 'active' : ''}" data-id="${profile.id}" title="${isThisRecording ? 'Stop Recording' : 'Record More Fields'}" ${isOtherRecording || isGeneralRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas ${isThisRecording ? 'fa-stop' : 'fa-circle'}"></i>
                </button>
                <button class="action-btn btn-edit" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas fa-pen"></i>
                </button>
                <button class="action-btn btn-delete" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

function attachProfileListeners(container) {
    container.querySelectorAll('.on-reload-toggle').forEach(chk => {
        chk.addEventListener('change', async () => {
            const index = profiles.findIndex(p => p.id === chk.dataset.id);
            if (index >= 0) {
                profiles[index].onReload = chk.checked;
                await saveProfiles();
            }
        });
    });

    container.querySelectorAll('.btn-record-more').forEach(btn => {
        btn.addEventListener('click', async () => {
            const profileId = btn.dataset.id;
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // If already recording for this profile, trigger stop
            if (isRecording && appendToId === profileId) {
                document.getElementById('recordBtn').click();
                return;
            }

            // Find the profile to get its fields and URL
            const profile = profiles.find(p => String(p.id) === String(profileId));
            if (!profile) {
                showToastMessage('Profile not found', 'error');
                return;
            }

            console.log('Starting recording for profile:', profileId, 'Fields count:', profile.fields?.length);

            // Set append mode and save to storage
            appendToId = profileId;
            await chrome.storage.sync.set({
                appendToProfileId: profileId,
                isRecordingActive: true
            });

            // Check for failed fields before starting recording
            const checkFailedFields = async () => {
                try {
                    console.log('Sending startRecording with failed fields check');
                    await chrome.tabs.sendMessage(tab.id, {
                        action: 'startRecording',
                        appendToProfileId: profileId,
                        checkFailedFields: true,
                        fields: profile.fields,
                        profileUrl: profile.url
                    });
                } catch (e) {
                    console.log('Content script not loaded, injecting...', e);
                    // Content script might not be loaded, inject it first
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    setTimeout(async () => {
                        console.log('Retrying startRecording after injection');
                        await chrome.tabs.sendMessage(tab.id, {
                            action: 'startRecording',
                            appendToProfileId: profileId,
                            checkFailedFields: true,
                            fields: profile.fields,
                            profileUrl: profile.url
                        });
                    }, 100);
                }
            };

            try {
                await checkFailedFields();
                isRecording = true;
                updateRecordButton();
                renderProfiles();
                showToastMessage('Recording started', 'success');
            } catch (e) {
                // Fallback: try without checking failed fields
                try {
                    await chrome.tabs.sendMessage(tab.id, {
                        action: 'startRecording',
                        appendToProfileId: profileId
                    });
                    isRecording = true;
                    updateRecordButton();
                    renderProfiles();
                    showToastMessage('Recording started', 'success');
                } catch (e2) {
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    setTimeout(async () => {
                        await chrome.tabs.sendMessage(tab.id, {
                            action: 'startRecording',
                            appendToProfileId: profileId
                        });
                        isRecording = true;
                        updateRecordButton();
                        renderProfiles();
                        showToastMessage('Recording started', 'success');
                    }, 100);
                }
            }
        });
    });

    container.querySelectorAll('.btn-fill').forEach(btn => {
        btn.addEventListener('click', () => {
            fillForm(btn.dataset.id);
        });
    });

    container.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => editProfile(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteProfile(btn.dataset.id));
    });
}

function editProfile(id) {
    qaOpenTabBeside(`editor.html?id=${id}`);
}

async function fillForm(profileId) {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5 };
    await ensureContentScript(tab.id);
    try {
        chrome.tabs.sendMessage(tab.id, {
            action: 'fillForm',
            fields: profile.fields,
            settings,
            profileId: profile.id,
            profileUrl: profile.url
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Fill error:', chrome.runtime.lastError);
                showToastMessage('Open the profile web page first', 'error');
            } else if (response && response.error === 'url_mismatch') {
                showToastMessage('Please open the profile page first', 'error');
            } else {
                showToastMessage('Form filled!', 'success');
            }
        });

    } catch (e) {
        showToastMessage('Error filling form', 'error');
    }
}

// Toast and Utility functions

let deleteTargetId = null;
let deleteChildrenIds = [];

function deleteProfile(id) {
    deleteTargetId = id;

    // Check if this profile has sub-profiles
    deleteChildrenIds = profiles.filter(p => p.parentProfileId === id).map(p => p.id);

    const modal = document.getElementById('deleteModal');
    const messageEl = document.getElementById('deleteModalMessage');

    if (deleteChildrenIds.length > 0) {
        messageEl.innerHTML = `<span style="color:#ef4444;font-weight:600;">Warning:</span> This will also delete <strong>${deleteChildrenIds.length}</strong> sub-profile${deleteChildrenIds.length > 1 ? 's' : ''}.`;
    } else {
        messageEl.textContent = 'This action cannot be undone.';
    }

    if (modal) modal.classList.add('active');
    else qaConfirm({ title: 'Delete this profile?', message: 'This action cannot be undone.', okText: 'Delete', danger: true, icon: 'fa-trash' }).then((ok) => {
        if (!ok) return;
        profiles = profiles.filter(p => p.id !== id && p.parentProfileId !== id);
        saveProfiles().then(() => renderProfiles());
    });
}

document.getElementById('cancelDeleteBtn')?.addEventListener('click', () => {
    document.getElementById('deleteModal').classList.remove('active');
    deleteTargetId = null;
    deleteChildrenIds = [];
});

document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    if (deleteTargetId) {
        // Delete the profile and all its sub-profiles
        profiles = profiles.filter(p => p.id !== deleteTargetId && p.parentProfileId !== deleteTargetId);
        await saveProfiles();
        renderProfiles();

        const deletedCount = 1 + deleteChildrenIds.length;
        showToastMessage(`${deletedCount} profile${deletedCount > 1 ? 's' : ''} deleted`, 'success');
    }
    document.getElementById('deleteModal').classList.remove('active');
    deleteTargetId = null;
    deleteChildrenIds = [];
});

function showToastMessage(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const icon = toast.querySelector('i');
    const text = toast.querySelector('span');
    text.textContent = message;
    if (type === 'error') {
        toast.style.background = '#ef4444';
        icon.className = 'fas fa-exclamation-circle';
    } else {
        toast.style.background = '#10b981';
        icon.className = 'fas fa-check-circle';
    }
    toast.classList.add('show');
    // Clear any previous hide timer so back-to-back toasts get the full duration
    if (toast._hideTimer) clearTimeout(toast._hideTimer);
    // Errors stay longer - the user needs time to read what went wrong
    const duration = type === 'error' ? 6000 : 4000;
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), duration);
}


function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// content.js reports on the lifecycle of on-page tools (Link Health /
// Performance / Page Images): when a scan finishes, when its panel opens,
// and when that panel closes - each drives a different bit of card UI.
const QA_TOOL_BTN_IDS = { links: 'linksToolBtn', perf: 'perfToolBtn', images: 'imagesToolBtn' };
chrome.runtime.onMessage.addListener((req) => {
    if (!req || !req.action) return;
    const c = document.getElementById(QA_TOOL_BTN_IDS[req.tool]);
    if (req.action === 'toolScanDone') {
        if (c) c.classList.remove('scanning');
    } else if (req.action === 'toolPanelOpened') {
        qaSetOnlyActive(QA_TOOL_BTN_IDS[req.tool]);
    } else if (req.action === 'toolPanelClosed') {
        if (c) c.classList.remove('active');
    } else if (req.action === 'toolResultCount') {
        const badge = document.getElementById(req.tool + 'CountBadge');
        if (badge) { badge.textContent = String(req.count); badge.style.display = req.count > 0 ? '' : 'none'; }
    }
});

// ── Screenshot & Record (capture/ module) ───────────────────────────────────
// The original lived in its own popup that closed after each action; the side
// panel stays open, so the flows just fire and toast.

(function captureCard() {
    const $id = (x) => document.getElementById(x);
    if (!$id('capVisibleBtn')) return;

    const activeTab = () => new Promise((res) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => res(tabs && tabs[0]));
    });
    const pageOk = (t) => t && t.url && !/^(chrome|chrome-extension|about|edge):/i.test(t.url);

    // None of these can work on a browser page (a new tab, the settings, the
    // extensions list). Area and Full page have to inject a script into the page,
    // which Chrome forbids there. Visible and Delayed photograph the tab, which
    // Chrome only allows under the activeTab grant - and activeTab is given when
    // the extension is *invoked* (a toolbar click that opens a popup, a shortcut, a
    // context-menu item). Clicking inside an already-open side panel is none of
    // those, so the grant never comes and the shot is refused. They used to sit
    // there enabled and simply fail; better to say so than to lie about it.
    const pageOnly = ['capVisibleBtn', 'capDelayedBtn', 'capAreaBtn', 'capFullBtn'];
    async function syncPageOnly() {
        const ok = pageOk(await activeTab());
        for (const id of pageOnly) {
            const b = $id(id);
            b.disabled = !ok;
            b.title = ok ? '' : 'Open a website first - Chrome does not allow capturing its own pages from the side panel';
        }
    }
    syncPageOnly();
    chrome.tabs.onActivated.addListener(syncPageOnly);
    chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) syncPageOnly(); });

    // Every capture closes the panel. The panel eats into the page's width, so a
    // shot taken while it is open is of a page squeezed into what is left - cut off
    // down one side. The worker does the capturing, and waits for the page to
    // reflow to its real width before it does; all this has to do is get out of
    // the way. (The waiting cannot live here: this script stops the moment the
    // panel closes.)
    const closePanel = (delay = 60) => setTimeout(() => window.close(), delay);
    const capture = async (act) => {
        // Pass the exact tab before closing the panel. In Chrome's default
        // spanning-incognito mode the worker's "current window" can be the
        // regular window even though this panel belongs to a private one.
        const tab = await activeTab();
        chrome.runtime.sendMessage({
            action: 'capPanelAction', act,
            targetTabId: tab && Number.isInteger(tab.id) ? tab.id : null
        });
        closePanel();
    };

    // A capture started from the floating button on the page closes the panel too.
    // The panel cannot see that click, so the worker tells it.
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.action === 'capClosePanel') closePanel();
    });

    $id('capVisibleBtn').addEventListener('click', () => capture('capture'));
    $id('capDelayedBtn').addEventListener('click', () => capture('delayed'));

    // Upload an image from the device and open it straight in the editor - the
    // same annotate/crop/share flow as a real capture, just sourced from a
    // file. The editor loads its image from storage.local[id]; ctx is optional
    // (a local file has no page context), so this needs nothing more than the
    // data URL under a fresh id.
    const uploadInput = $id('capUploadInput');
    $id('capUploadBtn').addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
        const file = uploadInput.files && uploadInput.files[0];
        uploadInput.value = ''; // let the same file be re-picked next time
        if (!file) return;
        if (!file.type.startsWith('image/')) { showToastMessage('Please choose an image file', 'error'); return; }
        const reader = new FileReader();
        reader.onload = () => {
            const id = 'upload_' + Date.now();
            const title = (file.name || 'image').replace(/\.[^.]+$/, '');
            // The panel stays open: Upload photographs nothing, so it is never in
            // the way of a shot - which is the only reason the capture buttons close it.
            chrome.storage.local.set({ [id]: reader.result, isVideo: false }, () => {
                qaOpenTabBeside(`capture/editor.html?id=${id}&title=${encodeURIComponent(title)}`);
            });
        };
        reader.onerror = () => showToastMessage('Could not read that file', 'error');
        reader.readAsDataURL(file);
    });

    // Full page is the one that suffered most: it measures the page to decide how
    // far to scroll, and a panel-narrowed page measured wrong from the first tile.
    $id('capAreaBtn').addEventListener('click', async () => {
        if (!pageOk(await activeTab())) { showToastMessage('Open a website first', 'error'); return; }
        capture('area');
    });

    $id('capFullBtn').addEventListener('click', async () => {
        if (!pageOk(await activeTab())) { showToastMessage('Open a website first', 'error'); return; }
        capture('full');
    });

    // The worker raises Chrome's own picker over the page. It used to open a
    // 710x540 window of ours to host it, which framed the picker inside an
    // extension window and put an entry in the taskbar - and the screenshot then
    // had to minimise that window so it wouldn't appear in its own shot.
    // No settle wait for these two: they photograph the SCREEN, not the tab, so the
    // panel's width never entered into it - and the picker gives it time to go anyway.
    $id('capScreenBtn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'capStartCapture', mode: 'screenshot' });
        window.close();
    });

    const recBtn = $id('capRecordBtn');
    const capCard = $id('capOptions');      // the panel carries the recording state
    const capLive = $id('capLive');

    // Expand/collapse through the shared accordion, exactly as Inspector and Auto
    // Refresh do - so opening this closes them, and opening one of them closes this.
    $id('capToolBtn').addEventListener('click', () => {
        toggleToolSection('capToolBtn', 'capOptions');
    });
    const capLiveTimer = $id('capLiveTimer');
    const capLiveText = $id('capLiveText');
    const capLivePause = $id('capLivePause');

    // While a recording runs the capture grid is swapped for its controls: taking
    // a shot or opening the editor mid-take breaks the recording, so those options
    // are removed rather than left there to be clicked by mistake.
    let liveTicker = null;
    let wasRecording = null;   // so the section is opened on the change, not on every paint
    const fmt = (ms) => {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const paintRecState = () => {
        chrome.storage.local.get(['isRecordingInProgress', 'recordingStartTime', 'recordingPaused'], (r) => {
            const on = !!r.isRecordingInProgress;
            // A recording is running and its Stop button lives in this panel - open
            // it, whatever the accordion was left set to. Done on the transition only,
            // so it is not forced back open every time the timer ticks.
            if (on && wasRecording !== true) openToolSection('capOptions');
            wasRecording = on;
            capCard.classList.toggle('recording', on);
            recBtn.classList.toggle('rec-on', on);
            recBtn.innerHTML = on ? '<i class="fas fa-stop"></i> Stop' : '<i class="fas fa-video"></i> Record';

            const paused = !!r.recordingPaused;
            capLive.classList.toggle('paused', paused);
            capLiveText.textContent = paused ? 'Paused' : 'Recording';
            capLivePause.innerHTML = paused
                ? '<i class="fas fa-play"></i> Resume'
                : '<i class="fas fa-pause"></i> Pause';

            clearInterval(liveTicker);
            liveTicker = null;
            if (!on) { capLiveTimer.textContent = '00:00'; return; }
            const start = r.recordingStartTime || Date.now();
            const tick = () => { capLiveTimer.textContent = fmt(Date.now() - start); };
            tick();
            if (!paused) liveTicker = setInterval(tick, 500);
        });
    };
    paintRecState();

    capLivePause.addEventListener('click', async () => {
        const r = await chrome.storage.local.get(['recordingPaused']);
        chrome.runtime.sendMessage({ action: r.recordingPaused ? 'requestResumeRecording' : 'requestPauseRecording' });
    });
    $id('capLiveStop').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'requestStopRecording' });
    });
    $id('capLiveDiscard').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'requestDiscardRecording' });
    });

    // Mic switch - the same `micEnabled` flag the page's floating menu writes, so
    // arming the mic in either place shows up in the other.
    const micToggle = $id('capMicToggle');
    const paintMicState = () => {
        chrome.storage.local.get(['micEnabled'], (r) => { micToggle.checked = !!r.micEnabled; });
    };
    paintMicState();
    micToggle.addEventListener('change', async () => {
        if (!micToggle.checked) {
            chrome.storage.local.set({ micEnabled: false });
            return;
        }
        // The recorder runs in an offscreen document, which has no UI and so can
        // never raise the microphone prompt. Ask for it HERE, the moment the
        // switch is turned on - a popup can show the prompt, and once granted the
        // recorder simply uses it. Without this, arming the mic would appear to
        // work and then record silence.
        try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            s.getTracks().forEach(t => t.stop());          // we only wanted the permission
            chrome.storage.local.set({ micEnabled: true });
        } catch (e) {
            micToggle.checked = false;
            chrome.storage.local.set({ micEnabled: false });
            showToastMessage('Microphone access was denied - recordings will have no voice', 'error');
        }
    });

    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.isRecordingInProgress || ch.recordingPaused || ch.recordingStartTime) paintRecState();
        if (ch.micEnabled) paintMicState();
    });

    recBtn.addEventListener('click', async () => {
        const r = await chrome.storage.local.get(['isRecordingInProgress']);
        if (r.isRecordingInProgress) {
            chrome.runtime.sendMessage({ action: 'requestStopRecording' });
            return;
        }
        chrome.runtime.sendMessage({ action: 'capStartCapture', mode: 'record' });
        window.close();
    });

    // Beside the tab you are looking at, not at the far end of the strip. The panel
    // is not itself a tab, so "beside me" means beside the active one.
    $id('capGalleryBtn').addEventListener('click', () => qaOpenTabBeside('capture/history.html'));

    // the background can't capture Chrome's own pages without an activeTab grant
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.action === 'capCaptureFailed') showToastMessage(msg.message, 'error');
    });

})();
