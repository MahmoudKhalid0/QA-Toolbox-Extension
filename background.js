// Background script for QA Testing Toolkit
importScripts('db.js');
importScripts('config.js');
importScripts('sync.js');
importScripts('capture/cap-store.js');
importScripts('capture/cap-background.js');
importScripts('session-swap.js');         // quick login switch (Snapshot & Swap, no debugger)
importScripts('automation.js');           // AI automation-code generator (prompts + framework matrix)
importScripts('spellcheck-bg.js');        // Spelling & language check - AI proofreading + cache

// A recording is handed to the editor as a Blob in IndexedDB. If that editor tab
// was never opened - the browser was closed, it crashed - the Blob would sit
// there for good, so anything left over from a previous day is cleared out.
if (self.CapStore && self.CapStore.sweepPending) {
    self.CapStore.sweepPending().catch(() => { /* nothing to clean, or DB busy */ });
}

// Clicking the toolbar icon opens the side panel (the extension's main surface)
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
}

// ===== Console logs: in-memory ring buffer per tab (avoids the storage
// read-modify-write that made the old tool hang on log-heavy pages) =====
const consoleLogs = new Map();   // tabId -> [{ level, message, source, ts, count }]
const CONSOLE_CAP = 1000;

function addConsoleBatch(tabId, batch) {
    if (tabId == null) return;
    let arr = consoleLogs.get(tabId);
    if (!arr) { arr = []; consoleLogs.set(tabId, arr); }
    for (const item of batch) {
        const last = arr[arr.length - 1];
        if (last && last.level === item.level && last.message === item.message) {
            last.count += (item.count || 1);
            last.ts = item.ts;
        } else {
            arr.push(item);
        }
    }
    if (arr.length > CONSOLE_CAP) arr.splice(0, arr.length - CONSOLE_CAP);
    updateConsoleBadge(tabId);
}

// ===== Network requests: same per-tab in-memory ring buffer (fetch/XHR only,
// captured in the page; webRequest-on-all_urls is what hung the old tool) =====
const networkReqs = new Map();   // tabId -> [{ kind, method, url, status, ... }]
const NETWORK_CAP = 500;

function addNetworkBatch(tabId, batch) {
    if (tabId == null) return;
    let arr = networkReqs.get(tabId);
    if (!arr) { arr = []; networkReqs.set(tabId, arr); }
    for (const item of batch) arr.push(item);
    if (arr.length > NETWORK_CAP) arr.splice(0, arr.length - NETWORK_CAP);
    updateBadge(tabId);
}

// A resource (img/js/css/font) captured via timing has status 0 when it is a cross-origin
// opaque load - that is UNKNOWN, not a failure. Only fetch/XHR treat status 0 as an error.
// This must match the popup's isFailed exactly, or the toolbar badge counts failures the
// Debug panel doesn't show.
function isFailedReq(r) { return r.kind === 'resource' ? r.status >= 400 : (r.status === 0 || r.status >= 400); }

// Toolbar icon badge = console error rows + failed network requests for the tab
function updateBadge(tabId) {
    const logs = consoleLogs.get(tabId) || [];
    const reqs = networkReqs.get(tabId) || [];
    let count = 0;
    logs.forEach(l => { if (l.level === 'error') count += 1; }); // distinct error rows (matches the panel)
    reqs.forEach(r => { if (isFailedReq(r)) count += 1; });
    const text = count > 0 ? (count > 999 ? '999+' : String(count)) : '';
    try {
        chrome.action.setBadgeText({ tabId, text });
        if (text) chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
    } catch (e) { }
}
// Back-compat alias (console code still calls updateConsoleBadge)
const updateConsoleBadge = updateBadge;

// Clear a tab's data when it navigates to a new page (main frame)
chrome.webNavigation && chrome.webNavigation.onCommitted && chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) { consoleLogs.delete(d.tabId); networkReqs.delete(d.tabId); updateBadge(d.tabId); }
});
chrome.tabs.onRemoved.addListener((tabId) => { consoleLogs.delete(tabId); networkReqs.delete(tabId); });

// Keep an open Cookies & Storage panel in sync with cookies created or rotated
// by the page after the panel's initial snapshot. Domain matching is explicit so
// unrelated browsing activity never refreshes another site's panel.
function qaCookieDomainMatchesUrl(cookieDomain, tabUrl) {
    try {
        const host = new URL(tabUrl).hostname.toLowerCase();
        const domain = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
        return !!domain && (host === domain || host.endsWith('.' + domain));
    } catch (e) { return false; }
}

if (chrome.cookies && chrome.cookies.onChanged) {
    chrome.cookies.onChanged.addListener((changeInfo) => {
        const cookie = changeInfo && changeInfo.cookie;
        if (!cookie) return;
        chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs || []) {
                if (!tab.id || !qaCookieDomainMatchesUrl(cookie.domain, tab.url)) continue;
                chrome.tabs.sendMessage(tab.id, { action: 'storageCookiesChanged' }).catch(() => { });
            }
        });
    });
}

// ===== Auto Refresh: per-tab reload interval (seconds). The page's content
// script re-arms a timer on each load; the interval is kept here (and in
// storage) so it survives the reloads. =====
let autoRefresh = {};
chrome.storage.local.get('autoRefresh', (r) => { autoRefresh = (r && r.autoRefresh) || {}; });
function arSaveState() { try { chrome.storage.local.set({ autoRefresh }); } catch (e) { } }
chrome.tabs.onRemoved.addListener((tabId) => { if (autoRefresh[tabId]) { delete autoRefresh[tabId]; arSaveState(); } });

// ===== Clear Browsing Data — Automation (on browser startup / on tab close).
// Runs from the background using the data types saved in qaClearData. =====
const ORIGIN_SCOPED_TYPES =['cookies', 'localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers', 'fileSystems', 'webSQL'];
const tabUrlCache = {};
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab && tab.url) tabUrlCache[id] = tab.url; });
chrome.tabs.onRemoved.addListener((id) => { const url = tabUrlCache[id]; delete tabUrlCache[id]; autoClearOnTabClosed(url); });

// ── Time Machine ────────────────────────────────────────────────────────────
// These run in the page's MAIN world (serialized by executeScript, so they must
// be fully self-contained). The real installer lives in modules/time-machine.js,
// which is a document_start content script - it is the only thing that beats the
// page's own first script. These two only handle the page that is ALREADY loaded
// when the user hits Apply / Reset.
function qaTMInstall(cfg) {
    try {
        const W = window;
        // Seed the per-tab config so the document_start script re-installs the
        // override on every future reload/navigation, before any page script runs.
        try { sessionStorage.setItem('__qaTM', JSON.stringify(cfg)); } catch (e) { }
        if (W.__qaTMInstall) { W.__qaTMInstall(cfg); return; }
    } catch (e) { }
}
function qaTMUninstall() {
    try {
        try { sessionStorage.removeItem('__qaTM'); } catch (e) { }
        const W = window;
        if (W.__qaTMUninstall) { W.__qaTMUninstall(); return; }
        if (W.__qaRealDate) { W.Date = W.__qaRealDate; W.__qaTMInstalled = false; W.__qaTMcfg = null; }
    } catch (e) { }
}
// A belt-and-braces re-apply for frames whose sessionStorage we can't seed (a
// cross-origin child frame keeps its own storage). The document_start script is
// what actually makes the override land on time; this only tops it up.
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'loading') return;
    chrome.storage.local.get(['qaTM'], (r) => {
        const cfg = r.qaTM && r.qaTM[tabId];
        if (!cfg) return;
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: qaTMInstall, args: [cfg] }).catch(() => { });
    });
});
chrome.tabs.onRemoved.addListener((id) => { chrome.storage.local.get(['qaTM'], (r) => { const m = r.qaTM || {}; if (m[id] !== undefined) { delete m[id]; chrome.storage.local.set({ qaTM: m }); } }); });
// Tab ids are reused across browser sessions, so stale entries would silently
// fake the clock in an unrelated tab. The override never survives a restart
// anyway — drop the state whenever the extension or the browser starts.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('qaTM'));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('qaTM'));

async function getClearCfg() { const r = await chrome.storage.local.get('qaClearData'); return Object.assign({ types: {}, auto: {} }, (r && r.qaClearData) || {}); }

