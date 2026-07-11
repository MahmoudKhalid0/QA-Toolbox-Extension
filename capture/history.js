// Capture Gallery — reads the local library (IndexedDB), not the cloud.
// Every capture lands here automatically, together with the console errors,
// failed requests and environment recorded at the moment it was taken.

const $ = (id) => document.getElementById(id);

// The pull timer runs every minute at best - opening the gallery is also a
// good moment to ask, so a capture shared from another device shows up sooner.
chrome.runtime.sendMessage({ action: 'pullNow' }).catch(() => { });

let items = [];                 // metadata only; blobs are fetched on demand
let filter = 'all';
let picked = new Set();
let previewIndex = -1;
let visible = [];               // the currently rendered, filtered order
const urls = new Map();         // objectURLs to revoke on re-render

// ── helpers ─────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(bytes) {
    if (!bytes) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
    return new Date(ts).toLocaleDateString();
}

function dayGroup(ts) {
    const d = new Date(ts), now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'Earlier this week';
    if (diff < 30) return 'This month';
    return 'Older';
}

// Older captures stored only the errors (and `consoleAll`); newer ones keep the
// whole console. Read both shapes so the counts never contradict each other.
function ctxLogs(ctx) {
    if (!ctx) return [];
    if (ctx.console && ctx.console.length) return ctx.console;
    if (ctx.consoleAll && ctx.consoleAll.length) return ctx.consoleAll;
    return ctx.consoleErrors || [];
}
function ctxReqs(ctx) {
    if (!ctx) return [];
    if (ctx.requests && ctx.requests.length) return ctx.requests;
    return ctx.failedRequests || [];
}
const isFailed = (r) => r.status === 0 || r.status >= 400;

const errCount = (it) => ctxLogs(it.ctx).filter(l => l.level === 'error').length;
const reqCount = (it) => ctxReqs(it.ctx).filter(isFailed).length;
const issues = (it) => errCount(it) + reqCount(it);

function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(() => { t.className = 'toast'; }, 2600);
}

function blobUrl(blob, key) {
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    urls.set(key, u);
    return u;
}

function revokeAll() {
    for (const [k, u] of urls) {
        if (k === 'pv') continue;           // the open preview keeps its own
        URL.revokeObjectURL(u);
        urls.delete(k);
    }
}

// ── data ────────────────────────────────────────────────────────────────────

async function load() {
    try {
        items = await CapStore.list();
    } catch (e) {
        $('content').innerHTML = `<div class="empty"><i class="fas fa-triangle-exclamation"></i>
            <h3>Could not open the library</h3><p>${esc(e.message || e)}</p></div>`;
        return;
    }
    picked.clear();
    render();
}

function matchesFilter(it) {
    if (filter === 'image') return it.type === 'image';
    if (filter === 'video') return it.type === 'video';
    if (filter === 'issues') return issues(it) > 0;
    if (filter === 'cloud') return !!it.cloudUrl;
    return true;
}

function matchesSearch(it, q) {
    if (!q) return true;
    const ctx = it.ctx || {};
    const hay = [
        it.title, it.pageUrl,
        ...ctxLogs(ctx).map(e => e.message),
        ...ctxReqs(ctx).map(r => r.url)
    ].join(' ').toLowerCase();
    return hay.includes(q);
}

function matchesDate(it) {
    const v = $('dateFilter').value;
    if (v === 'all') return true;
    const days = v === 'today' ? 1 : v === 'week' ? 7 : 30;
    return Date.now() - it.createdAt < days * 86400000;
}

let workspaceFilter = localStorage.getItem('wsFilter') || 'all';

function setWorkspaceFilter(name) {
    workspaceFilter = name;
    if (name === 'all') localStorage.removeItem('wsFilter');
    else localStorage.setItem('wsFilter', name);
}

// A workspace is a Drive folder, so it can exist with zero local captures in
// it (just created, or shared into from a different device). The sidebar's
// list is local-items-derived names PLUS whatever Drive itself reports.
let driveWorkspaceNames = null;   // null = not fetched yet, [] = fetched, none extra
let driveSignedIn = false;

