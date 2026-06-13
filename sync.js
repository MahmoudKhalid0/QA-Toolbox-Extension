// Cloud Sync for QA-Toolbox
// Stores a JSON backup of all user data (profiles, settings, categories) in the
// user's own Google Drive appDataFolder - a hidden, app-only space. No servers,
// no cost: the data lives in the user's Google account and follows them across
// devices once they sign in with the same Google account.
//
// Loaded by background.js via importScripts. Requires "identity" permission and
// the manifest "oauth2" client_id (see README for the Google Cloud setup).

const SYNC_FILE_NAME = 'qa-toolbox-sync.json';
const SYNC_DEBOUNCE_MS = 5000;
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // forget deletions after 90 days

let syncPushTimer = null;

// ---------- Auth ----------

function syncGetToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
            if (chrome.runtime.lastError || !token) {
                reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No token'));
            } else {
                resolve(token);
            }
        });
    });
}

function syncRemoveCachedToken(token) {
    return new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
}

function syncGetEmail() {
    return new Promise((resolve) => {
        try {
            chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
                resolve((info && info.email) || '');
            });
        } catch (e) {
            resolve('');
        }
    });
}

// Drive fetch with one retry on an expired cached token
async function driveFetch(url, options = {}) {
    let token = await syncGetToken(false);
    const doFetch = (t) => fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), 'Authorization': `Bearer ${t}` }
    });
    let res = await doFetch(token);
    if (res.status === 401) {
        await syncRemoveCachedToken(token);
        token = await syncGetToken(false);
        res = await doFetch(token);
    }
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text().catch(() => '')}`);
    return res;
}

// ---------- Drive file operations ----------

async function driveFindBackupFileId() {
    const q = encodeURIComponent(`name='${SYNC_FILE_NAME}'`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
    const data = await res.json();
    return (data.files && data.files[0] && data.files[0].id) || null;
}

async function driveDownload(fileId) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return res.json();
}

async function driveUpload(fileId, payload) {
    const body = JSON.stringify(payload);
    if (fileId) {
        await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        return fileId;
    }
    // Create: multipart upload (metadata putting the file in appDataFolder + content)
    const boundary = 'qa_toolbox_sync_' + Date.now();
    const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'] }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        body +
        `\r\n--${boundary}--`;
    const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart
    });
    const data = await res.json();
    return data.id;
}

// ---------- Local data collection / merge ----------

async function syncCollectLocalData() {
    let profiles = [];
    try { profiles = await FormFillerDB.getAllProfiles(); } catch (e) { }
    const syncStore = await chrome.storage.sync.get(['formFillerSettings', 'formFillerCategories', 'formFillerCategoriesUpdatedAt']);
    const localStore = await chrome.storage.local.get(['aiSaveBehavior', 'syncTombstones']);
    return {
        version: 1,
        exportedAt: Date.now(),
        profiles,
        tombstones: localStore.syncTombstones || {},
        settings: syncStore.formFillerSettings || null,
        categories: syncStore.formFillerCategories || null,
        categoriesUpdatedAt: syncStore.formFillerCategoriesUpdatedAt || 0,
        aiSaveBehavior: localStore.aiSaveBehavior || null
    };
}

// Merge cloud + local: union of profiles (newest lastModified wins per id),
// minus anything deleted more recently than it was modified (tombstones).
function syncMergeProfiles(localProfiles, cloudProfiles, localTombs, cloudTombs) {
    const tombstones = { ...cloudTombs };
    for (const [id, ts] of Object.entries(localTombs || {})) {
        if (!tombstones[id] || tombstones[id] < ts) tombstones[id] = ts;
    }
    // Drop expired tombstones so the map doesn't grow forever
    const now = Date.now();
    for (const id of Object.keys(tombstones)) {
        if (now - tombstones[id] > TOMBSTONE_TTL_MS) delete tombstones[id];
    }

    const byId = new Map();
    for (const p of (cloudProfiles || [])) {
        if (p && p.id !== undefined) byId.set(String(p.id), p);
    }
    for (const p of (localProfiles || [])) {
        if (!p || p.id === undefined) continue;
        const key = String(p.id);
        const existing = byId.get(key);
        if (!existing || (p.lastModified || 0) >= (existing.lastModified || 0)) {
            byId.set(key, p);
        }
    }

    const merged = [];
    for (const [id, p] of byId) {
        const deletedAt = tombstones[id];
        if (deletedAt && deletedAt > (p.lastModified || 0)) continue; // deleted wins
        merged.push(p);
    }
    return { merged, tombstones };
}

// ---------- Sync state ----------

async function syncGetMeta() {
    const r = await chrome.storage.local.get(['cloudSyncMeta']);
    return r.cloudSyncMeta || { signedIn: false, email: '', lastSyncAt: null, lastError: null };
}

async function syncSetMeta(patch) {
    const meta = await syncGetMeta();
    const next = { ...meta, ...patch };
    await chrome.storage.local.set({ cloudSyncMeta: next });
    return next;
}

// Tell open extension pages (side panel) what the sync is doing right now
function syncBroadcastState(state) {
    try { chrome.runtime.sendMessage({ action: 'syncStateChanged', state }).catch(() => { }); } catch (e) { }
}

// ---------- Main entry points ----------

// Pull + merge + push. Safe to call repeatedly; does nothing if not signed in.
async function syncNow() {
    const meta = await syncGetMeta();
    if (!meta.signedIn) return { skipped: true };

    syncBroadcastState('syncing');
    try {
        const fileId = await driveFindBackupFileId();
        const cloud = fileId ? await driveDownload(fileId).catch(() => null) : null;
        const local = await syncCollectLocalData();

        const { merged, tombstones } = syncMergeProfiles(
            local.profiles, (cloud && cloud.profiles) || [],
            local.tombstones, (cloud && cloud.tombstones) || {}
        );

        // Categories: newest list wins (union would resurrect deleted categories)
        let categories = local.categories;
        let categoriesUpdatedAt = local.categoriesUpdatedAt || 0;
        if (cloud && Array.isArray(cloud.categories) && (cloud.categoriesUpdatedAt || 0) > categoriesUpdatedAt) {
            categories = cloud.categories;
            categoriesUpdatedAt = cloud.categoriesUpdatedAt || 0;
        }
        if (categories && !categories.includes('General')) categories.unshift('General');

        // Settings / AI behavior: local wins when present, cloud fills the gaps
        const settings = local.settings || (cloud && cloud.settings) || null;
        const aiSaveBehavior = local.aiSaveBehavior || (cloud && cloud.aiSaveBehavior) || null;

        // Apply merged state locally
        await FormFillerDB.saveAllProfiles(merged);
        await chrome.storage.local.set({ syncTombstones: tombstones });
        if (categories) await chrome.storage.sync.set({ formFillerCategories: categories, formFillerCategoriesUpdatedAt: categoriesUpdatedAt });
        if (settings) await chrome.storage.sync.set({ formFillerSettings: settings });
        if (aiSaveBehavior) await chrome.storage.local.set({ aiSaveBehavior });

        // Push the merged result back to Drive
        await driveUpload(fileId, {
            version: 1,
            exportedAt: Date.now(),
            profiles: merged,
            tombstones,
            settings,
            categories,
            categoriesUpdatedAt,
            aiSaveBehavior
        });

        await syncSetMeta({ lastSyncAt: Date.now(), lastError: null });

        // Tell open extension pages to re-render with the merged data
        // (defined in background.js; skipCloudPush=true - we just synced)
        if (typeof broadcastProfilesUpdated === 'function') broadcastProfilesUpdated(true);
        syncBroadcastState('done');

        return { success: true, profileCount: merged.length };
    } catch (err) {
        console.error('Sync failed:', err);
        await syncSetMeta({ lastError: String(err.message || err) });
        syncBroadcastState('error');
        return { success: false, error: String(err.message || err) };
    }
}

// Debounced push after local changes (profile saves/deletes)
function syncSchedulePush() {
    if (syncPushTimer) clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(async () => {
        syncPushTimer = null;
        const meta = await syncGetMeta();
        if (meta.signedIn) await syncNow();
    }, SYNC_DEBOUNCE_MS);
}

async function syncSignIn() {
    // Interactive consent prompt (the only place that may show UI)
    await syncGetToken(true);
    const email = await syncGetEmail();
    await syncSetMeta({ signedIn: true, email, lastError: null });
    const result = await syncNow();
    return { email, ...result };
}

async function syncSignOut() {
    try {
        const token = await syncGetToken(false);
        await syncRemoveCachedToken(token);
    } catch (e) { /* no cached token - nothing to clear */ }
    await syncSetMeta({ signedIn: false, email: '', lastError: null });
    syncBroadcastState('signedout');
    return { success: true };
}

const syncExportTarget = typeof globalThis !== 'undefined' ? globalThis : self;
syncExportTarget.CloudSync = {
    syncNow,
    syncSchedulePush,
    syncSignIn,
    syncSignOut,
    syncGetMeta
};