function domainsToOrigins(hosts) {
    const out = [];
    (hosts || []).forEach(h => {
        h = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (h) { out.push('https://' + h, 'http://' + h); }
    });
    return out;
}
async function clearCookiesForDomain(host) {
    const bare = host.replace(/:\d+$/, ''); // cookies aren't port-specific
    try {
        const cookies = await chrome.cookies.getAll({ domain: bare });
        for (const c of cookies) {
            const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
            try { await chrome.cookies.remove({ url, name: c.name }); } catch (e) { }
        }
        return cookies.length;
    } catch (e) { return 0; }
}
async function runAutoClear(originOnly) {
    try {
        const cfg = await getClearCfg();
        const types = Object.keys(cfg.types || {}).filter(k => cfg.types[k]);
        if (!types.length) return;
        const want = new Set(types);
        const domains = originOnly ? [(() => { try { return new URL(originOnly).host; } catch (e) { return ''; } })()].filter(Boolean)
            : ((cfg.auto && cfg.auto.domains) || []);

        if (domains.length) {
            // Per-site clear. Cookies go through chrome.cookies (matches domain +
            // subdomains, ignores port); other storage via browsingData origins.
            let n = 0;
            if (want.has('cookies')) for (const d of domains) n += await clearCookiesForDomain(d);
            const storageTypes = ['localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers', 'fileSystems', 'webSQL'].filter(t => want.has(t));
            if (storageTypes.length) {
                const obj = {}; storageTypes.forEach(t => obj[t] = true);
                await chrome.browsingData.remove({ since: 0, origins: domainsToOrigins(domains) }, obj);
            }
            console.log('[QA auto-clear] domains', domains, 'types', types, 'cookies removed', n);
        } else {
            // No domains -> wipe ALL sites and ALL data types
            const ALL = ['cache', 'cacheStorage', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL', 'downloads', 'formData', 'history', 'passwords'];
            const obj = {}; ALL.forEach(t => obj[t] = true);
            await chrome.browsingData.remove({ since: 0 }, obj);
            console.log('[QA auto-clear] all sites, all types');
        }
    } catch (e) { console.error('auto clear:', e); }
}
function autoClearOnTabClosed(url) {
    if (!url || !/^https?:/i.test(url)) return;
    getClearCfg().then(cfg => {
        if (!cfg.auto || !cfg.auto.tabClose) return;
        let origin = ''; try { origin = new URL(url).origin; } catch (e) { return; }
        runAutoClear(origin);
    });
}
chrome.runtime.onStartup.addListener(() => { getClearCfg().then(cfg => { if (cfg.auto && cfg.auto.startup) runAutoClear(); }); });

// Migration: Move profiles from sync/local storage to IndexedDB
(async () => {
    try {
        // First migrate from sync to local (for backwards compatibility)
        const syncResult = await chrome.storage.sync.get(['formFillerProfiles']);
        if (syncResult.formFillerProfiles && syncResult.formFillerProfiles.length > 0) {
            // Save temporary to local
            await chrome.storage.local.set({ formFillerProfiles: syncResult.formFillerProfiles });
            await chrome.storage.sync.remove('formFillerProfiles');
            console.log('Moved profiles from sync to local storage');
        }

        // Then migrate from local to IndexedDB
        const migrated = await FormFillerDB.migrateFromLocalStorage();
        if (migrated > 0) {
            console.log('Migration to IndexedDB complete:', migrated, 'profiles');
        }

        // One-time cleanup: drop the old auto-seeded categories (Work, Personal,
        // Testing, عام) unless a profile uses them. "General" is the only built-in.
        const flag = await chrome.storage.local.get(['categoriesCleanupV1']);
        if (!flag.categoriesCleanupV1) {
            const catResult = await chrome.storage.sync.get(['formFillerCategories']);
            const before = catResult.formFillerCategories;
            // A fresh install has no categories to clean. Writing ['General']
            // here anyway stamped a brand-new device with Date.now(), and that
            // stamp then out-voted every real category on the user's other
            // machine the first time they signed in. Do nothing until there is
            // something to do.
            if (Array.isArray(before) && before.length) {
                const profiles = await FormFillerDB.getAllProfiles().catch(() => []);
                const used = new Set(profiles.map(p => p.category).filter(Boolean));
                const oldDefaults = ['Work', 'Personal', 'Testing', 'عام'];
                const cats = before.filter(c => !oldDefaults.includes(c) || used.has(c));
                if (!cats.includes('General')) cats.unshift('General');
                if (JSON.stringify(cats) !== JSON.stringify(before)) {
                    // A local cleanup is still a deletion - say so, or the merge
                    // will faithfully restore what we just removed.
                    const store = await chrome.storage.sync.get(['formFillerCategoryTombstones']);
                    const tombs = store.formFillerCategoryTombstones || {};
                    before.filter(c => !cats.includes(c)).forEach(c => { tombs[String(c).toLowerCase()] = Date.now(); });
                    await chrome.storage.sync.set({
                        formFillerCategories: cats,
                        formFillerCategoriesUpdatedAt: Date.now(),
                        formFillerCategoryTombstones: tombs
                    });
                    console.log('Categories cleanup done:', cats);
                }
            }
            await chrome.storage.local.set({ categoriesCleanupV1: true });
        }
    } catch (e) {
        console.error('Migration error:', e);
    }
})();

// In-memory recording state (replaces chrome.storage.sync for recording state)
let recordingState = {
    isRecording: false,
    appendToProfileId: null,
    isReplacementMode: false,
    tabId: null
};

async function clearRecordingState() {
    recordingState.isRecording = false;
    recordingState.appendToProfileId = null;
    recordingState.isReplacementMode = false;
    recordingState.tabId = null;
    await chrome.storage.sync.remove(['isRecordingActive', 'appendToProfileId']);
    chrome.runtime.sendMessage({ action: 'recordingStopped' }).catch(() => { });
}

// Shared by single-capture delete and workspace delete: trash the Drive file
// behind a record's link, if it has one. true = revoked, false = it had a link
// but revoking failed (the record is removed locally regardless), null = there
// was never a link to begin with.
async function revokeCaptureLink(rec) {
    const fileId = rec && (rec.cloudFileId || (String(rec.cloudUrl || '').match(/\/d\/([^/]+)/) || [])[1]);
    if (!fileId) return null;
    try {
        await CloudSync.driveTrashFile(fileId);
        return true;
    } catch (e) {
        console.error('Could not revoke the shared link:', e);
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'openEditorWithFields') {
        (async () => {
            let appendToId = request.appendToProfileId;
            if (!appendToId) {
                const syncResult = await chrome.storage.sync.get(['appendToProfileId']);
                appendToId = syncResult.appendToProfileId;
            }

            console.log('=== openEditorWithFields ===');
            console.log('appendToProfileId:', appendToId);

            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }

            if (appendToId) {
                console.log('Searching for profile ID:', appendToId, 'Type:', typeof appendToId);
                console.log('Total profiles loaded:', profiles.length);
                if (profiles.length > 0) {
                    console.log('First profile ID example:', profiles[0].id, 'Type:', typeof profiles[0].id);
                }

                // Be robust with ID comparison (string vs number)
                const profileIndex = profiles.findIndex(p => {
                    const match = String(p.id) === String(appendToId);
                    if (match) console.log('MATCH FOUND at index', profiles.indexOf(p));
                    return match;
                });
                console.log('Profile index result:', profileIndex);

                if (profileIndex >= 0) {
                    console.log('SUCCESS: Profile found to append to:', profiles[profileIndex].name);
                    const existingSelectors = new Set(profiles[profileIndex].fields.map(f => f.selector));
                    const newFields = request.fields
                        .filter(f => !existingSelectors.has(f.selector))
                        .map(f => ({ ...f, uniqueText: false, uniqueNumber: false, digits: 5 }));

                    // Clear state immediately since we are processing
                    await chrome.storage.sync.remove(['appendToProfileId', 'isRecordingActive']);
                    await chrome.storage.local.remove(['currentAppendToProfileId', 'recordedFields', 'recordedUrl']);

                    if (newFields.length > 0) {
                        profiles[profileIndex].fields = [...profiles[profileIndex].fields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                        } catch (err) {
                            await chrome.storage.local.set({ formFillerProfiles: profiles });
                        }

                        chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${appendToId}`) });
                        sendResponse({ success: true, addedCount: newFields.length });
                    } else {
                        // No new fields were added
                        sendResponse({ success: true, noNewFields: true });
                    }
                    return;
                }
            }

            // If not appending or profile not found, handle as new profile
            await chrome.storage.local.set({
                pendingNewProfile: { fields: request.fields, url: request.url || '' }
            });
            chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
            sendResponse({ success: true });
        })();
        return true;
    }

    if (request.action === 'openNewProfileEditor') {
        chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
        return true;
    }

    if (request.action === 'openEditorPage') {
        chrome.tabs.create({ url: request.url });
        return true;
    }

    // Get profiles - for content.js to access IndexedDB
    if (request.action === 'getProfiles') {
        (async () => {
            try {
                const profiles = await FormFillerDB.getAllProfiles();
                sendResponse({ profiles: profiles });
            } catch (err) {
                const result = await chrome.storage.local.get(['formFillerProfiles']);
                sendResponse({ profiles: result.formFillerProfiles || [] });
            }
        })();
        return true;
    }

    // Save profiles - for content.js or editor.js
    if (request.action === 'saveProfiles') {
        (async () => {
            try {
                // Deletions arrive as "the new list is missing some ids".
                // Record them as tombstones so cloud sync propagates the delete
                // instead of resurrecting the profile from another device.
                try {
                    const before = await FormFillerDB.getAllProfiles();
                    const newIds = new Set((request.profiles || []).map(p => String(p.id)));
                    const removed = before.filter(p => !newIds.has(String(p.id)));
                    if (removed.length > 0) {
                        const r = await chrome.storage.local.get(['syncTombstones']);
                        const tombs = r.syncTombstones || {};
                        removed.forEach(p => { tombs[String(p.id)] = Date.now(); });
                        await chrome.storage.local.set({ syncTombstones: tombs });
                    }
                } catch (e) { }

                await FormFillerDB.saveAllProfiles(request.profiles);
                broadcastProfilesUpdated();
                sendResponse({ success: true });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // ---- Cloud Sync (settings page UI) ----
    if (request.action === 'syncSignIn') {
        CloudSync.syncSignIn()
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ success: false, error: String(err.message || err) }));
        return true;
    }
    if (request.action === 'syncSignOut') {
        CloudSync.syncSignOut().then(result => sendResponse(result));
        return true;
    }
    if (request.action === 'syncNow') {
        CloudSync.syncNow(true).then(result => sendResponse(result));
        return true;
    }
    if (request.action === 'syncStatus') {
        CloudSync.syncGetMeta().then(meta => sendResponse(meta));
        return true;
    }
    // Settings/categories changed (no profile change involved) - push too
    if (request.action === 'scheduleCloudPush') {
        CloudSync.syncSchedulePush();
        return false;
    }

    // Deleting a capture revokes its link. A screenshot removed from the gallery
    // whose URL still opens for whoever you sent it to is not deleted.
    if (request.action === 'deleteCapture') {
        (async () => {
            const revoked = await revokeCaptureLink(await CapStore.get(request.id));
            await CapStore.remove(request.id);
            sendResponse({ success: true, revoked });
        })();
        return true;
    }

    // Deleting a workspace is deleting everything a user named it into: every
    // capture inside it, and the Drive folder itself, so a rename-by-recreating
    // never leaves an orphaned folder behind. The gallery confirms this with the
    // user before ever sending it - here it is unconditional.
    if (request.action === 'deleteWorkspace') {
        (async () => {
            try {
                const all = await CapStore.list();
                const matches = all.filter(it => it.workspace === request.name);

                let stuck = 0;
                for (const it of matches) {
                    const ok = await revokeCaptureLink(it);
                    if (ok === false) stuck++;
                    await CapStore.remove(it.id);
                }

                let folderRemoved = false;
                try {
                    folderRemoved = await CloudSync.driveTrashWorkspace(request.name);
                } catch (e) {
                    console.error('Could not remove the workspace folder:', e);
                }

                sendResponse({ success: true, removed: matches.length, stuck, folderRemoved });
            } catch (err) {
                sendResponse({ success: false, error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Share a capture. The blob is read here, from IndexedDB, rather than sent
    // through a message - a recording does not belong in a base64 string.
    if (request.action === 'shareCapture') {
        (async () => {
            try {
                let rec = await CapStore.get(request.id);
                if (!rec || !rec.blob) throw new Error('That capture is no longer stored on this device');

                // Already shared and unchanged: the editor asks for the link, not an upload.
                if (rec.cloudUrl && !request.replace) {
                    return sendResponse({ success: true, url: rec.cloudUrl, existing: true });
                }

                // A recording never passes through capLibrarySave, so the title the
                // user confirmed reaches the record only from here.
                if (request.title && request.title !== rec.title) {
                    await CapStore.patch(request.id, { title: request.title });
                    rec = await CapStore.get(request.id);
                }

                // The file is named for the tab it was taken from. Drive tolerates
                // most characters; the ones a filesystem never does are replaced,
                // so the same name survives a download.
                const ext = rec.type === 'video' ? 'webm' : 'png';
                const stamp = new Date(rec.createdAt || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
                // Characters a filesystem refuses, so the name survives a download.
                const ILLEGAL = /[\\\/:*?"<>|]/g;
                const safe = String(rec.title || '').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim();
                const name = `${(safe || 'Capture').slice(0, 60)} ${stamp}.${ext}`;

                // Upload exactly what the editor is showing. Prefer the canvas
                // the button sent over the stored blob, so a just-made edit can
                // never be missed by a race with the library write.
                const blob = request.dataUrl ? await CapStore.dataUrlToBlob(request.dataUrl) : rec.blob;
                const reuseId = request.replace ? rec.cloudFileId : null;
                // A replace keeps whatever workspace the file already lives in;
                // only a first share is filed into the one the user picked.
                const { id, url, workspace, recreated } = await CloudSync.driveShareBlob(blob, name, true, reuseId, request.workspace);
                const patch = { cloudUrl: url, cloudFileId: id, sharedAt: Date.now() };
                if (workspace) patch.workspace = workspace;
                await CapStore.patch(request.id, patch);
                // `recreated` = the old Drive file was gone for good, so this is a
                // new file with a NEW link - the editor must say so, not "same link".
                sendResponse({ success: true, url, workspace: workspace || rec.workspace, recreated });
            } catch (err) {
                sendResponse({ success: false, error: String(err.message || err) });
            }
        })();
        return true;
    }

    // The workspace picker in the share dialog: every folder that already
    // exists in Drive, so a second machine signed into the same account sees
    // exactly the same list.
    if (request.action === 'listWorkspaces') {
        (async () => {
            try {
                const { workspaces, defaultName } = await CloudSync.driveListWorkspaces();
                sendResponse({ success: true, workspaces, defaultName });
            } catch (err) {
                sendResponse({ success: false, error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Creating an empty workspace from the gallery, not just at share time -
    // this just files (or finds) the Drive folder; nothing local changes until
    // something is actually shared into it.
    if (request.action === 'createWorkspace') {
        (async () => {
            try {
                const { id, name } = await CloudSync.driveWorkspaceFolderId(request.name);
                sendResponse({ success: true, id, name });
            } catch (err) {
                sendResponse({ success: false, error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Get recording state for content.js on page load
    if (request.action === 'getRecordingState') {
        sendResponse({
            isRecording: recordingState.isRecording,
            appendToProfileId: recordingState.appendToProfileId,
            isReplacementMode: recordingState.isReplacementMode || false
        });
        return true;
    }

    // Content script started recording in its tab - track which tab it is
    if (request.action === 'recordingStarted') {
        recordingState.isRecording = true;
        recordingState.appendToProfileId = request.appendToProfileId || recordingState.appendToProfileId;
        recordingState.tabId = sender.tab ? sender.tab.id : null;
        // Tell the side panel so it shows the recording state (e.g. when
        // recording was started from the on-page re-record modal)
        chrome.runtime.sendMessage({
            action: 'recordingUiSync',
            isRecording: true,
            appendToProfileId: recordingState.appendToProfileId
        }).catch(() => { });
        sendResponse({ success: true });
        return true;
    }

    // A page loaded. If it's the tab that was recording, the page was
    // refreshed mid-recording - recording does not survive that, stop it
    if (request.action === 'recordingPageLoaded') {
        (async () => {
            const senderTabId = sender.tab ? sender.tab.id : null;
            const tabMatches = !recordingState.tabId || recordingState.tabId === senderTabId;
            if (recordingState.isRecording && tabMatches) {
                await clearRecordingState();
            }
            sendResponse({ success: true });
        })();
        return true;
    }

    // Handle stop recording from content.js - ALL LOGIC VIA INDEXEDDB
    if (request.action === 'handleStopRecording') {
        (async () => {
            const fields = request.fields;
            const appendToId = request.appendToProfileId;
            const url = request.url;

            console.log('=== handleStopRecording ===');
            console.log('Fields:', fields?.length, 'AppendTo:', appendToId);

            // Check if this is replacement mode (from state or request or storage)
            const storageData = await chrome.storage.local.get(['failedFields', 'profileIdForReplacement']);
            const failedFields = storageData.failedFields || [];
            const hasFailedFields = failedFields.length > 0;
            const profileIdMatches = hasFailedFields && storageData.profileIdForReplacement && String(storageData.profileIdForReplacement) === String(appendToId);
            const isReplacementMode = recordingState.isReplacementMode || request.isReplacementMode || profileIdMatches;

            console.log('Replacement mode check:', {
                isReplacementMode,
                hasFailedFields,
                profileIdMatches,
                failedFieldsCount: failedFields.length,
                appendToId,
                storedProfileId: storageData.profileIdForReplacement
            });

            // Clear recording state everywhere (in-memory + storage) and tell the
            // side panel, which stays open and can't detect the stop on its own
            await clearRecordingState();

            if (!fields || fields.length === 0) {
                sendResponse({ success: true, message: 'No fields' });
                return;
            }

            // Load profiles from IndexedDB
            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                console.error('Error loading profiles:', err);
                sendResponse({ success: false, error: err.message });
                return;
            }

            console.log('Profiles loaded:', profiles.length);

            if (appendToId) {
                // Find profile with String comparison
                const profileIndex = profiles.findIndex(p => String(p.id) === String(appendToId));
                console.log('Profile index:', profileIndex);

                if (profileIndex >= 0) {
                    if (isReplacementMode && failedFields.length > 0) {
                        // REPLACEMENT MODE: Only remove fields that have a "replacement" (matched by value)
                        console.log('Replacement mode: Checking replacements for', failedFields.length, 'failed fields');

                        // Determine which fields to remove (those that have a new field with the same value)
                        const newValues = new Set(fields.map(f => f.value));
                        const selectorsToRemove = failedFields
                            .filter(ff => newValues.has(ff.value))
                            .map(ff => ff.selector);

                        console.log('Selectors to remove (matched by value):', selectorsToRemove);

                        // Keep fields that are NOT in the removal list
                        const remainingFields = profiles[profileIndex].fields.filter(
                            f => !selectorsToRemove.includes(f.selector)
                        );

                        const existingSelectors = new Set(remainingFields.map(f => f.selector));

                        // Add ONLY new fields (that don't already exist in remaining)
                        const newFields = fields
                            .filter(f => !existingSelectors.has(f.selector))
                            .map(f => ({
                                ...f,
                                uniqueText: false,
                                uniqueNumber: false,
                                digits: 5
                            }));

                        profiles[profileIndex].fields = [...remainingFields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                            broadcastProfilesUpdated();
                            console.log('Saved smart-merged profile to IndexedDB');
                        } catch (err) {
                            console.error('Save error:', err);
                        }

                        // Clear failed fields from storage
                        await chrome.storage.local.remove(['failedFields', 'profileIdForReplacement']);

                        // Open editor with scroll to new fields (only if there are new fields)
                        if (newFields.length > 0) {
                            chrome.tabs.create({
                                url: chrome.runtime.getURL(`editor.html?id=${appendToId}&scrollToNew=true&newFieldsCount=${newFields.length}`)
                            });
                            sendResponse({ success: true, replacedCount: newFields.length });
                        } else {
                            sendResponse({ success: true, noNewFields: true });
                        }
                        return;
                    } else {
                        // NORMAL APPEND MODE: Just add new fields
                        // Get existing selectors
                        const existingSelectors = new Set(
                            profiles[profileIndex].fields.map(f => f.selector)
                        );

                        // Filter duplicates
                        const newFields = fields
                            .filter(f => !existingSelectors.has(f.selector))
                            .map(f => ({ ...f, uniqueText: false, uniqueNumber: false, digits: 5 }));

                        if (newFields.length === 0) {
                            console.log('No new fields to add');
                            sendResponse({ success: true, noNewFields: true });
                            return;
                        }

                        // Add fields and save
                        profiles[profileIndex].fields = [...profiles[profileIndex].fields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                            broadcastProfilesUpdated();
                            console.log('Saved to IndexedDB');
                        } catch (err) {
                            console.error('Save error:', err);
                        }

                        // Open editor
                        chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${appendToId}`) });
                        sendResponse({ success: true, addedCount: newFields.length });
                        return;
                    }
                }
            }

            // New profile - save pending fields
            await chrome.storage.local.set({ pendingNewProfile: { fields, url } });

            chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
            sendResponse({ success: true, newProfile: true });
        })();
        return true;
    }

    if (request.action === 'getMatchingProfiles') {
        (async () => {
            const url = request.url;
            let profiles = [];
            try {
                await FormFillerDB.initDB();
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }
            // Smart Filter Logic: Use isUrlMatch helper (handles sub-paths, ports, query params)
            const matching = profiles.filter(p => {
                if (!p.url) return false;
                try {
                    return FormFillerDB.isUrlMatch(url, p.url);
                } catch (e) {
                    console.error('Matching error:', e);
                    return false;
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

            sendResponse({ profiles: matching });
        })();
        return true;
    }

    if (request.action === 'getSettings') {
        chrome.storage.sync.get(['formFillerSettings'], (result) => {
            const defaultSettings = { randomDigits: 5, showFloatingButton: true, fieldAiIcon: true, charCounter: true };
            sendResponse({ settings: result.formFillerSettings || defaultSettings });
        });
        return true;
    }

    if (request.action === 'checkUrlMatch') {
        try {
            const matches = FormFillerDB.isUrlMatch(request.currentUrl, request.profileUrl);
            sendResponse({ matches });
        } catch (e) {
            sendResponse({ matches: false });
        }
        return true;
    }

    if (request.action === 'startRecordingForReplacement') {
        recordingState.isRecording = true;
        recordingState.appendToProfileId = request.profileId;
        recordingState.isReplacementMode = true; // Flag for replacement mode
        recordingState.tabId = sender.tab ? sender.tab.id : null;

        // Save to storage so popup can detect recording state
        chrome.storage.sync.set({
            appendToProfileId: request.profileId,
            isRecordingActive: true
        });

        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'fillProfile') {
        (async () => {
            const { profileId } = request;
            const tabId = sender.tab.id;
            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }
            const profile = profiles.find(p => String(p.id) === String(profileId));
            if (profile) {
                const syncResult = await chrome.storage.sync.get(['formFillerSettings']);
                const settings = syncResult.formFillerSettings || { randomDigits: 5 };
                try {
                    // Use the content script's fill engine (the single up-to-date one,
                    // with richtext/checkbox/radio/combobox support) instead of injecting
                    // the legacy copy below. The sender IS the content script, so it exists.
                    await chrome.tabs.sendMessage(tabId, {
                        action: 'fillForm',
                        fields: profile.fields,
                        settings,
                        profileId: profile.id,
                        profileUrl: profile.url
                    });
                    sendResponse({ success: true });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            } else {
                sendResponse({ success: false, error: 'Profile not found' });
            }
        })();
        return true;
    }

    // AI Profile: scan the form on the tab, generate data via Claude, save the profile, and fill the form
    if (request.action === 'aiCreateProfile') {
        (async () => {
            try {
                // tabId comes from the popup; from the floating button it is the sender tab
                const tabId = request.tabId || (sender.tab && sender.tab.id);

                const apiKey = AI_CONFIG.apiKey;
                if (!apiKey) {
                    sendResponse({ success: false, error: 'no_api_key' });
                    return;
                }

                // Limit: max 5 profiles per exact URL (hash/trailing slash ignored).
                // Checked before scanning or calling the API - saves tokens when at the limit.
                const tab = await chrome.tabs.get(tabId);
                const normalizeUrl = (u) => String(u || '').split('#')[0].trim().replace(/\/+$/, '');
                const currentUrl = normalizeUrl(tab && tab.url);
                try {
                    const existingProfiles = await FormFillerDB.getAllProfiles();
                    const sameUrlCount = existingProfiles.filter(p => p && p.url && normalizeUrl(p.url) === currentUrl).length;
                    if (sameUrlCount >= 5) {
                        sendResponse({ success: false, error: 'profile_limit' });
                        return;
                    }
                } catch (e) { }

                const catResult = await chrome.storage.sync.get(['formFillerCategories']);
                let categories = catResult.formFillerCategories || [];
                if (categories.length === 0) categories = ['General'];

                const settingsRes = await chrome.storage.sync.get(['formFillerSettings']);
                const settings = settingsRes.formFillerSettings || { randomDigits: 5 };

                const profileId = 'ai_' + Date.now();
                const allFields = [];
                const knownSelectors = new Set();
                let profileName = '';
                let aiCategory = '';
                let pageUrl = '';
                let sawAnyField = false;

                // Multi-pass: filling fields can reveal new conditional fields,
                // so re-scan after each fill and handle anything new (max 3 passes)
                for (let pass = 0; pass < 3; pass++) {
                    // Custom dropdowns must be opened to be read, so tell the scan which
                    // ones an earlier pass already handled - it then only opens the NEW
                    // ones a conditional rule has just revealed.
                    const scan = await chrome.tabs.sendMessage(tabId, {
                        action: 'scanFormFields',
                        captureCombo: true,
                        known: Array.from(knownSelectors)
                    });
                    if (!scan || !scan.fields) break;
                    if (!pageUrl) pageUrl = scan.url;
                    if (scan.fields.length > 0) sawAnyField = true;


                    // Only fields not handled in a previous pass, re-indexed for the AI
                    const newScanned = scan.fields
                        .filter(f => !knownSelectors.has(f.selector))
                        .map((f, i) => ({ ...f, index: i }));
                    if (newScanned.length === 0) break;
                    newScanned.forEach(f => knownSelectors.add(f.selector));

                    const ai = await generateProfileWithAI(apiKey, { ...scan, fields: newScanned }, categories, pass > 0);

                    // The AI judges whether the scanned fields are a REAL form or just
                    // page controls (search box, pagination, page-size select...)
                    if (pass === 0 && ai.isRealForm === false) {
                        sendResponse({ success: false, error: 'no_form' });
                        return;
                    }

                    if (!profileName) {
                        profileName = ai.profileName || 'AI Profile';
                        aiCategory = ai.category;
                    }

                    const passFields = mapAiValuesToFields(ai, newScanned);
                    if (passFields.length === 0) break;
                    allFields.push(...passFields);

                    // Fill this pass now - this is what triggers conditional fields to appear.
                    // profileUrl is empty on purpose: skips the URL check and the failed-fields modal.
                    try {
                        await chrome.tabs.sendMessage(tabId, {
                            action: 'fillForm',
                            fields: passFields,
                            settings,
                            profileId: profileId,
                            profileUrl: ''
                        });
                    } catch (fillErr) {
                        console.warn('AI fill failed:', fillErr);
                        break;
                    }

                    // Give the page time to render any conditional fields. A field that
                    // appears because of what we just filled usually has to fetch its own
                    // options first, and half a second was not enough - we re-scanned
                    // before it existed and left it unselected.
                    if (pass < 2) await new Promise(r => setTimeout(r, 1500));
                }

                if (!sawAnyField) {
                    sendResponse({ success: false, error: 'no_fields' });
                    return;
                }
                if (allFields.length === 0) {
                    sendResponse({ success: false, error: 'no_values' });
                    return;
                }

                const profile = {
                    id: profileId,
                    name: profileName || 'AI Profile',
                    category: categories.includes(aiCategory) ? aiCategory : 'General',
                    url: pageUrl,
                    fields: allFields,
                    onReload: false,
                    createdByAI: true,
                    lastModified: Date.now()
                };

                // Saving behavior: 'ask' (default) shows the on-page prompt,
                // 'always' saves silently, 'never' fills only and stays quiet
                const flagRes = await chrome.storage.local.get(['aiSaveBehavior', 'aiAutoSaveProfiles']);
                const behavior = flagRes.aiSaveBehavior || (flagRes.aiAutoSaveProfiles ? 'always' : 'ask');

                let saved = false;
                let prompted = false;
                if (behavior === 'always') {
                    // saveProfile upserts by id - updates the existing AI profile or adds a new one
                    await FormFillerDB.saveProfile(profile);
                    broadcastProfilesUpdated();
                    saved = true;
                } else if (behavior !== 'never') {
                    chrome.tabs.sendMessage(tabId, { action: 'showAiSavePrompt', profile }).catch(() => { });
                    prompted = true;
                }

                sendResponse({ success: true, saved, prompted, profileName: profile.name, fieldCount: allFields.length });
            } catch (e) {
                console.error('aiCreateProfile error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Save an AI-generated profile after the user confirmed via the on-page prompt
    if (request.action === 'saveAiProfile') {
        (async () => {
            try {
                // Upsert by id - updates an existing AI profile or adds a new one
                await FormFillerDB.saveProfile(request.profile);
                broadcastProfilesUpdated();

                if (request.dontAskAgain) {
                    await chrome.storage.local.set({ aiSaveBehavior: 'always' });
                }

                sendResponse({ success: true });
            } catch (e) {
                console.error('saveAiProfile error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Fill a rich text editor from the page's MAIN world. Editors like CKEditor 5
    // keep their content in a JS model that reverts direct DOM writes, and their
    // APIs (el.ckeditorInstance) are invisible to the content script's isolated world.
    if (request.action === 'fillRichText') {
        (async () => {
            try {
                const tabId = sender.tab.id;
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: (selector, value) => {
                        const getEl = (sel) => {
                            try {
                                if (sel.startsWith('/') || sel.startsWith('(')) {
                                    const q = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                    return q.singleNodeValue;
                                }
                                return document.querySelector(sel);
                            } catch (e) { return null; }
                        };
                        const el = getEl(selector);
                        if (!el) return false;

                        // Plain text escaped as paragraphs, for editors that take HTML
                        const escHtml = String(value)
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .split('\n').filter(s => s.trim()).map(s => '<p>' + s + '</p>').join('');

                        // CKEditor 5: official API attached to the editable element
                        if (el.ckeditorInstance) {
                            el.ckeditorInstance.setData(escHtml || '<p></p>');
                            return true;
                        }

                        // Quill
                        const quillRoot = el.closest('.ql-container');
                        if (quillRoot && quillRoot.__quill) {
                            quillRoot.__quill.setText(String(value));
                            return true;
                        }

                        // TinyMCE (inline mode: the editable element's id is the editor id)
                        try {
                            if (window.tinymce && el.id && window.tinymce.get(el.id)) {
                                window.tinymce.get(el.id).setContent(escHtml || '');
                                return true;
                            }
                        } catch (e) { }

                        // CKEditor 4 (inline mode): match the instance whose editable is this element
                        try {
                            if (window.CKEDITOR && window.CKEDITOR.instances) {
                                for (const k in window.CKEDITOR.instances) {
                                    const inst = window.CKEDITOR.instances[k];
                                    const editable = inst && inst.editable && inst.editable();
                                    if (editable && editable.$ === el) {
                                        inst.setData(escHtml || '');
                                        return true;
                                    }
                                }
                            }
                        } catch (e) { }

                        // Generic contenteditable: type through the page's input pipeline
                        try {
                            el.focus();
                            const selObj = window.getSelection();
                            const range = document.createRange();
                            range.selectNodeContents(el);
                            selObj.removeAllRanges();
                            selObj.addRange(range);
                            const ok = document.execCommand('insertText', false, String(value));
                            if (!ok) {
                                el.textContent = String(value);
                                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
                            }
                            el.blur();
                            return true;
                        } catch (e) { return false; }
                    },
                    args: [request.selector, request.value]
                });
                sendResponse({ success: !!(results && results[0] && results[0].result) });
            } catch (e) {
                console.error('fillRichText error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Element Inspector: AI-generated robust relative XPath (premium candidate)
    // AI automation, pass 1: look at the element and choose a locator. The page
    // verifies it before any code is written (the content script runs the loop).
    if (request.action === 'aiAnalyseElement') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const out = await analyseElementWithAI(AI_CONFIG.apiKey, {
                    framework: request.framework,
                    description: request.description,
                    element: request.element,
                    url: request.url,
                    feedback: request.feedback,
                    lastChance: !!request.lastChance,
                });
                if (out.__refused || out.outOfScope) { sendResponse({ refused: true }); return; }
                sendResponse(out);
            } catch (err) {
                console.error('aiAnalyseElement error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // AI automation, pass 2: write the code around the locator that was verified.
    if (request.action === 'aiGenerateAutomation') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const result = await generateAutomationWithAI(AI_CONFIG.apiKey, {
                    framework: request.framework,
                    language: request.language,
                    pom: !!request.pom,
                    description: request.description,
                    element: request.element,
                    url: request.url,
                    verified: request.verified,
                });
                sendResponse(result);
            } catch (err) {
                console.error('aiGenerateAutomation error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    if (request.action === 'aiGenerateXPath') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) {
                    sendResponse({ error: 'no_api_key' });
                    return;
                }
                const result = await generateRelativeXPathWithAI(AI_CONFIG.apiKey, request.context, request.url, request.extensionXpath, request.feedback);
                sendResponse({
                    xpath: result.xpath,
                    cssSelector: result.cssSelector,
                    attributeSelector: result.attributeSelector,
                    recommended: result.recommended,
                    reason: result.reason
                });
            } catch (err) {
                console.error('aiGenerateXPath error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Inspector OCR: extract text from a picked image (uses the smart model)
    if (request.action === 'aiWriteBugReport') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const report = await writeBugReportWithAI(AI_CONFIG.apiKey, request);
                sendResponse({ report });
            } catch (err) {
                console.error('aiWriteBugReport error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    if (request.action === 'aiExtractImageText') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                // Prefer the base64 captured in the page; fall back to fetching the src
                let data = request.imageData, mediaType = request.mediaType;
                if (!data) { const img = await fetchImageAsBase64(request.src); data = img.data; mediaType = img.mediaType; }
                const text = await extractImageTextWithAI(AI_CONFIG.apiKey, data, mediaType);
                sendResponse({ text });
            } catch (err) {
                console.error('aiExtractImageText error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Console logs: receive a batch from a tab's page
    if (request.action === 'consoleBatch') {
        if (sender.tab) addConsoleBatch(sender.tab.id, request.batch || []);
        return false;
    }
    if (request.action === 'getConsoleLogs') {
        sendResponse({ logs: consoleLogs.get(request.tabId) || [] });
        return true;
    }
    if (request.action === 'clearConsoleLogs') {
        consoleLogs.delete(request.tabId);
        updateConsoleBadge(request.tabId);
        sendResponse({ success: true });
        return true;
    }
    // AI: explain console errors and suggest fixes
    if (request.action === 'aiExplainConsole') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const result = await explainConsoleWithAI(AI_CONFIG.apiKey, request.logs, request.url);
                sendResponse({ findings: result.findings });
            } catch (err) {
                console.error('aiExplainConsole error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Network: receive a batch of captured requests from a tab's page
    if (request.action === 'networkBatch') {
        if (sender.tab) addNetworkBatch(sender.tab.id, request.batch || []);
        return false;
    }
    if (request.action === 'getNetworkReqs') {
        sendResponse({ reqs: networkReqs.get(request.tabId) || [] });
        return true;
    }
    if (request.action === 'clearNetworkReqs') {
        networkReqs.delete(request.tabId);
        updateBadge(request.tabId);
        sendResponse({ success: true });
        return true;
    }
    // AI: explain failed network requests and suggest fixes
    if (request.action === 'aiExplainNetwork') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const result = await explainNetworkWithAI(AI_CONFIG.apiKey, request.reqs, request.url);
                sendResponse({ findings: result.findings });
            } catch (err) {
                console.error('aiExplainNetwork error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Open a URL in a fresh private/incognito window (works on Chromium browsers)
    if (request.action === 'openIncognito') {
        const url = request.url || (sender.tab && sender.tab.url);
        if (!url || !/^https?:/i.test(url)) { sendResponse({ success: false, error: 'Open a website first' }); return true; }
        chrome.windows.create({ url, incognito: true, state: 'maximized', focused: true }, (win) => {
            if (chrome.runtime.lastError || !win) {
                sendResponse({ success: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Private browsing is disabled' });
            } else {
                sendResponse({ success: true });
            }
        });
        return true;
    }

    // Auto Refresh: content script asks for its tab's interval on each load
    if (request.action === 'arGet') {
        const id = sender.tab && sender.tab.id;
        sendResponse({ seconds: (id != null && autoRefresh[id]) || 0 });
        return false;
    }
    if (request.action === 'arStatus') {
        sendResponse({ seconds: autoRefresh[request.tabId] || 0 });
        return false;
    }
    if (request.action === 'arList') {
        const ids = Object.keys(autoRefresh).map(Number);
        Promise.all(ids.map(id => new Promise(res => {
            chrome.tabs.get(id, (t) => {
                if (chrome.runtime.lastError || !t) { delete autoRefresh[id]; res(null); }
                else res({ tabId: id, seconds: autoRefresh[id], url: t.url, title: t.title });
            });
        }))).then(items => { arSaveState(); sendResponse({ items: items.filter(Boolean) }); });
        return true;
    }
    if (request.action === 'arSet') {
        autoRefresh[request.tabId] = request.seconds; arSaveState();
        chrome.tabs.sendMessage(request.tabId, { action: 'arStart', seconds: request.seconds }).catch(() => { });
        sendResponse({ success: true });
        return false;
    }
    if (request.action === 'arStop') {
        delete autoRefresh[request.tabId]; arSaveState();
        chrome.tabs.sendMessage(request.tabId, { action: 'arStop' }).catch(() => { });
        sendResponse({ success: true });
        return false;
    }
    if (request.action === 'arStopSelf') { // from the on-page badge
        const id = sender.tab && sender.tab.id;
        if (id != null) { delete autoRefresh[id]; arSaveState(); }
        sendResponse({ success: true });
        return false;
    }

    // Cookie viewer/editor (chrome.cookies gives httpOnly cookies too)
    if (request.action === 'getCookies') {
        chrome.cookies.getAll({ url: request.url }, (cookies) => sendResponse({ cookies: cookies || [] }));
        return true;
    }
    if (request.action === 'setCookie') {
        const c = request.cookie || {};
        const host = (c.domain || '').replace(/^\./, '');
        const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
        const details = { url, name: c.name, value: c.value != null ? c.value : '', path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
        if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite;
        if (!c.hostOnly && c.domain) details.domain = c.domain;
        if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
        chrome.cookies.set(details, (res) => sendResponse({ success: !!res, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
        return true;
    }
    if (request.action === 'removeCookie') {
        const c = request.cookie || {};
        const host = (c.domain || '').replace(/^\./, '');
        const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
        chrome.cookies.remove({ url, name: c.name }, () => sendResponse({ success: true }));
        return true;
    }

    // Clear browsing data (cache/cookies/storage/...) for this site or all sites
    if (request.action === 'clearBrowsingData') {
        (async () => {
            try {
                const dataTypes = request.dataTypes || [];
                const since = request.since || 0;
                const scope = request.scope || 'site';
                const origin = request.origin;
                const tabId = sender.tab ? sender.tab.id : request.tabId;
                const ORIGIN_SCOPED = ['cookies', 'localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers', 'fileSystems', 'webSQL'];
                const want = {}; dataTypes.forEach(t => { want[t] = true; });
                const skipped = [];

                if (scope === 'site' && origin) {
                    const scoped = {}, global = {};
                    dataTypes.forEach(t => { (ORIGIN_SCOPED.includes(t) ? scoped : global)[t] = true; });
                    // Origin-scoped types -> only this site
                    if (Object.keys(scoped).length) await chrome.browsingData.remove({ since, origins: [origin] }, scoped);
                    // Global types (cache, history…) can't be scoped -> cleared for all sites
                    if (Object.keys(global).length) { await chrome.browsingData.remove({ since }, global); Object.keys(global).forEach(t => skipped.push(t)); }
                } else {
                    await chrome.browsingData.remove({ since }, want);
                }

                if (request.autoReload && tabId != null) {
                    try { chrome.tabs.reload(tabId, { bypassCache: true }); } catch (e) { }
                }
                sendResponse({ success: true, skipped });
            } catch (err) {
                console.error('clearBrowsingData error:', err);
                sendResponse({ success: false, error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Responsive Viewer: toggle the session rule that lets the page be framed
    // (strip X-Frame-Options / CSP frame-ancestors). The UA switch was removed: a DNR rule
    // can't tell one device frame from another in the same tab, and sites that size by
    // CSS width (most of them) never read the UA anyway.
    if (request.action === 'responsiveDnr') {
        const RV_DNR_ID = 4801;
        if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) { sendResponse({ success: false }); return true; }
        if (!request.enable) {
            chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RV_DNR_ID] }).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
            return true;
        }
        const action = {
            type: 'modifyHeaders',
            responseHeaders: [
                { header: 'x-frame-options', operation: 'remove' },
                { header: 'frame-options', operation: 'remove' },
                { header: 'content-security-policy', operation: 'remove' },
                { header: 'content-security-policy-report-only', operation: 'remove' }
            ]
        };
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [RV_DNR_ID],
            addRules: [{ id: RV_DNR_ID, priority: 1, action, condition: { resourceTypes: ['sub_frame'] } }]
        }).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
        return true;
    }

    // Fetch text (used by the Responsive Viewer to read a page's CROSS-ORIGIN
    // stylesheets - a content script can't, but the worker can with <all_urls>
    // host permission - so breakpoint detection sees CDN-hosted CSS too).
    if (request.action === 'fetchText') {
        fetch(request.url, { credentials: 'omit' })
            .then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then((text) => sendResponse({ ok: true, text: text.slice(0, 2_000_000) })) // cap huge sheets
            .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
    }

    // Capture the visible tab (used by the Responsive Viewer screenshots)
    if (request.action === 'captureTab') {
        chrome.tabs.captureVisibleTab({ format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) sendResponse({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Capture failed' });
            else sendResponse({ dataUrl });
        });
        return true;
    }

    // API Data Export: replay one request from the background (host permissions
    // let it read cross-origin responses that the page's own fetch could too,
    // but without a CORS wall). Used by the paginated CSV exporter.
    if (request.action === 'apiFetch') {
        (async () => {
            // The endpoint is usually cross-origin to the page the tool runs on (the app calls
            // its API on another host/port). A raw background fetch then fails with "Failed to
            // fetch" (HTTP 0) because it has neither accepted the API's self-signed certificate
            // nor an Origin the API's CORS allows.
            //
            // The fix: run the fetch INSIDE a real tab. The app's OWN tab is tried first - it
            // demonstrably reaches this API in normal use, so its accepted certificate, its
            // session cookies and the API's CORS grant for the app origin all apply. Then any
            // tab already on the target origin (same-origin there = no CORS at all). The bare
            // background fetch is the last resort, for public CORS-enabled APIs.
            let targetOrigin = '';
            try { targetOrigin = new URL(request.url).origin; } catch (e) { }

            // A request with an Authorization token authenticates by THAT token and needs no
            // cookies. Sending the session cookie too makes ABP switch to cookie-auth and
            // demand an anti-forgery token for the POST, which we don't have -> 400. A real
            // cross-site browser call drops the cookie via SameSite anyway, so omitting it
            // just matches the browser. Cookie-only sites (no Authorization) keep 'include'.
            const hasAuth = Object.keys(request.headers || {}).some((k) => k.toLowerCase() === 'authorization');
            const creds = hasAuth ? 'omit' : 'include';

            const runInTab = async (tabId) => {
                try {
                    const [out] = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: 'MAIN',
                        func: async (url, method, headers, body, credentials) => {
                            try {
                                const o = { method: method || 'GET', headers: headers || {}, credentials, redirect: 'follow' };
                                if (body != null && !/^(GET|HEAD)$/i.test(o.method)) o.body = body;
                                const r = await fetch(url, o);
                                return { ok: r.ok, status: r.status, text: await r.text() };
                            } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; }
                        },
                        args: [request.url, request.method || 'GET', request.headers || {}, request.body != null ? request.body : null, creds],
                    });
                    return out && out.result;
                } catch (e) { return null; }
            };

            // Build the candidate tab list: the tool's own tab first, then any tab on the API's
            // origin. De-duplicated, http(s) only.
            const candidates = [];
            const pushTab = (t) => {
                if (t && t.id != null && !candidates.includes(t.id) && /^https?:/i.test(t.url || '')) candidates.push(t.id);
            };
            if (sender && sender.tab) pushTab(sender.tab);
            try {
                const tabs = await chrome.tabs.query({});
                if (targetOrigin) tabs.forEach((t) => { try { if (new URL(t.url).origin === targetOrigin) pushTab(t); } catch (e) { } });
            } catch (e) { }

            for (const tabId of candidates) {
                const res = await runInTab(tabId);
                if (res && res.status !== 0) { sendResponse(res); return; }   // actually reached the server
            }

            // Last resort: a plain background fetch.
            try {
                const opts = { method: request.method || 'GET', headers: request.headers || {}, credentials: creds, redirect: 'follow' };
                if (request.body != null && !/^(GET|HEAD)$/i.test(opts.method)) opts.body = request.body;
                const resp = await fetch(request.url, opts);
                const text = await resp.text();
                sendResponse({ ok: resp.ok, status: resp.status, text });
            } catch (e) {
                sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) });
            }
        })();
        return true;
    }

    // Time Machine: install / update / remove the fake Date override in the page
    if (request.action === 'timeMachineApply') {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return true; }
        const cfg = { mode: request.mode === 'freeze' ? 'freeze' : 'advance', targetMs: request.targetMs, anchorMs: Date.now() };
        chrome.storage.local.get(['qaTM'], (r) => {
            const m = r.qaTM || {}; m[tabId] = cfg; chrome.storage.local.set({ qaTM: m });
        });
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: qaTMInstall, args: [cfg] })
            .then(() => sendResponse({ ok: true, cfg }))
            .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
    }
    if (request.action === 'timeMachineReset') {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null) { sendResponse({ ok: false }); return true; }
        chrome.storage.local.get(['qaTM'], (r) => { const m = r.qaTM || {}; delete m[tabId]; chrome.storage.local.set({ qaTM: m }); });
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: qaTMUninstall })
            .then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
        return true;
    }
    if (request.action === 'timeMachineStatus') {
        const tabId = sender.tab && sender.tab.id;
        chrome.storage.local.get(['qaTM'], (r) => sendResponse({ cfg: (r.qaTM || {})[tabId] || null }));
        return true;
    }

    // Link Health: check a list of links for broken/dead URLs
    if (request.action === 'checkLinks') {
        (async () => {
            try {
                const results = await checkLinks(request.links || []);
                sendResponse({ results });
            } catch (err) {
                console.error('checkLinks error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }
    // AI: explain performance metrics and suggest optimizations
    if (request.action === 'aiExplainPerformance') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) { sendResponse({ error: 'no_api_key' }); return; }
                const result = await explainPerformanceWithAI(AI_CONFIG.apiKey, request.metrics, request.url);
                sendResponse({ findings: result.findings });
            } catch (err) {
                console.error('aiExplainPerformance error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }



    // Right-click fill: generate one valid/invalid value for a single field
    if (request.action === 'aiGenerateFieldValue') {
        (async () => {
            try {
                if (!AI_CONFIG || !AI_CONFIG.apiKey) {
                    sendResponse({ error: 'no_api_key' });
                    return;
                }
                const result = await generateFieldValueWithAI(AI_CONFIG.apiKey, request.field, request.mode, request.url);
                sendResponse({ value: result.value });
            } catch (err) {
                console.error('aiGenerateFieldValue error:', err);
                sendResponse({ error: String(err.message || err) });
            }
        })();
        return true;
    }

    // Persist the user's AI saving preference ('ask' | 'always' | 'never')
    if (request.action === 'setAiSaveBehavior') {
        (async () => {
            await chrome.storage.local.set({ aiSaveBehavior: request.behavior });
            sendResponse({ success: true });
        })();
        return true;
    }

    return true;
});

// Convert AI-generated values into profile field objects (same shape as recorded
// profiles), normalizing select values so el.value assignment works.
function mapAiValuesToFields(ai, scannedFields) {
    const fields = [];
    for (const item of (ai.values || [])) {
        const scanned = scannedFields.find(f => f.index === item.index);
        if (!scanned || item.value === undefined || item.value === null || item.value === '') continue;

        let value = String(item.value);

        // Guard against the AI misassigning a checkbox value ('true'/'false') to a
        // text field - that would dump "true" into a notes/textarea field.
        const isCheckboxField = scanned.type === 'checkbox';
        if (!isCheckboxField && /^(true|false)$/i.test(value.trim())) continue;

        // Selects & radio groups: the AI sometimes returns the option's visible
        // text instead of its value attribute. Normalize to the real option value.
        if ((scanned.tag === 'select' || scanned.type === 'radio') && Array.isArray(scanned.options) && scanned.options.length > 0) {
            const wanted = value.trim().toLowerCase();
            const match =
                scanned.options.find(o => String(o.value).trim().toLowerCase() === wanted) ||
                scanned.options.find(o => String(o.text).trim().toLowerCase() === wanted) ||
                scanned.options.find(o => wanted.length > 1 && String(o.text).trim().toLowerCase().includes(wanted));
            if (match) {
                value = String(match.value);
            } else {
                // No matching option at all - pick the first real option instead of leaving it unselected
                value = String(scanned.options[0].value);
            }
        }

        // A dropdown whose options never loaded cannot be filled by anyone - drop it
        // rather than send the fill off to open it again for nothing.
        if (scanned.type === 'combobox' && scanned.noOptions) continue;

        // Choice fields keep the AI's chosen value (NOT sequential): the AI picks
        // each option deliberately and writes dependent text fields (notes, etc.)
        // to match it, so the actual selected value must stay what the AI decided.
        // Variety still happens - each new AI Fill regenerates fresh, coherent values.
        fields.push({
            selector: scanned.selector,
            value: value,
            actionType: 'fill',
            type: scanned.type || 'text',
            uniqueText: false,
            uniqueNumber: false,
            sequentialSelect: false,
            isSmartDate: false,
            dateDirection: 'future',
            dateFormat: 'DD/MM/YYYY',
            dateSeparator: '/',
            digits: 5
        });
    }
    return fields;
}

// Violation angles for invalid-data generation. One is picked at random per
// call and forced on the model - otherwise it converges on the same 2-3
// favorite violations (e.g. always "email without @").
const INVALID_STRATEGIES = [
    'missing a required symbol or structural part (e.g. email without @, URL without scheme)',
    'duplicated symbols or parts (e.g. double @@, double dots, repeated country code)',
    'illegal special characters injected into the value (e.g. #$%^ inside an email or name)',
    'whitespace abuse: leading/trailing spaces or spaces in the middle of a no-space value',
    'wrong data type: letters where digits are expected, or digits where letters are expected',
    'absurdly long value - exceed maxLength or reasonable length by a lot',
    'too short / minimal: a single character or just the symbol alone (e.g. "@" only)',
    'valid-looking but subtly broken: missing TLD, domain without dot, phone one digit short',
    'unicode tricks: emoji, RTL marks, or non-Latin lookalike characters inside the value',
    'boundary violation: out-of-range number, impossible date (e.g. Feb 30), age 999',
    'SQL/HTML injection style string (e.g. \' OR 1=1 --, <script>alert(1)</script>)',
    'control characters or formatting: tabs, newlines, null-like sequences in a single-line field'
];

// Fetch an image (the background has host permissions so cross-origin works)
// and return it base64-encoded with a Claude-supported media type.
async function fetchImageAsBase64(src) {
    // data: URLs are already encoded
    const dataMatch = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(src || '');
    if (dataMatch) return { mediaType: dataMatch[1], data: dataMatch[2] };

    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not load the image (${res.status})`);
    const blob = await res.blob();
    let mediaType = (blob.type || '').toLowerCase();
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(mediaType)) {
        if (/\.jpe?g(\?|$)/i.test(src)) mediaType = 'image/jpeg';
        else if (/\.png(\?|$)/i.test(src)) mediaType = 'image/png';
        else if (/\.gif(\?|$)/i.test(src)) mediaType = 'image/gif';
        else if (/\.webp(\?|$)/i.test(src)) mediaType = 'image/webp';
        else throw new Error('Unsupported image format (use JPG, PNG, GIF or WebP)');
    }
    const buf = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { mediaType, data: btoa(binary) };
}

// Read all text from an image (OCR) via Claude vision - uses the smart model.
// Writes a QA bug report from three sources at once: what the tester typed,
// what the screenshot shows, and what the page actually logged. The schema is
// what fills the form, so every field the form needs is required here.
async function writeBugReportWithAI(apiKey, req) {
    // Only what belongs in the ticket body. Module, environment and impact are
    // either tracked as fields or simply noise once the URL and browser are
    // already attached; severity drives a dropdown, not prose.
    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'One line, English, imperative and specific. No "Bug:" prefix.' },
            description: { type: 'string', description: 'Two or three sentences on what is wrong. English.' },
            stepsToReproduce: { type: 'array', items: { type: 'string' }, description: 'Numbered steps, each a single action. Infer them from the screenshot, URL and the reporter note.' },
            expectedResult: { type: 'string' },
            actualResult: { type: 'string', description: 'What happens instead, as seen on the screen.' },
            severity: { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'Fills the severity dropdown; it is never written into the description.' }
        },
        required: ['title', 'description', 'stepsToReproduce', 'expectedResult', 'actualResult', 'severity'],
        additionalProperties: false
    };

    const ctx = req.ctx || {};

    const prompt = [
        'You are a senior QA engineer writing a bug report that a developer can act on without asking questions.',
        '',
        'You are given the tester\'s note and a screenshot of the page. Write the report from those two things.',
        'Do NOT invent error messages, endpoints, stack traces or steps that the note and the screenshot do not support.',
        'Do NOT diagnose the cause, and do NOT discuss console output or network calls: the failing error is attached to the ticket separately, verbatim.',
        'Describe only what is on the screen and what the tester reported.',
        'Write in English regardless of the language of the note or the screenshot.',
        'Do NOT restate the module, the environment, the browser, the URL or the impact anywhere in your text: those are attached to the ticket already, and repeating them is noise.',
        'Do NOT write a "Severity:" line - the severity you return fills a dropdown.',
        '',
        `Tester's note: ${req.note || '(none - rely on the screenshot)'}`,
        `Page URL (for inferring the steps only, never to be written out): ${ctx.url || 'unknown'}`
    ].join('\n');

    const content = [{ type: 'text', text: prompt }];
    if (req.imageData) {
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: req.mediaType || 'image/png', data: req.imageData }
        });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 2048,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try { const e = await response.json(); if (e && e.error && e.error.message) message = e.error.message; } catch (e) { }
        throw new Error(message);
    }
    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block || !block.text) throw new Error('Empty AI response');
    return JSON.parse(block.text);
}

async function extractImageTextWithAI(apiKey, base64, mediaType) {
    const prompt = [
        'Extract ALL text visible in this image, exactly as written (verbatim), preserving the original language and line breaks.',
        'Return ONLY the extracted text - no commentary, no quotes, no explanations.',
        'If the image contains no readable text, return exactly: (no text found)'
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 2048,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                    { type: 'text', text: prompt }
                ]
            }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try { const e = await response.json(); if (e && e.error && e.error.message) message = e.error.message; } catch (e) { }
        throw new Error(message);
    }
    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return (textBlock && textBlock.text ? textBlock.text : '').trim();
}

// Explain console errors/warnings and suggest fixes (smart model, structured).
async function explainConsoleWithAI(apiKey, logs, url) {
    // Only send errors/warnings, deduped, capped - keeps the prompt small/fast
    const items = (logs || [])
        .filter(l => l.level === 'error' || l.level === 'warn')
        .slice(-40)
        .map(l => ({ level: l.level, message: String(l.message || '').slice(0, 500), source: l.source || '', count: l.count || 1 }));

    if (items.length === 0) return { findings: [] };

    const schema = {
        type: 'object',
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'short title of the problem' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                        cause: { type: 'string', description: 'likely root cause in plain language' },
                        fix: { type: 'string', description: 'concrete suggested fix' },
                        relatedMessage: { type: 'string', description: 'the console message this finding is about' }
                    },
                    required: ['title', 'severity', 'cause', 'fix', 'relatedMessage'],
                    additionalProperties: false
                }
            }
        },
        required: ['findings'],
        additionalProperties: false
    };

    const prompt = [
        'You are a senior web debugging assistant. Below are console errors/warnings captured from a web page.',
        'GROUP related messages and explain them: for each distinct problem give a title, severity, the likely root cause, and a concrete fix.',
        'Be practical and specific (mention the API/resource/selector involved when visible). Do not invent errors that are not in the list.',
        'Write in English.',
        '',
        `Page URL: ${url || ''}`,
        `Console messages (newest last): ${JSON.stringify(items)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 4096,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try { const e = await response.json(); if (e && e.error && e.error.message) message = e.error.message; } catch (e) { }
        throw new Error(message);
    }
    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block || !block.text) throw new Error('Empty AI response');
    return JSON.parse(block.text);
}

// Explain failed network requests (4xx/5xx/network errors) and suggest fixes.
async function explainNetworkWithAI(apiKey, reqs, url) {
    // Only send failed requests, capped, with trimmed bodies - keeps it small/fast
    const items = (reqs || [])
        .filter(r => r.status === 0 || r.status >= 400)
        .slice(-25)
        .map(r => ({
            method: r.method, url: String(r.url || '').slice(0, 300),
            status: r.status, statusText: r.statusText || '', error: r.error || '',
            kind: r.kind, contentType: r.contentType || '',
            reqBody: r.reqBody ? String(r.reqBody).slice(0, 400) : '',
            resBody: r.resBody ? String(r.resBody).slice(0, 600) : ''
        }));

    if (items.length === 0) return { findings: [] };

    const schema = {
        type: 'object',
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'short title of the problem' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                        cause: { type: 'string', description: 'likely root cause in plain language' },
                        fix: { type: 'string', description: 'concrete suggested fix' },
                        relatedMessage: { type: 'string', description: 'the request this finding is about (method + url + status)' }
                    },
                    required: ['title', 'severity', 'cause', 'fix', 'relatedMessage'],
                    additionalProperties: false
                }
            }
        },
        required: ['findings'],
        additionalProperties: false
    };

    const prompt = [
        'You are a senior web/API debugging assistant. Below are FAILED network requests (HTTP 4xx/5xx or network errors) captured from a web page.',
        'GROUP related failures and explain them: for each distinct problem give a title, severity, the likely root cause, and a concrete fix.',
        'Use the status code, the response body and headers to be specific (e.g. 401 -> auth/token, 403 -> permissions, 404 -> wrong endpoint, 422 -> validation, 5xx -> server, status 0 -> CORS/DNS/offline).',
        'Be practical and specific. Do not invent requests that are not in the list. Write in English.',
        '',
        `Page URL: ${url || ''}`,
        `Failed requests (newest last): ${JSON.stringify(items)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 4096,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try { const e = await response.json(); if (e && e.error && e.error.message) message = e.error.message; } catch (e) { }
        throw new Error(message);
    }
    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block || !block.text) throw new Error('Empty AI response');
    return JSON.parse(block.text);
}

// ===== Link Health: check links for broken/dead URLs (concurrent, capped) =====
// Transient statuses: worth ONE retry before judging (rate limits, hiccups,
// overloaded servers) - professional checkers never fail these on first sight.
const LINK_TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524]);

// One attempt. GET (not HEAD - many servers lie to HEAD) and the body download
// is aborted as soon as the response headers arrive, so it costs almost the
// same as HEAD but behaves exactly like a real browser visit.
async function linkAttempt(href, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(href, { method: 'GET', redirect: 'follow', signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
        const out = { status: resp.status, ok: resp.ok, redirected: resp.redirected, finalUrl: resp.url };
        clearTimeout(timer);
        try { ctrl.abort(); } catch (e) { }   // cancel the body download
        return out;
    } catch (e) {
        clearTimeout(timer);
        return { status: 0, ok: false, error: e.name === 'AbortError' ? 'Timeout' : (e.message || 'Network error') };
    }
}

async function checkOneLink(href) {
    let r = await linkAttempt(href, 12000);
    // transient failure -> wait a moment and retry once before judging
    if (r.status === 0 || LINK_TRANSIENT.has(r.status)) {
        await new Promise(res => setTimeout(res, 1500));
        const r2 = await linkAttempt(href, 15000);
        // a clean result on retry clears the false alarm; a different failure
        // (e.g. timeout -> real status) is also more informative
        if (r2.status !== 0 && !LINK_TRANSIENT.has(r2.status)) r = r2;
        else if (r.status === 0 && r2.status !== 0) r = r2;
        r.retried = true;
    }
    return r;
}

// Per-host scheduling: requests to the SAME host run one-at-a-time with a
// small delay (parallel bursts trip rate-limits/WAFs -> false "broken"),
// while different hosts are checked in parallel (8 workers).
async function checkLinks(links) {
    const results = new Array(links.length);
    const byHost = new Map();
    links.forEach((l, i) => {
        let host = '';
        try { host = new URL(l.href).host; } catch (e) { }
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(i);
    });
    const hostQueues = [...byHost.values()];
    let qi = 0;
    async function worker() {
        while (qi < hostQueues.length) {
            const queue = hostQueues[qi++];
            for (let k = 0; k < queue.length; k++) {
                const i = queue[k];
                const r = await checkOneLink(links[i].href);
                results[i] = { ...links[i], ...r };
                if (k < queue.length - 1) await new Promise(res => setTimeout(res, 150 + Math.random() * 200));
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(8, hostQueues.length) }, worker));
    return results;
}

// AI: analyse page performance metrics and suggest concrete optimizations.
async function explainPerformanceWithAI(apiKey, metrics, url) {
    const schema = {
        type: 'object',
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'short title of the performance issue' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                        cause: { type: 'string', description: 'what is slow and why, in plain language' },
                        fix: { type: 'string', description: 'concrete optimization (e.g. compress images, defer JS, enable caching/CDN)' }
                    },
                    required: ['title', 'severity', 'cause', 'fix'],
                    additionalProperties: false
                }
            }
        },
        required: ['findings'],
        additionalProperties: false
    };

    const prompt = [
        'You are a senior web performance engineer. Below are real performance metrics captured from a web page (times in ms, sizes in bytes).',
        'Identify the biggest performance problems and explain each: a title, severity, what is slow and the likely cause, and a concrete fix.',
        'Use the Core Web Vitals thresholds: LCP good<2500 poor>4000; FCP good<1800 poor>3000; TTFB good<800 poor>1800. Consider large/slow resources, heavy resource types, big total transfer, slow TTFB (server), and long DOM build.',
        'Base everything on the data only. Do not invent metrics. If performance is already good, return few/no findings. Write in English.',
        '',
        `Page URL: ${url || ''}`,
        `Metrics: ${JSON.stringify(metrics)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 4096,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try { const e = await response.json(); if (e && e.error && e.error.message) message = e.error.message; } catch (e) { }
        throw new Error(message);
    }
    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const block = (data.content || []).find(b => b.type === 'text');
    if (!block || !block.text) throw new Error('Empty AI response');
    return JSON.parse(block.text);
}


// Generate a short, robust RELATIVE XPath for one element (Element Inspector).
// The model gets the element + its ancestor chain and must anchor on stable
// attributes instead of brittle absolute paths or positional indexes.
async function generateRelativeXPathWithAI(apiKey, context, url, extensionXpath, feedback) {
    const schema = {
        type: 'object',
        properties: {
            xpath: { type: 'string', description: 'A robust relative XPath expression starting with // (always required)' },
            cssSelector: { type: 'string', description: 'A robust CSS selector for the element, or an EMPTY string if none can be built without brittle parts' },
            attributeSelector: { type: 'string', description: 'A CSS attribute selector using the element\'s single most stable attribute, e.g. input[name="email"] or [data-testid="login"]. EMPTY string if the element has no stable attribute' },
            recommended: { type: 'string', enum: ['xpath', 'cssSelector', 'attributeSelector'], description: 'Which of the returned locators is the most reliable for test automation' },
            reason: { type: 'string', description: 'ONE short sentence explaining why the recommended locator is the best choice here' }
        },
        required: ['xpath', 'cssSelector', 'attributeSelector', 'recommended', 'reason'],
        additionalProperties: false
    };

    const prompt = [
        'You are an expert in writing robust locators for UI test automation (Selenium/Playwright).',
        'For the TARGET element described below, generate up to THREE locators: a relative XPath (always), a CSS selector, and an attribute selector - then recommend the most reliable one.',
        '',
        ...(extensionXpath ? [
            `A locally-generated XPath already exists for this element: ${extensionXpath}`,
            'Your XPath MUST be a DIFFERENT expression using a DIFFERENT anchoring strategy (different attribute, or anchor on a nearby label/text/ancestor instead). It serves as the backup locator when the first one breaks, so never return the same or a trivially-equivalent expression.',
            ''
        ] : []),
        ...(feedback ? [
            `FEEDBACK FROM LIVE-PAGE VERIFICATION: ${feedback}`,
            ''
        ] : []),
        'Rules:',
        '- xpath: must start with // and be RELATIVE (never an absolute /html/body/... path). Anchoring on a nearby label/text or stable ancestor is encouraged, e.g. //label[normalize-space()="Email"]/following::input[1]. Avoid positional indexes like [3] unless there is truly nothing else.',
        '- cssSelector / attributeSelector: ONLY return them when they can be built from STABLE parts. If the element has no stable attribute or class, return an EMPTY string for that locator instead of inventing a brittle one - do not force it.',
        '- Prefer the most stable anchors everywhere: data-testid/data-* attributes, name, aria-label, placeholder, a human-readable static id, visible text.',
        '- SKIP ids/classes that look auto-generated (random hashes, GUIDs, framework suffixes like ng-*, css-1a2b3c, :r1:, b1-b2-...) - they change between builds.',
        '- Each returned locator must plausibly match ONLY this element on the page (sameTagCount tells you how many elements share its tag).',
        '- recommended: pick the most stable of the locators you actually returned; reason: one short sentence.',
        '',
        `Page URL: ${url || ''}`,
        `Target element: ${JSON.stringify(context)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            // Sonnet: locator accuracy matters more than cost here
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 4096,   // room for adaptive thinking + the JSON (512 left no text block)
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error && err.error.message) message = err.error.message;
        } catch (e) { }
        throw new Error(message);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error(data.stop_reason === 'max_tokens'
        ? 'The AI ran out of room before answering - try again'
        : 'Empty AI response');
    return JSON.parse(textBlock.text);
}

// Write automation code for a picked element. The system prompt is deliberately
// narrow (see automation.js): this writes tests for the element in front of it and
// refuses everything else, rather than becoming a chat window that happens to live
// in a QA tool.
async function callClaudeJson(apiKey, { system, prompt, schema, maxTokens }) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            // Sonnet: this is code someone will commit. Cheapness is not the point.
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: maxTokens || 2048,
            system,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error && err.error.message) message = err.error.message;
        } catch (e) { }
        throw new Error(message);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') return { __refused: true };

    // The answer ran out of room. Say so - a truncated JSON body would otherwise
    // blow up in JSON.parse as "Unterminated string", which tells the user nothing
    // about what actually went wrong or what to do about it.
    if (data.stop_reason === 'max_tokens') {
        throw new Error('The answer was cut short (too long). Try a shorter description, or turn Page Object off.');
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error(data.stop_reason === 'max_tokens'
        ? 'The AI ran out of room before answering - try again'
        : 'Empty AI response');

    try {
        return JSON.parse(textBlock.text);
    } catch (e) {
        console.error('Could not parse the AI response:', textBlock.text);
        throw new Error('The AI returned a malformed answer. Try again.');
    }
}

// PASS 1 - look at the element and choose a locator. No code is written yet: the
// locator comes back as a plain CSS/XPath too, so the PAGE can run it and tell us
// whether it really matches this element and nothing else. If it does not, the
// failure goes back to the model as feedback and it picks a different anchor.
async function analyseElementWithAI(apiKey, req) {
    const A = self.AutomationGen;
    return callClaudeJson(apiKey, {
        system: A.systemPrompt(),
        prompt: A.analysePrompt(req),
        schema: A.analyseSchema,
        // A long XPath anchored on a label, plus its reason, in a JSON envelope -
        // 700 left no room and the answer came back cut in half.
        maxTokens: 1500,
    });
}

// PASS 2 - write the code around a locator that has already been proven on the
// page, with the class names fixed so the file and the class cannot disagree.
async function generateAutomationWithAI(apiKey, req) {
    const A = self.AutomationGen;
    const out = await callClaudeJson(apiKey, {
        system: A.systemPrompt(),
        prompt: A.userPrompt(req),
        schema: A.schema,
        // Page Object means TWO files. A Java page object and its test, with imports
        // and waits, and every newline escaped inside a JSON string, runs well past
        // 2048 - and the answer came back truncated, which JSON.parse then reported
        // as "Unterminated string" rather than as the size problem it was.
        maxTokens: 8000,
    });

    if (out.__refused) return { refused: true };
    if (String(out.code || '').trim() === A.REFUSAL) return { refused: true };

    const name = (req.verified && req.verified.className) || 'Element';
    const pageObject = out.pageObject || '';
    return {
        refused: false,
        code: out.code,
        pageObject,
        notes: out.notes || '',
        locator: (req.verified && req.verified.locator) || '',
        reason: (req.verified && req.verified.reason) || '',
        className: name,
        // Named FROM the code, not from a name the model was asked to honour and
        // then quietly changed - a Java file whose class does not match it will not
        // compile, and that is not something to leave to good behaviour.
        testFile: A.fileNameFromCode(req.language, out.code, name, 'test'),
        pageFile: A.fileNameFromCode(req.language, pageObject, name, 'page'),
    };
}

// Generate a single value for one field (right-click fill). mode: 'valid' makes
// realistic correct data; 'invalid' makes data that should FAIL the field's
// validation - for negative testing.
async function generateFieldValueWithAI(apiKey, field, mode, url) {
    const schema = {
        type: 'object',
        properties: {
            value: { type: 'string', description: 'The generated value for the field' }
        },
        required: ['value'],
        additionalProperties: false
    };

    const strategy = INVALID_STRATEGIES[Math.floor(Math.random() * INVALID_STRATEGIES.length)];

    const prompt = [
        'You are generating ONE test value for a single form field in a QA testing browser extension.',
        '',
        mode === 'valid'
            ? 'MODE: VALID - generate a realistic, correctly-formatted value that PASSES validation for this field (analyze its name, type, label, placeholder, pattern, maxLength to understand what it expects). Data must look real but be entirely fictional. Vary your output: do not reuse common placeholder names.'
            : [
                'MODE: INVALID - generate a value that should FAIL this field\'s validation, for negative testing.',
                `Apply EXACTLY this violation strategy: ${strategy}.`,
                'Adapt the strategy to this specific field type. Only if it genuinely cannot apply to this field, pick the closest alternative violation. The value must still be typeable text.'
            ].join('\n'),
        '',
        '- Match the language and locale of the page (Arabic page -> Arabic text where appropriate).',
        '- Return ONLY the value itself, no explanations.',
        '',
        `Page URL: ${url || ''}`,
        `Field: ${JSON.stringify(field)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 4096,   // room for adaptive thinking + the JSON
            temperature: 1, // variety across repeated clicks on the same field
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error && err.error.message) message = err.error.message;
        } catch (e) { }
        throw new Error(message);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) throw new Error(data.stop_reason === 'max_tokens'
        ? 'The AI ran out of room before answering - try again'
        : 'Empty AI response');
    return JSON.parse(textBlock.text);
}

// Call the Claude API to generate test data for the scanned form fields.
// Uses structured outputs (json_schema) so the response is always valid JSON.
// For each choice field (select/radio/combobox) with options, pick the NEXT
// option by rotating a per-field index stored in chrome.storage.local - so every
// AI fill lands on a different option (your idea: remember + change each time).
async function pickRotatingChoices(fields) {
    const KEY = 'ai_choice_rotation';
    const store = await chrome.storage.local.get([KEY]);
    const rot = store[KEY] || {};
    const out = [];

    const isPlaceholder = (t) => {
        t = (t || '').toLowerCase();
        return !t || t.includes('select') || t.includes('choose') || t.includes('اختر') || t.includes('حدد') || t.includes('---');
    };

    for (const f of (fields || [])) {
        const isChoice = f.tag === 'select' || f.type === 'radio' || f.type === 'combobox';
        if (!isChoice || !Array.isArray(f.options) || f.options.length === 0) continue;

        // Real options only (drop the "اختر..." placeholder)
        const pool = f.options.filter(o => !isPlaceholder(o.text));
        const list = pool.length ? pool : f.options;
        if (list.length === 0) continue;

        const key = f.selector || f.label || String(f.index);
        const next = (rot[key] === undefined ? Math.floor(Math.random() * list.length) : (rot[key] + 1) % list.length);
        rot[key] = next;
        const choice = list[next];

        out.push({
            index: f.index,
            label: f.label,
            // select/radio match by value; combobox matches by visible text
            display: f.type === 'combobox' ? choice.text : choice.value
        });
    }

    await chrome.storage.local.set({ [KEY]: rot });
    return out;
}

async function generateProfileWithAI(apiKey, scan, categories, isFollowUp = false) {
    const schema = {
        type: 'object',
        properties: {
            isRealForm: {
                type: 'boolean',
                description: 'true only if the fields form a REAL data-entry form; false if they are just page controls (search box, table pagination, page-size select, list filters)'
            },
            profileName: {
                type: 'string',
                description: 'Short descriptive profile name based on the site and form purpose'
            },
            category: { type: 'string', enum: categories },
            values: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'integer', description: 'The index of the form field this value belongs to' },
                        value: { type: 'string', description: 'The generated test value for this field' }
                    },
                    required: ['index', 'value'],
                    additionalProperties: false
                }
            }
        },
        required: ['isRealForm', 'profileName', 'category', 'values'],
        additionalProperties: false
    };

    // Pre-pick choice-field options OURSELVES by rotating through them (stored per
    // field selector), so every fill lands on a DIFFERENT option even when the AI
    // would otherwise keep choosing the same "obvious" one. The AI is then told to
    // use these exact picks and write dependent text fields to match them.
    const predetermined = await pickRotatingChoices(scan.fields);

    const prompt = [
        'You are generating realistic fake test data for a form-filling browser extension.',
        'Analyze the page context and the form fields below, then generate an appropriate test value for every field.',
        ...(isFollowUp ? [
            '',
            'NOTE: These fields appeared dynamically AFTER earlier fields on the same form were filled (conditional fields). Generate values consistent with a single coherent test submission.'
        ] : []),
        '',
        'Rules:',
        '- FIRST, decide whether the fields form a REAL data-entry form (registration, login, application, contact, content creation, etc.). Standalone page controls - search boxes, table pagination, page-size selects ("show N entries"), list filters - are NOT a form. If there is no real form, set isRealForm to false and return an empty values array.',
        '- Even when a real form exists, SKIP page-control fields (search/filter/pagination/page-size) - generate values only for the form itself.',
        '- Match the language and locale of the page (e.g. Arabic page -> Arabic names, matching phone formats).',
        '- Data must look realistic but be entirely fictional (fake emails, phone numbers, names).',
        '- COHERENCE: all values together must form ONE consistent, realistic submission. When a free-text field (textarea / notes / message / richtext) clearly depends on another field, write its text to MATCH that field. For example, if a "request type" / "category" select is set to "proposal", the notes must read as a proposal (not a question); if it is set to "complaint", the notes must read as a complaint. Read each field\'s label and the choices made elsewhere on the form, and make dependent text fields consistent with them.',
        ...(predetermined.length ? [
            '- PREDETERMINED CHOICES: for the field indices listed below you MUST return EXACTLY the given option value (do not pick a different option). These choices are FIXED INPUTS - build every other dependent field around them, never the other way round:',
            ...predetermined.map(p => `    - field index ${p.index} (${p.label || 'choice'}): "${p.display}"`),
            '  Specifically: if one of these is a phone COUNTRY CODE / dialing prefix (e.g. +966, +673), the phone number field MUST be generated to match THAT country\'s real format and length. And any notes/message/subject text must be consistent with the chosen request type/category.'
        ] : []),
        '- For select fields, the value MUST be exactly one of the provided option "value" strings (never the display text, never a placeholder option like "Select...").',
        '- For checkbox fields, return "true" to check the box or "false" to leave it unchecked. Terms, conditions, consent, and agreement checkboxes must be "true".',
        '- For radio fields, the value MUST be exactly one of the provided option "value" strings (vary the choice across fills, not always the same one).',
        '- For combobox fields (custom dropdowns), return the visible TEXT of the option to choose. If options are provided pick one (varying your choice across fills); if not, return a short plausible choice based on the field label and the extension will pick the closest match.',
        '- For richtext fields (rich text editors), write 2-4 sentences of realistic PLAIN text (no HTML, no markdown) matching the field label and the page language.',
        '- Respect maxLength and the input type: email -> valid email format, tel -> phone number, number -> digits only, date -> YYYY-MM-DD, password -> strong password.',
        '- If there are password and confirm-password fields, use the same password for both.',
        '- Return one entry per field index. Skip a field only if no sensible value exists for it.',
        '- profileName: short descriptive name based on the site and form purpose.',
        '- category: pick the most fitting category from the allowed list.',
        '',
        `Page context: ${JSON.stringify(scan.pageContext)}`,
        `Page URL: ${scan.url}`,
        '',
        `Form fields: ${JSON.stringify(scan.fields)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.smartModel || AI_CONFIG.model,
            max_tokens: 8192,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error && err.error.message) message = err.error.message;
        } catch (e) { }
        throw new Error(message);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') {
        throw new Error('The AI declined to process this request');
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
        throw new Error('Empty AI response');
    }

    return JSON.parse(textBlock.text);
}

function broadcastProfilesUpdated(skipCloudPush) {
    // Live-refresh any open extension pages (side panel, settings, editor)
    chrome.runtime.sendMessage({ action: 'profilesUpdated' }).catch(() => { });
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && !tab.url.startsWith('chrome://')) {
                chrome.tabs.sendMessage(tab.id, { action: 'recheckFloatingButton' }).catch(() => { });
            }
        });
    });
    // Every code path that changes profiles announces it here - piggyback the
    // cloud push (debounced, no-op when not signed in). Skipped when the
    // change CAME from the cloud - it was just pushed/pulled.
    if (!skipCloudPush) CloudSync.syncSchedulePush();
}