async function loadDriveWorkspaces() {
    const meta = await chrome.runtime.sendMessage({ action: 'syncStatus' }).catch(() => null);
    driveSignedIn = !!(meta && meta.signedIn);
    if (!driveSignedIn) { driveWorkspaceNames = []; return; }

    const res = await chrome.runtime.sendMessage({ action: 'listWorkspaces' }).catch(() => null);
    driveWorkspaceNames = (res && res.success) ? res.workspaces.map(w => w.name) : [];
    renderWorkspaceList();
}

function matchesWorkspace(it) {
    return workspaceFilter === 'all' || (it.workspace || '') === workspaceFilter;
}

// Local items give a workspace's usage; Drive gives its existence - a folder
// just created, or shared into from another device, has no local items yet
// but is still a real workspace. Counts are raw local totals, same as the tab
// counts in renderStats() above.
function renderWorkspaceList() {
    const list = $('wsList');
    const localNames = items.map(it => it.workspace).filter(Boolean);
    const names = [...new Set([...localNames, ...(driveWorkspaceNames || [])])].sort();
    if (workspaceFilter !== 'all' && !names.includes(workspaceFilter)) setWorkspaceFilter('all');

    const countFor = (name) => name === 'all' ? items.length : items.filter(it => it.workspace === name).length;

    // "All workspaces" is a view, not a folder - nothing to delete there.
    const row = (value, label, deletable) => `
        <div class="ws-item ${workspaceFilter === value ? 'active' : ''}" data-ws="${esc(value)}">
            <span class="ws-name">${esc(label)}</span><span class="ws-count">${countFor(value)}</span>
            ${deletable ? `<button class="ws-del" data-del-ws="${esc(value)}" title="Delete this workspace"><i class="fas fa-trash"></i></button>` : ''}
        </div>`;

    list.innerHTML = row('all', 'All workspaces', false) + names.map(n => row(n, n, true)).join('')
        + `<div class="ws-item ws-add" id="wsAddRow"><span class="ws-name"><i class="fas fa-plus"></i> New workspace</span></div>`;

    list.querySelectorAll('.ws-item[data-ws]').forEach(el =>
        el.addEventListener('click', (e) => {
            if (e.target.closest('.ws-del')) return;   // handled separately below
            setWorkspaceFilter(el.dataset.ws);
            render();
        }));

    list.querySelectorAll('.ws-del').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteWorkspace(btn.dataset.delWs);
        }));

    $('wsAddRow').addEventListener('click', startAddWorkspace, { once: true });
}

