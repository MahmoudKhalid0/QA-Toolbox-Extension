// Bug trackers for the capture module: Azure DevOps and Jira Cloud.
//
// Both take the same payload — title, description, screenshot, and the page
// context recorded with the capture — and file it as a bug with the screenshot
// attached. Credentials live in chrome.storage and never leave the device.
//
// Loaded as an ES module by the editor.

const STORE_KEY = 'qaBugTracker';

// ── config ──────────────────────────────────────────────────────────────────

export async function getBugConfig() {
    const r = await chrome.storage.local.get([STORE_KEY]);
    const c = r[STORE_KEY] || {};
    return {
        provider: c.provider || 'azure',
        azure: Object.assign({ orgs: [], pat: '' }, c.azure || {}),
        jira: Object.assign({ baseUrl: '', email: '', token: '', project: '' }, c.jira || {})
    };
}

export async function saveBugConfig(patch) {
    const cur = await getBugConfig();
    const next = {
        provider: patch.provider || cur.provider,
        azure: Object.assign({}, cur.azure, patch.azure || {}),
        jira: Object.assign({}, cur.jira, patch.jira || {})
    };
    next.jira.baseUrl = String(next.jira.baseUrl || '').trim().replace(/\/+$/, '');
    await chrome.storage.local.set({ [STORE_KEY]: next });
    return next;
}

// ── shared helpers ──────────────────────────────────────────────────────────

const b64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
};

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Older captures kept only the errors; newer ones keep the whole console.
// The one thing worth appending to a bug: where it happened. Everything else
// the capture recorded stays in the gallery, out of the ticket.
export function contextHtml(ctx) {
    if (!ctx || !ctx.url) return '';
    return `<hr/><p><b>URL:</b> <a href="${esc(ctx.url)}">${esc(ctx.url)}</a></p>`;
}

export function contextText(ctx) {
    if (!ctx || !ctx.url) return '';
    return `\nURL: ${ctx.url}`;
}

const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then(r => r.blob());

