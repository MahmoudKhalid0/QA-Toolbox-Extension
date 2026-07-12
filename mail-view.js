// Email detail page for the Temp Mail tab - ported from a standalone
// extension, rebranded, and repointed at the toolkit's namespaced storage
// keys (tmToken / tmAccount). Renders the email HTML inside a sandboxed
// iframe so a hostile email can't touch the extension page.
const API_URL = 'https://api.mail.tm';
// `inbox`/`token` are set to whichever mailbox actually OWNS the message once we
// find it - not assumed to be the active one, because a message opened from a
// notification can belong to any inbox (see resolveMessage).
const state = { inboxes: [], activeId: null, inbox: null, token: null, currentMsg: null, viewMode: 'html' };
let currentTooltip = null, tooltipTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
    const messageId = new URLSearchParams(location.search).get('id');
    if (!messageId) return showError();
    await loadInboxes();
    if (!state.inboxes.length) return showError();
    fetchMessage(messageId);

    const dl = document.getElementById('download-btn');
    if (dl) dl.addEventListener('click', () => { if (state.currentMsg) downloadEML(state.currentMsg.id, state.currentMsg.subject); });

    // HTML | Text toggle
    const vh = document.getElementById('view-html');
    const vt = document.getElementById('view-text');
    if (vh) vh.addEventListener('click', () => setViewMode('html'));
    if (vt) vt.addEventListener('click', () => setViewMode('text'));

    // Copy buttons in the meta rows (sender / recipient address)
    document.querySelectorAll('.meta-copy').forEach((btn) => {
        btn.addEventListener('click', () => copyMeta(btn));
    });
});

// A sandboxed iframe can't open links itself; it posts the URL up to us.
window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'open_link' || !event.data.url) return;
    const url = event.data.url;
    // Beside THIS tab. A link out of an email used to be dropped at the far end of
    // the strip, so following one from the mail view meant losing the mail view.
    // openerTabId also means closing the link brings you straight back to it.
    chrome.tabs.getCurrent((me) => {
        void chrome.runtime.lastError;
        try {
            if (me && typeof me.index === 'number') {
                chrome.tabs.create({ url, index: me.index + 1, windowId: me.windowId, openerTabId: me.id });
            } else {
                chrome.tabs.create({ url });
            }
        } catch (e) {
            window.open(url, '_blank');
        }
    });
});

// All the inboxes, so a message can be looked up with the RIGHT key. Reading only
// the active tmToken (as this file used to) broke the moment there was more than
// one inbox: a message from a non-active inbox would 404 and show "can't be opened".
function loadInboxes() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['tmInboxes', 'tmActiveId', 'tmAccount', 'tmToken'], (res) => {
            let inboxes = Array.isArray(res.tmInboxes) ? res.tmInboxes.filter((b) => b && b.token) : [];
            // Legacy single-inbox install: fall back to tmAccount/tmToken.
            if (!inboxes.length && res.tmAccount && res.tmToken) {
                inboxes = [{ id: res.tmAccount.id || 'legacy', address: res.tmAccount.address, token: res.tmToken, name: '' }];
            }
            state.inboxes = inboxes;
            state.activeId = res.tmActiveId || (inboxes[0] ? inboxes[0].id : null);
            resolve();
        });
    });
}

// Find which inbox owns this message. The active one is tried first (the common
// case - you clicked a row in the inbox you're looking at); the rest are tried
// only if that misses (the notification case). The owning inbox's token is what
// later download / mark-as-seen calls must use.
async function resolveMessage(id) {
    const ordered = [...state.inboxes].sort((a, b) => (a.id === state.activeId ? -1 : b.id === state.activeId ? 1 : 0));
    for (const box of ordered) {
        try {
            const res = await fetch(`${API_URL}/messages/${id}`, { headers: { 'Authorization': `Bearer ${box.token}` } });
            if (res.ok) {
                state.inbox = box;
                state.token = box.token;
                return await res.json();
            }
        } catch (e) { /* try the next inbox */ }
    }
    return null;
}