// Turns the "+ New workspace" row into a text input in place, rather than a
// modal - it is one more folder, not a decision worth interrupting the page for.
function startAddWorkspace() {
    if (!driveSignedIn) {
        toast('Sign in to Google Drive from Settings first to create workspaces', true);
        renderWorkspaceList();   // the {once:true} listener is gone - put it back
        return;
    }

    const row = $('wsAddRow');
    row.innerHTML = `<input type="text" id="wsAddInput" placeholder="Workspace name" maxlength="100">`;
    const input = $('wsAddInput');
    input.focus();

    const cancel = () => renderWorkspaceList();
    const confirm = async () => {
        const name = input.value.trim();
        if (!name) { cancel(); return; }
        // Creating the folder in Drive is a real round trip, not instant -
        // same reasoning as every other delete/create action in this sidebar.
        row.innerHTML = `<span class="ws-name"><i class="fas fa-spinner fa-spin"></i> Creating "${esc(name)}"…</span>`;
        const res = await chrome.runtime.sendMessage({ action: 'createWorkspace', name }).catch(() => null);
        if (!res || !res.success) {
            toast('Could not create the workspace: ' + ((res && res.error) || 'no response'), true);
            cancel();
            return;
        }
        if (!driveWorkspaceNames.includes(res.name)) driveWorkspaceNames.push(res.name);
        setWorkspaceFilter(res.name);
        toast(`Created "${res.name}"`);
        render();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm();
        if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', () => { if (!input.value.trim()) cancel(); });
}

async function deleteWorkspace(name) {
    const count = items.filter(it => it.workspace === name).length;
    const yes = await ask({
        title: `Delete "${name}"?`,
        text: count
            ? `This workspace and its ${count} capture${count > 1 ? 's' : ''} are removed for good.`
            : 'This workspace is removed for good.',
        warn: 'Any shared links inside it stop working. This cannot be undone.',
        okText: 'Delete workspace'
    });
    if (!yes) return;

    // One shared capture inside is one full round trip (revoke, then trash),
    // then the folder itself - this is not instant. Without feedback here it
    // reads exactly like the silent bulk-delete did, which is what taught us
    // to add a spinner there in the first place.
    const list = $('wsList');
    const btn = list.querySelector(`.ws-del[data-del-ws="${CSS.escape(name)}"]`);
    list.classList.add('busy');
    if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
        const res = await chrome.runtime.sendMessage({ action: 'deleteWorkspace', name }).catch(() => null);
        if (!res || !res.success) {
            toast('Could not delete the workspace: ' + ((res && res.error) || 'no response'), true);
            return;
        }
        if (workspaceFilter === name) setWorkspaceFilter('all');
        // The sidebar also merges in the Drive-fetched list (see loadDriveWorkspaces) -
        // without this, the row survives on that stale cache until the next reload.
        if (driveWorkspaceNames) driveWorkspaceNames = driveWorkspaceNames.filter(n => n !== name);
        toast(res.stuck
            ? `Deleted "${name}" - ${res.stuck} link(s) may still be live`
            : `Deleted "${name}" and ${res.removed} capture${res.removed === 1 ? '' : 's'}`);
        load();   // rebuilds the sidebar, which clears .busy as a side effect
    } finally {
        // On the error path load() never runs, so this DOM still exists to reset.
        list.classList.remove('busy');
        if (btn) btn.innerHTML = '<i class="fas fa-trash"></i>';
    }
}

function sortItems(list) {
    const by = $('sortBy').value;
    const c = list.slice();
    if (by === 'old') return c.sort((a, b) => a.createdAt - b.createdAt);
    if (by === 'big') return c.sort((a, b) => (b.size || 0) - (a.size || 0));
    if (by === 'errors') return c.sort((a, b) => issues(b) - issues(a));
    return c.sort((a, b) => b.createdAt - a.createdAt);
}

// ── render ──────────────────────────────────────────────────────────────────

function renderStats() {
    // Scoped to the selected workspace, same as the grid itself - "Captures: 3"
    // while looking at a 2-capture workspace read as the filter doing nothing.
    const scoped = items.filter(matchesWorkspace);
    const imgs = scoped.filter(i => i.type === 'image').length;
    const vids = scoped.filter(i => i.type === 'video').length;
    const size = scoped.reduce((s, i) => s + (i.size || 0), 0);
    const withIssues = scoped.filter(i => issues(i) > 0).length;
    const shared = scoped.filter(i => i.cloudUrl).length;

    $('stats').innerHTML = `
        <div class="stat"><div class="v">${scoped.length}</div><div class="l">Captures</div></div>
        <div class="stat"><div class="v">${imgs} / ${vids}</div><div class="l">Images / Videos</div></div>
        <div class="stat"><div class="v">${fmtSize(size)}</div><div class="l">Storage used</div></div>
        <div class="stat ${withIssues ? 'warn' : ''}"><div class="v">${withIssues}</div><div class="l">With issues</div></div>
        <div class="stat ${shared ? 'ok' : ''}"><div class="v">${shared}</div><div class="l">Shared</div></div>`;

    $('nAll').textContent = scoped.length;
    $('nImage').textContent = imgs;
    $('nVideo').textContent = vids;
    $('nIssues').textContent = withIssues;
    $('nCloud').textContent = shared;
}