// Each tool writes its own config object (bug tracker, clear-data, responsive)
// from wherever its UI happens to live. Rather than teach every one of those
// call sites to stamp the write, watch the keys here: one place, and it covers
// any future tool that stores its settings the same way. Sync merges these key
// by key and needs the stamp only to settle keys both devices hold.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = (typeof SYNC_CONFIG_KEYS !== 'undefined' ? SYNC_CONFIG_KEYS : [])
        .filter(k => k in changes)
        // A value that sync itself just applied is the cloud arriving, not a
        // local edit; stamping it would make this device look like the author.
        .filter(k => !(typeof syncWasApplied === 'function' && syncWasApplied(k, changes[k].newValue)));
    if (!keys.length) return;
    chrome.storage.local.get(['qaConfigUpdatedAt'], (r) => {
        const map = { ...(r.qaConfigUpdatedAt || {}) };
        keys.forEach(k => { map[k] = Date.now(); });
        chrome.storage.local.set({ qaConfigUpdatedAt: map });
    });
});

// Pull cloud changes when the browser starts (e.g. edits made on another device)
chrome.runtime.onStartup.addListener(() => {
    CloudSync.syncNow(false);      // no window may open behind the user's back
});

// A push tells Drive. Nothing tells the other browser, so ask on a timer.
// chrome.alarms, not setInterval: the service worker is torn down when idle.
// 1 minute is Chrome's hard floor for periodInMinutes - there is no faster
// timer-based option short of a backend server pushing to the client.
const CLOUD_PULL_ALARM = 'cloudSyncPull';
const CLOUD_PULL_MINUTES = 1;

