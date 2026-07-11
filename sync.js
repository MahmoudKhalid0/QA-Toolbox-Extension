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

async function syncCollectLocalData() {
    let profiles = [];
    try { profiles = await FormFillerDB.getAllProfiles(); } catch (e) { }
    const syncStore = await chrome.storage.sync.get(['formFillerSettings', 'formFillerCategories', 'formFillerCategoriesUpdatedAt', 'delaySeconds']);
    const localStore = await chrome.storage.local.get(['aiSaveBehavior', 'syncTombstones', 'qaClearData', 'qaResponsive', 'qaBugTracker', 'capEyeEnabled']);
    return {
        version: 1,
        exportedAt: Date.now(),
        profiles,
        tombstones: localStore.syncTombstones || {},
        settings: syncStore.formFillerSettings || null,
        categories: syncStore.formFillerCategories || null,
        categoriesUpdatedAt: syncStore.formFillerCategoriesUpdatedAt || 0,
        aiSaveBehavior: localStore.aiSaveBehavior || null,
        qaClearData: localStore.qaClearData || null,
        qaResponsive: localStore.qaResponsive || null,
        // Jira / Azure credentials and project choices. They live in the app's
        // own private Drive folder, which nothing but this extension can read.
        qaBugTracker: localStore.qaBugTracker || null,
        capEyeEnabled: localStore.capEyeEnabled,
        delaySeconds: syncStore.delaySeconds
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

        // Settings / AI behavior / tool prefs: local wins when present, cloud fills the gaps
        const settings = local.settings || (cloud && cloud.settings) || null;
        const aiSaveBehavior = local.aiSaveBehavior || (cloud && cloud.aiSaveBehavior) || null;
        const qaClearData = local.qaClearData || (cloud && cloud.qaClearData) || null;
        const qaResponsive = local.qaResponsive || (cloud && cloud.qaResponsive) || null;
        const qaBugTracker = local.qaBugTracker || (cloud && cloud.qaBugTracker) || null;
        const capEyeEnabled = syncPick(local.capEyeEnabled, cloud && cloud.capEyeEnabled);
        const delaySeconds = syncPick(local.delaySeconds, cloud && cloud.delaySeconds);

        // Apply merged state locally
        await FormFillerDB.saveAllProfiles(merged);
        await chrome.storage.local.set({ syncTombstones: tombstones });
        if (categories) await chrome.storage.sync.set({ formFillerCategories: categories, formFillerCategoriesUpdatedAt: categoriesUpdatedAt });
        if (settings) await chrome.storage.sync.set({ formFillerSettings: settings });
        if (aiSaveBehavior) await chrome.storage.local.set({ aiSaveBehavior });
        if (qaClearData) await chrome.storage.local.set({ qaClearData });
        if (qaResponsive) await chrome.storage.local.set({ qaResponsive });
        // Writing an identical value still fires storage.onChanged everywhere.
        if (qaBugTracker && JSON.stringify(qaBugTracker) !== JSON.stringify(local.qaBugTracker)) {
            await chrome.storage.local.set({ qaBugTracker });
        }
        if (capEyeEnabled !== null) await chrome.storage.local.set({ capEyeEnabled });
        if (delaySeconds !== null) await chrome.storage.sync.set({ delaySeconds });

        // Push the merged result back to Drive
        await driveUpload(fileId, {
            version: 1,
            exportedAt: Date.now(),
            profiles: merged,
            tombstones,
            settings,
            categories,
            categoriesUpdatedAt,
            aiSaveBehavior,
            qaClearData,
            qaResponsive,
            qaBugTracker,
            capEyeEnabled,
            delaySeconds
        });

        await syncSetMeta({ lastSyncAt: Date.now(), lastError: null });

        // Tell open extension pages to re-render with the merged data
        // (defined in background.js; skipCloudPush=true - we just synced)
        if (typeof broadcastProfilesUpdated === 'function') broadcastProfilesUpdated(true);
        syncBroadcastState('done');

        return { success: true, profileCount: merged.length };
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
    await syncSetMeta({ signedIn: false, email: '', lastError: null });
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
        if (replaceFileId) {
            file = await driveReplaceShared(replaceFileId, blob);
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
            workspace: resolvedWorkspace
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