function render() {
    revokeAll();
    renderWorkspaceList();   // may correct workspaceFilter if its workspace is gone
    renderStats();

    const q = $('searchInput').value.trim().toLowerCase();
    visible = sortItems(items.filter(it => matchesFilter(it) && matchesSearch(it, q) && matchesDate(it) && matchesWorkspace(it)));

    if (!visible.length) {
        $('content').innerHTML = items.length
            ? `<div class="empty"><i class="fas fa-filter-circle-xmark"></i>
                 <h3>Nothing matches</h3><p>Try a different filter or search.</p></div>`
            : `<div class="empty"><i class="fas fa-camera"></i>
                 <h3>No captures yet</h3><p>Take a screenshot from the side panel or the floating eye &mdash; it lands here automatically.</p></div>`;
        syncBulk();
        return;
    }

    // group by day, preserving the chosen sort inside each group
    const groups = [];
    for (const it of visible) {
        const g = dayGroup(it.createdAt);
        const last = groups[groups.length - 1];
        if (last && last.name === g) last.items.push(it);
        else groups.push({ name: g, items: [it] });
    }

    $('content').innerHTML = groups.map(g => `
        <div class="group-h">${esc(g.name)} &middot; ${g.items.length}</div>
        <div class="grid">${g.items.map(cardHtml).join('')}</div>
    `).join('');

    wireCards();
    syncBulk();
}

function cardHtml(it) {
    const errs = errCount(it), reqs = reqCount(it);
    const thumbSrc = it.thumb ? blobUrl(it.thumb, 't' + it.id) : '';
    const media = it.type === 'video'
        ? (thumbSrc
            ? `<img src="${thumbSrc}" alt="" loading="lazy"><div class="play-overlay"><i class="fas fa-circle-play"></i></div>`
            : `<div class="ph"><i class="fas fa-circle-play"></i></div>`)
        : thumbSrc
            ? `<img src="${thumbSrc}" alt="" loading="lazy">`
            : `<div class="ph"><i class="fas fa-image"></i></div>`;

    return `
    <div class="card ${picked.has(it.id) ? 'picked' : ''}" data-id="${esc(it.id)}">
        <input type="checkbox" class="pick" ${picked.has(it.id) ? 'checked' : ''}>
        <div class="thumb" data-open="${esc(it.id)}">
            ${media}
            <div class="badges">
                ${it.type === 'video' ? '<span class="badge video"><i class="fas fa-video"></i> Video</span>' : ''}
                ${errs ? `<span class="badge err"><i class="fas fa-circle-exclamation"></i> ${errs}</span>` : ''}
                ${reqs ? `<span class="badge net"><i class="fas fa-wifi"></i> ${reqs}</span>` : ''}
                ${it.cloudUrl ? '<span class="badge cloud"><i class="fas fa-cloud"></i></span>' : ''}
            </div>
        </div>
        <div class="meta">
            <div class="title" title="${esc(it.title)}">${esc(it.title)}</div>
            <div class="sub">
                <span>${fmtAgo(it.createdAt)}</span><span class="dot">&bull;</span>
                <span>${fmtSize(it.size)}</span>
            </div>
            <div class="acts">
                ${it.cloudUrl
            ? `<button class="copy-share-link" data-url="${esc(it.cloudUrl)}" title="Copy the share link"><i class="fas fa-share-nodes"></i></button>`
            : ''}
                <button data-edit="${esc(it.id)}" title="Open in editor"><i class="fas fa-pen"></i></button>
                <button data-dl="${esc(it.id)}" title="Download"><i class="fas fa-download"></i></button>
                <button data-md="${esc(it.id)}" title="Copy bug report"><i class="fas fa-file-lines"></i></button>
                <button class="del" data-del="${esc(it.id)}" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    </div>`;
}

