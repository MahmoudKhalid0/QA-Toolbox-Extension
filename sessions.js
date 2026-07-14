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
    // idempotent - updating re-captures the same cookies, restoring re-lays the same
    // ones, deleting the same id twice is a no-op - so a repeat can't do damage.
    // SAVE is the one exception (it would create a duplicate) and never retries.
    const send = async (msg, { retries = 3 } = {}) => {
        for (let i = 0; i <= retries; i++) {
            const r = await sendOnce(msg);
            if (r) return r;
            await new Promise((s) => setTimeout(s, 120));   // let the worker boot
        }
        return {};
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

    // Custom name prompt styled like the extension (no ugly window.prompt).
    // Resolves with the trimmed string, or null on cancel.
    function swPrompt(defVal) {
        return new Promise((resolve) => {
            const modal = $('sw-modal'), input = $('sw-modal-input');
            const okBtn = $('sw-modal-ok'), cancelBtn = $('sw-modal-cancel');
            input.value = defVal || '';
            modal.classList.add('show');
            setTimeout(() => { input.focus(); input.select(); }, 30);
            const done = (val) => {
                modal.classList.remove('show');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                input.removeEventListener('keydown', onKey);
                modal.removeEventListener('mousedown', onBackdrop);
                resolve(val);
            };
            const onOk = () => done((input.value || '').trim() || null);
            const onCancel = () => done(null);
            const onKey = (e) => { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); };
            const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKey);
            modal.addEventListener('mousedown', onBackdrop);
        });
    }

    async function render() {
        const t = await activeTab();
        const url = t && t.url;
        const web = url && /^https?:/i.test(url);
        swSite.innerHTML = 'Current site: <b>' + (web ? esc(hostOf(url)) : '&mdash;') + '</b>';
        swSaveBtn.disabled = !web;
        if (!web) { swList.innerHTML = '<div class="sw-empty">Open a website to save its login.</div>'; return; }

        // Pass the site's tab id: the worker reads its storage to see WHO is signed
        // in, which is what keeps "Current" correct after a cookie rotation.
        const { snaps = [] } = await send({ action: 'swapList', url, tabId: t.id });
        if (!snaps.length) { swList.innerHTML = '<div class="sw-empty">No saved logins for this site yet.</div>'; return; }
        swList.innerHTML = '';
        snaps.forEach((s) => {
            const card = document.createElement('div');
            card.className = 'sw-card';
            if (s.active) card.classList.add('sw-current');
            const rightBtn = s.active
                ? `<span class="sw-badge">Current</span>`
                : `<button class="sw-go">Switch</button>`;
            card.innerHTML = `
                <span class="sw-ico">${s.active ? '<i class="fas fa-circle-check"></i>' : '<i class="fas fa-user"></i>'}</span>
                <div class="sw-meta">
                    <div class="sw-name" title="${esc(s.name)}">${esc(s.name)}</div>
                    <div class="sw-sub">${s.count} cookie${s.count === 1 ? '' : 's'} · saved ${esc(timeAgo(s.createdAt))}</div>
                </div>
                ${rightBtn}
                <button class="sw-x sw-upd" title="Update this saved login with the session you're logged in as now"><i class="fas fa-rotate"></i></button>
                <button class="sw-x sw-del" title="Delete"><i class="fas fa-trash"></i></button>`;
            const updBtn = card.querySelector('.sw-upd');
            updBtn.addEventListener('click', async () => {
                if (updBtn.disabled) return;
                updBtn.disabled = true;
                const site = await currentSite();          // LIVE tab, not the one from render
                if (!site) { showToastMessage('Open the website first', 'error'); updBtn.disabled = false; return; }
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
                if (r && r.ok) showToastMessage(`Switched to "${s.name}"`, 'success');
                else showToastMessage('Could not switch: ' + ((r && r.error) || 'no response'), 'error');
                render();
            });
            card.querySelector('.sw-del').addEventListener('click', async () => {
                const site = await currentSite();
                await send({ action: 'swapDelete', url: site ? site.url : url, id: s.id });
                render();
            });
            swList.appendChild(card);
        });
    }

    swSaveBtn.addEventListener('click', async () => {
        const t = await currentSite();
        if (!t) { showToastMessage('Open a website first', 'error'); return; }
        const name = await swPrompt('');
        if (!name) return;
        // No retry here: saving twice would create a duplicate snapshot.
        const r = await send({ action: 'swapSave', tab: { id: t.id, url: t.url }, name }, { retries: 0 });
        if (r && r.ok) { showToastMessage(`Saved "${name}"`, 'success'); render(); }
        else showToastMessage('Could not save: ' + ((r && r.error) || 'no response'), 'error');
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