async function must(res, what) {
    if (res.ok) return res;
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { }
    throw new Error(`${what} failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
}

// ── Azure DevOps ────────────────────────────────────────────────────────────

const azAuth = (pat) => 'Basic ' + b64(':' + pat);
const azOrgUrl = (org) => `https://dev.azure.com/${encodeURIComponent(org)}`;

// Azure has no "list my organizations" call on dev.azure.com. The identity
// lives on a different service: resolve the profile, then ask for the accounts
// that member belongs to. This only works when the PAT was created with the
// "All accessible organizations" scope.
export async function azureOrgs(cfg) {
    if (!cfg.pat) throw new Error('Paste your PAT first');
    const auth = { Authorization: azAuth(cfg.pat), Accept: 'application/json' };

    const meRes = await fetch('https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1', { headers: auth });
    await must(meRes, 'Reading your profile');
    const me = await meRes.json();
    if (!me.id) throw new Error('Could not resolve your profile');

    const accRes = await fetch(`https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(me.id)}&api-version=7.1`, { headers: auth });
    await must(accRes, 'Listing organizations');
    const orgs = ((await accRes.json()).value || []).map(a => a.accountName).filter(Boolean).sort();

    if (!orgs.length) {
        throw new Error('No organizations returned. Recreate the PAT with the "All accessible organizations" scope.');
    }
    return { orgs, user: me.displayName || me.emailAddress || '' };
}

export async function azureProjects(cfg, org) {
    if (!cfg.pat) throw new Error('Azure DevOps is not configured');
    if (!org) return [];
    const res = await fetch(`${azOrgUrl(org)}/_apis/projects?api-version=7.1&$top=200`, {
        headers: { Authorization: azAuth(cfg.pat), Accept: 'application/json' }
    });
    await must(res, 'Listing projects');
    return ((await res.json()).value || [])
        .map(p => ({ key: p.name, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function azureTest(cfg) {
    const r = await azureOrgs(cfg);
    return { user: r.user || r.orgs[0], orgs: r.orgs };
}

// Azure exposes the allowed values of every field per work item type. Reading
// them keeps the dropdown honest when a process template renames them.
export async function azureFieldOptions(cfg, org, project, refName, workItemType = 'Bug') {
    if (!cfg.pat || !org || !project) return [];
    try {
        const res = await fetch(
            `${azOrgUrl(org)}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/fields/${encodeURIComponent(refName)}?$expand=allowedValues&api-version=7.1`,
            { headers: { Authorization: azAuth(cfg.pat), Accept: 'application/json' } }
        );
        if (!res.ok) return [];
        return ((await res.json()).allowedValues || []).map(String);
    } catch (e) {
        return [];
    }
}

async function azureUpload(org, project, pat, blob, fileName) {
    const res = await fetch(
        `${azOrgUrl(org)}/${encodeURIComponent(project)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`,
        { method: 'POST', headers: { Authorization: azAuth(pat), 'Content-Type': 'application/octet-stream' }, body: blob }
    );
    await must(res, 'Attachment upload');
    return (await res.json()).url;
}

// A Bug's steps live in ReproSteps, not Description: writing to the wrong field
// loses the text silently.
export async function azureCreateBug(cfg, data) {
    if (!cfg.pat) throw new Error('Azure DevOps is not configured');
    if (!data.org || !data.project) throw new Error('Pick an organization and project');
    if (!String(data.title || '').trim()) throw new Error('The title is empty');

    const blob = await dataUrlToBlob(data.screenshotDataUrl);
    const shotUrl = await azureUpload(data.org, data.project, cfg.pat, blob, `screenshot-${Date.now()}.png`);

    const repro = `<div>${data.description || 'See the screenshot below.'}</div>` +
        contextHtml(data.ctx) +
        `<hr/><h4>Screenshot</h4><img src="${shotUrl}" alt="Screenshot" style="max-width:100%"/>`;

    const ops = [
        { op: 'add', path: '/fields/System.Title', value: data.title },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: repro }
    ];
    if (data.severity) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: data.severity });
    if (data.priority) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: Number(data.priority) });
    if (data.assignedTo) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: data.assignedTo });
    if (data.tags && data.tags.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: data.tags.join('; ') });
    // the $ in $Bug must stay percent-encoded
    ops.push({
        op: 'add', path: '/relations/-',
        value: { rel: 'AttachedFile', url: shotUrl, attributes: { comment: 'Screenshot' } }
    });

    const res = await fetch(
        `${azOrgUrl(data.org)}/${encodeURIComponent(data.project)}/_apis/wit/workitems/%24Bug?api-version=7.1`,
        { method: 'POST', headers: { Authorization: azAuth(cfg.pat), 'Content-Type': 'application/json-patch+json' }, body: JSON.stringify(ops) }
    );
    await must(res, 'Bug creation');
    const wi = await res.json();
    return {
        key: String(wi.id),
        url: `${azOrgUrl(data.org)}/${encodeURIComponent(data.project)}/_workitems/edit/${wi.id}`
    };
}

// ── Jira Cloud ──────────────────────────────────────────────────────────────

const jiraAuth = (cfg) => 'Basic ' + b64(`${cfg.email}:${cfg.token}`);

