// Sessions tab UI - Quick login switch (Snapshot & Swap). Save each user's
// login once (its cookies), then switch between saved logins in one click - no
// retyping credentials, and no "being debugged" bar. The heavy lifting lives in
// the service worker (session-swap.js); this only sends messages and renders.
(function sessionsTab() {
    const $ = (id) => document.getElementById(id);
    const tabBtn = document.querySelector('.tab-btn[data-tab="sessions"]');
    const swSite = $('sw-site');
    const swSaveBtn = $('sw-save');
    const swList = $('sw-list');
    if (!swList || !tabBtn) return;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };

    // One attempt. Returns null when the worker gave us NOTHING (dormant MV3 worker
    // that swallowed the message, mid-restart, port closed…), so the caller can tell
    // "no answer" apart from a real reply.
    const sendOnce = (msg) => new Promise((res) => {
        try {
            chrome.runtime.sendMessage(msg, (r) => {
                const dead = chrome.runtime.lastError || r === undefined;
                res(dead ? null : r);
            });
        } catch (e) { res(null); }
    });

    // The click-twice bug: an idle MV3 worker can drop the first message, so the
    // first press did nothing and you pressed again. Waking it first was not enough.
    // Now we simply RETRY when there was no answer. Every action we retry is
    // idempotent - save also carries a stable operation id, so a retry cannot create
    // a duplicate snapshot even if the first reply was lost.
    const send = async (msg, { retries = 3 } = {}) => {
        for (let i = 0; i <= retries; i++) {
            const r = await sendOnce(msg);
            if (r) return r;
            await new Promise((s) => setTimeout(s, 120));   // let the worker boot
        }
        return { ok: false, error: 'Extension service worker did not respond' };
    };
    const activeTab = () => new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t && t[0])));

    // The tab to act on, resolved AT CLICK TIME. The old code captured the tab when
    // the list was rendered and reused it - so if you'd since switched tab or the
    // page had navigated, Update/Switch ran against a stale tab id and appeared to do
    // nothing. Always ask for the live one.
    async function currentSite() {
        const t = await activeTab();
        if (!t || !/^https?:/i.test(t.url || '')) return null;
        return t;
    }
    const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
    const timeAgo = (ts) => {
        const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    };

    // Name prompt: the shared in-panel dialog (qaPrompt in popup.js).
    const swPrompt = (title, value) => qaPrompt({ title, value: value || '', placeholder: 'e.g. Admin', okText: 'Save', icon: 'fa-floppy-disk' })
        .then((v) => (v || '').trim() || null);

    // Username/password dialog for one saved login (the automatic re-login fallback).
    // Built on the shared .qa-dialog styles. Resolves 'save' | 'login' | 'remove' | null
    // with the typed values.
    function credsDialog(s, info, defaultUrl) {
        return new Promise((resolve) => {
            const root = document.createElement('div');
            root.className = 'qa-dialog show';
            root.innerHTML = `
                <div class="qa-dialog-box">
                    <div class="qa-dialog-head"><span class="qa-dialog-ic"><i class="fas fa-key"></i></span><span class="qa-dialog-title">Login details &mdash; ${esc(s.name)}</span></div>
                    <div class="qa-dialog-msg" style="margin-bottom:12px;">Used only when this saved session has expired: the tool opens the login page and signs in for you. Stored in this browser only.</div>
                    <input class="qa-dialog-input" data-f="username" placeholder="Username or email" autocomplete="off" style="margin-bottom:8px;">
                    <input class="qa-dialog-input" data-f="password" type="password" placeholder="${info && info.hasPassword ? '•••••• (saved - leave empty to keep)' : 'Password'}" autocomplete="new-password" style="margin-bottom:8px;">
                    <input class="qa-dialog-input" data-f="loginUrl" placeholder="Login page address" autocomplete="off" style="margin-bottom:4px;">
                    <div style="font-size:10.5px;color:#64748b;margin:0 2px 14px;">Tip: open the login page first &mdash; its address is filled in for you.</div>
                    <!-- Four buttons don't fit one row in the side panel (they wrapped and
                         squeezed): the main action gets its own full-width row, the rest below. -->
                    <div class="qa-dialog-actions" style="flex-wrap:wrap;">
                        <button class="qa-dialog-btn qa-dialog-ok" data-a="login" style="flex:1 1 100%;white-space:nowrap;"><i class="fas fa-right-to-bracket" style="margin-right:6px;"></i>Save &amp; log in</button>
                        ${info ? '<button class="qa-dialog-btn qa-dialog-cancel" data-a="remove" style="margin-right:auto;color:#f87171;white-space:nowrap;">Remove</button>' : ''}
                        <button class="qa-dialog-btn qa-dialog-cancel" data-a="cancel" style="white-space:nowrap;${info ? '' : 'margin-left:auto;'}">Cancel</button>
                        <button class="qa-dialog-btn qa-dialog-cancel" data-a="save" style="white-space:nowrap;">Save</button>
                    </div>
                </div>`;
            document.body.appendChild(root);
            const field = (f) => root.querySelector(`[data-f="${f}"]`);
            field('username').value = (info && info.username) || '';
            field('loginUrl').value = (info && info.loginUrl) || defaultUrl || '';
            setTimeout(() => field(info && info.username ? 'password' : 'username').focus(), 30);
            const close = (action) => {
                const values = { username: field('username').value.trim(), password: field('password').value, loginUrl: field('loginUrl').value.trim() };
                root.remove();
                document.removeEventListener('keydown', onKey, true);
                resolve(action && action !== 'cancel' ? { action, values } : null);
            };
            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } else if (e.key === 'Enter') { e.preventDefault(); close('save'); } };
            document.addEventListener('keydown', onKey, true);
            root.addEventListener('mousedown', (e) => { if (e.target === root) close(null); });
            root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => close(b.dataset.a)));
        });
    }

    async function editCreds(s, fallbackUrl) {
        const got = await send({ action: 'swapGetCreds', id: s.id });
        const site = await currentSite();
        const r = await credsDialog(s, got && got.creds, (site && site.url) || fallbackUrl);
        if (!r) return;
        if (r.action === 'remove') {
            if (!(await qaConfirm({ title: 'Remove login details?', message: `Forget the username/password saved for "${s.name}"?`, okText: 'Remove', danger: true }))) return;
            const d = await send({ action: 'swapClearCreds', id: s.id });
            showToastMessage(d && d.ok ? 'Login details removed' : 'Could not remove: ' + ((d && d.error) || 'no response'), d && d.ok ? 'success' : 'error');
            render(); return;
        }
        const saved = await send({ action: 'swapSaveCreds', id: s.id, creds: r.values });
        if (!saved || !saved.ok) { showToastMessage('Could not save: ' + ((saved && saved.error) || 'no response'), 'error'); return; }
        if (r.action === 'save') { showToastMessage('Login details saved', 'success'); render(); return; }
        // Save & log in: sign in for real now, in the current tab.
        const tab = await currentSite();
        if (!tab) { showToastMessage('Open the website first', 'error'); return; }
        showToastMessage(`Logging in as "${s.name}"…`, 'info');
        const lr = await send({ action: 'swapRelogin', tab: { id: tab.id, url: tab.url }, id: s.id }, { retries: 0 });
        showToastMessage(lr && lr.ok ? `Logged in as "${s.name}"` : 'Login failed: ' + ((lr && lr.error) || 'no response'), lr && lr.ok ? 'success' : 'error');
        render();
    }

    // What went wrong on the last switch (see verifySwitch in session-swap.js).
    const PROBLEM = {
        expired: { label: 'Expired', tip: 'The saved session has expired. Log in as this user, then press Update - or add its login details (key) so it logs in by itself.' },
        'other-user': { label: 'Wrong user', tip: 'Switching opened a different user (SSO sign-in). Log in as this user, then press Update.' },
    };

    async function render() {
        const t = await activeTab();
        const url = t && t.url;
        const web = url && /^https?:/i.test(url);
        swSite.innerHTML = 'Current site: <b>' + (web ? esc(hostOf(url)) : '&mdash;') + '</b>';
        swSaveBtn.disabled = !web;
        if (!web) { swList.innerHTML = '<div class="sw-empty">Open a website to save its login.</div>'; return; }

        // Pass the site's tab id: the worker reads its storage to see WHO is signed
        // in, which is what keeps "Current" correct after a cookie rotation.
        const { snaps = [], error } = await send({ action: 'swapList', url, tabId: t.id });
        if (error) { swList.innerHTML = `<div class="sw-empty">Could not read saved logins: ${esc(error)}</div>`; return; }
        if (!snaps.length) { swList.innerHTML = '<div class="sw-empty">No saved logins for this site yet.</div>'; return; }
        swList.innerHTML = '';
        snaps.forEach((s) => {
            const card = document.createElement('div');
            card.className = 'sw-card';
            if (s.active) card.classList.add('sw-current');
            const activeLabel = 'Current';
            const rightBtn = s.active
                ? `<span class="sw-badge" title="${s.activeConfidence === 'assumed' ? 'Cookie-only login; identity could not be verified' : 'Verified from the page login identity'}">${activeLabel}</span>`
                : `<button class="sw-go">Switch</button>`;
            const prob = !s.active && PROBLEM[s.problem];
            if (prob) card.classList.add('sw-bad');
            // WHO this login is (from its token) beats a cookie count nobody needs.
            card.innerHTML = `
                <span class="sw-ico">${s.active ? '<i class="fas fa-circle-check"></i>' : '<i class="fas fa-user"></i>'}</span>
                <div class="sw-meta">
                    <div class="sw-name" title="${esc(s.name)}">${esc(s.name)}${prob ? ` <span class="sw-warn" title="${esc(prob.tip)}">${prob.label}</span>` : ''}</div>
                    <div class="sw-sub" title="${esc(s.user || '')}">${s.user ? esc(s.user) + ' · ' : ''}saved ${esc(timeAgo(s.createdAt))}</div>
                </div>
                ${rightBtn}
                <button class="sw-x sw-key${s.hasCreds ? ' on' : ''}" title="${s.hasCreds ? 'Login details saved - auto login when the session expires' : 'Add username/password for automatic login when the session expires'}"><i class="fas fa-key"></i></button>
                <button class="sw-x sw-ren" title="Rename"><i class="fas fa-pen"></i></button>
                <button class="sw-x sw-upd" title="Update: re-save this login from the session open in the tab now (use after it expires)"><i class="fas fa-rotate"></i></button>
                <button class="sw-x sw-del" title="Delete"><i class="fas fa-trash"></i></button>`;
            card.querySelector('.sw-key').addEventListener('click', () => editCreds(s, url));
            card.querySelector('.sw-ren').addEventListener('click', async () => {
                const name = await swPrompt('Rename saved login', s.name);
                if (!name || name === s.name) return;
                const site = await currentSite();
                const r = await send({ action: 'swapRename', url: site ? site.url : url, id: s.id, name });
                if (r && r.ok) render();
                else showToastMessage('Could not rename: ' + ((r && r.error) || 'no response'), 'error');
            });
            const updBtn = card.querySelector('.sw-upd');
            updBtn.addEventListener('click', async () => {
                if (updBtn.disabled) return;
                const site = await currentSite();          // LIVE tab, not the one from render
                if (!site) { showToastMessage('Open the website first', 'error'); return; }
                if (!s.active && !(await qaConfirm({
                    title: 'Replace saved login?',
                    message: `This replaces "${s.name}" with the login currently open in the tab.`,
                    okText: 'Replace', danger: true
                }))) return;
                updBtn.disabled = true;
                const r = await send({ action: 'swapUpdate', tab: { id: site.id, url: site.url }, id: s.id });
                if (r && r.ok) { showToastMessage(`Updated "${s.name}"`, 'success'); render(); }
                else { showToastMessage('Could not update: ' + ((r && r.error) || 'no response'), 'error'); updBtn.disabled = false; }
            });
            const goBtn = card.querySelector('.sw-go');
            if (goBtn) goBtn.addEventListener('click', async () => {
                if (goBtn.disabled) return;
                goBtn.disabled = true; goBtn.textContent = 'Switching…';
                const site = await currentSite();          // LIVE tab
                if (!site) { showToastMessage('Open the website first', 'error'); render(); return; }
                const r = await send({ action: 'swapRestore', tab: { id: site.id, url: site.url }, id: s.id });
                // Re-render instead of closing the panel: the tab navigates beside the
                // panel and the list updates to show the new Current. (In the side panel
                // closing programmatically is a no-op and froze "Switching…" on screen.)
                if (r && r.ok && r.relogged) showToastMessage(`Session had expired - logged in again as "${s.name}"`, 'success');
                else if (r && r.ok && r.problem) showToastMessage(r.reloginError ? 'Expired, and automatic login failed: ' + r.reloginError : (PROBLEM[r.problem] || PROBLEM.expired).tip, 'error');
                else if (r && r.ok) showToastMessage(`Switched to "${s.name}"`, 'success');
                else showToastMessage('Could not switch: ' + ((r && r.error) || 'no response'), 'error');
                render();
            });
            card.querySelector('.sw-del').addEventListener('click', async () => {
                if (!(await qaConfirm({
                    title: 'Delete saved login?',
                    message: `Delete "${s.name}" and its saved cookies/tokens?`,
                    okText: 'Delete', danger: true
                }))) return;
                const site = await currentSite();
                const r = await send({ action: 'swapDelete', url: site ? site.url : url, id: s.id });
                if (r && r.ok) { showToastMessage(`Deleted "${s.name}"`, 'success'); render(); }
                else showToastMessage('Could not delete: ' + ((r && r.error) || 'no response'), 'error');
            });
            swList.appendChild(card);
        });
    }

    swSaveBtn.addEventListener('click', async () => {
        if (swSaveBtn.disabled) return;
        const t = await currentSite();
        if (!t) { showToastMessage('Open a website first', 'error'); return; }
        const name = await swPrompt('Save this login as', '');
        if (!name) return;
        swSaveBtn.disabled = true;
        const operationId = (crypto.randomUUID && crypto.randomUUID()) || `save_${Date.now()}_${Math.random()}`;
        const r = await send({ action: 'swapSave', tab: { id: t.id, url: t.url }, name, operationId });
        if (r && r.ok) { showToastMessage(`Saved "${name}"`, 'success'); render(); }
        else { showToastMessage('Could not save: ' + ((r && r.error) || 'no response'), 'error'); swSaveBtn.disabled = false; }
    });

    tabBtn.addEventListener('click', render);
    if (tabBtn.classList.contains('active')) render();

    // Keep the list tied to the tab you're actually looking at. Without this the
    // panel kept showing (and acting on) the site it was rendered for, so after
    // switching tabs or logging in, Update/Switch ran against the wrong page.
    const sessionsVisible = () => tabBtn.classList.contains('active');
    if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(() => { if (sessionsVisible()) render(); });
    if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((id, info, tab) => {
        if (info && info.status === 'complete' && tab && tab.active && sessionsVisible()) render();
    });
})();