function wireCards() {
    document.querySelectorAll('[data-open]').forEach(el =>
        el.addEventListener('click', () => openPreview(el.dataset.open)));
    document.querySelectorAll('[data-edit]').forEach(el =>
        el.addEventListener('click', (e) => { e.stopPropagation(); openInEditor(el.dataset.edit); }));
    document.querySelectorAll('[data-dl]').forEach(el =>
        el.addEventListener('click', (e) => { e.stopPropagation(); download(el.dataset.dl); }));
    document.querySelectorAll('[data-md]').forEach(el =>
        el.addEventListener('click', (e) => { e.stopPropagation(); copyReport(el.dataset.md); }));
    document.querySelectorAll('[data-del]').forEach(el =>
        el.addEventListener('click', (e) => { e.stopPropagation(); remove(el.dataset.del); }));

    document.querySelectorAll('.pick').forEach(cb =>
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const card = cb.closest('.card');
            const id = card.dataset.id;
            if (cb.checked) picked.add(id); else picked.delete(id);
            card.classList.toggle('picked', cb.checked);
            syncBulk();
        }));
}

function syncBulk() {
    $('bulkBar').classList.toggle('show', picked.size > 0);
    $('bulkCount').textContent = `${picked.size} selected`;
    $('selectAll').checked = visible.length > 0 && picked.size === visible.length;
}

// ── actions ─────────────────────────────────────────────────────────────────

async function fullItem(id) {
    const it = await CapStore.get(id);
    if (!it) { toast('That capture is gone', true); load(); return null; }
    return it;
}