export async function jiraTest(cfg) {
    if (!cfg.baseUrl || !cfg.email || !cfg.token) throw new Error('Jira is not configured');
    const res = await fetch(`${cfg.baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: jiraAuth(cfg), Accept: 'application/json' }
    });
    await must(res, 'Jira connection');
    const me = await res.json();
    return { user: me.displayName || me.emailAddress || 'connected' };
}

export async function jiraProjects(cfg) {
    const res = await fetch(`${cfg.baseUrl}/rest/api/3/project/search?maxResults=100&orderBy=name`, {
        headers: { Authorization: jiraAuth(cfg), Accept: 'application/json' }
    });
    await must(res, 'Loading projects');
    return ((await res.json()).values || []).map(p => ({ key: p.key, name: `${p.key} — ${p.name}` }));
}

// Jira v3 takes Atlassian Document Format, never a plain string.
// Jira renders an ADF text node literally: a bare URL stays dead text unless
// it carries a link mark. Split each line on its URLs and mark those runs.
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function adfLine(line) {
    const out = [];
    for (const part of line.split(URL_RE)) {
        if (!part) continue;
        out.push(/^https?:\/\//.test(part)
            ? { type: 'text', text: part, marks: [{ type: 'link', attrs: { href: part } }] }
            : { type: 'text', text: part });
    }
    return out;
}

function textToAdf(text) {
    return {
        type: 'doc', version: 1,
        content: String(text || '').split('\n').map(line => {
            const content = line ? adfLine(line) : [];
            return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
        })
    };
}

const stripHtml = (h) => String(h || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();

// ── HTML -> ADF ─────────────────────────────────────────────────────────────
// The editor writes real structure: <b> headings, <ol> steps, <ul> results.
// Jira v3 refuses HTML and refuses a plain string, so walk the DOM into the
// document format it does accept. Anything unrecognised degrades to a paragraph.

function adfText(str, marks) {
    const node = { type: 'text', text: str };
    const m = [];
    marks = marks || {};
    if (marks.bold) m.push({ type: 'strong' });
    if (marks.italic) m.push({ type: 'em' });
    if (marks.underline) m.push({ type: 'underline' });
    if (marks.href) m.push({ type: 'link', attrs: { href: marks.href } });
    if (m.length) node.marks = m;
    return node;
}

// inline content of one element: text nodes, <b>/<strong>, <br>
// adfInline runs deep inside the walk; the sink is set for the duration of one
// htmlToAdf call rather than threaded through every recursive frame.
let imgSink = null;

function adfInline(el) {
    const out = [];
    const walk = (n, marks) => {
        for (const c of n.childNodes) {
            if (c.nodeType === 3) {
                const t = c.textContent.replace(/\s+/g, ' ');
                if (t.trim()) out.push(adfText(t, marks));
            } else if (c.nodeType === 1) {
                const tag = c.tagName.toLowerCase();
                if (tag === 'br') { out.push({ type: 'hardBreak' }); continue; }
                if (tag === 'img') { collectImage(c, imgSink); continue; }
                walk(c, {
                    bold: marks.bold || tag === 'b' || tag === 'strong',
                    italic: marks.italic || tag === 'i' || tag === 'em',
                    underline: marks.underline || tag === 'u',
                    href: marks.href || (tag === 'a' ? c.getAttribute('href') || '' : '')
                });
            }
        }
    };
    walk(el, {});
    return out;
}

const adfPara = (content) => content.length ? { type: 'paragraph', content } : { type: 'paragraph' };

function adfList(listEl, ordered) {
    const items = [...listEl.querySelectorAll(':scope > li')]
        .map(li => ({ type: 'listItem', content: [adfPara(adfInline(li))] }))
        .filter(i => i.content[0].content && i.content[0].content.length);
    if (!items.length) return null;
    return { type: ordered ? 'orderedList' : 'bulletList', content: items };
}

// A data: URL cannot travel to Jira: an image has to be uploaded. Take it out
// of the prose and hand it to the caller, who attaches it to the issue.
function collectImage(img, images) {
    if (!images) return;
    const src = img.getAttribute('src') || '';
    if (src.startsWith('data:')) {
        images.push({ name: img.getAttribute('alt') || `image-${images.length + 1}.png`, dataUrl: src });
    }
}

export function htmlToAdf(html, images) {
    const content = [];
    imgSink = images || null;
    try {
        const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
        const root = doc.body.firstChild;

        for (const node of root.childNodes) {
            if (node.nodeType === 3) {
                const t = node.textContent.trim();
                if (t) content.push(adfPara([adfText(t)]));
                continue;
            }
            if (node.nodeType !== 1) continue;

            const tag = node.tagName.toLowerCase();
            if (tag === 'br') continue;                       // spacing between blocks
            if (tag === 'ol' || tag === 'ul') {
                const list = adfList(node, tag === 'ol');
                if (list) content.push(list);
                continue;
            }
            if (tag === 'img') { collectImage(node, images); continue; }
            const inline = adfInline(node);
            if (inline.length) content.push(adfPara(inline));
        }
    } catch (e) {
        // no DOMParser available: fall back to flat paragraphs
        imgSink = null;
        return textToAdf(stripHtml(html));
    }
    imgSink = null;

    return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph' }] };
}

// Every list Jira's own create screen offers for this project. Nothing here is
// hard-coded: rename a priority or add a component in Jira and it shows up.
// Each lookup is independent, so one failure never blanks the rest of the form.
export async function jiraCreateMeta(cfg, projectKey) {
    const auth = { Authorization: jiraAuth(cfg), Accept: 'application/json' };
    const errors = [];
    const get = async (path) => {
        try {
            const r = await fetch(`${cfg.baseUrl}${path}`, { headers: auth });
            if (!r.ok) { errors.push(`${path.split('?')[0]} → HTTP ${r.status}`); return null; }
            return await r.json();
        } catch (e) {
            errors.push(`${path.split('?')[0]} → ${e.message}`);
            return null;
        }
    };

    const [pri, users, project, labels, types] = await Promise.all([
        get('/rest/api/3/priority'),
        get(`/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`),
        get(`/rest/api/3/project/${encodeURIComponent(projectKey)}?expand=issueTypes`),
        get('/rest/api/3/label?maxResults=200'),
        get(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`)
    ]);

    // The endpoint answers { startAt, maxResults, total, issueTypes: [...] }.
    // Reading `values` here meant the real answer was never used, and every
    // request quietly took the fallback below - whose list comes from the
    // project's issue type scheme and can name types that createmeta refuses
    // with a 410. `values` stays as tolerance for sites that page it.
    const declared = (types && (types.issueTypes || types.values)) || [];
    let issueTypes = declared.filter(t => !t.subtask);

    // Some sites and roles get a 403 on createmeta but can still read the
    // project's own issueTypes. Worth trying, worth knowing it happened.
    if (!issueTypes.length && project && Array.isArray(project.issueTypes)) {
        errors.push('createmeta/issuetypes gave nothing; using the project issue type scheme');
        issueTypes = project.issueTypes.filter(t => !t.subtask);
    }

    // A project may call its bug type Defect, Fault, or anything at all - and it
    // may be named in another language. Never assume "Bug" exists.
    const bug = issueTypes.find(t => /bug|defect|fault/i.test(t.name)) || issueTypes[0] || null;

    return {
        errors,
        issueTypes: issueTypes.map(t => ({ id: t.id, name: t.name })),
        bugTypeId: bug ? bug.id : '',
        bugTypeName: bug ? bug.name : '',
        priorities: (Array.isArray(pri) ? pri : (pri && pri.values) || []).map(jiraOption),
        assignees: Array.isArray(users) ? users.map(u => ({ id: u.accountId, name: u.displayName })) : [],
        components: ((project && project.components) || []).map(c => c.name),
        // unreleased versions first: you rarely report a bug against an archived one
        versions: ((project && project.versions) || []).filter(v => !v.archived).map(v => v.name).reverse(),
        labels: (labels && labels.values) || []
    };
}

