// Cloud Sync for QA Testing Toolkit
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
const SYNC_PAYLOAD_VERSION = 2;

let syncPushTimer = null;

// ---------- Auth ----------
//
// We use identity.launchWebAuthFlow, not identity.getAuthToken: the latter only
// exists in Chrome (it piggybacks on the browser's own Google sign-in), so the
// extension would lose cloud sync on Edge and Firefox. launchWebAuthFlow is a
// plain OAuth redirect dance and works in all three.
//
// Flow: implicit grant (response_type=token). It returns no refresh token, so we
// cache the access token until it expires and then re-run the flow silently
// (prompt=none) against the user's existing Google session.
//
// Google Cloud setup: the OAuth client must be a *Web application* client whose
// authorized redirect URI is chrome.identity.getRedirectURL() — this differs per
// browser, so register each one you intend to support:
//   Chrome/Edge : https://<extension-id>.chromiumapp.org/
//   Firefox     : https://<uuid>.extensions.allizom.org/

// Google's consent screen lets the user untick a permission and continue. The
// token then arrives looking perfectly valid and fails on the first Drive call.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SHARE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHARE_FOLDER = 'QA Testing Toolkit';

// Every scope we cannot work without. `email` is cosmetic; these are not.
const requiredScopes = () => syncOAuthConfig().scopes.filter(s => s.includes('/auth/drive'));

function syncOAuthConfig() {
    const m = chrome.runtime.getManifest();
    const o = m.oauth2 || {};
    return { clientId: o.client_id || '', scopes: o.scopes || [] };
}

let syncTokenCache = null;      // { token, expiresAt, scopes }
let syncAllowPrompt = false;    // only a user-initiated sync may open a window

async function syncLoadToken() {
    // Adding a scope invalidates every token minted before it, no matter how
    // long it has left to live.
    const covers = (t) => Array.isArray(t.scopes) && requiredScopes().every(s => t.scopes.includes(s));
    const fresh = (t) => t && t.token && t.expiresAt > Date.now() + 60000 && covers(t); // 1 min of slack

    if (fresh(syncTokenCache)) return syncTokenCache;
    const r = await chrome.storage.local.get(['cloudSyncToken']);
    if (fresh(r.cloudSyncToken)) { syncTokenCache = r.cloudSyncToken; return syncTokenCache; }
    return null;
}

async function syncStoreToken(t) {
    syncTokenCache = t;
    await chrome.storage.local.set({ cloudSyncToken: t });
}

async function syncClearToken() {
    syncTokenCache = null;
    await chrome.storage.local.remove('cloudSyncToken');
}

function syncLaunchFlow(interactive) {
    const { clientId, scopes } = syncOAuthConfig();
    if (!clientId) return Promise.reject(new Error('No OAuth client_id in the manifest'));
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'token',
        redirect_uri: chrome.identity.getRedirectURL(),
        scope: scopes.join(' ')
    });
    // Silent attempt: never show UI, just reuse the browser's Google session.
    if (!interactive) params.set('prompt', 'none');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive: !!interactive }, (redirectUrl) => {
            if (chrome.runtime.lastError || !redirectUrl) {
                reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Authorization failed'));
                return;
            }
            // Implicit grant returns the token in the URL fragment
            const frag = new URLSearchParams((redirectUrl.split('#')[1] || ''));
            const error = frag.get('error');
            if (error) { reject(new Error(error)); return; }
            const token = frag.get('access_token');
            if (!token) { reject(new Error('No access token returned')); return; }

            // Refuse a token that cannot do the jobs we need it for, rather than
            // caching it and failing later with a Drive 403.
            const granted = (frag.get('scope') || '').split(' ');
            if (requiredScopes().some(s => !granted.includes(s))) {
                reject(new Error('SCOPE_DENIED'));
                return;
            }

            const expiresIn = parseInt(frag.get('expires_in'), 10) || 3600;
            resolve({ token, expiresAt: Date.now() + expiresIn * 1000, scopes: granted });
        });
    });
}

async function syncGetToken(interactive) {
    const cached = await syncLoadToken();
    if (cached) return cached.token;
    // Always try silently first — an interactive prompt is a last resort.
    try {
        const t = await syncLaunchFlow(false);
        await syncStoreToken(t);
        return t.token;
    } catch (e) {
        if (!interactive) throw e;
    }
    const t = await syncLaunchFlow(true);
    await syncStoreToken(t);
    return t.token;
}

