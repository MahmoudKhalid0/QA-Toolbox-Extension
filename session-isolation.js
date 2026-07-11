// Tab-level session isolation via chrome.debugger (CDP). This is the engine
// that makes two tabs in ONE window behave as two different logged-in users
// at the SAME time - the thing pure declarativeNetRequest can't do reliably
// because it's asynchronous and loses the race when a server (Liferay, any
// Java/servlet app) rotates its session id on login.
//
// How it beats the race: CDP's Fetch domain PAUSES every request until we
// release it, so we synchronously overwrite the outgoing Cookie header from
// this tab's own jar; and we read every Set-Cookie back off the wire via the
// Network domain and fold it into that jar. Because the request is paused and
// CDP events arrive in order, the rotated session id captured from the login
// response is already in the jar by the time the follow-up redirect is
// released - so it goes out authenticated instead of bouncing to login.
//
// Depends on SessionCookieJar (session-cookie-jar.js), importScripted first.
(function (root) {
    'use strict';
    const Jar = root.SessionCookieJar;
    const DP_VERSION = '1.3';
    const STORE_KEY = 'qaIsoSessions';   // { [sessionId]: { id, name, color, jar } }

    // sessionId -> { id, name, color, jar }
    const sessions = new Map();
    // tabId -> sessionId
    const tabSession = new Map();
    // tabId -> Map<networkRequestId, url>  (to attribute Set-Cookie to a URL)
    const reqUrl = new Map();
    const attached = new Set();

    let persistTimer = null;
    function persist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            const out = {};
            for (const [id, s] of sessions) out[id] = { id: s.id, name: s.name, color: s.color, jar: s.jar };
            chrome.storage.local.set({ [STORE_KEY]: out });
        }, 300);
    }

    async function loadFromStorage() {
        const r = await chrome.storage.local.get([STORE_KEY]);
        const saved = r[STORE_KEY] || {};
        for (const id in saved) {
            const s = saved[id];
            sessions.set(id, { id: s.id, name: s.name, color: s.color || '#6366f1', jar: s.jar || {} });
        }
    }

    // Flip to true (then reload the extension) to print the full per-request
    // trace to the service-worker console again - handy if something breaks.
    // The recent trace is always kept in a ring for the isoDebugState dump,
    // regardless of this flag; DEBUG only controls console noise.
    const DEBUG = false;
    // document.cookie isolation (page-side JS cookie override). OFF by default:
    // it's the risky, unproven layer that can loop/break complex SPAs. Plain
    // HTTP-cookie isolation (what Liferay needs) always runs regardless.
    const ISOLATE_DOC_COOKIE = false;
    const diag = [];
    function push(line) { diag.push(Date.now() % 100000 + ' ' + line); if (diag.length > 200) diag.shift(); }
    function log(...a) {
        const line = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        push(line);
        if (DEBUG) console.log('[iso]', line);
    }
    function logErr(...a) {   // real problems - always surfaced
        const line = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        push('ERROR ' + line);
        console.warn('[iso]', line);
    }

    const dbg = (tabId) => ({ tabId });
    // Returns { result, error } - error is the command's lastError message (if any).
    function send(tabId, method, params) {
        return new Promise((resolve) => {
            chrome.debugger.sendCommand(dbg(tabId), method, params || {}, (res) => {
                const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
                resolve({ result: res, error: err });
            });
        });
    }

    function attachDebugger(tabId) {
        return new Promise((resolve, reject) => {
            chrome.debugger.attach(dbg(tabId), DP_VERSION, () => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve();
            });
        });
    }

    async function startIsolation(tabId, sessionId) {
        if (!sessions.has(sessionId)) return { ok: false, error: 'unknown session' };
        // Re-isolating a tab that's already isolated (e.g. switching it to a
        // different session) would throw "Another debugger is already
        // attached" - tear the old one down cleanly first.
        if (attached.has(tabId) || tabSession.has(tabId)) await stopIsolation(tabId);
        tabSession.set(tabId, sessionId);
        reqUrl.set(tabId, new Map());
        try {
            await attachDebugger(tabId);
            attached.add(tabId);
            log('attached tab', tabId, 'session', sessions.get(sessionId).name);

            // Network domain: the reliable place to READ Set-Cookie (Fetch's
            // response headers hide it). Fetch domain (Request stage only): to
            // OVERRIDE the outgoing Cookie header. No response-stage Fetch, so
            // no continueResponse (which threw "both should be provided").
            const net = await send(tabId, 'Network.enable');
            if (net.error) throw new Error('Network.enable: ' + net.error);
            const fetchEn = await send(tabId, 'Fetch.enable', {
                patterns: [{ urlPattern: '*', requestStage: 'Request' }],
            });
            if (fetchEn.error) throw new Error('Fetch.enable: ' + fetchEn.error);

            // document.cookie isolation - OFF by default. It overrides
            // document.cookie in the page (for apps that read a CSRF token via
            // JS, like ABP). It's risky (can break pages / cause reload loops
            // on complex SPAs) and unproven, so it stays off: plain cookie
            // isolation is what reliably works (Liferay). Flip ISOLATE_DOC_COOKIE
            // to true only to experiment with JS-cookie-reading apps.
            if (ISOLATE_DOC_COOKIE) {
                await send(tabId, 'Page.enable');
                await send(tabId, 'Runtime.enable');
                await send(tabId, 'Runtime.addBinding', { name: '__isoCookieSet' });
                await registerDocCookieScript(tabId);
            }

            log('isolation active on tab', tabId);
            return { ok: true };
        } catch (e) {
            logErr('startIsolation failed tab', tabId, '-', e.message);
            tabSession.delete(tabId);
            reqUrl.delete(tabId);
            // Best-effort detach so a half-attached tab doesn't linger.
            if (attached.has(tabId)) { attached.delete(tabId); chrome.debugger.detach(dbg(tabId), () => void chrome.runtime.lastError); }
            return { ok: false, error: e.message };
        }
    }

    async function stopIsolation(tabId) {
        tabSession.delete(tabId);
        reqUrl.delete(tabId);
        docScriptId.delete(tabId);
        counts.delete(tabId);
        if (attached.has(tabId)) {
            attached.delete(tabId);
            await new Promise((resolve) => chrome.debugger.detach(dbg(tabId), () => { void chrome.runtime.lastError; resolve(); }));
        }
    }

    // Per-tab last-seen main URL, a fallback for attributing Set-Cookie when
    // the per-request-id map misses (redirects, sub-resources).
    const lastUrl = new Map();
    // Per-tab event counters, surfaced via isoDebugState for diagnosis.
    const counts = new Map();
    const bump = (tabId, k) => { const c = counts.get(tabId) || {}; c[k] = (c[k] || 0) + 1; counts.set(tabId, c); };

    // ── document.cookie isolation (page-side) ──
    const docScriptId = new Map(); // tabId -> Page.addScriptToEvaluateOnNewDocument id

    // The override installed into the page at document-start: document.cookie
    // reads/writes window.__isoLive (this session's JS-visible cookies) instead
    // of the shared browser store. INITIAL is baked in per (re)registration.
    function docCookieSource(initial) {
        return `(() => {
  try {
    if (typeof window.__isoLive === 'undefined') window.__isoLive = ${JSON.stringify(initial)};
    const proto = Document.prototype;
    Object.defineProperty(proto, 'cookie', {
      configurable: true,
      get() { return window.__isoLive || ''; },
      set(v) {
        try {
          const s = String(v); const nv = s.split(';')[0]; const eq = nv.indexOf('=');
          if (eq > 0) {
            const name = nv.slice(0, eq).trim();
            const parts = (window.__isoLive || '').split('; ').filter(c => c && c.split('=')[0].trim() !== name);
            const del = /expires=[^;]*1970|max-age=\\s*-?0(\\D|$)/i.test(s);
            if (!del) parts.push(nv.trim());
            window.__isoLive = parts.filter(Boolean).join('; ');
          }
        } catch (e) {}
        try { window.__isoCookieSet(String(v)); } catch (e) {}
      }
    });
  } catch (e) {}
})();`;
    }

    const jsCookieFor = (tabId, sess) => {
        const u = lastUrl.get(tabId);
        try { return u ? Jar.buildDocumentCookie(sess.jar, u) : ''; } catch (e) { return ''; }
    };

    // (Re)install the override so any NEW document in the tab starts with the
    // current JS-visible cookies baked in (no read race at document-start).
    async function registerDocCookieScript(tabId) {
        const sess = sessions.get(tabSession.get(tabId));
        if (!sess) return;
        const old = docScriptId.get(tabId);
        if (old) await send(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: old });
        const r = await send(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: docCookieSource(jsCookieFor(tabId, sess)) });
        if (r.result && r.result.identifier) docScriptId.set(tabId, r.result.identifier);
    }

    // Update the CURRENTLY-loaded document's cookies right now (after a new
    // Set-Cookie), so JS that reads document.cookie sees the fresh value.
    function pushDocCookie(tabId) {
        const sess = sessions.get(tabSession.get(tabId));
        if (!sess) return;
        const val = jsCookieFor(tabId, sess);
        send(tabId, 'Runtime.evaluate', { expression: `window.__isoLive = ${JSON.stringify(val)};`, returnByValue: true });
        registerDocCookieScript(tabId); // and keep future documents in sync
    }

    // ── the CDP event pump ──
    chrome.debugger.onEvent.addListener((source, method, params) => {
        const tabId = source.tabId;
        if (!tabSession.has(tabId)) return;
        const sess = sessions.get(tabSession.get(tabId));
        if (!sess) return;

        // Track each network request's URL so a later Set-Cookie can be
        // attributed to it (needed for the cookie's default domain/path).
        if (method === 'Network.requestWillBeSent') {
            bump(tabId, 'req');
            const m = reqUrl.get(tabId);
            const u = params.request && params.request.url;
            if (m && params.requestId && u) m.set(params.requestId, u);
            if (u && /^https?:/i.test(u)) lastUrl.set(tabId, u);
            return;
        }

        // The reliable Set-Cookie source (raw wire headers, incl. HttpOnly).
        if (method === 'Network.responseReceivedExtraInfo') {
            bump(tabId, 'extra');
            const headers = params.headers || {};
            let setCookie = null;
            for (const k in headers) if (k.toLowerCase() === 'set-cookie') { setCookie = headers[k]; break; }
            if (!setCookie) return;
            const m = reqUrl.get(tabId);
            const u = (m && m.get(params.requestId)) || lastUrl.get(tabId) || null;
            if (!u) { log('drop Set-Cookie (no url) tab', tabId); return; }
            const before = Object.keys(sess.jar).length;
            Jar.applySetCookies(sess.jar, setCookie, u);
            bump(tabId, 'setcookie');
            persist();
            if (ISOLATE_DOC_COOKIE) pushDocCookie(tabId); // keep page's document.cookie in sync
            log('captured Set-Cookie tab', tabId, 'jar', before, '->', Object.keys(sess.jar).length, '::', setCookie.split('\n').map((s) => s.split(';')[0]).join(','));
            return;
        }

        // The page wrote document.cookie -> fold it into this session's jar.
        if (method === 'Runtime.bindingCalled' && params.name === '__isoCookieSet') {
            const u = lastUrl.get(tabId);
            if (u) { Jar.applySetCookies(sess.jar, String(params.payload || ''), u); persist(); }
            return;
        }

        // Request stage: replace the outgoing Cookie header with THIS session's
        // cookies. This is what isolates the tab - it never sends the browser's
        // shared-jar cookies, only its own session's.
        if (method === 'Fetch.requestPaused') {
            bump(tabId, 'paused');
            const reqId = params.requestId;
            const url = (params.request && params.request.url) || lastUrl.get(tabId) || null;
            let cookieHeader = '';
            try { cookieHeader = url ? Jar.buildCookieHeader(sess.jar, url) : ''; } catch (e) { cookieHeader = ''; }

            const src = (params.request && params.request.headers) || {};
            const headers = [];
            let hadCookie = false;
            for (const name in src) {
                if (name.toLowerCase() === 'cookie') { hadCookie = true; continue; }
                headers.push({ name, value: String(src[name]) });
            }
            if (cookieHeader) headers.push({ name: 'Cookie', value: cookieHeader });

            // Log the first handful so we can confirm injection is happening.
            const c = counts.get(tabId) || {};
            if ((c.paused || 0) <= 6) log('inject tab', tabId, 'strip=' + hadCookie, 'send=' + (cookieHeader ? cookieHeader.split(';')[0] + '…' : '(none)'), url);

            send(tabId, 'Fetch.continueRequest', { requestId: reqId, headers }).then((r) => {
                if (r.error) logErr('continueRequest tab', tabId, r.error);
            });
            return;
        }
    });

    // If the user dismisses the debugger banner (or DevTools grabs the tab),
    // Chrome detaches us - stop tracking so we don't leak.
    chrome.debugger.onDetach.addListener((source) => {
        const tabId = source.tabId;
        attached.delete(tabId);
        tabSession.delete(tabId);
        reqUrl.delete(tabId);
    });

    chrome.tabs.onRemoved.addListener((tabId) => { stopIsolation(tabId); });

    // ── public API (used by the popup via messages, wired in background.js) ──
    function createSession(name, color) {
        const id = 'iso_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        sessions.set(id, { id, name: name || 'Session', color: color || '#6366f1', jar: {} });
        persist();
        return id;
    }
    function deleteSession(id) {
        sessions.delete(id);
        for (const [tabId, sid] of tabSession) if (sid === id) stopIsolation(tabId);
        persist();
    }
    function listSessions() {
        return [...sessions.values()].map((s) => ({ id: s.id, name: s.name, color: s.color, cookieCount: Object.keys(s.jar).length }));
    }
    function clearJar(id) {
        const s = sessions.get(id);
        if (s) { s.jar = {}; persist(); }
    }

    // Chrome can't tint an individual tab, but a TAB GROUP has a coloured,
    // named label - so every isolated tab of a session goes into that
    // session's group. Map our palette to the group-colour enum.
    const GROUP_COLOR = {
        '#6366f1': 'blue', '#10b981': 'green', '#f59e0b': 'orange',
        '#ef4444': 'red', '#8b5cf6': 'purple', '#0ea5e9': 'cyan', '#ec4899': 'pink',
    };
    const sessionGroup = new Map(); // sessionId -> groupId (best-effort, per window)
    async function groupTab(tabId, sessionId) {
        const s = sessions.get(sessionId);
        if (!s || !chrome.tabs.group) return;
        const doGroup = (opts) => new Promise((res) => chrome.tabs.group(opts, (gid) => res(chrome.runtime.lastError ? null : gid)));
        let gid = null;
        const existing = sessionGroup.get(sessionId);
        if (existing != null) gid = await doGroup({ groupId: existing, tabIds: [tabId] }); // same-session tabs share a group
        if (gid == null) gid = await doGroup({ tabIds: [tabId] });                         // different window / first tab
        if (gid != null) {
            sessionGroup.set(sessionId, gid);
            if (chrome.tabGroups) chrome.tabGroups.update(gid, { title: s.name, color: GROUP_COLOR[s.color] || 'grey' }, () => void chrome.runtime.lastError);
        }
    }

    async function openIsolatedTab(sessionId, url) {
        if (!sessions.has(sessionId)) sessionId = createSession('Session', '#6366f1');
        // Open BLANK first, attach + enable Fetch, THEN navigate - so the very
        // first document request (which sets the pre-login session cookie) is
        // already intercepted and isolated, not sent through the shared jar.
        const tab = await new Promise((resolve) => chrome.tabs.create({ url: 'about:blank' }, resolve));
        const r = await startIsolation(tab.id, sessionId);
        if (r.ok) { groupTab(tab.id, sessionId); if (url) chrome.tabs.update(tab.id, { url }); }
        return { tabId: tab.id, ok: r.ok, error: r.error };
    }

    // Copy the browser's CURRENT cookies for a URL into a session jar, so
    // isolating an already-logged-in tab keeps that login inside the session
    // instead of stripping it away on the first reload.
    function seedJarFromBrowser(sessionId, url) {
        return new Promise((resolve) => {
            const s = sessions.get(sessionId);
            if (!s || !url) return resolve();
            chrome.cookies.getAll({ url }, (cookies) => {
                void chrome.runtime.lastError;
                let n = 0;
                for (const c of cookies || []) {
                    s.jar[`${c.name}\x00${c.domain}\x00${c.path}`] = {
                        name: c.name, value: c.value,
                        domain: c.domain.replace(/^\./, '').toLowerCase(),
                        hostOnly: !!c.hostOnly,
                        path: c.path || '/',
                        secure: !!c.secure,
                        httpOnly: !!c.httpOnly,
                        sameSite: (c.sameSite || 'unspecified').toLowerCase(),
                        expires: c.session ? null : (c.expirationDate ? c.expirationDate * 1000 : null),
                        deleted: false,
                    };
                    n++;
                }
                if (n) { persist(); log('seeded', n, 'cookies into', s.name, 'from', url); }
                resolve();
            });
        });
    }

    // Turn the CURRENTLY-active tab into an isolated one (keeps its URL + login).
    async function isolateExistingTab(tabId, sessionId) {
        if (!sessions.has(sessionId)) sessionId = createSession('Session', '#6366f1');
        const tab = await new Promise((resolve) => chrome.tabs.get(tabId, (t) => { void chrome.runtime.lastError; resolve(t); }));
        if (tab && tab.url && /^https?:/i.test(tab.url)) {
            lastUrl.set(tabId, tab.url);              // so the doc.cookie script bakes the seeded cookies for this URL
            await seedJarFromBrowser(sessionId, tab.url);
        }
        const r = await startIsolation(tabId, sessionId);
        if (r.ok) { groupTab(tabId, sessionId); chrome.tabs.reload(tabId, { bypassCache: false }); }
        return { tabId, ok: r.ok, error: r.error };
    }

    function debugState() {
        return {
            attached: [...attached],
            tabSessions: [...tabSession.entries()],
            jars: [...sessions.values()].map((s) => ({ name: s.name, cookies: Object.keys(s.jar) })),
            counts: [...counts.entries()],
            log: diag.slice(-60),
        };
    }

    root.SessionIsolation = {
        loadFromStorage, createSession, deleteSession, listSessions, clearJar,
        openIsolatedTab, isolateExistingTab, stopIsolation, debugState,
        isTabIsolated: (tabId) => tabSession.has(tabId),
        sessionOfTab: (tabId) => tabSession.get(tabId) || null,
    };
})(typeof self !== 'undefined' ? self : globalThis);
