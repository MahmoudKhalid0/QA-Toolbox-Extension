// Quick login switch (Snapshot & Swap). Save the current logged-in session
// (its cookies) under a name, then switch between saved logins in one click -
// no retyping credentials, and no reopening the popup (a right-click menu does
// it). Unlike the debugger isolation this is NOT simultaneous (one login at a
// time in the browser), but it's rock-solid and works with any cookie auth
// (Liferay AND ABP - restoring the auth cookie logs you straight back in).
//
// importScripted by background.js. Uses chrome.cookies + chrome.contextMenus.
(function (root) {
    'use strict';
    const STORE = 'qaLoginSnapshots'; // { [origin]: [ { id, name, cookies:[...], createdAt } ] }
    const ACTIVE = 'qaActiveLogin';   // { [origin]: snapshotId } - the login currently in use
    const MENU_ROOT = 'qaSwapRoot';

    const originOf = (url) => { try { return new URL(url).origin; } catch (e) { return null; } };
    const hostOf = (url) => { try { return new URL(url).hostname; } catch (e) { return ''; } };

    // Tell any open tabs on this origin to refresh their floating-button list.
    function notifyTabs(origin) {
        if (!origin || !chrome.tabs) return;
        chrome.tabs.query({ url: origin + '/*' }, (tabs) => {
            void chrome.runtime.lastError;
            (tabs || []).forEach((t) => chrome.tabs.sendMessage(t.id, { action: 'swapChanged' }, () => void chrome.runtime.lastError));
        });
    }

    function getStore() {
        return new Promise((resolve, reject) => chrome.storage.local.get([STORE], (r) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`Could not read saved logins: ${err.message || err}`));
            else resolve(r[STORE] || {});
        }));
    }
    function setStore(all) {
        return new Promise((resolve, reject) => chrome.storage.local.set({ [STORE]: all }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`Could not save logins: ${err.message || err}`));
            else resolve();
        }));
    }
    function getActive() {
        return new Promise((resolve, reject) => chrome.storage.local.get([ACTIVE], (r) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`Could not read the active login: ${err.message || err}`));
            else resolve(r[ACTIVE] || {});
        }));
    }
    const activeKey = (origin, storeId) => storeId == null ? origin : `${origin}::cookie-store::${storeId}`;
    const activeFor = (all, origin, storeId) => {
        const key = activeKey(origin, storeId);
        if (Object.prototype.hasOwnProperty.call(all, key)) return all[key];
        // Old builds stored one marker per origin and always read the regular
        // cookie store. Only migrate that ambiguous marker into Chrome's regular
        // store; never guess that it belongs to an incognito session.
        return storeId === '0' ? all[origin] : undefined;
    };
    let activeWriteQueue = Promise.resolve();
    function mutateActive(mutator) {
        const operation = activeWriteQueue.catch(() => undefined).then(async () => {
            const a = await getActive();
            if (mutator(a) === false) return;
            return new Promise((resolve, reject) => chrome.storage.local.set({ [ACTIVE]: a }, () => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(`Could not update the active login: ${err.message || err}`));
                else resolve();
            }));
        });
        activeWriteQueue = operation;
        return operation;
    }
    function setActive(origin, id, storeId) {
        return mutateActive((a) => {
            const key = activeKey(origin, storeId);
            if (id) a[key] = id; else delete a[key];
            if (storeId != null) delete a[origin]; // remove the old origin-only marker after migration
        });
    }

    function clearActiveSnapshot(origin, id) {
        return mutateActive((a) => {
            const prefix = `${origin}::cookie-store::`;
            let changed = false;
            for (const key of Object.keys(a)) {
                if ((key === origin || key.startsWith(prefix)) && a[key] === id) {
                    delete a[key];
                    changed = true;
                }
            }
            return changed;
        });
    }

    const cookieUrl = (c) => {
        const domain = c.domain.replace(/^\./, '');
        return (c.secure ? 'https://' : 'http://') + domain + (c.path || '/');
    };

    function cookieError(action) {
        const err = chrome.runtime.lastError;
        return err ? new Error(`${action}: ${err.message || err}`) : null;
    }

    const cookiePartitionKey = (c) => c && c.partitionKey ? c.partitionKey : null;

    function cookieKey(c) {
        return [
            c.name || '', (c.domain || '').replace(/^\./, '').toLowerCase(), c.path || '/',
            c.hostOnly ? 'host' : 'domain', JSON.stringify(cookiePartitionKey(c) || null)
        ].join('\u0000');
    }

    function getCookieStoreId(tabId) {
        if (tabId == null) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            chrome.cookies.getAllCookieStores((stores) => {
                const err = cookieError('Could not read cookie stores');
                if (err) return reject(err);
                const store = (stores || []).find((s) => (s.tabIds || []).includes(tabId));
                if (!store) return reject(new Error('Could not find the cookie store for this tab'));
                resolve(store.id);
            });
        });
    }

    function getCookies(details) {
        return new Promise((resolve, reject) => {
            chrome.cookies.getAll(details, (cookies) => {
                const err = cookieError('Could not read cookies');
                if (err) reject(err); else resolve(cookies || []);
            });
        });
    }

    async function getCookiesForTab(tab, urls) {
        if (!tab || !tab.url) throw new Error('No website tab was provided');
        const storeId = await getCookieStoreId(tab.id);
        const unique = new Map();
        for (const url of [...new Set((urls || [tab.url]).filter(Boolean))]) {
            const details = { url };
            if (storeId != null) details.storeId = storeId;
            for (const cookie of await getCookies(details)) unique.set(cookieKey(cookie), cookie);
        }
        return { cookies: [...unique.values()], storeId };
    }

    function setCookie(c, targetStoreId) {
        return new Promise((resolve, reject) => {
            const details = {
                url: cookieUrl(c),
                name: c.name, value: c.value,
                path: c.path, secure: c.secure, httpOnly: c.httpOnly,
                sameSite: c.sameSite,
            };
            if (targetStoreId != null) details.storeId = targetStoreId;
            else if (c.storeId != null) details.storeId = c.storeId;
            if (cookiePartitionKey(c)) details.partitionKey = cookiePartitionKey(c);
            if (!c.hostOnly) details.domain = c.domain;
            if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
            chrome.cookies.set(details, (created) => {
                const err = cookieError(`Could not restore cookie "${c.name}"`);
                if (err || !created) reject(err || new Error(`Could not restore cookie "${c.name}"`));
                else resolve(created);
            });
        });
    }

    function removeCookie(c, targetStoreId) {
        return new Promise((resolve, reject) => {
            const details = { url: cookieUrl(c), name: c.name };
            if (targetStoreId != null) details.storeId = targetStoreId;
            else if (c.storeId != null) details.storeId = c.storeId;
            if (cookiePartitionKey(c)) details.partitionKey = cookiePartitionKey(c);
            chrome.cookies.remove(details, (removed) => {
                const err = cookieError(`Could not remove cookie "${c.name}"`);
                if (err) reject(err); else resolve(removed || null);
            });
        });
    }

    // Read a tab's localStorage + sessionStorage. Many modern apps (ABP/OIDC
    // SPAs) keep the auth token here, NOT in a cookie - so a cookie-only swap
    // leaves the old token behind and the API returns "NotAuthorized". We must
    // capture and restore this too.
    async function readStorage(tabId) {
        const [r] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
                return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
            },
        });
        if (!r || !r.result) throw new Error('Could not read this page\'s login storage');
        return r.result;
    }

    async function writeStorage(tabId, storage) {
        if (!storage) return;
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            args: [storage],
            func: (data) => {
                window.localStorage.clear();
                window.sessionStorage.clear();
                if (data && data.local) for (const k in data.local) window.localStorage.setItem(k, data.local[k]);
                if (data && data.session) for (const k in data.session) window.sessionStorage.setItem(k, data.session[k]);
                return true;
            },
        });
        if (!results || !results[0] || results[0].result !== true) throw new Error('Could not restore this page\'s login storage');
    }

    const storageHasData = (storage) => !!storage && (
        Object.keys(storage.local || {}).length || Object.keys(storage.session || {}).length
    );

    const saveOperations = new Map();

    // ── save / list / delete ──
    async function saveCurrentOnce(tab, name, operationId) {
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return { ok: false, error: 'Open a website first' };
        const origin = originOf(tab.url);
        const all = await getStore();
        if (!all[origin]) all[origin] = [];
        const duplicate = operationId && all[origin].find((s) => s.operationId === operationId);
        if (duplicate) {
            await setActive(origin, duplicate.id, await getCookieStoreId(tab.id));
            return { ok: true, id: duplicate.id, duplicate: true };
        }

        const captured = await getCookiesForTab(tab);
        const cookies = captured.cookies;
        const storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        if (!cookies.length && !storageHasData(storage)) return { ok: false, error: 'No login data was found on this page' };
        const id = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        // Remember the exact page this login was saved on: it's on the right app
        // path AND is a page this user is allowed to see - the best place to land
        // when switching back (some apps live on a sub-path, not the site root).
        all[origin].push({
            id, name: name || `Login ${all[origin].length + 1}`, url: tab.url, cookies, storage,
            operationId: operationId || null,
            identity: extractIdentity(storage),   // WHO this login is - survives cookie rotation
            createdAt: Date.now(),
        });
        await setStore(all);
        await setActive(origin, id, captured.storeId);   // what we just saved IS the current login
        rebuildMenuFor(tab);
        notifyTabs(origin);
        return { ok: true, id };
    }

    function saveCurrent(tab, name, operationId) {
        if (!operationId) return saveCurrentOnce(tab, name, null).catch((e) => ({ ok: false, error: e.message || String(e) }));
        const operationKey = `${tab && tab.url ? originOf(tab.url) : ''}\u0000${operationId}`;
        if (saveOperations.has(operationKey)) return saveOperations.get(operationKey);
        const pending = saveCurrentOnce(tab, name, operationId)
            .catch((e) => ({ ok: false, error: e.message || String(e) }))
            .finally(() => saveOperations.delete(operationKey));
        saveOperations.set(operationKey, pending);
        return pending;
    }

    // ── WHO you are, not WHICH session token you hold ────────────────────────
    // The root of the "CURRENT keeps disappearing" bug: we were deciding who you
    // are from the VALUE of the session cookie. That value is not you - it is one
    // login. It changes when the server rotates a sliding session, and it changes
    // when you sign in again as the SAME person, and in both cases CURRENT wrongly
    // vanished. (Matching on the cookie merely EXISTING was worse: it then claimed
    // CURRENT for a completely different user.)
    //
    // The identity inside the auth token does not change. These apps (ABP/OIDC,
    // Liferay) keep a JWT in local/session storage; its payload names the user. So
    // we fingerprint the USER at save time and compare that instead.
    function extractIdentity(storage) {
        if (!storage) return null;
        const values = [];
        for (const bag of [storage.local, storage.session]) {
            if (!bag) continue;
            for (const k in bag) if (typeof bag[k] === 'string') values.push(bag[k]);
        }
        for (const v of values) {
            const m = v.match(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/);
            if (!m) continue;
            try {
                const body = m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
                const p = JSON.parse(atob(body + '==='.slice((body.length + 3) % 4)));
                const id = p.sub || p.preferred_username || p.email || p.unique_name
                    || p.upn || p.user_id || p.uid || p.nameid || p.name;
                if (id) return String(id);
            } catch (e) { /* not a JWT we can read - keep looking */ }
        }
        return null;
    }

    // Fallback for sites with no token at all (pure cookie auth): we cannot tell WHO,
    // only WHETHER a session exists. Existence, not value - so a rotated cookie no
    // longer wipes CURRENT. (`qaActiveLogin` is only ever set BY US, on save/update/
    // restore, so it already points at the right snapshot.)
    async function sessionAlive(snapCookies, storeId) {
        if (!snapCookies || !snapCookies.length) return false;
        const auth = snapCookies.filter((c) => c.httpOnly);
        const check = auth.length ? auth : snapCookies;
        for (const c of check) {
            const live = await new Promise((res) => {
                const details = { url: cookieUrl(c), name: c.name };
                if (storeId != null) details.storeId = storeId;
                if (cookiePartitionKey(c)) details.partitionKey = cookiePartitionKey(c);
                chrome.cookies.get(details, (r) => { void chrome.runtime.lastError; res(r); });
            });
            if (!live || !live.value) return false;      // logged out
        }
        return true;
    }

    // `tabId` lets us read the LIVE storage and work out who is signed in right now.
    async function listFor(url, tabId) {
        const origin = originOf(url);
        const all = await getStore();
        const snaps = all[origin] || [];
        let storeId = null;
        try { storeId = await getCookieStoreId(tabId); } catch (e) { storeId = null; }
        const activeMap = await getActive();
        const storeKey = activeKey(origin, storeId);
        const hasStoreMarker = Object.prototype.hasOwnProperty.call(activeMap, storeKey);
        const storedActive = activeFor(activeMap, origin, storeId);
        let active = storedActive;
        let activeConfidence = null;

        let liveId = null;
        if (tabId != null) {
            try { liveId = extractIdentity(await readStorage(tabId)); }
            catch (e) { liveId = null; } // cookie-only pages can still be listed safely
        }

        if (liveId) {
            // We know WHO is signed in. The snapshot for that person is CURRENT -
            // whatever the cookie value happens to be right now.
            const match = snaps.find((s) => s.identity && s.identity === liveId);
            active = match ? match.id : null;
            activeConfidence = match ? 'verified' : null;
        } else {
            const snap = snaps.find((s) => s.id === active);
            if (!snap) {
                active = null;
            } else if (snap.identity) {
                // This login is token-based and the page now holds NO token: you are
                // signed out. Deliberately NOT falling back to the cookie here - a
                // stray request (even a favicon fetch) can hand you a fresh session
                // cookie while you are logged out, and that used to keep CURRENT lit.
                active = null;
            } else if (!(await sessionAlive(snap.cookies, storeId))) {
                active = null;      // pure cookie-auth site, and the cookie is gone
            } else activeConfidence = 'assumed';
        }
        if (active !== storedActive || (storeId != null && !hasStoreMarker)) await setActive(origin, active, storeId);

        return snaps.map((s) => ({
            id: s.id, name: s.name, count: s.cookies.length, createdAt: s.createdAt,
            active: s.id === active, activeConfidence: s.id === active ? activeConfidence : null
        }));
    }

    async function remove(url, id) {
        const origin = originOf(url);
        const all = await getStore();
        let removed = false;
        if (all[origin]) {
            const before = all[origin].length;
            all[origin] = all[origin].filter((s) => s.id !== id);
            removed = all[origin].length !== before;
            if (!all[origin].length) delete all[origin];
            if (removed) await setStore(all);
        }
        if (!removed) return { ok: false, error: 'saved login not found' };
        await clearActiveSnapshot(origin, id);   // delete this marker from regular and incognito stores
        // Rebuild the context menu on the current tab, and refresh open FABs.
        if (chrome.tabs) chrome.tabs.query({ active: true, currentWindow: true }, (t) => { if (t && t[0]) rebuildMenuFor(t[0]); });
        notifyTabs(origin);
        return { ok: true };
    }

    // Re-capture the session you're logged in as RIGHT NOW into an existing
    // saved login (same name, same landing page). Server sessions expire - after
    // a reboot or a timeout the saved cookies are dead, so you log in once and
    // refresh the slot instead of deleting and re-adding it.
    async function updateSnapshot(tab, id) {
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return { ok: false, error: 'Open a website first' };
        const origin = originOf(tab.url);
        const all = await getStore();
        const snap = (all[origin] || []).find((s) => s.id === id);
        if (!snap) return { ok: false, error: 'saved login not found' };
        const captured = await getCookiesForTab(tab);
        snap.cookies = captured.cookies;
        snap.storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        if (!snap.cookies.length && !storageHasData(snap.storage)) return { ok: false, error: 'No login data was found on this page' };
        snap.identity = extractIdentity(snap.storage);
        snap.url = tab.url;              // also refreshes the landing page
        snap.createdAt = Date.now();
        await setStore(all);
        await setActive(origin, id, captured.storeId);     // you ARE this login now
        rebuildMenuFor(tab);
        notifyTabs(origin);
        return { ok: true, name: snap.name };
    }

    async function rename(url, id, name) {
        const origin = originOf(url);
        const all = await getStore();
        const s = (all[origin] || []).find((x) => x.id === id);
        if (!s) return { ok: false, error: 'saved login not found' };
        s.name = name;
        await setStore(all);
        return { ok: true };
    }

    // ── the swap ──
    async function restore(tab, id) {
        if (!tab || !tab.url) return { ok: false, error: 'no tab' };
        const origin = originOf(tab.url);
        const all = await getStore();
        const snap = (all[origin] || []).find((s) => s.id === id);
        if (!snap) return { ok: false, error: 'snapshot not found' };
        const dest = snap.url || (origin + '/');
        const captured = await getCookiesForTab(tab, [tab.url, dest]);
        const current = captured.cookies;
        const targetStoreId = captured.storeId;
        const previousActive = activeFor(await getActive(), origin, targetStoreId) || null;
        const currentStorage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };

        const rollback = async () => {
            const partial = await getCookiesForTab(tab, [tab.url, dest]);
            for (const c of partial.cookies) await removeCookie(c, targetStoreId);
            for (const c of current) await setCookie(c, targetStoreId);
            if (tab.id != null) await writeStorage(tab.id, currentStorage);
        };

        // Treat the swap as a transaction. If any cookie/storage write fails,
        // restore the login that was active before this attempt instead of
        // leaving a half-old, half-new session while reporting success.
        try {
            for (const c of current) await removeCookie(c, targetStoreId);
            for (const c of snap.cookies || []) await setCookie(c, targetStoreId);
            if (tab.id != null) await writeStorage(tab.id, snap.storage);

            const live = await getCookiesForTab(tab, [dest]);
            const liveByKey = new Map(live.cookies.map((c) => [cookieKey(c), c]));
            for (const expected of snap.cookies || []) {
                const actual = liveByKey.get(cookieKey(expected));
                if (!actual || actual.value !== expected.value) throw new Error(`Cookie verification failed for "${expected.name}"`);
            }
        } catch (error) {
            let rollbackError = null;
            try {
                await rollback();
                await setActive(origin, previousActive, targetStoreId);
            } catch (rollbackFailure) { rollbackError = rollbackFailure; }
            return {
                ok: false,
                error: (error.message || String(error)) + (rollbackError
                    ? '; rollback also failed: ' + (rollbackError.message || rollbackError)
                    : '; previous login restored')
            };
        }
        try {
            await setActive(origin, id, targetStoreId);
        } catch (error) {
            let rollbackError = null;
            try {
                await rollback();
                await setActive(origin, previousActive, targetStoreId);
            } catch (rollbackFailure) { rollbackError = rollbackFailure; }
            return {
                ok: false,
                error: (error.message || String(error)) + (rollbackError
                    ? '; rollback also failed: ' + (rollbackError.message || rollbackError)
                    : '; previous login restored')
            };
        }
        // Land on the page THIS login was saved on, not the current URL: the
        // current page may be a permission-gated deep link the switched-to user
        // can't view ("NotAuthorized"), and the site root may be a different app
        // (apps often live on a sub-path like /en/web/mof, not the root). The
        // saved page is on the right path AND was allowed for this user. Older
        // snapshots without a url fall back to the site root.
        // Navigate, and REPORT whether it actually happened. A bad saved url (an
        // old snapshot pointing at a page that no longer resolves, a non-http
        // scheme, etc.) used to make tabs.update fail silently - the popup showed
        // "Switching…" forever and nothing moved. Now we check, fall back to the
        // site root, and only claim success once a navigation is under way.
        if (tab.id != null) {
            const navd = await new Promise((res) => {
                chrome.tabs.update(tab.id, { url: dest }, () => {
                    if (!chrome.runtime.lastError) return res(true);
                    // dest was unusable - try the site root instead.
                    chrome.tabs.update(tab.id, { url: origin + '/' }, () => res(!chrome.runtime.lastError));
                });
            });
            if (!navd) {
                try {
                    await rollback();
                    await setActive(origin, previousActive, targetStoreId);
                    return { ok: false, error: 'could not navigate the tab; previous login restored' };
                } catch (rollbackFailure) {
                    return { ok: false, error: 'could not navigate the tab; rollback also failed: ' + (rollbackFailure.message || rollbackFailure) };
                }
            }
        }
        notifyTabs(origin);
        return { ok: true };
    }

    // ── right-click menu (switch without opening the popup) ──
    let menuBuildGeneration = 0;
    let menuBuildQueue = Promise.resolve();

    function removeMenuItem(id) {
        return new Promise((resolve) => chrome.contextMenus.remove(id, () => {
            void chrome.runtime.lastError; // missing items are expected on startup
            resolve();
        }));
    }

    async function clearSwapMenus() {
        const all = await getStore();
        const ids = new Set(['swapSaveNow', 'swapSep']);
        Object.values(all).forEach((snaps) => (snaps || []).forEach((s) => ids.add('swap:' + s.id)));
        for (const id of ids) await removeMenuItem(id);
        await removeMenuItem(MENU_ROOT); // removes any stale children left by deleted snapshots
    }

    async function rebuildMenuForNow(tab, generation) {
        if (!chrome.contextMenus || generation !== menuBuildGeneration) return;
        await clearSwapMenus();
        if (generation !== menuBuildGeneration) return;
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;

        const snaps = await listFor(tab.url, tab.id);
        if (generation !== menuBuildGeneration) return;
        chrome.contextMenus.create({ id: MENU_ROOT, title: `Switch login (${hostOf(tab.url)})`, contexts: ['page'] }, () => void chrome.runtime.lastError);
        for (const s of snaps) {
            chrome.contextMenus.create({ id: 'swap:' + s.id, parentId: MENU_ROOT, title: '↪ ' + s.name, contexts: ['page'] }, () => void chrome.runtime.lastError);
        }
        if (snaps.length) chrome.contextMenus.create({ id: 'swapSep', parentId: MENU_ROOT, type: 'separator', contexts: ['page'] }, () => void chrome.runtime.lastError);
        chrome.contextMenus.create({ id: 'swapSaveNow', parentId: MENU_ROOT, title: '💾 Save current login…', contexts: ['page'] }, () => void chrome.runtime.lastError);
    }

    function rebuildMenuFor(tab) {
        const generation = ++menuBuildGeneration;
        menuBuildQueue = menuBuildQueue
            .catch(() => undefined)
            .then(() => rebuildMenuForNow(tab, generation))
            .catch((error) => console.warn('Could not rebuild session menus:', error));
        return menuBuildQueue;
    }

    if (chrome.contextMenus) {
        chrome.contextMenus.onClicked.addListener(async (info, tab) => {
            if (!tab) return;
            if (info.menuItemId === 'swapSaveNow') {
                // Name via a styled in-page dialog (the popup isn't open here).
                let name;
                try {
                    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: swapNameDialog });
                    name = r && r.result;   // string, or null on cancel
                } catch (e) { name = undefined; /* injection blocked (e.g. chrome:// page) */ }
                if (name === null) return;          // user cancelled
                await saveCurrent(tab, (name || '').trim() || undefined);
            } else if (String(info.menuItemId).startsWith('swap:')) {
                await restore(tab, String(info.menuItemId).slice(5));
            }
        });
        // Keep the menu showing the CURRENT site's saved logins.
        chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId, (t) => { void chrome.runtime.lastError; if (t) rebuildMenuFor(t); }));
        chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' || info.url) rebuildMenuFor(tab); });
    }

    // Injected into the page for "Save current login…" from the right-click
    // menu. Self-contained (no closure refs) - it must serialize. Returns a
    // Promise<string|null> that executeScript awaits: the name, or null.
    function swapNameDialog() {
        return new Promise((resolve) => {
            const done = (val) => { try { document.removeEventListener('keydown', onKey, true); } catch (e) {} ov.remove(); resolve(val); };
            const ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.66);backdrop-filter:blur(2px);font-family:-apple-system,Segoe UI,Roboto,sans-serif;direction:ltr;';
            const box = document.createElement('div');
            box.style.cssText = 'width:320px;max-width:86vw;background:#131a2b;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.55);';
            box.innerHTML =
                '<div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;color:#fff;margin-bottom:15px;">' +
                '<span style="width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:15px;">💾</span>' +
                'Save this login as</div>' +
                '<input id="__qaSwapIn" type="text" placeholder="e.g. Admin" autocomplete="off" ' +
                'style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#fff;padding:12px;font-size:14px;outline:none;margin-bottom:18px;">' +
                '<div style="display:flex;gap:9px;justify-content:flex-end;">' +
                '<button id="__qaSwapCancel" style="border:none;border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;background:rgba(255,255,255,.1);color:#cbd5e1;">Cancel</button>' +
                '<button id="__qaSwapOk" style="border:none;border-radius:10px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#10b981,#059669);color:#fff;">Save</button>' +
                '</div>';
            ov.appendChild(box);
            document.documentElement.appendChild(ov);
            const input = box.querySelector('#__qaSwapIn');
            const ok = () => done((input.value || '').trim() || null);
            const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.preventDefault(); done(null); } };
            box.querySelector('#__qaSwapOk').addEventListener('click', ok);
            box.querySelector('#__qaSwapCancel').addEventListener('click', () => done(null));
            ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
            document.addEventListener('keydown', onKey, true);
            setTimeout(() => input.focus(), 30);
        });
    }

    root.SessionSwap = { saveCurrent, listFor, remove, rename, restore, updateSnapshot, rebuildMenuFor };
})(typeof self !== 'undefined' ? self : globalThis);