function ensureCloudPullAlarm() {
    chrome.alarms.get(CLOUD_PULL_ALARM, (existing) => {
        // Recreate on top of an alarm left over from an older, slower interval -
        // chrome.alarms.create() only takes effect for a name that doesn't exist yet.
        if (!existing || existing.periodInMinutes !== CLOUD_PULL_MINUTES) {
            chrome.alarms.create(CLOUD_PULL_ALARM, { periodInMinutes: CLOUD_PULL_MINUTES });
        }
    });
}
chrome.runtime.onStartup.addListener(ensureCloudPullAlarm);
chrome.runtime.onInstalled.addListener(ensureCloudPullAlarm);
ensureCloudPullAlarm();          // and after every service-worker restart

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLOUD_PULL_ALARM) CloudSync.syncNow(false);
    if (alarm.name === TEMP_MAIL_ALARM) updateTempMailUnread();
});

// ── Temp Mail unread count ──────────────────────────────────────────────────
// Keeps the Mail tab's unread badge live even while the popup is closed, by
// polling api.mail.tm on a timer and storing the count. Deliberately does NOT
// touch the toolbar action badge - that belongs to the recording timer.
const TEMP_MAIL_ALARM = 'tempMailCheck';
// 30s is the practical floor for a periodic alarm (0.5 min). A truly instant
// OS notification while the popup is closed isn't reachable in MV3 - the service
// worker is killed after ~30s idle and mail.tm's push heartbeat is ~31s, just too
// slow to hold it alive - so 30s is as tight as this can reliably get without a
// push backend. Re-created if the period drifted from an older 1-minute install.
function ensureTempMailAlarm() {
    chrome.alarms.get(TEMP_MAIL_ALARM, (existing) => {
        if (!existing || existing.periodInMinutes !== 0.5) {
            chrome.alarms.create(TEMP_MAIL_ALARM, { periodInMinutes: 0.5 });
        }
    });
}
chrome.runtime.onStartup.addListener(ensureTempMailAlarm);
chrome.runtime.onInstalled.addListener(ensureTempMailAlarm);
ensureTempMailAlarm();

