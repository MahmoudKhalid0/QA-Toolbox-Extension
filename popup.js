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
let smartFilterActive = true;

// Load profiles
document.addEventListener('DOMContentLoaded', async () => {
    // Get current tab URL for smart filtering
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tabs[0]?.url || '';

    await loadProfiles();
    await loadCategories();

    // Settings Button - Open separate tab
    document.getElementById('settingsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'settings.html' });
    });

    // Header Login button: opens settings and starts the Google sign-in there
    document.getElementById('loginBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'settings.html?signin=1' });
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
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true') });
});

// Tools tab accordion: opening one expandable tool collapses the others
const TOOL_SECTIONS = [
    { card: 'inspectorToolBtn', panel: 'inspectorOptions' },
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

// Highlight which inspect tool is currently picking; cleared when picking ends
const INSPECT_TOOL_IDS = ['inspectBtn', 'xpathBtn', 'aiXpathBtn', 'ocrBtn'];
let inspectStartingGuard = false;

// Every tool across every family (picking-mode, panel-based, and the
// "opens its own on-page panel" tools) - exactly one of these, or none, is
// ever the single active/highlighted one at a time. Extend this list when a
// new tool is added instead of wiring its own one-off clearing logic.
const ALL_TOOL_BTN_IDS = [
    'inspectBtn', 'xpathBtn', 'aiXpathBtn', 'ocrBtn', 'measureBtn',
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
    let netFilter = 'all';           // 'all' | 'failed' | 'xhr'
    let netFilteredCache = [];
    let netViewingFindings = false;
    let lastConsoleSig = '';
    let lastNetSig = '';
    const isFailed = (r) => r.status === 0 || r.status >= 400;
    const sigOf = (arr) => { const l = arr[arr.length - 1]; return arr.length + ':' + (l ? (l.ts || '') + ':' + (l.count || '') : ''); };

    const dEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
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
        if (!filteredCache.length) {
            list().innerHTML = '<div class="dbg-empty">No console messages captured yet.<br>Interact with the page and they\'ll show here.</div>';
            return;
        }
        const RENDER_CAP = 300; // keep the DOM light no matter how many were captured
        const note = filteredCache.length > RENDER_CAP
            ? `<div class="dbg-empty" style="padding:8px;">Showing newest ${RENDER_CAP} of ${filteredCache.length}.</div>` : '';
        list().innerHTML = note + filteredCache.slice(0, RENDER_CAP).map((l, i) =>
            `<div class="dbg-row ${dEsc(l.level)}">
                <span class="dbg-msg">${dEsc(l.message)}</span>
                ${l.count > 1 ? `<span class="dbg-count">×${l.count}</span>` : ''}
                ${l.source ? `<span class="dbg-src" data-src="${dEsc(l.source)}" title="Click to copy location">${dEsc(l.source)}</span>` : ''}
                <button class="dbg-copy" data-i="${i}" title="Copy"><i class="fas fa-copy"></i></button>
            </div>`).join('');
    }

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
        if (r.status === 0) return 'serr';
        if (r.status >= 500) return 's5xx';
        if (r.status >= 400) return 's4xx';
        if (r.status >= 300) return 's3xx';
        return 's2xx';
    }

    function netUpdateCounts() {
        const failed = netCache.filter(isFailed).length;
        document.getElementById('net-c-all').textContent = netCache.length;
        document.getElementById('net-c-failed').textContent = failed;
        document.getElementById('net-c-xhr').textContent = netCache.length;
        const nb = document.getElementById('dbgNetBadge');
        if (nb) { nb.textContent = failed || ''; nb.classList.toggle('show', failed > 0); }
        updateTabBadge();
    }

    function netRender() {
        netViewingFindings = false;
        lastNetSig = sigOf(netCache);
        let filtered = netCache;
        if (netFilter === 'failed') filtered = netCache.filter(isFailed);
        netFilteredCache = filtered.slice().reverse(); // newest first
        if (!netFilteredCache.length) {
            netList().innerHTML = '<div class="dbg-empty">No fetch/XHR requests captured yet.<br>Interact with the page and they\'ll show here.</div>';
            return;
        }
        const RENDER_CAP = 300; // keep the DOM light no matter how many were captured
        const note = netFilteredCache.length > RENDER_CAP
            ? `<div class="dbg-empty" style="padding:8px;">Showing newest ${RENDER_CAP} of ${netFilteredCache.length}.</div>` : '';
        netList().innerHTML = note + netFilteredCache.slice(0, RENDER_CAP).map((r, i) => {
            const dur = r.duration != null ? Math.round(r.duration) + 'ms' : '';
            const statusLabel = r.status === 0 ? (r.error || 'ERR') : r.status;
            return `<div class="net-row ${isFailed(r) ? 'failed' : ''}" data-i="${i}">
                <span class="net-method">${dEsc(r.method || '')}</span>
                <span class="net-status ${statusClass(r)}">${dEsc(statusLabel)}</span>
                <span class="net-url" title="${dEsc(r.url || '')}">${dEsc(r.url || '')}</span>
                <span class="net-dur">${dEsc(dur)}</span>
                <button class="net-copy" data-i="${i}" title="Copy"><i class="fas fa-copy"></i></button>
            </div>
            <div class="net-detail hidden" data-detail="${i}"></div>`;
        }).join('');
    }

    function prettyJson(str) {
        if (!str || typeof str !== 'string') return '';
        const t = str.trim();
        if (t[0] !== '{' && t[0] !== '[') return '';
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return ''; }
    }

    // Syntax-highlight a JSON string (input is raw text; returns safe HTML)
    function highlightJson(json) {
        const esc = dEsc(json);
        return esc.replace(/("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m) => {
            let cls = 'j-num';
            if (m[0] === '"') cls = /:\s*$/.test(m) ? 'j-key' : 'j-str';
            else if (m === 'true' || m === 'false') cls = 'j-bool';
            else if (m === 'null') cls = 'j-null';
            return `<span class="${cls}">${m}</span>`;
        });
    }

    function netDetailHtml(r) {
        const secH = (label, html) => html ? `<div class="nd-sec">${label}</div><pre>${html}</pre>` : '';
        const headersH = (h) => h && Object.keys(h).length
            ? Object.entries(h).map(([k, v]) => `<span class="nd-key">${dEsc(k)}</span>: <span class="nd-val">${dEsc(v)}</span>`).join('\n') : '';
        const bodyH = (b) => { const p = prettyJson(b); return p ? highlightJson(p) : dEsc(b || ''); };
        const statusH = r.status === 0
            ? `<span class="net-status serr">Failed</span>${r.error ? ' — <span class="nd-err">' + dEsc(r.error) + '</span>' : ''}`
            : `<span class="net-status ${statusClass(r)}">${r.status}</span> ${dEsc(r.statusText || '')}`;
        const preview = prettyJson(r.resBody);
        return `<div class="nd-sec">URL</div><pre class="nd-url">${dEsc(r.url || '')}</pre>`
            + secH('Status', statusH)
            + secH('Request Headers', headersH(r.reqHeaders))
            + secH('Request Body', bodyH(r.reqBody))
            + secH('Response Headers', headersH(r.resHeaders))
            + (preview ? secH('Preview', highlightJson(preview)) : '')
            + secH('Response Body', bodyH(r.resBody))
            + (r.initiator ? secH('Initiator', `<span class="nd-init">${dEsc(r.initiator)}</span>`) : '');
    }

    netList().addEventListener('click', (e) => {
        const copy = e.target.closest('.net-copy');
        if (copy) {
            e.stopPropagation();
            const r = netFilteredCache[+copy.dataset.i];
            if (!r) return;
            const txt = `${r.method} ${r.url}\nStatus: ${r.status === 0 ? 'Failed ' + (r.error || '') : r.status + ' ' + (r.statusText || '')}\n\nResponse:\n${r.resBody || ''}`;
            navigator.clipboard.writeText(txt).then(() => {
                const o = copy.innerHTML; copy.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => { copy.innerHTML = o; }, 1200);
            }).catch(() => { });
            return;
        }
        const row = e.target.closest('.net-row');
        if (!row) return;
        const i = +row.dataset.i;
        const detail = netList().querySelector(`[data-detail="${i}"]`);
        if (!detail) return;
        if (detail.classList.contains('hidden')) {
            detail.innerHTML = netDetailHtml(netFilteredCache[i]);
            detail.classList.remove('hidden');
        } else {
            detail.classList.add('hidden');
        }
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
    chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${id}`) });
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
    else if (confirm('Are you sure you want to delete this profile?')) {
        profiles = profiles.filter(p => p.id !== id && p.parentProfileId !== id);
        saveProfiles().then(() => renderProfiles());
    }
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

    // Only Area and Full page inject into the page. Visible and Delayed capture
    // whatever the tab shows, chrome:// pages included - never disable those.
    const pageOnly = ['capAreaBtn', 'capFullBtn'];
    async function syncPageOnly() {
        const ok = pageOk(await activeTab());
        for (const id of pageOnly) {
            const b = $id(id);
            b.disabled = !ok;
            b.title = ok ? '' : 'Open a website first';
        }
    }
    syncPageOnly();
    chrome.tabs.onActivated.addListener(syncPageOnly);
    chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) syncPageOnly(); });

    $id('capVisibleBtn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'capture' });
    });

    $id('capDelayedBtn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'delayedCapture' });
        showToastMessage('Capturing after the countdown…', 'success');
    });

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
            chrome.storage.local.set({ [id]: reader.result, isVideo: false }, () => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL(`capture/editor.html?id=${id}&title=${encodeURIComponent(title)}`)
                });
            });
        };
        reader.onerror = () => showToastMessage('Could not read that file', 'error');
        reader.readAsDataURL(file);
    });

    $id('capAreaBtn').addEventListener('click', async () => {
        const t = await activeTab();
        if (!pageOk(t)) { showToastMessage('Open a website first', 'error'); return; }
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['capture/area-selection.js'] });
    });

    $id('capFullBtn').addEventListener('click', async () => {
        const t = await activeTab();
        if (!pageOk(t)) { showToastMessage('Open a website first', 'error'); return; }
        showToastMessage('Scrolling & capturing the whole page…', 'success');
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['capture/full-page.js'] });
    });

    $id('capScreenBtn').addEventListener('click', async () => {
        const t = await activeTab();
        chrome.windows.create({
            url: chrome.runtime.getURL(`capture/entire-screen.html?tabId=${t ? t.id : ''}`),
            type: 'popup', width: 710, height: 540, focused: true
        });
    });

    const recBtn = $id('capRecordBtn');
    const capCard = $id('capCard');
    const capLive = $id('capLive');
    const capLiveTimer = $id('capLiveTimer');
    const capLiveText = $id('capLiveText');
    const capLivePause = $id('capLivePause');

    // While a recording runs the capture grid is swapped for its controls: taking
    // a shot or opening the editor mid-take breaks the recording, so those options
    // are removed rather than left there to be clicked by mistake.
    let liveTicker = null;
    const fmt = (ms) => {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const paintRecState = () => {
        chrome.storage.local.get(['isRecordingInProgress', 'recordingStartTime', 'recordingPaused'], (r) => {
            const on = !!r.isRecordingInProgress;
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
    micToggle.addEventListener('change', () => {
        chrome.storage.local.set({ micEnabled: micToggle.checked });
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
        const t = await activeTab();
        chrome.windows.create({
            url: chrome.runtime.getURL(`capture/entire-screen.html?mode=record&tabId=${t ? t.id : ''}`),
            type: 'popup', width: 710, height: 540, focused: true
        });
    });

    $id('capGalleryBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('capture/history.html') });
    });

    // the background can't capture Chrome's own pages without an activeTab grant
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.action === 'capCaptureFailed') showToastMessage(msg.message, 'error');
    });

})();
