// Spelling & language check - the AI side (service worker).
// The page side (modules/spellcheck.js) sends the visible texts of a page; Claude reads each
// one IN CONTEXT (a dictionary can't tell خدمه - a misspelled خدمة - from عمله "his work") and
// returns only the real mistakes. Every text's result is cached - in memory and in
// chrome.storage.local - so a text is sent ONCE: "Save", "Cancel", a page's labels, a page
// you revisit… only new text costs a request.
//
// importScripted by background.js (needs AI_CONFIG from config.js).
(function (root) {
    'use strict';
    const CACHE_KEY = 'qaSpellAiCache';      // { [`${lang}\0${text}`]: issues[] }
    const CACHE_MAX = 6000;
    // Bump when the prompt changes: answers given under the old instructions are dropped -
    // otherwise texts already cached as "no mistakes" would never be re-checked.
    const CACHE_VERSION = 6;
    // The spelling check's own model (the other tools keep AI_CONFIG.model). Changing it also
    // bumps CACHE_VERSION so pages are re-read by the new model.
    const SPELL_MODEL = 'claude-sonnet-5-5';
    const VERSION_KEY = 'qaSpellAiCacheVersion';
    let cache = null;                        // Map, loaded lazily from storage

    async function loadCache() {
        if (cache) return cache;
        const r = await chrome.storage.local.get([CACHE_KEY, VERSION_KEY]);
        const fresh = r[VERSION_KEY] === CACHE_VERSION;
        cache = new Map(fresh ? Object.entries(r[CACHE_KEY] || {}) : []);
        if (!fresh) await chrome.storage.local.set({ [CACHE_KEY]: {}, [VERSION_KEY]: CACHE_VERSION });
        return cache;
    }
    // Saved right away after each batch: a delayed save could be lost when the service
    // worker is shut down, and the texts would be paid for again.
    function saveCache() {
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // keep the newest (insertion order)
        return chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
    }

    const schema = {
        type: 'object',
        properties: {
            results: {
                type: 'array',
                description: 'Only the texts that contain at least one mistake',
                items: {
                    type: 'object',
                    properties: {
                        i: { type: 'integer', description: 'The number of the text' },
                        issues: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    word: { type: 'string', description: 'The wrong word EXACTLY as it is written in the text (same letters, so it can be found)' },
                                    type: { type: 'string', enum: ['spelling', 'hamza', 'grammar'] },
                                    fix: { type: 'string', description: 'The corrected word' },
                                    severity: { type: 'string', enum: ['error', 'warning'], description: 'warning = probably wrong but could be correct in some reading' },
                                    note: { type: 'string', description: 'A very short reason, in the language of the text' }
                                },
                                required: ['word', 'type', 'fix', 'severity', 'note'],
                                additionalProperties: false
                            }
                        }
                    },
                    required: ['i', 'issues'],
                    additionalProperties: false
                }
            }
        },
        required: ['results'],
        additionalProperties: false
    };

    async function askClaude(texts, lang) {
        const prompt = [
            'You are proofreading the visible text of a web application under QA testing.',
            `The page language is ${lang === 'ar' ? 'Arabic' : 'English'}.`,
            'For each numbered text below, report ONLY real mistakes:',
            '- spelling: a misspelled Arabic or English word (including ة written as ه, ى/ي confusion, doubled or missing letters).',
            '- hamza: a wrong or missing hamza (الادارة → الإدارة, إستخدام → استخدام, إقرأ → اقرأ).',
            '- grammar: a clear grammar/agreement mistake inside the text.',
            // The user turned OFF the wrong-language check: English on an Arabic page (or the
            // reverse) is easy to see by eye. Text in the other language is still spell-checked.
            'Text written in the other language is NOT a mistake (English words on an Arabic page, Arabic on an English page) - never report a word just for its language; only check its spelling.',
            'Do NOT report: names of people, companies, places, products or brands; acronyms (PDF, ID, API, SAR); codes, IDs, numbers, dates, emails, URLs; British vs American spelling; stylistic preferences.',
            'Judge each word in the context of its text. When a word could be correct in some reading (e.g. عمله "his work" vs a misspelled عملة), use severity "warning"; use "error" only when it is certainly wrong. If unsure, do not report it.',
            '"word" must be copied exactly from the text so it can be located. "fix" must DIFFER from "word" - for a capitalization issue write the corrected case (accompanying → Accompanying). Return only texts that have mistakes.',
            '',
            ...texts.map((t, i) => `${i + 1}. ${t}`)
        ].join('\n');

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': AI_CONFIG.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
                // if a safety classifier declines, the server retries on a fallback model
                // instead of failing the check
                'anthropic-beta': 'server-side-fallback-2026-07-01'
            },
            body: JSON.stringify({
                model: SPELL_MODEL,
                // medium effort thinks more than low; the room is for that thinking + the JSON
                max_tokens: 16000,
                output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
                fallbacks: 'default',
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!response.ok) {
            let message = `Claude API error (${response.status})`;
            try { const err = await response.json(); if (err && err.error && err.error.message) message = err.error.message; } catch (e) { }
            throw new Error(message);
        }
        const data = await response.json();
        if (data.stop_reason === 'refusal') throw new Error('The AI declined this request');
        const block = (data.content || []).find((b) => b.type === 'text');
        if (!block || !block.text) throw new Error(data.stop_reason === 'max_tokens' ? 'The AI ran out of room before answering' : 'Empty AI response');
        return JSON.parse(block.text).results || [];
    }

    // texts: string[] (unique, visible page texts) -> { [text]: issues[] } for texts WITH mistakes
    // -> { issues: { [text]: issues[] }, failed: [texts whose batch failed], error }
    async function check(texts, lang) {
        if (!AI_CONFIG || !AI_CONFIG.apiKey) throw new Error('no_api_key');
        const c = await loadCache();
        const out = {};
        const failed = [];
        let error = '';
        const todo = [];
        for (const t of texts || []) {
            const k = `${lang}\0${t}`;
            if (c.has(k)) { const v = c.get(k); if (v.length) out[t] = v; }
            else todo.push(t);
        }
        // batches of ~25 texts / ~3000 characters per request (smaller = a failure loses less)
        for (let i = 0; i < todo.length;) {
            const batch = []; let chars = 0;
            while (i < todo.length && batch.length < 25 && (chars + todo[i].length < 3000 || !batch.length)) { chars += todo[i].length; batch.push(todo[i++]); }
            // One failed batch must not throw away the batches that worked - its texts are
            // reported back as failed (and NOT cached) so the page retries them later.
            let results;
            try { results = await askClaude(batch, lang); }
            catch (e) { failed.push(...batch); error = e.message || String(e); continue; }
            const byIndex = new Map(results.map((r) => [r.i, r.issues || []]));
            batch.forEach((t, j) => {
                // keep only issues whose word really appears in the text (so it can be marked)
                // ...and drop "fixes" that change nothing (accompanying → accompanying)
                const issues = (byIndex.get(j + 1) || []).filter((x) => x.word && t.includes(x.word) && x.fix !== x.word);
                c.delete(`${lang}\0${t}`); c.set(`${lang}\0${t}`, issues);
                if (issues.length) out[t] = issues;
            });
            await saveCache();
        }
        return { issues: out, failed, error };
    }

    // Second gate (the page side checks too): only the sites listed in Settings may spend
    // tokens - a request from any other site is refused here.
    async function siteAllowed(sender) {
        let host = '';
        try { host = new URL(sender && sender.tab && sender.tab.url).hostname.toLowerCase(); } catch (e) { return false; }
        const { qaSpellDomains = [] } = await chrome.storage.local.get(['qaSpellDomains']);
        return qaSpellDomains.some((d) => host === d || host.endsWith('.' + d));
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request && request.action === 'spellCheckAi') {
            siteAllowed(sender).then((ok) => {
                if (!ok) throw new Error('site not in the spelling-check list');
                return check(request.texts, request.lang);
            }).then((r) => sendResponse({ ok: true, issues: r.issues, failed: r.failed, error: r.error }))
                .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
            return true;
        }
        // A corrected text the page verified itself (only the suggested fixes were applied):
        // remember its result too, so it is never sent.
        if (request && request.action === 'spellCachePut') {
            loadCache().then((c) => {
                const k = `${request.lang}\0${request.text}`;
                c.delete(k); c.set(k, Array.isArray(request.issues) ? request.issues : []);
                return saveCache();
            }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
            return true;
        }
        return false;
    });

    root.SpellCheckAi = { check };
})(typeof self !== 'undefined' ? self : globalThis);