// Every field Jira's own create screen exposes for this project and issue type,
// with its type and its allowed values — the exact analogue of Azure's
// workitemtypes/{type}/fields?$expand=allowedValues. Nothing is chosen for you.
// An empty field list and a refused request are not the same answer, and the
// form cannot tell them apart once both arrive as [].
function metaError(status, detail) {
    const err = new Error(status
        ? `Jira createmeta refused (HTTP ${status})${detail ? ': ' + detail : ''}`
        : `Could not reach Jira: ${detail}`);
    err.status = status;
    // 410 Gone / 404 mean the endpoint itself is unavailable, not that this
    // project is. That is the one failure the form can work around.
    err.gone = status === 410 || status === 404;
    return err;
}

export async function jiraCreateFields(cfg, projectKey, issueTypeId) {
    if (!projectKey || !issueTypeId) return [];
    const auth = { Authorization: jiraAuth(cfg), Accept: 'application/json' };

    let res;
    try {
        res = await fetch(
            `${cfg.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`,
            { headers: auth }
        );
    } catch (e) {
        throw metaError(0, e.message);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw metaError(res.status, detail.slice(0, 200));
    }
    const body = await res.json();

    // Two shapes in the wild. The paged endpoint answers
    //   { fields: [ { fieldId, name, required, schema, allowedValues, ... } ] }
    // while the classic one answers
    //   { fields: { summary: { name, required, schema, ... }, ... } }
    // keyed by field id, with no fieldId inside. Normalise both to an array.
    const raw = body.fields || body.values || [];
    const values = Array.isArray(raw)
        ? raw
        : Object.entries(raw).map(([fieldId, f]) => Object.assign({ fieldId }, f));

    // Handled by dedicated inputs already, or never user-supplied.
    // issuelinks stays: plenty of projects make "Linked work items" required.
    const SKIP = new Set(['project', 'issuetype', 'summary', 'description', 'reporter', 'attachment']);

    return values
        .filter(f => f && f.fieldId && !SKIP.has(f.fieldId))
        .map(f => {
            const schema = f.schema || {};
            const isArray = schema.type === 'array';
            const base = isArray ? (schema.items || 'string') : schema.type;
            return {
                id: f.fieldId,
                name: f.name || f.fieldId,
                required: !!f.required,
                array: isArray,
                kind: base,                                   // string | option | user | version | component | number | date | priority ...
                autoCompleteUrl: f.autoCompleteUrl || '',
                // Jira only inlines allowedValues for some fields; the rest hand
                // you an autoCompleteUrl and expect you to ask.
                options: (f.allowedValues || []).map(jiraOption),
                defaultValue: f.hasDefaultValue ? f.defaultValue : undefined
            };
        });
}