async function download(id) {
    const it = await fullItem(id);
    if (!it) return;
    const ext = it.type === 'video' ? 'webm' : 'png';
    const safe = (it.title || 'capture').replace(/[/\\?%*:|"<>]/g, '').trim() || 'capture';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(it.blob);
    a.download = `${safe}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function openInEditor(id) {
    const it = await fullItem(id);
    if (!it) return;
    const dataUrl = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(it.blob);
    });
    // the editor reads its source out of storage.local, keyed by capture id
    chrome.storage.local.set({ [it.id]: dataUrl, isVideo: it.type === 'video' }, () => {
        const q = `id=${encodeURIComponent(it.id)}&title=${encodeURIComponent(it.title)}` +
            (it.type === 'video' ? '&type=video' : '');
        chrome.tabs.create({ url: chrome.runtime.getURL(`capture/editor.html?${q}`) });
    });
}

async function remove(id) {
    const it = items.find(i => i.id === id);
    const yes = await ask({
        title: 'Delete this capture?',
        text: 'It is removed from this device.',
        warn: (it && it.cloudUrl) ? 'The link you shared stops working.' : ''
    });
    if (!yes) return;

    // A shared capture's delete is a Drive round trip (revoke, then trash),
    // same reasoning as bulk-delete: show something moving, not a dead click.
    const btn = document.querySelector(`.del[data-del="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    const res = await chrome.runtime.sendMessage({ action: 'deleteCapture', id }).catch(() => null);
    picked.delete(id);
    toast(res && res.revoked === false ? 'Deleted here, but the shared link is still live' : 'Deleted');
    load();   // rebuilds the grid, which clears the spinner as a side effect
}

function reencodePng(blob) {
    return createImageBitmap(blob).then(bmp => {
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        return new Promise(res => c.toBlob(res, 'image/png'));
    });
}

async function copyImage(id) {
    const it = await fullItem(id);
    if (!it || it.type === 'video') { toast('Only images can be copied', true); return; }
    try {
        // the clipboard only accepts png
        const png = it.blob.type === 'image/png' ? it.blob : await reencodePng(it.blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast('Image copied');
    } catch (e) {
        toast('Copy failed: ' + (e.message || e), true);
    }
}

// A ready-to-paste bug report: exactly the context a developer asks for.
function reportMarkdown(it) {
    const c = it.ctx || {};
    const lines = [
        `## ${it.title || 'Bug report'}`, '',
        '### Environment', '',
        '| | |', '|---|---|',
        `| URL | ${c.url || '—'} |`,
        `| Browser | ${c.browser || '—'} |`,
        `| Platform | ${c.platform || '—'} |`,
        `| Viewport | ${c.viewport || '—'} |`,
        `| Captured | ${new Date(c.capturedAt || it.createdAt).toLocaleString()} |`,
        ''
    ];

    const allLogs = ctxLogs(c);
    const errs = allLogs.filter(l => l.level === 'error');
    lines.push('### Console errors', '');
    lines.push(errs.length ? '```\n' + errs.map(e => e.message).join('\n') + '\n```' : '_None_');
    lines.push('');

    const logs = allLogs;
    if (logs.length) {
        lines.push('<details><summary>Full console log</summary>', '');
        lines.push('```');
        for (const l of logs) lines.push('[' + (l.level || 'log').toUpperCase() + '] ' + l.message);
        lines.push('```', '</details>', '');
    }

    const reqs = ctxReqs(c).filter(isFailed);
    lines.push('### Failed requests', '');
    if (reqs.length) {
        lines.push('| Status | Method | URL |', '|---|---|---|');
        for (const r of reqs) lines.push(`| ${r.status || 'failed'} | ${r.method || 'GET'} | ${r.url} |`);
    } else {
        lines.push('_None_');
    }
    lines.push('');
    if (it.cloudUrl) lines.push('### Screenshot', '', it.cloudUrl, '');
    return lines.join('\n');
}

async function copyReport(id) {
    const it = await fullItem(id);
    if (!it) return;
    await navigator.clipboard.writeText(reportMarkdown(it));
    toast('Bug report copied as Markdown');
}

// ── preview ─────────────────────────────────────────────────────────────────

async function openPreview(id) {
    previewIndex = visible.findIndex(x => x.id === id);
    const it = await fullItem(id);
    if (!it) return;

    const old = urls.get('pv');
    if (old) URL.revokeObjectURL(old);

    $('pvTitle').textContent = it.title || 'Capture';
    const src = URL.createObjectURL(it.blob);
    urls.set('pv', src);

    $('pvStage').innerHTML = it.type === 'video'
        ? `<video src="${src}" controls autoplay></video>`
        : `<img src="${src}" alt="">`;

    $('pvSide').innerHTML = sideHtml(it);
    $('pvCopy').style.display = it.type === 'video' ? 'none' : '';

    $('pvEdit').onclick = () => openInEditor(it.id);
    $('pvDownload').onclick = () => download(it.id);
    $('pvCopy').onclick = () => copyImage(it.id);
    const cp = $('pvSide').querySelector('.copy-ctx');
    if (cp) cp.onclick = () => copyReport(it.id);

    $('pvPrev').disabled = previewIndex <= 0;
    $('pvNext').disabled = previewIndex >= visible.length - 1;

    $('overlay').classList.add('open');
}

// The browser's confirm() wears the browser's face and names the extension like
// a stranger. This one belongs to the gallery, and it resolves to a boolean the
// same way confirm() does.
function ask({ title, text, warn = '', okText = 'Delete' }) {
    const box = document.getElementById('confirmBox');
    if (!box) return Promise.resolve(true);

    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').textContent = text;
    const warnEl = document.getElementById('confirmWarn');
    warnEl.textContent = warn;
    warnEl.style.display = warn ? '' : 'none';
    document.getElementById('confirmOk').textContent = okText;

    box.classList.add('open');

    return new Promise((resolve) => {
        const done = (answer) => {
            box.classList.remove('open');
            document.removeEventListener('keydown', onKey);
            resolve(answer);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') done(false);
            if (e.key === 'Enter') done(true);
        };
        document.getElementById('confirmOk').onclick = () => done(true);
        document.getElementById('confirmCancel').onclick = () => done(false);
        box.onclick = (e) => { if (e.target === box) done(false); };   // click the backdrop
        document.addEventListener('keydown', onKey);
    });
}

// The detail panel is re-rendered whenever a capture is previewed, so this is
// bound to the document rather than to a node that will not survive it.
document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.copy-share-link');
    if (!a) return;
    e.preventDefault();
    navigator.clipboard.writeText(a.dataset.url)
        .then(() => toast('Link copied'))
        .catch(() => toast('Could not copy — the link is next to this button'));
});

function sideHtml(it) {
    if (!it.ctx) {
        return `<div class="sec-title"><i class="fas fa-circle-info"></i> Context</div>
            <div class="none">No page context was recorded for this capture.</div>`;
    }
    const c = it.ctx;
    const logs = ctxLogs(c);
    const errs = logs.filter(l => l.level === 'error');
    const allReqs = ctxReqs(c);
    const reqs = allReqs.filter(isFailed);

    const env = `
        <div class="sec-title"><i class="fas fa-circle-info"></i> Environment</div>
        <dl class="kv">
            <dt>Page</dt><dd>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>` : '&mdash;'}</dd>
            <dt>Browser</dt><dd>${esc(c.browser) || '&mdash;'}</dd>
            <dt>Platform</dt><dd>${esc(c.platform) || '&mdash;'}</dd>
            <dt>Viewport</dt><dd>${esc(c.viewport) || '&mdash;'}</dd>
            <dt>Captured</dt><dd>${new Date(it.createdAt).toLocaleString()}</dd>
            <dt>Size</dt><dd>${fmtSize(it.size)}</dd>
            ${it.cloudUrl ? `<dt>Shared</dt><dd>
                <a href="${esc(it.cloudUrl)}" target="_blank" rel="noopener">Open link</a>
                &nbsp;·&nbsp;
                <a href="#" class="copy-share-link" data-url="${esc(it.cloudUrl)}">Copy link</a></dd>` : ''}
            ${it.workspace ? `<dt>Workspace</dt><dd>${esc(it.workspace)}</dd>` : ''}
        </dl>`;

    // Every log the page emitted, not only errors: a warning right before the
    // bug is often the whole story. Errors are simply coloured louder.
    const logHtml = `
        <div class="sec-title">
            <i class="fas fa-terminal"></i> Console
            <span class="cnt">${logs.length}${errs.length ? ` &middot; ${errs.length} error${errs.length > 1 ? 's' : ''}` : ''}</span>
        </div>
        ${logs.length ? logs.map(l => `
            <div class="log lvl-${esc(l.level || 'log')}">
                <span class="lv">${esc(l.level || 'log')}</span>
                <span class="msg">${esc(l.message)}${l.count > 1 ? ` <b>&times;${l.count}</b>` : ''}</span>
                ${l.source ? `<span class="src">${esc(l.source)}</span>` : ''}
            </div>`).join('') : '<div class="none">The page logged nothing.</div>'}`;

    const reqHtml = `
        <div class="sec-title">
            <i class="fas fa-wifi"></i> Network
            <span class="cnt">${allReqs.length}${reqs.length ? ` &middot; ${reqs.length} failed` : ''}</span>
        </div>
        ${reqs.length ? reqs.map(r => `
            <div class="log req">
                <span class="st">${esc(r.status || 'ERR')}</span>
                <span class="u">${esc(r.method || 'GET')} ${esc(r.url)}</span>
            </div>`).join('')
        : allReqs.length ? '<div class="none">Every request succeeded.</div>'
        : '<div class="none">No requests were recorded.</div>'}`;

    return env + logHtml + reqHtml +
        '<button class="btn copy-ctx"><i class="fas fa-file-lines"></i> Copy bug report</button>';
}

function closePreview() {
    $('overlay').classList.remove('open');
    $('pvStage').innerHTML = '';
    const u = urls.get('pv');
    if (u) { URL.revokeObjectURL(u); urls.delete('pv'); }
    previewIndex = -1;
}

const step = (d) => {
    const n = previewIndex + d;
    if (n >= 0 && n < visible.length) openPreview(visible[n].id);
};

// ── wiring ──────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    filter = t.dataset.filter;
    render();
}));

$('searchInput').addEventListener('input', render);
$('dateFilter').addEventListener('change', render);
$('sortBy').addEventListener('change', render);
$('refreshBtn').addEventListener('click', load);

$('clearBtn').addEventListener('click', async () => {
    if (!items.length) return;
    const sharedAll = items.filter(i => i.cloudUrl).length;
    const yes = await ask({
        title: 'Delete every capture?',
        text: `All ${items.length} captures are removed from this device.`,
        warn: sharedAll
            ? `${sharedAll} shared link${sharedAll > 1 ? 's' : ''} stop working. This cannot be undone.`
            : 'This cannot be undone.',
        okText: 'Delete all'
    });
    if (!yes) return;

    // Same reason as bulk-delete: each shared item is a revoke round trip
    // before removal, so this is not instant - show live progress.
    const btn = $('clearBtn');
    const label = btn.innerHTML;
    btn.disabled = true;

    const all = items.slice();
    const n = all.length;
    let done = 0;
    let stuck = 0;
    for (const it of all) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Deleting ${done + 1}/${n}…`;
        const res = await chrome.runtime.sendMessage({ action: 'deleteCapture', id: it.id }).catch(() => null);
        if (res && res.revoked === false) stuck++;
        done++;
    }

    btn.innerHTML = label;
    btn.disabled = false;
    toast(stuck ? `Library cleared - ${stuck} link(s) may still be live` : 'Library cleared');
    load();
});

