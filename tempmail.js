// Temp Mail tab - a disposable inbox (api.mail.tm), ported into QA-Toolbox
// from a standalone extension and rebranded to the toolkit's look. Scoped in
// an IIFE so nothing leaks into popup.js's globals. Storage keys and the
// IndexedDB name are namespaced (tm*) so they can't collide with the rest of
// the toolkit. The toolbar action badge is deliberately NOT used for unread
// count - the recording timer already owns it - so unread shows on the Mail
// tab button and in the inbox header instead.
(function tempMail() {
    const API_URL = 'https://api.mail.tm';

    // Several inboxes at once, not one. "Generate new email" used to overwrite the
    // account AND its token - the old inbox went on existing at mail.tm with nobody
    // holding the key. Registering three users meant losing the first two mailboxes.
    // They are kept now, named, and switched between.
    const state = {
        inboxes: [],        // [{ id, address, token, name, createdAt }]
        activeId: null,
        account: null,      // the active inbox, in the shape the rest of the file expects
        token: null,
        messages: [],
        search: '',
        started: false,
        pollTimer: null,
    };

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

    // ── inboxes ──
    // tmAccount/tmToken are still written for whichever inbox is active: the worker's
    // poller reads them, and so would anything else built before this.
    function saveInboxes() {
        const active = state.inboxes.find((i) => i.id === state.activeId) || null;
        state.account = active ? { id: active.id, address: active.address } : null;
        state.token = active ? active.token : null;
        chrome.storage.local.set({
            tmInboxes: state.inboxes,
            tmActiveId: state.activeId,
            tmAccount: state.account,
            tmToken: state.token,
        });
    }

    function loadInboxes() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['tmInboxes', 'tmActiveId', 'tmAccount', 'tmToken'], (res) => {
                state.inboxes = Array.isArray(res.tmInboxes) ? res.tmInboxes : [];

                // The inbox you already had, from before there could be more than one.
                // Carried over rather than abandoned - it is a live mailbox and this
                // is the only copy of its key.
                if (!state.inboxes.length && res.tmAccount && res.tmToken) {
                    state.inboxes = [{
                        id: res.tmAccount.id || 'inbox_' + Date.now(),
                        address: res.tmAccount.address,
                        token: res.tmToken,
                        name: '',
                        createdAt: Date.now(),
                    }];
                    state.activeId = state.inboxes[0].id;
                    saveInboxes();
                    resolve(true);
                    return;
                }

                state.activeId = res.tmActiveId && state.inboxes.some((i) => i.id === res.tmActiveId)
                    ? res.tmActiveId
                    : (state.inboxes[0] ? state.inboxes[0].id : null);

                const active = state.inboxes.find((i) => i.id === state.activeId) || null;
                state.account = active ? { id: active.id, address: active.address } : null;
                state.token = active ? active.token : null;
                resolve(!!state.token);
            });
        });
    }

    async function switchInbox(id) {
        if (id === state.activeId) return;
        state.activeId = id;
        saveInboxes();
        addressEl.textContent = state.account ? state.account.address : '…';
        state.search = '';
        const searchEl = $('tm-search');
        if (searchEl) searchEl.value = '';
        state.messages = (await dbOp('getAll')) || [];
        state.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderInboxes();
        renderMessages();
        updateCounts();
        fetchMessages();
    }

    // Forgetting an inbox drops OUR key to it. The mailbox itself stays at mail.tm,
    // unreachable - so this is a one-way door and it says so.
    async function forgetInbox(id) {
        const box = state.inboxes.find((i) => i.id === id);
        if (!box) return;
        const label = box.name ? `"${box.name}" (${box.address})` : box.address;
        const yes = await qaConfirm({
            title: 'Forget this inbox?',
            message: `${label}\n\nThe mailbox stays on the server but you lose the key to it — you won't be able to open it again.`,
            okText: 'Forget', danger: true, icon: 'fa-link-slash',
        });
        if (!yes) return;

        state.inboxes = state.inboxes.filter((i) => i.id !== id);
        // Its messages go too; they belong to an inbox that no longer exists here.
        for (const m of state.messages.filter((m) => m.accountId === id)) await dbOp('delete', m.id);
        state.messages = state.messages.filter((m) => m.accountId !== id);

        if (state.activeId === id) state.activeId = state.inboxes[0] ? state.inboxes[0].id : null;
        saveInboxes();

        addressEl.textContent = state.account ? state.account.address : 'No inbox';
        renderInboxes();
        renderMessages();
        updateCounts();
        if (!state.inboxes.length) createNewAccount();
    }

    async function renameInbox(id) {
        const box = state.inboxes.find((i) => i.id === id);
        if (!box) return;
        const name = await qaPrompt({
            title: 'Name this inbox', message: 'A label to tell your inboxes apart.',
            value: box.name || '', placeholder: 'e.g. admin, user1', okText: 'Save', icon: 'fa-pen',
        });
        if (name === null) return;
        box.name = name.trim();
        saveInboxes();
        renderInboxes();
    }

    // `desired` is the local part the user asked for, if any (e.g. "admin_test").
    // mail.tm refuses an address that already exists, so a taken one is retried with
    // a short suffix rather than failing in the user's face.
    async function createNewAccount(desired, label) {
        try {
            addressEl.textContent = 'Generating…';
            const domains = await (await fetch(`${API_URL}/domains`)).json();
            const domain = domains['hydra:member'][0].domain;

            const clean = String(desired || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
            let address, account, res;
            for (let attempt = 0; attempt < 4; attempt++) {
                const local = clean
                    ? (attempt === 0 ? clean : `${clean}${Math.random().toString(36).slice(2, 5)}`)
                    : `user_${Math.random().toString(36).slice(2, 7)}`;
                address = `${local}@${domain}`;
                const password = Math.random().toString(36).slice(2, 12);

                res = await fetch(`${API_URL}/accounts`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address, password }),
                });
                if (res.ok) {
                    account = await res.json();
                    const { token } = await (await fetch(`${API_URL}/token`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ address, password }),
                    })).json();

                    // Added, not swapped. The one you had is still there.
                    state.inboxes.push({
                        id: account.id, address, token,
                        name: (label || '').trim(), createdAt: Date.now(),
                    });
                    state.activeId = account.id;
                    saveInboxes();

                    addressEl.textContent = address;
                    state.search = '';
                    const searchEl = $('tm-search');
                    if (searchEl) searchEl.value = '';
                    renderInboxes();
                    renderMessages();
                    updateCounts();
                    fetchMessages();
                    return;
                }
                if (res.status !== 422) break;      // 422 = that address is taken
            }
            addressEl.textContent = 'Could not create that address';
            tmToast(clean ? `"${clean}" is taken - try another name` : 'Could not create an inbox', true);
        } catch (err) {
            console.error('Temp Mail: account creation error', err);
            addressEl.textContent = 'Error creating email';
        }
    }

    // ── messages ──
    // The inbox to fetch is captured at the START, not read again when the response
    // lands. Switching quickly used to corrupt the store: a fetch begun for inbox A
    // would resolve after you'd moved to B, tag A's messages with B's id (it read
    // the CURRENT active account), and they'd surface under the wrong inbox until a
    // later fetch re-tagged them. Now every message is tagged with the inbox its
    // token actually belongs to, and the list only repaints if you're still on it.
    async function fetchMessages() {
        const box = state.inboxes.find((i) => i.id === state.activeId);
        if (!box || !box.token) return;
        const token = box.token;
        const ownerId = box.id;
        try {
            const data = await (await fetch(`${API_URL}/messages`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })).json();
            const server = data['hydra:member'] || [];
            for (const msg of server) {
                msg.accountId = ownerId;     // the inbox we fetched, never "whatever is active now"
                const local = await dbOp('get', msg.id);
                if (!local) await dbOp('put', msg);
                else if (local.seen !== msg.seen || local.accountId !== msg.accountId) await dbOp('put', { ...local, ...msg });
            }
            state.messages = (await dbOp('getAll')) || [];
            state.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            // Per-inbox unread badges are always safe to refresh; the message list
            // and the header count only if this fetch is for the inbox on screen.
            renderInboxes();
            if (state.activeId === ownerId) {
                renderMessages();
                updateCounts();
            }
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

    // Everything in the inbox you are looking at.
    function activeMessages() {
        return state.messages.filter((m) => !state.account || m.accountId === state.account.id);
    }

    // ...and what survives the search box. Kept apart from activeMessages: deleting
    // "all" must mean the whole inbox, not just whatever the search happens to show.
    function visibleMessages() {
        const q = state.search.trim().toLowerCase();
        if (!q) return activeMessages();
        return activeMessages().filter((m) => {
            const from = m.from ? `${m.from.name || ''} ${m.from.address || ''}` : '';
            return (`${m.subject || ''} ${m.intro || ''} ${from}`).toLowerCase().includes(q);
        });
    }

    // The inbox switcher. Every mailbox you have made, with its name, its address and
    // how many unread it is holding - so you can see where the mail landed without
    // opening each one.
    function renderInboxes() {
        const wrap = $('tm-inboxes');
        if (!wrap) return;
        wrap.innerHTML = '';

        for (const box of state.inboxes) {
            const unread = state.messages.filter((m) => m.accountId === box.id && !m.seen).length;
            const row = document.createElement('div');
            row.className = 'tm-box' + (box.id === state.activeId ? ' active' : '');
            row.innerHTML = `
                <i class="fas ${box.id === state.activeId ? 'fa-circle-dot' : 'fa-inbox'}"></i>
                <div class="tm-box-meta">
                    <div class="tm-box-name">${esc(box.name || box.address.split('@')[0])}</div>
                    <div class="tm-box-addr" title="${esc(box.address)}">${esc(box.address)}</div>
                </div>
                ${unread ? `<span class="tm-box-unread">${unread}</span>` : ''}
                <button class="tm-box-btn tm-box-rename" title="Name this inbox"><i class="fas fa-pen"></i></button>
                <button class="tm-box-btn tm-box-forget" title="Forget this inbox"><i class="fas fa-xmark"></i></button>`;

            row.addEventListener('click', (e) => {
                if (e.target.closest('.tm-box-btn')) return;
                switchInbox(box.id);
            });
            row.querySelector('.tm-box-rename').addEventListener('click', (e) => { e.stopPropagation(); renameInbox(box.id); });
            row.querySelector('.tm-box-forget').addEventListener('click', (e) => { e.stopPropagation(); forgetInbox(box.id); });
            wrap.appendChild(row);
        }
    }

    function renderMessages() {
        listEl.innerHTML = '';
        const msgs = visibleMessages();
        if (!msgs.length) {
            // "Nothing matched" and "nothing has arrived" are different things, and
            // telling them apart is the difference between waiting and retyping.
            listEl.innerHTML = state.search.trim()
                ? `<div class="tm-empty"><i class="fas fa-magnifying-glass"></i>No emails match &ldquo;${esc(state.search)}&rdquo;</div>`
                : `<div class="tm-empty"><i class="fas fa-inbox"></i>Waiting for new messages…</div>`;
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
            tmToast(`Could not download this email: ${err.message}`, true);
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

        // "New inbox" takes whatever name is in the field and ADDS a mailbox - it
        // does not throw the current one away. The field is cleared afterwards so
        // the next one doesn't accidentally reuse the last name.
        const wantedEl = $('tm-wanted');
        const makeInbox = () => {
            const desired = wantedEl ? wantedEl.value.trim() : '';
            createNewAccount(desired, desired);   // name it after what they typed
            if (wantedEl) wantedEl.value = '';
        };
        newBtn.addEventListener('click', makeInbox);
        if (wantedEl) wantedEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') makeInbox(); });

        // Spin the icon while a manual refresh runs (and hold it for at least a
        // beat) so pressing it clearly DOES something, even when the fetch is
        // instant. The 15s auto-poll stays silent - only the click spins.
        refreshBtn.addEventListener('click', async () => {
            if (refreshBtn.classList.contains('loading')) return;
            const icon = refreshBtn.querySelector('i');
            refreshBtn.classList.add('loading');
            const started = Date.now();
            try { await fetchMessages(); }
            finally {
                const rest = 550 - (Date.now() - started);
                setTimeout(() => refreshBtn.classList.remove('loading'), rest > 0 ? rest : 0);
            }
        });

        // Search filters the list as you type; both the inline × and the tab both
        // reflect the same state.search.
        const searchEl = $('tm-search');
        const searchWrap = searchEl ? searchEl.closest('.tm-search-wrap') : null;
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                state.search = searchEl.value;
                if (searchWrap) searchWrap.classList.toggle('has', !!searchEl.value);
                renderMessages();
            });
        }
        const searchClear = $('tm-search-clear');
        if (searchClear) searchClear.addEventListener('click', () => {
            state.search = '';
            if (searchEl) searchEl.value = '';
            if (searchWrap) searchWrap.classList.remove('has');
            renderMessages();
            if (searchEl) searchEl.focus();
        });

        // Delete every email. Asked first: this is not undoable - the messages go
        // from mail.tm itself, not just from our copy of the list.
        const clearBtn = $('tm-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', async () => {
            const n = activeMessages().length;
            if (!n) return;
            const ok = await qaConfirm({
                title: `Delete all ${n} email${n > 1 ? 's' : ''}?`,
                message: 'They are deleted from the mail server too, so this cannot be undone.',
                okText: 'Delete all', danger: true, icon: 'fa-trash',
            });
            if (ok) deleteAll();
        });

        const has = await loadInboxes();
        if (has && state.account) {
            addressEl.textContent = state.account.address;
            state.messages = (await dbOp('getAll')) || [];
            state.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            renderInboxes();
            renderMessages();
            updateCounts();
            startPolling();
        } else {
            await createNewAccount();
            renderInboxes();
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