// Exactly the kinds jiraCreateBug knows how to put in a payload. Anything else
// is rendered nowhere and sent never: a text box that guarantees an HTTP 400 is
// worse than a field that simply is not there.
const JIRA_WRITABLE_KINDS = new Set([
    'user', 'option', 'priority', 'resolution', 'component', 'version',
    'securitylevel', 'issuetype', 'group', 'number', 'string', 'date', 'datetime'
]);

export function jiraFieldSupported(f) {
    if (!f) return false;
    if (f.id === 'issuelinks') return true;      // handled by its own call
    if (f.id === 'labels') return true;          // array<string>, sent bare
    return JIRA_WRITABLE_KINDS.has(f.kind);
}

function jiraOption(v) {
    if (typeof v === 'string') return { id: v, name: v };
    return {
        id: v.id || v.accountId || v.key || v.value || v.name,
        name: v.name || v.value || v.displayName || v.inward || String(v.id || '')
    };
}

// Options for a field that did not inline them. Each endpoint answers in its
// own shape, which is why this cannot be one generic call.
export async function jiraFieldOptions(cfg, field, query = '', projectKey = '') {
    const auth = { Authorization: jiraAuth(cfg), Accept: 'application/json' };

    // Some fields (assignee, reporter) hand back an autoCompleteUrl that Jira
    // Cloud no longer serves. Their real endpoints are known, so use them.
    if (field.kind === 'user') {
        const url = projectKey
            ? `${cfg.baseUrl}/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&query=${encodeURIComponent(query)}&maxResults=50`
            : `${cfg.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=50`;
        try {
            const res = await fetch(url, { headers: auth });
            if (!res.ok) return [];
            const d = await res.json();
            return (Array.isArray(d) ? d : []).map(u => ({ id: u.accountId, name: u.displayName }));
        } catch (e) { return []; }
    }

    if (field.id === 'labels') {
        try {
            const res = await fetch(`${cfg.baseUrl}/rest/api/3/label?maxResults=200`, { headers: auth });
            if (!res.ok) return [];
            const d = await res.json();
            return (d.values || []).map(v => ({ id: v, name: v }));
        } catch (e) { return []; }
    }

    const url = field.autoCompleteUrl;
    if (!url) return [];
    try {
        const res = await fetch(url + encodeURIComponent(query), { headers: auth });
        if (!res.ok) return [];
        const d = await res.json();

        if (Array.isArray(d)) return d.map(jiraOption);
        if (Array.isArray(d.results)) return d.results.map(jiraOption);
        if (Array.isArray(d.values)) return d.values.map(jiraOption);
        // the label endpoint answers {suggestions:[{label:"x"}]}
        if (Array.isArray(d.suggestions)) return d.suggestions.map(x => ({ id: x.label || x.value, name: x.label || x.value }));
        return [];
    } catch (e) {
        return [];
    }
}

