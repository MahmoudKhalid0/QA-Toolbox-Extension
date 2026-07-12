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
    const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || {}); }));
    const activeTab = () => new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t && t[0])));
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

        const { snaps = [] } = await send({ action: 'swapList', url });
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
            card.querySelector('.sw-upd').addEventListener('click', async () => {
                const r = await send({ action: 'swapUpdate', tab: { id: t.id, url }, id: s.id });
                if (r && r.ok) { showToastMessage(`Updated "${s.name}"`, 'success'); render(); }
                else showToastMessage('Could not update: ' + ((r && r.error) || 'unknown'), 'error');
            });
            const goBtn = card.querySelector('.sw-go');
            if (goBtn) goBtn.addEventListener('click', async () => {
                const r = await send({ action: 'swapRestore', tab: { id: t.id, url }, id: s.id });
                if (r && r.ok) { showToastMessage(`Switching to "${s.name}"…`, 'success'); window.close(); }
                else showToastMessage('Could not switch: ' + ((r && r.error) || 'unknown'), 'error');
            });
            card.querySelector('.sw-del').addEventListener('click', async () => {
                await send({ action: 'swapDelete', url, id: s.id });
                render();
            });
            swList.appendChild(card);
        });
    }

    swSaveBtn.addEventListener('click', async () => {
        const t = await activeTab();
        if (!t || !/^https?:/i.test(t.url || '')) { showToastMessage('Open a website first', 'error'); return; }
        const name = await swPrompt('');
        if (!name) return;
        const r = await send({ action: 'swapSave', tab: { id: t.id, url: t.url }, name });
        if (r && r.ok) { showToastMessage(`Saved "${name}"`, 'success'); render(); }
        else showToastMessage('Could not save: ' + ((r && r.error) || 'unknown'), 'error');
    });

    tabBtn.addEventListener('click', render);
    if (tabBtn.classList.contains('active')) render();
})();
