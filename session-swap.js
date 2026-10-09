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
    // { [snapshotId]: { username, password, loginUrl } } - the fallback for when a saved
    // session has died on the server. Kept OUT of the snapshot store, and NOT in sync.js's
    // key list, so passwords never leave this browser profile.
    const CREDS = 'qaLoginCreds';
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

    // `hosts` = extra hosts whose cookies belong to this login as a WHOLE (the SSO
    // server - see ssoHostsOf). Read by domain, not URL: an IdP scopes its cookies to
    // paths like /realms/x/, which a URL lookup would miss.
    async function getCookiesForTab(tab, urls, hosts) {
        if (!tab || !tab.url) throw new Error('No website tab was provided');
        const storeId = await getCookieStoreId(tab.id);
        const unique = new Map();
        const queries = [...new Set((urls || [tab.url]).filter(Boolean))].map((url) => ({ url }))
            .concat([...new Set(hosts || [])].map((domain) => ({ domain })));
        for (const details of queries) {
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

        const storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        const ssoHosts = ssoHostsOf(storage, tab.url);
        const captured = await getCookiesForTab(tab, null, ssoHosts);
        const cookies = captured.cookies;
        if (!cookies.length && !storageHasData(storage)) return { ok: false, error: 'No login data was found on this page' };
        const id = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        // Remember the exact page this login was saved on: it's on the right app
        // path AND is a page this user is allowed to see - the best place to land
        // when switching back (some apps live on a sub-path, not the site root).
        all[origin].push({
            id, name: name || `Login ${all[origin].length + 1}`, url: tab.url, cookies, storage,
            operationId: operationId || null,
            identity: extractIdentity(storage),   // WHO this login is - survives cookie rotation
            displayName: extractDisplayName(storage),
            ssoHosts,
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
    // Every readable JWT payload in the page's storage.
    function jwtPayloads(storage) {
        const out = [];
        if (!storage) return out;
        for (const bag of [storage.local, storage.session]) {
            if (!bag) continue;
            for (const k in bag) {
                if (typeof bag[k] !== 'string') continue;
                const m = bag[k].match(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/);
                if (!m) continue;
                try {
                    const body = m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
                    out.push(JSON.parse(atob(body + '==='.slice((body.length + 3) % 4))));
                } catch (e) { /* not a JWT we can read - keep looking */ }
            }
        }
        return out;
    }

    function extractIdentity(storage) {
        for (const p of jwtPayloads(storage)) {
            const id = p.sub || p.preferred_username || p.email || p.unique_name
                || p.upn || p.user_id || p.uid || p.nameid || p.name;
            if (id) return String(id);
        }
        return null;
    }

    // A human label for the card (an email/username beats an opaque `sub` GUID).
    function extractDisplayName(storage) {
        for (const p of jwtPayloads(storage)) {
            const n = p.email || p.preferred_username || p.upn || p.unique_name || p.name;
            if (n) return String(n);
        }
        return null;
    }

    // The SSO server this login came from. Its cookies live on ANOTHER host (Keycloak,
    // Azure AD, IdentityServer…), so saving only the app's cookies left the IdP still
    // signed in as whoever logged in last - and "Switch" silently brought that user
    // back. The token's `iss` claim names the IdP, so we save/swap its cookies too.
    // Public IdPs are skipped: their cookies are YOUR own Microsoft/Google sign-in for
    // the whole browser, and swapping them would log you out of Outlook/Gmail. A wrong
    // user there is still caught - by the check after the switch (verifySwitch).
    const SHARED_IDP = /(^|\.)(microsoftonline\.com|windows\.net|live\.com|microsoft\.com|google\.com|googleapis\.com|apple\.com|facebook\.com)$/i;
    function ssoHostsOf(storage, appUrl) {
        const appHost = hostOf(appUrl);
        const hosts = new Set();
        for (const p of jwtPayloads(storage)) {
            const h = p.iss ? hostOf(String(p.iss)) : '';
            if (h && h !== appHost && !SHARED_IDP.test(h)) hosts.add(h);
        }
        return [...hosts];
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
        // Nothing saved for this site (most pages): skip injecting a storage reader.
        // This runs on every page load (floating button + right-click menu).
        if (!snaps.length) return [];
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
        const creds = await getCreds();

        return snaps.map((s) => ({
            id: s.id, name: s.name, count: s.cookies.length, createdAt: s.createdAt,
            user: s.displayName || null, problem: s.problem || null, hasCreds: !!creds[s.id],
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
        await setCreds(id, null);                // its username/password go with it
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
    async function updateSnapshot(tab, id, opts = {}) {
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return { ok: false, error: 'Open a website first' };
        const origin = originOf(tab.url);
        const all = await getStore();
        const snap = (all[origin] || []).find((s) => s.id === id);
        if (!snap) return { ok: false, error: 'saved login not found' };
        const storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        const ssoHosts = ssoHostsOf(storage, tab.url);
        const captured = await getCookiesForTab(tab, null, ssoHosts);
        if (!captured.cookies.length && !storageHasData(storage)) return { ok: false, error: 'No login data was found on this page' };
        snap.cookies = captured.cookies;
        snap.storage = storage;
        snap.ssoHosts = ssoHosts;
        snap.identity = extractIdentity(storage);
        snap.displayName = extractDisplayName(storage);
        delete snap.problem;             // fresh session - clear any "expired" flag
        if (!opts.keepUrl) snap.url = tab.url;   // also refreshes the landing page (not after an auto re-login)
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
        const sso = snap.ssoHosts || [];
        const captured = await getCookiesForTab(tab, [tab.url, dest], sso);
        const current = captured.cookies;
        const targetStoreId = captured.storeId;
        const previousActive = activeFor(await getActive(), origin, targetStoreId) || null;
        const currentStorage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };

        const rollback = async () => {
            const partial = await getCookiesForTab(tab, [tab.url, dest], sso);
            for (const c of partial.cookies) await removeCookie(c, targetStoreId);
            for (const c of current) await setCookie(c, targetStoreId);
            if (tab.id != null) await writeStorage(tab.id, currentStorage);
        };

        // Treat the swap as a transaction. If any cookie/storage write fails,
        // restore the login that was active before this attempt instead of
        // leaving a half-old, half-new session while reporting success.
        // A saved cookie whose expiry date has PASSED can't be restored - Chrome silently
        // refuses it (cookies.set returns null, no error), and the browser would have
        // dropped it anyway. That used to fail the whole switch ("Could not restore cookie
        // osVisit") for an old snapshot; skip it instead.
        const nowSec = Date.now() / 1000;
        const restorable = (snap.cookies || []).filter((c) => c.session || !c.expirationDate || c.expirationDate > nowSec + 5);
        try {
            for (const c of current) await removeCookie(c, targetStoreId);
            for (const c of restorable) await setCookie(c, targetStoreId);
            if (tab.id != null) await writeStorage(tab.id, snap.storage);

            const live = await getCookiesForTab(tab, [dest], sso);
            const liveByKey = new Map(live.cookies.map((c) => [cookieKey(c), c]));
            for (const expected of restorable) {
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
                    : '; nothing was changed - the page is as it was')
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
                    : '; nothing was changed - the page is as it was')
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
        // Listen BEFORE navigating - a fast page can finish loading before we'd attach.
        const loaded = tab.id != null ? waitForLoad(tab.id, 20000) : Promise.resolve(false);
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
                    return { ok: false, error: 'could not navigate the tab; nothing was changed - the page is as it was' };
                } catch (rollbackFailure) {
                    return { ok: false, error: 'could not navigate the tab; rollback also failed: ' + (rollbackFailure.message || rollbackFailure) };
                }
            }
        }
        // Writing the cookies back is not proof the SERVER still accepts them. An expired
        // session used to report "Switched" and land you on the login page. Check what
        // actually loaded, and say so on the card + the page.
        let problem = tab.id != null ? await verifySwitch(tab.id, snap, dest, targetStoreId, loaded) : null;
        // Dead session + saved username/password: log in for real, re-save, carry on.
        let reloginError = null;
        if (problem && (await getCreds())[id]) {
            const r = await autoLogin(tab, id);
            if (r.ok) { notifyTabs(origin); return { ok: true, relogged: true }; }
            reloginError = r.error;
        }
        await setProblem(origin, id, problem);
        notifyTabs(origin);
        if (problem) {
            chrome.tabs.sendMessage(tab.id, { action: 'swapProblem', name: snap.name, problem, reloginError }, () => void chrome.runtime.lastError);
            return { ok: true, problem, reloginError };
        }
        return { ok: true };
    }

    // Resolve when the tab finishes loading (or after `ms`, whichever comes first).
    function waitForLoad(tabId, ms) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); resolve(v); };
            const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
            const t = setTimeout(() => finish(false), ms);
            chrome.tabs.onUpdated.addListener(onUpd);
        });
    }

    // null = the switch really worked; otherwise 'expired' or 'other-user'.
    async function verifySwitch(tabId, snap, dest, storeId, loaded) {
        if (!(await loaded)) return null;                      // still loading - can't judge, don't cry wolf
        await new Promise((r) => setTimeout(r, 1500));         // SPAs write their token after load
        if (snap.identity) {
            let liveId = null;
            try { liveId = extractIdentity(await readStorage(tabId)); } catch (e) { return null; }
            if (liveId === snap.identity) return null;
            return liveId ? 'other-user' : 'expired';
        }
        // Cookie-only site: the server deleting our cookie, or bouncing us to a login
        // page we weren't sent to, both mean the saved session is dead.
        if (!(await sessionAlive(snap.cookies, storeId))) return 'expired';
        // A site that shows its login form in place (no redirect) - a password box on
        // the page we were sent to means we are not signed in.
        const probe = await probePage(tabId);
        if (probe && probe.password) return 'expired';
        const t = await new Promise((r) => chrome.tabs.get(tabId, (x) => { void chrome.runtime.lastError; r(x); }));
        const LOGIN = /(log-?in|sign-?in|logon|\/auth\b|\/sso\b|\/account\/login)/i;
        let landed = '', meant = '';
        try { landed = new URL(t.url).pathname; meant = new URL(dest).pathname; } catch (e) { return null; }
        return LOGIN.test(landed) && !LOGIN.test(meant) ? 'expired' : null;
    }

    async function setProblem(origin, id, problem) {
        const all = await getStore();
        const s = (all[origin] || []).find((x) => x.id === id);
        if (!s || (s.problem || null) === (problem || null)) return;
        if (problem) s.problem = problem; else delete s.problem;
        await setStore(all);
    }

    // ── saved username/password + automatic re-login ──
    function getCreds() {
        return new Promise((resolve) => chrome.storage.local.get([CREDS], (r) => { void chrome.runtime.lastError; resolve((r && r[CREDS]) || {}); }));
    }
    async function setCreds(id, creds) {
        const all = await getCreds();
        if (creds) all[id] = creds; else delete all[id];
        await new Promise((resolve, reject) => chrome.storage.local.set({ [CREDS]: all }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`Could not save the login details: ${err.message || err}`)); else resolve();
        }));
        return { ok: true };
    }
    // What the dialog may show: never the password itself.
    async function credsInfo(id) {
        const c = (await getCreds())[id];
        return c ? { username: c.username, loginUrl: c.loginUrl, hasPassword: !!c.password } : null;
    }
    // Save from the dialog. An empty password keeps the one already saved.
    async function saveCreds(id, { username, password, loginUrl }) {
        if (!/^https?:\/\//i.test(loginUrl || '')) return { ok: false, error: 'Login page must be a http(s) address' };
        const old = (await getCreds())[id];
        const pass = password || (old && old.password);
        if (!username || !pass) return { ok: false, error: 'Username and password are required' };
        return setCreds(id, { username, password: pass, loginUrl });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // executeScript can stay pending FOREVER when the page navigates away under a
    // running async script (the two-step login's "Next") - cap every page call.
    const capped = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('page did not answer'); })]);
    const getTab = (tabId) => new Promise((r) => chrome.tabs.get(tabId, (t) => { void chrome.runtime.lastError; r(t || null); }));
    const navigate = (tabId, url) => new Promise((r) => chrome.tabs.update(tabId, { url }, () => r(!chrome.runtime.lastError)));

    // One look at the page: is a password box showing (and is it empty), plus its
    // storage so we can read WHO is signed in. null while the page is mid-navigation.
    async function probePage(tabId) {
        try {
            const [r] = await capped(chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const vis = (el) => { const b = el.getBoundingClientRect(), cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden'; };
                    const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
                    // Step 1 of a two-step login has NO password box yet: a username/email
                    // field in a form whose button reads Next/Sign in. (Named fields only, so
                    // a site's search box does not count.)
                    const userOnly = !pw && [...document.querySelectorAll('form input:not([type=hidden])')].filter(vis).some((i) => {
                        const named = i.type === 'email' || /username|email|login|account|user/i.test([i.name, i.id, i.autocomplete, i.placeholder].join(' '));
                        const btn = [...i.form.querySelectorAll('button, input[type=submit]')].some((b) => vis(b) && /next|continue|log ?in|sign ?in|التالي|متابعة|دخول/i.test(b.innerText || b.value || ''));
                        return named && btn;
                    });
                    const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
                    return { password: !!pw || userOnly, passwordEmpty: !!pw && !pw.value, storage: { local: dump(localStorage), session: dump(sessionStorage) } };
                },
            }), 5000);
            return (r && r.result) || null;
        } catch (e) { return null; }
    }

    // Injected into the login page. Self-contained (it is serialized). Finds the
    // username + password boxes, types into them the way React/Angular notice (native
    // value setter + input/change events), and presses the form's submit. Handles the
    // two-step "username → Next → password" form when it happens on the same page.
    // Resolves { ok, step:'both'|'user' } or { ok:false, error }.
    function autoLoginInPage(user, pass) {
        const vis = (el) => {
            if (!el || el.disabled || el.readOnly) return false;
            const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
            return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        };
        const setVal = (el, v) => {
            el.focus();
            const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (d && d.set) d.set.call(el, v); else el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const find = () => {
            const pw = [...document.querySelectorAll('input[type=password]')].find(vis) || null;
            const texts = [...document.querySelectorAll('input:not([type]), input[type=text], input[type=email], input[type=tel]')].filter(vis);
            let userEl = null;
            if (pw) {
                // the username box is the last text box BEFORE the password box
                const before = texts.filter((t) => t.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
                userEl = before[before.length - 1] || null;
            } else {
                userEl = texts.find((t) => /user|mail|login|account|name|id/i.test([t.name, t.id, t.autocomplete, t.placeholder].join(' ')))
                    || (texts.length === 1 ? texts[0] : null);
            }
            return { pw, userEl };
        };
        const LABEL = /log ?in|sign ?in|next|continue|submit|دخول|تسجيل|التالي|متابعة/i;
        const submitBtn = (from) => {
            const form = from && from.form;
            const cands = [...(form || document).querySelectorAll('button, input[type=submit], [role=button]')].filter(vis);
            const byText = cands.find((b) => LABEL.test(b.innerText || b.value || b.getAttribute('aria-label') || ''));
            const bySubmit = cands.find((b) => b.type === 'submit');
            // Inside a form its submit button is the answer; on a form-less page a random
            // header button is "submit" too, so trust the label first there.
            return form ? (bySubmit || byText) : (byText || bySubmit);
        };
        const press = (btn, anchor) => {
            if (btn) return btn.click();
            if (anchor && anchor.form) return anchor.form.requestSubmit ? anchor.form.requestSubmit() : anchor.form.submit();
            if (anchor) anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        };
        const wait = (fn, ms) => new Promise((res) => {
            const t0 = Date.now();
            (function loop() { const v = fn(); if (v || Date.now() - t0 > ms) return res(v || null); setTimeout(loop, 200); })();
        });
        return (async () => {
            let f = await wait(() => { const x = find(); return (x.pw || x.userEl) ? x : null; }, 10000);
            if (!f) return { ok: false, error: 'No login form was found on the login page' };
            if (!f.pw) {
                // Step 1 of a two-step form: username, then Next. Reply BEFORE pressing it -
                // Next may navigate, which would leave this script's reply hanging. The
                // caller waits for the password box (same page or new) and runs us again.
                const next = submitBtn(f.userEl), field = f.userEl;
                setVal(field, user);
                setTimeout(() => press(next, field), 60);
                return { ok: true, step: 'user' };
            }
            if (f.userEl) setVal(f.userEl, user);
            setVal(f.pw, pass);
            const btn = submitBtn(f.pw);
            setTimeout(() => press(btn, f.pw), 60);              // reply first, then submit (it may navigate)
            return { ok: true, step: 'both' };
        })();
    }

    // Log in from scratch with the saved username/password, then re-save the snapshot
    // from that fresh session. The site's dead cookies/storage are cleared first, so it
    // shows its login form even when it would never redirect there by itself.
    async function autoLogin(tab, id) {
        const creds = (await getCreds())[id];
        if (!creds) return { ok: false, error: 'No username/password saved for this login' };
        if (!tab || tab.id == null) return { ok: false, error: 'no tab' };
        const origin = originOf(tab.url);
        const snap = ((await getStore())[origin] || []).find((s) => s.id === id);
        if (!snap) return { ok: false, error: 'saved login not found' };

        const dead = await getCookiesForTab(tab, [tab.url, creds.loginUrl, snap.url], snap.ssoHosts);
        for (const c of dead.cookies) { try { await removeCookie(c, dead.storeId); } catch (e) { } }
        try { await writeStorage(tab.id, { local: {}, session: {} }); } catch (e) { }

        const loaded = waitForLoad(tab.id, 20000);
        if (!(await navigate(tab.id, creds.loginUrl))) return { ok: false, error: 'Could not open the login page' };
        await loaded;

        // Cookie-only site: signed in = the password box is gone AND the server handed us
        // new cookies since we submitted. (Not "the URL changed": many sites show the
        // login form and the home page on the very same URL.)
        const cookieSig = async () => {
            const t = (await getTab(tab.id)) || tab;
            const c = await getCookiesForTab(t, [t.url, snap.url], snap.ssoHosts).catch(() => ({ cookies: [] }));
            return c.cookies.map((x) => x.name + '=' + x.value).sort().join(';');
        };
        let before = '';
        const signedIn = async (probe) => {
            if (!probe) return false;
            if (snap.identity) return extractIdentity(probe.storage) === snap.identity;
            return !probe.password && (await cookieSig()) !== before;
        };

        // Up to 3 rounds only for a username-first form that NAVIGATES to its password
        // page. Once a password has been submitted we never submit again: retrying a
        // wrong password could lock the account.
        for (let round = 0; round < 3; round++) {
            let res = null;
            before = await cookieSig();
            try {
                const [r] = await capped(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: autoLoginInPage, args: [creds.username, creds.password] }), 25000);
                res = r && r.result;
            } catch (e) { res = null; }                          // the page navigated mid-script
            if (res && !res.ok) return { ok: false, error: res.error };

            let probe = null, ok = false;
            const t0 = Date.now();
            while (Date.now() - t0 < 15000) {
                await sleep(700);
                probe = await probePage(tab.id);
                if (await signedIn(probe)) { ok = true; break; }
                if ((!res || res.step !== 'both') && probe && probe.passwordEmpty) break;   // the password step has loaded
            }
            if (ok) {
                await sleep(1000);                                // let the app finish writing its token
                const live = await getTab(tab.id);
                const up = await updateSnapshot(live || tab, id, { keepUrl: true });
                if (!up.ok) return up;
                if (snap.url && live && live.url !== snap.url) await navigate(tab.id, snap.url);
                return { ok: true };
            }
            if (res && res.step === 'both') break;             // a password went in and failed - stop
        }
        return { ok: false, error: 'Automatic login did not go through - check the saved username/password' };
    }

    // "Log in again" from the panel, any time.
    async function relogin(tab, id) {
        const r = await autoLogin(tab, id);
        if (r.ok) { await setProblem(originOf(tab.url), id, null); notifyTabs(originOf(tab.url)); }
        return r;
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

        // The menu only needs names - read the store directly instead of listFor,
        // which would inject a script into the page to work out who is signed in.
        const snaps = (await getStore())[originOf(tab.url)] || [];
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

    root.SessionSwap = { saveCurrent, listFor, remove, rename, restore, updateSnapshot, rebuildMenuFor, credsInfo, saveCreds, setCreds, relogin };
})(typeof self !== 'undefined' ? self : globalThis);