const formatDate = (s) => {
    const d = new Date(s);
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${time}`;
};

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

// Inline images referenced by cid:/attachment: (including Outlook's
// ATTACH000001-style sequential labels) - fetch each and swap in a data URL.
async function processEmailAttachments(html, attachments, messageId) {
    let out = html;
    if (!attachments || !attachments.length) return out;

    for (const att of attachments) {
        const url = att.downloadUrl ? `${API_URL}${att.downloadUrl}` : `${API_URL}/messages/${messageId}/attachment/${att.id}`;
        const patterns = [`attachment:${att.id}`, `cid:${att.id}`];
        if (patterns.some((p) => out.includes(p))) {
            try {
                const res = await fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } });
                if (res.ok) {
                    const dataUrl = await blobToDataUrl(await res.blob());
                    patterns.forEach((p) => { out = out.split(p).join(dataUrl); });
                }
            } catch (e) { /* leave the broken reference */ }
        }
    }

    for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        for (const num of [i, i + 1, i + 2]) {
            const label = `ATTACH${String(num).padStart(6, '0')}`;
            const patterns = [`attachment:${label}`, `cid:${label}`];
            if (patterns.some((p) => out.includes(p))) {
                try {
                    const url = att.downloadUrl ? `${API_URL}${att.downloadUrl}` : `${API_URL}/messages/${messageId}/attachment/${att.id}`;
                    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } });
                    if (res.ok) {
                        const dataUrl = await blobToDataUrl(await res.blob());
                        patterns.forEach((p) => { out = out.split(p).join(dataUrl); });
                        break;
                    }
                } catch (e) { /* keep going */ }
            }
        }
    }
    return out;
}

async function fetchMessage(id) {
    try {
        const msg = await resolveMessage(id);
        if (!msg) throw new Error('not found in any inbox');
        state.currentMsg = msg;

        const subject = msg.subject || '(No Subject)';
        const from = msg.from ? (msg.from.name || msg.from.address) : 'Unknown';
        const fromAddr = msg.from ? (msg.from.address || '') : '';
        const toList = Array.isArray(msg.to) ? msg.to : [];
        const toText = toList.length ? toList.map((t) => t.address).filter(Boolean).join(', ') : '';

        // Both bodies are kept so the HTML | Text toggle can switch without a refetch.
        const htmlBody = (msg.html && msg.html.length) ? msg.html[0] : '';
        state.htmlBody = htmlBody ? await processEmailAttachments(htmlBody, msg.attachments, id) : '';
        state.textBody = msg.text || '';

        document.getElementById('subject').textContent = subject;

        const fromEl = document.getElementById('from');
        fromEl.textContent = from; fromEl.title = fromAddr || from;
        setCopy('from', fromAddr || from);

        // TO / INBOX rows: hide the row entirely if we've nothing to put in it,
        // rather than showing a lonely "—".
        const toRow = document.getElementById('to-row');
        if (toText) {
            const toEl = document.getElementById('to');
            toEl.textContent = toText; toEl.title = toText;
            setCopy('to', toList[0].address || toText);
            toRow.style.display = '';
        } else { toRow.style.display = 'none'; }

        const inboxRow = document.getElementById('inbox-row');
        if (state.inbox) {
            const label = state.inbox.name
                ? `${state.inbox.name} · ${state.inbox.address}`
                : state.inbox.address;
            const inboxEl = document.getElementById('inbox');
            inboxEl.textContent = label; inboxEl.title = label;
            inboxRow.style.display = '';
        } else { inboxRow.style.display = 'none'; }

        const dateEl = document.getElementById('date');
        dateEl.textContent = formatDate(msg.createdAt); dateEl.title = dateEl.textContent;

        // Only offer a view that exists. If there's no plain text, the Text tab is
        // disabled; if there's no HTML, we start on Text.
        const vt = document.getElementById('view-text');
        const vh = document.getElementById('view-html');
        if (!state.textBody) { vt.disabled = true; }
        if (!state.htmlBody) { vh.disabled = true; state.viewMode = 'text'; }

        document.body.classList.remove('loading');
        renderBody();

        if (!msg.seen) {
            fetch(`${API_URL}/messages/${id}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/merge-patch+json' },
                body: JSON.stringify({ seen: true })
            }).catch(() => { });
        }
    } catch (err) {
        showError();
    }
}