// Needs the "email" scope; getProfileUserInfo() is Chrome-only.
async function syncGetEmail() {
    try {
        const token = await syncGetToken(false);
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return '';
        const d = await res.json();
        return d.email || '';
    } catch (e) {
        return '';
    }
}

// Drive fetch with one retry on an expired token
async function driveFetch(url, options = {}) {
    let token = await syncGetToken(syncAllowPrompt);
    const doFetch = (t) => fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), 'Authorization': `Bearer ${t}` }
    });
    let res = await doFetch(token);
    if (res.status === 401) {
        await syncClearToken();
        try {
            token = await syncGetToken(syncAllowPrompt);
        } catch (e) {
            throw new Error('SESSION_EXPIRED');
        }
        res = await doFetch(token);
    }
    if (res.status === 403) {
        const body = await res.text().catch(() => '');
        if (body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || body.includes('insufficientPermissions')) {
            await syncClearToken();          // it can never succeed; do not keep it
            throw new Error('SCOPE_DENIED');
        }
        throw new Error(`Drive API 403: ${body}`);
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

// A value that is `false` or `0` is still a value. Anything the user has set
// locally wins; only an absent setting falls back to what the cloud holds.
const syncPick = (mine, theirs) => (mine !== undefined && mine !== null) ? mine
    : ((theirs !== undefined && theirs !== null) ? theirs : null);

// Profiles carry their own lastModified. Nothing else did, so a device that had
// only ever written a *default* ("General", {randomDigits:5}) still stamped it
// with Date.now() and out-voted a year of real edits on the other machine.
// Everything that syncs now travels with the moment it was last touched.
async function syncCollectLocalData() {
    let profiles = [];
    try { profiles = await FormFillerDB.getAllProfiles(); } catch (e) { }
    const syncStore = await chrome.storage.sync.get([
        'formFillerSettings', 'formFillerSettingsUpdatedAt',
        'formFillerCategories', 'formFillerCategoriesUpdatedAt',
        'formFillerCategoryTombstones', 'formFillerCategoryAddedAt',
        'delaySeconds'
    ]);
    const localStore = await chrome.storage.local.get([
        'aiSaveBehavior', 'syncTombstones', 'qaClearData', 'qaResponsive', 'qaBugTracker',
        'capEyeEnabled', 'qaConfigUpdatedAt'
    ]);
    return {
        syncVersion: SYNC_PAYLOAD_VERSION,
        exportedAt: Date.now(),
        profiles,
        tombstones: localStore.syncTombstones || {},
        settings: syncStore.formFillerSettings || null,
        settingsUpdatedAt: syncStore.formFillerSettingsUpdatedAt || 0,
        categories: syncStore.formFillerCategories || null,
        categoriesUpdatedAt: syncStore.formFillerCategoriesUpdatedAt || 0,
        categoryTombstones: syncStore.formFillerCategoryTombstones || {},
        categoryAddedAt: syncStore.formFillerCategoryAddedAt || {},
        aiSaveBehavior: localStore.aiSaveBehavior || null,
        qaClearData: localStore.qaClearData || null,
        qaResponsive: localStore.qaResponsive || null,
        // Jira / Azure credentials and project choices. They live in the app's
        // own private Drive folder, which nothing but this extension can read.
        qaBugTracker: localStore.qaBugTracker || null,
        // When each tool's config object was last edited on this device. Written
        // by background.js's stamper, one entry per key (qaBugTracker, ...).
        configUpdatedAt: localStore.qaConfigUpdatedAt || {},
        capEyeEnabled: localStore.capEyeEnabled,
        delaySeconds: syncStore.delaySeconds
    };
}

// The tool config objects (bug tracker, clear-data, responsive) that are merged
// key by key rather than "whichever side has one wins".
const SYNC_CONFIG_KEYS = ['qaBugTracker', 'qaClearData', 'qaResponsive'];

// Values that sync itself has just written. background.js's stamper watches the
// same keys, and must not mistake "the cloud arrived" for "the user edited".
const syncAppliedValues = new Map();
function syncMarkApplied(key, value) { syncAppliedValues.set(key, JSON.stringify(value === undefined ? null : value)); }
function syncWasApplied(key, value) {
    return syncAppliedValues.get(key) === JSON.stringify(value === undefined ? null : value);
}

// A device that has never completed a pull knows nothing; its "state" is a pile
// of install defaults. Let it out-vote the cloud and it deletes the account.
// Until the first pull lands, every local timestamp counts as zero.
const syncStamp = (value, hydrated) => (hydrated ? (value || 0) : 0);

// Union of two sets of category names, minus the ones explicitly deleted.
// Union, not last-write-wins: a name only disappears when someone actually
// pressed Delete on it (a tombstone), never because the other device had not
// heard of it yet. `addedAt` lets a re-created category survive its own tombstone.
function syncMergeCategories(local, cloud, hydrated, profiles) {
    const tombstones = {};
    const addTombs = (map) => {
        for (const [k, ts] of Object.entries(map || {})) {
            const key = String(k).toLowerCase();
            if (!tombstones[key] || tombstones[key] < ts) tombstones[key] = ts;
        }
    };
    addTombs(cloud && cloud.categoryTombstones);
    if (hydrated) addTombs(local.categoryTombstones);

    const now = Date.now();
    for (const k of Object.keys(tombstones)) {
        if (now - tombstones[k] > TOMBSTONE_TTL_MS) delete tombstones[k];
    }

    const addedAt = { ...((cloud && cloud.categoryAddedAt) || {}) };
    for (const [k, ts] of Object.entries(local.categoryAddedAt || {})) {
        const key = String(k).toLowerCase();
        if (!addedAt[key] || addedAt[key] < ts) addedAt[key] = ts;
    }

    // Preserve display order: cloud's list first, then anything only we have.
    const seen = new Set();
    const names = [];
    for (const name of [...((cloud && cloud.categories) || []), ...(local.categories || [])]) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const deletedAt = tombstones[key] || 0;
        if (deletedAt && deletedAt > (addedAt[key] || 0)) continue;   // really deleted
        names.push(name);
    }
    if (!names.some(n => n.toLowerCase() === 'general')) names.unshift('General');

    // Self-heal: a category a profile is actually filed under exists, whatever
    // the list says. This is what puts back the names an older build lost, and
    // it costs nothing on a healthy install because the list already has them.
    for (const p of (profiles || [])) {
        const c = p && p.category;
        if (typeof c !== 'string' || !c.trim()) continue;
        const key = c.toLowerCase();
        if (seen.has(key)) continue;
        if ((tombstones[key] || 0) > (addedAt[key] || 0)) continue;   // deliberately deleted
        seen.add(key);
        names.push(c);
    }

    const categoriesUpdatedAt = Math.max(
        syncStamp(local.categoriesUpdatedAt, hydrated),
        (cloud && cloud.categoriesUpdatedAt) || 0
    );
    return { categories: names, categoryTombstones: tombstones, categoryAddedAt: addedAt, categoriesUpdatedAt };
}