// The link types a site defines: "blocks", "is blocked by", "relates to"...
export async function jiraLinkTypes(cfg) {
    try {
        const res = await fetch(`${cfg.baseUrl}/rest/api/3/issueLinkType`, {
            headers: { Authorization: jiraAuth(cfg), Accept: 'application/json' }
        });
        if (!res.ok) return [];
        const d = await res.json();
        // each type reads two ways; offer both directions as separate choices
        const out = [];
        for (const t of d.issueLinkTypes || []) {
            out.push({ id: `${t.name}|outward`, name: t.outward });
            if (t.inward !== t.outward) out.push({ id: `${t.name}|inward`, name: t.inward });
        }
        return out;
    } catch (e) {
        return [];
    }
}

// Issue search for the linked-item picker.
export async function jiraIssuePicker(cfg, query) {
    if (!query) return [];
    try {
        const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/picker?query=${encodeURIComponent(query)}`, {
            headers: { Authorization: jiraAuth(cfg), Accept: 'application/json' }
        });
        if (!res.ok) return [];
        const d = await res.json();
        const out = [];
        for (const sec of d.sections || []) {
            for (const it of sec.issues || []) out.push({ id: it.key, name: `${it.key} — ${it.summaryText || ''}` });
        }
        return out;
    } catch (e) {
        return [];
    }
}

export async function jiraCreateBug(cfg, data) {
    if (!cfg.baseUrl || !cfg.email || !cfg.token) throw new Error('Jira is not configured');
    if (!data.project) throw new Error('Pick a project');
    if (!String(data.title || '').trim()) throw new Error('The title is empty');

    // Structure survives: headings stay bold, steps stay numbered, results stay
    // bulleted. The recorded context is appended as plain paragraphs.
    // Images pasted into the description ride along as attachments; the prose
    // itself stays clean.
    const inlineImages = [];
    const doc = htmlToAdf(data.description, inlineImages);
    doc.content = doc.content.concat(textToAdf(contextText(data.ctx)).content);

    if (!data.issueTypeId && !data.issueType) throw new Error('Could not resolve the issue type for this project');
    const fields = {
        project: { key: data.project },
        // by id when we resolved one; Jira rejects a name it does not have
        issuetype: data.issueTypeId ? { id: String(data.issueTypeId) } : { name: data.issueType },
        summary: data.title,
        description: doc
    };
    // Fields the create screen does not carry. Jira rejects the whole request if
    // they ride along with it, so they are applied once the issue exists.
    const after = {};
    const deferred = new Set((data.extraMeta || []).filter(f => f.postCreate).map(f => f.id));

    // Jira Cloud has no Severity field out of the box; Priority is the standard
    // equivalent. An explicit pick (sent by id below) always wins over the
    // level the AI inferred, which can only be matched by name.
    const PRIORITY = { High: 'Highest', Medium: 'Medium', Low: 'Low' };
    const priorityField = (data.extraMeta || []).find(f => f.id === 'priority');
    const pickedPriority = data.extra && data.extra.priority;
    if (!pickedPriority && priorityField) {
        const inferred = data.severity && PRIORITY[data.severity];
        if (inferred) {
            const target = priorityField.postCreate ? after : fields;
            target.priority = { name: inferred };
        }
    }

    // Each extra field is shaped by its own schema, because Jira rejects the
    // wrong wrapper: an option wants {id}, a user wants {accountId}, a version
    // wants [{id}], and a label is a bare string.
    for (const f of data.extraMeta || []) {
        const raw = (data.extra || {})[f.id];
        if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) continue;

        const wrap = (v) => {
            switch (f.kind) {
                case 'user': return { accountId: v };
                case 'group': return { name: String(v) };
                case 'option':
                case 'priority':
                case 'resolution':
                case 'component':
                case 'version':
                case 'securitylevel':
                case 'issuetype': return { id: String(v) };
                case 'number': return Number(v);
                case 'string':
                case 'date':
                case 'datetime': return v;
                // unreachable: jiraFieldSupported keeps these out of the form
                default: return v;
            }
        };

        if (f.id === 'labels') { fields.labels = [].concat(raw); continue; }
        if (f.id === 'issuelinks') continue;                    // linked after creation
        if (f.kind === 'string' && !f.array && f.id === 'environment') { fields[f.id] = textToAdf(raw); continue; }

        const target = deferred.has(f.id) ? after : fields;
        target[f.id] = f.array ? [].concat(raw).map(wrap) : wrap(Array.isArray(raw) ? raw[0] : raw);
    }

    const post = (f) => fetch(`${cfg.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: { Authorization: jiraAuth(cfg), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ fields: f })
    });

    let res = await post(fields);
    if (!res.ok && fields.priority) {
        // Belt and braces: createmeta should already have deferred Priority, but
        // a site can refuse it for reasons createmeta does not report.
        const { priority, ...rest } = fields;
        res = await post(rest);
        if (res.ok) after.priority = fields.priority;
    }
    await must(res, 'Issue creation');
    const issue = await res.json();

    const warnings = [];

    // Fields the create screen refused to carry. The edit screen almost always
    // does. A bug with no priority is still a bug; a 400 is nothing at all.
    if (Object.keys(after).length) {
        try {
            const upd = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${issue.key}`, {
                method: 'PUT',
                headers: { Authorization: jiraAuth(cfg), 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ fields: after })
            });
            if (!upd.ok) throw new Error(`HTTP ${upd.status}: ${(await upd.text().catch(() => '')).slice(0, 200)}`);
        } catch (e) {
            warnings.push(`Could not set ${Object.keys(after).join(', ')}: ${e.message}`);
        }
    }

    // Links cannot ride along with the create call.
    const links = (data.extra || {}).issuelinks;
    const linkType = (data.extra || {}).__linkType;
    if (links && links.length && linkType) {
        const [name, dir] = String(linkType).split('|');
        for (const key of [].concat(links)) {
            try {
                await fetch(`${cfg.baseUrl}/rest/api/3/issueLink`, {
                    method: 'POST',
                    headers: { Authorization: jiraAuth(cfg), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: { name },
                        inwardIssue: dir === 'inward' ? { key: issue.key } : { key },
                        outwardIssue: dir === 'inward' ? { key } : { key: issue.key }
                    })
                });
            } catch (e) { console.error('link failed:', key, e); }
        }
    }

    // Attachments are a separate call, and Jira rejects it without this header.
    // One multipart request carries the screenshot and everything the user
    // attached by hand; Jira accepts repeated `file` parts.
    try {
        const form = new FormData();
        if (data.screenshotDataUrl) {
            form.append('file', await dataUrlToBlob(data.screenshotDataUrl), `screenshot-${Date.now()}.png`);
        }
        for (const img of inlineImages) form.append('file', await dataUrlToBlob(img.dataUrl), img.name);
        for (const f of data.attachments || []) form.append('file', f, f.name);

        if (form.has('file')) {
            const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${issue.key}/attachments`, {
                method: 'POST',
                headers: { Authorization: jiraAuth(cfg), 'X-Atlassian-Token': 'no-check' },
                body: form
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
    } catch (e) {
        console.error('Attachment upload failed:', e);   // the issue exists; say so
    }

    return { key: issue.key, url: `${cfg.baseUrl}/browse/${issue.key}`, warnings };
}

// ── unified ─────────────────────────────────────────────────────────────────

export async function createBug(data) {
    const cfg = await getBugConfig();
    return cfg.provider === 'jira'
        ? jiraCreateBug(cfg.jira, data)
        : azureCreateBug(cfg.azure, data);
}