// Paint whichever view is selected into the frame, and keep the toggle in step.
function renderBody() {
    const useText = state.viewMode === 'text' || !state.htmlBody;
    const raw = useText ? state.textBody : state.htmlBody;
    const isArabic = /[؀-ۿ]/.test((state.currentMsg && state.currentMsg.subject || '') + raw);

    document.body.classList.toggle('rtl', isArabic);
    document.getElementById('header-area').classList.toggle('rtl', isArabic);

    const frame = document.getElementById('email-frame');
    const loader = document.getElementById('body-loader');
    // Hide the loader once the frame has actually painted, not before.
    frame.onload = () => { if (loader) loader.classList.add('hidden'); };
    frame.srcdoc = useText ? buildTextFrame(state.textBody, isArabic) : buildFrame(raw, isArabic);

    document.getElementById('view-html').classList.toggle('on', !useText);
    document.getElementById('view-text').classList.toggle('on', useText);
}

function setViewMode(mode) {
    if (mode === state.viewMode) return;
    if (mode === 'text' && !state.textBody) return;
    if (mode === 'html' && !state.htmlBody) return;
    state.viewMode = mode;
    renderBody();
}

function buildFrame(bodyContent, isArabic) {
    return `<!DOCTYPE html>
<html dir="${isArabic ? 'rtl' : 'ltr'}">
<head>
<meta http-equiv="Content-Security-Policy" content="img-src 'self' data: blob: *; default-src * 'unsafe-inline' 'unsafe-eval';">
<style>
    html, body { margin: 0; padding: 0; height: 100%; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; line-height: 1.8; color: #1e293b; background: #fff; font-size: 17px; overflow-y: auto; overflow-x: hidden; }
    #content-inner { max-width: 800px; width: 100%; margin: 0 auto; padding: 40px 60px; text-align: ${isArabic ? 'right' : 'left'}; box-sizing: border-box; }
    img { max-width: 100%; height: auto; display: inline-block; vertical-align: middle; }
    img[style*="display"] { display: unset; }
    a { color: #4f46e5; text-decoration: none; }
    pre { background: #f8fafc; padding: 15px; border-radius: 8px; overflow-x: auto; border: 1px solid #e2e8f0; }
    #content-inner *[style*="color: #fff"], #content-inner *[style*="color:#fff"],
    #content-inner *[style*="color: white"], #content-inner *[style*="color:white"],
    #content-inner *[style*="color: rgb(255, 255, 255)"], #content-inner *[style*="color:rgb(255,255,255)"] { color: #1e293b !important; }
    body::-webkit-scrollbar { width: 10px; }
    body::-webkit-scrollbar-track { background: #f1f5f9; }
    body::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 10px; border: 2px solid #f1f5f9; }
    body::-webkit-scrollbar-thumb:hover { background: #64748b; }
    table { border-collapse: collapse; }
    [style*="display: none"] { display: none !important; }
    [style*="visibility: hidden"] { visibility: hidden !important; }
</style>
</head>
<body>
<div id="content-inner">${bodyContent}</div>
<script>
    document.addEventListener('DOMContentLoaded', function () {
        var content = document.getElementById('content-inner');
        if (!content) return;
        content.querySelectorAll('a').forEach(function (a) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            a.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                var url = a.getAttribute('href');
                if (url && url !== '#') window.parent.postMessage({ type: 'open_link', url: url }, '*');
                return false;
            });
        });
        content.offsetHeight;
    });
<\/script>
</body>
</html>`;
}