// Key-by-key union of two settings objects. Whole-object last-write-wins used to
// throw away every key the winner had never heard of; a key that exists on only
// one side is not a conflict, it is data.
function syncMergeSettings(mine, theirs, myStamp, theirStamp) {
    if (!mine || typeof mine !== 'object') return theirs && typeof theirs === 'object' ? { ...theirs } : (theirs || mine || null);
    if (!theirs || typeof theirs !== 'object') return { ...mine };
    const out = { ...theirs, ...mine };                 // union, local value by default
    if ((theirStamp || 0) > (myStamp || 0)) {           // their edit is newer: it wins the overlap
        for (const k of Object.keys(theirs)) out[k] = theirs[k];
        for (const k of Object.keys(mine)) if (!(k in theirs)) out[k] = mine[k];
    }
    return out;
}

// The same key-by-key union for QA Toolbox's per-tool config objects (bug
// tracker credentials, clear-data types, responsive breakpoints). `local ||
// cloud` used to mean a device that had ever opened the tool could never
// receive the other machine's copy - the second half of the reported bug.
// Anything that is not an object (a string like aiSaveBehavior, a boolean) has
// no keys to union, so it falls back to a plain newest/hydrated-aware pick.
function syncMergeConfig(mine, theirs, hydrated, myStamp, theirStamp) {
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(mine) || !isObj(theirs)) {
        return hydrated ? (mine || theirs || null) : (theirs || mine || null);
    }
    // Not hydrated: this device is still a reader, so the cloud wins the keys
    // both sides hold - but keys only this device has are still data, not noise.
    if (!hydrated) return syncMergeSettings(theirs, mine, theirStamp || 0, 0);
    return syncMergeSettings(mine, theirs, myStamp || 0, theirStamp || 0);
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
    return r.cloudSyncMeta || { signedIn: false, email: '', lastSyncAt: null, lastError: null, hydratedAt: null };
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