$('selectAll').addEventListener('change', () => {
    picked = $('selectAll').checked ? new Set(visible.map(i => i.id)) : new Set();
    render();
});

$('bulkCancel').addEventListener('click', () => { picked.clear(); render(); });

$('bulkDelete').addEventListener('click', async () => {
    const sharedCount = items.filter(i => picked.has(i.id) && i.cloudUrl).length;
    const yes = await ask({
        title: `Delete ${picked.size} capture${picked.size > 1 ? 's' : ''}?`,
        text: 'They are removed from this device.',
        warn: sharedCount ? `${sharedCount} shared link${sharedCount > 1 ? 's' : ''} stop working.` : ''
    });
    if (!yes) return;

    // Each deletion is a round trip to revoke the Drive link before removing
    // the local record, so a large batch is not instant. Disable the whole bar
    // and show live progress, or a second click reads as "it didn't work" and
    // invites exactly the repeated clicking that prompted this.
    const btn = $('bulkDelete');
    const cancelBtn = $('bulkCancel');
    const downloadBtn = $('bulkDownload');
    const label = btn.innerHTML;
    btn.disabled = true;
    cancelBtn.disabled = true;
    downloadBtn.disabled = true;

    const n = picked.size;
    let done = 0;
    let stuck = 0;
    for (const id of picked) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Deleting ${done + 1}/${n}…`;
        const res = await chrome.runtime.sendMessage({ action: 'deleteCapture', id }).catch(() => null);
        if (res && res.revoked === false) stuck++;
        done++;
        // Reflect each deletion as it happens, not only once the whole batch
        // finishes - the counts should never look stuck while work is visibly
        // still going.
        items = items.filter(it => it.id !== id);
        renderStats();
        renderWorkspaceList();
    }

    btn.innerHTML = label;
    btn.disabled = false;
    cancelBtn.disabled = false;
    downloadBtn.disabled = false;
    toast(stuck ? `${n} deleted, ${stuck} link(s) still live` : `${n} deleted`);
    picked.clear();
    load();
});

$('bulkDownload').addEventListener('click', async () => {
    const btn = $('bulkDownload');
    const deleteBtn = $('bulkDelete');
    const cancelBtn = $('bulkCancel');
    const label = btn.innerHTML;
    const n = picked.size;
    let done = 0;
    btn.disabled = true;
    deleteBtn.disabled = true;
    cancelBtn.disabled = true;
    for (const id of picked) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Downloading ${done + 1}/${n}…`;
        await download(id);
        done++;
        await new Promise(r => setTimeout(r, 250));   // let the browser's own download queue keep up
    }
    btn.innerHTML = label;
    btn.disabled = false;
    deleteBtn.disabled = false;
    cancelBtn.disabled = false;
});

$('pvClose').addEventListener('click', closePreview);
$('pvPrev').addEventListener('click', () => step(-1));
$('pvNext').addEventListener('click', () => step(1));
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closePreview(); });

document.addEventListener('keydown', (e) => {
    if (!$('overlay').classList.contains('open')) return;
    if (e.key === 'Escape') closePreview();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
});

load();
loadDriveWorkspaces();
