// Runs in the PAGE (MAIN world) at document_start. Overrides console + global
// error events and forwards them to the isolated content script in small,
// throttled, de-duplicated, size-capped batches - so even a page that logs
// thousands of times a second never floods or hangs the browser.
(function () {
    if (window.__qaConsoleCapture) return;
    window.__qaConsoleCapture = true;

    const orig = {};
    ['log', 'info', 'warn', 'error', 'debug'].forEach(m => {
        orig[m] = (console[m] || console.log).bind(console);
    });
    const LEVEL = { log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'log' };

    const MAX_STR = 2000;       // cap each serialized value
    const MAX_QUEUE = 400;      // local safety cap before a flush
    const FLUSH_MS = 300;       // batch window

    let queue = [];
    let flushTimer = null;

    function serializeArg(a) {
        try {
            if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
            if (a === null) return 'null';
            const t = typeof a;
            if (t === 'undefined' || t === 'number' || t === 'boolean') return String(a);
            if (t === 'function') return '[Function]';
            if (t === 'string') return a.length > MAX_STR ? a.slice(0, MAX_STR) + '… (truncated)' : a;
            if (typeof Element !== 'undefined' && a instanceof Element) {
                return '<' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + '>';
            }
            const seen = new WeakSet();
            let s = JSON.stringify(a, (k, v) => {
                if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                if (typeof v === 'string' && v.length > MAX_STR) return v.slice(0, MAX_STR) + '…';
                return v;
            });
            if (s === undefined) return String(a);
            return s.length > MAX_STR ? s.slice(0, MAX_STR) + '… (truncated)' : s;
        } catch (e) {
            try { return String(a); } catch (_) { return '[unserializable]'; }
        }
    }

    // First non-extension frame in a stack -> "file.js:line"
    function firstStackLocation(stack) {
        if (!stack) return '';
        const lines = stack.split('\n');
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].includes('console-capture.js')) continue;
            const m = lines[i].match(/((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)/);
            if (m) return m[1].split('/').pop().split('?')[0] + ':' + m[2];
        }
        return '';
    }

    function push(level, args) {
        let message = args.map(serializeArg).join(' ');
        if (message.length > MAX_STR) message = message.slice(0, MAX_STR) + '… (truncated)';
        const source = (level === 'error' || level === 'warn') ? firstStackLocation(new Error().stack) : '';

        // Collapse an identical consecutive message into a count (kills spam loops)
        const last = queue[queue.length - 1];
        if (last && last.level === level && last.message === message) {
            last.count++;
            last.ts = Date.now();
            return;
        }
        queue.push({ level, message, source, ts: Date.now(), count: 1 });
        if (queue.length > MAX_QUEUE) queue.shift();
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    function flush() {
        flushTimer = null;
        if (!queue.length) return;
        const batch = queue;
        queue = [];
        try { window.postMessage({ __qaConsole: true, batch }, '*'); } catch (e) { }
    }

    ['log', 'info', 'warn', 'error', 'debug'].forEach(m => {
        console[m] = function (...args) {
            try { push(LEVEL[m], args); } catch (e) { }
            return orig[m].apply(console, args);
        };
    });

    function reportUncaught(message, filename, lineno, errorObj) {
        let msg = message || 'Error';
        if (errorObj && errorObj.stack) msg = errorObj.stack;
        else if (filename) msg += ' (' + String(filename).split('/').pop() + ':' + (lineno || 0) + ')';
        push('error', [msg]);
    }

    window.addEventListener('error', (e) => {
        try {
            const t = e.target;
            if (t && t !== window && (t.src || t.href) && t.tagName) {
                push('error', ['Failed to load ' + t.tagName.toLowerCase() + ': ' + (t.src || t.href)]);
                return;
            }
            reportUncaught(e.message, e.filename, e.lineno, e.error);
        } catch (err) { }
    }, true);

    // Belt-and-suspenders: some uncaught errors are delivered via onerror only
    const prevOnError = window.onerror;
    window.onerror = function (message, source, lineno, colno, error) {
        try { reportUncaught(message, source, lineno, error); } catch (e) { }
        if (typeof prevOnError === 'function') return prevOnError.apply(this, arguments);
        return false;
    };

    window.addEventListener('unhandledrejection', (e) => {
        try {
            const r = e.reason;
            push('error', ['Unhandled Promise Rejection: ' + ((r && (r.stack || r.message)) || String(r))]);
        } catch (err) { }
    });
})();