// Anything the cloud holds that the merge dropped without a tombstone to explain
// it is a bug, not a deletion - put it back rather than uploading the loss.
// This is the last line of defence: whatever slips through the merge, the cloud
// copy still cannot shrink by accident.
function syncGuardNoSilentLoss(cloud, next) {
    const lost = [];
    const keptIds = new Set(next.profiles.map(p => String(p.id)));
    for (const p of ((cloud && cloud.profiles) || [])) {
        const id = String(p && p.id);
        if (keptIds.has(id) || next.tombstones[id]) continue;
        next.profiles.push(p);
        lost.push('profile:' + id);
    }
    const keptCats = new Set(next.categories.map(c => String(c).toLowerCase()));
    for (const c of ((cloud && cloud.categories) || [])) {
        const key = String(c).toLowerCase();
        if (keptCats.has(key) || next.categoryTombstones[key]) continue;
        next.categories.push(c);
        keptCats.add(key);
        lost.push('category:' + c);
    }
    if (lost.length) console.warn('Cloud sync: refused to drop un-tombstoned items', lost);
    return lost;
}

// Pull + merge + push. Safe to call repeatedly; does nothing if not signed in.
//
// Order matters: PULL, merge, apply locally, mark this device hydrated, then
// push. A device that has not yet hydrated never gets to out-vote the cloud -
// on first sign-in it is a reader, and only afterwards an author.
async function syncNow(interactive = false) {
    const meta = await syncGetMeta();
    if (!meta.signedIn) return { skipped: true };

    syncAllowPrompt = !!interactive;
    syncBroadcastState('syncing');
    try {
        const fileId = await driveFindBackupFileId();

        // A download that failed is not an empty backup. Swallowing the error
        // here merges local against nothing and then writes that nothing back,
        // erasing the other machine's data while reporting success.
        const cloud = fileId ? await driveDownload(fileId) : null;
        const local = await syncCollectLocalData();

        // First successful pull on this device? Then its timestamps are install
        // defaults, not decisions - they lose every tie-break this round.
        const hydrated = !!meta.hydratedAt;

        const { merged, tombstones } = syncMergeProfiles(
            local.profiles, (cloud && cloud.profiles) || [],
            hydrated ? local.tombstones : {}, (cloud && cloud.tombstones) || {}
        );

        // Categories: union by name, minus explicit deletions (see syncMergeCategories)
        const cat = syncMergeCategories(local, cloud, hydrated, merged);

        // Settings: key-by-key union, newest side wins the overlapping keys
        const settingsUpdatedAt = Math.max(syncStamp(local.settingsUpdatedAt, hydrated), (cloud && cloud.settingsUpdatedAt) || 0);
        const settings = syncMergeSettings(
            local.settings, cloud && cloud.settings,
            syncStamp(local.settingsUpdatedAt, hydrated), (cloud && cloud.settingsUpdatedAt) || 0);

        // Device-local prefs: on a hydrated device local wins and cloud fills the
        // gaps; on a fresh one the cloud leads, so nothing arrives half-configured.
        const preferLocal = (l, c) => hydrated ? (l || c || null) : (c || l || null);
        const aiSaveBehavior = preferLocal(local.aiSaveBehavior, cloud && cloud.aiSaveBehavior);

        // Per-tool config objects: key-by-key union, newest side wins the
        // overlap. Their stamps live in one map so a new tool needs no new key.
        const cloudCfgAt = (cloud && cloud.configUpdatedAt) || {};
        const configUpdatedAt = { ...cloudCfgAt };
        for (const [k, ts] of Object.entries(local.configUpdatedAt || {})) {
            const mine = syncStamp(ts, hydrated);
            if (!configUpdatedAt[k] || configUpdatedAt[k] < mine) configUpdatedAt[k] = mine;
        }
        const mergeCfg = (key) => syncMergeConfig(
            local[key], cloud && cloud[key], hydrated,
            syncStamp((local.configUpdatedAt || {})[key], hydrated), cloudCfgAt[key] || 0);
        const qaClearData = mergeCfg('qaClearData');
        const qaResponsive = mergeCfg('qaResponsive');
        const qaBugTracker = mergeCfg('qaBugTracker');
        const capEyeEnabled = hydrated
            ? syncPick(local.capEyeEnabled, cloud && cloud.capEyeEnabled)
            : syncPick(cloud && cloud.capEyeEnabled, local.capEyeEnabled);
        const delaySeconds = hydrated
            ? syncPick(local.delaySeconds, cloud && cloud.delaySeconds)
            : syncPick(cloud && cloud.delaySeconds, local.delaySeconds);

        const next = {
            profiles: merged, tombstones,
            categories: cat.categories,
            categoryTombstones: cat.categoryTombstones,
            categoryAddedAt: cat.categoryAddedAt
        };
        syncGuardNoSilentLoss(cloud, next);
        const categories = next.categories;

        // Keep the pre-merge state on disk before touching anything, so a sync
        // that goes wrong is one restore away instead of gone.
        await chrome.storage.local.set({ syncLocalBackup: { at: Date.now(), data: local } });

        // Apply merged state locally
        await FormFillerDB.saveAllProfiles(next.profiles);
        await chrome.storage.local.set({ syncTombstones: next.tombstones });
        await chrome.storage.sync.set({
            formFillerCategories: categories,
            formFillerCategoriesUpdatedAt: cat.categoriesUpdatedAt,
            formFillerCategoryTombstones: next.categoryTombstones,
            formFillerCategoryAddedAt: next.categoryAddedAt
        });
        if (settings) await chrome.storage.sync.set({ formFillerSettings: settings, formFillerSettingsUpdatedAt: settingsUpdatedAt });
        if (aiSaveBehavior) await chrome.storage.local.set({ aiSaveBehavior });
        // Writing an identical value still fires storage.onChanged everywhere -
        // which would both churn the tools' UIs and re-stamp the config as if
        // the user had just edited it. Only write what actually changed.
        const applyConfig = async (key, value) => {
            if (value === null || value === undefined) return;
            syncMarkApplied(key, value);
            if (JSON.stringify(value) === JSON.stringify(local[key])) return;
            await chrome.storage.local.set({ [key]: value });
        };
        await applyConfig('qaClearData', qaClearData);
        await applyConfig('qaResponsive', qaResponsive);
        await applyConfig('qaBugTracker', qaBugTracker);
        if (Object.keys(configUpdatedAt).length) await chrome.storage.local.set({ qaConfigUpdatedAt: configUpdatedAt });
        if (capEyeEnabled !== null) await chrome.storage.local.set({ capEyeEnabled });
        if (delaySeconds !== null) await chrome.storage.sync.set({ delaySeconds });

        // The pull landed and is on disk: from here on this device is a full peer.
        if (!hydrated) await syncSetMeta({ hydratedAt: Date.now() });

        // Push the merged result back to Drive
        await driveUpload(fileId, {
            syncVersion: SYNC_PAYLOAD_VERSION,
            version: 1,                      // older builds read this field
            exportedAt: Date.now(),
            lastSyncedAt: Date.now(),
            profiles: next.profiles,
            tombstones: next.tombstones,
            settings,
            settingsUpdatedAt,
            categories,
            categoriesUpdatedAt: cat.categoriesUpdatedAt,
            categoryTombstones: next.categoryTombstones,
            categoryAddedAt: next.categoryAddedAt,
            aiSaveBehavior,
            qaClearData,
            qaResponsive,
            qaBugTracker,
            configUpdatedAt,
            capEyeEnabled,
            delaySeconds
        });

        await syncSetMeta({ lastSyncAt: Date.now(), lastError: null });

        // Tell open extension pages to re-render with the merged data
        // (defined in background.js; skipCloudPush=true - we just synced)
        if (typeof broadcastProfilesUpdated === 'function') broadcastProfilesUpdated(true);
        syncBroadcastState('done');

        return { success: true, profileCount: next.profiles.length, categoryCount: categories.length };
    } catch (err) {
        console.error('Sync failed:', err);
        // Nothing was uploaded: the cloud copy is whatever it was before. The
        // account stays connected - an hour-old token is not a disconnection.
        const msg = syncExplain(err);
        await syncSetMeta({ lastError: msg });
        syncBroadcastState('error');
        return { success: false, error: msg };
    } finally {
        syncAllowPrompt = false;
    }
}