// Plain-text view: the raw text, escaped, in a wrapping monospace block - so an
// email with no HTML part (or when the user just wants to see the real text) is
// readable instead of a wall.
function buildTextFrame(text, isArabic) {
    const esc = (t) => String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html dir="${isArabic ? 'rtl' : 'ltr'}">
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
    html, body { margin: 0; padding: 0; height: 100%; background: #fff; }
    pre {
        margin: 0; padding: 40px 60px; max-width: 900px; box-sizing: border-box;
        white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word;
        font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 14.5px; line-height: 1.7;
        color: #1e293b; text-align: ${isArabic ? 'right' : 'left'};
    }
</style>
</head>
<body><pre>${esc(text) || '<em style="color:#94a3b8">This email has no text content.</em>'}</pre></body>
</html>`;
}

// Fill a copy button's payload (the actual address, not the display name).
function setCopy(which, value) {
    const btn = document.querySelector(`.meta-copy[data-copy="${which}"]`);
    if (btn) btn.dataset.value = value || '';
}

function copyMeta(btn) {
    const value = btn.dataset.value || '';
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
        const icon = btn.querySelector('i');
        const prev = icon.className;
        icon.className = 'fas fa-check';
        btn.classList.add('done');
        setTimeout(() => { icon.className = prev; btn.classList.remove('done'); }, 1500);
    });
}

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
    const btn = document.getElementById('download-btn');
    try {
        if (!state.token) { alert('Your session has expired. Reopen this email from the toolkit.'); return; }
        if (btn) btn.disabled = true;
        const res = await fetch(`${API_URL}/messages/${id}`, { headers: { 'Authorization': `Bearer ${state.token}`, 'Accept': 'application/json' } });
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
        alert(`Download failed: ${err.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function closeTab() {
    try {
        const tab = await chrome.tabs.getCurrent();
        if (tab && tab.id) await chrome.tabs.remove(tab.id);
        else window.close();
    } catch (e) { window.close(); }
}

function showError() {
    const container = document.querySelector('.view-container');
    container.innerHTML = `
        <div class="error-container">
            <div class="error-icon">⚠️</div>
            <div class="error-title">This email can't be opened</div>
            <div class="error-text">It may have been deleted, or its inbox was forgotten - none of your temporary inboxes hold it any more.</div>
            <button id="close-tab-btn" class="close-tab-btn">Close Tab</button>
        </div>`;
    const btn = document.getElementById('close-tab-btn');
    if (btn) btn.addEventListener('click', closeTab);
}

// Tooltip for a truncated (clamped) subject.
function showTooltip(target, text) {
    if (!text) return;
    if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return;
    if (!currentTooltip) {
        currentTooltip = document.createElement('div');
        currentTooltip.className = 'custom-tooltip';
        document.body.appendChild(currentTooltip);
    }
    currentTooltip.textContent = text;
    currentTooltip.className = 'custom-tooltip show' + (document.body.classList.contains('rtl') ? ' rtl' : '');
    const rect = target.getBoundingClientRect();
    const tip = currentTooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tip.width / 2;
    if (left < 10) left = 10;
    if (left + tip.width > window.innerWidth - 10) left = window.innerWidth - tip.width - 10;
    currentTooltip.style.top = `${rect.bottom + 10}px`;
    currentTooltip.style.left = `${left}px`;
}
function hideTooltip() { if (currentTooltip) currentTooltip.classList.remove('show'); }

document.addEventListener('mouseover', (e) => {
    if (e.target.id === 'subject') {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => showTooltip(e.target, e.target.textContent), 700);
    }
});
document.addEventListener('mouseout', (e) => {
    if (e.target.id === 'subject') { clearTimeout(tooltipTimeout); hideTooltip(); }
});
