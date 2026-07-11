// Pure per-session cookie-jar logic - NO chrome.* calls, so it can be both
// importScripts'd into the service worker AND unit-tested in plain Node. This
// is the heart of the tab-session-isolation feature: each isolated tab keeps
// its own jar here, we build its outgoing Cookie header from the jar, and we
// fold every Set-Cookie the server sends back into it. Modelled on RFC 6265.
(function (root) {
    'use strict';

    // The directory of a request path is the default cookie path.
    // "/a/b/c" -> "/a/b" ; "/a" -> "/" ; "/" -> "/"
    function defaultPath(pathname) {
        if (!pathname || pathname[0] !== '/') return '/';
        const i = pathname.lastIndexOf('/');
        return i <= 0 ? '/' : pathname.slice(0, i);
    }

    // Parse ONE Set-Cookie header value against the request URL it arrived on.
    // Returns a cookie object; cookie.deleted === true means "remove this".
    function parseSetCookie(headerValue, requestUrl) {
        if (!headerValue) return null;
        const segments = headerValue.split(';');
        const nameValue = segments.shift();
        const eq = nameValue.indexOf('=');
        if (eq < 0) return null;
        const name = nameValue.slice(0, eq).trim();
        if (!name) return null;
        const value = nameValue.slice(eq + 1).trim();

        const u = new URL(requestUrl);
        const cookie = {
            name, value,
            domain: u.hostname.toLowerCase(),
            hostOnly: true,
            path: defaultPath(u.pathname),
            secure: false,
            httpOnly: false,
            sameSite: 'unspecified',
            expires: null,   // null = session cookie (gone when the "browser" closes)
            deleted: false,
        };

        let maxAge = null, expires = null;
        for (const seg of segments) {
            const i = seg.indexOf('=');
            const key = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
            const val = i < 0 ? '' : seg.slice(i + 1).trim();
            if (key === 'domain' && val) {
                cookie.domain = val.replace(/^\./, '').toLowerCase();
                cookie.hostOnly = false;
            } else if (key === 'path' && val) {
                cookie.path = val;
            } else if (key === 'secure') {
                cookie.secure = true;
            } else if (key === 'httponly') {
                cookie.httpOnly = true;
            } else if (key === 'samesite') {
                cookie.sameSite = val.toLowerCase() || 'unspecified';
            } else if (key === 'max-age') {
                const n = parseInt(val, 10);
                if (!isNaN(n)) maxAge = n;
            } else if (key === 'expires') {
                const t = Date.parse(val);
                if (!isNaN(t)) expires = t;
            }
        }

        // Max-Age wins over Expires (RFC 6265 5.2.2/5.2.1).
        if (maxAge !== null) {
            cookie.expires = Date.now() + maxAge * 1000;
            if (maxAge <= 0) cookie.deleted = true;
        } else if (expires !== null) {
            cookie.expires = expires;
            if (expires <= Date.now()) cookie.deleted = true;
        }
        return cookie;
    }

    // Identity of a cookie (what a new Set-Cookie replaces): name + domain + path.
    const cookieKey = (c) => `${c.name}\x00${c.domain}\x00${c.path}`;

    // A jar is a plain object { [key]: cookie } (JSON-serialisable, so it can
    // live in chrome.storage or be passed around freely).
    function putCookie(jar, cookie) {
        if (!cookie) return;
        const key = cookieKey(cookie);
        if (cookie.deleted) delete jar[key];
        else jar[key] = cookie;
    }

    function domainMatch(host, cookie) {
        host = host.toLowerCase();
        const cd = cookie.domain.toLowerCase();
        if (cookie.hostOnly) return host === cd;
        return host === cd || host.endsWith('.' + cd);
    }

    function pathMatch(reqPath, cookiePath) {
        if (reqPath === cookiePath) return true;
        if (reqPath.startsWith(cookiePath)) {
            if (cookiePath.endsWith('/')) return true;
            if (reqPath.charAt(cookiePath.length) === '/') return true;
        }
        return false;
    }

    // Build the outgoing "Cookie: ..." header value for a request URL.
    function buildCookieHeader(jar, requestUrl) {
        const u = new URL(requestUrl);
        const host = u.hostname, path = u.pathname || '/', https = u.protocol === 'https:';
        const now = Date.now();
        const matches = [];
        for (const key in jar) {
            const c = jar[key];
            if (c.expires !== null && c.expires <= now) continue;   // expired
            if (c.secure && !https) continue;                       // secure-only
            if (!domainMatch(host, c)) continue;
            if (!pathMatch(path, c.path)) continue;
            matches.push(c);
        }
        // RFC 6265: cookies with longer paths come first.
        matches.sort((a, b) => b.path.length - a.path.length);
        return matches.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    // Fold every Set-Cookie from one response into the jar. rawSetCookie may be
    // a single header value or several joined by "\n" (how CDP delivers them).
    function applySetCookies(jar, rawSetCookie, requestUrl) {
        if (!rawSetCookie) return;
        for (const line of String(rawSetCookie).split('\n')) {
            const trimmed = line.trim();
            if (trimmed) putCookie(jar, parseSetCookie(trimmed, requestUrl));
        }
    }

    function purgeExpired(jar) {
        const now = Date.now();
        for (const key in jar) if (jar[key].expires !== null && jar[key].expires <= now) delete jar[key];
    }

    // What document.cookie should return for a URL: the same matching set as
    // buildCookieHeader, but EXCLUDING HttpOnly cookies (JS can't see those).
    // This is what a page's own script reads - e.g. ABP reading its XSRF-TOKEN.
    function buildDocumentCookie(jar, requestUrl) {
        const u = new URL(requestUrl);
        const host = u.hostname, path = u.pathname || '/', https = u.protocol === 'https:';
        const now = Date.now();
        const matches = [];
        for (const key in jar) {
            const c = jar[key];
            if (c.httpOnly) continue;                               // invisible to JS
            if (c.expires !== null && c.expires <= now) continue;
            if (c.secure && !https) continue;
            if (!domainMatch(host, c)) continue;
            if (!pathMatch(path, c.path)) continue;
            matches.push(c);
        }
        matches.sort((a, b) => b.path.length - a.path.length);
        return matches.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    const api = {
        defaultPath, parseSetCookie, cookieKey, putCookie,
        domainMatch, pathMatch, buildCookieHeader, buildDocumentCookie, applySetCookies, purgeExpired,
    };
    root.SessionCookieJar = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