// Debounced push after local changes (profile saves/deletes)
function syncSchedulePush() {
    if (syncPushTimer) clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(async () => {
        syncPushTimer = null;
        const meta = await syncGetMeta();
        if (meta.signedIn) await syncNow(false);   // a timer must never open a window
    }, SYNC_DEBOUNCE_MS);
}

async function syncSignIn() {
    // Interactive consent prompt (the only place that may show UI)
    try {
        await syncGetToken(true);
    } catch (err) {
        const msg = syncExplain(err);
        await syncSetMeta({ lastError: msg });
        throw new Error(msg);
    }
    const email = await syncGetEmail();
    await syncSetMeta({ signedIn: true, email, lastError: null });
    const result = await syncNow(true);
    return { email, ...result };
}

async function syncSignOut() {
    // Revoke at Google so a silent re-auth can't quietly sign the user back in
    const cached = await syncLoadToken();
    if (cached) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(cached.token), { method: 'POST' }).catch(() => { });
    }
    await syncClearToken();
    // Clearing hydratedAt matters: the next sign-in may well be a different
    // account, and this device must read that account's cloud before it writes
    // to it. Merges are unions, so nothing local is lost by pulling first.
    await syncSetMeta({ signedIn: false, email: '', lastError: null, hydratedAt: null });
    syncBroadcastState('signedout');
    return { success: true };
}

