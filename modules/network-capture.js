// Runs in the PAGE (MAIN world) at document_start. Wraps fetch + XHR and
// forwards each completed request to the isolated content script in throttled,
// size-capped batches. Only fetch/XHR (the API calls QA cares about) are
// captured - not every image/script/font - so heavy pages never hang.
(function () {
    if (window.__qaNetworkCapture) return;
    window.__qaNetworkCapture = true;

    const origFetch = window.fetch;
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;

    const MAX_BODY = 4000;       // cap stored response body
    const MAX_REQ_BODY = 2000;   // cap stored request body
    const MAX_READ = 200 * 1024; // never read a response body bigger than this
    const FLUSH_MS = 400;
    const MAX_QUEUE = 200;

    let queue = [];
    let flushTimer = null;

    function cap(str, max) {
        if (str == null) return null;
        str = String(str);
        return str.length > max ? str.slice(0, max) + '… (truncated)' : str;
    }

    function toAbsolute(url) {
        try { return new URL(url, window.location.href).href; } catch (e) { return url; }
    }

    // Readable call stack of whatever triggered the request (skip our own frames)
    function initiatorStack() {
        try {
            const lines = (new Error().stack || '').split('\n').slice(1);
            const out = [];
            for (const ln of lines) {
                if (ln.includes('network-capture.js')) continue;
                out.push(ln.trim());
                if (out.length >= 6) break;
            }
            return out.join('\n');
        } catch (e) { return ''; }
    }

    function headersToObj(headers) {
        const o = {};
        try { headers.forEach((v, k) => { o[k] = v; }); } catch (e) { }
        return o;
    }

    function flush() {
        flushTimer = null;
        if (!queue.length) return;
        const batch = queue;
        queue = [];
        try { window.postMessage({ __qaNetwork: true, batch }, '*'); } catch (e) { }
    }

    function report(entry) {
        queue.push(entry);
        if (queue.length > MAX_QUEUE) queue.shift();
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    // --- fetch ---------------------------------------------------------------
    window.fetch = async function (...args) {
        const startTime = Date.now();
        const initiator = initiatorStack();
        const input = args[0];
        const init = args[1] || {};
        let url = input instanceof Request ? input.url : String(input);
        url = toAbsolute(url);
        const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();

        let reqHeaders = {};
        if (input instanceof Request) reqHeaders = headersToObj(input.headers);
        else if (init.headers) {
            if (init.headers instanceof Headers) reqHeaders = headersToObj(init.headers);
            else if (typeof init.headers === 'object') reqHeaders = { ...init.headers };
        }

        let reqBody = null;
        try {
            const b = init.body;
            if (typeof b === 'string') reqBody = b;
            else if (b instanceof URLSearchParams) reqBody = b.toString();
            else if (b instanceof FormData) { const o = {}; b.forEach((v, k) => { o[k] = String(v); }); reqBody = JSON.stringify(o); }
            else if (b instanceof Blob) reqBody = '[Blob ' + b.size + 'B]';
            else if (b) reqBody = JSON.stringify(b);
        } catch (e) { reqBody = '[unserializable body]'; }

        try {
            const response = await origFetch.apply(this, args);
            const duration = Date.now() - startTime;
            const ct = response.headers.get('content-type') || '';
            const len = parseInt(response.headers.get('content-length') || '0', 10);

            let resBody = null;
            try {
                if (len && len > MAX_READ) {
                    resBody = '[large body ' + len + 'B - skipped]';
                } else if (/json|text|javascript|xml|html/i.test(ct)) {
                    resBody = await response.clone().text();
                } else {
                    resBody = '[binary]';
                }
            } catch (e) { resBody = '[unable to read body]'; }

            report({
                kind: 'fetch', method, url,
                status: response.status, statusText: response.statusText,
                ok: response.ok, duration, ts: Date.now(),
                reqHeaders, resHeaders: headersToObj(response.headers),
                reqBody: cap(reqBody, MAX_REQ_BODY), resBody: cap(resBody, MAX_BODY),
                contentType: ct, error: null, initiator
            });
            return response;
        } catch (error) {
            report({
                kind: 'fetch', method, url,
                status: 0, statusText: 'Failed', ok: false,
                duration: Date.now() - startTime, ts: Date.now(),
                reqHeaders, resHeaders: {},
                reqBody: cap(reqBody, MAX_REQ_BODY), resBody: null,
                contentType: '', error: error && error.message ? error.message : 'Network error', initiator
            });
            throw error;
        }
    };

    // --- XHR -----------------------------------------------------------------
    XHR.setRequestHeader = function (header, value) {
        if (!this.__qaHeaders) this.__qaHeaders = {};
        this.__qaHeaders[header] = value;
        return origSetHeader.apply(this, arguments);
    };

    XHR.open = function (method, url) {
        this.__qaMethod = (method || 'GET').toUpperCase();
        this.__qaUrl = toAbsolute(url);
        this.__qaHeaders = {};
        return origOpen.apply(this, arguments);
    };

    XHR.send = function (body) {
        const startTime = Date.now();
        const initiator = initiatorStack();
        const self = this;
        let reqBody = null;
        try {
            if (typeof body === 'string') reqBody = body;
            else if (body instanceof URLSearchParams) reqBody = body.toString();
            else if (body instanceof FormData) { const o = {}; body.forEach((v, k) => { o[k] = String(v); }); reqBody = JSON.stringify(o); }
            else if (body) reqBody = '[body]';
        } catch (e) { }

        function resHeadersObj() {
            const o = {};
            try {
                (self.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach(line => {
                    const i = line.indexOf(':');
                    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                });
            } catch (e) { }
            return o;
        }

        self.addEventListener('load', function () {
            const rh = resHeadersObj();
            let resBody = null;
            try {
                if (self.responseType === '' || self.responseType === 'text') resBody = self.responseText;
                else if (self.responseType === 'json') resBody = JSON.stringify(self.response);
                else resBody = '[' + self.responseType + ']';
            } catch (e) { }
            report({
                kind: 'xhr', method: self.__qaMethod, url: self.__qaUrl,
                status: self.status, statusText: self.statusText,
                ok: self.status >= 200 && self.status < 300,
                duration: Date.now() - startTime, ts: Date.now(),
                reqHeaders: self.__qaHeaders || {}, resHeaders: rh,
                reqBody: cap(reqBody, MAX_REQ_BODY), resBody: cap(resBody, MAX_BODY),
                contentType: rh['content-type'] || '', error: null, initiator
            });
        });

        self.addEventListener('error', function () {
            report({
                kind: 'xhr', method: self.__qaMethod, url: self.__qaUrl,
                status: 0, statusText: 'Failed', ok: false,
                duration: Date.now() - startTime, ts: Date.now(),
                reqHeaders: self.__qaHeaders || {}, resHeaders: {},
                reqBody: cap(reqBody, MAX_REQ_BODY), resBody: null,
                contentType: '', error: 'Network error', initiator
            });
        });

        return origSend.apply(this, arguments);
    };
})();
