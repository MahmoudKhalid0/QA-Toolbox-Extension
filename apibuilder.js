// Editable API request page. The AI-built request is loaded from storage; the
// user can tweak any field and the cURL / fetch() output rebuilds live.

document.addEventListener('DOMContentLoaded', async () => {
    const { pendingApiRequest } = await chrome.storage.local.get(['pendingApiRequest']);
    if (!pendingApiRequest || !pendingApiRequest.request) {
        document.getElementById('emptyView').classList.remove('hidden');
        return;
    }
    chrome.storage.local.remove('pendingApiRequest'); // consume so refresh won't show stale data

    const r = pendingApiRequest.request;
    document.getElementById('mainView').classList.remove('hidden');
    document.getElementById('genDate').textContent = pendingApiRequest.generatedAt
        ? 'Generated ' + new Date(pendingApiRequest.generatedAt).toLocaleString() : '';
    document.getElementById('desc').innerHTML =
        (r.explanation ? esc(r.explanation) + '<br>' : '') + '<b>From:</b> ' + esc(pendingApiRequest.description || '');

    document.getElementById('method').value = r.method || 'GET';
    document.getElementById('url').value = r.url || '';
    document.getElementById('bodyType').value = r.bodyType || 'none';
    document.getElementById('body').value = r.body || '';
    (r.headers && r.headers.length ? r.headers : [{ key: '', value: '' }]).forEach(addHeaderRow);

    // Rebuild on any edit
    ['method', 'url', 'bodyType', 'body'].forEach(id =>
        document.getElementById(id).addEventListener('input', build));
    document.getElementById('addHeader').addEventListener('click', () => { addHeaderRow({ key: '', value: '' }); build(); });
    document.getElementById('copyCurl').addEventListener('click', (e) => copy(buildCurl(), e.currentTarget, 'Copy cURL'));
    document.getElementById('copyFetch').addEventListener('click', (e) => copy(buildFetch(), e.currentTarget, 'Copy as fetch()'));

    build();
});

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function addHeaderRow(h) {
    const row = document.createElement('div');
    row.className = 'kv';
    row.innerHTML = `
        <input type="text" class="hk" placeholder="Header" value="${esc(h.key)}">
        <input type="text" class="hv" placeholder="Value" value="${esc(h.value)}">
        <button class="rm" title="Remove"><i class="fas fa-times"></i></button>`;
    row.querySelector('.hk').addEventListener('input', build);
    row.querySelector('.hv').addEventListener('input', build);
    row.querySelector('.rm').addEventListener('click', () => { row.remove(); build(); });
    document.getElementById('headers').appendChild(row);
}

function collect() {
    const headers = [];
    document.querySelectorAll('#headers .kv').forEach(row => {
        const key = row.querySelector('.hk').value.trim();
        const value = row.querySelector('.hv').value.trim();
        if (key) headers.push({ key, value });
    });
    return {
        method: document.getElementById('method').value,
        url: document.getElementById('url').value.trim(),
        bodyType: document.getElementById('bodyType').value,
        body: document.getElementById('body').value,
        headers
    };
}

function build() {
    document.getElementById('curlOut').textContent = buildCurl();
}

// Shell-escape for single-quoted cURL arguments
function sh(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function buildCurl() {
    const r = collect();
    if (!r.url) return '# Enter a URL';
    const parts = [`curl -X ${r.method} ${sh(r.url)}`];
    r.headers.forEach(h => parts.push(`  -H ${sh(h.key + ': ' + h.value)}`));
    if (r.bodyType !== 'none' && r.body.trim()) {
        parts.push(`  -d ${sh(r.body)}`);
    }
    return parts.join(' \\\n');
}

function buildFetch() {
    const r = collect();
    const opts = { method: r.method };
    const headers = {};
    r.headers.forEach(h => { headers[h.key] = h.value; });
    if (Object.keys(headers).length) opts.headers = headers;
    if (r.bodyType !== 'none' && r.body.trim()) {
        opts.body = r.bodyType === 'json' ? r.body.trim() : r.body;
    }
    // Pretty-print, but keep a JSON body inline as a template string
    let bodyLine = '';
    if (opts.body !== undefined) {
        bodyLine = opts.body;
        delete opts.body;
    }
    let out = `fetch(${JSON.stringify(r.url)}, ${JSON.stringify(opts, null, 2)}`;
    if (bodyLine) {
        // Insert the body back into the options object
        out = `const options = ${JSON.stringify(opts, null, 2)};\n`;
        out += `options.body = ${JSON.stringify(bodyLine)};\n`;
        out += `fetch(${JSON.stringify(r.url)}, options)`;
    } else {
        out += `)`;
    }
    out += `\n  .then(res => res.json())\n  .then(data => console.log(data))\n  .catch(err => console.error(err));`;
    return out;
}

function copy(text, btn, label) {
    navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => { btn.innerHTML = `<i class="fas fa-copy"></i> ${label}`; }, 1500);
    }).catch(() => { });
}