// ---------- Sharing a capture ----------

// Files land in one folder in the user's own Drive, so they can find and delete
// them without us. drive.file only ever shows us what this extension created,
// so this query cannot see anything else they own.
async function driveFindOrCreateFolder(name, parentId) {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(
        `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false` +
        (parentId ? ` and '${parentId}' in parents` : ''));
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`);
    const found = (await res.json()).files || [];
    if (found.length) return found[0].id;

    const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) meta.parents = [parentId];
    const made = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
    });
    return (await made.json()).id;
}

async function driveShareFolderId() {
    return driveFindOrCreateFolder(SHARE_FOLDER, null);
}

// The default workspace is named for whichever account is currently synced.
// Logging in from another machine with the same account sees the same name and
// the same Drive folder - there is nothing device-local to fall out of step.
async function driveDefaultWorkspaceName() {
    const meta = await syncGetMeta();
    return meta.email || 'My captures';
}

// Resolve a workspace to its Drive folder id, creating it under the shared root
// if this is the first time it is used. No name means the default workspace.
async function driveWorkspaceFolderId(workspaceName) {
    const rootId = await driveShareFolderId();
    const name = (workspaceName || '').trim() || await driveDefaultWorkspaceName();
    const id = await driveFindOrCreateFolder(name, rootId);
    return { id, name };
}

// Every workspace that exists in Drive, default first. The default is created
// here if it does not exist yet, so the picker is never empty.
async function driveListWorkspaces() {
    const rootId = await driveShareFolderId();
    const q = encodeURIComponent(
        `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    const found = (await res.json()).files || [];

    const defaultName = await driveDefaultWorkspaceName();
    if (!found.some(f => f.name === defaultName)) {
        const id = await driveFindOrCreateFolder(defaultName, rootId);
        found.push({ id, name: defaultName });
    }
    found.sort((a, b) => (a.name === defaultName ? -1 : b.name === defaultName ? 1 : a.name.localeCompare(b.name)));
    return { workspaces: found, defaultName };
}

