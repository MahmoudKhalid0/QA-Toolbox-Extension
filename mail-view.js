// Email detail page for the Temp Mail tab - ported from a standalone
// extension, rebranded, and repointed at the toolkit's namespaced storage
// keys (tmToken / tmAccount). Renders the email HTML inside a sandboxed
// iframe so a hostile email can't touch the extension page.
const API_URL = 'https://api.mail.tm';
const state = { account: null, token: null, currentMsg: null };
let currentTooltip = null, tooltipTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
    const messageId = new URLSearchParams(location.search).get('id');
    if (!messageId) return showError();
    await loadAccount();
    if (!state.token) return showError();
    fetchMessage(messageId);
    const dl = document.getElementById('download-btn');
    if (dl) dl.addEventListener('click', () => { if (state.currentMsg) downloadEML(state.currentMsg.id, state.currentMsg.subject); });
});

// A sandboxed iframe can't open links itself; it posts the URL up to us.
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'open_link' && event.data.url) {
        try { chrome.tabs.create({ url: event.data.url }); }
        catch (e) { window.open(event.data.url, '_blank'); }
    }
});

function loadAccount() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['tmAccount', 'tmToken'], (res) => {
            state.account = res.tmAccount || null;
            state.token = res.tmToken || null;
            resolve();
        });
    });
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
        const res = await fetch(`${API_URL}/messages/${id}`, { headers: { 'Authorization': `Bearer ${state.token}` } });
        if (!res.ok) throw new Error('Failed to fetch');
        const msg = await res.json();
        state.currentMsg = msg;

        const subject = msg.subject || '(No Subject)';
        const from = msg.from ? (msg.from.name || msg.from.address) : 'Unknown';
        let body = (msg.html && msg.html.length) ? msg.html[0] : (msg.text || '');
        body = await processEmailAttachments(body, msg.attachments, id);

        const subjectEl = document.getElementById('subject');
        subjectEl.textContent = subject;
        const fromEl = document.getElementById('from');
        fromEl.textContent = from; fromEl.title = from;
        const dateEl = document.getElementById('date');
        dateEl.textContent = formatDate(msg.createdAt); dateEl.title = dateEl.textContent;

        const isArabic = /[؀-ۿ]/.test(subject + body);
        document.body.classList.toggle('rtl', isArabic);
        document.getElementById('header-area').classList.toggle('rtl', isArabic);

        document.getElementById('email-frame').srcdoc = buildFrame(body, isArabic);

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
            <div class="error-text">Its inbox was replaced by a new temporary address, so it's no longer accessible.</div>
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
