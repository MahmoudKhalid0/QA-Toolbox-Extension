// Responsive Viewer: renders the target URL in multiple device-sized iframes.
// To let framed sites load, a session DNR rule strips X-Frame-Options / CSP
// frame-ancestors from sub_frame responses while this page is open.

const DEVICE_LIBRARY = [
    { name: 'iPhone SE', w: 375, h: 667 },
    { name: 'iPhone 14 Pro', w: 393, h: 852 },
    { name: 'iPhone 14 Pro Max', w: 430, h: 932 },
    { name: 'Pixel 7', w: 412, h: 915 },
    { name: 'Galaxy S20', w: 360, h: 800 },
    { name: 'Surface Duo', w: 540, h: 720 },
    { name: 'iPad Mini', w: 768, h: 1024 },
    { name: 'iPad Pro 11"', w: 834, h: 1194 },
    { name: 'iPad Pro 12.9"', w: 1024, h: 1366 },
    { name: 'Laptop', w: 1280, h: 800 },
    { name: 'Desktop', w: 1440, h: 900 },
    { name: 'Full HD', w: 1920, h: 1080 }
];
const DEFAULT_DEVICES = ['iPhone 14 Pro', 'Pixel 7', 'iPad Mini', 'Laptop'];
const DNR_RULE_ID = 4801;

let url = '';
let zoom = 0.5;
let screens = []; // { id, name, w, h, rotated }
let nextId = 1;

const $ = (id) => document.getElementById(id);

function enableFraming() {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [DNR_RULE_ID],
        addRules: [{
            id: DNR_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                responseHeaders: [
                    { header: 'x-frame-options', operation: 'remove' },
                    { header: 'frame-options', operation: 'remove' },
                    { header: 'content-security-policy', operation: 'remove' },
                    { header: 'content-security-policy-report-only', operation: 'remove' }
                ]
            },
            condition: { resourceTypes: ['sub_frame'] }
        }]
    }).catch(() => { });
}
function disableFraming() {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] }).catch(() => { });
}

function render() {
    const row = $('rv-row');
    if (!url) { row.innerHTML = '<div class="rv-empty">Enter a URL above and press Go.</div>'; return; }
    if (!screens.length) { row.innerHTML = '<div class="rv-empty">No devices — add one from the menu.</div>'; return; }
    row.innerHTML = screens.map(s => {
        const w = s.rotated ? s.h : s.w;
        const h = s.rotated ? s.w : s.h;
        const sw = Math.round(w * zoom), sh = Math.round(h * zoom);
        return `<div class="rv-frame" data-id="${s.id}">
            <div class="rv-fhead">
                <span class="rv-fname">${escapeHtml(s.name)}</span>
                <span class="rv-fdim">${w}×${h}</span>
                <span class="rv-fact">
                    <button data-act="rotate" title="Rotate"><i class="fas fa-rotate"></i></button>
                    <button data-act="reload" title="Reload"><i class="fas fa-rotate-right"></i></button>
                    <button data-act="remove" title="Remove"><i class="fas fa-xmark"></i></button>
                </span>
            </div>
            <div class="rv-screen" style="width:${sw}px;height:${sh}px;">
                <iframe src="${encodeURI(url)}" style="width:${w}px;height:${h}px;transform:scale(${zoom});transform-origin:top left;"></iframe>
            </div>
        </div>`;
    }).join('');
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }

function reloadAll() { document.querySelectorAll('.rv-screen iframe').forEach(f => { f.src = f.src; }); }

// ---- Toolbar wiring ----
$('rv-go').addEventListener('click', () => {
    let v = $('rv-url').value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    url = v; $('rv-url').value = v; render();
});
$('rv-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rv-go').click(); });
$('rv-reload').addEventListener('click', reloadAll);
$('rv-rotate').addEventListener('click', () => { screens.forEach(s => s.rotated = !s.rotated); render(); });
$('rv-zoom').addEventListener('change', (e) => { zoom = parseFloat(e.target.value); render(); });
$('rv-add').addEventListener('change', (e) => {
    const dev = DEVICE_LIBRARY.find(d => d.name === e.target.value);
    if (dev) { screens.push({ id: nextId++, name: dev.name, w: dev.w, h: dev.h, rotated: false }); render(); }
    e.target.value = '';
});

$('rv-row').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = +btn.closest('.rv-frame').dataset.id;
    const s = screens.find(x => x.id === id); if (!s) return;
    if (btn.dataset.act === 'rotate') { s.rotated = !s.rotated; render(); }
    else if (btn.dataset.act === 'remove') { screens = screens.filter(x => x.id !== id); render(); }
    else if (btn.dataset.act === 'reload') {
        const f = btn.closest('.rv-frame').querySelector('iframe'); if (f) f.src = f.src;
    }
});

// ---- Init ----
(function init() {
    enableFraming();
    window.addEventListener('beforeunload', disableFraming);

    const params = new URLSearchParams(location.search);
    url = params.get('url') || '';
    $('rv-url').value = url;

    // Populate the "add device" menu
    $('rv-add').insertAdjacentHTML('beforeend',
        DEVICE_LIBRARY.map(d => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} — ${d.w}×${d.h}</option>`).join(''));

    DEFAULT_DEVICES.forEach(name => {
        const d = DEVICE_LIBRARY.find(x => x.name === name);
        if (d) screens.push({ id: nextId++, name: d.name, w: d.w, h: d.h, rotated: false });
    });

    render();
})();