// Every inbox the user holds is polled, not just one. tmInboxes is the list
// tempmail.js maintains ([{id,address,token,name}]); tmToken is kept in step for
// whichever is active, so a legacy install with only tmToken still gets polled.
function tmPollList(store) {
    if (Array.isArray(store.tmInboxes) && store.tmInboxes.length) {
        return store.tmInboxes.filter((b) => b && b.token);
    }
    if (store.tmToken) return [{ id: 'legacy', address: (store.tmAccount || {}).address || '', token: store.tmToken, name: '' }];
    return [];
}

// Polls every inbox and stores the summed unread count, so the Mail tab badge
// stays live while the popup is closed. (OS notifications were dropped - MV3
// can't deliver them instantly and the delayed ones weren't useful.)
function updateTempMailUnread() {
    chrome.storage.local.get(['tmInboxes', 'tmToken', 'tmAccount'], async (r) => {
        const boxes = tmPollList(r);
        if (!boxes.length) return; // user never opened the Mail tab; nothing to poll

        let total = 0;
        for (const box of boxes) {
            try {
                const res = await fetch('https://api.mail.tm/messages', {
                    headers: { 'Authorization': `Bearer ${box.token}` }
                });
                if (!res.ok) continue;
                const msgs = (await res.json())['hydra:member'] || [];
                total += msgs.filter((m) => !m.seen).length;
            } catch (e) { /* offline / token expired - skip this inbox */ }
        }
        chrome.storage.local.set({ tmUnreadCount: total });
    });
}
updateTempMailUnread();

