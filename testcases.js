// Render-only page for AI-generated test cases. Input lives in the side panel;
// the background stores the result here and opens this tab.

let currentCases = [];

document.addEventListener('DOMContentLoaded', async () => {
    const { pendingTestCases } = await chrome.storage.local.get(['pendingTestCases']);
    if (!pendingTestCases || !Array.isArray(pendingTestCases.cases) || pendingTestCases.cases.length === 0) {
        document.getElementById('emptyView').classList.remove('hidden');
        return;
    }
    chrome.storage.local.remove('pendingTestCases'); // consume so refresh won't show stale data

    currentCases = pendingTestCases.cases;
    document.getElementById('reportView').classList.remove('hidden');
    document.getElementById('genDate').textContent = pendingTestCases.generatedAt
        ? 'Generated ' + new Date(pendingTestCases.generatedAt).toLocaleString() : '';
    document.getElementById('story').innerHTML = '<b>User story:</b> ' + esc(pendingTestCases.story || '');
    renderCases();

    document.getElementById('copyBtn').addEventListener('click', copyAll);
    document.getElementById('csvBtn').addEventListener('click', exportCsv);
});

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

const PRI_CLASS = { high: 'p-high', medium: 'p-medium', low: 'p-low' };
const TYPE_CLASS = { positive: 't-positive', negative: 't-negative', 'edge case': 't-edge' };

function renderCases() {
    document.getElementById('outCount').textContent =
        `${currentCases.length} Test Case${currentCases.length !== 1 ? 's' : ''}`;

    document.getElementById('cards').innerHTML = currentCases.map(tc => {
        const steps = (tc.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
        return `
        <div class="tc">
            <div class="tc-head">
                <span class="tc-id">${esc(tc.id || '')}</span>
                <span class="tc-title">${esc(tc.title || '')}</span>
                <span class="tc-badge ${PRI_CLASS[(tc.priority || '').toLowerCase()] || 'p-medium'}">${esc(tc.priority || 'medium')}</span>
                <span class="tc-badge ${TYPE_CLASS[(tc.type || '').toLowerCase()] || 't-positive'}">${esc(tc.type || 'positive')}</span>
            </div>
            <div class="tc-body">
                ${tc.preconditions ? `<div class="tc-pre"><i class="fas fa-info-circle"></i> ${esc(tc.preconditions)}</div>` : ''}
                <div class="tc-lbl">Steps</div>
                <div class="tc-steps"><ol>${steps}</ol></div>
                <div class="tc-lbl" style="margin-top:12px;">Expected Result</div>
                <div class="tc-expected">${esc(tc.expected || '')}</div>
            </div>
        </div>`;
    }).join('');
}

function copyAll() {
    const text = currentCases.map((tc, i) => {
        const steps = (tc.steps || []).map((s, j) => `  ${j + 1}. ${s}`).join('\n');
        return `${tc.id || 'TC-' + (i + 1)} | ${tc.title}\nPriority: ${tc.priority} | Type: ${tc.type}` +
            (tc.preconditions ? `\nPreconditions: ${tc.preconditions}` : '') +
            `\nSteps:\n${steps}\nExpected: ${tc.expected}`;
    }).join('\n\n---\n\n');
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1600);
    }).catch(() => { });
}

function exportCsv() {
    const rows = [['ID', 'Title', 'Priority', 'Type', 'Preconditions', 'Steps', 'Expected Result']];
    currentCases.forEach(tc => {
        const steps = (tc.steps || []).map((s, i) => (i + 1) + '. ' + s).join(' | ');
        rows.push([tc.id, tc.title, tc.priority, tc.type, tc.preconditions || '', steps, tc.expected]);
    });
    const csv = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: 'test-cases.csv' });
    a.click();
    URL.revokeObjectURL(url);
}
