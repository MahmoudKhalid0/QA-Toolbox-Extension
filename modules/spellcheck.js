// Spelling & language check - the page side (Settings → General → "Spelling & language check").
// While it is on, every page is checked by itself by the AI (spellcheck-bg.js), and re-checked
// when its content changes (an SPA tab, a popup, a table that loads later):
//   red    - a certain mistake: spelling, hamza or grammar (Arabic and English). Text in the
//            other language is NOT flagged for its language - the user sees that by eye.
//   yellow - probably wrong but could be right in some reading (عمله vs عملة)
// Hover a marked word for what is wrong and the fix. Only text the AI hasn't seen before is
// sent - results are cached per text.
//
// Marks are drawn with the CSS Custom Highlight API - ranges over the page's own text, NO
// elements inserted - so app frameworks (OutSystems/React) never see their DOM change.
(function qaSpellCheck() {
    if (window.top !== window || window.__qaSpellLoaded) return;
    window.__qaSpellLoaded = true;
    if (!(window.CSS && CSS.highlights && typeof Highlight === 'function')) return;   // old browser

    const ERR = 'qa-spell-err', WARN = 'qa-spell-warn';
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'TITLE', 'OPTION']);
    const OUR_UI = '#qa-rv, #qa-result-panel, #qa-cap-eye, #qa-spell-tip, [id^="ff-"], [class*="qa-li-toast"]';
    const LABEL = { spelling: 'Spelling', hamza: 'Hamza', grammar: 'Grammar' };

    let on = false, observer = null, timer = null, busy = false, again = false;
    const known = new Map();         // text -> issues[] (this page's answers; [] = no mistakes)
    const tries = new Map();         // text -> failed attempts (retried, not taken as correct)
    let retryAt = 0;
    let marks = new Map();           // text node -> [{ s, e, issue }]
    let pageLang = 'en';

    const send = (msg) => new Promise((res) => {
        try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); }
        catch (e) { res(null); }
    });
    const norm = (t) => t.replace(/\s+/g, ' ').trim();

    function detectLang(sample) {
        const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
        if (htmlLang.startsWith('ar')) return 'ar';
        if (htmlLang.startsWith('en')) return 'en';
        const ar = (sample.match(/[ء-ي]/g) || []).length;
        const en = (sample.match(/[A-Za-z]/g) || []).length;
        return ar > en ? 'ar' : 'en';
    }

    function collect() {
        const nodes = [];
        if (!document.body) return nodes;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                // at least two letters - skip numbers, dates, single symbols
                if (!n.nodeValue || !/[A-Za-zء-ي].*[A-Za-zء-ي]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
                const p = n.parentElement;
                if (!p || SKIP_TAGS.has(p.tagName) || p.isContentEditable || p.closest(OUR_UI)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        // Visible only - judged by the TEXT's own boxes, not its parent's: an element with
        // display:contents (OutSystems tab titles: <div class="display-contents">) has no box
        // of its own, so asking the parent skipped every tab label.
        const r = document.createRange();
        for (let n = walker.nextNode(); n && nodes.length < 5000; n = walker.nextNode()) {
            r.selectNodeContents(n);
            if (r.getClientRects().length) nodes.push(n);
        }
        return nodes;
    }

    async function scan() {
        if (!on) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
            const nodes = collect();
            pageLang = detectLang(nodes.slice(0, 400).map((n) => n.nodeValue).join(' '));
            // texts this page hasn't asked about yet; one request per scan, capped so a huge
            // page can't run up a big bill in one go (the rest is checked on the next scan)
            const ask = [];
            let chars = 0;
            for (const n of nodes) {
                const t = norm(n.nodeValue).slice(0, 1500);
                if (!t || known.has(t) || ask.includes(t)) continue;
                if (tries.get(t) && Date.now() < retryAt) continue;   // failed recently - wait for the retry
                // This text had mistakes and has changed: if the change is exactly the suggested
                // fix(es), it is settled here - nothing is sent (see wasFixed).
                const prev = nodeMem.get(n) || (n.parentElement && nodeMem.get(n.parentElement));
                if (prev && prev.issues.length && prev.t !== t) {
                    const left = wasFixed(prev.t, prev.issues, t);
                    if (left) {
                        known.set(t, left);
                        send({ action: 'spellCachePut', text: t, lang: pageLang, issues: left });
                        continue;
                    }
                }
                if (chars + t.length > 30000) { again = true; break; }
                ask.push(t); chars += t.length;
            }
            if (ask.length) {
                busyMark(true);
                const r = await send({ action: 'spellCheckAi', texts: ask, lang: pageLang }).finally(() => busyMark(false));
                // A text whose request FAILED is not "no mistakes": it was dropped like that before,
                // so a timed-out first request left the whole page unmarked until F5. Retry it
                // after 20s, up to 3 times, then give up (and say so in the Console).
                const failed = !r ? ask : !r.ok ? ask : (r.failed || []);
                if (r && r.ok) {
                    ask.forEach((t) => { if (!failed.includes(t)) known.set(t, r.issues[t] || []); });
                    // one line per AI request - shows which language the page was judged as
                    console.info(`[QA spell] page language: ${pageLang} - sent ${ask.length} texts, ${Object.keys(r.issues).length} with mistakes${failed.length ? `, ${failed.length} failed` : ''}`);
                }
                if (failed.length) {
                    console.warn(`[QA spell] AI check failed for ${failed.length} texts:`, (r && r.error) || 'no response', '- retrying in 20s');
                    for (const t of failed) {
                        const n = (tries.get(t) || 0) + 1;
                        tries.set(t, n);
                        if (n >= 3) known.set(t, []);          // gave up on this one
                    }
                    retryAt = Date.now() + 20000;
                    setTimeout(schedule, 20500);
                }
            }
            if (on) paint(nodes);
        } finally {
            busy = false;
            if (again && on) { again = false; schedule(); }
        }
    }

    // What each text (and its element - apps often swap the text node itself) said last
    // time, with its mistakes: lets a corrected text be verified locally.
    const nodeMem = new WeakMap();

    // Did the text change ONLY by applying some of the suggested fixes? Tries every
    // combination of the old mistakes (there are only a few per text). Returns the mistakes
    // still left ([] = all fixed), or null when the text changed in some other way - then
    // the AI has to read it.
    function wasFixed(oldText, issues, newText) {
        const list = issues.filter((x) => x.fix && x.fix !== x.word).slice(0, 6);
        for (let mask = 1; mask < (1 << list.length); mask++) {
            let cand = oldText;
            list.forEach((x, k) => { if (mask & (1 << k)) cand = cand.split(x.word).join(x.fix); });
            if (cand === newText) return issues.filter((x, k) => !(list.includes(x) && (mask & (1 << list.indexOf(x)))) && newText.includes(x.word));
        }
        return null;
    }

    function paint(nodes) {
        const err = new Highlight(), warn = new Highlight();
        const next = new Map();
        for (const node of nodes) {
            const t = norm(node.nodeValue).slice(0, 1500);
            const issues = known.get(t);
            if (issues) { const mem = { t, issues }; nodeMem.set(node, mem); if (node.parentElement) nodeMem.set(node.parentElement, mem); }
            if (!issues || !issues.length) continue;
            const text = node.nodeValue;
            for (const issue of issues) {
                // every occurrence of the flagged word in this text
                for (let at = text.indexOf(issue.word); at !== -1; at = text.indexOf(issue.word, at + issue.word.length)) {
                    try {
                        const r = new Range(); r.setStart(node, at); r.setEnd(node, at + issue.word.length);
                        (issue.severity === 'warning' ? warn : err).add(r);
                    } catch (e) { continue; }
                    if (!next.has(node)) next.set(node, []);
                    next.get(node).push({ s: at, e: at + issue.word.length, issue });
                }
            }
        }
        marks = next;
        CSS.highlights.set(ERR, err);
        CSS.highlights.set(WARN, warn);
    }

    // A tiny spinner while the AI is checking (only then - a page answered from the cache shows
    // nothing). It sits on the floating ⚡ button's bottom-left corner - the one corner still
    // free (green login dot top-left, notification count top-right); without the button, in
    // the window's corner.
    function busyMark(on) {
        let el = document.getElementById('qa-spell-busy');
        if (!on) { if (el) el.remove(); return; }
        if (!document.getElementById('qa-spell-busy-style')) {
            const st = document.createElement('style'); st.id = 'qa-spell-busy-style';
            st.textContent = `@keyframes qaSpellSpin { to { transform: rotate(360deg); } }
                #qa-spell-busy { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
                  border: 2.5px solid rgba(245,158,11,.25); border-top-color: #f59e0b; background: #fff; box-shadow: 0 0 0 1.5px #fff, 0 1px 4px rgba(0,0,0,.35);
                  animation: qaSpellSpin .8s linear infinite; pointer-events: none; z-index: 2147483647; }`;
            (document.head || document.documentElement).appendChild(st);
        }
        if (!el) { el = document.createElement('div'); el.id = 'qa-spell-busy'; el.title = 'AI is checking the spelling…'; }
        const fab = document.getElementById('ff-floating-btn');
        if (fab) { el.style.cssText = 'position:absolute;bottom:-5px;left:-5px;'; if (el.parentNode !== fab) fab.appendChild(el); }
        else { el.style.cssText = 'position:fixed;bottom:14px;right:14px;'; if (el.parentNode !== document.documentElement) document.documentElement.appendChild(el); }
    }

    // AI calls cost money - wait for the page to settle before asking again
    // …but never longer than 4s: a page that keeps changing (an animation, a slider) would
    // otherwise push the check back forever.
    let firstAsk = 0;
    function schedule() {
        clearTimeout(timer);
        if (!firstAsk) firstAsk = Date.now();
        const wait = Math.max(0, Math.min(1500, 4000 - (Date.now() - firstAsk)));
        timer = setTimeout(() => { firstAsk = 0; scan(); }, wait);
    }

    // ── hover: what is wrong + the fix ──
    let tip = null, tipId = '';
    const caretAt = (x, y) => {
        if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); return p && { node: p.offsetNode, off: p.offset }; }
        if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); return r && { node: r.startContainer, off: r.startOffset }; }
        return null;
    };
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function hideTip() { if (tip) tip.style.display = 'none'; tipId = ''; }
    function showTip(mark, node, x, y) {
        const id = mark.issue.word + mark.s;
        if (tipId !== id) {
            tipId = id;
            if (!tip) {
                tip = document.createElement('div');
                tip.id = 'qa-spell-tip';
                tip.style.cssText = 'position:fixed;z-index:2147483647;max-width:300px;padding:8px 11px;border-radius:9px;background:#17151f;color:#e5e7eb;border:1px solid #2a2738;box-shadow:0 8px 24px rgba(0,0,0,.45);font:12px/1.5 -apple-system,Segoe UI,Tahoma,sans-serif;pointer-events:none;direction:ltr;text-align:left;';
                document.documentElement.appendChild(tip);
            }
            const i = mark.issue, warnColor = i.severity === 'warning' ? '#fbbf24' : '#f87171';
            tip.innerHTML = `<b style="color:${warnColor}">${LABEL[i.type] || 'Mistake'}${i.severity === 'warning' ? ' (maybe)' : ''}</b>`
                // Arabic reads right-to-left: there "wrong → fix" displays with the arrow pointing
                // BACK at the wrong word - use ← so it always points from the mistake to the fix.
                + `<div dir="auto" style="margin-top:3px;color:#94a3b8">${esc(i.word)}${i.fix ? ` ${/[؀-ۿ]/.test(i.word) ? '←' : '→'} <span style="color:#fff;font-weight:700">${esc(i.fix)}</span>` : ''}</div>`
                + (i.note ? `<div dir="auto" style="margin-top:3px;color:#cbd5e1">${esc(i.note)}</div>` : '');
            tip.style.display = 'block';
        }
        const w = tip.offsetWidth, h = tip.offsetHeight;
        tip.style.left = Math.min(x + 12, innerWidth - w - 8) + 'px';
        tip.style.top = (y + 18 + h > innerHeight ? y - h - 10 : y + 18) + 'px';
    }
    let lastMove = 0;
    function onMove(e) {
        const now = Date.now(); if (now - lastMove < 60) return; lastMove = now;
        const c = caretAt(e.clientX, e.clientY);
        const list = c && marks.get(c.node);
        let mark = list && list.find((m) => c.off >= m.s && c.off <= m.e);
        // caretPositionFromPoint snaps to the NEAREST text even with the pointer far below it -
        // only count it when the pointer is really over the word's box.
        if (mark) {
            try {
                const r = new Range(); r.setStart(c.node, mark.s); r.setEnd(c.node, mark.e);
                const over = [...r.getClientRects()].some((b) => e.clientX >= b.left - 2 && e.clientX <= b.right + 2 && e.clientY >= b.top - 2 && e.clientY <= b.bottom + 2);
                if (!over) mark = null;
            } catch (x) { mark = null; }
        }
        if (mark) showTip(mark, c.node, e.clientX, e.clientY); else hideTip();
    }

    function start() {
        if (on) return;
        on = true;
        let st = document.getElementById('qa-spell-style');
        if (!st) {
            st = document.createElement('style'); st.id = 'qa-spell-style';
            st.textContent = `::highlight(${ERR}) { background-color: rgba(239,68,68,.18); text-decoration: underline wavy #ef4444; text-decoration-thickness: 1.5px; text-decoration-skip-ink: none; }
                ::highlight(${WARN}) { background-color: rgba(245,158,11,.20); text-decoration: underline wavy #f59e0b; text-decoration-thickness: 1.5px; text-decoration-skip-ink: none; }`;
            (document.head || document.documentElement).appendChild(st);
        }
        observer = new MutationObserver((muts) => {
            if (muts.every((m) => m.target && m.target.closest && m.target.closest('#qa-spell-tip'))) return;
            schedule();
        });
        // Also watch for content being SHOWN, not only added: OutSystems tabs keep every tab's
        // content in the page and only flip a class / style / hidden on click - with just
        // childList+characterData the second tab was never checked.
        if (document.body) observer.observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'aria-expanded', 'aria-selected']
        });
        document.addEventListener('mousemove', onMove, { passive: true, capture: true });
        document.addEventListener('click', schedule, { passive: true, capture: true });
        scan();
    }
    function stop() {
        busyMark(false);
        on = false;
        clearTimeout(timer);
        if (observer) { observer.disconnect(); observer = null; }
        document.removeEventListener('mousemove', onMove, { capture: true });
        document.removeEventListener('click', schedule, { capture: true });
        CSS.highlights.delete(ERR); CSS.highlights.delete(WARN);
        marks = new Map();
        hideTip();
        const st = document.getElementById('qa-spell-style'); if (st) st.remove();
    }

    // Runs ONLY on the sites listed in Settings (qaSpellDomains) - every other site is never
    // sent to the AI, so tokens are spent on the test sites alone. A listed site covers its
    // sub-domains. Empty list = runs nowhere.
    let enabled = false, domains = [];
    const siteAllowed = () => {
        const h = location.hostname.toLowerCase();
        return domains.some((d) => h === d || h.endsWith('.' + d));
    };
    const apply = () => { if (enabled && siteAllowed()) start(); else if (on) stop(); };
    try {
        chrome.storage.local.get(['qaSpellCheck', 'qaSpellDomains'], (r) => {
            void chrome.runtime.lastError;
            enabled = !!(r && r.qaSpellCheck); domains = (r && r.qaSpellDomains) || [];
            apply();
        });
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area !== 'local' || (!ch.qaSpellCheck && !ch.qaSpellDomains)) return;
            if (ch.qaSpellCheck) enabled = !!ch.qaSpellCheck.newValue;
            if (ch.qaSpellDomains) domains = ch.qaSpellDomains.newValue || [];
            apply();
        });
    } catch (e) { }
})();