// ── Quick login switch (Snapshot & Swap, no debugger) - popup message bridge ─
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const SW = self.SessionSwap;
    if (!request || !request.action || !SW) return false;
    switch (request.action) {
        case 'swapPing':
            // Just proves the worker is awake - the popup pings before every real
            // action so a sleeping worker doesn't drop it (see sessions.js).
            sendResponse({ ok: true });
            return true;
        case 'swapList':
            // The tab id lets listFor read the LIVE storage and work out WHO is
            // signed in - which is what makes "CURRENT" survive a rotated cookie.
            SW.listFor(request.url, request.tabId != null ? request.tabId : (sender && sender.tab && sender.tab.id))
                .then((snaps) => sendResponse({ snaps }))
                .catch((e) => sendResponse({ snaps: [], error: e.message || String(e) }));
            return true;   // async
        case 'swapSave':
            SW.saveCurrent(request.tab || (sender && sender.tab), request.name, request.operationId)
                .then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapRestore':
            SW.restore(request.tab || (sender && sender.tab), request.id).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapUpdate':
            SW.updateSnapshot(request.tab || (sender && sender.tab), request.id).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapDelete':
            SW.remove(request.url, request.id).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapRename':
            SW.rename(request.url, request.id, request.name).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapGetCreds':
            SW.credsInfo(request.id).then((creds) => sendResponse({ ok: true, creds }))
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapSaveCreds':
            SW.saveCreds(request.id, request.creds || {}).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapClearCreds':
            SW.setCreds(request.id, null).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        case 'swapRelogin':
            SW.relogin(request.tab || (sender && sender.tab), request.id).then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
    }
    return false;
});

