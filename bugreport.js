// Render-only page for an AI-generated bug report. Input lives in the side
// panel; the background stores the result here and opens this tab.

let currentReport = null;

document.addEventListener('DOMContentLoaded', async () => {
    const { pendingBugReport } = await chrome.storage.local.get(['pendingBugReport']);
    if (!pendingBugReport || !pendingBugReport.report) {
        document.getElementById('emptyView').classList.remove('hidden');
        return;
    }
    chrome.storage.local.remove('pendingBugReport'); // consume so refresh won't show stale data

    currentReport = pendingBugReport.report;
    document.getElementById('reportView').classList.remove('hidden');
    document.getElementById('genDate').textContent = pendingBugReport.generatedAt
        ? 'Generated ' + new Date(pendingBugReport.generatedAt).toLocaleString() : '';
    renderReport(currentReport);

    document.getElementById('copyBtn').addEventListener('click', copyReport);
    document.getElementById('csvBtn').addEventListener('click', exportCsv);
});

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

// Color the S1-S5 / P1-P4 badges by how urgent they are
function sevClass(v) {
    v = (v || '').toUpperCase();
    if (v === 'S1' || v === 'S2' || v === 'P1') return 'sev-critical';
    if (v === 'S3' || v === 'P2' || v === 'P3') return 'sev-medium';
    return 'sev-low';
}
const SEV_LABEL = { S1: 'S1 · Blocker', S2: 'S2 · Critical', S3: 'S3 · Major', S4: 'S4 · Minor', S5: 'S5 · Trivial' };
const PRI_LABEL = { P1: 'P1 · Urgent', P2: 'P2 · High', P3: 'P3 · Medium', P4: 'P4 · Low' };

function actionClass(a) {
    a = (a || '').toLowerCase();
    if (a.startsWith('fix now')) return 'sev-critical';
    if (a.startsWith('high urgency')) return 'sev-medium';
    return 'sev-low';
}

function renderReport(r) {
    const section = (label, valueHtml) => valueHtml
        ? `<div class="sec"><div class="sec-lbl">${label}</div><div class="sec-val">${valueHtml}</div></div>` : '';
    const steps = (r.stepsToReproduce || []).map(s => `<li>${esc(s)}</li>`).join('');

    document.getElementById('repBody').innerHTML =
        section('Title', `<strong>${esc(r.title)}</strong>`) +
        section('Module', esc(r.module)) +
        section('Environment', esc(r.environment)) +
        section('Description', esc(r.description)) +
        (steps ? `<div class="sec"><div class="sec-lbl">Steps to Reproduce</div><div class="sec-val"><ol>${steps}</ol></div></div>` : '') +
        section('Expected Result', esc(r.expectedResult)) +
        section('Actual Result', esc(r.actualResult)) +
        section('Impact', esc(r.impact)) +
        section('Severity', `<span class="badge ${sevClass(r.severity)}">${esc(SEV_LABEL[r.severity] || r.severity)}</span>`) +
        section('Priority', `<span class="badge ${sevClass(r.priority)}">${esc(PRI_LABEL[r.priority] || r.priority)}</span>`) +
        section('Recommended Action', r.recommendedAction ? `<span class="badge ${actionClass(r.recommendedAction)}">${esc(r.recommendedAction)}</span>` : '');
}

function reportAsText(r) {
    const steps = (r.stepsToReproduce || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n');
    return [
        `Title: ${r.title}`,
        r.module ? `Module: ${r.module}` : '',
        r.environment ? `Environment: ${r.environment}` : '',
        `Description: ${r.description}`,
        `Steps to Reproduce:\n${steps}`,
        `Expected Result: ${r.expectedResult}`,
        `Actual Result: ${r.actualResult}`,
        `Impact: ${r.impact}`,
        `Severity: ${SEV_LABEL[r.severity] || r.severity}`,
        `Priority: ${PRI_LABEL[r.priority] || r.priority}`,
        r.recommendedAction ? `Recommended Action: ${r.recommendedAction}` : ''
    ].filter(Boolean).join('\n');
}

function copyReport() {
    if (!currentReport) return;
    navigator.clipboard.writeText(reportAsText(currentReport)).then(() => {
        const btn = document.getElementById('copyBtn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1600);
    }).catch(() => { });
}

function exportCsv() {
    if (!currentReport) return;
    const r = currentReport;
    const rows = [
        ['Field', 'Value'],
        ['Title', r.title],
        ['Module', r.module],
        ['Environment', r.environment],
        ['Description', r.description],
        ['Steps to Reproduce', (r.stepsToReproduce || []).map((s, i) => (i + 1) + '. ' + s).join(' | ')],
        ['Expected Result', r.expectedResult],
        ['Actual Result', r.actualResult],
        ['Impact', r.impact],
        ['Severity', SEV_LABEL[r.severity] || r.severity],
        ['Priority', PRI_LABEL[r.priority] || r.priority],
        ['Recommended Action', r.recommendedAction || '']
    ];
    const csv = rows.map(row => row.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: 'bug-report.csv' });
    a.click();
    URL.revokeObjectURL(url);
}
