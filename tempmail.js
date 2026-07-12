// Temp Mail tab - a disposable inbox (api.mail.tm), ported into QA-Toolbox
// from a standalone extension and rebranded to the toolkit's look. Scoped in
// an IIFE so nothing leaks into popup.js's globals. Storage keys and the
// IndexedDB name are namespaced (tm*) so they can't collide with the rest of
// the toolkit. The toolbar action badge is deliberately NOT used for unread
// count - the recording timer already owns it - so unread shows on the Mail
// tab button and in the inbox header instead.
(function tempMail() {
    const API_URL = 'https://api.mail.tm';

    const state = { account: null, token: null, messages: [], started: false, pollTimer: null };

    const $ = (id) => document.getElementById(id);
    const addressEl = $('tm-address');
    const copyBtn = $('tm-copy-btn');
    const newBtn = $('tm-new-btn');
    const refreshBtn = $('tm-refresh-btn');
    const listEl = $('tm-list');
    const unreadEl = $('tm-unread');
    const tabBadge = $('mailTabBadge');
    const mailTabBtn = document.querySelector('.tab-btn[data-tab="mail"]');
    if (!addressEl || !mailTabBtn) return; // markup not present

    // ── IndexedDB (mirrors the server inbox locally so the list survives popup
    //    reopens and shows instantly before the network round-trip) ──
    const DB_NAME = 'QAToolboxTempMail';
    let dbInstance = null;
    function initDB() {
        if (dbInstance) return Promise.resolve(dbInstance);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            };
            req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
            req.onerror = () => reject(req.error);
        });
    }
    async function dbOp(mode, data = null) {
        const db = await initDB();
        const tx = db.transaction('messages', mode === 'getAll' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('messages');
        return new Promise((resolve, reject) => {
            let r;
            if (mode === 'put') r = store.put(data);
            else if (mode === 'delete') r = store.delete(data);
            else if (mode === 'get') r = store.get(data);
            else r = store.getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }

    // ── account ──
    function loadAccount() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['tmAccount', 'tmToken'], (res) => {
                state.account = res.tmAccount || null;
                state.token = res.tmToken || null;
                resolve(!!state.token);
            });
        });
    }

    async function createNewAccount() {
        try {
            addressEl.textContent = 'Generating…';
            const domains = await (await fetch(`${API_URL}/domains`)).json();
            const domain = domains['hydra:member'][0].domain;
            const address = `user_${Math.random().toString(36).slice(2, 7)}@${domain}`;
            const password = Math.random().toString(36).slice(2, 12);

            const account = await (await fetch(`${API_URL}/accounts`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, password })
            })).json();

            const { token } = await (await fetch(`${API_URL}/token`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, password })
            })).json();

            state.account = Object.assign({ address }, account);
            state.token = token;
            chrome.storage.local.set({ tmAccount: state.account, tmToken: token });

            addressEl.textContent = state.account.address;
            state.messages = [];
            renderMessages();
            updateCounts();
        } catch (err) {
            console.error('Temp Mail: account creation error', err);
            addressEl.textContent = 'Error creating email';
        }
    }

    // ── messages ──
    async function fetchMessages() {
        if (!state.token) return;
        try {
            const data = await (await fetch(`${API_URL}/messages`, {
                headers: { 'Authorization': `Bearer ${state.token}` }
            })).json();
            const server = data['hydra:member'] || [];
            for (const msg of server) {
                msg.accountId = state.account && state.account.id;
                const local = await dbOp('get', msg.id);
                if (!local) await dbOp('put', msg);
                else if (local.seen !== msg.seen || local.accountId !== msg.accountId) await dbOp('put', { ...local, ...msg });
            }
            state.messages = (await dbOp('getAll')) || [];
            state.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            renderMessages();
            updateCounts();
        } catch (err) {
            console.error('Temp Mail: fetch error', err);
        }
    }

    const formatDate = (s) => {
        const d = new Date(s);
        const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
        return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${time}`;
    };
    const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
    const truncate = (t, n) => !t ? '' : (t.length > n ? t.slice(0, n) + '…' : t);

    function activeMessages() {
        return state.messages.filter((m) => !state.account || m.accountId === state.account.id);
    }

    function renderMessages() {
        listEl.innerHTML = '';
        const msgs = activeMessages();
        if (!msgs.length) {
            listEl.innerHTML = `<div class="tm-empty"><i class="fas fa-inbox"></i>Waiting for new messages…</div>`;
            return;
        }
        for (const msg of msgs) {
            const isArabic = /[؀-ۿ]/.test((msg.subject || '') + (msg.intro || ''));
            const item = document.createElement('div');
            item.className = `tm-msg ${msg.seen ? 'seen' : 'new'} ${isArabic ? 'rtl' : ''}`;
            item.innerHTML = `
                <div class="tm-msg-top">
                    <div class="tm-from">${esc(msg.from ? (msg.from.name || msg.from.address) : 'Unknown')}</div>
                    <div class="tm-time">${esc(formatDate(msg.createdAt))}</div>
                </div>
                <div class="tm-subj" title="${esc(msg.subject || '')}">${esc(truncate(msg.subject || '(No Subject)', 60))}</div>
                <div class="tm-bottom">
                    <p class="tm-intro" title="${esc(msg.intro || '')}">${esc(truncate(msg.intro || '', 80))}</p>
                    <button class="tm-dl" title="Download EML"><i class="fas fa-download"></i></button>
                    <button class="tm-del" title="Delete this email"><i class="fas fa-trash"></i></button>
                </div>`;
            item.addEventListener('click', (e) => {
                if (e.target.closest('.tm-dl, .tm-del')) return;
                openMessage(msg);
            });
            item.querySelector('.tm-dl').addEventListener('click', (e) => {
                e.stopPropagation();
                downloadEML(msg.id, msg.subject || 'email');
            });
            item.querySelector('.tm-del').addEventListener('click', (e) => {
                e.stopPropagation();
                item.classList.add('deleting');       // it is going; say so at once
                deleteMessage(msg);
            });
            listEl.appendChild(item);
        }
    }

    // ── deleting ────────────────────────────────────────────────────────────
    // On the SERVER, not just here. Deleting only our own copy would look right for
    // about ten seconds: the next fetch sees a message the local store does not have
    // and puts it straight back (see fetchMessages). The inbox lives at mail.tm; a
    // message is only gone once it is gone from there.
    async function deleteOnServer(id) {
        const res = await fetch(`${API_URL}/messages/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${state.token}` },
        });
        // 404 = already gone. That is the outcome we wanted anyway.
        if (!res.ok && res.status !== 404) throw new Error(`mail.tm said ${res.status}`);
    }

    async function deleteMessage(msg) {
        try {
            await deleteOnServer(msg.id);
            await dbOp('delete', msg.id);
            state.messages = state.messages.filter((m) => m.id !== msg.id);
            renderMessages();
            updateCounts();
        } catch (e) {
            console.error('Could not delete the message:', e);
            tmToast('Could not delete that message', true);
        }
    }

    async function deleteAll() {
        const msgs = activeMessages();
        if (!msgs.length) return;

        const btn = document.getElementById('tm-clear-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

        let failed = 0;
        for (const m of msgs) {
            try {
                await deleteOnServer(m.id);
                await dbOp('delete', m.id);
            } catch (e) {
                failed++;
            }
        }
        state.messages = (await dbOp('getAll')) || [];
        renderMessages();
        updateCounts();

        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash"></i>'; }
        if (failed) tmToast(`${failed} message${failed > 1 ? 's' : ''} could not be deleted`, true);
        else tmToast(`Deleted ${msgs.length} message${msgs.length > 1 ? 's' : ''}`);
    }

    // A word from the tool itself. The panel's own toast lives in popup.js and this
    // file is loaded after it, so it is there - but not worth crashing over if the
    // mail tab is ever used somewhere else.
    function tmToast(text, isError) {
        if (typeof showToastMessage === 'function') showToastMessage(text, isError ? 'error' : 'success');
    }

    async function openMessage(msg) {
        // Beside the tab you are on, like everything else the panel opens - not at
        // the far end of the strip (see qaOpenTabBeside in popup.js).
        qaOpenTabBeside(`mail-view.html?id=${encodeURIComponent(msg.id)}`);
        if (!msg.seen) {
            msg.seen = true;
            await dbOp('put', msg);
            renderMessages();
            updateCounts();
        }
    }

    function updateCounts() {
        const unread = activeMessages().filter((m) => !m.seen).length;
        unreadEl.textContent = String(unread);
        if (tabBadge) {
            tabBadge.textContent = String(unread);
            tabBadge.style.display = unread > 0 ? '' : 'none';
        }
        // Let the background alarm's stored count stay in sync with what the
        // popup knows, so the tab badge is right even before the next poll.
        chrome.storage.local.set({ tmUnreadCount: unread });
    }

    // ── EML download (anchor+blob, matching the toolkit's no-downloads-perm
    //    convention - never chrome.downloads) ──
    function buildEML(m) {
        const from = m.from ? `${m.from.name || ''} <${m.from.address}>`.trim() : 'Unknown <unknown@unknown>';
        const to = m.to ? m.to.map((t) => `${t.name || ''} <${t.address}>`.trim()).join(', ') : '';
        const date = m.createdAt ? new Date(m.createdAt).toUTCString() : new Date().toUTCString();
        const subject = m.subject || '(No Subject)';
        const html = (m.html && m.html.length) ? m.html[0] : '';
        const text = m.text || '';
        let eml = `From: ${from}\r\n`;
        if (to) eml += `To: ${to}\r\n`;
        eml += `Date: ${date}\r\nSubject: ${subject}\r\nMessage-ID: <${m.id}@mail.tm>\r\nMIME-Version: 1.0\r\n`;
        if (html) {
            eml += `Content-Type: multipart/alternative; boundary="b123"\r\n\r\n--b123\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n--b123\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n--b123--\r\n`;
        } else {
            eml += `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`;
        }
        return eml;
    }

    async function downloadEML(id, subject) {
        try {
            if (!state.token) return;
            const res = await fetch(`${API_URL}/messages/${id}`, {
                headers: { 'Authorization': `Bearer ${state.token}`, 'Accept': 'application/json' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const message = await res.json();
            const blob = new Blob([buildEML(message)], { type: 'message/rfc822' });
            const url = URL.createObjectURL(blob);
            const safe = (subject || 'email').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'email';
            const a = document.createElement('a');
            a.href = url; a.download = `${safe}.eml`;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
        } catch (err) {
            console.error('Temp Mail: download error', err);
            alert(`Could not download this email: ${err.message}`);
        }
    }

    function copyAddress() {
        const text = addressEl.textContent;
        if (!text || text.includes('…')) return;
        navigator.clipboard.writeText(text).then(() => {
            const icon = copyBtn.querySelector('i');
            const prev = icon.className;
            icon.className = 'fas fa-check';
            copyBtn.style.color = '#10b981';
            setTimeout(() => { icon.className = prev; copyBtn.style.color = ''; }, 1600);
        });
    }

    function startPolling() {
        if (state.pollTimer) return;
        fetchMessages();
        state.pollTimer = setInterval(fetchMessages, 15000);
    }

    // ── lazy init: only spin up (and create an account) the first time the
    //    user actually opens the Mail tab ──
    async function ensureStarted() {
        if (state.started) return;
        state.started = true;
        copyBtn.addEventListener('click', copyAddress);
        newBtn.addEventListener('click', createNewAccount);
        refreshBtn.addEventListener('click', fetchMessages);

        // Delete every email. Asked first: this is not undoable - the messages go
        // from mail.tm itself, not just from our copy of the list.
        const clearBtn = $('tm-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            const n = activeMessages().length;
            if (!n) return;
            const ok = window.confirm(
                `Delete all ${n} email${n > 1 ? 's' : ''} in this inbox?\n\nThey are deleted from the mail server too, so this cannot be undone.`);
            if (ok) deleteAll();
        });

        const has = await loadAccount();
        if (has && state.account) {
            addressEl.textContent = state.account.address;
            state.messages = (await dbOp('getAll')) || [];
            state.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            renderMessages();
            updateCounts();
            startPolling();
        } else {
            await createNewAccount();
            startPolling();
        }
    }

    mailTabBtn.addEventListener('click', ensureStarted);
    // If the toolkit restored the Mail tab as the last-open tab on load, it's
    // already visible without a click - start immediately in that case.
    if (mailTabBtn.classList.contains('active')) ensureStarted();

    // Keep the tab badge live from the background alarm's count even while the
    // user is on another tab and hasn't opened Mail this session.
    chrome.storage.local.get(['tmUnreadCount'], (r) => {
        const n = r.tmUnreadCount || 0;
        if (tabBadge && n > 0) { tabBadge.textContent = String(n); tabBadge.style.display = ''; }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.tmUnreadCount && tabBadge) {
            const n = ch.tmUnreadCount.newValue || 0;
            tabBadge.textContent = String(n);
            tabBadge.style.display = n > 0 ? '' : 'none';
        }
    });
})();