// The timer alone means up to a full minute of staleness right when someone
// opens a panel to go look at something - pull the instant a page opens too.
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'pullNow') CloudSync.syncNow(false);
    return false;
});

// Auto-fill logic for "On Reload"
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        // Load profiles from IndexedDB
        let profiles = [];
        try {
            profiles = await FormFillerDB.getAllProfiles();
        } catch (err) {
            const localResult = await chrome.storage.local.get(['formFillerProfiles']);
            profiles = localResult.formFillerProfiles || [];
        }

        const match = profiles.find(p => {
            if (!p.url || !p.onReload || !p.fields || p.fields.length === 0) return false;
            try {
                return FormFillerDB.isUrlMatch(tab.url, p.url);
            } catch (e) {
                return false;
            }
        });

        if (match) {
            const settingsRes = await chrome.storage.sync.get(['formFillerSettings']);
            const settings = settingsRes.formFillerSettings || { randomDigits: 5 };

            // Wait 1 second for dynamic content to load
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, {
                    action: 'fillForm',
                    fields: match.fields,
                    settings,
                    profileId: match.id,
                    profileUrl: match.url
                }).catch(() => { });
            }, 1000);
        }
    }
});

// FAB Reactivity: Listen for tab updates (URL changes or full reloads)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Notify on URL change or completion to catch dynamic changes faster
    if ((changeInfo.url || changeInfo.status === 'complete') && tab.url && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tabId, { action: 'recheckFloatingButton' }).catch(() => { });
    }
});