// Drive wants multipart/related: a JSON part, then the bytes. A Blob can hold
// both, which keeps a large recording out of a base64 string.
async function driveUploadShared(blob, name, folderId) {
    const boundary = 'qa_share_' + Date.now();
    const meta = JSON.stringify({ name, parents: [folderId] });
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`
    ]);

    const res = await driveFetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
        { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    return res.json();
}

// A link nobody can open is not a share - but the grant is on this one file, it
// is read-only, and allowFileDiscovery keeps it out of Drive search and out of
// Google's index. The folder above it is never shared, so a link to one capture
// is never a door to the rest.
async function driveMakeLinkReadable(fileId) {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false })
    });
}

// Replacing the bytes of a file everyone already has a link to beats minting a
// second file: the link keeps working, and it shows what you just drew.
async function driveReplaceShared(fileId, blob) {
    const res = await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,webViewLink`,
        { method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    return res.json();
}

async function driveShareBlob(blob, name, interactive = true, replaceFileId = null, workspaceName = null) {
    const meta = await syncGetMeta();
    if (!meta.signedIn) throw new Error('Sign in to Google in Settings first');

    syncAllowPrompt = !!interactive;
    try {
        // Replacing a file updates it in whatever workspace it already lives in;
        // only a brand-new share needs to be filed into one.
        let file;
        let resolvedWorkspace = null;
        let recreated = false;
        if (replaceFileId) {
            try {
                file = await driveReplaceShared(replaceFileId, blob);
            } catch (err) {
                // Deleting in Drive only trashes a file, so a replace normally
                // still works. A 404 means it was purged for good (trash emptied)
                // - there is nothing left to update. Upload a fresh copy instead
                // of leaving the caller stuck retrying a file that cannot return.
                if (!/Drive API 404/.test(String((err && err.message) || err))) throw err;
                const ws = await driveWorkspaceFolderId(workspaceName);
                resolvedWorkspace = ws.name;
                file = await driveUploadShared(blob, name, ws.id);
                replaceFileId = null;   // a brand-new file: it needs the grant below
                recreated = true;       // and the caller must publish the new link
            }
        } else {
            const ws = await driveWorkspaceFolderId(workspaceName);
            resolvedWorkspace = ws.name;
            file = await driveUploadShared(blob, name, ws.id);
        }

        // A replaced file keeps the grant it already had.
        if (!replaceFileId) await driveMakeLinkReadable(file.id);

        return {
            id: file.id,
            url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
            workspace: resolvedWorkspace,
            recreated
        };
    } catch (err) {
        throw new Error(syncExplain(err));
    } finally {
        syncAllowPrompt = false;
    }
}

// Deleting a capture must revoke its link. Trashing alone does not reliably do
// it: a file sitting in the owner's trash can still answer a link it already
// granted. Take the grant away first - that kills the link the moment it lands -
// then trash the file, so the owner keeps thirty days to change their mind.
async function driveTrashFile(fileId) {
    const res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,type)`);
    const perms = (await res.json()).permissions || [];

    for (const p of perms.filter(p => p.type === 'anyone')) {
        await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${p.id}`,
            { method: 'DELETE' });
    }

    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
    });
}

// A workspace is never itself shared (only the files inside it are, one grant
// each), so there is no public permission to strip here - trashing is enough.
// Returns false rather than throwing when the folder is simply gone already.
async function driveTrashWorkspace(name) {
    const rootId = await driveShareFolderId();
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(
        `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${rootId}' in parents`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`);
    const found = (await res.json()).files || [];
    if (!found.length) return false;

    await driveFetch(`https://www.googleapis.com/drive/v3/files/${found[0].id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
    });
    return true;
}

// One wording for each failure, wherever it surfaces.
function syncExplain(err) {
    const code = String((err && err.message) || err);
    if (code === 'SESSION_EXPIRED') return 'Google session expired - press Sync Now to reconnect';
    if (code === 'SCOPE_DENIED') return 'Google Drive access was not granted. Sign out, sign in again, and tick every Google Drive permission.';
    return code;
}

const syncExportTarget = typeof globalThis !== 'undefined' ? globalThis : self;
syncExportTarget.CloudSync = {
    syncNow,
    syncSchedulePush,
    syncSignIn,
    syncSignOut,
    syncGetMeta,
    driveShareBlob,
    driveListWorkspaces,
    driveWorkspaceFolderId,
    driveTrashFile,
    driveTrashWorkspace
};
