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
        return new Promise((res) => chrome.storage.local.get([STORE], (r) => res(r[STORE] || {})));
    }
    function setStore(all) {
        return new Promise((res) => chrome.storage.local.set({ [STORE]: all }, () => res()));
    }
    function getActive() {
        return new Promise((res) => chrome.storage.local.get([ACTIVE], (r) => res(r[ACTIVE] || {})));
    }
    async function setActive(origin, id) {
        const a = await getActive();
        if (id) a[origin] = id; else delete a[origin];
        return new Promise((res) => chrome.storage.local.set({ [ACTIVE]: a }, () => res()));
    }

    const cookieUrl = (c) => {
        const domain = c.domain.replace(/^\./, '');
        return (c.secure ? 'https://' : 'http://') + domain + (c.path || '/');
    };

    function setCookie(c) {
        return new Promise((resolve) => {
            const details = {
                url: cookieUrl(c),
                name: c.name, value: c.value,
                path: c.path, secure: c.secure, httpOnly: c.httpOnly,
                sameSite: c.sameSite, storeId: c.storeId,
            };
            if (!c.hostOnly) details.domain = c.domain;
            if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
            chrome.cookies.set(details, () => { void chrome.runtime.lastError; resolve(); });
        });
    }
    function removeCookie(c) {
        return new Promise((resolve) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }, () => { void chrome.runtime.lastError; resolve(); }));
    }

    // Read a tab's localStorage + sessionStorage. Many modern apps (ABP/OIDC
    // SPAs) keep the auth token here, NOT in a cookie - so a cookie-only swap
    // leaves the old token behind and the API returns "NotAuthorized". We must
    // capture and restore this too.
    async function readStorage(tabId) {
        try {
            const [r] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const dump = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch (e) {} return o; };
                    return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
                },
            });
            return (r && r.result) || { local: {}, session: {} };
        } catch (e) { return { local: {}, session: {} }; }   // e.g. injection blocked
    }

    async function writeStorage(tabId, storage) {
        if (!storage) return;
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                args: [storage],
                func: (data) => {
                    try { window.localStorage.clear(); } catch (e) {}
                    try { window.sessionStorage.clear(); } catch (e) {}
                    if (data && data.local) for (const k in data.local) { try { window.localStorage.setItem(k, data.local[k]); } catch (e) {} }
                    if (data && data.session) for (const k in data.session) { try { window.sessionStorage.setItem(k, data.session[k]); } catch (e) {} }
                },
            });
        } catch (e) { /* injection blocked - cookies alone will have to do */ }
    }

    // ── save / list / delete ──
    async function saveCurrent(tab, name) {
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return { ok: false, error: 'Open a website first' };
        const origin = originOf(tab.url);
        const cookies = await new Promise((res) => chrome.cookies.getAll({ url: tab.url }, (c) => { void chrome.runtime.lastError; res(c || []); }));
        const storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        const all = await getStore();
        if (!all[origin]) all[origin] = [];
        const id = 'snap_' + Date.now();
        // Remember the exact page this login was saved on: it's on the right app
        // path AND is a page this user is allowed to see - the best place to land
        // when switching back (some apps live on a sub-path, not the site root).
        all[origin].push({ id, name: name || `Login ${all[origin].length + 1}`, url: tab.url, cookies, storage, createdAt: Date.now() });
        await setStore(all);
        await setActive(origin, id);   // what we just saved IS the current login
        rebuildMenuFor(tab);
        notifyTabs(origin);
        return { ok: true };
    }

    // Is a saved snapshot still the one actually logged in right now? Check each
    // of the snapshot's AUTH cookies (HttpOnly - the session/identity ones) AT ITS
    // OWN domain+path, not against the current tab's URL. That distinction matters:
    // a path-scoped auth cookie is only returned by getAll({url}) when the tab is
    // on that exact path, so the old check made "CURRENT" appear only on the page
    // the login was saved on and vanish everywhere else. Checking each cookie where
    // it actually lives ties "CURRENT" to the SESSION, independent of the URL.
    async function stillLoggedIn(snapCookies) {
        if (!snapCookies || !snapCookies.length) return false;
        const authCookies = snapCookies.filter((c) => c.httpOnly);
        const check = authCookies.length ? authCookies : snapCookies;
        for (const c of check) {
            const live = await new Promise((res) => chrome.cookies.get(
                { url: cookieUrl(c), name: c.name, storeId: c.storeId },
                (r) => { void chrome.runtime.lastError; res(r); }));
            // The value must MATCH what we saved. Existence alone is not enough: if
            // you log in as a DIFFERENT user the cookie still exists (new value), and
            // an existence-only check wrongly kept showing this snapshot as CURRENT.
            if (!live || live.value !== c.value) return false;
        }
        return true;
    }

    async function listFor(url) {
        const origin = originOf(url);
        const all = await getStore();
        const snaps = all[origin] || [];
        let active = (await getActive())[origin];
        // Validate the stored "current" against the live session cookies - clear it
        // if the user has since logged out (so nothing shows as CURRENT anymore).
        if (active) {
            const snap = snaps.find((s) => s.id === active);
            if (!snap || !(await stillLoggedIn(snap.cookies))) { active = null; await setActive(origin, null); }
        }
        return snaps.map((s) => ({ id: s.id, name: s.name, count: s.cookies.length, createdAt: s.createdAt, active: s.id === active }));
    }

    async function remove(url, id) {
        const origin = originOf(url);
        const all = await getStore();
        if (all[origin]) {
            all[origin] = all[origin].filter((s) => s.id !== id);
            if (!all[origin].length) delete all[origin];
            await setStore(all);
        }
        if ((await getActive())[origin] === id) await setActive(origin, null);   // deleted the active one
        // Rebuild the context menu on the current tab, and refresh open FABs.
        if (chrome.tabs) chrome.tabs.query({ active: true, currentWindow: true }, (t) => { if (t && t[0]) rebuildMenuFor(t[0]); });
        notifyTabs(origin);
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
        snap.cookies = await new Promise((res) => chrome.cookies.getAll({ url: tab.url }, (c) => { void chrome.runtime.lastError; res(c || []); }));
        snap.storage = tab.id != null ? await readStorage(tab.id) : { local: {}, session: {} };
        snap.url = tab.url;              // also refreshes the landing page
        snap.createdAt = Date.now();
        await setStore(all);
        await setActive(origin, id);     // you ARE this login now
        rebuildMenuFor(tab);
        notifyTabs(origin);
        return { ok: true, name: snap.name };
    }

    async function rename(url, id, name) {
        const origin = originOf(url);
        const all = await getStore();
        const s = (all[origin] || []).find((x) => x.id === id);
        if (s) { s.name = name; await setStore(all); }
    }

    // ── the swap ──
    async function restore(tab, id) {
        if (!tab || !tab.url) return { ok: false, error: 'no tab' };
        const origin = originOf(tab.url);
        const all = await getStore();
        const snap = (all[origin] || []).find((s) => s.id === id);
        if (!snap) return { ok: false, error: 'snapshot not found' };
        // Clear the site's current cookies, then lay down the saved ones...
        const current = await new Promise((res) => chrome.cookies.getAll({ url: tab.url }, (c) => { void chrome.runtime.lastError; res(c || []); }));
        for (const c of current) await removeCookie(c);
        for (const c of snap.cookies) await setCookie(c);
        // ...and restore localStorage/sessionStorage (where OIDC/SPA apps keep
        // the token) so the new page boots as that user.
        if (tab.id != null) await writeStorage(tab.id, snap.storage);
        // Land on the page THIS login was saved on, not the current URL: the
        // current page may be a permission-gated deep link the switched-to user
        // can't view ("NotAuthorized"), and the site root may be a different app
        // (apps often live on a sub-path like /en/web/mof, not the root). The
        // saved page is on the right path AND was allowed for this user. Older
        // snapshots without a url fall back to the site root.
        await setActive(origin, id);   // this snapshot is now the current login
        const dest = snap.url || (origin + '/');
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
            notifyTabs(origin);
            if (!navd) return { ok: false, error: 'could not navigate the tab' };
        } else {
            notifyTabs(origin);
        }
        return { ok: true };
    }

    // ── right-click menu (switch without opening the popup) ──
    let menuBuilt = false;
    async function rebuildMenuFor(tab) {
        if (!chrome.contextMenus) return;
        await new Promise((res) => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; res(); }));
        menuBuilt = false;
        if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;

        const snaps = await listFor(tab.url);
        chrome.contextMenus.create({ id: MENU_ROOT, title: `Switch login (${hostOf(tab.url)})`, contexts: ['page'] }, () => void chrome.runtime.lastError);
        for (const s of snaps) {
            chrome.contextMenus.create({ id: 'swap:' + s.id, parentId: MENU_ROOT, title: '↪ ' + s.name, contexts: ['page'] }, () => void chrome.runtime.lastError);
        }
        if (snaps.length) chrome.contextMenus.create({ id: 'swapSep', parentId: MENU_ROOT, type: 'separator', contexts: ['page'] }, () => void chrome.runtime.lastError);
        chrome.contextMenus.create({ id: 'swapSaveNow', parentId: MENU_ROOT, title: '💾 Save current login…', contexts: ['page'] }, () => void chrome.runtime.lastError);
        menuBuilt = true;
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