// Support for Single Page Applications (SPAs) that use history API
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
    if (details.url && !details.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(details.tabId, { action: 'recheckFloatingButton' }).catch(() => { });
    }
});

/** 
 * Helper functions for form filling. 
 * These must be duplicated here because they are injected into the page scope.
 */
async function fillFormFields(fieldsData) {
    const { fields, settings, profileId } = fieldsData;

    function getElementsBySelector(selector) {
        if (!selector) return [];
        try {
            if (selector.startsWith('/') || selector.startsWith('//') || (selector.startsWith('(') && selector.includes('//'))) {
                const results = [];
                const query = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < query.snapshotLength; i++) {
                    results.push(query.snapshotItem(i));
                }
                return results;
            } else {
                return Array.from(document.querySelectorAll(selector));
            }
        } catch (e) {
            console.error('Selector error:', selector, e);
            return [];
        }
    }

    function resolveSmartVariables(val) {
        if (typeof val !== 'string') return val;
        let processedValue = val;
        const now = new Date();
        const smartVars = {
            '{{date}}': () => now.toISOString().split('T')[0],
            '{{time}}': () => now.toTimeString().split(' ')[0],
            '{{datetime}}': () => now.toISOString().replace('T', ' ').split('.')[0],
            '{{year}}': () => now.getFullYear().toString(),
            '{{month}}': () => (now.getMonth() + 1).toString().padStart(2, '0'),
            '{{day}}': () => now.getDate().toString().padStart(2, '0'),
            '{{random_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)] + '_' + Math.floor(100 + Math.random() * 899);
            },
            '{{first_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)];
            },
            '{{last_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)];
            },
            '{{full_name}}': () => {
                const first = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                const last = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                const f = first[Math.floor(Math.random() * first.length)];
                const l = last[Math.floor(Math.random() * last.length)];
                return `${f} ${l}`;
            },
            '{{username}}': () => {
                const names = ['Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'];
                return names[Math.floor(Math.random() * names.length)] + Math.floor(1000 + Math.random() * 89999);
            },
            '{{email}}': () => {
                const names = ['Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'];
                const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'mail.com', 'icloud.com'];
                return names[Math.floor(Math.random() * names.length)] + '_' + Math.floor(1000 + Math.random() * 8999) + '@' + domains[Math.floor(Math.random() * domains.length)];
            },
            '{{phone}}': () => {
                const prefix = ['010', '011', '012', '015', '050', '055', '0100', '0111', '0122'];
                const p = prefix[Math.floor(Math.random() * prefix.length)];
                return p + Math.floor(1000000 + Math.random() * 8999999);
            },
            '{{password}}': () => {
                const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
                let pass = "";
                for (let i = 0; i < 16; i++) pass += charset.charAt(Math.floor(Math.random() * charset.length));
                return pass;
            },
            '{{address}}': () => {
                const streets = [
                    'Teseen St', 'Gameat Al Dowal St', 'Haram St', 'Kasr Al Nile St', 'Talaat Harb St', 'Fouad St', 'Al Moez St', 'Port Said St', 'Al Galaa St', 'Al Nasr St', 'Al Merghany St', 'Mossadak St', 'Mohie El Din Abu El Ezz St', 'Abbas Al Akkad St', 'Makram Ebeid St', 'El Batal Ahmed Abdel Aziz St'
                ];
                return Math.floor(1 + Math.random() * 1999) + ' ' + streets[Math.floor(Math.random() * streets.length)];
            },
            '{{city}}': () => {
                const cities = [
                    'Cairo', 'Alexandria', 'Giza', 'Mansoura', 'Tanta', 'Assiut', 'Sohag', 'Luxor', 'Aswan', 'Port Said', 'Suez', 'Ismailia', 'Sharm El Sheikh', 'Hurghada', 'Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam', 'Khobar', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Kuwait City', 'Doha', 'Manama', 'Muscat'
                ];
                return cities[Math.floor(Math.random() * cities.length)];
            },
            '{{country}}': () => {
                const countries = [
                    'Egypt', 'Saudi Arabia', 'UAE', 'Kuwait', 'Qatar', 'Bahrain', 'Oman', 'Jordan', 'Lebanon', 'Syria', 'Iraq', 'Palestine', 'Yemen', 'Libya', 'Tunisia', 'Algeria', 'Morocco', 'Sudan', 'Mauritania', 'Djibouti', 'Somalia', 'Comoros'
                ];
                return countries[Math.floor(Math.random() * countries.length)];
            },
            '{{zip_code}}': () => Math.floor(10000 + Math.random() * 89999).toString(),
            '{{company}}': () => {
                const companies = [
                    'Nile Co', 'Arab Group', 'Global IT', 'Oriental Weavers', 'Ezz Steel', 'Elsewedy Electric', 'Talaat Moustafa', 'Palm Hills', 'Emaar Misr', 'Orascom', 'Vodafone', 'Etisalat', 'Orange', 'Banque Misr', 'National Bank of Egypt', 'EgyptAir'
                ];
                return companies[Math.floor(Math.random() * companies.length)];
            },
            '{{job_title}}': () => {
                const titles = [
                    'Software Developer', 'Project Manager', 'Graphic Designer', 'Engineer', 'Accountant', 'Lawyer', 'Doctor', 'Pharmacist', 'Teacher', 'Professor', 'Sales Rep', 'Marketing Specialist', 'HR Manager', 'Data Analyst', 'Auditor', 'Architect'
                ];
                return titles[Math.floor(Math.random() * titles.length)];
            },
            '{{age}}': () => Math.floor(18 + Math.random() * 62).toString(),
            '{{bool}}': () => Math.random() > 0.5 ? 'true' : 'false',
            '{{color}}': () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
            '{{guid}}': () => crypto.randomUUID(),
            '{{url}}': () => {
                const domains = ['google.com.eg', 'yahoo.com', 'facebook.com', 'linkedin.com', 'test.com.eg', 'portal.eg', 'myweb.site'];
                return 'https://' + domains[Math.floor(Math.random() * domains.length)] + '/' + Math.random().toString(36).substring(7);
            },
            '{{long_text}}': () => "This is a sample description text for testing purposes. It is used to fill long text fields with generic content. This profile belongs to a user registered for form filling automation. " + (Math.random() > 0.5 ? "The data generated here is randomized but follows a consistent theme for testing the application workflow effectively." : "")
        };
        for (const [key, resolver] of Object.entries(smartVars)) {
            if (processedValue.includes(key)) processedValue = processedValue.split(key).join(resolver());
        }
        return processedValue;
    }

    function generateSmartDate(field) {
        const direction = field.dateDirection || 'future';
        const format = field.dateFormat || 'DD/MM/YYYY';
        const separator = field.dateSeparator || '/';

        const now = new Date();
        let targetDate = new Date();

        if (direction === 'future') {
            const daysToAdd = Math.floor(1 + Math.random() * 29);
            targetDate.setDate(now.getDate() + daysToAdd);
        } else if (direction === 'past') {
            const daysToSub = Math.floor(1 + Math.random() * 29);
            targetDate.setDate(now.getDate() - daysToSub);
        } else if (direction === 'random') {
            const daysToShift = Math.floor(Math.random() * 60) - 30;
            targetDate.setDate(now.getDate() + daysToShift);
        }

        const dd = String(targetDate.getDate()).padStart(2, '0');
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const yyyy = targetDate.getFullYear();

        let result = format;
        result = result.replace('DD', dd).replace('MM', mm).replace('YYYY', yyyy);
        return result.split('/').join(separator);
    }

    const storageKey = 'ff_sequential_indices';
    const storageResult = await new Promise(resolve => chrome.storage.local.get([storageKey], resolve));
    const allIndices = storageResult[storageKey] || {};
    let updatedAny = false;

    for (const field of fields) {
        const action = field.actionType || 'fill';

        if (action === 'wait') {
            const seconds = parseFloat(field.value) || 0;
            const ms = Math.max(0, seconds * 1000);
            await new Promise(resolve => setTimeout(resolve, ms));
            continue;
        }

        const elements = getElementsBySelector(field.selector);
        for (const el of elements) {
            if (el.offsetParent === null) continue;

            if (action === 'click') {
                el.click();
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            if (field.sequentialSelect && el.tagName === 'SELECT') {
                const options = Array.from(el.options).filter((opt, index) => {
                    if (!opt.value || opt.value.trim() === '') return false;
                    if (opt.disabled) return false;
                    const text = opt.text.toLowerCase();
                    const isPlaceholder = text.includes('select') || text.includes('choose') || text.includes('اختر') || text.includes('حدد') || text.includes('---');
                    if (index === 0 && isPlaceholder) return false;
                    return true;
                });

                if (options.length > 0) {
                    const key = `${profileId}_${field.selector}`;
                    let currentIndex = allIndices[key] !== undefined ? allIndices[key] : -1;
                    let nextIndex = (currentIndex + 1) % options.length;
                    el.value = options[nextIndex].value;
                    allIndices[key] = nextIndex;
                    updatedAny = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    continue;
                }
            }

            let value = '';
            if (field.isSmartDate) {
                value = generateSmartDate(field);
            } else {
                value = resolveSmartVariables(field.value);
                if (field.uniqueText) {
                    const digits = Math.min(field.digits || 5, 50);
                    let res = "";
                    for (let i = 0; i < digits; i++) res += Math.floor(Math.random() * 10).toString();
                    value = value + res;
                }
                else if (field.uniqueNumber) {
                    const digits = Math.min(field.digits || 5, 50);
                    let res = Math.floor(1 + Math.random() * 9).toString();
                    for (let i = 1; i < digits; i++) res += Math.floor(Math.random() * 10).toString();
                    value = res;
                }
            }

            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if (updatedAny) chrome.storage.local.set({ [storageKey]: allIndices });
}
