// Content script for recording form fills.
//
// Idempotency guard: the manifest injects this file at document_idle, but
// popup.js's ensureContentScript() also re-injects it via executeScript when
// its ping goes unanswered - which happens after the (unpacked) extension is
// reloaded while a page stays open. Two injections into the same isolated
// world would re-declare every top-level `let`/`const`, throwing
// "Identifier 'isRecording' has already been declared" and leaving the tab
// with no working content script. Wrapping the whole file so a second
// injection is a no-op keeps those top-level names block-scoped (no
// collision) and simply skips re-running.
if (!window.__qaToolboxContentLoaded) {
    window.__qaToolboxContentLoaded = true;

let isRecording = false;
let recordedFields = [];
let mutationObserver = null;
let currentAppendToProfileId = null;  // Store appendToProfileId locally
let recordedElementMap = new WeakMap(); // Map elements to their index in recordedFields
let lastCapture = { time: 0, value: '', element: null }; // For temporal deduplication
let lastComboboxInput = null; // Last custom dropdown (input[role="combobox"]) the user opened

// Recording does NOT survive page loads: tell the background this page loaded.
// If this is the tab that was recording, the background stops the recording
// everywhere (its own state, storage and the side panel).
chrome.runtime.sendMessage({ action: 'recordingPageLoaded' }, () => {
    if (chrome.runtime.lastError) return;
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // A saved login was added/removed elsewhere (popup or right-click) - refresh
    // the floating button so the "Switch login" list is up to date immediately.
    if (request.action === 'swapChanged') {
        initFloatingButton();
        sendResponse && sendResponse({ ok: true });
        return;
    }
    // A switch went through but the server didn't take it (see verifySwitch in
    // session-swap.js) - say so on the page, where the user is looking.
    if (request.action === 'swapProblem') {
        showFabAiStatus('error', request.problem === 'other-user'
            ? `"${request.name}" opened as a different user (SSO sign-in). Log in as them, then press Update.`
            : request.reloginError
                ? `"${request.name}" has expired and the automatic login failed: ${request.reloginError}`
                : `"${request.name}" has expired. Log in again, then press Update to refresh it.`);
        sendResponse && sendResponse({ ok: true });
        return;
    }
    if (request.action === 'storageCookiesChanged') {
        stQueueCookieRefresh();
        sendResponse && sendResponse({ ok: true });
        return;
    }
    if (request.action === 'startRecording') {
        // Store appendToProfileId if provided
        currentAppendToProfileId = request.appendToProfileId || null;
        console.log('Starting recording for profile:', currentAppendToProfileId);

        // If recording for an existing profile, check for failed fields
        if (currentAppendToProfileId && request.checkFailedFields && request.fields) {
            console.log('Checking failed fields for profile:', currentAppendToProfileId);
            checkFailedFieldsForProfile(currentAppendToProfileId, request.fields, request.profileUrl);
        }

        startRecording();
        sendResponse({ success: true });
    }
    if (request.action === 'stopRecording') {
        const fields = stopRecording();
        sendResponse({ fields, url: window.location.href, appendToProfileId: currentAppendToProfileId });
    }
    if (request.action === 'getRecordingStatus') {
        sendResponse({ isRecording, fields: recordedFields, appendToProfileId: currentAppendToProfileId });
    }
    if (request.action === 'fillForm') {
        (async () => {
            const { fields, settings, profileId, profileUrl } = request;
            const result = await fillFormFields({ fields, settings, profileId, profileUrl });
            sendResponse(result || { success: true });
        })();
        return true; // Keep channel open for async response
    }
    if (request.action === 'scanFormFields') {
        (async () => { sendResponse(await scanPageFormFields(request.captureCombo !== false, request.known)); })();
        return true;
    }
    if (request.action === 'showAiSavePrompt') {
        showAiSavePromptModal(request.profile);
    }
    if (request.action === 'startInspectMode') {
        startInspectMode();
        sendResponse({ success: true });
    }
    if (request.action === 'startAutomationPicker') {
        // The framework/language/style were settled in the panel; carry them into
        // the pick so the page panel opens already knowing what it is writing.
        qaAutoCfg = {
            framework: request.framework, language: request.language, pom: !!request.pom,
            frameworkLabel: request.frameworkLabel, languageLabel: request.languageLabel,
        };
        startInspectMode((el) => showAutomationPanel(el));
        sendResponse({ success: true });
        return;
    }
    if (request.action === 'startXPathFinder') {
        const mode = request.mode; // 'extension' | 'ai'
        closeXPathFinderPanel();
        startInspectMode((el) => showXPathFinderPanel(el, mode));
        sendResponse({ success: true });
    }
    if (request.action === 'startImageOcr') {
        closeImageOcrPanel();
        startInspectMode(handleImageOcrPick);
        sendResponse({ success: true });
    }
    if (request.action === 'runLinkHealth') {
        runLinkHealth();
        sendResponse({ success: true });
    }
    if (request.action === 'runPerformance') {
        runPerformance();
        sendResponse({ success: true });
    }
    if (request.action === 'runImagesFinder') {
        runImagesFinder();
        sendResponse({ success: true });
    }
    if (request.action === 'countPageImages') {
        // Read-only: just the number, for the popup's badge - no panel, no
        // qaCancelAllTools, nothing that disturbs whatever tool (if any) is
        // already running on the page.
        try { sendResponse({ count: collectPageImages().length }); }
        catch (e) { sendResponse({ count: 0 }); }
    }
    if (request.action === 'openResponsive') {
        openResponsiveOverlay();
        // Unlike the other panels, this one builds itself inside an async
        // chrome.storage.local.get callback - #qa-rv doesn't exist yet the
        // instant openResponsiveOverlay() returns, so checking for it here
        // would always (wrongly) report closed. The listener already
        // returns true below, so the channel stays open for this.
        setTimeout(() => sendResponse({ success: true, open: !!document.getElementById('qa-rv') }), 150);
    }
    if (request.action === 'openStorage') {
        openStoragePanel();
        sendResponse({ success: true, open: !!document.getElementById('qa-storage') });
    }
    if (request.action === 'openMeasure') {
        openMeasureTool();
        sendResponse({ open: !!liState });   // report new toggle state to the panel
    }
    if (request.action === 'measureStatus') { sendResponse({ open: !!liState }); }
    if (request.action === 'openTextMatch') {
        openTextMatchPanel();
        sendResponse({ success: true, open: !!document.getElementById('qa-tm') });
    }
    if (request.action === 'openApiExport') {
        openApiExportPanel();
        sendResponse({ success: true, open: !!document.getElementById('qa-ax') });
    }
    if (request.action === 'openTimeMachine') {
        openTimeMachinePanel();
        sendResponse({ success: true, open: !!document.getElementById('qa-tmx') });
    }
    if (request.action === 'arStart') { arArm(request.seconds); sendResponse({ success: true }); }
    if (request.action === 'arStop') { arArm(0); sendResponse({ success: true }); }
    if (request.action === 'highlightBySelector') { sendResponse(highlightSelector(request.query)); }
    if (request.action === 'clearHighlight') { clearHighlights(); sendResponse({ success: true }); }
    if (request.action === 'settingsChanged') {
        refreshFieldAiIconSetting();
    }
    if (request.action === 'updateFloatingButton' || request.action === 'recheckFloatingButton') {
        const enabled = request.action === 'updateFloatingButton' ? request.enabled : true;
        if (enabled) {
            initFloatingButton();
        } else {
            cleanupFloatingButton();
        }
    }
    return true;
});

// Relay console-capture batches (from the MAIN-world script) to the background
window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !Array.isArray(e.data.batch)) return;
    if (e.data.__qaConsole) chrome.runtime.sendMessage({ action: 'consoleBatch', batch: e.data.batch }).catch(() => { });
    else if (e.data.__qaNetwork) chrome.runtime.sendMessage({ action: 'networkBatch', batch: e.data.batch }).catch(() => { });
}, false);

// Highlight by selector: outline elements matching a CSS selector or XPath.
let hlEls = [];
function clearHighlights() {
    hlEls.forEach(el => { try { el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); } catch (e) { } });
    hlEls = [];
}
function highlightSelector(query) {
    clearHighlights();
    const q = (query || '').trim();
    if (!q) return { count: 0 };
    let nodes = [];
    try {
        const isXPath = q.startsWith('/') || q.startsWith('(') || q.startsWith('./') || q.startsWith('//');
        if (isXPath) {
            const r = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n && n.nodeType === 1) nodes.push(n); }
        } else {
            nodes = [...document.querySelectorAll(q)];
        }
    } catch (e) { return { error: e.message || 'Invalid selector' }; }
    nodes.forEach(el => {
        el.style.setProperty('outline', '2px solid #22c55e', 'important');
        el.style.setProperty('outline-offset', '1px', 'important');
        hlEls.push(el);
    });
    if (nodes[0]) { try { nodes[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { } }
    return { count: nodes.length };
}

// Auto Refresh: re-arm the reload timer on every page load using the interval
// saved for this tab in the background. The countdown shows in the TAB TITLE
// (stopping is done from the extension side panel).
// Auto-refresh indicator = a SMOOTHLY pulsing orange dot as the tab's favicon
// (replaces the site icon while active) + a countdown in the title. The favicon
// is redrawn ~11x/sec for a smooth pulse; the countdown updates each second.
let arCountdown = null, arSavedIcons = null;
const AR_TITLE_RE = /^↻ \d+s · /;
function arTitle(left) { document.title = `↻ ${left}s · ${document.title.replace(AR_TITLE_RE, '')}`; }
function arArm(seconds) {
    if (arCountdown) { clearInterval(arCountdown); arCountdown = null; }
    if (!(seconds > 0)) { arClearIndicator(); return; }
    let left = seconds;
    arTitle(left);
    if (arSavedIcons === null) { // hide the site's own favicons so ours shows
        arSavedIcons = [...document.querySelectorAll('link[rel~="icon"]:not(#qa-ar-favicon)')];
        arSavedIcons.forEach(l => { l.rel = 'qa-disabled-icon'; });
    }
    arDrawFavicon(); // a clean static dot (the tab strip can't animate smoothly)
    arCountdown = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(arCountdown); arCountdown = null; try { location.reload(); } catch (e) { } return; }
        arTitle(left);
    }, 1000);
}
function arDrawFavicon() {
    let link = document.getElementById('qa-ar-favicon');
    if (!link) { link = document.createElement('link'); link.id = 'qa-ar-favicon'; link.rel = 'icon'; (document.head || document.documentElement).appendChild(link); }
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(16, 16, 15, 0, Math.PI * 2); ctx.fillStyle = '#f97316'; ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(16, 16, 10, 0, Math.PI * 2); ctx.fillStyle = '#f97316'; ctx.fill();
    try { link.href = c.toDataURL('image/png'); } catch (e) { }
}
function arClearIndicator() {
    document.title = document.title.replace(AR_TITLE_RE, '');
    const link = document.getElementById('qa-ar-favicon'); if (link) link.remove();
    if (arSavedIcons) { arSavedIcons.forEach(l => { l.rel = 'icon'; }); arSavedIcons = null; }
}
try {
    chrome.runtime.sendMessage({ action: 'arGet' }, (r) => {
        if (chrome.runtime.lastError) return;
        if (r && r.seconds) arArm(r.seconds);
    });
} catch (e) { }

// Floating Button Support
let matchingProfiles = [];
let matchingLogins = [];       // saved logins (Snapshot & Swap) for this site
const fabAiFillEnabled = true; // the "AI Fill" option is always available in the FAB
let lastCheckUrl = '';
let fabInitTimeout = null;

async function initFloatingButton() {
    // Debounce calls
    if (fabInitTimeout) clearTimeout(fabInitTimeout);
    fabInitTimeout = setTimeout(async () => {
        const currentUrl = window.location.href;
        lastCheckUrl = currentUrl;

        chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
            if (chrome.runtime.lastError) return;
            const settings = response && response.settings;
            if (!settings || !settings.showFloatingButton) {
                cleanupFloatingButton();
                return;
            }
            // AI Fill is always available, so the floating button shows on every
            // page; matching profiles (if any) are listed under it
            chrome.runtime.sendMessage({ action: 'getMatchingProfiles', url: currentUrl }, (profRes) => {
                if (chrome.runtime.lastError) return;
                matchingProfiles = (profRes && profRes.profiles) || [];
                // Build the button now so its items always match the current
                // profiles (never block this on the swap-list round-trip).
                createFloatingButton();
                // Then pull this site's saved logins and re-render only if they changed.
                chrome.runtime.sendMessage({ action: 'swapList', url: currentUrl }, (swRes) => {
                    void chrome.runtime.lastError;
                    const next = (swRes && swRes.snaps) || [];
                    const changed = next.map((s) => s.id).join(',') !== matchingLogins.map((s) => s.id).join(',');
                    matchingLogins = next;
                    if (changed) createFloatingButton();
                    renderLoginBadge();     // "Logged in as <name>" on the page
                });
            });
        });
    }, 100);
}

// Show WHICH saved login you are currently in - INSIDE the floating button, as the
// user's name under the ⚡ icon (the button widens to fit it). A bar on the page always
// covered something, and a dot on the button's corner sat on the notification count.
// `active` comes from the worker, which works it out from WHO is signed in, so the name
// goes when you log out.
function renderLoginBadge() {
    const old = document.getElementById('ff-login-badge'); if (old) old.remove();   // the old on-page bar
    const btn = document.getElementById('ff-floating-btn'); if (!btn) return;
    const current = (matchingLogins || []).find((s) => s.active);
    let label = btn.querySelector('.ff-fab-user');
    if (current && !label) {
        label = document.createElement('span');
        label.className = 'ff-fab-user';
        btn.insertBefore(label, btn.querySelector('#ff-badge'));
    }
    if (label) label.textContent = current ? current.name : '';   // textContent = no injection
    btn.classList.toggle('ff-has-login', !!current);
    if (current) btn.title = 'Logged in as ' + current.name; else btn.removeAttribute('title');
}

// Settings → General → "Floating buttons opacity" (qaFloatOpacity, 20-100). One rule for
// both floating buttons - the fill button and the capture eye (#qa-cap-eye, its shadow
// HOST lives in the page, so a page-level rule reaches it). Solid again on hover, so a
// faint button is still easy to use. Live: follows the setting without a reload.
function qaApplyFloatOpacity(pct) {
    const v = Math.min(100, Math.max(20, parseInt(pct, 10) || 100)) / 100;
    let st = document.getElementById('qa-float-opacity');
    if (v >= 1) { if (st) st.remove(); return; }
    if (!st) { st = document.createElement('style'); st.id = 'qa-float-opacity'; (document.head || document.documentElement).appendChild(st); }
    st.textContent = `#ff-floating-btn, #qa-cap-eye { opacity: ${v}; transition: opacity .15s; }
        #ff-floating-btn:hover, #qa-cap-eye:hover { opacity: 1; }`;
}
if (window.top === window) {
    try {
        chrome.storage.local.get(['qaFloatOpacity'], (r) => { void chrome.runtime.lastError; qaApplyFloatOpacity(r && r.qaFloatOpacity); });
        chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.qaFloatOpacity) qaApplyFloatOpacity(ch.qaFloatOpacity.newValue); });
    } catch (e) { }
}

function cleanupFloatingButton() {
    const btn = document.getElementById('ff-floating-btn');
    if (btn) btn.remove();
    const menu = document.getElementById('ff-floating-menu');
    if (menu) menu.remove();
    const badge = document.getElementById('ff-login-badge');
    if (badge) badge.remove();
}

// Radical Monitoring: Watch for URL changes locally (for SPAs)
let lastObservedUrl = window.location.href;
setInterval(() => {
    if (window.location.href !== lastObservedUrl) {
        lastObservedUrl = window.location.href;
        console.log('FAB: URL change detected via heartbeat', lastObservedUrl);
        initFloatingButton();
    }
}, 1000);

window.addEventListener('popstate', () => {
    lastObservedUrl = window.location.href;
    initFloatingButton();
});

// Also watch for DOM changes that might indicate a page transition
const spaObserver = new MutationObserver(() => {
    if (window.location.href !== lastObservedUrl) {
        lastObservedUrl = window.location.href;
        initFloatingButton();
    }
});
spaObserver.observe(document.querySelector('title') || document.documentElement, { subtree: true, characterData: true, childList: true });

// Check on load
initFloatingButton();

function startRecording() {
    // Prevent double recording
    if (isRecording) return;

    isRecording = true;
    recordedFields = [];
    recordedElementMap = new WeakMap();

    // Register with background (it tracks which tab records, so a page
    // refresh in this tab stops the recording instead of resuming it)
    chrome.runtime.sendMessage({ action: 'recordingStarted', appendToProfileId: currentAppendToProfileId }, () => {
        if (chrome.runtime.lastError) return;
    });

    showRecordingIndicator();

    // Listen to all input events
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('blur', handleBlur, true);

    // Watch for DOM changes (date pickers, dropdowns, etc.)
    startMutationObserver();

    // Capture any existing values - DISABLED to avoid capturing pre-filled fields
    // setTimeout(captureVisibleFields, 500);
}

function stopRecording() {
    isRecording = false;
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('blur', handleBlur, true);

    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    // Clear state from storage
    chrome.storage.sync.remove('isRecordingActive');

    hideRecordingIndicator();
    // Hand back the fields but clear local state, so a second stop call
    // (e.g. from the side panel after the page bar already stopped) can't
    // re-save the previous recording
    const fields = recordedFields;
    recordedFields = [];
    recordedElementMap = new WeakMap();
    return fields;
}

function startMutationObserver() {
    mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'value') {
                const el = mutation.target;
                if (el.tagName && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
                    captureField(el);
                }
            }
        });
    });

    mutationObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['value'],
        subtree: true
    });
}

function handleInput(e) {
    if (!isRecording) return;
    captureField(e.target);
}

function handleChange(e) {
    if (!isRecording) return;
    captureField(e.target);
}

function handleBlur(e) {
    if (!isRecording) return;
    // Capture on blur for date pickers that update value after selection
    setTimeout(() => captureField(e.target), 100);
}

function handleClick(e) {
    if (!isRecording) return;
    const target = e.target;

    // Track the last custom dropdown the user opened (input[role="combobox"]),
    // so we know which input to capture when an option is clicked later
    try {
        const comboInput = (target.tagName === 'INPUT' && target.getAttribute('role') === 'combobox')
            ? target
            : (target.closest ? target.closest('input[role="combobox"]') : null);
        if (comboInput) lastComboboxInput = comboInput;
    } catch (err) { }

    // Custom dropdown option clicked: the page writes the selection into the
    // combobox input programmatically (no input/change events fire), so capture
    // the linked input ourselves after a short delay
    try {
        const optionEl = target.closest ? target.closest('[role="option"], [role="listbox"] li') : null;
        if (optionEl) {
            let input = null;
            const listbox = optionEl.closest('[role="listbox"]');
            if (listbox && listbox.id) {
                input = document.querySelector(
                    `input[aria-controls="${CSS.escape(listbox.id)}"], input[aria-owns="${CSS.escape(listbox.id)}"]`
                );
            }
            if (!input) input = lastComboboxInput;
            if (input) {
                [150, 400, 800].forEach(delay => {
                    setTimeout(() => {
                        if (input.value) captureField(input);
                    }, delay);
                });
            }
        }
    } catch (err) { }

    // For date pickers - check value after a delay
    if (target.tagName === 'INPUT' || target.closest('input')) {
        const input = target.tagName === 'INPUT' ? target : target.closest('input');
        if (input) {
            // Check multiple times for date pickers
            [100, 300, 500, 1000].forEach(delay => {
                setTimeout(() => {
                    if (input.value) captureField(input);
                }, delay);
            });
        }
    }
}

function captureVisibleFields() {
    if (!isRecording) return;

    const inputs = document.querySelectorAll('input, select, textarea');
    inputs.forEach(el => {
        if (el.value && el.offsetParent !== null) {
            captureField(el);
        }
    });
}

function captureField(element) {
    if (!element || !element.tagName || !isRecording) return;

    const tagName = element.tagName.toLowerCase();
    const isRichText = !['input', 'textarea', 'select'].includes(tagName) && element.isContentEditable;
    if (!['input', 'textarea', 'select'].includes(tagName) && !isRichText) return;

    // Get value
    let value = element.value;
    if (isRichText) {
        value = (element.innerText || '').trim();
    } else if (tagName === 'select' && element.selectedIndex >= 0) {
        value = element.options[element.selectedIndex].value;
    }

    if (!value) return;

    // 1. Visibility Guard: skip type="hidden" and invisible elements entirely.
    // The fill engine only fills VISIBLE elements, so recording hidden widget
    // internals (e.g. companion inputs inside custom dropdowns) only produces
    // duplicates and "selector mismatch" noise at fill time.
    if (element.type === 'hidden') return;
    if (element.offsetParent === null && !element.getClientRects().length) return;

    // 2. Temporal Deduplication: If same value captured within 500ms, it's likely the same logical interaction
    const now = Date.now();
    if (now - lastCapture.time < 500 && lastCapture.value === value) {
        // If the previous element was readonly and this one isn't, prefer this one
        if (lastCapture.element.readOnly && !element.readOnly) {
            // Replace the previous entry
            const index = recordedElementMap.get(lastCapture.element);
            if (index !== undefined) {
                const selector = generateSelector(element);
                recordedFields[index] = {
                    selector,
                    value,
                    type: element.type || tagName
                };
                recordedElementMap.delete(lastCapture.element);
                recordedElementMap.set(element, index);
                lastCapture = { time: now, value: value, element: element };
                flashElement(element);
                return;
            }
        }
        // Otherwise, skip this capture as it's a "echo" of the previous one
        return;
    }

    lastCapture = { time: now, value: value, element: element };

    // Deduplication: Check if this element has already been recorded in this session
    if (recordedElementMap.has(element)) {
        const index = recordedElementMap.get(element);
        recordedFields[index].value = value;
    } else {
        const selector = generateSelector(element);
        // Selector-level dedup: a DIFFERENT element can produce the same selector
        // (e.g. twin inputs inside widget internals) - update instead of duplicating
        const dupIndex = recordedFields.findIndex(f => f.selector === selector);
        if (dupIndex >= 0) {
            recordedFields[dupIndex].value = value;
            recordedElementMap.set(element, dupIndex);
        } else {
            recordedElementMap.set(element, recordedFields.length);
            recordedFields.push({
                selector,
                value,
                type: isRichText ? 'richtext' : (element.type || tagName)
            });
        }
    }

    flashElement(element);
    updateRecordingCount();
}

// Scan visible form fields on the page for AI profile generation.
// Includes text-like inputs, selects, textareas, checkboxes, and radio groups.
// Open a custom dropdown, read its options, then close it - so the AI gets the
// real choices for comboboxes whose listbox isn't in the DOM until opened.

// ── Custom dropdowns, across frameworks ───────────────────────────────────────
// A dropdown is very often NOT a <select>, and often not even an <input>:
//   Angular Material   <mat-select role="combobox" aria-haspopup="listbox">
//   MUI / Vuetify      <div role="combobox" aria-haspopup="listbox">
//   Element Plus       <div class="el-select__wrapper" role="combobox">
//   Ant / react-select <input role="combobox"> inside a styled wrapper
//   PrimeNG / Select2  <div|span role="combobox">
//   Headless UI        <button aria-haspopup="listbox">
//   Bootstrap / Clay   <button class="dropdown-toggle" aria-haspopup="true">
//   hand-rolled        <app-select formcontrolname="x"> - NO aria role anywhere, just a
//                      chevron <button aria-expanded> and (sometimes) a plain <input>
//                      inside that is really the component's SEARCH box
// …and the option list is rendered into an overlay at the END of <body>, or straight
// into the component, and only exists while the control is open. So the rule is always:
// open it, read it, close it - never assume the options are sitting in the DOM.

// Always a form control.
const DD_STRONG = '[role="combobox"], [aria-haspopup="listbox"]';
// Only a form control when it sits inside a form FIELD. On its own a menu button is
// site chrome - a navbar or a kebab menu - and must never be "filled".
const DD_WEAK = '[aria-haspopup="true"], [aria-haspopup="menu"], button.dropdown-toggle, a.dropdown-toggle';
const DD_FIELD_WRAP = 'fieldset, .form-group, .form-field, .form-item, mat-form-field, .field, .input-group';

function isCustomDropdown(el) {
    if (!el || el.tagName === 'SELECT') return false;
    try {
        if (el.matches(DD_STRONG)) return true;
        // A hand-rolled component with no ARIA at all. The one thing that gives it away
        // is that it IS a form control (Angular's formControlName) and it owns a toggle.
        // Getting this wrong is expensive: its inner <input> then looks like a text field,
        // the AI types a value into it, the component reads that as a SEARCH QUERY, opens
        // an empty list ("لا يوجد بيانات") and the real value is never set.
        if (el.hasAttribute('formcontrolname') && el.querySelector('[aria-expanded]')) return true;
        return el.matches(DD_WEAK) && !!el.closest(DD_FIELD_WRAP);
    } catch (e) { return false; }
}

// Whatever is on screen right now that behaves like an option. An open dropdown owns
// the only visible options on the page, so this needs no per-library knowledge.
//
// `fresh` is the set of elements that were NOT visible before we clicked. A hand-rolled
// component names nothing - no role, no known class - so the only thing that identifies
// its option list is that it just APPEARED. That works for any component ever written.
function ddReadOptions(el) {
    for (const root of ddPanels(el)) {
        const opts = ddOptionsIn(root);
        if (opts.length) return opts;
    }

    const panel = ddFreshPanel(el);
    if (panel) {
        const opts = ddOptionsIn(panel);
        if (opts.length) return opts;
    }

    // Last resort: some libraries (Ant Design's virtual list) render the options with
    // no visible listbox wrapper around them at all.
    return Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]')).filter(ddUsableOption);
}

function ddOptionsIn(panel) {
    let opts = Array.from(panel.querySelectorAll('[role="option"], [role="menuitem"], li, .dropdown-item, [class*="option"], [class*="item"]'));
    if (!opts.length) {
        // Nothing to go on: the panel's own rows ARE the options. Walk down through any
        // single-child wrappers until we reach the row list.
        let rows = Array.from(panel.children);
        while (rows.length === 1 && rows[0].children.length > 1) rows = Array.from(rows[0].children);
        opts = rows;
    }
    // Keep only the innermost rows - a row wrapped around other rows is a container.
    const usable = opts.filter(ddUsableOption);
    return usable.filter((o) => !usable.some((m) => m !== o && o.contains(m)));
}

// The list is closed, we click, something appears. THAT is the panel - whatever the
// component calls it. We only ever open one dropdown at a time, so a single snapshot,
// taken just before the click, is all the state this needs.
let ddBefore = null;
let ddBeforeEl = null;

// Take in the WHOLE document, not just the control and the top of <body>. A component is
// free to render its list into any container it likes - one of them renders into a
// wrapper of its own, halfway down the page - and if we don't see the panel we can
// neither read it nor close it, so it sat open on screen for the whole run.
// Recording identity only (no layout reads) keeps this cheap.
function ddSnapshot(el) {
    ddBeforeEl = el;
    try { ddBefore = new Set(document.querySelectorAll('*')); }
    catch (e) { ddBefore = null; }
}

function ddFreshPanel(el) {
    if (!el || !ddBefore || ddBeforeEl !== el) return null;
    const fresh = [];
    try {
        for (const n of document.querySelectorAll('*')) {
            if (!ddBefore.has(n) && isElementVisible(n)) fresh.push(n);
        }
    } catch (e) { return null; }
    if (!fresh.length) return null;
    return fresh.find((n) => !fresh.some((m) => m !== n && m.contains(n))) || fresh[0];
}

// An empty list still renders a row - "لا يوجد بيانات", "No data". Libraries mark it
// disabled; hand-rolled ones mark it nothing at all, so the text is the only tell.
// Choosing it would put nonsense in the field.
const DD_EMPTY_ROW = /^\s*(لا\s*(يوجد|توجد)|لا\s*بيانات|غير\s*متاح|no\s+(data|results?|options?|items?|matches)|not\s+found|nothing|empty)/i;

function ddUsableOption(o) {
    if (!isElementVisible(o) || !(o.innerText || '').trim()) return false;
    if (o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('disabled')) return false;
    const cls = String(o.className && o.className.baseVal !== undefined ? o.className.baseVal : (o.className || ''));
    if (/disabled|no-?data|empty|placeholder/i.test(cls)) return false;
    return !DD_EMPTY_ROW.test((o.innerText || '').trim());
}

// Every panel a dropdown library renders, whatever it calls it.
const DD_PANEL_SEL = [
    '[role="listbox"]', '[role="menu"]', '.dropdown-menu', '.cdk-overlay-pane',
    '.ng-dropdown-panel', '.p-dropdown-panel', '.p-multiselect-panel', '.p-autocomplete-panel',
    '.mat-select-panel', '.mat-mdc-select-panel', '.ant-select-dropdown', '.el-select-dropdown',
    '.select2-dropdown', '.chosen-drop', '.choices__list--dropdown',
].join(', ');

function ddPanels(el) {
    const out = [];
    const id = el && (el.getAttribute('aria-controls') || el.getAttribute('aria-owns'));
    const owned = id ? document.getElementById(id) : null;
    if (owned && isElementVisible(owned)) out.push(owned);
    for (const p of document.querySelectorAll(DD_PANEL_SEL)) {
        if (isElementVisible(p) && !out.includes(p)) out.push(p);
    }
    return out;
}

// "Is it open?" must NOT be answered by counting options. A list that opened EMPTY has
// zero options - so the old check called it closed, never closed it, and left the panel
// hanging under the field. It also covered the NEXT dropdown, so the click meant for
// that one landed on the stale panel and it was never filled.
// `fresh` (what appeared after the click) lets this see a hand-rolled panel that carries
// no class or role we could ever have guessed.
function ddIsOpen(el) {
    if (el) {
        // The flag usually sits on the chevron BUTTON inside the component, not on the host.
        if (el.getAttribute('aria-expanded') === 'true') return true;
        try { if (el.querySelector('[aria-expanded="true"]')) return true; } catch (e) { }
    }
    if (ddPanels(el).length > 0) return true;
    if (ddFreshPanel(el)) return true;
    // Last: options you can SEE. A component that never updates aria-expanded and renders
    // its list into some container of its own defeats every structural check above - and
    // then nothing closes it, so the last dropdown of the scan sat open on screen for the
    // whole run. If options are on the page, a list is open, whatever the markup claims.
    return ddReadOptions(el).length > 0;
}

// Escape sent to the control is NOT enough for a CDK/Material overlay - measured: the
// list stayed open, and every field after it then read the WRONG list. Those overlays
// listen for a backdrop click; everyone else listens for a click outside.
async function ddClose(el) {
    const esc = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    for (let i = 0; i < 5; i++) {
        if (!ddIsOpen(el)) return true;

        // Prefer the component's OWN toggle and Escape. A click on the page body reads as
        // "the user clicked away", which is what makes a control mark itself touched -
        // exactly the thing we are trying not to do. Keep it as the last resort.
        const backdrop = document.querySelector('.cdk-overlay-backdrop, .p-component-overlay, .modal-backdrop');
        if (backdrop) backdrop.click();
        const toggle = el && el.querySelector('[aria-expanded="true"]');
        if (toggle) ddMouse(toggle);
        (document.activeElement || document.body).dispatchEvent(esc());
        if (el) el.dispatchEvent(esc());
        document.dispatchEvent(esc());
        await new Promise((r) => setTimeout(r, 120));

        if (!ddIsOpen(el)) return true;
        ddMouse(document.body);
        await new Promise((r) => setTimeout(r, 120));
    }
    return !ddIsOpen(el);
}

// The full press a real user makes. Libraries bind to any one of these, so send them all.
function ddMouse(target) {
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        const Ev = t === 'pointerdown' ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ev(t, { bubbles: true, cancelable: true, view: window }));
    }
}

// Did the control actually open, even if the list came back empty? That difference is
// what stops us hammering a dropdown whose data never loaded.
const ddDidOpen = (el) => ddIsOpen(el);

async function ddAwaitOptions(el, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const opts = ddReadOptions(el);
        if (opts.length) return opts;
        if (Date.now() >= deadline) return [];
        await new Promise((r) => setTimeout(r, 40));
    }
}

// Open it and return its options. A click on the HOST bubbles UP - it never reaches an
// inner trigger element, which is where most libraries bind the handler - so click the
// deepest node at the control's centre, where a user's cursor would actually land.
//
// Give up FAST. A dropdown whose data never arrived (a dead lookup API) simply refuses
// to open, and waiting a second and a half on each one - once while scanning and again
// while filling - added half a minute to a seven-dropdown form for nothing.
async function ddOpen(el) {
    ddBefore = null;
    await ddClose(el);                          // a list left open by the previous field

    // Click the chevron if there is one: on a searchable component the wide part of the
    // control is a SEARCH BOX, and clicking that can start a text entry instead of just
    // opening the list. The toggle only ever opens - and dispatching straight to it needs
    // no scrolling, so the page never jumps from field to field while we work.
    let target = null;
    try {
        const toggle = el.querySelector('[aria-expanded]');
        if (toggle && isElementVisible(toggle)) target = toggle;
    } catch (e) { }

    if (!target) {
        // No toggle to aim at: we have to find the deepest node under the control's
        // centre, and that only works if the control is actually on screen.
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { }
        await new Promise((r) => setTimeout(r, 40));
        target = el;
        try {
            const r = el.getBoundingClientRect();
            const deep = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            if (deep && (deep === el || el.contains(deep))) target = deep;
        } catch (e) { }
    }

    // Deliberately NOT el.focus(). Focusing a dropdown and then moving to the next one
    // BLURS it, and a blur is exactly what makes a framework mark the control "touched"
    // - which made an untouched, empty, required dropdown paint "هذا الحقل مطلوب" the
    // moment AI Fill was pressed. A synthetic click does not move focus, so as long as
    // we never focus one, we never blur one, and the form stays as the user left it.
    ddSnapshot(el);                             // so we can see what the click produces
    ddMouse(target);

    const opts = await ddAwaitOptions(el, 500);
    if (opts.length) return opts;
    if (ddDidOpen(el)) return [];               // it DID open - the list is simply empty

    // Some widgets only open from the keyboard. One attempt, then stop.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
    return await ddAwaitOptions(el, 300);
}

async function ddPick(option) {
    try { option.scrollIntoView({ block: 'nearest' }); } catch (e) { }
    ddMouse(option);
    await new Promise((r) => setTimeout(r, 200));
}


// A real dropdown can hold hundreds of options (a department list, a country list). The
// AI needs to see CHOICES, not an inventory - sending 500 of them just makes the prompt
// huge and the answer slow. Take a short window, from a random place in the list each
// run, so the choice still varies from fill to fill instead of always being the first ten.
const DD_MAX_OPTIONS = 10;

function ddSampleOptions(texts) {
    if (texts.length <= DD_MAX_OPTIONS) return texts;
    const start = Math.floor(Math.random() * (texts.length - DD_MAX_OPTIONS + 1));
    return texts.slice(start, start + DD_MAX_OPTIONS);
}

// Read a custom dropdown's options: open it, note them, close it again. The AI decides
// which one to use; the fill then opens it again and picks that option.
async function captureComboboxOptions(el) {
    const read = async () => {
        const opts = (await ddOpen(el)).map((o) => (o.innerText || '').trim()).filter(Boolean);
        await ddClose(el);
        return opts;
    };
    try {
        let opts = await read();
        if (!opts.length) {
            // Empty on the first look is not proof it is empty. A list that depends on
            // another field reloads from the server the moment that field changes, and a
            // list on a field that only just appeared may still be on the wire. Writing it
            // off here is why a conditional dropdown was left unselected. Look again.
            await new Promise((r) => setTimeout(r, 800));
            opts = await read();
        }
        return ddSampleOptions(opts);
    } catch (e) {
        try { await ddClose(el); } catch (e2) { }
        return [];
    }
}

async function scanPageFormFields(captureCombo = true, known = []) {
    const skipTypes = ['hidden', 'submit', 'button', 'reset', 'image', 'file'];
    const fields = [];
    const seenSelectors = new Set();
    const seenRadioGroups = new Set();
    const MAX_FIELDS = 60;

    // Dropdowns already handled by an earlier pass must not be opened again.
    const knownSelectors = new Set(known || []);

    // Most frameworks do NOT use label[for]. Angular Material, Bootstrap and Clay
    // put the <label> next to the control inside a wrapper, so without this the AI
    // was being handed a form whose fields had no names at all.
    const labelFromWrapper = (el) => {
        try {
            let node = el.parentElement;
            for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
                // Once a wrapper holds more than one control its label is ambiguous -
                // climbing further would steal the neighbouring field's label.
                if (node.querySelectorAll('input, select, textarea, [role="combobox"], [aria-haspopup="listbox"]').length > 1) break;
                const l = node.querySelector('label, mat-label, legend, .control-label, .form-label');
                if (l && !l.contains(el)) {
                    const t = (l.innerText || '').trim();
                    if (t) return t;
                }
            }
        } catch (e) { }
        return '';
    };

    const getLabel = (el) => {
        try {
            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label && label.innerText.trim()) return label.innerText.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel && parentLabel.innerText.trim()) return parentLabel.innerText.trim();
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            return labelFromWrapper(el);
        } catch (e) { }
        return '';
    };

    // Dropdowns are not always <select> or even <input>: Angular Material renders a
    // custom <mat-select role="combobox"> element, others use <div>/<button> with
    // aria-haspopup="listbox". A query for `input, select, textarea` never saw them,
    // so the AI was never told those fields existed - it wasn't failing to fill them,
    // it didn't know they were there.
    // [formcontrolname] is in the list for the hand-rolled components (<app-select>):
    // they carry no role at all, and their only marks are that they ARE a form control
    // and that they own a toggle.
    let nodes = Array.from(document.querySelectorAll(
        `input, select, textarea, ${DD_STRONG}, ${DD_WEAK}, [formcontrolname]`));
    // The weak selectors also match site chrome (a navbar or kebab menu button), and
    // [formcontrolname] matches every Angular control. isCustomDropdown only accepts the
    // real dropdowns - drop everything else that is not a plain field, or we would
    // "fill" the account menu.
    nodes = nodes.filter((n) => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName) || isCustomDropdown(n));
    const ddNodes = nodes.filter(isCustomDropdown);
    // A dropdown wrapped in another dropdown: the innermost one is the real control.
    const innerDD = ddNodes.filter((n) => !ddNodes.some((m) => m !== n && n.contains(m)));
    // …and a plain input living INSIDE a dropdown is that dropdown's display box,
    // not a field of its own.
    nodes = nodes.filter((n) => innerDD.includes(n)
        || (!isCustomDropdown(n) && !innerDD.some((d) => d.contains(n))));

    for (const el of nodes) {
        if (fields.length >= MAX_FIELDS) break;

        const tagName = el.tagName.toLowerCase();
        let type = (el.type || tagName).toLowerCase();
        const isCombobox = isCustomDropdown(el);
        if (isCombobox) type = 'combobox';

        // A datepicker's input is a plain text box that the widget writes into. Calling
        // it "date" is what tells the AI to answer in YYYY-MM-DD instead of inventing a
        // format the parser rejects.
        const isDatePicker = tagName === 'input' && !isCombobox
            && (el.hasAttribute('ngbdatepicker') || el.hasAttribute('bsdatepicker')
                || /datepicker|datetimepicker/i.test(String(el.className || '')));
        if (isDatePicker) type = 'date';

        if (tagName === 'input' && skipTypes.includes(type)) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        // A readonly input is usually NOT a display-only field: it is a real form control
        // driven by a widget (a datepicker, a masked field, a custom dropdown). Skipping
        // every one of them left every date on the form blank.
        if (el.readOnly && !isCombobox && !isDatePicker && !el.hasAttribute('formcontrolname')) continue;
        if (el.offsetParent === null && !el.getClientRects().length) continue;

        // Note: no DOM-level noise filtering here - the AI itself decides whether
        // the scanned fields form a real form (isRealForm) and skips page controls
        // like search boxes and pagination. Keeps the scan free of fragile heuristics.

        // Radio buttons: one field entry per GROUP (same name), with the
        // group's options. Nameless radios are skipped (can't be grouped).
        if (type === 'radio') {
            const groupName = el.name || '';
            if (!groupName || seenRadioGroups.has(groupName)) continue;
            seenRadioGroups.add(groupName);

            let groupEls = [];
            try {
                groupEls = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`));
            } catch (e) { continue; }

            const options = groupEls.map(r => {
                let text = '';
                try {
                    if (r.id) {
                        const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
                        if (lbl && lbl.innerText.trim()) text = lbl.innerText.trim();
                    }
                    if (!text) {
                        const parentLbl = r.closest('label');
                        if (parentLbl && parentLbl.innerText.trim()) text = parentLbl.innerText.trim();
                    }
                } catch (e) { }
                return { value: r.value, text: (text || r.value).substring(0, 60) };
            }).filter(o => o.value);
            if (options.length === 0) continue;

            // Group label: fieldset legend is the most reliable source
            let groupLabel = '';
            try {
                const fieldset = el.closest('fieldset');
                const legend = fieldset ? fieldset.querySelector('legend') : null;
                if (legend && legend.innerText.trim()) groupLabel = legend.innerText.trim();
                if (!groupLabel) groupLabel = getLabel(el);
            } catch (e) { }

            const radioSelector = `input[type="radio"][name="${CSS.escape(groupName)}"]`;
            if (seenSelectors.has(radioSelector)) continue;
            seenSelectors.add(radioSelector);

            const checkedEl = groupEls.find(r => r.checked);
            fields.push({
                index: fields.length,
                selector: radioSelector,
                tag: 'input',
                type: 'radio',
                name: groupName,
                label: groupLabel.substring(0, 120),
                placeholder: '',
                required: groupEls.some(r => r.required),
                maxLength: null,
                options,
                checked: checkedEl ? checkedEl.value : null
            });
            continue;
        }

        let selector = '';
        try {
            selector = generateSelector(el);
        } catch (e) { }
        if (!selector || seenSelectors.has(selector)) continue;
        seenSelectors.add(selector);

        let label = getLabel(el);
        // Checkboxes often have their text in a sibling element, not a <label>
        if (!label && type === 'checkbox') {
            try {
                const container = el.closest('div, li, td, p');
                if (container && container.innerText) label = container.innerText.trim();
            } catch (e) { }
        }

        const field = {
            index: fields.length,
            selector,
            tag: tagName,
            type,
            name: el.name || el.getAttribute('formcontrolname') || '',
            label: label.substring(0, 120),
            // A custom dropdown has no .placeholder property, but its closed trigger
            // shows one ("اختر الجنس") - the clearest hint about the field there is.
            placeholder: (el.placeholder || (isCombobox ? (el.innerText || '').trim() : '') || '').substring(0, 60),
            required: !!el.required || el.getAttribute('aria-required') === 'true',
            maxLength: el.maxLength > 0 ? el.maxLength : null
        };

        if (tagName === 'select') {
            const all = Array.from(el.options).filter(o => o.value && o.value.trim() !== '');
            field.options = ddSampleOptions(all)
                .map(o => ({ value: o.value, text: o.text.trim().substring(0, 60) }));
        }

        if (type === 'checkbox') {
            field.checked = el.checked;
        }

        // Custom dropdowns: read the options so the AI can pick a real one (and write
        // dependent text fields to match it). Try the linked listbox first; if it isn't
        // in the DOM yet, open the dropdown to capture them and close it again.
        if (isCombobox) {
            const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            const listbox = listId ? document.getElementById(listId) : null;
            if (listbox) {
                const opts = ddSampleOptions(Array.from(listbox.querySelectorAll('[role="option"], li'))
                    .map(o => (o.innerText || '').trim())
                    .filter(Boolean));
                if (opts.length > 0) {
                    field.options = opts.map(t => ({ value: t.substring(0, 60), text: t.substring(0, 60) }));
                }
            }
            if (captureCombo && !knownSelectors.has(selector) && (!field.options || field.options.length === 0)) {
                const opts = await captureComboboxOptions(el);
                if (opts.length > 0) {
                    field.options = opts.map(t => ({ value: t.substring(0, 60), text: t.substring(0, 60) }));
                } else {
                    // Its data never loaded (a dead lookup API). Nothing can be selected
                    // in it, so say so - the fill must not waste a second poking at it.
                    field.noOptions = true;
                }
            }
        }

        fields.push(field);
    }

    // Rich text editors (CKEditor, Quill, TinyMCE inline, ...): the real textarea
    // is hidden and the user-visible surface is a contenteditable div - scan those too
    if (fields.length < MAX_FIELDS) {
        const editors = document.querySelectorAll('[contenteditable="true"]');
        for (const el of editors) {
            if (fields.length >= MAX_FIELDS) break;
            if (el.offsetParent === null && !el.getClientRects().length) continue;

            let selector = '';
            try { selector = generateSelector(el); } catch (e) { }
            if (!selector || seenSelectors.has(selector)) continue;
            seenSelectors.add(selector);

            // Label: a meaningful aria-label, or the nearest <label> walking up the tree
            let label = '';
            try {
                const aria = el.getAttribute('aria-label') || '';
                if (aria && !/editing area/i.test(aria)) label = aria;
                if (!label) {
                    let node = el;
                    for (let i = 0; i < 4 && node.parentElement; i++) {
                        node = node.parentElement;
                        const lbl = node.querySelector('label');
                        if (lbl && lbl.innerText.trim()) { label = lbl.innerText.trim(); break; }
                    }
                }
            } catch (e) { }

            let placeholder = '';
            try {
                const ph = el.querySelector('[data-placeholder]');
                placeholder = el.getAttribute('data-placeholder') || (ph ? ph.getAttribute('data-placeholder') : '') || '';
            } catch (e) { }

            fields.push({
                index: fields.length,
                selector,
                tag: 'contenteditable',
                type: 'richtext',
                name: '',
                label: label.substring(0, 120),
                placeholder: placeholder.substring(0, 120),
                required: false,
                maxLength: null
            });
        }
    }

    // Nothing may be left hanging open. The last dropdown of the loop has no next one
    // whose opening would have closed it by accident, so it needs saying explicitly.
    if (captureCombo) { try { await ddClose(null); } catch (e) { } }

    const h1 = document.querySelector('h1');
    const metaDesc = document.querySelector('meta[name="description"]');

    return {
        fields,
        url: window.location.href.split('#')[0],
        pageContext: {
            title: (document.title || '').substring(0, 150),
            language: document.documentElement.lang || '',
            heading: h1 ? h1.innerText.trim().substring(0, 120) : '',
            description: metaDesc ? (metaDesc.content || '').substring(0, 200) : ''
        }
    };
}

// Ask the user whether to save the AI-generated profile after the form was filled.
// "Don't ask again" stores a flag so the choice is remembered for future AI fills.
function showAiSavePromptModal(profile) {
    const existing = document.getElementById('ff-ai-save-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ff-ai-save-modal';
    modal.innerHTML = `
        <div class="ff-ai-modal-content">
            <div class="ff-ai-modal-header">
                <div class="ff-ai-modal-icon"><i class="fas fa-wand-magic-sparkles"></i>&#10024;</div>
                <h3 class="ff-ai-modal-title">Form filled by AI</h3>
                <p class="ff-ai-modal-subtitle">Profile: "${escapeHtml(profile.name)}" &middot; ${profile.fields.length} field(s)</p>
            </div>
            <div class="ff-ai-modal-body">
                <p class="ff-ai-modal-question">Do you want to save this profile for future use?</p>
                <label class="ff-ai-dont-ask">
                    <input type="checkbox" id="ff-ai-dont-ask-check">
                    <span>Don't ask again &mdash; remember my choice</span>
                </label>
            </div>
            <div class="ff-ai-modal-actions">
                <button class="ff-ai-btn ff-ai-btn-save" id="ff-ai-btn-save">Save Profile</button>
                <button class="ff-ai-btn ff-ai-btn-discard" id="ff-ai-btn-discard">Don't Save</button>
            </div>
        </div>
    `;

    if (!document.getElementById('ff-ai-save-modal-styles')) {
        const style = document.createElement('style');
        style.id = 'ff-ai-save-modal-styles';
        style.textContent = `
            #ff-ai-save-modal {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 2147483647;
                font-family: 'Segoe UI', Arial, sans-serif;
            }
            .ff-ai-modal-content {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 16px;
                width: 340px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
                border: 2px solid rgba(139, 92, 246, 0.4);
                direction: ltr;
                overflow: hidden;
            }
            .ff-ai-modal-header {
                padding: 18px 20px 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                text-align: center;
            }
            .ff-ai-modal-icon { font-size: 28px; margin-bottom: 6px; }
            .ff-ai-modal-icon i { color: #8b5cf6; display: none; }
            .ff-ai-modal-title {
                color: white;
                font-size: 16px;
                font-weight: 700;
                margin: 0 0 4px;
            }
            .ff-ai-modal-subtitle {
                color: rgba(255, 255, 255, 0.7);
                font-size: 12px;
                margin: 0;
                word-break: break-word;
            }
            .ff-ai-modal-body { padding: 14px 20px 4px; }
            .ff-ai-modal-question {
                color: rgba(255, 255, 255, 0.85);
                font-size: 13px;
                margin: 0 0 12px;
            }
            .ff-ai-dont-ask {
                display: flex;
                align-items: center;
                gap: 8px;
                color: rgba(255, 255, 255, 0.6);
                font-size: 12px;
                cursor: pointer;
                user-select: none;
            }
            .ff-ai-dont-ask input { accent-color: #8b5cf6; cursor: pointer; }
            .ff-ai-modal-actions {
                padding: 14px 20px 18px;
                display: flex;
                gap: 8px;
            }
            .ff-ai-btn {
                flex: 1;
                padding: 10px 12px;
                border: none;
                border-radius: 10px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: 'Segoe UI', Arial, sans-serif;
            }
            .ff-ai-btn-save {
                background: linear-gradient(135deg, #8b5cf6, #6366f1);
                color: white;
            }
            .ff-ai-btn-save:hover { background: linear-gradient(135deg, #7c3aed, #4f46e5); }
            .ff-ai-btn-discard {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.7);
            }
            .ff-ai-btn-discard:hover { background: rgba(255, 255, 255, 0.2); color: white; }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(modal);

    modal.querySelector('#ff-ai-btn-save').addEventListener('click', () => {
        const dontAskAgain = modal.querySelector('#ff-ai-dont-ask-check').checked;
        chrome.runtime.sendMessage({ action: 'saveAiProfile', profile, dontAskAgain }, () => {
            if (chrome.runtime.lastError) console.warn('saveAiProfile error:', chrome.runtime.lastError);
        });
        modal.remove();
    });

    modal.querySelector('#ff-ai-btn-discard').addEventListener('click', () => {
        const dontAskAgain = modal.querySelector('#ff-ai-dont-ask-check').checked;
        if (dontAskAgain) {
            // Remember "never save" - future AI fills won't show this prompt
            chrome.runtime.sendMessage({ action: 'setAiSaveBehavior', behavior: 'never' }, () => {
                if (chrome.runtime.lastError) console.warn('setAiSaveBehavior error:', chrome.runtime.lastError);
            });
        }
        modal.remove();
    });
}

// ==================== Element Inspector ====================
// Pick an element on the page (DevTools-style hover highlight), then show a
// panel with its selector, attributes, computed styles, and a custom-CSS box.

let inspectState = null;
let inspectedElement = null;
let inspectedOriginalStyle = null;

const INSPECTOR_COMMON_PROPS = [
    'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
    'margin', 'padding', 'border', 'border-radius', 'background-color', 'color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
    'z-index', 'opacity', 'overflow', 'visibility', 'cursor', 'box-shadow',
    'flex', 'gap', 'transform'
];

// Candidate keyword values for the value autocomplete. Filtered per property
// with CSS.supports(prop, keyword), so each property only suggests its own
// valid keywords (display -> flex/grid/..., position -> absolute/sticky/...).
const INSPECTOR_VALUE_KEYWORDS = [
    'auto', 'none', 'normal', 'inherit', 'initial', 'unset', 'revert',
    'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'flow-root', 'table', 'table-cell',
    'static', 'relative', 'absolute', 'fixed', 'sticky',
    'visible', 'hidden', 'scroll', 'clip', 'collapse',
    'pointer', 'default', 'move', 'text', 'grab', 'not-allowed', 'crosshair', 'wait', 'help',
    'left', 'right', 'center', 'justify', 'start', 'end',
    'bold', 'bolder', 'lighter', 'italic', 'oblique',
    'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-all', 'break-word', 'keep-all',
    'row', 'column', 'row-reverse', 'column-reverse', 'wrap', 'wrap-reverse',
    'flex-start', 'flex-end', 'space-between', 'space-around', 'space-evenly', 'stretch', 'baseline',
    'uppercase', 'lowercase', 'capitalize',
    'underline', 'line-through', 'overline',
    'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset',
    'border-box', 'content-box',
    'middle', 'top', 'bottom', 'text-top', 'text-bottom', 'sub', 'super',
    'cover', 'contain', 'fill', 'scale-down',
    'repeat', 'no-repeat', 'repeat-x', 'repeat-y',
    'ellipsis', 'disc', 'circle', 'square', 'decimal',
    'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear',
    'transparent', 'currentColor'
];

function startInspectMode(onPick) {
    qaCancelAllTools(); // stopInspectMode() + closeMeasureTool() + qaClosePanel()
    closeInspectorPanel();
    closeXPathFinderPanel();
    closeImageOcrPanel();

    const hl = document.createElement('div');
    hl.id = 'ff-insp-highlight';
    hl.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:rgba(99,102,241,0.18);border:2px solid #6366f1;border-radius:2px;display:none;';
    document.body.appendChild(hl);

    const badge = document.createElement('div');
    badge.id = 'ff-insp-badge';
    badge.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#6366f1;color:#fff;font:11px/1.7 monospace;padding:1px 8px;border-radius:4px;display:none;white-space:nowrap;';
    document.body.appendChild(badge);

    const onMove = (e) => {
        const t = e.target;
        if (!t || t === hl || t === badge || t === document.documentElement || t === document.body ||
            (t.closest && t.closest('#ff-insp-cancel'))) {
            hl.style.display = 'none';
            badge.style.display = 'none';
            return;
        }
        const r = t.getBoundingClientRect();
        hl.style.display = 'block';
        hl.style.top = r.top + 'px';
        hl.style.left = r.left + 'px';
        hl.style.width = r.width + 'px';
        hl.style.height = r.height + 'px';
        badge.style.display = 'block';
        badge.style.top = Math.max(2, r.top - 24) + 'px';
        badge.style.left = Math.max(2, r.left) + 'px';
        const cls = (t.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        badge.textContent = t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (cls ? '.' + cls : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    };

    const onClick = (e) => {
        // Ignore clicks on our own cancel bar (its own handler deals with it)
        if (e.target.closest && e.target.closest('#ff-insp-cancel')) return;
        e.preventDefault();
        e.stopPropagation();
        const target = e.target;
        stopInspectMode();
        if (target && target !== document.documentElement && target !== document.body) {
            (onPick || showInspectorPanel)(target);
        }
    };

    const onKey = (e) => {
        if (e.key === 'Escape') stopInspectMode();
    };

    // Cancel bar (top-center) so the user can exit without having to pick an element
    const cancel = document.createElement('div');
    cancel.id = 'ff-insp-cancel';
    cancel.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:rgba(15,15,35,0.95);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:24px;' +
        'padding:8px 16px;font-family:\'Segoe UI\',Arial,sans-serif;font-size:13px;display:flex;align-items:center;gap:12px;' +
        'box-shadow:0 6px 22px rgba(0,0,0,0.5);';
    cancel.innerHTML = '<span style="display:flex;align-items:center;gap:7px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg> Pick an element</span>' +
        '<button id="ff-insp-cancel-btn" style="background:#ef4444;border:none;color:#fff;border-radius:14px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">Cancel (Esc)</button>';
    document.body.appendChild(cancel);
    cancel.querySelector('#ff-insp-cancel-btn').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        stopInspectMode();
    });

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    inspectState = { hl, badge, cancel, onMove, onClick, onKey };
}

function stopInspectMode() {
    if (!inspectState) return;
    document.removeEventListener('mousemove', inspectState.onMove, true);
    document.removeEventListener('click', inspectState.onClick, true);
    document.removeEventListener('keydown', inspectState.onKey, true);
    inspectState.hl.remove();
    inspectState.badge.remove();
    if (inspectState.cancel) inspectState.cancel.remove();
    inspectState = null;
    // Let the side panel clear the active-tool highlight
    chrome.runtime.sendMessage({ action: 'inspectModeEnded' }).catch(() => { });
}

let inspectorDragCleanup = null;

// ============================================================================
// Element Inspector (revamped) — a clean, hybrid panel: smooth visual controls
// up top, full DevTools power (matched rules, live toggle/edit, box model)
// underneath. Live edits apply to the page; Copy CSS exports your inline edits.
// Namespace: #qa-ins. No emojis (inline SVG icons), no AI, no network.
// ============================================================================
let insRuleSnaps = null;     // CSSStyleDeclaration -> original cssText (for Reset)
let insDisabled = null;      // CSSStyleDeclaration -> { prop: {value, priority} }

const INS_IC = (() => {
    const w = (p) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    return {
        x: w('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        pick: w('<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>'),
        copy: w('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
        reset: w('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>')
    };
})();

// Quick-edit property catalogue (name -> input type). ~70 common CSS props.
//   color | px (number + px) | num (unitless number) | text (free / keyword)
const INS_QUICK_CATALOG = [
    ['color', 'color'], ['background-color', 'color'], ['border-color', 'color'], ['outline-color', 'color'], ['text-decoration-color', 'color'], ['caret-color', 'color'],
    ['font-size', 'px'], ['line-height', 'px'], ['letter-spacing', 'px'], ['word-spacing', 'px'], ['text-indent', 'px'],
    ['width', 'px'], ['height', 'px'], ['min-width', 'px'], ['max-width', 'px'], ['min-height', 'px'], ['max-height', 'px'],
    ['top', 'px'], ['right', 'px'], ['bottom', 'px'], ['left', 'px'],
    ['margin', 'px'], ['margin-top', 'px'], ['margin-right', 'px'], ['margin-bottom', 'px'], ['margin-left', 'px'],
    ['padding', 'px'], ['padding-top', 'px'], ['padding-right', 'px'], ['padding-bottom', 'px'], ['padding-left', 'px'],
    ['border-width', 'px'], ['border-radius', 'px'], ['outline-width', 'px'], ['outline-offset', 'px'],
    ['gap', 'px'], ['row-gap', 'px'], ['column-gap', 'px'],
    ['opacity', 'num'], ['z-index', 'num'], ['font-weight', 'num'], ['flex-grow', 'num'], ['flex-shrink', 'num'], ['order', 'num'], ['tab-size', 'num'],
    ['display', 'text'], ['position', 'text'], ['float', 'text'], ['clear', 'text'], ['box-sizing', 'text'],
    ['flex-direction', 'text'], ['flex-wrap', 'text'], ['justify-content', 'text'], ['align-items', 'text'], ['align-self', 'text'], ['flex', 'text'],
    ['text-align', 'text'], ['text-transform', 'text'], ['text-decoration', 'text'], ['font-style', 'text'], ['font-family', 'text'], ['font', 'text'],
    ['white-space', 'text'], ['overflow', 'text'], ['overflow-x', 'text'], ['overflow-y', 'text'], ['visibility', 'text'], ['cursor', 'text'], ['pointer-events', 'text'],
    ['box-shadow', 'text'], ['text-shadow', 'text'], ['transform', 'text'], ['transition', 'text'], ['filter', 'text'], ['backdrop-filter', 'text'],
    ['background', 'text'], ['background-image', 'text'], ['border', 'text'], ['border-style', 'text'], ['object-fit', 'text'], ['vertical-align', 'text'], ['list-style', 'text']
];
const INS_QUICK_TYPE = Object.fromEntries(INS_QUICK_CATALOG);

function closeInspectorPanel() {
    if (inspectorDragCleanup) { inspectorDragCleanup(); inspectorDragCleanup = null; }
    const p = document.getElementById('qa-ins');
    if (p) p.remove();
    ['qa-ins-style', 'qa-ins-state'].forEach(id => { const s = document.getElementById(id); if (s) s.remove(); });
    document.querySelectorAll('.qa-ins-target').forEach(n => n.classList.remove('qa-ins-target'));
    // also clean any leftover panel from older versions
    const old = document.getElementById('ff-insp-panel'); if (old) old.remove();
    inspectedElement = null;
    inspectedOriginalStyle = null;
    insRuleSnaps = null; insDisabled = null;
}

function insToHex(color) {
    try {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillStyle = color;
        const v = ctx.fillStyle;
        if (v.startsWith('#')) return v;
        const n = v.match(/\d+(\.\d+)?/g);
        if (n) return '#' + n.slice(0, 3).map(x => Math.round(+x).toString(16).padStart(2, '0')).join('');
    } catch (e) { }
    return '#000000';
}

// Prepend a small colour swatch input to colour tokens in a value string.
function insColorize(escaped, el) {
    return escaped.replace(/(var\(--[^)]*\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g, (m) => {
        let color = m;
        if (m.startsWith('var(')) {
            const name = m.match(/--[\w-]+/);
            color = '';
            if (name && el) { try { color = getComputedStyle(el).getPropertyValue(name[0]).trim(); } catch (e) { } }
            if (!color || !CSS.supports('color', color)) return m;
        }
        return `<input type="color" class="qa-ins-sw" data-token="${m}" value="${insToHex(color)}" title="Pick colour">${m}`;
    });
}

// Matched CSS rules for the element, later-wins first, inline ("element.style") on top.
function insMatchedBlocks(el) {
    const blocks = [];
    const collect = (rules) => {
        for (const rule of rules) {
            try {
                if (rule.selectorText && rule.style) {
                    if (el.matches(rule.selectorText)) blocks.push({ selector: rule.selectorText, style: rule.style });
                } else if (rule.cssRules && (!rule.media || matchMedia(rule.media.mediaText).matches)) {
                    collect(rule.cssRules);
                }
            } catch (e) { }
        }
    };
    for (const sheet of document.styleSheets) {
        if (sheet.ownerNode && sheet.ownerNode.id === 'qa-ins-state') continue; // our own injected rule
        try { collect(sheet.cssRules); } catch (e) { }
    }
    blocks.reverse();
    if (el.getAttribute('style') || (insDisabled && insDisabled.has(el.style))) {
        blocks.unshift({ selector: 'element.style', style: el.style });
    }
    return blocks;
}

function showInspectorPanel(el) {
    closeInspectorPanel();
    inspectedElement = el;
    inspectedOriginalStyle = el.getAttribute('style');
    insRuleSnaps = new Map();
    insDisabled = new Map();

    const sel = (() => { try { return generateSelector(el); } catch (e) { return ''; } })();

    // ---- styles ----
    const style = document.createElement('style');
    style.id = 'qa-ins-style';
    style.textContent = `
#qa-ins{position:fixed;top:16px;right:16px;width:328px;max-height:88vh;z-index:2147483647;display:flex;flex-direction:column;
  background:#17151f;color:#e5e7eb;border:1px solid #2a2738;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.6);
  font:12px/1.45 -apple-system,Segoe UI,sans-serif;overflow:hidden;direction:ltr;text-align:left;}
#qa-ins *{box-sizing:border-box;outline:none!important;direction:ltr;text-align:left;}
#qa-ins .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:#1c1a26;border-bottom:1px solid #2a2738;cursor:move;user-select:none;}
#qa-ins .hd .tag{background:#2d2a3e;color:#c4b5fd;font-weight:600;font-size:11px;padding:2px 7px;border-radius:5px;word-break:break-all;}
#qa-ins .hd .dim{color:#9b98ac;font-variant-numeric:tabular-nums;margin-left:6px;font-size:11px;}
#qa-ins .hd .hbtns{display:flex;gap:4px;flex-shrink:0;}
#qa-ins .iconbtn{all:unset;cursor:pointer;color:#8b8898;padding:5px;border-radius:7px;display:flex;}
#qa-ins .iconbtn:hover{background:#262335;color:#fff;}
#qa-ins .iconbtn.danger:hover{background:#3a1d24;color:#f87171;}
#qa-ins .tabs{display:flex;gap:2px;padding:8px 10px 0;background:#1c1a26;}
#qa-ins .tab{all:unset;cursor:pointer;flex:1;text-align:center;padding:8px 0;font-size:12px;font-weight:600;color:#8b8898;border-radius:8px 8px 0 0;}
#qa-ins .tab:hover{color:#cbd5e1;}
#qa-ins .tab.on{color:#fff;background:#17151f;}
#qa-ins .bd{overflow-y:auto;padding:14px;}
#qa-ins .pane{display:none;}
#qa-ins .pane.on{display:block;}
#qa-ins .grp{margin-bottom:16px;}
#qa-ins .grp:last-child{margin-bottom:0;}
#qa-ins .lbl{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#7e7b90;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;}
#qa-ins .lbl .mini{all:unset;cursor:pointer;font-size:10px;color:#a78bfa;padding:2px 7px;border-radius:5px;text-transform:none;letter-spacing:0;}
#qa-ins .lbl .mini:hover{background:#262335;}
#qa-ins .qrow{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
#qa-ins .qrow .nm{width:74px;color:#b9b6c8;flex:0 0 auto;}
#qa-ins .qrow input[type=range]{flex:1;accent-color:#7c3aed;height:4px;cursor:pointer;}
#qa-ins .qrow .val{width:42px;text-align:right;color:#fff;font-variant-numeric:tabular-nums;}
#qa-ins .qrow input[type=color]{width:30px;height:22px;border:none;border-radius:5px;background:none;padding:0;cursor:pointer;flex:0 0 auto;}
#qa-ins .qrow input[type=color]::-webkit-color-swatch{border:1px solid #3a3654;border-radius:5px;}
#qa-ins .qrow input[type=color]::-webkit-color-swatch-wrapper{padding:0;}
#qa-ins .qrow .hex{flex:1;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:7px;padding:5px 8px;font:12px monospace;min-width:0;}
#qa-ins .qrow .num{flex:1;min-width:0;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:7px;padding:5px 8px;font:12px monospace;text-align:left;-moz-appearance:textfield;}
#qa-ins .qrow .num::-webkit-inner-spin-button{opacity:.5;}
#qa-ins .qrow .num:focus,#qa-ins .qrow .hex:focus,#qa-ins .qrow .txt:focus{border-color:#7c3aed;}
#qa-ins .qrow .txt{flex:1;min-width:0;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:7px;padding:5px 8px;font:12px monospace;}
#qa-ins .qrow .unit{color:#7e7b90;font-size:11px;flex:0 0 auto;}
#qa-ins .qrow .rm{all:unset;cursor:pointer;color:#6b6878;flex:0 0 auto;padding:2px;border-radius:5px;display:flex;}
#qa-ins .qrow .rm:hover{color:#f87171;background:#3a1d24;}
#qa-ins .qrow .rm svg{width:13px;height:13px;}
/* state segmented toggle */
#qa-ins .states{display:flex;gap:4px;background:#13111c;border:1px solid #2a2738;border-radius:8px;padding:3px;margin-bottom:9px;}
#qa-ins .states .st{all:unset;flex:1;text-align:center;cursor:pointer;font-size:11px;font-weight:600;color:#8b8898;padding:6px 0;border-radius:6px;}
#qa-ins .states .st:hover{color:#cbd5e1;}
#qa-ins .states .st.on{background:#7c3aed;color:#fff;}
/* property search */
#qa-ins .qsearch{position:relative;margin-bottom:10px;}
#qa-ins #qa-ins-search{width:100%;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:7px 10px;font:12px monospace;}
#qa-ins #qa-ins-search:focus{border-color:#7c3aed;}
#qa-ins .qsug{position:absolute;left:0;right:0;top:100%;margin-top:3px;z-index:5;display:none;background:#1c1a26;border:1px solid #3a3654;border-radius:8px;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5);}
#qa-ins .qsug.show{display:block;}
#qa-ins .qsug-item{padding:6px 10px;cursor:pointer;font:12px monospace;color:#e5e7eb;display:flex;justify-content:space-between;gap:8px;}
#qa-ins .qsug-item .ty{color:#7e7b90;font-size:10px;}
#qa-ins .qsug-item.active,#qa-ins .qsug-item:hover{background:#7c3aed;color:#fff;}
#qa-ins .qsug-item.active .ty,#qa-ins .qsug-item:hover .ty{color:#e9d5ff;}
#qa-ins .qhint{color:#6b6878;font-style:italic;font-size:11px;margin-bottom:8px;}
#qa-ins .filter{width:100%;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:7px 10px;font:12px monospace;margin-bottom:8px;}
#qa-ins .filter:focus{border-color:#7c3aed;}
#qa-ins .rules{max-height:300px;overflow-y:auto;background:#13111c;border:1px solid #2a2738;border-radius:8px;padding:8px 10px;font:12px/1.85 monospace;}
#qa-ins .rule{margin-bottom:9px;}
#qa-ins .rsel{color:#fbbf24;font-weight:600;word-break:break-all;cursor:pointer;}
#qa-ins .rsel:hover{text-decoration:underline;}
#qa-ins .decl{padding-left:4px;word-break:break-all;}
#qa-ins .decl.off .k,#qa-ins .decl.off .v{text-decoration:line-through;opacity:.4;}
#qa-ins .dchk,#qa-ins .dchk-state{width:11px!important;height:11px!important;min-width:0!important;margin:0 5px 0 0!important;padding:0!important;accent-color:#7c3aed!important;cursor:pointer!important;vertical-align:middle!important;flex:0 0 auto!important;-webkit-appearance:auto!important;appearance:auto!important;}
#qa-ins .k{color:#a5b4fc;}
#qa-ins .v{color:#fff;cursor:text;}
#qa-ins .v:hover{text-decoration:underline;}
#qa-ins .qa-ins-sw{-webkit-appearance:none!important;appearance:none!important;width:12px!important;height:12px!important;min-width:0!important;border-radius:3px!important;border:1px solid rgba(255,255,255,.5)!important;margin:0 4px 0 0!important;padding:0!important;vertical-align:middle!important;cursor:pointer!important;background:none!important;display:inline-block!important;}
#qa-ins .qa-ins-sw::-webkit-color-swatch-wrapper{padding:0!important;}
#qa-ins .qa-ins-sw::-webkit-color-swatch{border:none!important;border-radius:2px!important;}
#qa-ins .vedit{background:#000;border:1px solid #7c3aed;color:#fff;font:inherit;border-radius:4px;padding:0 4px;}
#qa-ins .empty{color:#6b6878;font-style:italic;}
#qa-ins .code{background:#13111c;border:1px solid #2a2738;border-radius:8px;padding:8px 10px;font:12px/1.7 monospace;color:#c7d2fe;word-break:break-all;}
/* No inner max-height/scroll: a nested scrollbox was hiding half the attributes behind a
   scroll people didn't notice. Let the list flow at full height and let the panel body
   (.bd, already overflow-y:auto) be the single, obvious scroll for long lists. */
#qa-ins .attrs{background:#13111c;border:1px solid #2a2738;border-radius:8px;padding:6px 10px;font:12px/1.8 monospace;word-break:break-word;}
#qa-ins .attrs .k{color:#a5b4fc;}
#qa-ins .attrs .v{color:#fff;cursor:auto;}
/* box model */
#qa-ins .bm{padding:4px 0;}
#qa-ins .bm .box{border-radius:7px;padding:18px 8px 6px;position:relative;text-align:center;}
#qa-ins .bm .tagn{position:absolute;top:4px;left:8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;}
#qa-ins .bm-margin{background:rgba(245,158,11,.16);} #qa-ins .bm-margin>.tagn{color:#f59e0b;}
#qa-ins .bm-border{background:rgba(250,204,21,.14);} #qa-ins .bm-border>.tagn{color:#facc15;}
#qa-ins .bm-padding{background:rgba(16,185,129,.16);} #qa-ins .bm-padding>.tagn{color:#34d399;}
#qa-ins .bm-content{background:rgba(96,165,250,.18);color:#bfdbfe;padding:10px 4px;font-variant-numeric:tabular-nums;font-weight:600;font-size:11px;}
#qa-ins .bm .e{width:30px;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:4px;padding:2px 0;font:10px monospace;text-align:center;}
#qa-ins .bm .e[readonly]{background:transparent;border-color:transparent;color:#9b98ac;}
#qa-ins .bm .e:focus{border-color:#7c3aed;}
#qa-ins .bm .sides{display:flex;align-items:center;justify-content:space-between;gap:4px;}
#qa-ins .ft{display:flex;gap:8px;padding:11px 13px;border-top:1px solid #2a2738;background:#1c1a26;}
#qa-ins .ft button{flex:1 1 0!important;min-width:0!important;margin:0!important;border:none!important;box-shadow:none!important;text-transform:none!important;letter-spacing:normal!important;all:unset;box-sizing:border-box!important;cursor:pointer!important;height:36px!important;border-radius:8px!important;font:600 12px/1 -apple-system,Segoe UI,sans-serif!important;white-space:nowrap!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:6px!important;}
#qa-ins .ft button svg{width:14px!important;height:14px!important;flex:0 0 auto!important;}
#qa-ins .ft .b-reset{background:#262335!important;color:#d4d2e0!important;}
#qa-ins .ft .b-reset:hover{background:#322f44!important;}
#qa-ins .ft .b-copy{background:#7c3aed!important;color:#fff!important;}
#qa-ins .ft .b-copy:hover{background:#6d28d9!important;}`;
    document.head.appendChild(style);

    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const tagLabel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');

    const panel = document.createElement('div');
    panel.id = 'qa-ins';
    panel.innerHTML = `
<div class="hd">
  <span><span class="tag">${escapeHtml(tagLabel)}</span><span class="dim">${Math.round(r.width)} × ${Math.round(r.height)}</span></span>
  <span class="hbtns">
    <button class="iconbtn" id="qa-ins-pick" title="Pick another element">${INS_IC.pick}</button>
    <button class="iconbtn danger" id="qa-ins-close" title="Close">${INS_IC.x}</button>
  </span>
</div>
<div class="tabs">
  <button class="tab on" data-t="styles">Styles</button>
  <button class="tab" data-t="box">Box</button>
  <button class="tab" data-t="info">Info</button>
</div>
<div class="bd">
  <div class="pane on" data-p="styles">
    <div class="grp">
      <div class="lbl">Quick edit</div>
      <div class="states" id="qa-ins-states">
        <button class="st on" data-s="element">Element</button>
        <button class="st" data-s="hover">Hover</button>
        <button class="st" data-s="focus">Focus</button>
        <button class="st" data-s="active">Pressed</button>
      </div>
      <div class="qsearch">
        <input id="qa-ins-search" type="text" placeholder="Add a property… (e.g. font-size, display)" spellcheck="false">
        <div class="qsug" id="qa-ins-sug"></div>
      </div>
      <div id="qa-ins-qrows"></div>
    </div>
    <div class="grp">
      <div class="lbl">Matched rules</div>
      <input class="filter" id="qa-ins-filter" type="text" placeholder="Filter properties… (e.g. font, margin)">
      <div class="rules" id="qa-ins-rules"></div>
    </div>
  </div>
  <div class="pane" data-p="box">
    <div class="grp"><div class="lbl">Box model</div><div class="bm" id="qa-ins-bm"></div></div>
  </div>
  <div class="pane" data-p="info">
    <div class="grp"><div class="lbl">Selector <button class="mini" id="qa-ins-copy-sel">Copy</button></div><div class="code">${escapeHtml(sel || '(none)')}</div></div>
    <div class="grp"><div class="lbl">Attributes <button class="mini" id="qa-ins-copy-attr">Copy</button></div><div class="attrs" id="qa-ins-attrs"></div></div>
  </div>
</div>
<div class="ft">
  <button class="b-reset" id="qa-ins-reset" title="Revert all changes">${INS_IC.reset} Reset</button>
  <button class="b-copy" id="qa-ins-copy" title="Copy your edits as CSS">${INS_IC.copy} Copy CSS</button>
</div>`;
    document.body.appendChild(panel);

    // ---------- helpers ----------
    const $ = (s) => panel.querySelector(s);
    // Box-model edits also go through the class-wide base rule (so they apply to
    // every element sharing the selector, like the Quick edit does).
    const setInline = (prop, value) => {
        insStateStyles.element[prop] = value;
        rebuildStateStyle();
        renderRules();
    };
    const snapRule = (st) => { if (!insRuleSnaps.has(st)) insRuleSnaps.set(st, st.cssText); };
    // a short, readable selector for copied CSS / state blocks: #id, else tag.class.class
    const copySelector = () => {
        const tag = el.tagName.toLowerCase();
        if (el.id) return tag + '#' + CSS.escape(el.id);
        const cl = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).filter(c => c !== 'qa-ins-target');
        if (cl.length) return tag + '.' + cl.map(c => CSS.escape(c)).join('.');
        return sel || tag;
    };

    // ---------- tabs ----------
    panel.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
        panel.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.p === t.dataset.t));
        if (t.dataset.t === 'box') renderBox();
    }));

    // ---------- header ----------
    $('#qa-ins-close').addEventListener('click', closeInspectorPanel);
    qaAddMinimize(panel, panel.querySelector('.hd'), $('#qa-ins-close'));
    $('#qa-ins-pick').addEventListener('click', () => { closeInspectorPanel(); startInspectMode(); });

    // ---------- quick edit (state-aware, searchable) ----------
    // Edits apply to the element's SELECTOR (class-based), so every element that
    // shares the class gets the same style — e.g. a button repeated in many cards.
    const INS_STATES = ['element', 'hover', 'focus', 'active'];   // element = base rule (no pseudo)
    let insState = 'element';
    const insStateStyles = { element: {}, hover: {}, focus: {}, active: {} };   // enabled decls
    const insStateDisabled = { element: {}, hover: {}, focus: {}, active: {} }; // toggled-off decls
    // each state keeps its own list of property rows (independent of the others)
    const insQuickProps = {
        element: ['color', 'background-color', 'font-size', 'opacity', 'border-radius'],
        hover: [], focus: [], active: []
    };
    const qrows = $('#qa-ins-qrows');

    // Raise specificity by repeating the selector's classes (same match set,
    // higher specificity) so our rule beats the page's own rules; !important
    // then wins any equal-specificity declaration.
    const boostSelector = (s) => {
        const cls = s.match(/\.[\w-]+/g);
        return cls ? s + cls.join('') + cls.join('') : s;
    };
    const stateSuffix = (state) => (state === 'element' ? '' : ':' + state);

    // build/refresh the single injected stylesheet for all quick edits
    const rebuildStateStyle = () => {
        const has = INS_STATES.some(s => Object.keys(insStateStyles[s]).length);
        let styleEl = document.getElementById('qa-ins-state');
        if (!has) { if (styleEl) styleEl.remove(); return; }
        if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'qa-ins-state'; document.head.appendChild(styleEl); }
        const base = boostSelector(copySelector());
        const block = (state) => {
            const m = insStateStyles[state]; const keys = Object.keys(m);
            if (!keys.length) return '';
            return `${base}${stateSuffix(state)}{${keys.map(k => `${k}:${m[k]}!important`).join(';')}}`;
        };
        styleEl.textContent = INS_STATES.map(block).join('');
    };

    // current value of a property for the active state (for prefilling the input)
    const valueOf = (prop, type) => {
        const raw = insStateStyles[insState][prop];
        if (raw != null) {
            if (type === 'color') return insToHex(raw);
            if (type === 'px' || type === 'num') { const n = parseFloat(raw); return isNaN(n) ? '' : n; }
            return raw;
        }
        // not edited yet: prefill the base state from the element's computed value
        if (insState === 'element') {
            const cv = getComputedStyle(el).getPropertyValue(prop);
            if (type === 'color') return insToHex(cv);
            if (type === 'px' || type === 'num') { const n = parseFloat(cv); return isNaN(n) ? '' : Math.round(n * 100) / 100; }
            return cv.trim();
        }
        return type === 'color' ? '#000000' : '';
    };

    // apply a value for prop in the active state ('' clears it)
    const applyProp = (prop, type, rawVal) => {
        let css = '';
        if (rawVal !== '' && rawVal != null) {
            if (type === 'px') css = (parseFloat(rawVal) || 0) + 'px';
            else if (type === 'num') css = String(parseFloat(rawVal));
            else css = String(rawVal);
        }
        if (css === '') delete insStateStyles[insState][prop];
        else insStateStyles[insState][prop] = css;
        rebuildStateStyle();
        renderRules();   // show the rule in the list
    };

    const renderQRows = () => {
        qrows.innerHTML = '';
        if (insState !== 'element') {
            const hint = document.createElement('div');
            hint.className = 'qhint';
            hint.textContent = `Editing :${insState} — ${insState} the element on the page to preview.`;
            qrows.appendChild(hint);
        }
        insQuickProps[insState].forEach(prop => {
            const type = INS_QUICK_TYPE[prop] || 'text';
            const row = document.createElement('div');
            row.className = 'qrow';
            const v = valueOf(prop, type);
            let control;
            if (type === 'color') {
                control = `<input type="text" class="hex" value="${v}"><input type="color" value="${/^#/.test(v) ? v : '#000000'}">`;
            } else if (type === 'px') {
                control = `<input type="number" step="any" class="num" value="${v}"><span class="unit">px</span>`;
            } else if (type === 'num') {
                control = `<input type="number" step="any" class="num" value="${v}">`;
            } else {
                control = `<input type="text" class="txt" list="qa-ins-vals-${CSS.escape(prop)}" value="${escapeHtml(String(v))}"><datalist id="qa-ins-vals-${CSS.escape(prop)}"></datalist>`;
            }
            row.innerHTML = `<span class="nm" title="${prop}">${prop}</span>${control}<button class="rm" title="Remove">${INS_IC.x}</button>`;
            qrows.appendChild(row);

            // wire controls
            if (type === 'color') {
                const hex = row.querySelector('.hex'), pick = row.querySelector('input[type=color]');
                pick.addEventListener('input', () => { hex.value = pick.value; applyProp(prop, type, pick.value); });
                hex.addEventListener('change', () => { if (CSS.supports('color', hex.value)) { pick.value = insToHex(hex.value); applyProp(prop, type, hex.value); } });
            } else if (type === 'text') {
                const txt = row.querySelector('.txt');
                let vals = []; try { vals = INSPECTOR_VALUE_KEYWORDS.filter(k => CSS.supports(prop, k)); } catch (e) { }
                row.querySelector('datalist').innerHTML = vals.map(x => `<option value="${x}">`).join('');
                txt.addEventListener('change', () => applyProp(prop, type, txt.value));
            } else {
                const num = row.querySelector('.num');
                num.addEventListener('input', () => applyProp(prop, type, num.value));
            }
            row.querySelector('.rm').addEventListener('click', () => {
                applyProp(prop, type, '');                 // clear its effect (this state only)
                insQuickProps[insState] = insQuickProps[insState].filter(p => p !== prop);
                renderQRows();
            });
        });
    };

    // state toggle
    $('#qa-ins-states').querySelectorAll('.st').forEach(b => b.addEventListener('click', () => {
        $('#qa-ins-states').querySelectorAll('.st').forEach(x => x.classList.toggle('on', x === b));
        insState = b.dataset.s;
        renderQRows();
    }));

    // property search + add
    const searchEl = $('#qa-ins-search'), sugEl = $('#qa-ins-sug');
    let sugItems = [], sugIdx = 0;
    const hideSug = () => { sugEl.classList.remove('show'); sugItems = []; };
    const addProp = (prop) => {
        if (!insQuickProps[insState].includes(prop)) insQuickProps[insState].push(prop);
        searchEl.value = ''; hideSug(); renderQRows();
        const last = qrows.lastElementChild; if (last) { const inp = last.querySelector('input'); if (inp) inp.focus(); }
    };
    const updateSug = () => {
        const q = searchEl.value.trim().toLowerCase();
        if (!q) { hideSug(); return; }
        sugItems = INS_QUICK_CATALOG.filter(([n]) => n.includes(q) && !insQuickProps[insState].includes(n)).slice(0, 10);
        if (!sugItems.length) { hideSug(); return; }
        sugIdx = 0;
        sugEl.innerHTML = sugItems.map(([n, t], i) => `<div class="qsug-item${i === 0 ? ' active' : ''}" data-p="${n}">${n}<span class="ty">${t}</span></div>`).join('');
        sugEl.classList.add('show');
        sugEl.querySelectorAll('.qsug-item').forEach(it => it.addEventListener('mousedown', (e) => { e.preventDefault(); addProp(it.dataset.p); }));
    };
    searchEl.addEventListener('input', updateSug);
    searchEl.addEventListener('blur', () => setTimeout(hideSug, 150));
    searchEl.addEventListener('keydown', (e) => {
        if (!sugItems.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); sugIdx = (sugIdx + 1) % sugItems.length; }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; }
        else if (e.key === 'Enter') { e.preventDefault(); addProp(sugItems[sugIdx][0]); return; }
        else if (e.key === 'Escape') { hideSug(); return; }
        else return;
        sugEl.querySelectorAll('.qsug-item').forEach((n, i) => n.classList.toggle('active', i === sugIdx));
    });

    renderQRows();

    // ---------- matched rules (live) ----------
    const rulesEl = $('#qa-ins-rules');
    const filterEl = $('#qa-ins-filter');

    const declsOf = (st) => {
        const out = [];
        for (const part of st.cssText.split(';')) {
            const i = part.indexOf(':');
            if (i > 0) out.push({ prop: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), off: false });
        }
        // re-insert disabled declarations at the position they were toggled off,
        // so a greyed-out row stays put instead of jumping to the bottom
        const dis = insDisabled.get(st);
        if (dis) {
            Object.keys(dis)
                .map(p => ({ prop: p, value: dis[p].value + (dis[p].priority ? ' !important' : ''), off: true, idx: dis[p].idx }))
                .sort((a, b) => (a.idx ?? 1e9) - (b.idx ?? 1e9))
                .forEach(d => out.splice(Math.min(d.idx ?? out.length, out.length), 0, d));
        }
        return out;
    };

    const renderRules = () => {
        const prevScroll = rulesEl.scrollTop;   // keep the list put across re-renders
        const f = (filterEl.value || '').trim().toLowerCase();
        const blocks = insMatchedBlocks(el);
        let html = '';
        for (let bi = 0; bi < blocks.length; bi++) {
            let decls = declsOf(blocks[bi].style);
            if (f) decls = decls.filter(d => (d.prop + ': ' + d.value).toLowerCase().includes(f));
            if (!decls.length) continue;
            const rows = decls.map(d =>
                `<div class="decl${d.off ? ' off' : ''}" data-b="${bi}" data-prop="${escapeHtml(d.prop)}">` +
                `<input type="checkbox" class="dchk"${d.off ? '' : ' checked'}>` +
                `<span class="k">${escapeHtml(d.prop)}</span>: <span class="v">${insColorize(escapeHtml(d.value), el)}</span>;</div>`
            ).join('');
            html += `<div class="rule" data-b="${bi}"><span class="rsel">${escapeHtml(blocks[bi].selector)} {</span>${rows}<div class="rsel">}</div></div>`;
        }
        if (!html) {
            // fallback: flat computed values
            const props = f ? INSPECTOR_COMMON_PROPS.concat([]) : INSPECTOR_COMMON_PROPS;
            const c2 = getComputedStyle(el);
            html = props.filter(p => !f || p.includes(f)).map(p =>
                `<div class="decl"><span class="k">${escapeHtml(p)}</span>: <span class="v">${insColorize(escapeHtml(c2.getPropertyValue(p)), el)}</span>;</div>`).join('');
        }
        // synthetic blocks for the :hover / :focus / :active edits — toggleable, like real rules
        const stateHtml = INS_STATES.map(stt => {
            const m = insStateStyles[stt], md = insStateDisabled[stt];
            let all = Object.keys(m).map(k => ({ prop: k, value: m[k], off: false }))
                .concat(Object.keys(md).map(k => ({ prop: k, value: md[k], off: true })));
            if (f) all = all.filter(d => (d.prop + ': ' + d.value).toLowerCase().includes(f));
            if (!all.length) return '';
            const rows = all.map(d =>
                `<div class="decl${d.off ? ' off' : ''}" data-state="${stt}" data-prop="${escapeHtml(d.prop)}">` +
                `<input type="checkbox" class="dchk-state"${d.off ? '' : ' checked'}>` +
                `<span class="k">${escapeHtml(d.prop)}</span>: <span class="v">${insColorize(escapeHtml(d.value), el)} !important</span>;</div>`).join('');
            return `<div class="rule"><span class="rsel">${escapeHtml(copySelector() + stateSuffix(stt))} {</span>${rows}<div class="rsel">}</div></div>`;
        }).join('');
        rulesEl.innerHTML = (stateHtml + html) || '<div class="empty">No matching properties</div>';
        rulesEl.scrollTop = prevScroll;
        rulesEl._blocks = blocks;
    };

    // toggle a declaration on/off
    rulesEl.addEventListener('change', (e) => {
        if (e.target.classList.contains('dchk-state')) {
            const row = e.target.closest('.decl');
            const stt = row.dataset.state, prop = row.dataset.prop;
            if (e.target.checked) {
                if (insStateDisabled[stt][prop] != null) { insStateStyles[stt][prop] = insStateDisabled[stt][prop]; delete insStateDisabled[stt][prop]; }
            } else {
                if (insStateStyles[stt][prop] != null) { insStateDisabled[stt][prop] = insStateStyles[stt][prop]; delete insStateStyles[stt][prop]; }
            }
            rebuildStateStyle();
            renderRules();
            return;
        }
        if (e.target.classList.contains('dchk')) {
            const row = e.target.closest('.decl');
            const blocks = rulesEl._blocks; const b = blocks[+row.dataset.b]; if (!b) return;
            const prop = row.dataset.prop; snapRule(b.style);
            const dis = insDisabled.get(b.style) || {};
            if (e.target.checked) {
                // re-enable at the original position (setProperty alone appends to the end)
                if (dis[prop]) {
                    const parts = b.style.cssText.split(';').map(s => s.trim()).filter(Boolean);
                    parts.splice(Math.min(dis[prop].idx ?? parts.length, parts.length), 0,
                        `${prop}: ${dis[prop].value}${dis[prop].priority ? ' !important' : ''}`);
                    try { b.style.cssText = parts.join('; ') + ';'; } catch (err) { b.style.setProperty(prop, dis[prop].value, dis[prop].priority); }
                    delete dis[prop];
                }
                row.classList.remove('off');
            } else {
                const idx = declsOf(b.style).findIndex(d => d.prop === prop);
                dis[prop] = { value: b.style.getPropertyValue(prop), priority: b.style.getPropertyPriority(prop), idx: idx < 0 ? undefined : idx };
                b.style.removeProperty(prop);
                row.classList.add('off');
            }
            insDisabled.set(b.style, dis);
            // toggle the row in place — no full re-render (which would scroll/jump the list)
            return;
        }
        if (e.target.classList.contains('qa-ins-sw')) renderRules();
    });

    // live colour swatch inside a value
    rulesEl.addEventListener('input', (e) => {
        const sw = e.target; if (!sw.classList.contains('qa-ins-sw')) return;
        const row = sw.closest('.decl'); const b = rulesEl._blocks[+row.dataset.b]; if (!b) return;
        const prop = row.dataset.prop; snapRule(b.style);
        const cur = b.style.getPropertyValue(prop) || sw.dataset.token;
        const next = cur.replace(sw.dataset.token, sw.value); sw.dataset.token = sw.value;
        const imp = /!important/i.test(next);
        try { b.style.setProperty(prop, next.replace(/\s*!important\s*/i, ' ').trim(), imp ? 'important' : ''); } catch (err) { }
    });

    // click a value to edit it inline
    rulesEl.addEventListener('click', (e) => {
        const v = e.target.closest('.v'); if (!v || e.target.classList.contains('qa-ins-sw')) return;
        const row = v.closest('.decl'); const b = rulesEl._blocks[+row.dataset.b]; if (!b) return;
        const prop = row.dataset.prop;
        const inp = document.createElement('input');
        inp.className = 'vedit'; inp.value = b.style.getPropertyValue(prop) || v.textContent.trim();
        v.replaceWith(inp); inp.focus(); inp.select();
        const commit = () => {
            snapRule(b.style);
            const val = inp.value.trim();
            const imp = /!important/i.test(val);
            try { b.style.setProperty(prop, val.replace(/\s*!important\s*/i, ' ').trim(), imp ? 'important' : ''); } catch (err) { }
            renderRules();
        };
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } else if (ev.key === 'Escape') { renderRules(); } });
        inp.addEventListener('blur', commit);
    });

    filterEl.addEventListener('input', renderRules);
    renderRules();

    // ---------- box model ----------
    function renderBox() {
        const c = getComputedStyle(el), rr = el.getBoundingClientRect();
        const g = (p) => Math.round(parseFloat(c[p]) || 0);
        const cw = Math.round(rr.width - g('paddingLeft') - g('paddingRight') - g('borderLeftWidth') - g('borderRightWidth'));
        const ch = Math.round(rr.height - g('paddingTop') - g('paddingBottom') - g('borderTopWidth') - g('borderBottomWidth'));
        const ed = (type, side) => {
            const valProp = type === 'border' ? `border${side}Width` : type + side;
            return `<input class="e" data-type="${type}" data-side="${side}" value="${g(valProp)}">`;
        };
        $('#qa-ins-bm').innerHTML = `
<div class="box bm-margin"><span class="tagn">margin</span>
  <div class="sides">${ed('margin', 'Left')}
    <div style="flex:1">
      <div style="margin-bottom:6px">${ed('margin', 'Top')}</div>
      <div class="box bm-border"><span class="tagn">border</span>
        <div class="sides">${ed('border', 'Left')}
          <div style="flex:1">
            <div style="margin-bottom:6px">${ed('border', 'Top')}</div>
            <div class="box bm-padding"><span class="tagn">padding</span>
              <div class="sides">${ed('padding', 'Left')}
                <div style="flex:1">
                  <div style="margin-bottom:6px">${ed('padding', 'Top')}</div>
                  <div class="box bm-content">${cw} × ${ch}</div>
                  <div style="margin-top:6px">${ed('padding', 'Bottom')}</div>
                </div>${ed('padding', 'Right')}
              </div>
            </div>
            <div style="margin-top:6px">${ed('border', 'Bottom')}</div>
          </div>${ed('border', 'Right')}
        </div>
      </div>
      <div style="margin-top:6px">${ed('margin', 'Bottom')}</div>
    </div>${ed('margin', 'Right')}
  </div>
</div>`;
        $('#qa-ins-bm').querySelectorAll('.e').forEach(inp => inp.addEventListener('change', () => {
            const type = inp.dataset.type, side = inp.dataset.side, sk = side.toLowerCase();
            const v = (parseFloat(inp.value) || 0) + 'px';
            if (type === 'border') {
                setInline(`border-${sk}-width`, v);
                // a width alone is invisible when border-style is none — make it solid
                if (getComputedStyle(el)['border' + side + 'Style'] === 'none') setInline(`border-${sk}-style`, 'solid');
            } else {
                setInline(`${type}-${sk}`, v); // margin-top / padding-left …
            }
            renderBox();
            // refresh header dims
            const nr = el.getBoundingClientRect();
            panel.querySelector('.hd .dim').textContent = `${Math.round(nr.width)} × ${Math.round(nr.height)}`;
        }));
    }

    // ---------- info ----------
    const attrs = Array.from(el.attributes || []);
    $('#qa-ins-attrs').innerHTML = attrs.length
        ? attrs.map(a => `<div><span class="k">${escapeHtml(a.name)}</span>="<span class="v">${escapeHtml(a.value)}</span>"</div>`).join('')
        : '<div class="empty">No attributes</div>';
    $('#qa-ins-copy-sel').addEventListener('click', () => { navigator.clipboard.writeText(sel || '').then(() => liToast('Selector copied')); });
    $('#qa-ins-copy-attr').addEventListener('click', () => {
        navigator.clipboard.writeText(attrs.map(a => `${a.name}="${a.value}"`).join(' ')).then(() => liToast('Attributes copied'));
    });

    // ---------- footer ----------
    $('#qa-ins-reset').addEventListener('click', () => {
        if (inspectedOriginalStyle != null) el.setAttribute('style', inspectedOriginalStyle); else el.removeAttribute('style');
        for (const [st, css] of insRuleSnaps) st.cssText = css;
        insRuleSnaps.clear(); insDisabled.clear();
        // clear all quick edits (element/hover/focus/active, enabled + disabled)
        INS_STATES.forEach(s => { insStateStyles[s] = {}; insStateDisabled[s] = {}; });
        rebuildStateStyle();
        renderQRows();
        renderRules();
        if (panel.querySelector('.tab[data-t="box"]').classList.contains('on')) renderBox();
        liToast('Reset');
    });
    $('#qa-ins-copy').addEventListener('click', () => {
        const sl = copySelector();
        const blocks = [];
        const block = (suffix, map, imp) => {
            const keys = Object.keys(map);
            if (keys.length) blocks.push(`${sl}${suffix} {\n${keys.map(k => `  ${k}: ${map[k]}${imp ? ' !important' : ''};`).join('\n')}\n}`);
        };
        block('', insStateStyles.element, true);
        block(':hover', insStateStyles.hover, true);
        block(':focus', insStateStyles.focus, true);
        block(':active', insStateStyles.active, true);
        if (!blocks.length) { liToast('No changes to copy'); return; }
        navigator.clipboard.writeText(blocks.join('\n\n')).then(() => liToast('CSS copied')).catch(() => liToast('Copy failed'));
    });

    // ---------- drag by header ----------
    let off = null;
    const head = panel.querySelector('.hd');
    const down = (e) => { if (e.target.closest('button')) return; const rc = panel.getBoundingClientRect(); off = { dx: e.clientX - rc.left, dy: e.clientY - rc.top }; e.preventDefault(); };
    const move = (e) => { if (!off) return; panel.style.right = 'auto'; panel.style.left = Math.max(4, Math.min(innerWidth - 80, e.clientX - off.dx)) + 'px'; panel.style.top = Math.max(4, Math.min(innerHeight - 50, e.clientY - off.dy)) + 'px'; };
    const up = () => { off = null; };
    head.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    inspectorDragCleanup = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
}


function generateSelector(element) {
    // 1. XPath (Relative) - Now prioritized as requested
    try {
        const xpath = generateXPath(element);
        if (xpath) return xpath;
    } catch (e) { }

    // 2. ID (Fallback)
    if (element.id) {
        return `#${element.id}`;
    }

    // 3. data-testid
    if (element.getAttribute('data-testid')) {
        return `[data-testid='${element.getAttribute('data-testid')}']`;
    }

    // 4. name
    if (element.name) {
        return `[name='${element.name}']`;
    }

    // 5. placeholder
    if (element.placeholder) {
        return `[placeholder='${element.placeholder}']`;
    }

    // 6. formcontrolname (Angular)
    if (element.getAttribute('formcontrolname')) {
        return `[formcontrolname="${element.getAttribute('formcontrolname')}"]`;
    }

    // 7. ng-model
    if (element.getAttribute('ng-model')) {
        return `[ng-model="${element.getAttribute('ng-model')}"]`;
    }

    // 8. aria-label
    if (element.getAttribute('aria-label')) {
        return `[aria-label="${element.getAttribute('aria-label')}"]`;
    }

    // 9. Class combination
    if (element.className && typeof element.className === 'string') {
        const classes = element.className.split(' ')
            .filter(c => c.trim() && !c.includes('ng-') && !c.includes('touched') && !c.includes('pristine') && !c.includes('valid') && !c.includes('invalid'))
            .slice(0, 2).join('.');
        if (classes) {
            return `${element.tagName.toLowerCase()}.${classes}`;
        }
    }

    // 10. Fallback: nth-of-type
    const tagName = element.tagName.toLowerCase();
    const type = element.type ? `[type="${element.type}"]` : '';
    const allSimilar = document.querySelectorAll(`${tagName}${type}`);
    const index = Array.from(allSimilar).indexOf(element);
    return `${tagName}${type}:nth-of-type(${index + 1})`;
}

function generateXPath(element) {
    // Helper to check if ID looks dynamic (e.g., OutSystems patterns: b1-b2-Input, etc.)
    const isDynamicId = (id) => {
        if (!id) return false;
        // Patterns: b[digit]-, contains multiple dashes, or ends with long random string
        return /^b\d+-/.test(id) || (id.split('-').length > 2) || (id.split('_').length > 3);
    };

    const getBaseXPath = (el) => {
        if (el.id && !isDynamicId(el.id)) return `//*[@id='${el.id}']`;
        if (el === document.body) return '/html/body';

        // Try data-testid as high priority XPath
        const testId = el.getAttribute('data-testid');
        if (testId) return `//${el.tagName.toLowerCase()}[@data-testid='${testId}']`;

        // Try name, placeholder, or aria-label for relative XPath.
        // formcontrolname is Angular's own field name: on reactive forms it is often
        // the ONLY stable handle (those inputs carry no id and no name at all), so it
        // beats falling back to a brittle positional path.
        const attributes = ['name', 'formcontrolname', 'placeholder', 'aria-label'];
        for (const attr of attributes) {
            const val = el.getAttribute(attr);
            if (val) return `//${el.tagName.toLowerCase()}[@${attr}='${val}']`;
        }

        // Try finding by label text if it's an input
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label && label.innerText.trim()) {
                // Escape quotes in text
                const text = label.innerText.trim().replace(/"/g, '\\"');
                return `//${el.tagName.toLowerCase()}[@id=//label[contains(text(), "${text}")]/@for]`;
            }
        }

        // Default to hierarchical path (stable but long)
        let ix = 0;
        const siblings = el.parentNode ? el.parentNode.childNodes : [];
        for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === el) {
                const parentPath = el.parentNode && el.parentNode !== document ? getBaseXPath(el.parentNode) : '';
                return (parentPath || '/html/body') + '/' + el.tagName.toLowerCase() + '[' + (ix + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.tagName === el.tagName) ix++;
        }
        return '';
    };

    const xpath = getBaseXPath(element);
    if (!xpath) return '';

    // Verify uniqueness and add index if necessary
    try {
        const results = [];
        const query = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (query.snapshotLength <= 1) return xpath;

        // If not unique, wrap in parentheses and add index
        // To find the correct index, we see which one is OUR element
        for (let i = 0; i < query.snapshotLength; i++) {
            if (query.snapshotItem(i) === element) {
                return `(${xpath})[${i + 1}]`;
            }
        }
    } catch (e) {
        console.error('XPath uniqueness check failed:', e);
    }

    return xpath;
}

function showRecordingIndicator() {
    if (document.getElementById('ff-recording-indicator')) return;

    const indicator = document.createElement('div');
    indicator.id = 'ff-recording-indicator';
    indicator.innerHTML = `
        <div id="ff-bar" style="position:fixed;top:15px;right:15px;background:linear-gradient(135deg,#e74c3c,#c0392b);color:white;padding:12px 20px;border-radius:30px;z-index:2147483647;display:flex;align-items:center;gap:14px;font-family:'Segoe UI',Arial,sans-serif;box-shadow:0 8px 30px rgba(231,76,60,0.5);font-size:13px;">
            <div style="width:10px;height:10px;background:white;border-radius:50%;animation:ff-pulse 1s infinite;"></div>
            <span style="font-weight:600;">Recording</span>
            <span id="ff-count" style="background:rgba(0,0,0,0.3);padding:3px 10px;border-radius:15px;font-size:12px;">0 fields</span>
            <button id="ff-stop-btn" style="background:white;color:#e74c3c;border:none;padding:6px 14px;border-radius:15px;cursor:pointer;font-weight:600;font-size:12px;margin-left:5px;">Stop</button>
        </div>
        <style>
            @keyframes ff-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.5; transform: scale(1.3); }
            }
            #ff-stop-btn:hover { background: #f0f0f0; }
        </style>
    `;
    document.body.appendChild(indicator);

    // ===== STOP BUTTON - SIMPLE: Just send to background =====
    document.getElementById('ff-stop-btn').addEventListener('click', async () => {
        const fields = stopRecording();
        const recordedUrl = window.location.href;
        const appendToId = currentAppendToProfileId;

        console.log('=== STOP BUTTON ===');
        console.log('Fields:', fields.length, 'AppendTo:', appendToId);

        // Always notify background - even with 0 fields it must clear its
        // recording state, otherwise the indicator resurrects on the next page load
        chrome.runtime.sendMessage({
            action: 'handleStopRecording',
            fields: fields,
            url: recordedUrl,
            appendToProfileId: appendToId
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Background error:', chrome.runtime.lastError.message);
            } else {
                console.log('Background response:', response);
            }
            hideRecordingIndicator();
        });

        // Reset local state
        currentAppendToProfileId = null;
    });
}

function updateRecordingCount() {
    const countEl = document.getElementById('ff-count');
    if (countEl) {
        countEl.textContent = `${recordedFields.length} field${recordedFields.length !== 1 ? 's' : ''}`;
    }
}

function hideRecordingIndicator() {
    const indicator = document.getElementById('ff-recording-indicator');
    if (indicator) indicator.remove();
}

function flashElement(element, color = '#10b981') {
    const original = {
        outline: element.style.outline,
        outlineOffset: element.style.outlineOffset,
        transition: element.style.transition
    };

    element.style.transition = 'all 0.2s';
    element.style.outline = `3px solid ${color}`;
    element.style.outlineOffset = '2px';

    setTimeout(() => {
        element.style.outline = original.outline;
        element.style.outlineOffset = original.outlineOffset;
        element.style.transition = original.transition;
    }, 600);
}

// ==================== Inline AI field icon ====================
// A small AI icon appears on the focused editable field; clicking it offers
// "valid data" / "invalid data" AI fills. Toggle via the fieldAiIcon setting.

let fieldAiIconEnabled = true;
let aiIconTarget = null;          // the field the icon currently belongs to
let aiIconHideTimer = null;
let aiMenuOpen = false;           // keep icon alive while its menu is open

function refreshFieldAiIconSetting() {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (resp) => {
        if (chrome.runtime.lastError) return;
        const s = (resp && resp.settings) || {};
        fieldAiIconEnabled = s.fieldAiIcon !== false;
        if (!fieldAiIconEnabled) hideFieldAiIcon();
        charCounterEnabled = s.charCounter !== false;
        if (!charCounterEnabled) hideCharCounter();
    });
}
refreshFieldAiIconSetting();

// ==================== Character Counter ====================
// When the user selects text on the page, a small box shows the character count
// (with and without spaces) and the word count. Toggle via the charCounter setting.

let charCounterEnabled = true;

function hideCharCounter() {
    const box = document.getElementById('ff-char-counter');
    if (box) box.remove();
}

function updateCharCounter() {
    if (!charCounterEnabled) return;
    const sel = window.getSelection();
    const raw = sel ? sel.toString() : '';
    if (!raw.trim()) { hideCharCounter(); return; }

    // Don't show it over our own UI
    if (sel.anchorNode && sel.anchorNode.parentElement &&
        sel.anchorNode.parentElement.closest('#ff-char-counter, #ff-ai-field-icon, #ff-ai-field-menu')) return;

    // Ignore leading/trailing whitespace so a double-click and a drag over the
    // same word give the same count (drag/double-click often grab an extra space)
    const text = raw.trim();
    const withSpaces = text.length;
    const withoutSpaces = text.replace(/\s/g, '').length;
    const words = text.split(/\s+/).filter(Boolean).length;

    let box = document.getElementById('ff-char-counter');
    if (!box) {
        box = document.createElement('div');
        box.id = 'ff-char-counter';
        // Fixed in the bottom-right corner, semi-transparent - never covers the
        // selected text and doesn't jump around with each selection
        box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:175px;' +
            'background:rgba(15,15,35,0.72);backdrop-filter:blur(6px);' +
            'color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:9px;padding:8px 12px;' +
            'font-family:\'Segoe UI\',Arial,sans-serif;font-size:12px;line-height:1.7;box-shadow:0 6px 22px rgba(0,0,0,0.4);' +
            'pointer-events:none;white-space:nowrap;';
        document.body.appendChild(box);
    }
    box.innerHTML =
        `<div><b style="color:#a78bfa;">${withSpaces}</b> characters</div>` +
        `<div><b style="color:#38bdf8;">${withoutSpaces}</b> without spaces</div>` +
        `<div><b style="color:#4ade80;">${words}</b> word${words === 1 ? '' : 's'}</div>`;
}

document.addEventListener('mouseup', () => setTimeout(() => { updateCharCounter(); }, 0), true);
document.addEventListener('keyup', (e) => {
    // Selection via keyboard (Shift+arrows, Ctrl+A)
    if (e.shiftKey || e.key === 'a' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        setTimeout(() => { updateCharCounter(); }, 0);
    }
}, true);
document.addEventListener('selectionchange', () => {
    // Hide promptly when the selection is cleared
    const t = window.getSelection() ? window.getSelection().toString() : '';
    if (!t.trim()) { hideCharCounter(); }
});

// ==================== Scroll to a range and ring it ====================
// Used by Text Match (clicking a difference row). Left over from the removed selection
// Review tool, which it was written for.
function reviewAfterScroll(done) {
    let last = -1;
    let still = 0;
    const tick = () => {
        const y = Math.round(window.scrollY);
        if (y === last) still++; else { still = 0; last = y; }
        if (still >= 3) done();            // three frames unmoved: it has settled
        else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

// Scroll to it and ring it, briefly. Drawn as an overlay rather than by touching
// the page's own markup - the page under test must come out of this unchanged.
function reviewFlashRange(range) {
    try { (range.startContainer.parentElement || document.body).scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { }

    reviewAfterScroll(() => {
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        if (!rects.length) return;

        if (!document.getElementById('qa-rv-flash-style')) {
            const st = document.createElement('style');
            st.id = 'qa-rv-flash-style';
            st.textContent = '@keyframes qaRvPulse{0%{opacity:0;transform:scale(1.12)}12%{opacity:1;transform:scale(1)}75%{opacity:1}100%{opacity:0}}';
            (document.head || document.documentElement).appendChild(st);
        }

        // Page coordinates, not viewport ones: pinned to the words themselves, so a
        // scroll while it is still showing carries it along instead of leaving it
        // hanging over whatever has scrolled into its place.
        const sx = window.scrollX, sy = window.scrollY;
        for (const rc of rects) {
            const mark = document.createElement('div');
            mark.className = 'qa-rv-flash';
            mark.style.cssText = `position:absolute; left:${rc.left + sx - 3}px; top:${rc.top + sy - 3}px;
                width:${rc.width + 6}px; height:${rc.height + 6}px;
                border:2px solid #f43f5e; border-radius:4px; background:rgba(244,63,94,.16);
                z-index:2147483646; pointer-events:none; box-shadow:0 0 0 4px rgba(244,63,94,.18);
                animation:qaRvPulse 1.6s ease-out forwards;`;
            document.body.appendChild(mark);
            setTimeout(() => mark.remove(), 2600);
        }
    });
}

function isFillableField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'hidden', 'range', 'color'].includes(t);
    }
    return false;
}

document.addEventListener('focusin', (e) => {
    if (!fieldAiIconEnabled) return;
    if (e.target.closest && e.target.closest('#ff-ai-field-icon, #ff-ai-field-menu')) return;
    if (!isFillableField(e.target)) return;
    aiIconTarget = e.target;
    showFieldAiIcon(e.target);
}, true);

document.addEventListener('focusout', () => {
    if (aiMenuOpen) return; // keep the icon while its menu is open
    // Delay so a mousedown on the icon/menu isn't lost to the blur
    clearTimeout(aiIconHideTimer);
    aiIconHideTimer = setTimeout(() => { if (!aiMenuOpen) hideFieldAiIcon(); }, 200);
}, true);

function positionFieldAiIcon() {
    const icon = document.getElementById('ff-ai-field-icon');
    if (!icon || !aiIconTarget || !document.contains(aiIconTarget)) { hideFieldAiIcon(); return; }
    const r = aiIconTarget.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { hideFieldAiIcon(); return; }
    // Sit OUTSIDE the field (just past its right edge) so it never covers the
    // text - and flip to the left edge if there's no room on the right
    const top = r.top + Math.max(0, (r.height - 22) / 2);
    let left = r.right + 6;
    if (left + 22 > window.innerWidth - 4) left = r.left - 28;
    icon.style.top = top + 'px';
    icon.style.left = left + 'px';
}

function showFieldAiIcon(el) {
    clearTimeout(aiIconHideTimer);
    let icon = document.getElementById('ff-ai-field-icon');
    if (!icon) {
        icon = document.createElement('div');
        icon.id = 'ff-ai-field-icon';
        icon.title = 'AI fill this field';
        icon.style.cssText = 'position:fixed;z-index:2147483646;width:22px;height:22px;border-radius:6px;' +
            'background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;display:flex;align-items:center;justify-content:center;' +
            'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-size:11px;transition:transform 0.15s;';
        icon.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>';
        // mousedown.preventDefault keeps the field focused (no blur) when clicking
        icon.addEventListener('mousedown', (e) => e.preventDefault());
        icon.addEventListener('mouseenter', () => { icon.style.transform = 'scale(1.12)'; });
        icon.addEventListener('mouseleave', () => { icon.style.transform = 'scale(1)'; });
        icon.addEventListener('click', (e) => { e.stopPropagation(); toggleFieldAiMenu(); });
        document.body.appendChild(icon);
        window.addEventListener('scroll', positionFieldAiIcon, true);
        window.addEventListener('resize', positionFieldAiIcon, true);
    }
    icon.style.display = 'flex';
    positionFieldAiIcon();
}

function hideFieldAiIcon() {
    aiMenuOpen = false;
    const icon = document.getElementById('ff-ai-field-icon');
    if (icon) icon.style.display = 'none';
    const menu = document.getElementById('ff-ai-field-menu');
    if (menu) menu.remove();
}

function toggleFieldAiMenu() {
    const existing = document.getElementById('ff-ai-field-menu');
    if (existing) { existing.remove(); aiMenuOpen = false; return; }
    const icon = document.getElementById('ff-ai-field-icon');
    if (!icon) return;

    // Keep the field focused (no blur). We open the menu ABOVE the icon so the
    // browser's native autocomplete - which renders below the field and always
    // draws on top - can't cover it.
    aiMenuOpen = true;

    const menu = document.createElement('div');
    menu.id = 'ff-ai-field-menu';
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(15,15,35,0.97);backdrop-filter:blur(8px);' +
        'border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:5px;box-shadow:0 8px 28px rgba(0,0,0,0.5);' +
        'font-family:\'Segoe UI\',Arial,sans-serif;min-width:160px;direction:ltr;text-align:left;';
    menu.innerHTML = `
        <div class="ff-ai-opt" data-mode="valid" style="display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:7px;cursor:pointer;color:#e0e0e0;font-size:13px;">
            <i class="fas fa-circle-check" style="color:#4ade80;"></i> Fill with valid data
        </div>
        <div class="ff-ai-opt" data-mode="invalid" style="display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:7px;cursor:pointer;color:#e0e0e0;font-size:13px;">
            <i class="fas fa-circle-xmark" style="color:#f87171;"></i> Fill with invalid data
        </div>`;
    menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep field focused
    menu.querySelectorAll('.ff-ai-opt').forEach(opt => {
        opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(99,102,241,0.25)'; });
        opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const mode = opt.dataset.mode;
            const target = aiIconTarget;
            menu.remove();              // close the menu only
            aiMenuOpen = false;
            if (target) runFieldAiFill(target, mode);
        });
    });
    document.body.appendChild(menu);
    const ir = icon.getBoundingClientRect();
    // Prefer opening ABOVE the icon (away from the autocomplete below the field);
    // fall back to below only if there's no room above
    let top = ir.top - menu.offsetHeight - 4;
    if (top < 4) top = ir.bottom + 4;
    menu.style.top = top + 'px';
    menu.style.left = Math.max(4, Math.min(ir.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 6)) + 'px';

    // Close when clicking anywhere outside the icon/menu (the field is blurred,
    // so focusout won't fire to close it)
    const onOutside = (ev) => {
        if (ev.target.closest && ev.target.closest('#ff-ai-field-icon, #ff-ai-field-menu')) return;
        document.removeEventListener('mousedown', onOutside, true);
        hideFieldAiIcon();
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

async function runFieldAiFill(el, mode) {
    if (!el || !document.contains(el)) return;
    const info = collectContextFieldInfo(el);
    // Site-independent progress pill (the field outline pulse is unreliable on
    // pages with aggressive styles)
    showFabAiStatus('loading', mode === 'invalid' ? 'Generating invalid data…' : 'Generating valid data…');
    try {
        const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: 'aiGenerateFieldValue', field: info, mode, url: location.href },
                (r) => {
                    if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                    else resolve(r || { error: 'no_response' });
                }
            );
        });
        if (resp.error || resp.value === undefined || resp.value === null) {
            console.warn('AI field fill failed:', resp.error);
            const msg = resp.error === 'no_api_key' ? 'AI key is not configured'
                : resp.error ? ('AI fill failed: ' + resp.error)
                    : 'AI fill failed';
            showFabAiStatus('error', msg);
            flashElement(el, '#ef4444');
            return;
        }
        setContextFieldValue(el, resp.value);
        showFabAiStatus('success', 'Field filled');
        flashElement(el);
        // Keep the icon available on the field after filling (don't make the user
        // click away and back). Re-show if the field is still the active one.
        if (fieldAiIconEnabled && document.contains(el) && (document.activeElement === el || el.isContentEditable)) {
            aiIconTarget = el;
            showFieldAiIcon(el);
        }
    } catch (e) {
        showFabAiStatus('error', 'AI fill failed');
    }
}


function collectContextFieldInfo(el) {
    let label = '';
    try {
        const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        label = ((labelEl && labelEl.innerText) || (el.closest('label') || {}).innerText || '').trim().slice(0, 120);
    } catch (e) { }
    return {
        tag: el.tagName ? el.tagName.toLowerCase() : 'div',
        type: el.isContentEditable ? 'richtext' : (el.type || 'text'),
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        label,
        ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || '',
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        pattern: el.pattern || undefined,
        required: !!el.required,
        min: el.min || undefined,
        max: el.max || undefined,
        autocomplete: el.autocomplete || undefined
    };
}

// ==================== On-page results panel (Link Health / Security) ====================
function qaEsc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

// Cancellation: closing the panel aborts the in-flight scan and unlocks the card.
let qaScanCtrl = null;
let qaActiveTool = null;
function qaAborted() { return qaScanCtrl ? qaScanCtrl.signal.aborted : false; }

function qaClosePanel() {
    const p = document.getElementById('qa-result-panel');
    if (p) p.remove();
    if (qaScanCtrl) { try { qaScanCtrl.abort(); } catch (e) { } }
    if (qaActiveTool) {
        try { chrome.runtime.sendMessage({ action: 'toolPanelClosed', tool: qaActiveTool }); } catch (e) { }
        qaToolDone(qaActiveTool); // unlock the card's "scanning" state too, in case it's still mid-scan
        qaActiveTool = null;
    }
}

// Only one tool should ever be live on the page at once - every one of these
// registers its own document-level listeners and/or floating UI, and two
// running together fight each other for clicks and screen space. Every
// tool-opening function calls this first, regardless of family; each single
// call below already no-ops on its own if that particular tool wasn't open
// (either via its own guard, like stopInspectMode's `if (!inspectState)
// return`, or because getElementById finds nothing to remove).
function qaCancelAllTools() {
    stopInspectMode();          // Element Inspector / XPath Finder / AI Locator / OCR picking
    closeMeasureTool();         // Measure
    qaClosePanel();             // Link Health / Performance / Page Images
    const storage = document.getElementById('qa-storage'); if (storage) storage.remove();
    // closeResponsiveOverlay() unconditionally resets overflow/sends a DNR
    // message even when nothing was open - only call it when #qa-rv is real.
    if (document.getElementById('qa-rv')) closeResponsiveOverlay();
    closeTextMatchPanel();      // Text Match
    closeApiExportPanel();      // API Data Export
    closeTimeMachinePanel();    // Time Machine
}

// Open the floating panel; returns the .qa-body element to fill.
function qaOpenPanel(titleHtml, tool) {
    qaCancelAllTools();
    qaScanCtrl = new AbortController();
    qaActiveTool = tool || null;
    if (qaActiveTool) { try { chrome.runtime.sendMessage({ action: 'toolPanelOpened', tool: qaActiveTool }); } catch (e) { } }
    const panel = document.createElement('div');
    panel.id = 'qa-result-panel';
    panel.innerHTML = `
        <style>
            #qa-result-panel {
                position: fixed; top: 16px; right: 16px; width: 380px; max-height: 84vh;
                z-index: 2147483647; display: flex; flex-direction: column;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 2px solid rgba(139, 92, 246, 0.5); border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.7); color: #fff;
                font-family: 'Segoe UI', Arial, sans-serif; direction: ltr; font-size: 13px;
            }
            #qa-result-panel .qa-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: move; user-select: none; }
            #qa-result-panel .qa-title { font: 700 13.5px/1.4 'Segoe UI', Arial; display: flex; align-items: center; gap: 8px; }
            #qa-result-panel .qa-close { background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; font-size: 13px; }
            #qa-result-panel .qa-close:hover { background: rgba(255,255,255,0.22); }
            #qa-result-panel .qa-body { padding: 12px 14px; overflow-y: auto; }
            #qa-result-panel .qa-empty { text-align: center; color: #94a3b8; padding: 24px 8px; }
            /* Link rows */
            #qa-result-panel .qa-sum { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; } #qa-result-panel .qa-sum .qa-stat { flex: 1 1 21%; min-width: 74px; }
            #qa-result-panel .qa-stat { flex: 1; background: rgba(255,255,255,0.05); border-radius: 10px; padding: 9px; text-align: center; }
            #qa-result-panel .qa-stat .n { font-size: 19px; font-weight: 800; }
            #qa-result-panel .qa-stat .l { font-size: 9.5px; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }
            #qa-result-panel .qa-stat.ok .n { color: #6ee7b7; } #qa-result-panel .qa-stat.bad .n { color: #f87171; }
            #qa-result-panel .lhrow { display: flex; gap: 8px; align-items: center; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,0.03); border-left: 3px solid #475569; margin-bottom: 4px; }
            #qa-result-panel .lhst { font-weight: 700; font-size: 10.5px; font-family: Consolas, monospace; min-width: 30px; text-align: center; flex-shrink: 0; }
            #qa-result-panel .s-ok.lhrow, #qa-result-panel .lhrow.s-ok { border-left-color: #10b981; } #qa-result-panel .lhst.s-ok { color: #6ee7b7; }
            #qa-result-panel .lhrow.s-redir { border-left-color: #fde047; } #qa-result-panel .lhst.s-redir { color: #fef08a; }
            #qa-result-panel .lhrow.s-auth { border-left-color: #3b82f6; } #qa-result-panel .lhst.s-auth { color: #93c5fd; }
            #qa-result-panel .lhrow.s-forbid { border-left-color: #a855f7; } #qa-result-panel .lhst.s-forbid { color: #c084fc; }
            #qa-result-panel .lhrow.s-broken { border-left-color: #ef4444; background: rgba(239,68,68,0.07); } #qa-result-panel .lhst.s-broken { color: #f87171; }
            #qa-result-panel .lhrow.s-soft { border-left-color: #f97316; background: rgba(249,115,22,0.08); } #qa-result-panel .lhst.s-soft { color: #fdba74; }
            #qa-result-panel .lhrow.s-unknown { border-left-color: #64748b; } #qa-result-panel .lhst.s-unknown { color: #94a3b8; }
            #qa-result-panel .lhrow.s-nourl { border-left-color: #2dd4bf; background: rgba(45,212,191,0.06); } #qa-result-panel .lhst.s-nourl { color: #5eead4; font-size: 8.5px; }
            #qa-result-panel .lh-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10px; color: #94a3b8; margin: 2px 2px 10px; line-height: 1.5; }
            #qa-result-panel .lh-legend b { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
            #qa-result-panel .lh-loc { background: rgba(255,255,255,0.08); border: none; color: #94a3b8; width: 26px; height: 26px; border-radius: 6px; cursor: pointer; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
            #qa-result-panel .lh-loc:hover { background: rgba(255,255,255,0.2); color: #fff; }
            #qa-result-panel .lhhref[data-href] { cursor: pointer; }
            #qa-result-panel .lhhref[data-href]:hover { text-decoration: underline; color: #93c5fd; }
            #qa-result-panel .qa-stat.nourl .n { color: #5eead4; }
            #qa-result-panel .lhinfo { flex: 1; min-width: 0; }
            #qa-result-panel .lhhref { color: #60a5fa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #qa-result-panel .lhtext { color: #94a3b8; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
            #qa-result-panel .qa-btn { width: 100%; border: none; border-radius: 8px; padding: 9px; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff; background: linear-gradient(135deg, #8b5cf6, #6366f1); margin-bottom: 10px; }
            #qa-result-panel .qa-btn:hover { filter: brightness(1.12); }
            #qa-result-panel .qa-btn:disabled { opacity: .6; cursor: wait; }
            /* Findings */
            #qa-result-panel .qa-find { background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.3); border-radius: 10px; padding: 9px 11px; margin-bottom: 8px; }
            #qa-result-panel .qa-find h5 { font-size: 12.5px; margin: 0 0 4px; display: flex; align-items: center; gap: 7px; }
            #qa-result-panel .qa-find .sev { font-size: 8.5px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 7px; }
            #qa-result-panel .qa-find .sev.high { background: rgba(239,68,68,0.2); color: #fca5a5; }
            #qa-result-panel .qa-find .sev.medium { background: rgba(245,158,11,0.2); color: #fcd34d; }
            #qa-result-panel .qa-find .sev.low { background: rgba(16,185,129,0.2); color: #6ee7b7; }
            #qa-result-panel .qa-find p { font-size: 12px; color: #cbd5e1; line-height: 1.6; margin: 4px 0 0; }
            #qa-result-panel .qa-find .fix { color: #7dd3fc; }
            /* Security */
            #qa-result-panel .qa-score-wrap { display: flex; align-items: center; gap: 14px; background: rgba(255,255,255,0.04); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
            #qa-result-panel .qa-score { width: 58px; height: 58px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; flex-shrink: 0; }
            #qa-result-panel .qa-score.good { background: conic-gradient(#10b981 var(--p), rgba(255,255,255,0.08) 0); }
            #qa-result-panel .qa-score.mid { background: conic-gradient(#f59e0b var(--p), rgba(255,255,255,0.08) 0); }
            #qa-result-panel .qa-score.bad { background: conic-gradient(#ef4444 var(--p), rgba(255,255,255,0.08) 0); }
            #qa-result-panel .qa-score span { background: #15152b; width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
            #qa-result-panel .qa-score-info h4 { font-size: 13px; margin: 0 0 3px; }
            #qa-result-panel .qa-score-info p { font-size: 11.5px; color: #94a3b8; margin: 0; }
            #qa-result-panel .qa-secrow { display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,0.03); margin-bottom: 4px; }
            #qa-result-panel .qa-secrow.pass { border-left: 3px solid #10b981; } #qa-result-panel .qa-secrow.fail { border-left: 3px solid #ef4444; } #qa-result-panel .qa-secrow.warn { border-left: 3px solid #f59e0b; }
            #qa-result-panel .qa-secrow .nm { font-weight: 600; }
            #qa-result-panel .qa-secrow .ds { color: #94a3b8; font-size: 11px; margin-top: 2px; }
            #qa-result-panel .qa-grp { font-size: 9.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #64748b; margin: 12px 0 6px; }
            /* Performance */
            #qa-result-panel .pf-vitals { display: flex; gap: 8px; margin-bottom: 12px; }
            #qa-result-panel .pf-vital { flex: 1; background: rgba(255,255,255,0.05); border-radius: 10px; padding: 9px 4px; text-align: center; border-top: 3px solid #64748b; }
            #qa-result-panel .pf-vital.pf-good { border-top-color: #10b981; } #qa-result-panel .pf-vital.pf-mid { border-top-color: #f59e0b; } #qa-result-panel .pf-vital.pf-bad { border-top-color: #ef4444; }
            #qa-result-panel .pf-vn { font-size: 15px; font-weight: 800; }
            #qa-result-panel .pf-good .pf-vn { color: #6ee7b7; } #qa-result-panel .pf-mid .pf-vn { color: #fcd34d; } #qa-result-panel .pf-bad .pf-vn { color: #f87171; }
            #qa-result-panel .pf-vl { font-size: 9.5px; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }
            #qa-result-panel .pf-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 11px; }
            #qa-result-panel .pf-bar-l { width: 92px; color: #cbd5e1; flex-shrink: 0; }
            #qa-result-panel .pf-bar-track { flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 5px; overflow: hidden; }
            #qa-result-panel .pf-bar { height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); border-radius: 5px; }
            #qa-result-panel .pf-bar-v { width: 52px; text-align: right; color: #94a3b8; flex-shrink: 0; font-family: Consolas, monospace; }
            #qa-result-panel .pf-wf-cap { font-size: 10.5px; color: #64748b; margin: -2px 0 8px; }
            #qa-result-panel .pf-wf { position: relative; padding-top: 22px; }
            #qa-result-panel .pf-wf-row { display: flex; align-items: center; min-height: 24px; }
            #qa-result-panel .pf-wf-l { width: 112px; box-sizing: border-box; flex-shrink: 0; font-size: 11px; font-weight: 600; color: #cbd5e1; line-height: 1.2; padding-right: 6px; }
            #qa-result-panel .pf-wf-l small { display: block; font-size: 9.5px; font-weight: 400; color: #64748b; }
            #qa-result-panel .pf-wf-row.sub .pf-wf-l { font-weight: 400; color: #94a3b8; padding-left: 10px; border-left: 2px dotted #475569; }
            #qa-result-panel .pf-wf-track { position: relative; flex: 1; height: 24px; background: rgba(255,255,255,0.025); border-radius: 3px; }
            #qa-result-panel .pf-wf-track > i { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed rgba(148,163,184,0.18); }
            #qa-result-panel .pf-wf-track > b { position: absolute; top: 6px; height: 12px; border-radius: 2px; }
            #qa-result-panel .pf-wf-net { background: #7aa7d8; }
            #qa-result-panel .pf-wf-ren { background: #e2c582; }
            #qa-result-panel .pf-wf-sub { background: rgba(226,197,130,0.45); }
            #qa-result-panel .pf-wf-track > em { position: absolute; top: 5px; font-style: normal; font-size: 10px; color: #94a3b8; font-family: Consolas, monospace; white-space: nowrap; }
            #qa-result-panel .pf-wf-row.axis .pf-wf-track { background: none; height: 16px; }
            #qa-result-panel .pf-wf-row.axis span { position: absolute; top: 2px; transform: translateX(-50%); font-size: 9.5px; color: #64748b; white-space: nowrap; }
            #qa-result-panel .pf-wf-ov { position: absolute; left: 112px; right: 0; top: 14px; bottom: 16px; pointer-events: none; z-index: 2; }
            #qa-result-panel .pf-wf-total { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid #94a3b8; }
            #qa-result-panel .pf-wf-total::before { content: ''; position: absolute; top: -4px; left: -5px; width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
            #qa-result-panel .pf-wf-total span { position: absolute; top: -18px; right: 6px; font-size: 10.5px; color: #cbd5e1; white-space: nowrap; }
            #qa-result-panel .pf-wf-total b { color: #fff; font-size: 12px; }
            #qa-result-panel .pf-res { display: flex; justify-content: space-between; font-size: 11.5px; color: #cbd5e1; padding: 4px 2px; border-bottom: 1px solid rgba(255,255,255,0.04); }
            #qa-result-panel .pf-slow { background: rgba(255,255,255,0.03); border-radius: 7px; padding: 6px 8px; margin-bottom: 4px; }
            #qa-result-panel .pf-slow-top { display: flex; gap: 8px; font-size: 10.5px; }
            #qa-result-panel .pf-slow-dur { color: #fca5a5; font-weight: 700; font-family: Consolas, monospace; }
            #qa-result-panel .pf-slow-type { color: #a5b4fc; } #qa-result-panel .pf-slow-sz { color: #94a3b8; margin-left: auto; }
            #qa-result-panel .pf-slow-url { font-size: 10px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; direction: ltr; }
            /* Page Images */
            #qa-result-panel .qa-img-toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
            #qa-result-panel .qa-img-search { flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: #fff; padding: 7px 9px; font-size: 11.5px; outline: none; }
            #qa-result-panel .qa-img-type { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: #fff; padding: 7px 6px; font-size: 11.5px; outline: none; }
            #qa-result-panel .qa-img-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
            #qa-result-panel .qa-img-selectall { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #cbd5e1; cursor: pointer; }
            #qa-result-panel .qa-img-dl-btn { border: none; border-radius: 8px; padding: 7px 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; color: #fff; background: linear-gradient(135deg, #10b981, #14b8a6); white-space: nowrap; }
            #qa-result-panel .qa-img-dl-btn:disabled { opacity: .4; cursor: not-allowed; }
            #qa-result-panel .qa-body { overflow-x: hidden; }
            #qa-result-panel .qa-img-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
            /* min-width:0 lets a grid column shrink below its content's
               natural width - without it the nowrap filename label forces
               each column wider than 1fr, overflowing the panel sideways. */
            #qa-result-panel .qa-img-card { position: relative; min-width: 0; box-sizing: border-box; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 6px; }
            #qa-result-panel .qa-img-thumb { height: 72px; display: flex; align-items: center; justify-content: center; background: repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 14px 14px; border-radius: 6px; overflow: hidden; }
            #qa-result-panel .qa-img-thumb img, #qa-result-panel .qa-img-thumb svg { max-width: 100%; max-height: 100%; object-fit: contain; }
            #qa-result-panel .qa-img-label { font-size: 9.5px; color: #94a3b8; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: ltr; text-align: center; }
            #qa-result-panel .qa-img-check { position: absolute; top: 4px; left: 4px; z-index: 1; }
            #qa-result-panel .qa-img-get { position: absolute; top: 4px; right: 4px; z-index: 1; background: rgba(0,0,0,0.5); border: none; color: #fff; width: 22px; height: 22px; border-radius: 6px; cursor: pointer; font-size: 10px; }
            #qa-result-panel .qa-img-get:hover { background: rgba(16,185,129,0.7); }
            #qa-result-panel .qa-img-get:disabled { opacity: .5; cursor: wait; }
        </style>
        <div class="qa-head">
            <span class="qa-title">${titleHtml}</span>
            <button class="qa-close" id="qa-close" title="Close">&#10005;</button>
        </div>
        <div class="qa-body" id="qa-body"><div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Working…</div></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#qa-close').addEventListener('click', qaClosePanel);
    qaAddMinimize(panel, panel.querySelector('.qa-head'), panel.querySelector('#qa-close'));

    // Canvas apps (Figma, Miro, maps, games) listen for wheel events on the
    // window to zoom/pan their surface - which hijacks scrolling inside this
    // panel, so the list won't move. Stopping the wheel event from bubbling
    // out of the panel lets the panel body scroll normally while the app
    // never sees it. (The panel's own default scroll still happens.)
    panel.addEventListener('wheel', (e) => { e.stopPropagation(); }, false);

    // Drag the panel by its header
    (function makeDraggable() {
        const head = panel.querySelector('.qa-head');
        let sx = 0, sy = 0, sl = 0, st = 0;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.qa-close') || e.button !== 0) return;
            const rect = panel.getBoundingClientRect();
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';
            sx = e.clientX; sy = e.clientY; sl = rect.left; st = rect.top;
            e.preventDefault();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });
        function onMove(e) {
            let nl = sl + (e.clientX - sx), nt = st + (e.clientY - sy);
            nl = Math.max(0, Math.min(nl, window.innerWidth - panel.offsetWidth));
            nt = Math.max(0, Math.min(nt, window.innerHeight - 40));
            panel.style.left = nl + 'px';
            panel.style.top = nt + 'px';
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
        }
    })();

    return panel.querySelector('#qa-body');
}

// ---- Link Health (runs in the page so same-origin cert/session apply) ----
// Statuses that mean "the checker was refused", NOT "the page is broken":
// auth walls, bot blocks, rate limits, legal blocks, LinkedIn's 999...
const LH_BLOCKED = new Set([401, 403, 405, 406, 407, 418, 429, 451, 999]);
function lhClassify(r) {
    if (r.soft) return { kind: 's-soft', label: '200⚠' };
    const s = r.status;
    if (s >= 200 && s < 300) return { kind: 's-ok', label: String(s) };
    if (s >= 300 && s < 400) return { kind: 's-redir', label: String(s) };
    if (s === 401 || s === 407) return { kind: 's-auth', label: String(s) };
    if (LH_BLOCKED.has(s)) return { kind: 's-forbid', label: String(s) };
    if (s >= 400) return { kind: 's-broken', label: String(s) };
    return { kind: 's-unknown', label: r.error ? 'ERR' : '0' };
}
const LH_COLORS = { 's-ok': '#10b981', 's-redir': '#fde047', 's-auth': '#3b82f6', 's-forbid': '#a855f7', 's-broken': '#ef4444', 's-unknown': '#64748b', 's-soft': '#f97316' };
function lhIsBroken(r) { return r.soft || (r.status >= 400 && !LH_BLOCKED.has(r.status)) || (r.status === 0 && r.error && r.error !== 'Timeout'); }

function qaToolDone(tool) { try { chrome.runtime.sendMessage({ action: 'toolScanDone', tool }); } catch (e) { } }

async function runLinkHealth() {
    const body = qaOpenPanel('&#128279; Link Health', 'links');
    try {
        await runLinkHealthInner(body);
    } finally {
        // qaActiveTool stays set here - it now also tracks "the panel is open"
        // for the popup card's .active state, cleared only when qaClosePanel()
        // actually removes the panel, not just when the scan finishes.
        if (!qaAborted()) qaToolDone('links');
    }
}

async function runLinkHealthInner(body) {
    const myCtrl = qaScanCtrl;                 // this scan's own cancel token
    const aborted = () => !myCtrl || myCtrl.signal.aborted;
    // Collect links + keep element refs (for on-page colouring). Anchors that
    // "work" but have no real URL (href="#", javascript:, or no href + a JS
    // handler) are collected separately so we can flag them.
    const map = new Map();
    lhNoUrl = [];
    document.querySelectorAll('a').forEach(a => {
        const raw = (a.getAttribute('href') || '').trim();
        const text = (a.textContent || '').trim().slice(0, 100);
        const handler = a.hasAttribute('onclick') || a.getAttribute('role') === 'button' || a.getAttribute('role') === 'link';
        // No real URL: missing href, empty, "#", or javascript:
        if (!raw || raw === '#' || /^javascript:/i.test(raw)) {
            lhNoUrl.push({ el: a, text, reason: !raw ? 'No href attribute' : (/^javascript:/i.test(raw) ? 'javascript: link' : 'Empty "#" link'), handler });
            return;
        }
        if (/^#/.test(raw)) return;            // in-page anchor (#section) - works, skip
        if (!/^https?:/i.test(a.href)) return; // mailto/tel/etc - ignore
        if (!map.has(a.href)) map.set(a.href, { href: a.href, text, els: [] });
        map.get(a.href).els.push(a);
    });
    let links = [...map.values()];
    if (!links.length && !lhNoUrl.length) { body.innerHTML = '<div class="qa-empty">No links found on this page.</div>'; return; }
    const MAX = 200;
    links = links.slice(0, MAX);
    body.innerHTML = `<div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Checking links… <b id="lh-prog">0/${links.length}</b></div>`;

    const origin = location.origin;
    const same = links.filter(l => { try { return new URL(l.href).origin === origin; } catch (e) { return false; } });
    const cross = links.filter(l => !same.includes(l));

    function sniff(u, method) {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
        const onAbort = () => { try { ctrl.abort(); } catch (e) { } };
        if (myCtrl) myCtrl.signal.addEventListener('abort', onAbort);
        const cleanup = () => { clearTimeout(timer); if (myCtrl) myCtrl.signal.removeEventListener('abort', onAbort); };
        // 'PEEK' = GET but cancel the body once headers arrive: as reliable as
        // a real visit (HEAD answers are often wrong) at almost HEAD's cost
        const real = method === 'PEEK' ? 'GET' : (method || 'GET');
        return fetch(u, { method: real, redirect: 'follow', signal: ctrl.signal })
            .then(async r => {
                let len = null;
                if (real === 'GET' && method !== 'PEEK') { let t = ''; try { t = await r.text(); } catch (e) { } len = t.replace(/\s+/g, ' ').trim().length; }
                const out = { status: r.status, ok: r.ok, redirected: r.redirected, finalUrl: r.url, len };
                cleanup();
                if (method === 'PEEK') { try { ctrl.abort(); } catch (e) { } }
                return out;
            })
            .catch(e => { cleanup(); return { status: 0, ok: false, error: e.name === 'AbortError' ? 'Timeout' : (e.message || 'Failed'), finalUrl: u, len: null }; });
    }

    // Soft-404 probe: many portals/SPAs answer 200 for missing pages. Probe a
    // guaranteed-missing URL INSIDE the same path namespaces the links use (so we
    // hit the same router), plus the home page, to learn how the site behaves.
    let softMode = false; const baseLens = []; // lengths of the site's "not found" page(s)
    if (same.length) {
        const prefixes = new Set(['/']);
        for (const l of same) { try { prefixes.add(new URL(l.href).pathname.replace(/[^/]*$/, '')); } catch (e) { } if (prefixes.size >= 4) break; }
        const rand = '__qa_missing_' + Date.now() + Math.random().toString(36).slice(2);
        const probeUrls = [...prefixes].slice(0, 4).map(p => origin + p + rand);
        const home = await sniff(origin + '/');
        const probes = await Promise.all(probeUrls.map(u => sniff(u)));
        for (const pr of probes) {
            if (pr.status >= 200 && pr.status < 400 && pr.len > 0) {
                softMode = true; // the site serves "OK" for a page that cannot exist
                const distinctFromHome = !home.len || Math.abs(pr.len - home.len) / Math.max(home.len, 1) >= 0.05;
                if (distinctFromHome) baseLens.push(pr.len);
            }
        }
    }

    function isSoft(href, res) {
        try {
            const fp = new URL(res.finalUrl).pathname, hp = new URL(href).pathname;
            if (fp !== hp && (fp === '/' || /404|not.?found|error|missing/i.test(fp))) return true; // redirected away
        } catch (e) { }
        if (res.len != null) { for (const b of baseLens) if (b && Math.abs(res.len - b) / b < 0.05) return true; }
        return false;
    }

    const LH_TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524]);
    async function checkHere(list) {
        const out = new Array(list.length); let i = 0;
        async function worker() {
            while (i < list.length) {
                if (aborted()) return; // panel closed → stop
                const idx = i++; const href = list[idx].href;
                // In soft-404 mode we GET (need the body length); otherwise PEEK
                // (a real GET whose body is cancelled after the headers).
                let res = await sniff(href, softMode ? 'GET' : 'PEEK');
                // transient failure -> pause and retry once before judging
                if (!aborted() && (res.status === 0 || LH_TRANSIENT.has(res.status))) {
                    await new Promise(r2 => setTimeout(r2, 1500));
                    const retry = await sniff(href, softMode ? 'GET' : 'PEEK');
                    if (retry.status !== 0 && !LH_TRANSIENT.has(retry.status)) res = retry;
                    else if (res.status === 0 && retry.status !== 0) res = retry;
                }
                if (softMode && res.status >= 200 && res.status < 400) res.soft = isSoft(href, res);
                out[idx] = res;
                Object.assign(list[idx], res);
                lhDone++; lhPaint(list[idx]); lhProgress();
                // all same-origin = same host: pace the requests so the site's
                // own rate-limit/WAF never fires
                await new Promise(r2 => setTimeout(r2, 120 + Math.random() * 130));
            }
        }
        await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
        return out;
    }
    function checkBg(list) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'checkLinks', links: list.map(l => ({ href: l.href })) }, (resp) => {
                if (chrome.runtime.lastError || !resp || resp.error) { resolve(list.map(() => ({ status: 0, ok: false, error: 'check failed' }))); return; }
                resolve((resp.results || []).map(r => ({ status: r.status, ok: r.ok, error: r.error, redirected: r.redirected })));
            });
        });
    }

    // progressive painting: each link is coloured on the page the moment ITS
    // check finishes - no waiting for the whole batch
    let lhDone = 0;
    const lhProgress = () => {
        const el = body.querySelector('#lh-prog');
        if (el) el.textContent = `${lhDone}/${links.length}`;
    };
    const lhPaint = (l) => {
        const c = lhClassify(l); const color = LH_COLORS[c.kind];
        (l.els || []).forEach(el => {
            if (!el.isConnected) return;
            el.style.setProperty('outline', `2px solid ${color}`, 'important');
            el.style.setProperty('outline-offset', '1px', 'important');
            el.setAttribute('data-qa-link', c.label);
            el.title = `QA Link Health: ${l.soft ? 'Soft 404 — HTTP 200 but the page looks like a not-found/redirect' : (l.status === 0 ? (l.error || 'Unreachable') : l.status)}`;
        });
    };
    // cross-origin: one background batch PER HOST, painted as each host finishes
    async function checkBgProgressive(list) {
        const byHost = new Map();
        list.forEach((l, i) => {
            let h = ''; try { h = new URL(l.href).host; } catch (e) { }
            if (!byHost.has(h)) byHost.set(h, []);
            byHost.get(h).push(i);
        });
        const out = new Array(list.length);
        await Promise.all([...byHost.values()].map(async idxs => {
            const res = await checkBg(idxs.map(i => list[i]));
            if (aborted()) return;
            idxs.forEach((i, k) => {
                out[i] = res[k] || { status: 0, ok: false };
                Object.assign(list[i], out[i]);
                lhDone++; lhPaint(list[i]); lhProgress();
            });
        }));
        return out;
    }

    const [sameRes, crossRes] = await Promise.all([
        same.length ? checkHere(same) : Promise.resolve([]),
        cross.length ? checkBgProgressive(cross) : Promise.resolve([])
    ]);
    if (aborted()) return; // panel closed mid-scan
    same.forEach((l, i) => Object.assign(l, sameRes[i] || { status: 0, ok: false }));
    cross.forEach((l, i) => Object.assign(l, crossRes[i] || { status: 0, ok: false }));

    // Mark the no-URL anchors with a distinct dashed outline
    lhNoUrl.forEach(n => {
        if (!n.el.isConnected) return;
        n.el.style.setProperty('outline', '2px dashed #2dd4bf', 'important');
        n.el.style.setProperty('outline-offset', '1px', 'important');
        n.el.title = `QA Link Health: ${n.reason}${n.handler ? ' (has a JS handler)' : ''} — works via script but has no real URL`;
    });

    lhRenderResults(body, links);
}

let lhBrokenCache = [];
let lhNoUrl = [];
function lhRenderResults(body, links) {
    const order = { 's-broken': 0, 's-soft': 1, 's-unknown': 2, 's-redir': 3, 's-auth': 4, 's-forbid': 5, 's-ok': 6 };
    const rows = links.map(l => ({ l, c: lhClassify(l) })).sort((a, b) => order[a.c.kind] - order[b.c.kind]);
    lhBrokenCache = links.filter(lhIsBroken).map(l => ({ href: l.href, text: l.text, status: l.status, error: l.soft ? 'Soft 404 (HTTP 200 but content looks like a not-found page or redirect to home)' : l.error }));
    // per-category counts (mirror the row classification exactly)
    const kc = {};
    rows.forEach(({ c }) => { kc[c.kind] = (kc[c.kind] || 0) + 1; });

    const LOC_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/></svg>';
    const tile = (n, label, color) => `<div class="qa-stat"><div class="n" style="color:${color};">${n}</div><div class="l">${label}</div></div>`;
    let html = `<div class="qa-sum">
        ${tile(links.length, 'Checked', '#fff')}
        ${tile(kc['s-ok'] || 0, 'OK', LH_COLORS['s-ok'])}
        ${tile(kc['s-broken'] || 0, 'Broken', LH_COLORS['s-broken'])}
        ${tile(kc['s-forbid'] || 0, 'Blocked', LH_COLORS['s-forbid'])}
        ${tile(kc['s-soft'] || 0, 'Soft 404', LH_COLORS['s-soft'])}
        ${tile(kc['s-redir'] || 0, 'Redirect', LH_COLORS['s-redir'])}
        ${tile(kc['s-auth'] || 0, 'Login', LH_COLORS['s-auth'])}
        ${(kc['s-unknown'] || 0) ? tile(kc['s-unknown'], 'Unreachable', LH_COLORS['s-unknown']) : ''}
        ${tile(lhNoUrl.length, 'No URL', '#2dd4bf')}
    </div>
    <div class="lh-legend">
        <span><b style="background:#10b981"></b>OK — verified working</span>
        <span><b style="background:#ef4444"></b>Broken — page really missing (404/410/5xx)</span>
        <span><b style="background:#a855f7"></b>Blocked — server refused the automated check (403/429…); usually fine for real visitors, verify manually</span>
        <span><b style="background:#f97316"></b>Soft 404 — says OK but shows an error page</span>
        <span><b style="background:#fde047"></b>Redirect</span>
        <span><b style="background:#3b82f6"></b>Login required</span>
    </div>`;
    html += rows.map(({ l, c }, i) => `<div class="lhrow ${c.kind}">
        <span class="lhst ${c.kind}">${qaEsc(c.label)}</span>
        <div class="lhinfo"><div class="lhhref" data-href="${qaEsc(l.href)}" title="Open the link in a new tab">${qaEsc(l.href)}</div>${l.text ? `<div class="lhtext">${qaEsc(l.text)}</div>` : ''}</div>
        <button class="lh-loc" data-i="${i}" title="Show this link on the page">${LOC_SVG}</button>
    </div>`).join('');

    if (lhNoUrl.length) {
        html += `<div class="qa-grp">Links without a real URL (${lhNoUrl.length})</div>`;
        html += lhNoUrl.map((n, i) => `<div class="lhrow s-nourl">
            <span class="lhst s-nourl" title="${qaEsc(n.reason)}">NO&nbsp;URL</span>
            <div class="lhinfo"><div class="lhtext" style="color:#cbd5e1;">${qaEsc(n.text || '(no text)')}</div><div class="lhtext">${qaEsc(n.reason)}${n.handler ? ' · has JS handler' : ''}</div></div>
            <button class="lh-loc" data-n="${i}" title="Show this link on the page">${LOC_SVG}</button>
        </div>`).join('');
    }
    body.innerHTML = html;

    // locate: scroll to the anchor on the page and flash a black outline on it
    const lhFlash = (el) => {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
        setTimeout(() => {
            try {
                const r = el.getBoundingClientRect();
                const box = document.createElement('div');
                box.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid #000;border-radius:5px;z-index:2147483646;pointer-events:none;`;
                document.body.appendChild(box);
                setTimeout(() => box.remove(), 2400);
            } catch (e) { }
        }, 500);
    };
    body.querySelectorAll('.lh-loc').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        let el = null;
        if (btn.dataset.i !== undefined) { const d = rows[+btn.dataset.i]; el = d && d.l.els && d.l.els.find(x => x.isConnected); }
        else if (btn.dataset.n !== undefined) { const n = lhNoUrl[+btn.dataset.n]; el = n && n.el && n.el.isConnected ? n.el : null; }
        if (el) lhFlash(el);
    }));
    // clicking the URL opens it in a new tab
    body.querySelectorAll('.lhhref[data-href]').forEach(a => a.addEventListener('click', () => {
        try { window.open(a.dataset.href, '_blank', 'noopener'); } catch (e) { }
    }));

}

// ---- Performance Monitor (collected in the page; AI explains the result) ----
function perfRate(metric, val) {
    const T = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], load: [3000, 6000], dcl: [2000, 4000] };
    const t = T[metric]; if (!t || !val) return 'na';
    return val <= t[0] ? 'good' : val <= t[1] ? 'mid' : 'bad';
}
function perfMs(v) { return v ? (v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms') : '—'; }
function perfKb(b) { return b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB'; }

async function collectPerf() {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paint = performance.getEntriesByType('paint') || [];
    const fcp = (paint.find(p => p.name === 'first-contentful-paint') || {}).startTime || 0;
    const lcp = await new Promise(res => {
        let v = 0;
        try {
            const po = new PerformanceObserver(list => { const e = list.getEntries(); if (e.length) v = e[e.length - 1].startTime; });
            po.observe({ type: 'largest-contentful-paint', buffered: true });
            setTimeout(() => { try { po.disconnect(); } catch (e) { } res(v); }, 300);
        } catch (e) { res(0); }
    });
    const d = (a, b) => Math.max(0, (nav[a] || 0) - (nav[b] || 0));
    const resAll = performance.getEntriesByType('resource') || [];
    const byType = {}; let totalSize = 0;
    resAll.forEach(r => {
        const t = r.initiatorType || 'other';
        const size = r.transferSize || r.encodedBodySize || 0;
        byType[t] = byType[t] || { count: 0, size: 0 };
        byType[t].count++; byType[t].size += size; totalSize += size;
    });
    const slowest = resAll.map(r => ({ name: r.name, type: r.initiatorType || 'other', dur: Math.round(r.duration || 0), size: r.transferSize || r.encodedBodySize || 0 }))
        .sort((a, b) => b.dur - a.dur).slice(0, 8);
    return {
        ttfb: nav.responseStart || 0,
        fcp, lcp,
        domInteractive: nav.domInteractive || 0,
        dcl: nav.domContentLoadedEventEnd || 0,
        load: nav.loadEventEnd || 0,
        phases: { dns: d('domainLookupEnd', 'domainLookupStart'), tcp: d('connectEnd', 'connectStart'), request: d('responseStart', 'requestStart'), response: d('responseEnd', 'responseStart'), dom: d('domComplete', 'responseEnd') },
        // raw navigation marks (ms from navigation start) for the waterfall
        timing: Object.fromEntries(['redirectStart', 'redirectEnd', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd']
            .map((k) => [k, Math.max(0, nav[k] || 0)])),
        capturedAt: Date.now(),
        resourceCount: resAll.length,
        totalSize,
        byType,
        slowest,
        memory: performance.memory ? { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null
    };
}

let perfLast = null;
async function runPerformance() {
    const body = qaOpenPanel('&#9889; Performance', 'perf');
    const panelEl = body.closest('#qa-result-panel');
    // the waterfall needs room for its time axis - wider than the 380px default
    if (panelEl) { panelEl.style.width = '560px'; panelEl.style.maxWidth = 'calc(100vw - 32px)'; }
    try {
        const m = await collectPerf();
        if (qaAborted()) return;
        perfLast = m;
        perfRender(body, m);
    } finally {
        // qaActiveTool stays set - see the same note in runLinkHealth().
        if (!qaAborted()) qaToolDone('perf');
    }
}

// Navigation Timings as a WATERFALL on one shared time axis (like the "Page Load Time"
// extension): each phase is a bar placed at its real start, so you see what ran when,
// and a vertical marker shows the total Page Load Time.
function perfWaterfall(t, capturedAt) {
    if (!t) return '';
    const end = t.loadEventEnd || t.loadEventStart || t.domComplete || t.responseEnd;
    if (!end) return '<div class="qa-grp">Navigation timings</div><div class="qa-empty">No navigation timing for this page (it was restored from cache or is a single-page-app route).</div>';
    const rows = [
        { l: 'Redirect', a: t.redirectStart, b: t.redirectEnd, k: 'net' },
        { l: 'DNS', a: t.domainLookupStart, b: t.domainLookupEnd, k: 'net' },
        { l: 'Connect', a: t.connectStart, b: t.connectEnd, k: 'net' },
        { l: 'Request', s: 'Network + server processing', a: t.requestStart, b: t.responseStart, k: 'net' },
        { l: 'Response', a: t.responseStart, b: t.responseEnd, k: 'net' },
        { l: 'Rendering', a: t.responseEnd, b: t.loadEventStart || t.domComplete, k: 'ren' },
        { l: 'HTML Parse', s: 'DOM building', a: t.responseEnd, b: t.domInteractive, k: 'sub' },
        { l: 'DOM + CSSOM ready', a: t.responseEnd, b: t.domContentLoadedEventStart, k: 'sub' },
        { l: 'DCL event', s: 'DOMContentLoaded handlers', a: t.domContentLoadedEventStart, b: t.domContentLoadedEventEnd, k: 'sub' },
        { l: 'Layout, Paint', s: '& subresources', a: t.domContentLoadedEventEnd, b: t.domComplete, k: 'sub' },
        { l: 'Load event', a: t.loadEventStart, b: t.loadEventEnd, k: 'net' },
    ];
    // A "nice" axis step so there are ~5 gridlines: 1/2/5 × 10^n ms.
    const raw = end / 5, pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 5, 10].map((f) => f * pow).find((x) => x >= raw) || raw;
    const max = Math.ceil(end / step) * step;
    const pct = (v) => (v / max * 100).toFixed(2) + '%';
    let ticks = '', grid = '';
    for (let v = 0; v <= max + 0.001; v += step) {
        grid += `<i style="left:${pct(v)}"></i>`;
        ticks += `<span style="left:${pct(v)}">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 's' : Math.round(v) + 'ms'}</span>`;
    }
    const bar = (r) => {
        const a = Math.max(0, r.a || 0), b = Math.max(a, r.b || 0), dur = b - a;
        return `<div class="pf-wf-row${r.k === 'sub' ? ' sub' : ''}">
            <div class="pf-wf-l">${r.l}${r.s ? `<small>${r.s}</small>` : ''}</div>
            <div class="pf-wf-track">${grid}${(r.a || r.b) ? `<b class="pf-wf-${r.k}" style="left:${pct(a)};width:max(2px,${pct(dur)})"></b><em style="left:calc(${pct(b)} + 4px)">${perfMs(dur) === '—' ? '0ms' : perfMs(dur)}</em>` : '<em style="left:0">0ms</em>'}</div>
        </div>`;
    };
    const when = new Date(capturedAt || Date.now());
    return `<div class="qa-grp">Navigation timings</div>
        <div class="pf-wf-cap">Captured ${when.toLocaleTimeString()} · ${when.toLocaleDateString()}</div>
        <div class="pf-wf">
            <div class="pf-wf-ov"><div class="pf-wf-total" style="left:${pct(end)}"><span>Page Load Time: <b>${perfMs(end)}</b></span></div></div>
            ${rows.map(bar).join('')}
            <div class="pf-wf-row axis"><div class="pf-wf-l"></div><div class="pf-wf-track">${ticks}</div></div>
        </div>`;
}

function perfRender(body, m) {
    const vital = (label, key, val) => {
        const r = perfRate(key, val);
        return `<div class="pf-vital pf-${r}"><div class="pf-vn">${perfMs(val)}</div><div class="pf-vl">${label}</div></div>`;
    };
    let html = `<div class="pf-vitals">
        ${vital('LCP', 'lcp', m.lcp)}
        ${vital('FCP', 'fcp', m.fcp)}
        ${vital('TTFB', 'ttfb', m.ttfb)}
        ${vital('Load', 'load', m.load)}
    </div>`;
    html += `<button class="qa-btn" id="pf-explain"><i class="fas fa-wand-magic-sparkles"></i> Explain &amp; Optimize</button>`;

    html += perfWaterfall(m.timing, m.capturedAt);

    // Resources summary
    html += `<div class="qa-grp">Resources (${m.resourceCount} · ${perfKb(m.totalSize)})</div>`;
    html += Object.entries(m.byType).sort((a, b) => b[1].size - a[1].size).map(([t, v]) =>
        `<div class="pf-res"><span>${qaEsc(t)}</span><span>${v.count} · ${perfKb(v.size)}</span></div>`).join('');

    // Slowest
    if (m.slowest.length) {
        html += `<div class="qa-grp">Slowest resources</div>`;
        html += m.slowest.filter(s => s.dur > 0).map(s => `<div class="pf-slow">
            <div class="pf-slow-top"><span class="pf-slow-dur">${perfMs(s.dur)}</span> <span class="pf-slow-type">${qaEsc(s.type)}</span> <span class="pf-slow-sz">${perfKb(s.size)}</span></div>
            <div class="pf-slow-url">${qaEsc(s.name)}</div>
        </div>`).join('');
    }

    if (m.memory) html += `<div class="qa-grp">JS memory</div><div class="pf-res"><span>Used heap</span><span>${perfKb(m.memory.used)} / ${perfKb(m.memory.limit)}</span></div>`;

    body.innerHTML = html;

    const ex = body.querySelector('#pf-explain');
    if (ex) ex.addEventListener('click', () => {
        ex.disabled = true; ex.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing with AI…';
        chrome.runtime.sendMessage({ action: 'aiExplainPerformance', metrics: perfLast, url: location.href }, (resp) => {
            if (chrome.runtime.lastError || !resp || resp.error) {
                ex.disabled = false; ex.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Explain & Optimize';
                alert((resp && resp.error === 'no_api_key') ? 'AI key not configured in the extension settings.' : 'AI failed: ' + ((resp && resp.error) || 'error'));
                return;
            }
            const findings = resp.findings || [];
            let h = `<button class="qa-btn" id="pf-back" style="background:rgba(255,255,255,0.12);"><i class="fas fa-arrow-left"></i> Back to metrics</button>`;
            h += findings.length ? findings.map(f => `<div class="qa-find">
                <h5>${qaEsc(f.title)} <span class="sev ${qaEsc(f.severity)}">${qaEsc(f.severity)}</span></h5>
                <p>${qaEsc(f.cause)}</p><p class="fix"><i class="fas fa-lightbulb"></i> ${qaEsc(f.fix)}</p></div>`).join('')
                : '<div class="qa-empty">The AI found nothing actionable — performance looks good. ✅</div>';
            body.innerHTML = h;
            body.querySelector('#pf-back').addEventListener('click', () => perfRender(body, perfLast));
        });
    });
}

// ---- Page Images (finds every <img> and inline <svg>, preview + download) ----
// FontAwesome isn't loaded inside the page, so panel titles that want an icon
// (rather than an emoji) inline the SVG - matching how the Measure tool does it.
const QA_IMAGES_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
async function runImagesFinder() {
    const body = qaOpenPanel(QA_IMAGES_ICON + '<span>Page Images</span>', 'images');
    const panelEl = body.closest('#qa-result-panel');
    if (panelEl) panelEl.style.width = '440px'; // a 2-column thumbnail grid needs more room than the 380px default
    body.innerHTML = '<div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Scanning the page for images…</div>';
    // Let the panel + spinner paint before the (potentially heavy) DOM scan
    // runs, instead of freezing on a blank panel while it works.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
        const items = collectPageImages();
        if (qaAborted()) return;
        imagesRender(body, items);
        try { chrome.runtime.sendMessage({ action: 'toolResultCount', tool: 'images', count: items.length }); } catch (e) { }
    } finally {
        // qaActiveTool stays set - see the same note in runLinkHealth().
        if (!qaAborted()) qaToolDone('images');
    }
}

// Every element on the page, descending THROUGH shadow roots (web components
// - which a plain document.querySelectorAll('*') never sees into, and modern
// apps put a lot of their real UI, images included, inside). Capped so a
// huge app can't spin forever.
function qaAllElementsDeep(root, out, budget) {
    out = out || [];
    budget = budget || { n: 0 };
    const els = root.querySelectorAll('*');
    for (const el of els) {
        if (budget.n++ > 60000) return out; // safety ceiling for enormous pages
        out.push(el);
        if (el.shadowRoot) qaAllElementsDeep(el.shadowRoot, out, budget);
    }
    return out;
}

// Finds real images from every source the page can hold them in - not just
// <img> and inline <svg>, but also <img srcset>/<picture> (via currentSrc),
// CSS background-image (on any element), and <canvas> - across the light DOM
// AND every shadow root. NOTE: pixels drawn to a WebGL/2D canvas by an app
// like Figma's design surface don't live in the DOM as discrete images and
// can't be enumerated this way; the canvas itself is captured as one image.
function collectPageImages() {
    const seen = new Set();
    const items = [];
    const MAX = 500; // more than any human wants to scroll; keeps the grid usable

    const labelFor = (src) => src.startsWith('data:')
        ? `data:${(src.split(';')[0].split(':')[1] || 'image')} (inline)`
        : src;

    const all = qaAllElementsDeep(document);

    for (const el of all) {
        if (items.length >= MAX) break;
        // Never re-collect this panel's own thumbnails (closest() stays within
        // the panel's own light-DOM tree, so shadow images aren't affected).
        if (el.closest && el.closest('#qa-result-panel')) continue;
        const tag = el.tagName;

        // 1. <img> (currentSrc already resolves srcset / <picture> for us)
        if (tag === 'IMG') {
            const src = el.currentSrc || el.src;
            if (src && !seen.has(src)) {
                const w = el.naturalWidth || el.width || 0, h = el.naturalHeight || el.height || 0;
                if (!(w > 0 && h > 0 && (w < 8 || h < 8))) { // skip tracking pixels
                    seen.add(src);
                    items.push({ kind: 'img', el, src, label: labelFor(src), w, h });
                }
            }
        }

        // 2. <canvas> - snapshot whatever is currently drawn. But NOT an app's
        // whole rendering surface: a design/whiteboard/game/map app (Figma,
        // Miro, etc.) paints everything onto one viewport-filling canvas, and
        // grabbing that is (a) one giant useless "whole page" image, not the
        // individual pictures the user sees - those are painted pixels, not
        // DOM images anything can enumerate - and (b) a slow, memory-heavy
        // toDataURL. Skip canvases that essentially cover the viewport; keep
        // the small ones (charts, avatars, signature pads).
        if (tag === 'CANVAS' && el.width > 8 && el.height > 8) {
            const coversViewport = el.width >= window.innerWidth * 0.8 && el.height >= window.innerHeight * 0.8;
            const tooBig = el.width * el.height > 1400 * 1400;
            if (!coversViewport && !tooBig) {
                let src = null;
                try { src = el.toDataURL('image/png'); } catch (e) { /* tainted */ }
                if (src && !seen.has(src)) {
                    seen.add(src);
                    items.push({ kind: 'img', el, src, label: 'canvas (rendered)', w: el.width, h: el.height });
                }
            }
        }

        // 3. CSS background-image on ANY element (icons, hero images, sprites)
        try {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(')) {
                const re = /url\(["']?(.*?)["']?\)/g;
                let m;
                while ((m = re.exec(bg)) && items.length < MAX) {
                    const u = m[1];
                    if (!u || u.startsWith('data:image/svg') || seen.has(u)) continue;
                    seen.add(u);
                    const r = el.getBoundingClientRect();
                    items.push({ kind: 'img', el, src: u, label: labelFor(u), w: Math.round(r.width), h: Math.round(r.height) });
                }
            }
        } catch (e) { /* getComputedStyle can throw on detached nodes */ }
    }

    // 4. Top-level inline <svg> (skip <svg> nested inside another svg - the
    // outer one already serializes it). Done in a second pass so the item
    // cap above doesn't starve them out before raster images are counted.
    for (const el of all) {
        if (items.length >= MAX) break;
        if (el.tagName !== 'svg') continue; // SVG elements report lowercase tagName
        if (el.closest && el.closest('#qa-result-panel')) continue;
        if (el.parentNode && el.parentNode.closest && el.parentNode.closest('svg')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue; // not actually rendered
        let xml;
        try { xml = new XMLSerializer().serializeToString(el); } catch (e) { continue; }
        if (seen.has(xml)) continue;
        seen.add(xml);
        items.push({ kind: 'svg', el, xml, label: '<svg…>', w: Math.round(rect.width), h: Math.round(rect.height) });
    }

    return items;
}

// A Blob straight from the page (page cookies/session, canvas fallback) -
// getImageBase64 already solves this for the OCR tool; reused as-is rather
// than writing a second fetch/CORS/canvas dance.
async function imageItemToBlob(item) {
    if (item.kind === 'svg') {
        const xml = item.xml.startsWith('<?xml') ? item.xml : `<?xml version="1.0" encoding="UTF-8"?>\n${item.xml}`;
        return { blob: new Blob([xml], { type: 'image/svg+xml' }), ext: 'svg' };
    }
    const res = await getImageBase64(item.el, item.src);
    if (!res) return null;
    const blob = await (await fetch(`data:${res.mediaType};base64,${res.data}`)).blob();
    const ext = (res.mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return { blob, ext };
}

function imageItemFilename(item, index) {
    if (item.kind === 'svg') return `image-${index + 1}.svg`;
    // A data: URI's "pathname" (per the URL spec) IS the whole base64 payload -
    // splitting it on '/' like a normal path grabs a meaningless fragment of
    // the image's own bytes instead of a filename.
    if (item.src.startsWith('data:')) return `image-${index + 1}.png`;
    try {
        const u = new URL(item.src, location.href);
        const base = (u.pathname.split('/').pop() || `image-${index + 1}`).split('?')[0];
        return base.includes('.') ? base : `${base || 'image-' + (index + 1)}.png`;
    } catch (e) { return `image-${index + 1}.png`; }
}

function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function imagesRender(body, items) {
    const picked = new Set();

    if (!items.length) {
        body.innerHTML = '<div class="qa-empty">No images found on this page.</div>';
        return;
    }

    body.innerHTML = `
        <div class="qa-img-toolbar">
            <input type="text" id="qi-search" class="qa-img-search" placeholder="Filter by URL…">
            <select id="qi-type" class="qa-img-type">
                <option value="all">All types</option>
                <option value="img">Images</option>
                <option value="svg">SVG</option>
            </select>
        </div>
        <div class="qa-img-bar">
            <label class="qa-img-selectall"><input type="checkbox" id="qi-selectall"> Select all (<span id="qi-count">0</span>/${items.length})</label>
            <button class="qa-img-dl-btn" id="qi-download" disabled><i class="fas fa-download"></i> Download</button>
        </div>
        <div class="qa-img-grid" id="qi-grid"></div>
    `;

    const grid = body.querySelector('#qi-grid');
    const countEl = body.querySelector('#qi-count');
    const selectAllEl = body.querySelector('#qi-selectall');
    const downloadBtn = body.querySelector('#qi-download');

    const syncBar = () => {
        countEl.textContent = String(picked.size);
        downloadBtn.disabled = picked.size === 0;
        selectAllEl.checked = picked.size > 0 && picked.size === grid.querySelectorAll('.qa-img-card').length;
    };

    const cardHtml = (item, i) => `
        <div class="qa-img-card" data-i="${i}">
            <label class="qa-img-check"><input type="checkbox" data-i="${i}"></label>
            <button class="qa-img-get" data-i="${i}" title="Download this one"><i class="fas fa-download"></i></button>
            <div class="qa-img-thumb">${item.kind === 'svg' ? item.xml : `<img src="${qaEsc(item.src)}" loading="lazy">`}</div>
            <div class="qa-img-label" title="${qaEsc(item.label)}">${item.kind === 'svg' ? '&lt;svg&gt;' : qaEsc(item.label.split('/').pop().split('?')[0] || item.label)}</div>
        </div>`;

    function paint() {
        const q = (body.querySelector('#qi-search').value || '').toLowerCase();
        const type = body.querySelector('#qi-type').value;
        grid.innerHTML = items.map((it, i) => ({ it, i }))
            .filter(({ it }) => type === 'all' || it.kind === type)
            .filter(({ it }) => !q || it.label.toLowerCase().includes(q))
            .map(({ it, i }) => cardHtml(it, i)).join('') || '<div class="qa-empty">No matches.</div>';

        grid.querySelectorAll('.qa-img-check input').forEach((cb) => {
            const i = Number(cb.dataset.i);
            cb.checked = picked.has(i);
            cb.addEventListener('change', () => {
                if (cb.checked) picked.add(i); else picked.delete(i);
                syncBar();
            });
        });
        grid.querySelectorAll('.qa-img-get').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const i = Number(btn.dataset.i);
                btn.disabled = true;
                const result = await imageItemToBlob(items[i]).catch(() => null);
                btn.disabled = false;
                if (!result) { alert('Could not download this image (blocked by the site)'); return; }
                downloadBlob(result.blob, imageItemFilename(items[i], i).replace(/\.[a-zA-Z0-9]+$/, '') + '.' + result.ext);
            });
        });
        syncBar();
    }

    body.querySelector('#qi-search').addEventListener('input', paint);
    body.querySelector('#qi-type').addEventListener('change', paint);

    selectAllEl.addEventListener('change', () => {
        const visibleIs = [...grid.querySelectorAll('.qa-img-card')].map((c) => Number(c.dataset.i));
        if (selectAllEl.checked) visibleIs.forEach((i) => picked.add(i));
        else visibleIs.forEach((i) => picked.delete(i));
        paint();
    });

    downloadBtn.addEventListener('click', async () => {
        const ids = [...picked];
        downloadBtn.disabled = true;
        for (let n = 0; n < ids.length; n++) {
            downloadBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${n + 1}/${ids.length}…`;
            const i = ids[n];
            const result = await imageItemToBlob(items[i]).catch(() => null);
            if (result) downloadBlob(result.blob, imageItemFilename(items[i], i).replace(/\.[a-zA-Z0-9]+$/, '') + '.' + result.ext);
            // Give the browser's own download queue a moment to keep up (same
            // delay the capture gallery's bulk download already relies on).
            await new Promise((r) => setTimeout(r, 250));
        }
        downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download';
        downloadBtn.disabled = picked.size === 0;
    });

    paint();
}

// Custom on-page confirm dialog (replaces the browser's window.confirm).
// Returns a Promise<boolean>.
function qaConfirm(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const old = document.getElementById('qa-confirm'); if (old) old.remove();
        const o = document.createElement('div');
        o.id = 'qa-confirm';
        o.innerHTML = `
            <style>
                #qa-confirm { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
                    background: rgba(0,0,0,0.55); direction: ltr; font-family: 'Segoe UI', Arial, sans-serif; animation: qac-fade .15s ease-out; }
                @keyframes qac-fade { from { opacity: 0; } to { opacity: 1; } }
                #qa-confirm .qac-box { width: 340px; max-width: 90vw; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; box-shadow: 0 12px 50px rgba(0,0,0,0.6); padding: 20px; color: #fff; }
                #qa-confirm .qac-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
                #qa-confirm .qac-msg { font-size: 13px; color: #cbd5e1; line-height: 1.6; }
                #qa-confirm .qac-btns { display: flex; gap: 10px; margin-top: 18px; }
                #qa-confirm .qac-btns button { flex: 1; border: none; border-radius: 9px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
                #qa-confirm .qac-cancel { background: rgba(255,255,255,0.1); color: #e2e8f0; }
                #qa-confirm .qac-cancel:hover { background: rgba(255,255,255,0.18); }
                #qa-confirm .qac-ok { color: #1a1a1a; background: linear-gradient(135deg, ${opts.danger ? '#fbbf24, #f59e0b' : '#a78bfa, #8b5cf6'}); }
                #qa-confirm .qac-ok:hover { filter: brightness(1.08); }
            </style>
            <div class="qac-box">
                <div class="qac-title">${opts.danger ? '&#9888;&#65039; ' : ''}${qaEsc(opts.title || 'Are you sure?')}</div>
                <div class="qac-msg">${qaEsc(message)}</div>
                <div class="qac-btns">
                    <button class="qac-cancel">${qaEsc(opts.cancelText || 'Cancel')}</button>
                    <button class="qac-ok">${qaEsc(opts.confirmText || 'Confirm')}</button>
                </div>
            </div>`;
        document.body.appendChild(o);
        const done = (v) => { o.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
        const onKey = (e) => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); };
        document.addEventListener('keydown', onKey, true);
        o.querySelector('.qac-cancel').addEventListener('click', () => done(false));
        o.querySelector('.qac-ok').addEventListener('click', () => done(true));
        o.addEventListener('click', (e) => { if (e.target === o) done(false); });
        o.querySelector('.qac-ok').focus();
    });
}

// ---- Clear browsing data: runs from the floating button using the options
// saved in Settings (no per-click panel). ----
const CLEAR_DEFAULT = {
    activeTab: true, span: 0, reload: true, confirm: false,
    types: { cache: true, cacheStorage: true, cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, fileSystems: false, webSQL: false, downloads: false, formData: false, history: false, passwords: false }
};
const CLEAR_ORIGIN_SCOPED = ['cookies', 'localStorage', 'indexedDB', 'cacheStorage', 'serviceWorkers', 'fileSystems', 'webSQL'];

function doClearData() {
    chrome.storage.local.get('qaClearData', (res) => {
        const cfg = Object.assign({}, CLEAR_DEFAULT, res && res.qaClearData ? res.qaClearData : {});
        cfg.types = Object.assign({}, CLEAR_DEFAULT.types, cfg.types || {});
        const scope = cfg.activeTab ? 'site' : 'all';
        // "Active tab only" blocks the privacy-sensitive global types (cache is still
        // allowed — it clears all-sites cache, paired with the bypass-cache reload).
        const SITE_DISABLED = ['downloads', 'formData', 'history', 'passwords'];
        let types = Object.keys(cfg.types).filter(k => cfg.types[k]);
        if (scope === 'site') types = types.filter(k => !SITE_DISABLED.includes(k));
        if (!types.length) { showFabAiStatus('error', 'No data types selected — open Settings'); return; }
        let host = ''; try { host = new URL(location.href).host; } catch (e) { }
        const target = scope === 'site' ? (host || 'this site') : 'ALL sites';

        const run = () => {
            showFabAiStatus('loading', 'Clearing data…');
            const since = cfg.span ? Date.now() - cfg.span : 0;
            chrome.runtime.sendMessage({ action: 'clearBrowsingData', dataTypes: types, since, scope, origin: location.origin, autoReload: cfg.reload }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.success) {
                    showFabAiStatus('error', 'Clear failed: ' + ((resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'error'));
                } else {
                    showFabAiStatus('success', 'Data cleared' + (cfg.reload ? ' — reloading…' : ''));
                }
            });
        };

        if (cfg.confirm) {
            qaConfirm(`This will clear ${types.length} data type(s) for ${target}. This can't be undone.`,
                { title: 'Clear browsing data?', confirmText: 'Clear now', danger: true }).then(ok => { if (ok) run(); });
        } else {
            run();
        }
    });
}

// ---- Cookies & Storage viewer/editor: cookies (via chrome.cookies, includes
// httpOnly), localStorage and sessionStorage for the current site. ----
let stSection = 'cookies';
let stCookies = [];
let stFilter = '';
let stCookieRefreshTimer = null;
function stGetStore() { return stSection === 'session' ? sessionStorage : localStorage; }

function stQueueCookieRefresh() {
    clearTimeout(stCookieRefreshTimer);
    stCookieRefreshTimer = setTimeout(() => {
        stCookieRefreshTimer = null;
        if (stSection === 'cookies' && document.getElementById('qa-storage')) stRefresh(true);
    }, 150);
}

const ST_IC = (() => {
    const w = (p) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    return {
        x: w('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        check: w('<path d="M20 6 9 17l-5-5"/>'),
        copy: w('<rect width="12" height="12" x="9" y="9" rx="2"/><path d="M5 15c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2"/>'),
        down: w('<path d="m6 9 6 6 6-6"/>'),
        reload: w('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
        exp: w('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
        imp: w('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>'),
        trash: w('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>')
    };
})();

// after a mutation-triggered reload, bring the panel back automatically
try {
    const rr = sessionStorage.getItem('qa-st-reopen');
    if (rr) {
        sessionStorage.removeItem('qa-st-reopen');
        const d = JSON.parse(rr);
        stSection = d.sec || 'cookies';
        setTimeout(() => { if (!document.getElementById('qa-storage')) openStoragePanel(); }, 350);
    }
} catch (e) { }

function openStoragePanel() {
    const old = document.getElementById('qa-storage'); if (old) { old.remove(); return; }
    qaCancelAllTools();
    const panel = document.createElement('div');
    panel.id = 'qa-storage';
    panel.innerHTML = `
        <style>
            #qa-storage { position: fixed; top: 16px; right: 16px; width: 480px; max-width: calc(100vw - 32px); max-height: 88vh; z-index: 2147483647; display: flex; flex-direction: column; direction: ltr; text-align: left;
                background: #17151f; border: 1px solid #2a2738; border-radius: 14px; box-shadow: 0 14px 44px rgba(0,0,0,0.6); color: #e5e7eb; font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 13px; overflow: hidden; }
            #qa-storage * { box-sizing: border-box; }
            #qa-storage button { min-width: 0 !important; margin: 0; line-height: 1 !important; text-transform: none !important; }
            #qa-storage .st-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 13px; background: #1c1a26; border-bottom: 1px solid #2a2738; cursor: move; user-select: none; }
            #qa-storage .st-title { font-weight: 600; font-size: 13px; color: #fff; }
            #qa-storage .st-head .qa-minbtn, #qa-storage .st-close { background: rgba(255,255,255,0.08); border: none; color: #e5e7eb; cursor: pointer; width: 26px !important; min-width: 26px !important; max-width: 26px !important; height: 26px !important; min-height: 26px !important; padding: 0 !important; border-radius: 6px; font-size: 13px; display: inline-flex !important; align-items: center !important; justify-content: center !important; flex: 0 0 26px !important; }
            #qa-storage .st-close:hover { background: #3a1d24; color: #f87171; }
            #qa-storage .st-tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
            #qa-storage .st-tab { flex: 1; background: #1d1a28; border: 1px solid transparent; color: #a9a6b8; border-radius: 8px; padding: 7px 6px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
            #qa-storage .st-tab.on { background: rgba(124,58,237,0.18); border-color: #7c3aed; color: #fff; }
            #qa-storage .st-tab b { font-weight: 600; color: #a78bfa; }
            #qa-storage .st-tools { display: flex; gap: 6px; padding: 10px 12px 0; align-items: center; }
            #qa-storage .st-search { flex: 1; background: #0f0e16; border: 1px solid #2a2738; border-radius: 8px; color: #fff; padding: 7px 10px; font-size: 12px; outline: none; }
            #qa-storage .st-search:focus { border-color: #7c3aed; }
            #qa-storage .st-tools button { background: #1d1a28; border: 1px solid #2a2738; color: #a9a6b8; cursor: pointer; width: 30px !important; min-width: 30px !important; max-width: 30px !important; height: 30px !important; min-height: 30px !important; padding: 0 !important; margin: 0 !important; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 30px !important; }
            #qa-storage .st-tools button:hover { background: #262335; color: #fff; }
            #qa-storage .st-tools button.st-clear:hover { background: #3a1d24; color: #f87171; border-color: #7f1d1d; }
            #qa-storage .st-add { display: flex; gap: 6px; padding: 10px 12px; }
            #qa-storage .st-add input { background: #0f0e16; border: 1px solid #2a2738; border-radius: 8px; color: #fff; padding: 7px 9px; font-size: 12px; outline: none; }
            #qa-storage .st-add input:focus { border-color: #7c3aed; }
            #qa-storage .st-add .st-ak { width: 36%; } #qa-storage .st-add .st-av { flex: 1; }
            #qa-storage .st-add button { background: #7c3aed; border: none; color: #fff; font-weight: 600; border-radius: 8px; padding: 0 13px; cursor: pointer; font-family: inherit; }
            #qa-storage .st-add button:hover { background: #6d28d9; }
            #qa-storage .st-body { overflow-y: auto; padding: 0 12px 12px; }
            #qa-storage .st-row { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; padding: 7px 0; border-bottom: 1px solid #221f2e; }
            #qa-storage .st-k { flex: 0 1 34%; width: 34%; min-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
            #qa-storage .st-k .st-flags { display: block; color: #f59e0b; font-size: 9px; font-weight: 700; }
            #qa-storage .st-v { flex: 1; min-width: 0; background: #0f0e16; border: 1px solid #2a2738; border-radius: 6px; color: #e5e7eb; padding: 6px 7px; font: 11.5px Consolas, monospace; outline: none; }
            #qa-storage .st-v:focus { border-color: #7c3aed; }
            #qa-storage .st-row button { background: #1d1a28; border: 1px solid #2a2738; color: #8b8898; cursor: pointer; width: 24px !important; min-width: 24px !important; max-width: 24px !important; height: 24px !important; min-height: 24px !important; padding: 0 !important; margin: 0 !important; border-radius: 6px; flex: 0 0 24px !important; display: inline-flex; align-items: center; justify-content: center; }
            #qa-storage .st-row button:hover { background: #262335; color: #fff; }
            #qa-storage .st-row button.st-del:hover { color: #f87171; background: #3a1d24; }
            #qa-storage .st-row button.st-exp.on { color: #a78bfa; border-color: #7c3aed; }
            #qa-storage .st-empty { text-align: center; color: #6b6878; padding: 26px 8px; }
            #qa-storage .st-detail { background: #110f18; border: 1px solid #2a2738; border-radius: 8px; margin: 6px 0; padding: 10px; font-size: 11.5px; }
            #qa-storage .st-detail .st-dl { color: #8b8898; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; margin: 8px 0 3px; }
            #qa-storage .st-detail .st-dl:first-child { margin-top: 0; }
            #qa-storage .st-detail pre { margin: 0; background: #0f0e16; border: 1px solid #262335; border-radius: 6px; padding: 7px; max-height: 150px; overflow: auto; font: 11px Consolas, monospace; color: #c4b5fd; white-space: pre-wrap; word-break: break-all; }
            #qa-storage .st-detail .st-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
            #qa-storage .st-detail input[type=text], #qa-storage .st-detail input[type=datetime-local], #qa-storage .st-detail select { width: 100%; background: #0f0e16; border: 1px solid #2a2738; border-radius: 6px; color: #fff; padding: 5px 7px; font-size: 11.5px; outline: none; font-family: inherit; }
            #qa-storage .st-detail .st-chk { display: flex; align-items: center; gap: 5px; color: #a9a6b8; font-size: 11.5px; }
            #qa-storage .st-detail .st-chk input { accent-color: #7c3aed; }
            #qa-storage .st-detail .st-apply { margin-top: 9px; width: 100%; background: #7c3aed; border: none; color: #fff; font-weight: 600; border-radius: 7px; padding: 7px; cursor: pointer; font-family: inherit; }
            #qa-storage .st-detail .st-apply:hover { background: #6d28d9; }
        </style>
        <div class="st-head"><span class="st-title">Cookies &amp; Storage</span><button class="st-close" id="st-close" title="Close">&#10005;</button></div>
        <div class="st-tabs">
            <button class="st-tab" data-sec="cookies">Cookies <b id="st-n-cookies"></b></button>
            <button class="st-tab" data-sec="local">Local <b id="st-n-local"></b></button>
            <button class="st-tab" data-sec="session">Session <b id="st-n-session"></b></button>
        </div>
        <div class="st-tools">
            <input class="st-search" id="st-search" placeholder="Search keys & values…" spellcheck="false">
            <button id="st-refresh" title="Refresh">${ST_IC.reload}</button>
            <button id="st-export" title="Export this section as JSON">${ST_IC.exp}</button>
            <button id="st-import" title="Import JSON into this section">${ST_IC.imp}</button>
            <button id="st-clearall" class="st-clear" title="Delete everything in this section">${ST_IC.trash}</button>
            <input type="file" id="st-file" accept=".json,application/json" style="display:none;">
        </div>
        <div class="st-add">
            <input class="st-ak" placeholder="name / key"><input class="st-av" placeholder="value"><button id="st-add">Add</button>
        </div>
        <div class="st-body" id="st-body"></div>`;
    document.body.appendChild(panel);

    panel.querySelector('#st-close').addEventListener('click', () => panel.remove());
    qaAddMinimize(panel, panel.querySelector('.st-head'), panel.querySelector('#st-close'));
    panel.querySelectorAll('.st-tab').forEach(b => b.addEventListener('click', () => { stSection = b.dataset.sec; stRefresh(); }));
    panel.querySelector('#st-add').addEventListener('click', stAdd);
    panel.querySelector('#st-search').addEventListener('input', (e) => { stFilter = e.target.value.toLowerCase(); stRefresh(false); });
    panel.querySelector('#st-refresh').addEventListener('click', () => stRefresh());
    panel.querySelector('#st-export').addEventListener('click', stExport);
    panel.querySelector('#st-import').addEventListener('click', () => panel.querySelector('#st-file').click());
    panel.querySelector('#st-file').addEventListener('change', stImport);
    panel.querySelector('#st-clearall').addEventListener('click', stClearAll);

    panel.querySelector('#st-body').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-st]'); if (!btn) return;
        const row = btn.closest('.st-row');
        const key = row.dataset.k;
        if (btn.dataset.st === 'save') stSave(key, row.querySelector('.st-v').value);
        else if (btn.dataset.st === 'del') stDelete(key);
        else if (btn.dataset.st === 'copy') {
            navigator.clipboard.writeText(row.querySelector('.st-v').value).then(() => stToast('Value copied'));
        }
        else if (btn.dataset.st === 'exp') stToggleDetail(row, btn);
    });
    panel.querySelector('#st-body').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('st-v')) { const row = e.target.closest('.st-row'); stSave(row.dataset.k, e.target.value); }
    });

    // drag by header
    (function () {
        const head = panel.querySelector('.st-head'); let sx, sy, sl, st;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.button !== 0) return;
            const r = panel.getBoundingClientRect(); panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.style.right = 'auto';
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top; e.preventDefault();
            const mv = (ev) => { panel.style.left = Math.max(0, Math.min(sl + ev.clientX - sx, innerWidth - panel.offsetWidth)) + 'px'; panel.style.top = Math.max(0, Math.min(st + ev.clientY - sy, innerHeight - 40)) + 'px'; };
            const up = () => { document.removeEventListener('mousemove', mv, true); document.removeEventListener('mouseup', up, true); };
            document.addEventListener('mousemove', mv, true); document.addEventListener('mouseup', up, true);
        });
    })();

    stRefresh();
}

function stCounts() {
    const p = document.getElementById('qa-storage'); if (!p) return;
    p.querySelector('#st-n-cookies').textContent = `(${stCookies.length})`;
    try { p.querySelector('#st-n-local').textContent = `(${localStorage.length})`; } catch (e) { }
    try { p.querySelector('#st-n-session').textContent = `(${sessionStorage.length})`; } catch (e) { }
}

function stRefresh(reloadCookies = true) {
    const panel = document.getElementById('qa-storage'); if (!panel) return;
    panel.querySelectorAll('.st-tab').forEach(b => b.classList.toggle('on', b.dataset.sec === stSection));
    if (stSection === 'cookies') {
        if (!reloadCookies) { stRenderCookieRows(); return; }
        chrome.runtime.sendMessage({ action: 'getCookies', url: location.href }, (resp) => {
            stCookies = (resp && resp.cookies) || [];
            stRenderCookieRows();
        });
    } else {
        const store = stGetStore(); const rows = [];
        for (let i = 0; i < store.length; i++) { const k = store.key(i); rows.push({ k, v: store.getItem(k), flags: '' }); }
        stRenderRows(rows);
    }
}

function stRenderCookieRows() {
    stRenderRows(stCookies.map(c => ({
        k: c.name, v: c.value,
        flags: [c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : '', c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : '', c.session ? 'Session' : ''].filter(Boolean).join(' · ')
    })));
}

function stRenderRows(rows) {
    stCounts();
    const body = document.getElementById('st-body'); if (!body) return;
    if (stFilter) rows = rows.filter(r => (r.k + ' ' + r.v).toLowerCase().includes(stFilter));
    if (!rows.length) { body.innerHTML = `<div class="st-empty">${stFilter ? 'No matches.' : 'Nothing stored here for this site.'}</div>`; return; }
    body.innerHTML = rows.map(r => `<div class="st-row" data-k="${qaEsc(r.k)}">
        <div class="st-k" title="${qaEsc(r.k)}">${qaEsc(r.k)}${r.flags ? `<span class="st-flags">${qaEsc(r.flags)}</span>` : ''}</div>
        <input class="st-v" value="${qaEsc(r.v)}">
        <button data-st="copy" title="Copy value">${ST_IC.copy}</button>
        <button data-st="exp" class="st-exp" title="Details">${ST_IC.down}</button>
        <button data-st="save" class="st-save" title="Save">${ST_IC.check}</button>
        <button data-st="del" class="st-del" title="Delete">${ST_IC.x}</button>
    </div>`).join('');
}

// value preview: pretty JSON, or a decoded JWT payload
function stValuePreview(v) {
    try { const j = JSON.parse(v); if (j && typeof j === 'object') return { label: 'JSON value', text: JSON.stringify(j, null, 2) }; } catch (e) { }
    if (/^[\w-]{8,}\.[\w-]{8,}\.[\w-]+$/.test((v || '').trim())) {
        try {
            const part = v.trim().split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const json = JSON.parse(decodeURIComponent(escape(atob(part))));
            return { label: 'JWT payload (decoded)', text: JSON.stringify(json, null, 2) };
        } catch (e) { }
    }
    return null;
}

function stToggleDetail(row, btn) {
    const open = row.nextElementSibling && row.nextElementSibling.classList.contains('st-detail');
    document.querySelectorAll('#qa-storage .st-detail').forEach(d => d.remove());
    document.querySelectorAll('#qa-storage .st-exp.on').forEach(b => b.classList.remove('on'));
    if (open) return;
    btn.classList.add('on');
    const key = row.dataset.k;
    const val = row.querySelector('.st-v').value;
    const prev = stValuePreview(val);
    let html = '';
    if (prev) html += `<div class="st-dl">${qaEsc(prev.label)}</div><pre>${qaEsc(prev.text)}</pre>`;
    if (stSection === 'cookies') {
        const c = stCookies.find(x => x.name === key);
        if (c) {
            const expVal = (!c.session && c.expirationDate) ? new Date(c.expirationDate * 1000).toISOString().slice(0, 16) : '';
            html += `<div class="st-dl">Cookie attributes</div>
            <div class="st-grid">
                <div><div class="st-dl">Domain</div><input type="text" data-cd="domain" value="${qaEsc(c.domain || '')}"></div>
                <div><div class="st-dl">Path</div><input type="text" data-cd="path" value="${qaEsc(c.path || '/')}"></div>
                <div><div class="st-dl">SameSite</div><select data-cd="sameSite">
                    ${['unspecified', 'lax', 'strict', 'no_restriction'].map(s => `<option value="${s}" ${c.sameSite === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select></div>
                <div><div class="st-dl">Expires</div><input type="datetime-local" data-cd="expires" value="${expVal}"></div>
            </div>
            <div class="st-grid" style="margin-top:7px;">
                <label class="st-chk"><input type="checkbox" data-cd="secure" ${c.secure ? 'checked' : ''}> Secure</label>
                <label class="st-chk"><input type="checkbox" data-cd="httpOnly" ${c.httpOnly ? 'checked' : ''}> HttpOnly</label>
                <label class="st-chk"><input type="checkbox" data-cd="session" ${c.session ? 'checked' : ''}> Session cookie</label>
            </div>
            <button class="st-apply">Apply attributes</button>`;
        }
    } else if (!prev) {
        html += `<div class="st-dl">Value</div><pre>${qaEsc(val)}</pre>`;
    }
    const d = document.createElement('div');
    d.className = 'st-detail';
    d.innerHTML = html || '<div class="st-empty" style="padding:8px;">No details.</div>';
    row.after(d);
    const apply = d.querySelector('.st-apply');
    if (apply) apply.addEventListener('click', () => {
        const c = stCookies.find(x => x.name === key); if (!c) return;
        const g = (sel) => d.querySelector(`[data-cd="${sel}"]`);
        const upd = Object.assign({}, c, {
            value: row.querySelector('.st-v').value,
            domain: g('domain').value.trim() || c.domain,
            path: g('path').value.trim() || '/',
            sameSite: g('sameSite').value,
            secure: g('secure').checked,
            httpOnly: g('httpOnly').checked,
            session: g('session').checked,
            hostOnly: !(g('domain').value.trim().startsWith('.'))
        });
        if (!upd.session) {
            const ex = g('expires').value;
            upd.expirationDate = ex ? Math.floor(new Date(ex).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400 * 365;
        } else delete upd.expirationDate;
        // domain/path/flags form the cookie's identity - remove the old one first
        chrome.runtime.sendMessage({ action: 'removeCookie', cookie: c }, () => {
            chrome.runtime.sendMessage({ action: 'setCookie', cookie: upd }, (r) => {
                if (r && r.success) stMutated('Cookie updated — reloading…');
                else { stToast('Failed: ' + ((r && r.error) || 'error')); stRefresh(); }
            });
        });
    });
}

function stExport() {
    let data, name;
    if (stSection === 'cookies') { data = stCookies; name = `cookies-${location.hostname}.json`; }
    else {
        const store = stGetStore(); const obj = {};
        for (let i = 0; i < store.length; i++) { const k = store.key(i); obj[k] = store.getItem(k); }
        data = obj; name = `${stSection}Storage-${location.hostname}.json`;
    }
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    stToast('Exported');
}

function stImport(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
        let data; try { data = JSON.parse(rd.result); } catch (err) { stToast('Invalid JSON file'); return; }
        if (stSection === 'cookies') {
            const list = Array.isArray(data) ? data : [];
            if (!list.length) { stToast('No cookies in the file'); return; }
            let done = 0;
            list.forEach(c => {
                if (!c || !c.name) { if (++done === list.length) stRefresh(); return; }
                chrome.runtime.sendMessage({ action: 'setCookie', cookie: Object.assign({ domain: location.hostname, path: '/', hostOnly: true, secure: location.protocol === 'https:' }, c) },
                    () => { if (++done === list.length) stMutated(`Imported ${list.length} cookie(s) — reloading…`); });
            });
        } else {
            if (!data || typeof data !== 'object' || Array.isArray(data)) { stToast('Expected a JSON object { key: value }'); return; }
            let n = 0;
            try { for (const k of Object.keys(data)) { stGetStore().setItem(k, typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); n++; } } catch (err) { }
            stMutated(`Imported ${n} item(s) — reloading…`);
        }
    };
    rd.readAsText(file);
}

function stClearAll() {
    const label = stSection === 'cookies' ? `all ${stCookies.length} cookie(s)` : `all ${stGetStore().length} item(s)`;
    qaConfirm(`Delete ${label} for this site?`).then((ok) => {
        if (!ok) return;
        if (stSection === 'cookies') {
            let done = 0; const list = stCookies.slice();
            if (!list.length) return;
            list.forEach(c => chrome.runtime.sendMessage({ action: 'removeCookie', cookie: c }, () => { if (++done === list.length) stMutated('Cleared — reloading…'); }));
        } else { try { stGetStore().clear(); } catch (e) { } stMutated('Cleared — reloading…'); }
    });
}

function stSave(key, value) {
    if (stSection === 'cookies') {
        const c = stCookies.find(x => x.name === key); if (!c) return;
        chrome.runtime.sendMessage({ action: 'setCookie', cookie: Object.assign({}, c, { value }) }, () => stMutated('Saved — reloading…'));
    } else {
        try { stGetStore().setItem(key, value); stMutated('Saved — reloading…'); } catch (e) { stToast('Failed: ' + e.message); }
    }
}
function stDelete(key) {
    if (stSection === 'cookies') {
        const c = stCookies.find(x => x.name === key); if (!c) return;
        chrome.runtime.sendMessage({ action: 'removeCookie', cookie: c }, () => stMutated('Deleted — reloading…'));
    } else {
        try { stGetStore().removeItem(key); } catch (e) { } stMutated('Deleted — reloading…');
    }
}
function stAdd() {
    const panel = document.getElementById('qa-storage'); if (!panel) return;
    const k = panel.querySelector('.st-ak').value.trim(); const v = panel.querySelector('.st-av').value;
    if (!k) { panel.querySelector('.st-ak').style.borderColor = '#ef4444'; return; }
    if (stSection === 'cookies') {
        const host = location.hostname;
        chrome.runtime.sendMessage({ action: 'setCookie', cookie: { name: k, value: v, path: '/', domain: host, hostOnly: true, secure: location.protocol === 'https:' } }, () => stMutated('Added — reloading…'));
    } else {
        try { stGetStore().setItem(k, v); } catch (e) { } stMutated('Added — reloading…');
    }
}
// Any storage/cookie change should take effect on the SITE too: reload the
// page shortly after the action, and re-open this panel automatically.
function stMutated(msg) {
    if (msg) stToast(msg);
    try { sessionStorage.setItem('qa-st-reopen', JSON.stringify({ sec: stSection })); } catch (e) { }
    setTimeout(() => location.reload(), 650);
}

function stToast(msg) {
    const old = document.getElementById('st-toast'); if (old) old.remove();
    const t = document.createElement('div'); t.id = 'st-toast'; t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e1b2e;color:#fff;padding:9px 16px;border-radius:8px;font:13px -apple-system,Segoe UI,Arial;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.4);';
    document.body.appendChild(t); setTimeout(() => t.remove(), 1400);
}

// ---- Responsive Viewer: full-screen overlay with customizable workspace tabs,
// custom devices, and saved settings. Device iframes load this same page
// (same-origin) so cookies/login work and it renders like the browser. ----
const RV_BUILTIN = [
    { name: 'iPhone SE', w: 375, h: 667 }, { name: 'iPhone 14 Pro', w: 393, h: 852 },
    { name: 'iPhone 14 Pro Max', w: 430, h: 932 }, { name: 'Pixel 7', w: 412, h: 915 },
    { name: 'Galaxy S20', w: 360, h: 800 }, { name: 'Surface Duo', w: 540, h: 720 },
    { name: 'iPad Mini', w: 768, h: 1024 }, { name: 'iPad Pro 11"', w: 834, h: 1194 },
    { name: 'iPad Pro 12.9"', w: 1024, h: 1366 }, { name: 'Laptop', w: 1280, h: 800 },
    { name: 'Desktop', w: 1440, h: 900 }, { name: 'Full HD', w: 1920, h: 1080 }
];
const RV_STORE = 'qaResponsive';
let rvState = null;
let rvSyncing = false, rvClicking = false;

// Inline SVG icons (Font Awesome isn't available inside the page).
const rvIco = (p, s) => `<svg width="${s || 13}" height="${s || 13}" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;">${p}</svg>`;
const RV_ICON = {
    mobile: rvIco('<path d="M7 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H7zm0 2h10v14H7V4zm3.5 15h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1z"/>', 15),
    reload: rvIco('<path d="M17.65 6.35A8 8 0 1 0 19.74 14h-2.08A6 6 0 1 1 16.24 7.76L13 11h7V4z"/>'),
    // Screen-rotation glyph (a device turning), NOT a circular arrow - the old curved
    // arrow was too close to the reload icon and the two got confused.
    rotate: rvIco('<path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zM10.23 1.75c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zM7.52 21.48C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/>'),
    link: rvIco('<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM13 7v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10zm-5 4h8v2H8z"/>'),
    touch: rvIco('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-6a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/>'),
    camera: rvIco('<path d="M9 3 7.5 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>'),
    eye: rvIco('<path d="M12 5C5 5 2 12 2 12s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>'),
    close: rvIco('<path d="M18.3 5.7 12 12l6.3 6.3-1.3 1.4L10.6 13.4 4.3 19.7 3 18.3 9.2 12 3 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/>', 12),
    gear: rvIco('<path d="M19.14 12.94a7.5 7.5 0 0 0 .05-1.88l2-1.56a.5.5 0 0 0 .12-.64l-1.9-3.28a.5.5 0 0 0-.6-.22l-2.36.95a7.3 7.3 0 0 0-1.62-.94l-.36-2.5a.5.5 0 0 0-.5-.42h-3.8a.5.5 0 0 0-.5.42l-.36 2.5a7.3 7.3 0 0 0-1.62.94l-2.36-.95a.5.5 0 0 0-.6.22L2.6 8.86a.5.5 0 0 0 .12.64l2 1.56a7.5 7.5 0 0 0 0 1.88l-2 1.56a.5.5 0 0 0-.12.64l1.9 3.28a.5.5 0 0 0 .6.22l2.36-.95c.5.38 1.04.7 1.62.94l.36 2.5a.5.5 0 0 0 .5.42h3.8a.5.5 0 0 0 .5-.42l.36-2.5a7.3 7.3 0 0 0 1.62-.94l2.36.95a.5.5 0 0 0 .6-.22l1.9-3.28a.5.5 0 0 0-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>')
};

function rvDefaultState() {
    const s = { tabs: [], active: 1, nextTab: 1, nextScreen: 1, custom: [], zoom: 0.5, ua: 'desktop', mockup: false, layout: 'row', sync: true, touch: true, outline: false, grid: false, ruler: false, hideScroll: true };
    const mk = (name) => { const d = RV_BUILTIN.find(x => x.name === name); return { id: s.nextScreen++, name: d.name, w: d.w, h: d.h, rotated: false }; };
    s.tabs = [
        { id: s.nextTab++, name: 'Mobile', screens: [mk('iPhone 14 Pro'), mk('Pixel 7')] },
        { id: s.nextTab++, name: 'Tablet', screens: [mk('iPad Mini')] },
        { id: s.nextTab++, name: 'Desktop', screens: [mk('Laptop')] }
    ];
    s.active = s.tabs[0].id;
    return s;
}
function rvSave() {
    if (!rvState) return;
    const { url, isolated, ...persist } = rvState; // url & isolated are per-session
    try { chrome.storage.local.set({ [RV_STORE]: persist }); } catch (e) { }
}
function rvLibrary() { return RV_BUILTIN.concat(rvState.custom || []); }
function rvActiveTab() { return rvState.tabs.find(t => t.id === rvState.active) || rvState.tabs[0]; }


function openResponsiveOverlay() {
    const old = document.getElementById('qa-rv'); if (old) old.remove();
    qaCancelAllTools();
    chrome.storage.local.get(RV_STORE, (res) => {
        const saved = res && res[RV_STORE];
        rvState = saved && saved.tabs && saved.tabs.length ? Object.assign(rvDefaultState(), saved) : rvDefaultState();
        // migrate: guarantee UNIQUE screen ids (old saves could collide)
        let nid = 1;
        rvState.tabs.forEach(t => (t.screens || []).forEach(s => { s.id = nid++; }));
        rvState.nextScreen = nid;
        rvState.isolated = null;
        rvState.url = location.href;
        rvState.isolated = null;
        rvState.outline = rvState.grid = rvState.ruler = false; // hidden for now
        if (!rvState.tabs.some(t => t.id === rvState.active)) rvState.active = rvState.tabs[0].id;
        rvBuildOverlay();
    });
}

let rvPrevOverflow = '';
function rvBuildOverlay() {
    chrome.runtime.sendMessage({ action: 'responsiveDnr', enable: true, ua: rvState.ua }).catch(() => { });
    rvPrevOverflow = document.documentElement.style.overflow; // hide the page's own scrollbar behind the overlay
    document.documentElement.style.overflow = 'hidden';
    const o = document.createElement('div');
    o.id = 'qa-rv';
    o.innerHTML = `
        <style>
            #qa-rv { --rv-bg:#0a0d14; --rv-panel:#111623; --rv-panel2:#0d111b; --rv-surface:#1a2130; --rv-surface-h:#232c3f;
                --rv-border:#232c3d; --rv-text:#e6eaf2; --rv-sub:#95a1b6; --rv-muted:#5f6b80; --rv-accent:#6366f1; --rv-accent-2:#818cf8;
                position: fixed; inset: 0; z-index: 2147483647; background: var(--rv-bg); color: var(--rv-text); direction: ltr; text-align: left;
                font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; display: flex; flex-direction: column; font-size: 12.5px; }
            #qa-rv * { box-sizing: border-box; }
            /* ---- top bar ---- */
            #qa-rv .rv-bar { display: flex; align-items: center; gap: 7px; padding: 9px 14px; background: var(--rv-panel); border-bottom: 1px solid var(--rv-border); flex-wrap: wrap; flex-shrink: 0; }
            #qa-rv .rv-brand { font-weight: 700; font-size: 13px; color: #fff; display: flex; align-items: center; gap: 8px; padding-right: 6px; letter-spacing: .2px; }
            #qa-rv .rv-brand svg { color: var(--rv-accent-2); }
            #qa-rv .rv-sep { width: 1px; height: 20px; background: var(--rv-border); margin: 0 4px; flex-shrink: 0; }
            #qa-rv .rv-url { flex: 1; min-width: 190px; display: flex; gap: 6px; }
            #qa-rv .rv-url input { flex: 1; background: var(--rv-panel2); border: 1px solid var(--rv-border); border-radius: 10px; color: #fff; padding: 0 13px; height: 34px; font-size: 12.5px; outline: none; transition: border-color .15s, box-shadow .15s; }
            #qa-rv .rv-url input:focus { border-color: var(--rv-accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.18); }
            #qa-rv .rv-btn { background: var(--rv-surface); border: 1px solid var(--rv-border); color: var(--rv-text); border-radius: 10px; padding: 0 12px; height: 34px; font-size: 12.5px; cursor: pointer; white-space: nowrap; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; transition: background .15s, border-color .15s, color .15s; }
            #qa-rv .rv-btn:hover { background: var(--rv-surface-h); border-color: #33405a; color: #fff; }
            #qa-rv .rv-btn.ic { width: 34px; padding: 0; justify-content: center; color: var(--rv-sub); }
            #qa-rv .rv-btn.ic:hover { color: #fff; }
            #qa-rv .rv-btn.go { background: linear-gradient(135deg, var(--rv-accent), #8b5cf6); border-color: transparent; color: #fff; font-weight: 600; }
            #qa-rv .rv-btn.go:hover { filter: brightness(1.1); }
            #qa-rv .rv-btn.on { background: rgba(99,102,241,0.22); border-color: var(--rv-accent); color: #fff; box-shadow: inset 0 0 0 1px rgba(99,102,241,0.4); }
            #qa-rv .rv-btn.close:hover { background: rgba(239,68,68,0.16); border-color: rgba(239,68,68,0.5); color: #f87171; }
            #qa-rv select.rv-sel { background: var(--rv-surface); border: 1px solid var(--rv-border); color: var(--rv-text); border-radius: 10px; padding: 0 9px; height: 34px; font-size: 12.5px; outline: none; cursor: pointer; font-family: inherit; transition: background .15s, border-color .15s; }
            #qa-rv select.rv-sel:hover { background: var(--rv-surface-h); border-color: #33405a; }
            #qa-rv select.rv-sel option { background: var(--rv-panel); color: #fff; }
            #qa-rv .rv-zoomwrap { display: inline-flex; align-items: center; background: var(--rv-surface); border: 1px solid var(--rv-border); border-radius: 10px; height: 34px; padding: 0 9px 0 5px; }
            #qa-rv .rv-zoomwrap input { width: 40px; background: none; border: none; color: #fff; font-size: 12.5px; outline: none; text-align: right; font-family: inherit; font-variant-numeric: tabular-nums; }
            #qa-rv .rv-zoomwrap b { color: var(--rv-muted); font-weight: 400; font-size: 12px; }
            /* ---- tabs ---- */
            #qa-rv .rv-tabs { display: flex; align-items: center; gap: 6px; padding: 8px 14px; background: var(--rv-panel2); border-bottom: 1px solid var(--rv-border); flex-shrink: 0; overflow-x: auto; }
            #qa-rv .rv-tab { display: flex; align-items: center; gap: 7px; background: var(--rv-surface); border: 1px solid transparent; color: var(--rv-sub); border-radius: 9px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
            #qa-rv .rv-tab:hover { color: #fff; background: var(--rv-surface-h); }
            #qa-rv .rv-tab.active { background: rgba(99,102,241,0.16); border-color: var(--rv-accent); color: #fff; }
            #qa-rv .rv-tabname { outline: none; }
            #qa-rv .rv-tabname[contenteditable="true"] { background: rgba(255,255,255,0.12); border-radius: 4px; padding: 0 4px; }
            #qa-rv .rv-tabx, #qa-rv .rv-tabedit { background: none; border: none; color: var(--rv-muted); cursor: pointer; font-size: 12px; padding: 0 1px; transition: color .15s; }
            #qa-rv .rv-tabx { font-size: 14px; }
            #qa-rv .rv-tabx:hover { color: #f87171; }
            #qa-rv .rv-tabedit:hover { color: var(--rv-accent-2); }
            #qa-rv .rv-tabadd { background: var(--rv-surface); border: 1px solid var(--rv-border); color: var(--rv-sub); cursor: pointer; border-radius: 9px; width: 29px; height: 29px; font-size: 16px; flex-shrink: 0; transition: background .15s, color .15s; }
            #qa-rv .rv-tabadd:hover { background: var(--rv-surface-h); color: #fff; }
            /* ---- breakpoints ---- */
            /* Breakpoints live in a popover now (a dropdown off the toolbar button),
               not a long inline row. */
            #qa-rv .rv-bp-pop { position: absolute; z-index: 20; display: none; width: 300px; max-height: 300px; overflow-y: auto;
                background: var(--rv-panel); border: 1px solid var(--rv-border); border-radius: 12px; padding: 13px; box-shadow: 0 18px 46px rgba(0,0,0,0.55); }
            #qa-rv .rv-bp-pop.show { display: block; }
            #qa-rv .rv-bps-l { display: block; font-size: 10px; color: var(--rv-muted); text-transform: uppercase; letter-spacing: .7px; font-weight: 700; margin: 0 0 8px; }
            #qa-rv .rv-bps-l.dim { margin-top: 14px; }
            #qa-rv .rv-bp-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
            #qa-rv .rv-bp-empty { color: var(--rv-muted); font-size: 12px; }
            #qa-rv .rv-bp { background: var(--rv-surface); border: 1px solid var(--rv-border); color: var(--rv-sub); border-radius: 8px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-family: Consolas, monospace; font-variant-numeric: tabular-nums; transition: background .15s, color .15s, border-color .15s; }
            #qa-rv .rv-bp:hover { background: var(--rv-surface-h); color: #fff; }
            #qa-rv .rv-bp.det { border-color: rgba(99,102,241,0.5); color: var(--rv-accent-2); }
            #qa-rv .rv-bp.det:hover { background: rgba(99,102,241,0.18); color: #fff; }
            #qa-rv #rv-bp-caret { font-size: 9px; opacity: .7; }
            /* ---- stage ---- */
            #qa-rv .rv-iso { display: none; padding: 8px 14px; background: rgba(99,102,241,0.12); border-bottom: 1px solid rgba(99,102,241,0.3); font-size: 12px; color: var(--rv-accent-2); flex-shrink: 0; }
            #qa-rv .rv-stage { flex: 1; overflow: auto; padding: 26px; background:
                radial-gradient(circle at 1px 1px, rgba(255,255,255,0.028) 1px, transparent 0) 0 0 / 22px 22px, var(--rv-bg); }
            #qa-rv .rv-row { display: flex; gap: 26px; align-items: flex-start; min-width: min-content; }
            #qa-rv .rv-row.stack { flex-direction: column; align-items: center; }
            /* No overflow:hidden here - it clipped the options dropdown. The device name
               already truncates itself (.rv-fname). position+z-index lift the header (and
               its dropdown) above the sibling iframe, which would otherwise paint over it. */
            #qa-rv .rv-fhead { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--rv-text); position: relative; z-index: 3; }
            #qa-rv .rv-fname { font-weight: 600; font-size: 13px; color: #fff; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: grab; }
            #qa-rv .rv-fname:active { cursor: grabbing; }
            #qa-rv .rv-fdim { font-size: 10.5px; color: var(--rv-sub); font-family: Consolas, monospace; font-variant-numeric: tabular-nums; flex-shrink: 0; cursor: text; background: var(--rv-surface); border: 1px solid var(--rv-border); border-radius: 6px; padding: 2px 7px; }
            #qa-rv .rv-fdim:hover { color: #fff; border-color: #33405a; }
            #qa-rv .rv-fdim[contenteditable="true"] { background: rgba(99,102,241,0.16); border-color: var(--rv-accent); color: #fff; }
            #qa-rv .rv-fact { display: flex; gap: 4px; flex-shrink: 0; position: relative; }
            /* only the two top-level buttons (gear + remove) are square icon buttons */
            #qa-rv .rv-fact > button { background: var(--rv-surface); border: 1px solid var(--rv-border); color: var(--rv-sub); cursor: pointer; width: 27px; height: 25px; border-radius: 7px; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; transition: background .15s, color .15s, border-color .15s; }
            #qa-rv .rv-fact > button:hover { background: var(--rv-accent); border-color: var(--rv-accent); color: #fff; }
            #qa-rv .rv-fact > button[data-menu].open { background: var(--rv-accent); border-color: var(--rv-accent); color: #fff; }
            #qa-rv .rv-fact > button[data-act="remove"]:hover { background: #e0455e; border-color: #e0455e; }
            /* the options dropdown */
            #qa-rv .rv-fmenu { position: absolute; top: 30px; right: 0; z-index: 30; display: none; flex-direction: column; min-width: 210px; padding: 5px; background: var(--rv-panel2, #1a1f2e); border: 1px solid var(--rv-border); border-radius: 10px; box-shadow: 0 12px 34px rgba(0,0,0,.5); }
            #qa-rv .rv-fmenu.open { display: flex; }
            #qa-rv .rv-fmenu button { display: flex; align-items: center; gap: 9px; width: 100%; background: none; border: 0; color: var(--rv-sub); cursor: pointer; padding: 8px 9px; border-radius: 7px; font-size: 12.5px; text-align: left; transition: background .12s, color .12s; }
            #qa-rv .rv-fmenu button:hover { background: var(--rv-surface-h, rgba(255,255,255,.06)); color: #fff; }
            #qa-rv .rv-fmenu button svg { flex-shrink: 0; }
            #qa-rv .rv-fmenu button > span:first-of-type { flex: 1 1 auto; }
            #qa-rv .rv-screen { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 12px 34px rgba(0,0,0,0.5); }
            #qa-rv .rv-inner { overflow: hidden; position: relative; }
            #qa-rv .rv-screen iframe { border: 0; display: block; background: #fff; }
            #qa-rv .rv-grid { position: absolute; inset: 0; pointer-events: none; z-index: 3;
                background-image:
                    repeating-linear-gradient(to right, rgba(129,140,248,0.18) 0 1px, transparent 1px 20px),
                    repeating-linear-gradient(to bottom, rgba(129,140,248,0.18) 0 1px, transparent 1px 20px),
                    repeating-linear-gradient(to right, rgba(129,140,248,0.4) 0 1px, transparent 1px 100px),
                    repeating-linear-gradient(to bottom, rgba(129,140,248,0.4) 0 1px, transparent 1px 100px); }
            #qa-rv .rv-rt, #qa-rv .rv-rl { position: absolute; pointer-events: none; z-index: 4; background: rgba(10,13,20,0.85); color: var(--rv-accent-2); font: 9px/1 Consolas, monospace; }
            #qa-rv .rv-rt { top: 0; left: 0; right: 0; height: 14px; border-bottom: 1px solid rgba(255,255,255,0.15); }
            #qa-rv .rv-rl { top: 0; left: 0; bottom: 0; width: 22px; border-right: 1px solid rgba(255,255,255,0.15); }
            #qa-rv .rv-rt span { position: absolute; top: 2px; transform: translateX(2px); }
            #qa-rv .rv-rl span { position: absolute; left: 2px; }
            #qa-rv .rv-rt i, #qa-rv .rv-rl i { position: absolute; background: rgba(129,140,248,0.5); }
            #qa-rv .rv-rt i { top: 0; width: 1px; height: 5px; }
            #qa-rv .rv-rl i { left: 0; height: 1px; width: 5px; }
            #qa-rv .rv-screen.mock { background: #05060a; padding: 14px 8px; border-radius: 34px; box-shadow: 0 12px 38px rgba(0,0,0,0.6), inset 0 0 0 2px #222838; position: relative; }
            #qa-rv .rv-screen.mock .rv-inner { border-radius: 18px; }
            #qa-rv .rv-screen.mock::before { content:''; position:absolute; top:6px; left:50%; transform:translateX(-50%); width:44px; height:6px; background:#222838; border-radius:5px; }
            #qa-rv .rv-empty { color: var(--rv-muted); text-align: center; padding: 60px 20px; width: 100%; }
            /* ---- custom device dialog ---- */
            #qa-rv .rv-dlg { position: fixed; inset: 0; background: rgba(4,6,11,0.66); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 5; }
            #qa-rv .rv-dlg-box { background: var(--rv-panel); border: 1px solid var(--rv-border); border-radius: 16px; padding: 20px; width: 300px; box-shadow: 0 20px 54px rgba(0,0,0,0.6); }
            #qa-rv .rv-dlg-box h4 { margin: 0 0 14px; font-size: 14px; color: #fff; }
            #qa-rv .rv-dlg-box label { display: block; font-size: 11px; color: var(--rv-sub); margin: 8px 0 4px; }
            #qa-rv .rv-dlg-box input { width: 100%; background: var(--rv-panel2); border: 1px solid var(--rv-border); border-radius: 9px; color: #fff; padding: 9px 10px; font-size: 13px; outline: none; transition: border-color .15s, box-shadow .15s; }
            #qa-rv .rv-dlg-box input:focus { border-color: var(--rv-accent); box-shadow: 0 0 0 3px rgba(99,102,241,0.18); }
            #qa-rv .rv-dlg-row { display: flex; gap: 8px; }
            #qa-rv .rv-dlg-btns { display: flex; gap: 8px; margin-top: 18px; }
            #qa-rv .rv-dlg-btns button { flex: 1; border: none; border-radius: 9px; padding: 10px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
            #qa-rv .rv-cd-item { display: flex; align-items: center; justify-content: space-between; background: var(--rv-panel2); border: 1px solid var(--rv-border); border-radius: 9px; padding: 8px 11px; margin-bottom: 6px; font-size: 12.5px; }
            #qa-rv .rv-cd-item button { background: none; border: none; color: var(--rv-muted); cursor: pointer; font-size: 16px; transition: color .15s; }
            #qa-rv .rv-cd-item button:hover { color: #f87171; }
        </style>
        <div class="rv-bar">
            <span class="rv-brand">${RV_ICON.mobile} Responsive</span>
            <div class="rv-url"><input type="text" id="rv-url" spellcheck="false"><button class="rv-btn go" id="rv-go">Go</button></div>
            <span class="rv-sep"></span>
            <select class="rv-sel" id="rv-add" title="Add a device"><option value="">+ Add device</option></select>
            <button class="rv-btn" id="rv-bp-btn" title="Add a device at one of this page's breakpoints">Breakpoints <span id="rv-bp-caret">▾</span></button>
            <button class="rv-btn ic" id="rv-rotate" title="Rotate all devices">${RV_ICON.rotate}</button>
            <button class="rv-btn ic" id="rv-reload" title="Reload all devices">${RV_ICON.reload}</button>
            <span class="rv-sep"></span>
            <span class="rv-zoomwrap" title="Zoom %"><input type="number" id="rv-zoom" min="10" max="200" step="5"><b>%</b></span>
            <button class="rv-btn" id="rv-fit" title="Auto-zoom so every device fits in view">Fit</button>
            <span class="rv-sep"></span>
            <select class="rv-sel" id="rv-ua" title="User-Agent"><option value="desktop">UA: Desktop</option><option value="iphone">UA: iPhone</option><option value="android">UA: Android</option></select>
            <span class="rv-sep"></span>
            <button class="rv-btn" id="rv-mockup" title="Device frame">Mockup</button>
            <button class="rv-btn" id="rv-sync" title="Sync scroll, clicks & typing across devices">${RV_ICON.link} Sync</button>
            <button class="rv-btn" id="rv-scrollbar" title="Show/hide the scrollbar inside devices (on = shown)">Scrollbar</button>
            <span class="rv-sep"></span>
            <button class="rv-btn ic" id="rv-shot" title="Screenshot the whole view">${RV_ICON.camera}</button>
            <button class="rv-btn ic close" id="rv-close" title="Close">${RV_ICON.close}</button>
        </div>
        <div class="rv-bp-pop" id="rv-bp-pop"></div>
        <div class="rv-tabs" id="rv-tabs"></div>
        <div class="rv-iso" id="rv-iso">Isolation — showing one screen. <button class="rv-btn" id="rv-isoexit" style="margin-left:8px;padding:3px 9px;">Show all</button></div>
        <div class="rv-stage"><div class="rv-row" id="rv-row"></div></div>`;
    document.body.appendChild(o);

    o.querySelector('#rv-url').value = rvState.url;
    o.querySelector('#rv-zoom').value = Math.round(rvState.zoom * 100);
    o.querySelector('#rv-ua').value = rvState.ua;
    o.querySelector('#rv-mockup').classList.toggle('on', rvState.mockup);
    o.querySelector('#rv-sync').classList.toggle('on', rvState.sync);
    o.querySelector('#rv-scrollbar').classList.toggle('on', !rvState.hideScroll);
    rvFillAddMenu();
    rvLoadBreakpoints();
    rvRender();
    rvUaHint();

    const reloadAll = () => o.querySelectorAll('.rv-screen iframe').forEach(f => { f.src = f.src; });
    o.querySelector('#rv-go').addEventListener('click', () => {
        let v = o.querySelector('#rv-url').value.trim(); if (!v) return;
        if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
        rvState.url = v; o.querySelector('#rv-url').value = v; rvRender();
    });
    o.querySelector('#rv-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') o.querySelector('#rv-go').click(); });
    o.querySelector('#rv-reload').addEventListener('click', reloadAll);
    o.querySelector('#rv-rotate').addEventListener('click', () => { rvActiveTab().screens.forEach(s => s.rotated = !s.rotated); rvSave(); rvApplyGeometry(); });
    o.querySelector('#rv-zoom').addEventListener('change', (e) => {
        let pct = parseInt(e.target.value, 10); if (!pct) pct = 50;
        pct = Math.max(10, Math.min(200, pct)); e.target.value = pct;
        rvState.zoom = pct / 100; rvSave(); rvApplyGeometry();
    });
    o.querySelector('#rv-ua').addEventListener('change', (e) => { rvState.ua = e.target.value; rvSave(); rvUaHint(); chrome.runtime.sendMessage({ action: 'responsiveDnr', enable: true, ua: rvState.ua }, () => setTimeout(reloadAll, 150)); });
    o.querySelector('#rv-mockup').addEventListener('click', () => { rvState.mockup = !rvState.mockup; o.querySelector('#rv-mockup').classList.toggle('on', rvState.mockup); rvSave(); rvApplyGeometry(); });
    o.querySelector('#rv-sync').addEventListener('click', () => { rvState.sync = !rvState.sync; o.querySelector('#rv-sync').classList.toggle('on', rvState.sync); rvSave(); });
    o.querySelector('#rv-scrollbar').addEventListener('click', () => { rvState.hideScroll = !rvState.hideScroll; o.querySelector('#rv-scrollbar').classList.toggle('on', !rvState.hideScroll); rvSave(); rvWireFrames(); });
    o.querySelector('#rv-add').addEventListener('change', (e) => {
        const v = e.target.value; e.target.value = '';
        if (v === '__custom') { rvCustomDialog(); return; }
        const d = rvLibrary().find(x => x.name === v);
        if (d) rvAddScreenLive({ id: rvState.nextScreen++, name: d.name, w: d.w, h: d.h, rotated: false });
    });
    o.querySelector('#rv-isoexit').addEventListener('click', () => { rvState.isolated = null; rvApplyGeometry(); });
    o.querySelector('#rv-fit').addEventListener('click', () => {
        const stage = o.querySelector('.rv-stage');
        const tab = rvActiveTab();
        const screens = rvState.isolated ? tab.screens.filter(s => s.id === rvState.isolated) : tab.screens;
        if (!screens.length) return;
        // gaps, mockup padding and stage padding are fixed pixels - only the
        // devices themselves scale, so solve z for: pad + n*mock + gaps + z*sumW = stageW
        const mock = rvState.mockup ? 18 : 0, pad = 48, gaps = 22 * (screens.length - 1);
        let z;
        if (rvState.layout === 'stack') {
            const maxW = Math.max(...screens.map(s => (s.rotated ? s.h : s.w)));
            z = (stage.clientWidth - pad - mock) / maxW;
        } else {
            const sumW = screens.reduce((a, s) => a + (s.rotated ? s.h : s.w), 0);
            z = (stage.clientWidth - pad - gaps - screens.length * mock) / sumW;
        }
        // also fit the TALLEST device into the stage height (row layout),
        // otherwise a "fitting" width still leaves a big vertical scroll
        if (rvState.layout !== 'stack') {
            const headH = 32, mockV = rvState.mockup ? 34 : 0;
            const maxH = Math.max(...screens.map(s => (s.rotated ? s.w : s.h)));
            const zH = (stage.clientHeight - pad - headH - mockV) / maxH;
            z = Math.min(z, zH);
        }
        z = Math.max(0.1, Math.min(2, Math.floor(z * 100) / 100));
        rvState.zoom = z;
        o.querySelector('#rv-zoom').value = Math.round(z * 100);
        rvSave(); rvApplyGeometry();
    });
    // Breakpoints dropdown: the button opens a popover positioned under it; a chip
    // adds a device at that width; clicking elsewhere closes it.
    const bpBtn = o.querySelector('#rv-bp-btn'), bpPop = o.querySelector('#rv-bp-pop');
    bpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = bpPop.classList.toggle('show');
        bpBtn.classList.toggle('on', open);
        if (open) {
            const r = bpBtn.getBoundingClientRect();
            bpPop.style.left = Math.min(r.left, innerWidth - 316) + 'px';
            bpPop.style.top = (r.bottom + 6) + 'px';
        }
    });
    bpPop.addEventListener('click', (e) => {
        const bp = e.target.closest('.rv-bp'); if (!bp) return;
        const w = +bp.dataset.bp; if (!w) return;
        rvAddScreenLive({ id: rvState.nextScreen++, name: `${w}px`, w, h: 900, rotated: false });
        bpPop.classList.remove('show'); bpBtn.classList.remove('on');
    });
    o.addEventListener('click', (e) => {
        if (bpPop.classList.contains('show') && !bpPop.contains(e.target) && e.target !== bpBtn && !bpBtn.contains(e.target)) {
            bpPop.classList.remove('show'); bpBtn.classList.remove('on');
        }
    });
    o.querySelector('#rv-close').addEventListener('click', closeResponsiveOverlay);

    o.querySelector('#rv-tabs').addEventListener('click', (e) => {
        const x = e.target.closest('[data-tabx]');
        if (x) { e.stopPropagation(); rvDeleteTab(+x.dataset.tabx); return; }
        const ed = e.target.closest('[data-tabedit]');
        if (ed) {
            e.stopPropagation();
            const nm = ed.closest('[data-tab]').querySelector('.rv-tabname');
            nm.contentEditable = 'true'; nm.focus();
            const sel = document.getSelection(); sel.removeAllRanges();
            const r = document.createRange(); r.selectNodeContents(nm); sel.addRange(r);
            return;
        }
        if (e.target.closest('#rv-tabadd')) { rvAddTab(); return; }
        const tab = e.target.closest('[data-tab]');
        if (tab && !e.target.isContentEditable) { rvState.active = +tab.dataset.tab; rvState.isolated = null; rvSave(); rvRender(); }
    });
    o.querySelector('#rv-tabs').addEventListener('dblclick', (e) => {
        const nm = e.target.closest('.rv-tabname'); if (!nm) return;
        nm.contentEditable = 'true'; nm.focus(); document.getSelection().selectAllChildren(nm);
    });
    o.querySelector('#rv-tabs').addEventListener('keydown', (e) => {
        const nm = e.target.closest('.rv-tabname');
        if (nm && e.key === 'Enter') { e.preventDefault(); nm.blur(); }
    });
    o.querySelector('#rv-tabs').addEventListener('blur', (e) => {
        const nm = e.target.closest('.rv-tabname'); if (!nm) return;
        nm.contentEditable = 'false';
        const tab = rvState.tabs.find(t => t.id === +nm.closest('[data-tab]').dataset.tab);
        if (tab) { tab.name = (nm.textContent || 'Tab').trim().slice(0, 24) || 'Tab'; rvSave(); rvRenderTabs(); }
    }, true);

    const rvRow = o.querySelector('#rv-row');
    rvRow.addEventListener('click', (e) => {
        const dim = e.target.closest('.rv-fdim');
        if (dim) { dim.contentEditable = 'true'; dim.focus(); const sel = document.getSelection(); sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(dim); sel.addRange(r); return; }
        // Gear button toggles this frame's options menu (and closes any other open one).
        const gear = e.target.closest('button[data-menu]');
        if (gear) {
            const menu = gear.parentElement.querySelector('.rv-fmenu');
            const wasOpen = menu.classList.contains('open');
            rvRow.querySelectorAll('.rv-fmenu.open').forEach(m => m.classList.remove('open'));
            rvRow.querySelectorAll('button[data-menu].open').forEach(g => g.classList.remove('open'));
            if (!wasOpen) { menu.classList.add('open'); gear.classList.add('open'); }
            return;
        }
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        // Any menu action closes the menu it lives in.
        const inMenu = btn.closest('.rv-fmenu');
        if (inMenu) { inMenu.classList.remove('open'); const g = inMenu.parentElement.querySelector('button[data-menu]'); if (g) g.classList.remove('open'); }
        const frame = btn.closest('[data-id]'); const id = +frame.dataset.id;
        const tab = rvActiveTab();
        const s = tab.screens.find(x => x.id === id); if (!s) return;
        const act = btn.dataset.act;
        if (act === 'rotate') { s.rotated = !s.rotated; rvSave(); rvApplyGeometry(); }
        else if (act === 'remove') {
            tab.screens = tab.screens.filter(x => x.id !== id);
            if (rvState.isolated === id) rvState.isolated = null;
            rvSave(); frame.remove();
            if (!tab.screens.length) rvRow.innerHTML = '<div class="rv-empty">No devices in this tab — add one with "+ Add device".</div>';
            rvApplyGeometry();
        }
        else if (act === 'isolate') { rvState.isolated = (rvState.isolated === id) ? null : id; rvApplyGeometry(); }
        else if (act === 'reload') { const f = frame.querySelector('iframe'); if (f) f.src = f.src; }
        else if (act === 'shot') { rvDeviceShot(frame, s); }
        else if (act === 'full') { rvFullShot(frame, s); }
    });
    // Click anywhere else (or Esc) closes an open frame options menu.
    o.addEventListener('click', (e) => {
        if (e.target.closest('.rv-fact')) return;   // clicks inside the gear/menu are handled above
        rvRow.querySelectorAll('.rv-fmenu.open').forEach(m => m.classList.remove('open'));
        rvRow.querySelectorAll('button[data-menu].open').forEach(g => g.classList.remove('open'));
    }, true);
    // Edit dimensions inline (type "WxH")
    rvRow.addEventListener('keydown', (e) => { if (e.target.closest('.rv-fdim') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    rvRow.addEventListener('blur', (e) => {
        const dim = e.target.closest('.rv-fdim'); if (!dim) return;
        dim.contentEditable = 'false';
        const s = rvActiveTab().screens.find(x => x.id === +dim.closest('[data-id]').dataset.id);
        const m = (dim.textContent || '').match(/(\d{2,4})\s*[x×*,]\s*(\d{2,4})/i);
        if (s && m) { s.w = +m[1]; s.h = +m[2]; s.rotated = false; rvSave(); }
        rvApplyGeometry();
    }, true);
    // Drag to reorder devices
    let rvDragId = null;
    rvRow.addEventListener('dragstart', (e) => {
        const head = e.target.closest('.rv-fhead'); if (!head) return;
        rvDragId = +head.closest('[data-id]').dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        o.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = 'none'); // so dragover fires over frames
    });
    rvRow.addEventListener('dragover', (e) => { if (rvDragId != null) e.preventDefault(); });
    rvRow.addEventListener('drop', (e) => {
        if (rvDragId == null) return; e.preventDefault();
        const target = e.target.closest('[data-id]');
        const screens = rvActiveTab().screens;
        const from = screens.findIndex(s => s.id === rvDragId);
        let to = target ? screens.findIndex(s => s.id === +target.dataset.id) : screens.length - 1;
        if (from >= 0 && to >= 0 && from !== to) {
            const [m] = screens.splice(from, 1); screens.splice(to, 0, m); rvSave();
            const dragNode = rvRow.querySelector(`[data-id="${rvDragId}"]`);
            if (dragNode && target && dragNode !== target) { if (from < to) target.after(dragNode); else target.before(dragNode); }
        }
    });
    rvRow.addEventListener('dragend', () => { rvDragId = null; o.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = ''); });
    o.querySelector('#rv-shot').addEventListener('click', () => rvScreenshot(null, 'responsive-view.png'));
    document.addEventListener('keydown', rvEsc, true);
}

function rvFillAddMenu() {
    const sel = document.querySelector('#qa-rv #rv-add'); if (!sel) return;
    sel.innerHTML = '<option value="">+ Add device</option>'
        + rvLibrary().map(d => `<option value="${qaEsc(d.name)}">${qaEsc(d.name)} — ${d.w}×${d.h}</option>`).join('')
        + '<option value="__custom">➕ Custom device…</option>';
}

function rvCustomDialog() {
    const o = document.getElementById('qa-rv'); if (!o) return;
    const dlg = document.createElement('div');
    dlg.className = 'rv-dlg';
    dlg.innerHTML = `<div class="rv-dlg-box">
        <h4>Custom devices</h4>
        <label>Name</label><input id="rv-cd-name" placeholder="My device">
        <div class="rv-dlg-row">
            <div style="flex:1"><label>Width</label><input id="rv-cd-w" type="number" placeholder="390"></div>
            <div style="flex:1"><label>Height</label><input id="rv-cd-h" type="number" placeholder="844"></div>
        </div>
        <div class="rv-dlg-btns">
            <button class="rv-btn" id="rv-cd-cancel">Close</button>
            <button class="rv-btn go" id="rv-cd-add">Add</button>
        </div>
        <div id="rv-cd-list"></div>
    </div>`;
    o.appendChild(dlg);
    dlg.querySelector('#rv-cd-name').focus();
    const close = () => dlg.remove();
    const renderList = () => {
        const list = dlg.querySelector('#rv-cd-list');
        if (!rvState.custom.length) { list.innerHTML = ''; return; }
        list.innerHTML = `<div style="font-size:11px;color:#94a3b8;margin:14px 0 6px;">Your devices</div>`
            + rvState.custom.map((d, i) => `<div class="rv-cd-item"><span>${qaEsc(d.name)} <b style="color:#64748b;font-weight:400;">${d.w}×${d.h}</b></span><button data-del="${i}" title="Delete">&times;</button></div>`).join('');
    };
    renderList();
    dlg.querySelector('#rv-cd-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        rvState.custom.splice(+b.dataset.del, 1);
        rvSave(); rvFillAddMenu(); renderList();
    });
    dlg.querySelector('#rv-cd-cancel').addEventListener('click', close);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.querySelector('#rv-cd-add').addEventListener('click', () => {
        const name = (dlg.querySelector('#rv-cd-name').value || '').trim() || 'Custom';
        const w = parseInt(dlg.querySelector('#rv-cd-w').value, 10), h = parseInt(dlg.querySelector('#rv-cd-h').value, 10);
        if (!w || !h || w < 100 || h < 100) { dlg.querySelector('#rv-cd-w').style.borderColor = '#ef4444'; dlg.querySelector('#rv-cd-h').style.borderColor = '#ef4444'; return; }
        rvState.custom.push({ name, w, h });
        rvActiveTab().screens.push({ id: rvState.nextScreen++, name, w, h, rotated: false });
        rvSave(); rvFillAddMenu(); rvRender();
        dlg.querySelector('#rv-cd-name').value = ''; dlg.querySelector('#rv-cd-w').value = ''; dlg.querySelector('#rv-cd-h').value = '';
        renderList(); dlg.querySelector('#rv-cd-name').focus();
    });
}

function rvAddTab() {
    const id = rvState.nextTab++;
    rvState.tabs.push({ id, name: 'New tab', screens: [] });
    rvState.active = id; rvState.isolated = null;
    rvSave(); rvRender();
}
function rvDeleteTab(id) {
    if (rvState.tabs.length <= 1) return;
    rvState.tabs = rvState.tabs.filter(t => t.id !== id);
    if (rvState.active === id) rvState.active = rvState.tabs[0].id;
    rvSave(); rvRender();
}

function rvDownload(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function rvScreenshot(rect, name) {
    chrome.runtime.sendMessage({ action: 'captureTab' }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error || !resp.dataUrl) return;
        if (!rect) { rvDownload(resp.dataUrl, name); return; }
        const img = new Image();
        img.onload = () => {
            const dpr = window.devicePixelRatio || 1;
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(rect.width * dpr));
            c.height = Math.max(1, Math.round(rect.height * dpr));
            c.getContext('2d').drawImage(img, rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr, 0, 0, c.width, c.height);
            rvDownload(c.toDataURL('image/png'), name);
        };
        img.src = resp.dataUrl;
    });
}

// The page's REAL breakpoints, read from its own @media rules. Two things make
// this accurate instead of a wall of near-duplicate numbers:
//   1. A boundary written as `max-width:767px` is the same line as `min-width:768px`
//      - the layout flips at 768. So every max-width is normalised to value+1,
//      which collapses the 767/768, 991/992, 1023/1024/1025 … pairs into one.
//   2. Cross-origin (CDN) stylesheets can't be read from a content script; their
//      text is fetched through the worker and parsed, so CDN breakpoints aren't
//      silently missed.
const RV_BP_MIN = 240, RV_BP_MAX = 2600;

// Pull min/max-width values out of a media-query string, normalising max to the
// boundary where the next layout begins.
function rvBpsFromMediaText(text, out) {
    for (const m of text.matchAll(/(min|max)-width:\s*([\d.]+)px/gi)) {
        let v = Math.round(parseFloat(m[2]));
        if (m[1].toLowerCase() === 'max') v += 1;
        if (v >= RV_BP_MIN && v <= RV_BP_MAX) out.add(v);
    }
}
function rvBpsFromCssText(css, out) {
    for (const mm of css.matchAll(/@media[^{]+/gi)) rvBpsFromMediaText(mm[0], out);
}

// Same-origin / readable sheets now; returns the hrefs of the ones we couldn't
// read so the caller can fetch them cross-origin.
function rvCollectReadableBps(out) {
    const external = [];
    for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { if (sheet.href) external.push(sheet.href); continue; }
        if (!rules) { if (sheet.href) external.push(sheet.href); continue; }
        const walk = (rs) => {
            for (const r of rs) {
                try {
                    if (r.media && r.media.mediaText) rvBpsFromMediaText(r.media.mediaText, out);
                    if (r.cssRules) walk(r.cssRules);
                } catch (e) { }
            }
        };
        try { walk(rules); } catch (e) { }
    }
    return external;
}

const rvBpChip = (v, cls) => `<button class="rv-bp ${cls}" data-bp="${v}" title="Add a ${v}px-wide screen">${v}</button>`;

// Collapse values within `tol` px of the one before them - so a site that writes
// 768 AND 769 (max-width:767 → 768 next to min-width:769) shows ONE clean 768,
// not both. Keeps the list short and readable.
function rvMergeClose(sorted, tol) {
    const out = [];
    for (const v of sorted) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    return out;
}

let rvBpsPage = [];   // detected page breakpoints (merged), filled by rvLoadBreakpoints

// Render the popover contents from the current rvBpsPage + presets.
function rvRenderBpPop() {
    const pop = document.querySelector('#qa-rv #rv-bp-pop'); if (!pop) return;
    const presets = [320, 480, 768, 1024, 1280, 1440].filter(v => !rvBpsPage.includes(v));
    pop.innerHTML =
        `<span class="rv-bps-l">Page breakpoints</span>`
        + (rvBpsPage.length
            ? `<div class="rv-bp-wrap">${rvBpsPage.map(v => rvBpChip(v, 'det')).join('')}</div>`
            : `<div class="rv-bp-empty">None found in this page's CSS.</div>`)
        + `<span class="rv-bps-l dim">Preset widths</span>`
        + `<div class="rv-bp-wrap">${presets.map(v => rvBpChip(v, '')).join('')}</div>`;
}

// Detect the page's breakpoints (readable sheets first, then CDN sheets fetched
// through the worker), merge near-duplicates, and refresh the popover.
async function rvLoadBreakpoints() {
    const det = new Set();
    const external = rvCollectReadableBps(det);
    rvBpsPage = rvMergeClose([...det].sort((a, b) => a - b), 3).slice(0, 30);
    rvRenderBpPop();
    if (!external.length) return;
    const texts = await Promise.all(external.map((href) => new Promise((res) => {
        try { chrome.runtime.sendMessage({ action: 'fetchText', url: href }, (r) => res(r && r.ok ? r.text : '')); }
        catch (e) { res(''); }
    })));
    const before = det.size;
    texts.forEach((css) => { if (css) rvBpsFromCssText(css, det); });
    if (det.size !== before) { rvBpsPage = rvMergeClose([...det].sort((a, b) => a - b), 3).slice(0, 30); rvRenderBpPop(); }
}

// Full-page screenshot of one device: scroll its document step by step,
// capture each step and stitch the crops into one tall PNG.
// Screenshot ONE device at its real resolution, whatever the current zoom - like
// ResponsivelyApp, which captures each device on its own. The old shot cropped the
// screen as shown, so at 50% zoom a 390px phone came out 195px wide and blurry. Now the
// device is shown alone at 100%, pinned to the top-left corner of the window, and a
// device bigger than the window is captured in tiles and stitched.
const rvCapTab = () => new Promise((res) => { try { chrome.runtime.sendMessage({ action: 'captureTab' }, (r) => res(r && r.dataUrl)); } catch (e) { res(null); } });
const rvLoadImg = (u) => new Promise((res) => { if (!u) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
// While capturing, hide every toast/status pill - one that pops up MID-capture sits
// above the pinned device and was photographed as a 34px band in three slices in a row.
function rvHideOverlaysWhileCapturing(on) {
    let st = document.getElementById('rv-cap-hide');
    if (on && !st) {
        st = document.createElement('style'); st.id = 'rv-cap-hide';
        st.textContent = '.qa-li-toast, #ff-ai-status, #toast { visibility: hidden !important; }';
        (document.head || document.documentElement).appendChild(st);
    } else if (!on && st) st.remove();
}
async function rvDeviceShot(frameEl, s) {
    const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
    const dpr = window.devicePixelRatio || 1;
    const inner = frameEl.querySelector('.rv-inner'), screenEl = frameEl.querySelector('.rv-screen');
    const keep = { zoom: rvState.zoom, iso: rvState.isolated, innerStyle: inner.getAttribute('style') || '', screenR: screenEl.style.borderRadius };
    document.querySelectorAll('.qa-li-toast').forEach((t) => t.remove());   // never photograph a toast
    rvHideOverlaysWhileCapturing(true);
    rvState.zoom = 1; rvState.isolated = s.id; rvApplyGeometry();
    screenEl.style.borderRadius = '0';
    const vw = window.innerWidth, vh = window.innerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    let ok = true;
    try {
        for (let y = 0; y < h && ok; y += vh) {
            for (let x = 0; x < w && ok; x += vw) {
                // pin the device so this tile sits at the window's top-left
                Object.assign(inner.style, { position: 'fixed', left: -x + 'px', top: -y + 'px', zIndex: '2147483647', margin: '0', borderRadius: '0' });
                await new Promise((r) => setTimeout(r, 550));   // paint + captureVisibleTab quota (2/s)
                const img = await rvLoadImg(await rvCapTab());
                if (!img) { ok = false; break; }
                const tw = Math.min(vw, w - x), th = Math.min(vh, h - y);
                ctx.drawImage(img, 0, 0, tw * dpr, th * dpr, x * dpr, y * dpr, tw * dpr, th * dpr);
            }
        }
    } finally {
        inner.setAttribute('style', keep.innerStyle); screenEl.style.borderRadius = keep.screenR;
        rvHideOverlaysWhileCapturing(false);
        rvState.zoom = keep.zoom; rvState.isolated = keep.iso; rvApplyGeometry();
    }
    if (!ok) { liToast('Screenshot failed - try again'); return; }
    rvDownload(canvas.toDataURL('image/png'), `${s.name}-${w}x${h}.png`);
}

// Full-page capture at 100% (the device's real width) whatever zoom the grid is at -
// the old capture was only as sharp as the current zoom (half size at the default 50%),
// and refused to run unless you zoomed out yourself.
async function rvFullShot(frameEl, s) {
    const inner = frameEl.querySelector('.rv-inner');
    const keep = { zoom: rvState.zoom, iso: rvState.isolated, sync: rvState.sync, innerStyle: inner.getAttribute('style') || '' };
    rvHideOverlaysWhileCapturing(true);
    rvState.isolated = s.id;
    rvState.zoom = 1;
    rvApplyGeometry();
    await new Promise((r) => setTimeout(r, 250));
    try { await rvFullShotAtZoom(frameEl, s); }
    catch (e) { liToast('Full-page screenshot failed'); }
    finally {
        // ALWAYS un-pin the device, even if the capture threw half-way - otherwise it
        // stays stuck over the top-left of the page.
        inner.setAttribute('style', keep.innerStyle);
        rvHideOverlaysWhileCapturing(false);
        rvState.sync = keep.sync;
        rvState.zoom = keep.zoom; rvState.isolated = keep.iso; rvApplyGeometry();
    }
}

async function rvFullShotAtZoom(frameEl, s) {
    const iframe = frameEl.querySelector('iframe');
    let doc, win; try { doc = iframe.contentDocument; win = iframe.contentWindow; } catch (e) { doc = null; }
    if (!doc || !win) { liToast('Full-page capture needs a same-origin page'); return; }
    const inner = frameEl.querySelector('.rv-inner');
    const innerStyle = inner.getAttribute('style') || '';
    const de = doc.documentElement;
    // Many sites don't scroll the WINDOW at all - a wrapper (<main> etc.)
    // scrolls instead. Find the real scroller, otherwise every capture would
    // show the same screen stacked over and over.
    let scEl = null;
    if (de.scrollHeight <= win.innerHeight + 4) {
        let best = null;
        try {
            const all = doc.querySelectorAll('body, body *');
            for (let i = 0; i < all.length && i < 3000; i++) {
                const el = all[i];
                if (el.clientHeight >= win.innerHeight * 0.5 && el.scrollHeight > el.clientHeight + 40) {
                    const cs = win.getComputedStyle(el);
                    if (/(auto|scroll|overlay)/.test(cs.overflowY) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
                }
            }
        } catch (e) { }
        scEl = best;
    }
    const z = rvState.zoom, dpr = window.devicePixelRatio || 1;
    // capture sub-rect inside the frame (whole viewport, or just the scroller)
    let srL = 0, srT = 0, srW = win.innerWidth, srH = win.innerHeight;
    // Only the part of the scroller that is ON the device screen. OutSystems sizes
    // .main-content at 100% of the layout, so it runs ~64px (the header) past the
    // device's bottom edge - capturing its full clientHeight photographed that hidden
    // strip as a black band at the bottom of every slice.
    let hiddenBelow = 0;
    if (scEl) {
        const b = scEl.getBoundingClientRect();
        srL = Math.max(0, b.left); srT = Math.max(0, b.top);
        srW = Math.min(scEl.clientWidth, win.innerWidth - srL);
        srH = Math.min(scEl.clientHeight, win.innerHeight - srT);
        hiddenBelow = Math.max(0, scEl.clientHeight - srH);
    }
    if (srH < 40 || srW < 40) { liToast('Nothing scrollable to capture'); return; }
    // The last `hiddenBelow` px can never scroll into view on the device either.
    const totalH = Math.max((scEl ? scEl.scrollHeight : de.scrollHeight) - hiddenBelow, srH);
    const steps = Math.min(Math.ceil(totalH / srH), 15);
    const getY = () => scEl ? scEl.scrollTop : (win.scrollY || de.scrollTop || 0);
    const setY = (y) => { if (scEl) scEl.scrollTop = y; else { win.scrollTo(0, y); try { de.scrollTop = y; } catch (e) { } } };
    const prevY = getY(), prevSync = rvState.sync;
    rvState.sync = false;                        // don't drag the other frames along
    rvHideScrollbar(doc, true);
    // rounded device corners let the dark stage show through - captured in
    // EVERY slice they repeat as black marks. Square them during the capture.
    const screenEl = frameEl.querySelector('.rv-screen');
    const prevScreenR = screenEl.style.borderRadius, prevInnerR = inner.style.borderRadius;
    screenEl.style.borderRadius = '0'; inner.style.borderRadius = '0';
    await new Promise(r => setTimeout(r, 60));
    const prevBehavior = de.style.scrollBehavior;
    de.style.scrollBehavior = 'auto';
    if (scEl) scEl.style.scrollBehavior = 'auto';
    // fixed/sticky elements (navbars...) repeat in every slice - hide them after slice 0
    const fixedEls = [];
    if (!scEl) {
        try {
            const all = doc.querySelectorAll('body *');
            for (let i = 0; i < all.length && i < 4000; i++) {
                const cs = win.getComputedStyle(all[i]);
                if (cs.position === 'fixed' || cs.position === 'sticky') fixedEls.push([all[i], all[i].style.visibility]);
            }
        } catch (e) { }
    }
    // Each scroll position is captured with the device PINNED to the window's top-left
    // (same as rvDeviceShot), tile by tile when the device is bigger than the window -
    // so the page comes out at its real width, not at the grid's zoom.
    // The WHOLE device screen, not just the scroller: the header above it and any bottom
    // bar below it belong in a full-page shot. Layout of the final image:
    //   [ device rows 0..srT (header)                     ]  from the first capture
    //   [ the scroller's full content, totalH tall        ]  one slice per scroll step
    //   [ device rows below the scroller (bottom bar)     ]  from the last capture
    const vw = window.innerWidth, vh = window.innerHeight;
    const devW = win.innerWidth, devH = win.innerHeight;
    const aboveH = srT, belowH = Math.max(0, devH - (srT + srH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(devW * z * dpr));
    canvas.height = Math.max(1, Math.round((aboveH + totalH + belowH) * z * dpr));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // NO toasts while capturing - they'd be photographed into every slice
    document.querySelectorAll('.qa-li-toast').forEach(t => t.remove());
    let failed = false;
    // Copy device region (x,y,w,h) [device px] onto the canvas at (dx,dy) [device px]:
    // the device is PINNED so each window-sized tile of the region sits at the window's
    // top-left, captured, and drawn (same as rvDeviceShot).
    const grab = async (x, y, w, h, dx, dy) => {
        for (let ty = 0; ty < h * z && !failed; ty += vh) {
            for (let tx = 0; tx < w * z && !failed; tx += vw) {
                Object.assign(inner.style, { position: 'fixed', left: -(x * z + tx) + 'px', top: -(y * z + ty) + 'px', zIndex: '2147483647', margin: '0' });
                await new Promise(r => setTimeout(r, 550));   // paint + captureVisibleTab quota (2/s)
                const img = await rvLoadImg(await rvCapTab());
                if (!img) { failed = true; break; }
                const tw = Math.min(vw, w * z - tx), th = Math.min(vh, h * z - ty);
                ctx.drawImage(img, 0, 0, tw * dpr, th * dpr, (dx * z + tx) * dpr, (dy * z + ty) * dpr, tw * dpr, th * dpr);
            }
        }
    };
    setY(0);
    // 1) the full device screen at the top of the page (header, first screen, bottom bar)
    await grab(0, 0, devW, devH, 0, 0);
    // 2) the rest of the scroller, slice by slice, right under the header
    let lastActual = 0;
    for (let i = 1; i < steps && !failed; i++) {
        const target = Math.min(i * srH, Math.max(0, totalH - srH));
        if (i === 1) fixedEls.forEach(([el]) => { el.style.visibility = 'hidden'; });
        setY(target);
        const actual = Math.round(getY());
        if (actual <= lastActual) break;              // the page can't scroll further
        lastActual = actual;
        await grab(srL, srT, srW, srH, srL, aboveH + actual);
    }
    // 3) whatever sits BELOW the scroller (a bottom bar) goes at the very bottom
    const contentEnd = Math.max(srH, lastActual + srH);  // how far the scroller's content actually went
    if (belowH > 0 && !failed) await grab(0, srT + srH, devW, belowH, 0, aboveH + contentEnd);
    const maxBottom = Math.round((aboveH + contentEnd + belowH) * z * dpr);
    inner.setAttribute('style', innerStyle);
    fixedEls.forEach(([el, prev]) => { el.style.visibility = prev || ''; });
    screenEl.style.borderRadius = prevScreenR; inner.style.borderRadius = prevInnerR;
    de.style.scrollBehavior = prevBehavior;
    if (scEl) scEl.style.scrollBehavior = '';
    setY(prevY);
    rvHideScrollbar(doc, rvState.hideScroll);
    rvState.sync = prevSync;
    let out = canvas;
    if (maxBottom > 0 && maxBottom < canvas.height) {
        out = document.createElement('canvas');
        out.width = canvas.width; out.height = maxBottom;
        out.getContext('2d').drawImage(canvas, 0, 0);
    }
    const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
    try { rvDownload(out.toDataURL('image/png'), `${s.name}-${w}x${h}-full.png`); liToast('Full-page screenshot saved'); }
    catch (e) { liToast('Capture failed'); }
}

function rvEsc(e) { if (e.key === 'Escape' && document.getElementById('qa-rv')) closeResponsiveOverlay(); }
function closeResponsiveOverlay() {
    const o = document.getElementById('qa-rv'); if (o) o.remove();
    document.documentElement.style.overflow = rvPrevOverflow || '';
    document.removeEventListener('keydown', rvEsc, true);
    chrome.runtime.sendMessage({ action: 'responsiveDnr', enable: false }).catch(() => { });
}

function rvRenderTabs() {
    const o = document.getElementById('qa-rv'); if (!o) return;
    o.querySelector('#rv-tabs').innerHTML = rvState.tabs.map(t =>
        `<div class="rv-tab ${t.id === rvState.active ? 'active' : ''}" data-tab="${t.id}">
            <span class="rv-tabname">${qaEsc(t.name)}</span>
            <button class="rv-tabedit" data-tabedit="${t.id}" title="Rename">&#9998;</button>
            ${rvState.tabs.length > 1 ? `<button class="rv-tabx" data-tabx="${t.id}" title="Delete tab">&times;</button>` : ''}
        </div>`).join('') + `<button class="rv-tabadd" id="rv-tabadd" title="New tab">+</button>`;
}

// Width at or below this (in the current orientation) is treated as a touch device:
// hover states are suppressed and the page's JS is told it's touch. Above it is a
// laptop/desktop that keeps hover. 1024 is the usual tablet/desktop CSS breakpoint.
const RV_TOUCH_MAX_W = 1024;
function rvIsTouchWidth(s) { return (s.rotated ? s.h : s.w) <= RV_TOUCH_MAX_W; }

function rvFrameHtml(s) {
    const z = rvState.zoom;
    const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
    const sw = Math.round(w * z), sh = Math.round(h * z);
    const outerW = Math.max(sw + (rvState.mockup ? 18 : 0), 150);
    const hidden = rvState.isolated && rvState.isolated !== s.id;
    // Stamp the touch decision on the frame NOW, from its width. decorate() reads this
    // attribute directly - no lookup that could race or fall back to the wrong default.
    return `<div data-id="${s.id}" data-touch="${rvIsTouchWidth(s) ? '1' : '0'}" style="flex-shrink:0; width:${outerW}px;${hidden ? 'display:none;' : ''}">
        <div class="rv-fhead">
            <span class="rv-fname" draggable="true" title="Drag to reorder">${qaEsc(s.name)}</span>
            <span class="rv-fdim" title="Click to edit size">${w}×${h}</span>
            <span class="rv-fact">
                <button data-menu title="Options">${RV_ICON.gear}</button>
                <button data-act="remove" title="Remove device">${RV_ICON.close}</button>
                <div class="rv-fmenu">
                    <button data-act="shot">${RV_ICON.camera}<span>Screenshot (visible)</span></button>
                    <button data-act="full"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v8"/><path d="m9 12 3 3 3-3"/></svg><span>Full-page screenshot</span></button>
                    <button data-act="rotate">${RV_ICON.rotate}<span>Rotate</span></button>
                    <button data-act="reload">${RV_ICON.reload}<span>Reload</span></button>
                </div>
            </span>
        </div>
        <div class="rv-screen ${rvState.mockup ? 'mock' : ''}">
            <div class="rv-inner" style="width:${sw}px;height:${sh}px;">
                <!-- zoom (not transform:scale): renders the iframe NATIVELY at the
                     scaled size instead of rasterising a full-size layer and scaling
                     it on the GPU. The page still sees the real device width, but the
                     rounded-corner clip is now antialiased (a scaled GPU layer never
                     was) and scrolling is lighter. -->
                <iframe src="${encodeURI(rvState.url)}" style="width:${w}px;height:${h}px;zoom:${z};"></iframe>
            </div>
        </div>
    </div>`;
}

// Full rebuild - ONLY for open / tab switch / URL change / UA reload. Any
// geometry change (zoom, rotate, mockup, layout, isolate, resize) goes through
// rvApplyGeometry() instead, which patches styles in place WITHOUT reloading
// the iframes.
function rvRender() {
    const o = document.getElementById('qa-rv'); if (!o || !rvState) return;
    rvRenderTabs();
    const row = o.querySelector('#rv-row');
    row.classList.toggle('stack', rvState.layout === 'stack');
    o.querySelector('#rv-iso').style.display = rvState.isolated ? 'block' : 'none';
    const screens = rvActiveTab().screens;
    if (!screens.length) { row.innerHTML = '<div class="rv-empty">No devices in this tab — add one with "+ Add device".</div>'; return; }
    row.innerHTML = screens.map(rvFrameHtml).join('');
    rvWireFrames();
}

// Patch sizes/classes/visibility in place - the iframes (and everything the
// user did inside them) survive untouched.
function rvApplyGeometry() {
    const o = document.getElementById('qa-rv'); if (!o || !rvState) return;
    const row = o.querySelector('#rv-row');
    row.classList.toggle('stack', rvState.layout === 'stack');
    o.querySelector('#rv-iso').style.display = rvState.isolated ? 'block' : 'none';
    const z = rvState.zoom;
    const tab = rvActiveTab();
    const nodes = row.querySelectorAll('[data-id]');
    nodes.forEach((node, i) => {
        // match by id, fall back to position - DOM order always mirrors state order
        const s = tab.screens.find(x => x.id === +node.dataset.id) || tab.screens[i];
        if (!s) { node.remove(); return; }
        node.dataset.id = s.id;
        node.style.display = (rvState.isolated && rvState.isolated !== s.id) ? 'none' : '';
        const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
        const sw = Math.round(w * z), sh = Math.round(h * z);
        node.style.width = Math.max(sw + (rvState.mockup ? 18 : 0), 150) + 'px';
        node.querySelector('.rv-screen').classList.toggle('mock', rvState.mockup);
        const inner = node.querySelector('.rv-inner');
        inner.style.width = sw + 'px'; inner.style.height = sh + 'px';
        const f = node.querySelector('iframe');
        // MUST match rvFrameHtml (zoom, not transform:scale). Applying transform on
        // top of the existing zoom double-scaled the frame and left a ghost render
        // when geometry changed (e.g. toggling Mockup off/on).
        f.style.width = w + 'px'; f.style.height = h + 'px'; f.style.transform = ''; f.style.zoom = z;
        const dim = node.querySelector('.rv-fdim');
        if (dim && !dim.isContentEditable) dim.textContent = `${w}×${h}`;
    });
}

// Append ONE new device frame without rebuilding (and reloading) the others.
function rvAddScreenLive(s) {
    rvActiveTab().screens.push(s);
    rvSave();
    const o = document.getElementById('qa-rv'); if (!o) return;
    const row = o.querySelector('#rv-row');
    const emp = row.querySelector('.rv-empty'); if (emp) emp.remove();
    row.insertAdjacentHTML('beforeend', rvFrameHtml(s));
    rvWireFrames();
}

function rvRulerHtml(w, h, z) {
    let top = '', left = '';
    for (let x = 0; x <= w; x += 50) { const px = Math.round(x * z); top += `<i style="left:${px}px"></i>`; if (x % 100 === 0) top += `<span style="left:${px}px">${x}</span>`; }
    for (let y = 0; y <= h; y += 50) { const py = Math.round(y * z); left += `<i style="top:${py}px"></i>`; if (y % 100 === 0) left += `<span style="top:${py}px">${y}</span>`; }
    return `<div class="rv-rt">${top}</div><div class="rv-rl">${left}</div>`;
}

function rvTouchCursorValue() {
    const ring = `<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><circle cx='10' cy='10' r='7.5' fill='rgba(96,165,250,0.22)' stroke='rgb(59,130,246)' stroke-width='1.5'/></svg>`;
    return `url("data:image/svg+xml;base64,${btoa(ring)}") 10 10, auto`;
}
// Click-sync trace in the page's Console ("[QA sync]"): what was clicked and what each
// other device did with it. One line per click - the only way to see why a click
// didn't reach a device on a real site.
function rvDescribe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.');
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const href = el.getAttribute('href');
    const inner = !text && !cls && el.firstElementChild ? ` <${el.firstElementChild.tagName.toLowerCase()} class="${(el.firstElementChild.getAttribute('class') || '').slice(0, 40)}">` : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + (href ? `[href="${href.slice(0, 40)}"]` : '') + (text ? ` "${text}"` : '') + inner;
}
// Bump on every change to click sync: the log line proves which code the page runs.
const RV_SYNC_BUILD = 9;
function rvSyncLog(what, el, results) {
    try { console.log(`[QA sync #${RV_SYNC_BUILD}] ` + what + ': ' + rvDescribe(el) + (results ? '  →  ' + results.join('  |  ') : '')); } catch (e) { }
}
// How devices are paired - the same method ResponsivelyApp uses (BrowserSync "ghost
// mode"): an element is identified by its tag + its index among ALL elements with that
// tag in the page. It is the same app in every device, so the order of <a>/<button>/
// <div>… is the same even where ids differ (OutSystems: "b5-b24-…" on a tablet vs
// "b5-b18-…" on a phone). Every smarter heuristic (ids, classes, text, guessing which
// popup closed) failed somewhere on the real app; this one is what works there.
function rvTagIndex(el) {
    return Array.prototype.indexOf.call(el.ownerDocument.getElementsByTagName(el.tagName), el);
}
function rvByTagIndex(doc, tagName, index) {
    return index < 0 ? null : doc.getElementsByTagName(tagName)[index] || null;
}

// Never mirror a sign-out: logging out of one device must not log out all of them.
const RV_DANGER = /log ?out|sign ?out|log-off|logoff|تسجيل الخروج|خروج/i;
function rvLooksDangerous(el) {
    if (!el || el.nodeType !== 1) return false;
    const act = el.closest('a, button, [role="button"], [role="menuitem"], [role="link"]') || el;
    const text = (act.textContent || act.value || '').trim().slice(0, 60);
    return [act.getAttribute('href'), act.id, act.getAttribute('aria-label'), act.getAttribute('title'), text].some((b) => b && RV_DANGER.test(b));
}

// Some sites decide mobile/desktop from the User-Agent on the SERVER - if the
// devices are phone-sized while the UA is still Desktop, nudge the user.
function rvUaHint() {
    const sel = document.querySelector('#qa-rv #rv-ua'); if (!sel) return;
    const phoneish = rvActiveTab().screens.some(s => Math.min(s.w, s.h) <= 500);
    const warn = phoneish && rvState.ua === 'desktop';
    sel.style.borderColor = warn ? '#f59e0b' : '';
    sel.title = warn ? 'Tip: some sites serve different HTML per device - switch the UA to iPhone/Android for true mobile rendering' : 'User-Agent';
}

// A touch device has no hover, so moving the desktop mouse over a phone/tablet frame must
// not fire :hover states (link colours, underlines, hover-only menus) - they misrepresent
// the mobile view. There is no CSS switch for this and blocking mouse events doesn't help
// (the engine sets :hover from pointer position). The one reliable way is to rewrite every
// :hover rule's selector so it can never match. Frames load the current page's own URL, so
// they're same-origin and their CSSOM is reachable; a cross-origin CDN sheet is skipped.
// `on` comes from the frame's stamped data-touch, so a laptop (on=false) is never touched.
// A reload re-parses the untouched CSS, which is how the desktop/off case stays clean.
// IDEMPOTENT and safe to call repeatedly. There is NO permanent "done" flag: navigating
// (a fresh document) or a single-page-app route change (new <style>/rules injected into
// the SAME document) both bring back un-neutered :hover, so we must keep re-scanning.
// Re-running is cheap - an already-rewritten selector no longer contains ':hover', so the
// regex test skips it and nothing is written; only genuinely new :hover rules are touched.
function rvKillHover(doc, on) {
    if (!on) return;
    try {
        const neuter = (sel) => sel.replace(/:hover\b/gi, '.__rvnh');   // never matches
        const walk = (rules) => {
            for (const rule of rules) {
                if (rule.type === 1) {                                  // STYLE_RULE
                    if (rule.selectorText && /:hover\b/i.test(rule.selectorText)) {
                        try { rule.selectorText = neuter(rule.selectorText); } catch (e) { }
                    }
                } else if ((rule.type === 4 || rule.type === 12) && rule.cssRules) {
                    walk(rule.cssRules);                                // @media / @supports
                }
            }
        };
        // Walk a sheet only when it is NEW or its rule count changed. This runs 5x a second
        // per device, and re-walking every rule each time (OutSystems ships ~15k) ate ~40%
        // of the main thread - which all same-origin devices share - so the mirrored
        // scroll dropped to ~16fps.
        const seen = doc.__rvHoverSeen || (doc.__rvHoverSeen = new WeakMap());
        for (const sheet of doc.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
            if (!rules || seen.get(sheet) === rules.length) continue;
            walk(rules);
            seen.set(sheet, rules.length);
        }
    } catch (e) { }
}

// Make the page's JavaScript see a touch device (hover:none, pointer:coarse,
// maxTouchPoints) while Touch mode is on. CSS @media(hover/pointer) cannot be
// overridden without the debugger API - this covers the JS side.

function rvPatchTouchMedia(win) {
    try {
        // Mark the WRAPPED FUNCTION, not the window: a reload/navigation gives a fresh
        // window whose matchMedia is native again, so the old __rvMM window-flag guard
        // let a reloaded frame slip back to desktop behaviour. Checking the function is
        // reliable - a fresh native matchMedia has no mark, so we re-wrap it.
        if (!win.matchMedia.__rvWrapped) {
            const orig = win.matchMedia.bind(win);
            const wrapped = (q) => {
                if (win.__rvTouch && typeof q === 'string') {
                    const s = q.replace(/\s+/g, '').toLowerCase();
                    if (s.includes('(hover:none)') || s.includes('(pointer:coarse)') || s.includes('(any-pointer:coarse)')) {
                        return { matches: true, media: q, onchange: null, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; } };
                    }
                    if (s.includes('(hover:hover)') || s.includes('(pointer:fine)')) {
                        return { matches: false, media: q, onchange: null, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; } };
                    }
                }
                return orig(q);
            };
            wrapped.__rvWrapped = true;
            win.matchMedia = wrapped;
        }
        try { Object.defineProperty(win.navigator, 'maxTouchPoints', { configurable: true, get: () => win.__rvTouch ? 5 : 0 }); } catch (e) { }
    } catch (e) { }
}

function rvApplyCursor(doc, on) {
    try {
        let st = doc.getElementById('rv-cursor-style');
        if (on) {
            if (!st) { st = doc.createElement('style'); st.id = 'rv-cursor-style'; doc.head.appendChild(st); }
            st.textContent = `*,*::before,*::after{cursor:${rvTouchCursorValue()} !important;}`;
        } else if (st) { st.remove(); }
    } catch (e) { }
}
function rvHideScrollbar(doc, hide) {
    try {
        let st = doc.getElementById('rv-sb-style');
        if (!st) { st = doc.createElement('style'); st.id = 'rv-sb-style'; doc.head.appendChild(st); }
        // Hidden = no bar (phone look). Shown = a THIN, rounded, translucent bar on
        // both axes - like a mobile overlay scrollbar, not the chunky desktop one.
        // Use the STANDARD scrollbar-width/scrollbar-color on EVERY element (*),
        // not just html. Modern Chrome/Edge (121+) ignores ::-webkit-scrollbar once
        // scrollbar-width is present, and nested scrollers (a horizontal tab strip,
        // etc.) need it directly - putting it only on html left those with the fat
        // legacy bar (with arrows). `thin` gives a slim, arrow-less, mobile-like bar.
        st.textContent = hide
            ? `*{scrollbar-width:none !important;} *::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}`
            : `*{scrollbar-width:thin !important;scrollbar-color:rgba(135,139,155,0.6) transparent !important;}`;
    } catch (e) { }
}
// A page with `scroll-behavior:smooth` makes a programmatic scrollTo animate over
// ~300ms - fine when a user clicks an anchor, but for scroll SYNC it means the
// mirrored device eases toward each position and trails the one you're driving.
// Force instant scrolling inside every device so sync is 1:1.
// The element that actually scrolls a device's page. Usually the document - but app
// layouts (OutSystems Reactive, Angular/SPA shells) lock html/body at 100% height and
// scroll an inner container (.main-content…) instead, where window.scrollY stays 0
// and sync never saw a move. Then: the largest visible scrollable element.
// Cached per frame; re-checked twice a second while the page is still building.
//
// The element you ACTUALLY scrolled wins (f.__rvActive, set by a capturing 'scroll'
// listener in rvBindResponsiveFrames) - guessing "the largest scrollable box" alone
// picked the wrong one on real OutSystems pages.
const rvCanScrollY = (el) => el && el.isConnected && el.scrollHeight - el.clientHeight > 2;
function rvScroller(f) {
    const doc = f.contentDocument, win = f.contentWindow;
    if (!doc || !win) return null;
    const act = f.__rvActive;
    if (act && act.ownerDocument === doc && rvCanScrollY(act)) return act;
    const c = f.__rvScr;
    const now = Date.now();
    if (c && c.doc === doc && c.el.isConnected && now - c.at < 1000) return c.el;
    const se = doc.scrollingElement || doc.documentElement;
    // Vertical only: a page that overflows SIDEWAYS (common at phone widths) still
    // scrolls its content in an inner box - checking both axes chose the wrong one.
    let el = se;
    if (!rvCanScrollY(se)) {
        let area = 0;
        for (const x of doc.body ? doc.body.querySelectorAll('*') : []) {
            if (x.scrollHeight - x.clientHeight <= 2) continue;          // cheap test first
            const oy = win.getComputedStyle(x).overflowY;
            if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
            const a = x.clientWidth * x.clientHeight;
            if (a > area) { area = a; el = x; }
        }
    }
    f.__rvScr = { doc, el, at: now };
    return el;
}

// The same scroll box in another device: the page itself, or - like BrowserSync - the
// element with the same tag + index; then same id / tag+classes; else that device's
// own main scroller.
function rvScrollTwin(src, g) {
    const doc = g.contentDocument; if (!doc) return null;
    const sdoc = src.ownerDocument;
    if (src === (sdoc.scrollingElement || sdoc.documentElement)) {
        const se = doc.scrollingElement || doc.documentElement;
        return rvCanScrollY(se) ? se : rvScroller(g);
    }
    const byIndex = rvByTagIndex(doc, src.tagName, rvTagIndex(src));
    if (rvCanScrollY(byIndex)) return byIndex;
    if (src.id) { const m = doc.getElementById(src.id); if (rvCanScrollY(m)) return m; }
    const cls = (src.getAttribute('class') || '').trim();
    if (cls) {
        for (const m of doc.getElementsByTagName(src.tagName)) {
            if ((m.getAttribute('class') || '').trim() === cls && rvCanScrollY(m)) return m;
        }
    }
    return rvScroller(g);
}

function rvNoSmoothScroll(doc) {
    try {
        let st = doc.getElementById('rv-smooth-style');
        if (!st) { st = doc.createElement('style'); st.id = 'rv-smooth-style'; doc.head.appendChild(st); }
        st.textContent = `html,body{scroll-behavior:auto !important;}`;
    } catch (e) { }
}
function rvApplyOutline(doc, on) {
    try {
        let st = doc.getElementById('rv-outline-style');
        if (on) {
            if (!st) { st = doc.createElement('style'); st.id = 'rv-outline-style'; doc.head.appendChild(st); }
            st.textContent = `* { outline: 1px solid rgba(139,92,246,0.45) !important; } div{outline-color:rgba(96,165,250,0.4) !important;} img,picture,svg,video{outline-color:rgba(16,185,129,0.6) !important;}`;
        } else if (st) { st.remove(); }
    } catch (e) { }
}
function rvWireFrames() {
    const o = document.getElementById('qa-rv'); if (!o) return;
    o.querySelectorAll('iframe').forEach(f => {
        const decorate = () => {
            let doc, win;
            try { doc = f.contentDocument; win = f.contentWindow; } catch (e) { return; }
            if (!doc || !win) return;
            // Touch MEDIA emulation stays (hover:none, coarse pointer, maxTouchPoints
            // - so sites render their real mobile UI), but NOT the circle touch-cursor
            // gimmick, which was removed.
            // Deterministic: read the touch decision stamped on the frame at render time.
            const host = f.closest('[data-id]');
            const touchOn = !!host && host.dataset.touch === '1';
            win.__rvTouch = touchOn;                  // read live by the matchMedia patch
            rvPatchTouchMedia(win);
            rvKillHover(doc, touchOn);                // small screen -> no hover
            rvApplyCursor(doc, touchOn);              // small screen -> round touch cursor
            rvApplyOutline(doc, rvState.outline);
            rvHideScrollbar(doc, rvState.hideScroll); // controlled by the Scrollbar toggle
            rvNoSmoothScroll(doc);                    // kill CSS smooth-scroll so sync is instant
            if (doc.__rvBound) return;
            doc.__rvBound = true;
            // Remember WHICH box the user is scrolling (scroll doesn't bubble - capture
            // sees every element's). Only real input marks it: a wheel/touch/key/drag
            // just before, so our own mirrored scrolls don't steal the role.
            // Scroll sync is EVENT-driven, like BrowserSync (ResponsivelyApp): nothing runs
            // until the user scrolls, then one mirror per animation frame. The old rAF loop
            // read every device's scroll position 60x a second, forever.
            let userScrollAt = 0, pointerDown = false;
            const markUser = () => { userScrollAt = Date.now(); };
            ['wheel', 'touchmove', 'keydown'].forEach((ev) => win.addEventListener(ev, markUser, { capture: true, passive: true }));
            // Dragging the scrollbar can take longer than the 1.5s window - it counts as
            // long as the button is held.
            win.addEventListener('mousedown', () => { pointerDown = true; markUser(); }, { capture: true, passive: true });
            win.addEventListener('mouseup', () => { pointerDown = false; }, { capture: true, passive: true });
            doc.addEventListener('scroll', (e) => {
                if (Date.now() < (f.__rvApplyUntil || 0)) return;          // our own mirrored scroll arriving
                if (!pointerDown && Date.now() - userScrollAt > 1500) return;
                const t = e.target === doc ? (doc.scrollingElement || doc.documentElement) : e.target;
                if (!t || t.nodeType !== 1) return;
                f.__rvActive = t;
                if (rvState.sync) rvQueueScrollMirror(o, f, t);
            }, true);
            // Clicks and typing are mirrored the ResponsivelyApp / BrowserSync way: the
            // EXACT element clicked (no climbing to a parent), found in each other device by
            // tag + index, and only when that device is on the same page.
            win.addEventListener('click', (e) => {
                if (!rvState.sync || rvClicking || !e.isTrusted) return;
                const t = e.target; if (!t || t.nodeType !== 1) return;
                if (rvLooksDangerous(t)) { rvSyncLog('skip (logout-like)', t); return; }   // signing out of ONE device stays in that device
                const tag = t.tagName, idx = rvTagIndex(t), page = win.location.pathname;
                rvClicking = true;
                const results = [];
                o.querySelectorAll('iframe').forEach((other, i) => {
                    if (other === f) { results.push(`device${i + 1}: (you clicked here)`); return; }
                    let r;
                    try {
                        const ow = other.contentWindow, od = other.contentDocument;
                        const m = ow.location.pathname !== page ? null : rvByTagIndex(od, tag, idx);
                        if (ow.location.pathname !== page) r = 'other page - skipped';
                        else if (!m) r = `NO ELEMENT (${tag.toLowerCase()} #${idx})`;
                        else {
                            // A synthetic click event, like BrowserSync - also works on <svg>/<path>,
                            // which have no .click() method.
                            ow.setTimeout(() => m.dispatchEvent(new ow.MouseEvent('click', { bubbles: true, cancelable: true, view: ow })), 0);
                            r = 'clicked ' + rvDescribe(m);
                        }
                    } catch (x) { r = 'ERROR ' + (x && x.message || x); }
                    results.push(`device${i + 1}: ` + r);
                });
                rvSyncLog(`click ${tag.toLowerCase()} #${idx}`, t, results);
                setTimeout(() => { rvClicking = false; }, 80);
            }, true);
            win.addEventListener('input', (e) => {
                if (!rvState.sync || rvClicking || !e.isTrusted) return;
                const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
                rvClicking = true;
                const val = t.value, idx = rvTagIndex(t), page = win.location.pathname;
                o.querySelectorAll('iframe').forEach(other => {
                    if (other === f) return;
                    try {
                        const ow = other.contentWindow;
                        if (ow.location.pathname !== page) return;
                        const el = rvByTagIndex(other.contentDocument, t.tagName, idx);
                        if (el && 'value' in el) { el.value = val; el.dispatchEvent(new ow.Event('input', { bubbles: true })); el.dispatchEvent(new ow.Event('change', { bubbles: true })); }
                    } catch (x) { }
                });
                setTimeout(() => { rvClicking = false; }, 40);
            }, true);
        };
        if (!f.__rvLoadBound) { f.__rvLoadBound = true; f.addEventListener('load', decorate); }
        decorate();
    });
    rvStartSyncLoop();
}

let rvSyncLoopOn = false;
// Mirror one user scroll to every other device - at most once per animation frame
// (bursts of scroll events coalesce, like ResponsivelyApp). PROPORTIONALLY: each device
// goes to the same fraction of ITS OWN scroll range, so a short page moves slower and
// every device reaches the top/bottom together. Each follower gets a short "this scroll
// is ours" window so its own scroll event doesn't echo back - per device, never a shared
// lock, so the device you are scrolling is never blocked.
let rvScrollPending = null;
function rvQueueScrollMirror(o, f, el) {
    const first = !rvScrollPending;
    rvScrollPending = { o, f, el };
    if (!first) return;
    requestAnimationFrame(() => {
        const p = rvScrollPending; rvScrollPending = null;
        if (!p || !rvState || !rvState.sync) return;
        const range = (s) => ({ x: Math.max(0, s.scrollWidth - s.clientWidth), y: Math.max(0, s.scrollHeight - s.clientHeight) });
        const fr = range(p.el);
        const px = fr.x ? p.el.scrollLeft / fr.x : 0, py = fr.y ? p.el.scrollTop / fr.y : 0;
        for (const g of p.o.querySelectorAll('iframe')) {
            if (g === p.f) continue;
            try {
                const ge = rvScrollTwin(p.el, g); if (!ge) continue;
                const gr = range(ge);
                const tx = Math.round(px * gr.x), ty = Math.round(py * gr.y);
                if (Math.abs(ge.scrollLeft - tx) < 1 && Math.abs(ge.scrollTop - ty) < 1) continue;
                g.__rvApplyUntil = Date.now() + 150;
                ge.scrollTo({ left: tx, top: ty, behavior: 'instant' });
            } catch (e) { }                       // cross-origin frame - skip
        }
    });
}

// Keep hover suppression + touch cursor applied to each touch frame's CURRENT document:
// right away when the document changes (navigation), otherwise 5x a second - so an SPA
// that injects new :hover styles between routes gets them neutered quickly. A timer,
// not a 60fps rAF loop (scroll sync no longer needs one - see rvQueueScrollMirror).
function rvStartSyncLoop() {
    if (rvSyncLoopOn) return;
    rvSyncLoopOn = true;
    const tick = () => {
        const o = document.getElementById('qa-rv');
        if (!o) { rvSyncLoopOn = false; return; }   // overlay gone - stop
        for (const f of o.querySelectorAll('iframe')) {
            const host = f.closest('[data-id]');
            if (!host || host.dataset.touch !== '1') continue;
            let d; try { d = f.contentDocument; if (!d) continue; } catch (e) { continue; }
            if (f.__rvLastDoc !== d) f.__rvLastDoc = d;
            rvKillHover(d, true); rvApplyCursor(d, true);
        }
        setTimeout(tick, 200);
    };
    tick();
}

// ==================== Image Text Extractor (OCR) ====================
// Pick an image; the AI (smart model, vision) reads its text. Images only -
// if a non-image element is picked, ask the user to pick an image.

function closeImageOcrPanel() {
    const p = document.getElementById('ff-ocr-panel');
    if (p) p.remove();
}

// Find the image source for a picked element: <img>, or an element with a
// CSS background-image. Returns null if it isn't an image.
function getImageSrcFromElement(el) {
    if (el.tagName === 'IMG' && el.currentSrc) return el.currentSrc;
    if (el.tagName === 'IMG' && el.src) return el.src;
    try {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1] && !m[1].startsWith('data:image/svg')) return m[1];
    } catch (e) { }
    return null;
}

// Get the image as base64 FROM THE PAGE CONTEXT (it's already loaded here, with
// the right cookies/session) - more reliable than fetching it in the background.
async function getImageBase64(el, src) {
    const dataMatch = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(src || '');
    if (dataMatch) return { data: dataMatch[2], mediaType: dataMatch[1] };

    // 1) Fetch in the page origin (carries the page's cookies)
    try {
        const res = await fetch(src);
        if (res.ok) {
            const blob = await res.blob();
            if (/^image\/(jpeg|png|gif|webp)$/.test(blob.type)) {
                return { data: await blobToBase64(blob), mediaType: blob.type };
            }
        }
    } catch (e) { /* fall through to canvas */ }

    // 2) Canvas from the <img> (works for same-origin or CORS-enabled images)
    try {
        const img = el.tagName === 'IMG' ? el : null;
        if (img && img.complete && img.naturalWidth) {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/png'); // throws if tainted
            return { data: dataUrl.split(',')[1], mediaType: 'image/png' };
        }
    } catch (e) { /* tainted/cross-origin */ }

    return null;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

async function handleImageOcrPick(el) {
    const src = getImageSrcFromElement(el);
    if (!src) {
        // Not an image - tell the user and let them pick again
        showFabAiStatus('error', 'Pick an image (this tool works on images only)');
        startInspectMode(handleImageOcrPick);
        return;
    }
    showFabAiStatus('loading', 'Reading text from the image…');

    const img = await getImageBase64(el, src);
    if (!img) {
        showFabAiStatus('error', "Couldn't read this image (it may be protected)");
        return;
    }

    chrome.runtime.sendMessage({ action: 'aiExtractImageText', imageData: img.data, mediaType: img.mediaType }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error || resp.text === undefined) {
            const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown';
            showFabAiStatus('error', err === 'no_api_key' ? 'AI key is not configured' : ('Failed: ' + err));
            return;
        }
        showFabAiStatus('success', 'Text extracted');
        showImageOcrPanel(resp.text || '(no text found)');
    });
}

function showImageOcrPanel(text) {
    closeImageOcrPanel();
    const panel = document.createElement('div');
    panel.id = 'ff-ocr-panel';
    panel.innerHTML = `
        <style>
            #ff-ocr-panel {
                position: fixed; top: 16px; right: 16px; width: 360px; max-height: 80vh;
                z-index: 2147483647; display: flex; flex-direction: column;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 2px solid rgba(139, 92, 246, 0.5); border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.7); color: #fff;
                font-family: 'Segoe UI', Arial, sans-serif; direction: ltr;
            }
            #ff-ocr-panel .ocr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: move; user-select: none; }
            #ff-ocr-panel .ocr-title { font: 700 13px/1.4 'Segoe UI', Arial; display: flex; align-items: center; gap: 8px; }
            #ff-ocr-panel .ocr-btns { display: flex; gap: 6px; }
            #ff-ocr-panel .ocr-btns button { background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; font-size: 13px; }
            #ff-ocr-panel .ocr-btns button:hover { background: rgba(255,255,255,0.22); }
            #ff-ocr-panel .ocr-text { margin: 12px 14px; padding: 10px 12px; background: rgba(0,0,0,0.35); border-radius: 8px; font: 13px/1.7 'Segoe UI', Tahoma, sans-serif; color: #e2e8f0; white-space: pre-wrap; word-break: break-word; overflow-y: auto; }
            #ff-ocr-panel .ocr-copy { margin: 0 14px 14px; border: none; border-radius: 8px; padding: 9px; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff; background: linear-gradient(135deg, #8b5cf6, #6366f1); }
            #ff-ocr-panel .ocr-copy:hover { filter: brightness(1.12); }
        </style>
        <div class="ocr-head">
            <span class="ocr-title">&#128196; Extracted Text</span>
            <div class="ocr-btns">
                <button id="ocr-repick" title="Pick another image">&#8982;</button>
                <button id="ocr-close" title="Close">&#10005;</button>
            </div>
        </div>
        <div class="ocr-text" id="ocr-text"></div>
        <button class="ocr-copy" id="ocr-copy"><i class="fas fa-copy"></i> Copy text</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#ocr-text').textContent = text;
    panel.querySelector('#ocr-close').addEventListener('click', closeImageOcrPanel);
    panel.querySelector('#ocr-repick').addEventListener('click', () => {
        closeImageOcrPanel();
        startInspectMode(handleImageOcrPick);
    });
    panel.querySelector('#ocr-copy').addEventListener('click', (e) => {
        ffCopyText(text).then(() => {
            const b = e.currentTarget; const o = b.innerHTML;
            b.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => { b.innerHTML = o; }, 1400);
        }).catch(() => { });
    });

    // Drag by the header
    let drag = null;
    const head = panel.querySelector('.ocr-head');
    head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.preventDefault();
    });
    const move = (e) => { if (!drag) return; panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px'; panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px'; panel.style.right = 'auto'; };
    const up = () => { drag = null; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
}

// ==================== XPath Finder (Tools tab) ====================
// Two standalone tools: "XPath Finder" (extension-generated, instant) and
// "AI XPath Finder" (Claude builds a robust relative XPath from stable
// attributes). Both verify the result against the live page.

let xpathFinderDragCleanup = null;

function closeXPathFinderPanel() {
    if (xpathFinderDragCleanup) {
        xpathFinderDragCleanup();
        xpathFinderDragCleanup = null;
    }
    const p = document.getElementById('ff-xpath-panel');
    if (p) p.remove();
    clearHighlights();
}

const FFX_COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const FFX_EYE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
function ffShowHlToast(msg) {
    let t = document.getElementById('ff-hl-toast');
    if (!t) {
        t = document.createElement('div'); t.id = 'ff-hl-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;padding:8px 16px;border-radius:8px;font:13px Segoe UI,Arial;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.4);';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(t._timer); t._timer = setTimeout(() => { t.remove(); }, 1500);
}
const FFX_CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// Evaluate an XPath and return all matching nodes (null = invalid syntax)
function evaluateXPathAll(xp) {
    try {
        const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const nodes = [];
        for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i));
        return nodes;
    } catch (e) {
        return null;
    }
}

function showXPathFinderPanel(el, mode) {
    closeXPathFinderPanel();

    const isAi = mode === 'ai';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const tagLabel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');

    const panel = document.createElement('div');
    panel.id = 'ff-xpath-panel';
    panel.innerHTML = `
        <style>
            #ff-xpath-panel {
                position: fixed; top: 16px; right: 16px; width: 340px;
                z-index: 2147483647;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 2px solid rgba(${isAi ? '139, 92, 246' : '14, 165, 233'}, 0.5); border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.7);
                font-family: 'Segoe UI', Arial, sans-serif; color: #fff; direction: ltr;
                padding: 14px;
            }
            #ff-xpath-panel .ffx-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; cursor: move; user-select: none; }
            #ff-xpath-panel .ffx-title { font: 700 13px/1.4 'Segoe UI', Arial, sans-serif; }
            #ff-xpath-panel .ffx-btns { display: flex; gap: 6px; }
            #ff-xpath-panel .ffx-btns button {
                background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer;
                width: 24px; height: 24px; border-radius: 6px; font-size: 12px;
            }
            #ff-xpath-panel .ffx-btns button:hover { background: rgba(255,255,255,0.22); }
            #ff-xpath-panel .ffx-tag { font: 12px/1.5 monospace; color: rgba(255,255,255,0.55); margin-bottom: 10px; word-break: break-all; }
            #ff-xpath-panel .ffx-out {
                background: rgba(0,0,0,0.35); border-radius: 7px; padding: 8px 10px;
                font: 12px/1.6 'Segoe UI', Tahoma, monospace; color: #c7d2fe; word-break: break-all;
                min-height: 20px; flex: 1;
            }
            #ff-xpath-panel .ffx-row { margin-bottom: 10px; }
            #ff-xpath-panel .ffx-row-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 11px; }
            #ff-xpath-panel .ffx-row-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.6); }
            #ff-xpath-panel .ffx-badge {
                background: linear-gradient(135deg, #8b5cf6, #6366f1); color: #fff; font-size: 9px;
                padding: 2px 7px; border-radius: 8px; margin-left: 6px; text-transform: none; letter-spacing: 0;
            }
            #ff-xpath-panel .ffx-rec .ffx-out { border: 1px solid rgba(139, 92, 246, 0.7); }
            #ff-xpath-panel .ffx-out-wrap { display: flex; gap: 6px; align-items: stretch; }
            #ff-xpath-panel .ffx-copy-icon {
                background: rgba(255,255,255,0.1); border: none; color: rgba(255,255,255,0.75);
                cursor: pointer; border-radius: 7px; width: 30px; flex-shrink: 0;
                display: flex; align-items: center; justify-content: center;
            }
            #ff-xpath-panel .ffx-copy-icon:hover { background: rgba(255,255,255,0.25); color: #fff; }
            #ff-xpath-panel .ffx-hl-icon {
                background: rgba(34,197,94,0.15); border: none; color: #4ade80;
                cursor: pointer; border-radius: 7px; width: 30px; flex-shrink: 0;
                display: flex; align-items: center; justify-content: center;
            }
            #ff-xpath-panel .ffx-hl-icon:hover { background: rgba(34,197,94,0.35); color: #fff; }
            #ff-xpath-panel .ffx-reason { margin-top: 4px; font-size: 11px; color: #c4b5fd; line-height: 1.5; }
            #ff-xpath-panel .ffx-loading { color: rgba(255,255,255,0.45); font-size: 12px; padding: 6px 0; }
        </style>
        <div class="ffx-head">
            <span class="ffx-title">${isAi ? '&#10024; AI Locator Finder' : '&#127919; XPath Finder'}</span>
            <div class="ffx-btns">
                <button id="ffx-repick" title="Pick another element">&#8982;</button>
                <button id="ffx-close" title="Close">&#10005;</button>
            </div>
        </div>
        <div class="ffx-tag">${escapeHtml(tagLabel)}</div>
        <div id="ffx-body">${isAi ? '<div class="ffx-loading">&#10024; AI is analyzing the element...</div>' : ''}</div>
    `;
    document.body.appendChild(panel);

    const body = panel.querySelector('#ffx-body');

    panel.querySelector('#ffx-close').addEventListener('click', closeXPathFinderPanel);
    qaAddMinimize(panel, panel.querySelector('.ffx-head'), panel.querySelector('#ffx-close'));
    panel.querySelector('#ffx-repick').addEventListener('click', () => {
        closeXPathFinderPanel();
        startInspectMode((picked) => showXPathFinderPanel(picked, mode));
    });

    // Drag the panel around by its header (same as the Element Inspector)
    let dragOffset = null;
    const headEl = panel.querySelector('.ffx-head');
    const onDragStart = (e) => {
        if (e.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
    };
    const onDragMove = (e) => {
        if (!dragOffset) return;
        panel.style.left = Math.max(0, e.clientX - dragOffset.dx) + 'px';
        panel.style.top = Math.max(0, e.clientY - dragOffset.dy) + 'px';
        panel.style.right = 'auto';
    };
    const onDragEnd = () => { dragOffset = null; };
    headEl.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    xpathFinderDragCleanup = () => {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
    };

    // Validate any locator against the live page
    const validate = (type, value) => {
        if (!value) return { state: 'invalid', count: 0 };
        let nodes = null;
        if (type === 'xpath') nodes = evaluateXPathAll(value);
        else { try { nodes = Array.from(document.querySelectorAll(value)); } catch (e) { nodes = null; } }
        if (nodes === null) return { state: 'invalid', count: 0 };
        if (nodes.length === 1 && nodes[0] === el) return { state: 'unique', count: 1 };
        if (nodes.includes(el)) return { state: 'multi', count: nodes.length };
        return { state: 'none', count: nodes.length };
    };

    const statusHtml = (v) =>
        v.state === 'unique' ? '<span style="color:#4ade80;">&#10003; unique</span>'
            : v.state === 'multi' ? `<span style="color:#fbbf24;">&#9888; matches ${v.count} elements</span>`
                : v.state === 'none' ? '<span style="color:#f87171;">&#10007; no match</span>'
                    : '<span style="color:#f87171;">&#10007; invalid</span>';

    // Copy values are kept in an array (not in HTML attributes) so quotes in
    // selectors can never break the markup
    const copyValues = [];
    const rowHtml = (label, value, v, isRec) => {
        const idx = copyValues.push(value) - 1;
        return `
        <div class="ffx-row${isRec ? ' ffx-rec' : ''}">
            <div class="ffx-row-head"><span class="ffx-row-label">${label}${isRec ? '<span class="ffx-badge">Recommended</span>' : ''}</span>${v ? statusHtml(v) : ''}</div>
            <div class="ffx-out-wrap">
                <div class="ffx-out">${escapeHtml(value)}</div>
                <button class="ffx-hl-icon" data-hl="${idx}" title="Highlight matches on the page">${FFX_EYE_SVG}</button>
                <button class="ffx-copy-icon" data-idx="${idx}" title="Copy">${FFX_COPY_SVG}</button>
            </div>
        </div>`;
    };

    body.addEventListener('click', (e) => {
        const hl = e.target.closest('.ffx-hl-icon');
        if (hl) {
            const r = highlightSelector(copyValues[+hl.dataset.hl] || '');
            ffShowHlToast(r && r.error ? ('Invalid: ' + r.error) : `${(r && r.count) || 0} match(es) highlighted`);
            return;
        }
        const btn = e.target.closest('.ffx-copy-icon');
        if (!btn) return;
        ffCopyText(copyValues[+btn.dataset.idx] || '').then(() => {
            btn.innerHTML = FFX_CHECK_SVG;
            setTimeout(() => { btn.innerHTML = FFX_COPY_SVG; }, 1100);
        }).catch(() => { });
    });

    if (!isAi) {
        // Extension-generated XPath: instant and free (no verification badge -
        // the live check is part of what makes the AI tool premium)
        let xpath = '';
        try { xpath = generateXPath(el) || generateSelector(el); } catch (e) { }
        body.innerHTML = rowHtml('XPath', xpath || '(could not generate an XPath)', null, false);
        return;
    }

    // AI mode: send the element context to Claude, along with what the local
    // generator produced - the AI must offer a DIFFERENT robust alternative.
    // Results are verified locally; non-unique ones go BACK to the AI with
    // feedback (up to 2 retries), then get an index appended as a last resort.
    const context = collectAiXPathContext(el);
    let extensionXpath = '';
    try { extensionXpath = generateXPath(el) || ''; } catch (e) { }

    const askAi = (feedback) => new Promise((resolve) => {
        chrome.runtime.sendMessage(
            { action: 'aiGenerateXPath', context, extensionXpath, url: location.href, feedback },
            (resp) => {
                if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                else resolve(resp || { error: 'no response' });
            }
        );
    });

    (async () => {
        const LOCATOR_KEYS = ['xpath', 'cssSelector', 'attributeSelector'];
        const LABELS = { xpath: 'XPath', cssSelector: 'CSS Selector', attributeSelector: 'Attribute' };
        let feedback = null;
        let result = null;
        let checks = null;
        let present = [];

        for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) {
                body.innerHTML = `<div class="ffx-loading">Refining locators... (attempt ${attempt}/3)</div>`;
            }
            const resp = await askAi(feedback);
            if (resp.error || !resp.xpath) {
                body.innerHTML = `<div class="ffx-loading" style="color:#f87171;">Failed: ${escapeHtml(resp.error || 'no response')}</div>`;
                return;
            }
            result = resp;
            // Only the locator types the AI could build robustly (empty string
            // = not achievable for this element, e.g. no stable attribute)
            present = LOCATOR_KEYS.filter(k => result[k] && String(result[k]).trim());
            checks = {};
            for (const k of present) checks[k] = validate(k === 'xpath' ? 'xpath' : 'css', result[k]);
            if (present.every(k => checks[k].state === 'unique')) break;

            // Tell the AI exactly what the live page said about each locator
            feedback = 'Live verification results: ' + present.map(k => {
                const c = checks[k];
                const verdict = c.state === 'unique' ? 'OK, unique'
                    : c.state === 'multi' ? `matched ${c.count} elements - NOT unique`
                        : c.state === 'none' ? 'did NOT match the target element'
                            : 'INVALID syntax';
                return `${k} ${result[k]} -> ${verdict}`;
            }).join('; ') + '. Keep the locators that are OK and fix the failing ones so each matches exactly the one target element.';
        }

        // Last resort: force the XPath unique with an index (same trick the
        // local generator uses)
        if (checks.xpath && checks.xpath.state === 'multi') {
            const nodes = evaluateXPathAll(result.xpath);
            if (nodes && nodes.includes(el)) {
                result.xpath = `(${result.xpath})[${nodes.indexOf(el) + 1}]`;
                checks.xpath = validate('xpath', result.xpath);
            }
        }

        // Recommend the AI's pick if it verified unique, otherwise the first
        // locator that did
        let rec = result.recommended;
        if (!present.includes(rec) || !checks[rec] || checks[rec].state !== 'unique') {
            const firstUnique = present.find(k => checks[k].state === 'unique');
            if (firstUnique) rec = firstUnique;
        }

        body.innerHTML =
            present.map(k => rowHtml(LABELS[k], result[k], checks[k], rec === k)).join('') +
            (result.reason ? `<div class="ffx-reason">&#128161; ${escapeHtml(result.reason)}</div>` : '');
    })();
}

// Compact description of an element + its ancestors for AI XPath generation
// ── AI Automation Code ──────────────────────────────────────────────────────
// The settings were chosen in the panel; what the user actually WANTS is asked
// here, on the page, next to the element it is about - because that is the only
// place the question makes sense.
let qaAutoCfg = null;    // { framework, language, pom } carried in from the panel

function showAutomationPanel(el) {
    const ctx = collectAiXPathContext(el);
    const cfg = qaAutoCfg || { framework: 'playwright', language: 'typescript', pom: false };
    const fwLabel = cfg.frameworkLabel || cfg.framework;
    const langLabel = cfg.languageLabel || cfg.language;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
    const body = qaOpenPanel('<i class="fas fa-code"></i> AI Automation Code', 'automation');

    const summary = `<${ctx.tag}>` + (ctx.text ? ` "${ctx.text.slice(0, 40)}"` : '');

    body.innerHTML = `
        <style>
            .qa-auto-el { display:flex; align-items:center; gap:8px; background:rgba(16,185,129,.09); border:1px solid rgba(16,185,129,.25);
                          border-radius:10px; padding:9px 11px; font-size:12px; color:#6ee7b7; margin-bottom:10px; }
            .qa-auto-el code { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; color:#a7f3d0; }
            .qa-auto-cfg { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
            .qa-auto-tag { font-size:10.5px; font-weight:700; color:#94a3b8; background:rgba(255,255,255,.06);
                           border-radius:20px; padding:4px 10px; }
            .qa-auto-ta { width:100%; box-sizing:border-box; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.14);
                          border-radius:10px; color:#fff; padding:10px 12px; font-size:13px; outline:none; resize:vertical;
                          min-height:64px; font-family:inherit; }
            .qa-auto-ta:focus { border-color:#10b981; }
            .qa-auto-go { width:100%; margin-top:9px; border:none; border-radius:10px; padding:11px; font-size:13px; font-weight:700;
                          cursor:pointer; color:#fff; background:linear-gradient(135deg,#10b981,#0d9488);
                          display:flex; align-items:center; justify-content:center; gap:8px; }
            .qa-auto-go:hover { filter:brightness(1.08); }
            .qa-auto-go:disabled { opacity:.6; cursor:not-allowed; }
            .qa-auto-out { margin-top:12px; }

            /* Verified badge: the locator was RUN on this page and hit exactly one
               element. Worth saying loudly - it is what separates code you can trust
               from code you have to go and check by hand. */
            .qa-auto-ok { display:flex; gap:9px; background:rgba(16,185,129,.1); border:1px solid rgba(16,185,129,.3);
                          border-radius:10px; padding:10px 12px; font-size:11.5px; color:#a7f3d0; line-height:1.6; }
            .qa-auto-ok > i { color:#10b981; margin-top:2px; flex-shrink:0; }
            /* min-width:0. A flex child defaults to min-width:auto, which means it
               refuses to shrink below its content - so a long locator pushed the whole
               badge out past the edge of the panel instead of wrapping or scrolling. */
            .qa-auto-ok > div { flex:1; min-width:0; overflow-wrap:anywhere; }
            .qa-auto-ok b { color:#6ee7b7; }
            .qa-auto-ok code { display:block; margin-top:5px; font-family:ui-monospace,Menlo,monospace; font-size:11px;
                               color:#e2e8f0; background:rgba(0,0,0,.3); border-radius:6px; padding:6px 8px;
                               max-width:100%; box-sizing:border-box;
                               overflow-x:auto; white-space:pre; }
            .qa-auto-ok code::-webkit-scrollbar { height:6px; }
            .qa-auto-ok code::-webkit-scrollbar-thumb { background:rgba(255,255,255,.2); border-radius:3px; }
            .qa-auto-why { display:block; margin-top:5px; color:#7dd3b0; }

            /* The file name and its buttons were on one row, and the Download button
               fell off the end of a panel this narrow. The name gets the row; the
               buttons get their own. */
            .qa-auto-file { margin-top:14px; }
            .qa-auto-name { display:block; font-size:11.5px; font-weight:700; color:#cbd5e1;
                            font-family:ui-monospace,Menlo,monospace; margin-bottom:7px;
                            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .qa-auto-acts { display:flex; gap:7px; margin-bottom:7px; }
            .qa-auto-btn { flex:1; justify-content:center; border:none; border-radius:8px; padding:7px 10px; font-size:11.5px;
                           font-weight:700; cursor:pointer; color:#cbd5e1; background:rgba(255,255,255,.08);
                           display:flex; align-items:center; gap:6px; }
            .qa-auto-btn:hover { background:rgba(16,185,129,.3); color:#fff; }
            .qa-auto-btn.dl { background:linear-gradient(135deg,#10b981,#0d9488); color:#fff; }
            .qa-auto-btn.dl:hover { filter:brightness(1.08); }

            .qa-auto-code { margin:0; background:#0b1020; border:1px solid rgba(255,255,255,.1); border-radius:10px;
                            padding:12px; overflow:auto; max-height:280px; }
            .qa-auto-code::-webkit-scrollbar { width:8px; height:8px; }
            .qa-auto-code::-webkit-scrollbar-thumb { background:rgba(255,255,255,.16); border-radius:4px; }
            .qa-auto-code code { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; line-height:1.7; color:#e2e8f0;
                                 white-space:pre; display:block; }
            .qa-auto-note { margin-top:10px; font-size:11px; color:#94a3b8; line-height:1.55;
                            border-left:2px solid rgba(255,255,255,.12); padding-left:9px; }
            .qa-auto-err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.35); color:#fca5a5;
                           border-radius:10px; padding:11px; font-size:12px; line-height:1.6; }
            .qa-auto-err code { font-family:ui-monospace,Menlo,monospace; font-size:11px; }
        </style>
        <div class="qa-auto-el"><i class="fas fa-crosshairs"></i><code>${esc(summary)}</code></div>
        <div class="qa-auto-cfg">
            <span class="qa-auto-tag">${esc(fwLabel)}</span>
            <span class="qa-auto-tag">${esc(langLabel)}</span>
            ${cfg.pom ? '<span class="qa-auto-tag">Page Object</span>' : ''}
        </div>
        <textarea class="qa-auto-ta" id="qaAutoWhat"
            placeholder="What should the code do?&#10;e.g. assert the text is &quot;Saved&quot;, or click it and check the dialog closes"></textarea>
        <button class="qa-auto-go" id="qaAutoGo"><i class="fas fa-wand-magic-sparkles"></i> Generate code</button>
        <div class="qa-auto-out" id="qaAutoOut"></div>
    `;

    const what = body.querySelector('#qaAutoWhat');
    const go = body.querySelector('#qaAutoGo');
    const out = body.querySelector('#qaAutoOut');
    setTimeout(() => what.focus(), 60);

    const download = (name, text) => {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };

    const fileBlock = (name, code) => {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="qa-auto-file">
                <span class="qa-auto-name" title="${esc(name)}">${esc(name)}</span>
                <div class="qa-auto-acts">
                    <button class="qa-auto-btn qa-copy"><i class="fas fa-copy"></i> Copy</button>
                    <button class="qa-auto-btn dl qa-dl"><i class="fas fa-download"></i> Download</button>
                </div>
            </div>
            <pre class="qa-auto-code"><code>${esc(code)}</code></pre>`;
        wrap.querySelector('.qa-copy').addEventListener('click', (e) => {
            navigator.clipboard.writeText(code).then(() => {
                const b = e.currentTarget;
                b.innerHTML = '<i class="fas fa-check"></i> Copied';
                setTimeout(() => { b.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1200);
            }).catch(() => { });
        });
        wrap.querySelector('.qa-dl').addEventListener('click', () => download(name, code));
        return wrap;
    };

    const ask = (msg) => new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(resp || { error: 'no response' });
        });
    });

    // Run the locator the AI chose against THIS page. A selector that matches
    // nothing, or matches five things, is a test that will fail or - worse - quietly
    // act on the wrong element. Either way the model hears about it and tries again.
    const checkOnPage = (selector, type) => {
        let nodes;
        if (type === 'xpath') {
            nodes = evaluateXPathAll(selector);
            if (nodes === null) return { ok: false, why: `that XPath is not valid syntax: ${selector}` };
        } else {
            try { nodes = Array.from(document.querySelectorAll(selector)); }
            catch (e) { return { ok: false, why: `that CSS selector is not valid syntax: ${selector}` }; }
        }
        if (nodes.length === 0) return { ok: false, why: `"${selector}" matched NOTHING on the live page.` };
        if (nodes.length > 1) return { ok: false, why: `"${selector}" matched ${nodes.length} elements - it must match exactly one.` };
        if (nodes[0] !== el) return { ok: false, why: `"${selector}" matched a different element (a <${nodes[0].tagName.toLowerCase()}>), not the one that was picked.` };
        return { ok: true, count: 1 };
    };

    const err = (html) => { out.innerHTML = `<div class="qa-auto-err">${html}</div>`; };
    const refusedHtml = `<b>That is not something this tool does.</b><br>
        It only writes test-automation code for the element you picked.
        Describe what you want tested &mdash; an assertion, a click, a form fill.`;

    go.addEventListener('click', async () => {
        const description = (what.value || '').trim();
        if (!description) { what.focus(); return; }

        go.disabled = true;
        out.innerHTML = '';

        // ── pass 1: the AI studies the element and picks a locator; the PAGE checks
        // it. Up to three goes, and it is shown EVERY failure so far - told only the
        // last one, it would cycle back round to an answer it had already been told
        // was wrong. ──
        let verified = null;
        const failures = [];
        for (let attempt = 0; attempt < 3 && !verified; attempt++) {
            go.innerHTML = attempt === 0
                ? '<i class="fas fa-spinner fa-spin"></i> Studying the element…'
                : `<i class="fas fa-spinner fa-spin"></i> That locator missed &mdash; trying another…`;

            const a = await ask({
                action: 'aiAnalyseElement',
                framework: cfg.framework,
                description,
                element: ctx,
                url: location.href,
                feedback: failures.length ? failures : undefined,
                // On the final go, a brittle-but-unique anchor beats no answer at
                // all - some pages really do offer nothing stable. It has to admit
                // to the brittleness, which the badge then shows.
                lastChance: attempt === 2,
            });

            if (a.error) {
                go.disabled = false;
                go.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate code';
                err(`<b>Could not generate:</b> ${esc(a.error === 'no_api_key' ? 'The AI key is not configured.' : a.error)}`);
                return;
            }
            if (a.refused) {
                go.disabled = false;
                go.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate code';
                err(refusedHtml);
                return;
            }

            const check = checkOnPage(a.verifySelector, a.verifyType);
            if (check.ok) verified = a;
            else failures.push(check.why);
        }

        // Three misses. Say so rather than handing over code built on a locator we
        // know does not find the element.
        if (!verified) {
            go.disabled = false;
            go.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate code';
            err(`<b>Could not find a locator that reliably matches this element.</b><br>
                 Tried ${failures.length}:<br>${failures.map((f) => '&bull; ' + esc(f)).join('<br>')}`);
            return;
        }

        // ── pass 2: write the code around the locator we just proved ──
        go.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Writing the code…';
        const resp = await ask({
            action: 'aiGenerateAutomation',
            framework: cfg.framework,
            language: cfg.language,
            pom: cfg.pom,
            description,
            element: ctx,
            url: location.href,
            verified,
        });

        go.disabled = false;
        go.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate code';

        if (resp.error) {
            err(`<b>Could not generate:</b> ${esc(resp.error === 'no_api_key' ? 'The AI key is not configured.' : resp.error)}`);
            return;
        }
        if (resp.refused) { err(refusedHtml); return; }

        out.innerHTML = '';

        // Say plainly that the locator was run on this page and hit exactly one
        // element - that is the difference between code you can trust and code you
        // have to go and check yourself.
        const badge = document.createElement('div');
        badge.className = 'qa-auto-ok';
        badge.innerHTML = `<i class="fas fa-circle-check"></i>
            <div><b>Verified on this page</b> &mdash; the locator matches this element and nothing else.
            <code>${esc(verified.locator)}</code>
            ${verified.reason ? `<span class="qa-auto-why">${esc(verified.reason)}</span>` : ''}</div>`;
        out.appendChild(badge);

        if (resp.pageObject) out.appendChild(fileBlock(resp.pageFile, resp.pageObject));
        out.appendChild(fileBlock(resp.testFile, resp.code));

        if (resp.notes) {
            const note = document.createElement('div');
            note.className = 'qa-auto-note';
            note.textContent = resp.notes;
            out.appendChild(note);
        }
    });
}

function collectAiXPathContext(el) {
    const attrs = {};
    for (const a of Array.from(el.attributes || [])) attrs[a.name] = a.value.slice(0, 80);

    const ancestors = [];
    let p = el.parentElement;
    let depth = 0;
    while (p && p !== document.body && depth < 5) {
        const pa = Array.from(p.attributes || []).map(a => `${a.name}="${a.value.slice(0, 60)}"`).join(' ');
        ancestors.push(`<${p.tagName.toLowerCase()}${pa ? ' ' + pa : ''}>`);
        p = p.parentElement;
        depth++;
    }

    let label = '';
    try {
        const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        label = ((labelEl && labelEl.innerText) || (el.closest('label') || {}).innerText || '').trim().slice(0, 100);
    } catch (e) { }

    return {
        tag: el.tagName.toLowerCase(),
        attributes: attrs,
        text: ((el.innerText || el.value || '') + '').trim().slice(0, 100),
        label,
        ancestors, // closest ancestor first
        sameTagCount: document.getElementsByTagName(el.tagName).length
    };
}

function setContextFieldValue(el, value) {
    if (el.isContentEditable) {
        try {
            el.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
            if (!document.execCommand('insertText', false, value)) {
                el.innerHTML = '';
                el.appendChild(document.createTextNode(value));
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            }
        } catch (e) { }
        return;
    }
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}
// Brief on-page "Copied" toast (bottom-center), shown after any copy action.
let ffCopyToastTimer = null;
function ffShowCopyToast() {
    let t = document.getElementById('ff-copy-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'ff-copy-toast';
        t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;' +
            'background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:9px 18px;border-radius:24px;' +
            'font-family:\'Segoe UI\',Arial,sans-serif;font-size:13px;font-weight:600;box-shadow:0 8px 26px rgba(0,0,0,0.4);' +
            'display:flex;align-items:center;gap:8px;pointer-events:none;transition:opacity 0.25s;';
        t.innerHTML = '<i class="fas fa-check"></i><span>Copied</span>';
        document.body.appendChild(t);
    }
    t.style.opacity = '1';
    if (ffCopyToastTimer) clearTimeout(ffCopyToastTimer);
    ffCopyToastTimer = setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 300);
    }, 1400);
}

// Copy helper: copies text and shows the toast. Returns the promise so callers
// can still chain their own button feedback. (bracket call avoids being caught
// by the writeText -> ffCopyText replacement)
function ffCopyText(t) {
    const p = navigator.clipboard['writeText'](t == null ? '' : t);
    p.then(() => ffShowCopyToast()).catch(() => { });
    return p;
}

// On-page status pill for AI fill triggered from the floating button (the side
// panel can't show progress for a page action, so we surface it on the page).
let fabAiStatusTimer = null;
function showFabAiStatus(state, message) {
    let pill = document.getElementById('ff-ai-status');
    if (!pill) {
        pill = document.createElement('div');
        pill.id = 'ff-ai-status';
        pill.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
            'display:flex;align-items:center;gap:10px;padding:11px 18px;border-radius:30px;' +
            'font-family:\'Segoe UI\',Arial,sans-serif;font-size:13px;font-weight:600;color:#fff;' +
            'box-shadow:0 8px 30px rgba(0,0,0,0.45);transition:opacity 0.3s;';
        document.body.appendChild(pill);
    }
    if (fabAiStatusTimer) { clearTimeout(fabAiStatusTimer); fabAiStatusTimer = null; }

    const icon = state === 'loading'
        ? '<i class="fas fa-spinner fa-spin"></i>'
        : state === 'success' ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-circle-exclamation"></i>';
    const bg = state === 'loading'
        ? 'linear-gradient(135deg,#8b5cf6,#6366f1)'
        : state === 'success' ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#ef4444,#dc2626)';
    pill.style.background = bg;
    pill.style.opacity = '1';
    pill.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;

    if (state !== 'loading') {
        fabAiStatusTimer = setTimeout(() => {
            pill.style.opacity = '0';
            setTimeout(() => pill.remove(), 350);
        }, state === 'success' ? 2500 : 4500);
    }
}

// Styled name dialog for "Save current login" from the FAB (no ugly
// window.prompt). Returns a Promise<string|null>: the trimmed name, or null.
function qaSwapNamePrompt() {
    return new Promise((resolve) => {
        const prev = document.getElementById('qa-swap-name-ov');
        if (prev) prev.remove();
        const done = (val) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(val); };
        const ov = document.createElement('div');
        ov.id = 'qa-swap-name-ov';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.66);backdrop-filter:blur(2px);font-family:Segoe UI,-apple-system,Roboto,sans-serif;direction:ltr;';
        const box = document.createElement('div');
        box.style.cssText = 'width:320px;max-width:86vw;background:#131a2b;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.55);';
        box.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;color:#fff;margin-bottom:15px;">' +
            '<span style="width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:15px;">💾</span>' +
            'Save this login as</div>' +
            '<input id="qa-swap-name-in" type="text" placeholder="e.g. Admin" autocomplete="off" ' +
            'style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#fff;padding:12px;font-size:14px;outline:none;margin-bottom:18px;">' +
            '<div style="display:flex;gap:9px;justify-content:flex-end;">' +
            '<button id="qa-swap-cancel" style="border:none;border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;background:rgba(255,255,255,.1);color:#cbd5e1;">Cancel</button>' +
            '<button id="qa-swap-ok" style="border:none;border-radius:10px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#10b981,#059669);color:#fff;">Save</button>' +
            '</div>';
        ov.appendChild(box);
        (document.body || document.documentElement).appendChild(ov);
        const input = box.querySelector('#qa-swap-name-in');
        const ok = () => done((input.value || '').trim() || null);
        const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.preventDefault(); done(null); } };
        box.querySelector('#qa-swap-ok').addEventListener('click', ok);
        box.querySelector('#qa-swap-cancel').addEventListener('click', () => done(null));
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => input.focus(), 30);
    });
}

function createFloatingButton() {
    // 1. Style Setup
    if (!document.getElementById('ff-fab-styles')) {
        const style = document.createElement('style');
        style.id = 'ff-fab-styles';
        style.textContent = `
        #ff-floating-btn {
            position: fixed;
            bottom: 110px;
            right: 25px;
            width: 54px;
            height: 54px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 22px;
            cursor: pointer;
            box-shadow: 0 10px 25px -5px rgba(102, 126, 234, 0.5);
            z-index: 999999999;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            border: 2px solid rgba(255, 255, 255, 0.1);
        }
        #ff-floating-btn:hover {
            transform: scale(1.1) translateY(-5px);
            box-shadow: 0 8px 30px rgba(102, 126, 234, 0.6);
        }
        /* Logged in with a saved login: the user's name under the ⚡, and the button
           grows sideways to fit it (anchored right, so it widens to the left). */
        #ff-floating-btn.ff-has-login {
            width: auto;
            min-width: 54px;
            padding: 0 10px;
            box-sizing: border-box;
            flex-direction: column;
            gap: 3px;
        }
        /* ...plus a green "signed in" dot on the TOP-LEFT corner - the opposite corner
           to the notification count (top-right), so the two never overlap. */
        #ff-floating-btn.ff-has-login::after {
            content: '';
            position: absolute;
            top: -4px;
            left: -4px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #10b981;
            border: 2px solid #0f0f23;
            pointer-events: none;
        }
        #ff-floating-btn .ff-fab-user { display: none; }
        #ff-floating-btn.ff-has-login .ff-fab-user {
            display: block;
            max-width: 150px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font: 600 10px/1.1 -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
            color: #fff;
            direction: ltr;
        }
        #ff-floating-menu {
            position: fixed;
            bottom: 180px;
            right: 30px;
            direction: ltr;
            text-align: left;
            background: rgba(15, 15, 35, 0.95);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 8px;
            width: 270px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            z-index: 999999999;
            display: none;
            flex-direction: column;
            gap: 2px;
            animation: ff-slide-up 0.3s ease-out;
            /* Cap to the viewport (menu grows upward from bottom:180px) so a long
               list stays fully scrollable instead of clipping off the top. */
            max-height: calc(100vh - 200px);
            overflow-y: auto;
            overscroll-behavior: contain;
        }
        @keyframes ff-slide-up {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .ff-menu-item {
            padding: 8px 12px;
            border-radius: 9px;
            color: #e0e0e0;
            font-family: 'Segoe UI', sans-serif;
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            transition: all 0.2s;
        }
        .ff-menu-item:hover {
            background: rgba(102, 126, 234, 0.2);
            color: white;
        }
        .ff-menu-item.ff-action {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.07);
            margin-bottom: 3px;
        }
        .ff-menu-item.ff-action:hover {
            background: rgba(102, 126, 234, 0.22);
            border-color: rgba(102, 126, 234, 0.5);
        }
        .ff-menu-divider {
            height: 1px;
            background: rgba(255, 255, 255, 0.08);
            margin: 5px 4px;
        }
        .ff-menu-item i {
            color: #667eea;
            font-size: 16px;
        }
        .ff-menu-header {
            padding: 4px 12px 5px;
            font-size: 10px;
            font-weight: bold;
            color: #667eea;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 2px;
        }
        .ff-sub-profiles {
            margin-left: 18px;
            border-left: 2px solid rgba(102, 126, 234, 0.2);
            padding-left: 4px;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .ff-menu-item span {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 240px;
        }
        .ff-swap-badge {
            margin-left: auto;
            flex-shrink: 0;
            font-size: 9px;
            font-weight: 700;
            letter-spacing: .5px;
            color: #10b981;
            background: rgba(16, 185, 129, 0.15);
            padding: 2px 7px;
            border-radius: 20px;
            max-width: none;
        }
        .ff-swap-update {
            margin-left: auto;
            flex-shrink: 0;
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #64748b;
            cursor: pointer;
            max-width: none;
            transition: all 0.2s;
        }
        .ff-swap-badge + .ff-swap-update { margin-left: 4px; }
        .ff-swap-update:hover { background: rgba(16, 185, 129, 0.25); color: #10b981; }
        .ff-swap-update i { font-size: 12px; color: inherit; }
        /* Per-section scroll: a long login/profile list scrolls on its own so it
           never pushes the other sections out of reach. */
        .ff-swap-list, .ff-menu-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
            max-height: 170px;
            overflow-y: auto;
            overscroll-behavior: contain;
        }
        .ff-swap-list::-webkit-scrollbar, .ff-menu-list::-webkit-scrollbar,
        #ff-floating-menu::-webkit-scrollbar { width: 7px; }
        .ff-swap-list::-webkit-scrollbar-thumb, .ff-menu-list::-webkit-scrollbar-thumb,
        #ff-floating-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 4px; }
    `;
        document.head.appendChild(style);
    }

    // 2. Button and Menu Setup
    let btn = document.getElementById('ff-floating-btn');
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'ff-floating-btn';
        btn.innerHTML = `
            <svg width="22" height="22" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>
            <div id="ff-badge" style="position:absolute; top:-5px; right:-5px; background:#ef4444; color:white; font-size:10px; font-weight:bold; padding:2px 6px; border-radius:10px; border:2px solid #0f0f23; transition: all 0.2s;">0</div>
        `;
        document.body.appendChild(btn);

        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.1)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('ff-floating-menu');
            if (menu) {
                const isOpen = menu.style.display === 'flex';
                menu.style.display = isOpen ? 'none' : 'flex';
            }
        });
    }

    let menu = document.getElementById('ff-floating-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'ff-floating-menu';
        document.body.appendChild(menu);

        menu.addEventListener('click', async (e) => {
            // Save the current logged-in session under a name
            if (e.target.closest('#ff-menu-swap-save')) {
                menu.style.display = 'none';
                const name = await qaSwapNamePrompt();
                if (!name) return;
                showFabAiStatus('loading', `Saving "${name}"…`);
                const operationId = (crypto.randomUUID && crypto.randomUUID()) || `save_${Date.now()}_${Math.random()}`;
                chrome.runtime.sendMessage({ action: 'swapSave', name, operationId }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        showFabAiStatus('error', (resp && resp.error) || 'Could not save this login');
                    } else {
                        showFabAiStatus('success', `Saved "${name}"`);
                        initFloatingButton();   // refresh the list in the menu
                    }
                });
                return;
            }
            // ↻ Update a saved login with the session in use right now. Checked
            // before the row itself so it works on the CURRENT (no-click) row too.
            const updBtn = e.target.closest('.ff-swap-update');
            if (updBtn) {
                e.stopPropagation();
                menu.style.display = 'none';
                if (updBtn.dataset.active !== 'true' && !(await qaConfirm(
                    'This replaces the saved login with the login currently open in this tab.',
                    { title: 'Replace saved login?', confirmText: 'Replace', danger: true }
                ))) return;
                showFabAiStatus('loading', 'Updating saved login…');
                chrome.runtime.sendMessage({ action: 'swapUpdate', id: updBtn.dataset.swapId }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        showFabAiStatus('error', (resp && resp.error) || 'Could not update');
                    } else {
                        showFabAiStatus('success', `Updated "${resp.name}"`);
                        initFloatingButton();
                    }
                });
                return;
            }

            // Switch to a saved login (Snapshot & Swap) - the page reloads.
            // Skip the "current" one (marked no-click) so it can't be re-clicked.
            const swapItem = e.target.closest('.ff-swap-item');
            if (swapItem && swapItem.classList.contains('no-click')) return;
            if (swapItem) {
                menu.style.display = 'none';
                const id = swapItem.dataset.swapId;
                showFabAiStatus('loading', 'Switching login…');
                chrome.runtime.sendMessage({ action: 'swapRestore', id }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        showFabAiStatus('error', (resp && resp.error) || 'Could not switch');
                    }
                    // on success the tab reloads, so no toast needed
                });
                return;
            }

            // Open the current page in a private/incognito window
            if (e.target.closest('#ff-menu-incognito')) {
                menu.style.display = 'none';
                chrome.runtime.sendMessage({ action: 'openIncognito', url: location.href }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.success) {
                        showFabAiStatus('error', (resp && resp.error) || 'Could not open a private window');
                    } else {
                        showFabAiStatus('success', 'Opened in a private window');
                    }
                });
                return;
            }

            // Clear browsing data — runs using the options saved in Settings
            if (e.target.closest('#ff-menu-cleardata')) {
                menu.style.display = 'none';
                doClearData();
                return;
            }




            // Standalone "AI Fill" option - scan + AI-fill the current page
            const aiItem = e.target.closest('#ff-menu-ai-fill');
            if (aiItem) {
                menu.style.display = 'none';
                showFabAiStatus('loading', 'AI is analyzing the form…');
                chrome.runtime.sendMessage({ action: 'aiCreateProfile' }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.success) {
                        const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown';
                        const messages = {
                            no_form: 'No fillable form found on this page',
                            no_fields: 'No form fields found on this page',
                            no_values: 'Could not generate data for this form',
                            no_api_key: 'AI key is not configured',
                            profile_limit: 'Profile limit reached for this page'
                        };
                        showFabAiStatus('error', messages[err] || ('AI fill failed: ' + err));
                    } else {
                        showFabAiStatus('success', `Form filled (${resp.fieldCount} field${resp.fieldCount === 1 ? '' : 's'})`);
                    }
                });
                return;
            }

            const item = e.target.closest('.ff-menu-item');
            if (item && !item.classList.contains('no-click')) {
                const profileId = item.dataset.id;
                const profile = matchingProfiles.find(p => String(p.id) === String(profileId));
                if (profile) {
                    menu.style.display = 'none';
                    showFabAiStatus('loading', `Filling "${profile.name}"…`);
                    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
                        const settings = (response && response.settings) ? response.settings : { randomDigits: 5 };
                        fillFormFields({ fields: profile.fields, settings, profileId: profile.id, profileUrl: profile.url })
                            .then(() => showFabAiStatus('success', `Filled with "${profile.name}"`))
                            .catch(() => showFabAiStatus('error', 'Could not fill the form'));
                    });
                }
            }
        });
    }

    // 3. Update Content
    const badge = btn.querySelector('#ff-badge');
    if (badge) {
        badge.textContent = matchingProfiles.length;
        badge.style.display = matchingProfiles.length > 0 ? 'block' : 'none';
    }

    const renderMenuItems = (filter = '') => {
        const escHtml = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const truncateName = (name) => (!name ? '' : (name.length > 30 ? name.substring(0, 30) + '...' : name));

        // === Switch login group (Snapshot & Swap) - shown first, most used ===
        let menuHtml = `<div class="ff-menu-header">Switch login</div>`;
        menuHtml += `
            <div class="ff-menu-item ff-action" id="ff-menu-swap-save" title="Save the current logged-in session">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#10b981" style="flex-shrink:0;" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"/></svg>
                <span style="font-weight:600;">Save current login</span>
            </div>`;
        if (matchingLogins.length) menuHtml += `<div class="ff-swap-list">`;
        matchingLogins.forEach((s) => {
            // ↻ re-saves the session you're logged in as right now into this slot
            // (server sessions expire - refresh instead of delete + re-add).
            const refreshBtn = `<span class="ff-swap-update" data-swap-id="${escHtml(s.id)}" data-active="${s.active ? 'true' : 'false'}" title="Update this saved login with the session you're logged in as now"><i class="fas fa-rotate"></i></span>`;
            if (s.active) {
                // The login currently in use - shown as CURRENT and not clickable
                // (so you don't re-switch to yourself by accident).
                menuHtml += `
                    <div class="ff-menu-item ff-swap-item ff-active no-click" title="${s.activeConfidence === 'assumed' ? 'Cookie-only login; identity could not be verified' : 'You are using this login now'}" style="cursor:default;">
                        <i class="fas fa-circle-check" style="color:#10b981;"></i>
                        <span style="font-weight:600;">${escHtml(truncateName(s.name))}</span>
                        <span class="ff-swap-badge">${s.activeConfidence === 'assumed' ? 'LIKELY CURRENT' : 'CURRENT'}</span>
                        ${refreshBtn}
                    </div>`;
            } else {
                menuHtml += `
                    <div class="ff-menu-item ff-swap-item" data-swap-id="${escHtml(s.id)}" title="Switch to ${escHtml(s.name)}">
                        <i class="fas fa-user" style="color:#10b981;"></i>
                        <span>${escHtml(truncateName(s.name))}</span>
                        ${refreshBtn}
                    </div>`;
            }
        });
        if (matchingLogins.length) menuHtml += `</div>`;   // close .ff-swap-list
        menuHtml += `<div class="ff-menu-divider"></div>`;

        // Standalone "AI Fill" option at the very top (independent of profiles)
        // === Tools group (page utilities) - shown first ===
        menuHtml += `<div class="ff-menu-header">Tools</div>`;
        menuHtml += `
            <div class="ff-menu-item ff-action" id="ff-menu-incognito" title="Open this page in a private window (clean session)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#94a3b8" style="flex-shrink:0;" aria-hidden="true"><path d="M2 11l1.5-5A2 2 0 0 1 5.4 4.6h13.2a2 2 0 0 1 1.9 1.4L22 11v1H2v-1zm6 2.5A2.5 2.5 0 1 0 8 18a2.5 2.5 0 0 0 0-4.5zm8 0a2.5 2.5 0 1 0 0 4.5 2.5 2.5 0 0 0 0-4.5z"/></svg>
                <span style="font-weight:600;">Open in Incognito</span>
            </div>
            <div class="ff-menu-item ff-action" id="ff-menu-cleardata" title="Clear cache, cookies & storage for this site or all sites">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#f59e0b" style="flex-shrink:0;" aria-hidden="true"><path d="M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13H6zm4 3h1v8h-1v-8zm3 0h1v8h-1v-8z"/></svg>
                <span style="font-weight:600;">Clear browsing data</span>
            </div>
        `;
        menuHtml += `<div class="ff-menu-divider"></div>`;

        // === Form fill group: AI Fill + matching profiles ===
        menuHtml += `<div class="ff-menu-header">Form fill</div>`;
        if (fabAiFillEnabled) {
            menuHtml += `
                <div class="ff-menu-item ff-action" id="ff-menu-ai-fill" title="Let AI fill this form">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#a78bfa" style="flex-shrink:0;" aria-hidden="true"><path d="M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z"/></svg>
                    <span style="font-weight:600;">AI Fill this page</span>
                </div>
            `;
        }

        // The profiles section only appears when there are matching profiles
        if (matchingProfiles.length > 0) {
            menuHtml += `
                <div class="ff-menu-header" style="margin-top:10px;">Matching Profiles</div>
                <div class="ff-search-container" style="padding: 4px 2px 8px;">
                    <div style="position:relative;">
                        <i class="fas fa-search" style="position:absolute; left:10px; top:50%; transform:translateY(-50%); font-size:12px; color:#666;"></i>
                        <input type="text" id="ff-menu-search" placeholder="Search profiles..."
                            style="width:100%; padding:8px 8px 8px 30px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:white; font-size:12px; outline:none;"
                            value="${filter}">
                    </div>
                </div>`;
        }
        menuHtml += `<div class="ff-menu-list">`;

        const filteredProfiles = matchingProfiles.filter(p =>
            p.name.toLowerCase().includes(filter.toLowerCase()) ||
            (p.category && p.category.toLowerCase().includes(filter.toLowerCase()))
        );

        if (matchingProfiles.length === 0) {
            // AI-fill-only mode: nothing else to list
        } else if (filteredProfiles.length === 0) {
            menuHtml += `<div style="padding:20px; text-align:center; color:#666; font-size:13px;">No profiles found</div>`;
        } else {
            const parents = filteredProfiles.filter(p => !p.parentProfileId);
            const subProfiles = filteredProfiles.filter(p => p.parentProfileId);
            const renderedSubs = new Set();

            parents.forEach(parent => {
                menuHtml += `
                    <div class="ff-menu-item" data-id="${parent.id}" title="${parent.name}">
                        <i class="fas fa-file-alt"></i>
                        <span>${truncateName(parent.name)}</span>
                    </div>
                `;

                const children = subProfiles.filter(p => p.parentProfileId === parent.id);
                if (children.length > 0) {
                    menuHtml += `<div class="ff-sub-profiles">`;
                    children.forEach(child => {
                        menuHtml += `
                            <div class="ff-menu-item sub" data-id="${child.id}" title="${child.name}">
                                <i class="fas fa-level-up-alt fa-rotate-90" style="font-size: 12px; opacity: 0.6;"></i>
                                <span>${truncateName(child.name)}</span>
                            </div>
                        `;
                        renderedSubs.add(child.id);
                    });
                    menuHtml += `</div>`;
                }
            });

            // Orphanned sub-profiles
            subProfiles.forEach(sub => {
                if (!renderedSubs.has(sub.id)) {
                    menuHtml += `
                        <div class="ff-menu-item" data-id="${sub.id}" title="${sub.name}">
                            <i class="fas fa-file-alt"></i>
                            <span>${truncateName(sub.name)}</span>
                        </div>
                    `;
                }
            });
        }

        menuHtml += `</div>`;
        menu.innerHTML = menuHtml;

        const searchInput = menu.querySelector('#ff-menu-search');
        if (searchInput) {
            if (filter) {
                searchInput.focus();
                const val = searchInput.value;
                searchInput.value = '';
                searchInput.value = val;
            }

            searchInput.addEventListener('input', (e) => {
                renderMenuItems(e.target.value);
            });
            searchInput.addEventListener('click', (e) => e.stopPropagation());
        }
    };

    renderMenuItems();

    // Close menu when clicking outside
    if (!window.ffCloseListenerAdded) {
        document.addEventListener('click', () => {
            const m = document.getElementById('ff-floating-menu');
            if (m) m.style.display = 'none';
        });
        window.ffCloseListenerAdded = true;
    }

    // Our panels use FontAwesome icons. Ship it with the extension rather than
    // pulling it from a CDN: a CDN leaks the user's IP + every page they visit,
    // and pages with a strict style-src CSP would block it, leaving no icons.
    // Guard on our own id so we don't depend on whatever FA the page may load.
    if (!document.getElementById('qa-toolbox-fa')) {
        const fa = document.createElement('link');
        fa.id = 'qa-toolbox-fa';
        fa.rel = 'stylesheet';
        fa.href = chrome.runtime.getURL('vendor/fontawesome/css/all.min.css');
        (document.head || document.documentElement).appendChild(fa);
    }
}

/** 
 * Core Form Filling Logic 
 */
async function fillFormFields(fieldsData) {
    const { fields, settings, profileId, profileUrl } = fieldsData;

    // Check URL match before filling
    if (profileUrl) {
        const currentUrl = window.location.href;
        const urlMatch = await new Promise(resolve => {
            chrome.runtime.sendMessage({
                action: 'checkUrlMatch',
                currentUrl: currentUrl,
                profileUrl: profileUrl
            }, (response) => {
                if (chrome.runtime.lastError) resolve(true); // Fallback to filling if match check fails
                resolve(response && response.matches);
            });
        });

        if (!urlMatch) {
            console.log('URL mismatch, aborting fill');
            return { error: 'url_mismatch' };
        }
    }

    const failedFields = []; // Track fields that failed to fill

    function getElementsBySelector(selector) {
        if (!selector) return [];
        try {
            if (selector.startsWith('/') || selector.startsWith('//') || (selector.startsWith('(') && selector.includes('//'))) {
                const results = [];
                const query = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < query.snapshotLength; i++) {
                    results.push(query.snapshotItem(i));
                }
                return results;
            } else {
                return Array.from(document.querySelectorAll(selector));
            }
        } catch (e) {
            // Malformed/unsupported selector for this page - handled by skipping it
            console.warn('Skipping invalid selector:', selector);
            return [];
        }
    }

    // Custom dropdowns (<mat-select>, div/button comboboxes, readonly inputs…): open
    // the list, then click the option whose text matches the value. With
    // sequentialSelect, the choice cycles through the options instead (random start,
    // then in order) so repeated fills don't keep picking the same one.
    async function fillComboboxField(el, value, field) {
        try {
            const options = await ddOpen(el);
            if (options.length === 0) { await ddClose(el); return false; }

            let target;
            if (field && field.sequentialSelect) {
                // Sequential mode: cycle through the options (skip placeholder-looking ones)
                let pool = options.filter(o => {
                    const t = o.innerText.trim().toLowerCase();
                    return !(t.includes('select') || t.includes('choose') || t.includes('اختر') || t.includes('حدد') || t.includes('---'));
                });
                if (pool.length === 0) pool = options;

                const key = `${profileId}_${field.selector}`;
                const storedIndex = allIndices[key];
                // First fill starts at a RANDOM option; subsequent fills cycle in order
                const nextIndex = storedIndex === undefined
                    ? Math.floor(Math.random() * pool.length)
                    : (storedIndex + 1) % pool.length;
                target = pool[nextIndex];
                allIndices[key] = nextIndex;
                updatedAny = true;
            } else {
                const wanted = String(value || '').trim().toLowerCase();
                target =
                    options.find(o => o.innerText.trim().toLowerCase() === wanted) ||
                    (wanted && options.find(o => o.innerText.trim().toLowerCase().includes(wanted))) ||
                    (wanted && options.find(o => wanted.includes(o.innerText.trim().toLowerCase()))) ||
                    options[0];
            }

            await ddPick(target);
            // Picking normally closes the list; a multi-select one stays open and would
            // then be read as the NEXT field's list, so make sure it is gone.
            await ddClose(el);
            return true;
        } catch (e) {
            console.warn('Combobox fill failed:', e);
            try { await ddClose(el); } catch (e2) { }
            return false;
        }
    }

    function resolveSmartVariables(val) {
        if (typeof val !== 'string') return val;
        let processedValue = val;
        const now = new Date();
        const smartVars = {
            '{{date}}': () => now.toISOString().split('T')[0],
            '{{time}}': () => now.toTimeString().split(' ')[0],
            '{{datetime}}': () => now.toISOString().replace('T', ' ').split('.')[0],
            '{{year}}': () => now.getFullYear().toString(),
            '{{month}}': () => (now.getMonth() + 1).toString().padStart(2, '0'),
            '{{day}}': () => now.getDate().toString().padStart(2, '0'),
            '{{random_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)] + '_' + Math.floor(100 + Math.random() * 899);
            },
            '{{first_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)];
            },
            '{{last_name}}': () => {
                const names = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                return names[Math.floor(Math.random() * names.length)];
            },
            '{{full_name}}': () => {
                const first = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                const last = [
                    'Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'
                ];
                const f = first[Math.floor(Math.random() * first.length)];
                const l = last[Math.floor(Math.random() * last.length)];
                return `${f} ${l}`;
            },
            '{{username}}': () => {
                const names = ['Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'];
                return names[Math.floor(Math.random() * names.length)] + Math.floor(1000 + Math.random() * 89999);
            },
            '{{email}}': () => {
                const names = ['Ahmed', 'Mohamed', 'Mahmoud', 'Ali', 'Omar', 'Khaled', 'Youssef', 'Ibrahim', 'Hassan', 'Hussein', 'Zaid', 'Adam', 'Kareem', 'Mustafa', 'Tarek', 'Samer', 'Hany', 'Wael', 'Amr', 'Ashraf', 'Bassem', 'Ehab', 'Fady', 'Gamal', 'Hazem', 'Islam', 'Jaber', 'Kamal', 'Lotfy', 'Magdy', 'Nabil', 'Osama', 'Raafat', 'Saeed', 'Talaat', 'Yehia', 'Zakaria', 'Ayman', 'Sherif', 'Walid', 'Yasser', 'Mona', 'Sara', 'Laila', 'Mariam', 'Fatima', 'Nour', 'Salma', 'Hana', 'Maya', 'Reem', 'Yara', 'Jana', 'Habiba', 'Nada', 'Aya', 'Malak', 'Farida', 'Khadija', 'Zainab', 'Aisha', 'Rodina', 'Talia', 'Karma', 'Kenzy', 'Judy', 'Lara', 'Sandy', 'Perry', 'Sherine', 'Ghada', 'Heba', 'Dina', 'Noha', 'Mai', 'Rania', 'Shaimaa', 'Amira', 'Iman', 'Inas', 'Engy', 'Azza', 'Naglaa', 'Manal', 'Hanan', 'Sahar', 'Abeer'];
                const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'mail.com', 'icloud.com'];
                return names[Math.floor(Math.random() * names.length)] + '_' + Math.floor(1000 + Math.random() * 8999) + '@' + domains[Math.floor(Math.random() * domains.length)];
            },
            '{{phone}}': () => {
                const prefix = ['010', '011', '012', '015', '050', '055', '0100', '0111', '0122'];
                const p = prefix[Math.floor(Math.random() * prefix.length)];
                return p + Math.floor(1000000 + Math.random() * 8999999);
            },
            '{{password}}': () => {
                const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
                let pass = "";
                for (let i = 0; i < 16; i++) pass += charset.charAt(Math.floor(Math.random() * charset.length));
                return pass;
            },
            '{{address}}': () => {
                const streets = [
                    'Teseen St', 'Gameat Al Dowal St', 'Haram St', 'Kasr Al Nile St', 'Talaat Harb St', 'Fouad St', 'Al Moez St', 'Port Said St', 'Al Galaa St', 'Al Nasr St', 'Al Merghany St', 'Mossadak St', 'Mohie El Din Abu El Ezz St', 'Abbas Al Akkad St', 'Makram Ebeid St', 'El Batal Ahmed Abdel Aziz St'
                ];
                return Math.floor(1 + Math.random() * 1999) + ' ' + streets[Math.floor(Math.random() * streets.length)];
            },
            '{{city}}': () => {
                const cities = [
                    'Cairo', 'Alexandria', 'Giza', 'Mansoura', 'Tanta', 'Assiut', 'Sohag', 'Luxor', 'Aswan', 'Port Said', 'Suez', 'Ismailia', 'Sharm El Sheikh', 'Hurghada', 'Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam', 'Khobar', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Kuwait City', 'Doha', 'Manama', 'Muscat'
                ];
                return cities[Math.floor(Math.random() * cities.length)];
            },
            '{{country}}': () => {
                const countries = [
                    'Egypt', 'Saudi Arabia', 'UAE', 'Kuwait', 'Qatar', 'Bahrain', 'Oman', 'Jordan', 'Lebanon', 'Syria', 'Iraq', 'Palestine', 'Yemen', 'Libya', 'Tunisia', 'Algeria', 'Morocco', 'Sudan', 'Mauritania', 'Djibouti', 'Somalia', 'Comoros'
                ];
                return countries[Math.floor(Math.random() * countries.length)];
            },
            '{{zip_code}}': () => Math.floor(10000 + Math.random() * 89999).toString(),
            '{{company}}': () => {
                const companies = [
                    'Nile Co', 'Arab Group', 'Global IT', 'Oriental Weavers', 'Ezz Steel', 'Elsewedy Electric', 'Talaat Moustafa', 'Palm Hills', 'Emaar Misr', 'Orascom', 'Vodafone', 'Etisalat', 'Orange', 'Banque Misr', 'National Bank of Egypt', 'EgyptAir'
                ];
                return companies[Math.floor(Math.random() * companies.length)];
            },
            '{{job_title}}': () => {
                const titles = [
                    'Software Developer', 'Project Manager', 'Graphic Designer', 'Engineer', 'Accountant', 'Lawyer', 'Doctor', 'Pharmacist', 'Teacher', 'Professor', 'Sales Rep', 'Marketing Specialist', 'HR Manager', 'Data Analyst', 'Auditor', 'Architect'
                ];
                return titles[Math.floor(Math.random() * titles.length)];
            },
            '{{age}}': () => Math.floor(18 + Math.random() * 62).toString(),
            '{{bool}}': () => Math.random() > 0.5 ? 'true' : 'false',
            '{{color}}': () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
            '{{guid}}': () => crypto.randomUUID(),
            '{{url}}': () => {
                const domains = ['google.com.eg', 'yahoo.com', 'facebook.com', 'linkedin.com', 'test.com.eg', 'portal.eg', 'myweb.site'];
                return 'https://' + domains[Math.floor(Math.random() * domains.length)] + '/' + Math.random().toString(36).substring(7);
            },
            '{{long_text}}': () => "This is a sample description text for testing purposes. It is used to fill long text fields with generic content. This profile belongs to a user registered for form filling automation. " + (Math.random() > 0.5 ? "The data generated here is randomized but follows a consistent theme for testing the application workflow effectively." : "")
        };
        for (const [key, resolver] of Object.entries(smartVars)) {
            if (processedValue.includes(key)) processedValue = processedValue.split(key).join(resolver());
        }
        return processedValue;
    }

    function generateSmartDate(field) {
        const direction = field.dateDirection || 'future';
        const format = field.dateFormat || 'DD/MM/YYYY';
        const separator = field.dateSeparator || '/';

        const now = new Date();
        let targetDate = new Date();

        if (direction === 'future') {
            const daysToAdd = Math.floor(1 + Math.random() * 29);
            targetDate.setDate(now.getDate() + daysToAdd);
        } else if (direction === 'past') {
            const daysToSub = Math.floor(1 + Math.random() * 29);
            targetDate.setDate(now.getDate() - daysToSub);
        } else if (direction === 'random') {
            const daysToShift = Math.floor(Math.random() * 60) - 30;
            targetDate.setDate(now.getDate() + daysToShift);
        }

        const dd = String(targetDate.getDate()).padStart(2, '0');
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const yyyy = targetDate.getFullYear();

        let result = format;
        result = result.replace('DD', dd).replace('MM', mm).replace('YYYY', yyyy);
        return result.split('/').join(separator);
    }

    const storageKey = 'ff_sequential_indices';
    const counterKey = 'ff_unique_counters';   // monotonic counters → truly unique values
    const storageResult = await new Promise(resolve => chrome.storage.local.get([storageKey, counterKey], resolve));
    const allIndices = storageResult[storageKey] || {};
    const allCounters = storageResult[counterKey] || {};
    let updatedAny = false;
    let countersUpdated = false;

    // Next persistent counter for (profile, selector, kind) — guarantees no repeats
    // across fills, even across sessions. Starts at 1.
    const nextUnique = (selector, kind) => {
        const ckey = `${profileId}_${selector}_${kind}`;
        const n = (allCounters[ckey] || 0) + 1;
        allCounters[ckey] = n;
        countersUpdated = true;
        return n;
    };

    for (const field of fields) {
        const action = field.actionType || 'fill';

        if (action === 'wait') {
            const seconds = parseFloat(field.value) || 0;
            const ms = Math.max(0, seconds * 1000);
            await new Promise(resolve => setTimeout(resolve, ms));
            continue;
        }

        const elements = getElementsBySelector(field.selector);

        // Check if field failed (no elements found or all hidden)
        if (elements.length === 0 || elements.every(el => !isElementVisible(el))) {
            // Track failures for all actions except 'wait' (which has no selector)
            if (action !== 'wait') {
                // Try to extract a better name from the selector
                let fieldName = field.name || '';
                if (!fieldName) {
                    // Extract from selector
                    const nameMatch = field.selector.match(/\[name=['"]([^'"]+)['"]\]/);
                    const idMatch = field.selector.match(/#([\w-]+)/);
                    const placeholderMatch = field.selector.match(/\[placeholder=['"]([^'"]+)['"]\]/);
                    const dataTestIdMatch = field.selector.match(/\[data-testid=['"]([^'"]+)['"]\]/);

                    if (nameMatch) fieldName = nameMatch[1];
                    else if (idMatch) fieldName = idMatch[1];
                    else if (placeholderMatch) fieldName = placeholderMatch[1];
                    else if (dataTestIdMatch) fieldName = dataTestIdMatch[1];
                    else fieldName = field.selector.substring(0, 40);
                }

                failedFields.push({
                    selector: field.selector,
                    value: field.value || '',
                    action: action,
                    name: fieldName
                });
            }
            continue;
        }

        // Successfully found element - proceed to fill

        for (const el of elements) {
            if (!isElementVisible(el)) continue;

            if (action === 'click') {
                el.click();
                // Add a small delay after clicks to allow for UI updates
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            // Checkboxes: value "true"/"false" controls the checked state.
            // Use click() so the page's own event handlers fire naturally.
            if (el.type === 'checkbox') {
                const shouldCheck = ['true', '1', 'yes', 'on', 'checked'].includes(String(field.value).trim().toLowerCase());
                if (el.checked !== shouldCheck) el.click();
                continue;
            }

            // Radio groups: the selector matches every radio in the group
            if (el.type === 'radio') {
                // Sequential mode: cycle to the NEXT radio in the group on each fill
                // (same mechanism and storage key as sequential selects)
                if (field.sequentialSelect) {
                    // The group is handled once - only act on the first element
                    if (el !== elements[0]) continue;
                    const radios = elements.filter(r => r.type === 'radio' && !r.disabled);
                    if (radios.length > 0) {
                        const key = `${profileId}_${field.selector}`;
                        const storedIndex = allIndices[key];
                        // First fill starts at a RANDOM radio; subsequent fills cycle in order
                        const nextIndex = storedIndex === undefined
                            ? Math.floor(Math.random() * radios.length)
                            : (storedIndex + 1) % radios.length;
                        if (!radios[nextIndex].checked) radios[nextIndex].click();
                        allIndices[key] = nextIndex;
                        updatedAny = true;
                    }
                    continue;
                }

                // Fixed mode: click only the radio whose value matches the saved value
                const wanted = String(field.value).trim().toLowerCase();
                if (String(el.value).trim().toLowerCase() === wanted && !el.checked) {
                    el.click();
                }
                continue;
            }

            // Custom dropdowns: open the listbox and click the matching option
            if (isCustomDropdown(el)) {
                const handled = await fillComboboxField(el, resolveSmartVariables(field.value), field);
                if (handled) continue;
                // A non-input dropdown (<mat-select>, <div>, <button>) has no .value to
                // fall back on - writing one would silently do nothing, so report it.
                if (el.tagName !== 'INPUT') {
                    failedFields.push({
                        selector: field.selector,
                        value: field.value || '',
                        action: 'select',
                        name: field.label || field.name || field.selector.substring(0, 40)
                    });
                    continue;
                }
                // A readonly <input> dropdown can still take a plain value - fall through
            }

            // Fill logic
            if (field.sequentialSelect && el.tagName === 'SELECT') {
                const options = Array.from(el.options).filter((opt, index) => {
                    if (!opt.value || opt.value.trim() === '') return false;
                    if (opt.disabled) return false;
                    const text = opt.text.toLowerCase();
                    const isPlaceholder = text.includes('select') || text.includes('choose') || text.includes('اختر') || text.includes('حدد') || text.includes('---');
                    if (index === 0 && isPlaceholder) return false;
                    return true;
                });

                if (options.length > 0) {
                    const key = `${profileId}_${field.selector}`;
                    const storedIndex = allIndices[key];
                    // First fill starts at a RANDOM option; subsequent fills cycle in order
                    const nextIndex = storedIndex === undefined
                        ? Math.floor(Math.random() * options.length)
                        : (storedIndex + 1) % options.length;
                    el.value = options[nextIndex].value;
                    allIndices[key] = nextIndex;
                    updatedAny = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    continue;
                }
            }

            let value = '';
            if (field.isSmartDate) {
                value = generateSmartDate(field);
            } else {
                value = resolveSmartVariables(field.value);
                if (field.uniqueText) {
                    // base value + a zero-padded counter → always unique, never repeats
                    const digits = Math.min(Math.max(1, field.digits || 5), 50);
                    const n = nextUnique(field.selector, 'text');
                    value = value + String(n).padStart(digits, '0');
                }
                else if (field.uniqueNumber) {
                    // an N-digit number that increments (no leading zero), grows if it
                    // overflows the width. BigInt keeps it exact for large digit counts.
                    const digits = Math.min(Math.max(1, field.digits || 5), 50);
                    const n = nextUnique(field.selector, 'number');
                    value = String(10n ** BigInt(digits - 1) + BigInt(n - 1));
                }
                else if (field.numberRange) {
                    // random integer between min and max (inclusive); tolerate swapped/blank bounds
                    let lo = Number.isFinite(field.rangeMin) ? Math.round(field.rangeMin) : parseInt(field.rangeMin);
                    let hi = Number.isFinite(field.rangeMax) ? Math.round(field.rangeMax) : parseInt(field.rangeMax);
                    if (!Number.isFinite(lo)) lo = 1;
                    if (!Number.isFinite(hi)) hi = 100;
                    if (lo > hi) { const t = lo; lo = hi; hi = t; }
                    value = String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
                }
            }

            // Rich text editors (contenteditable, e.g. CKEditor): the editor's JS
            // model lives in the page's world and reverts direct DOM writes, so
            // the background injects the fill into the MAIN world (ckeditorInstance
            // .setData / Quill API / page-context execCommand)
            if (el.isContentEditable) {
                const delegated = await new Promise(resolve => {
                    chrome.runtime.sendMessage(
                        { action: 'fillRichText', selector: field.selector, value },
                        (res) => {
                            if (chrome.runtime.lastError) resolve(false);
                            else resolve(!!(res && res.success));
                        }
                    );
                });

                if (!delegated) {
                    // Last resort from the isolated world
                    try {
                        el.focus();
                        const selection = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        selection.removeAllRanges();
                        selection.addRange(range);
                        const inserted = document.execCommand('insertText', false, value);
                        if (!inserted) {
                            el.innerHTML = '';
                            el.appendChild(document.createTextNode(value));
                            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                        }
                        el.blur();
                    } catch (e) {
                        console.warn('Rich text fill failed:', e);
                    }
                }
                continue;
            }

            el.value = value;

            // Select fallback: if direct assignment didn't take (value doesn't match any
            // option), try matching an option by value or visible text (case-insensitive)
            if (el.tagName === 'SELECT' && el.value !== value) {
                const wanted = String(value).trim().toLowerCase();
                const options = Array.from(el.options);
                const match =
                    options.find(o => o.value.trim().toLowerCase() === wanted) ||
                    options.find(o => o.text.trim().toLowerCase() === wanted) ||
                    options.find(o => wanted.length > 1 && o.text.trim().toLowerCase().includes(wanted));
                if (match) el.value = match.value;
            }

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }


    const toPersist = {};
    if (updatedAny) toPersist[storageKey] = allIndices;
    if (countersUpdated) toPersist[counterKey] = allCounters;
    if (Object.keys(toPersist).length) chrome.storage.local.set(toPersist);

    // Show warning modal if there are failed fields and we're on the profile's page
    if (failedFields.length > 0 && profileUrl) {
        // Check if current page URL matches profile URL
        chrome.runtime.sendMessage({
            action: 'checkUrlMatch',
            currentUrl: window.location.href,
            profileUrl: profileUrl
        }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.matches) {
                showFieldChangeWarningModal(failedFields, profileId);
            }
        });
    }
}

// Module-level so both fillFormFields and checkFailedFieldsForProfile can use it.
// position:fixed elements have offsetParent === null but are visible, so check
// offsetWidth/Height and client rects.
function isElementVisible(el) {
    if (!el) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/**
 * Check for failed fields in a profile (without filling)
 */
async function checkFailedFieldsForProfile(profileId, fields, profileUrl) {
    if (!fields || fields.length === 0) {
        console.log('No fields to check');
        return;
    }

    const checkFields = async () => {
        const failedFields = [];

        function getElementsBySelector(selector) {
            if (!selector) return [];
            try {
                if (selector.startsWith('/') || selector.startsWith('//') || (selector.startsWith('(') && selector.includes('//'))) {
                    const results = [];
                    const query = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    for (let i = 0; i < query.snapshotLength; i++) {
                        results.push(query.snapshotItem(i));
                    }
                    return results;
                } else {
                    return Array.from(document.querySelectorAll(selector));
                }
            } catch (e) {
                return [];
            }
        }

        for (const field of fields) {
            const action = field.actionType || 'fill';
            if (action === 'wait') continue;

            const elements = getElementsBySelector(field.selector);

            // Check if field failed (no elements found or all hidden)
            if (elements.length === 0 || elements.every(el => !isElementVisible(el))) {
                failedFields.push({
                    selector: field.selector,
                    value: field.value || '',
                    action: action,
                    name: field.name || field.selector.substring(0, 40)
                });
            }
        }

        // If there are failed fields, save them for replacement mode
        if (failedFields.length > 0) {
            await chrome.storage.local.set({
                failedFields: failedFields,
                profileIdForReplacement: profileId
            });
            console.log('Found', failedFields.length, 'failed fields for replacement mode:', failedFields);
        } else {
            // Clear any existing failed selectors if no failed fields found
            await chrome.storage.local.remove(['failedFields', 'profileIdForReplacement']);
            console.log('No failed fields found, cleared replacement mode');
        }
    };

    // Check if current URL matches profile URL (if provided)
    if (profileUrl) {
        chrome.runtime.sendMessage({
            action: 'checkUrlMatch',
            currentUrl: window.location.href,
            profileUrl: profileUrl
        }, async (response) => {
            if (chrome.runtime.lastError) {
                console.log('Error checking URL match:', chrome.runtime.lastError);
                // Still check fields even if URL check fails
                await checkFields();
                return;
            }
            if (response && response.matches) {
                await checkFields();
            } else {
                console.log('URL does not match, skipping failed fields check');
            }
        });
    } else {
        // No profile URL, check fields anyway
        await checkFields();
    }
}

/**
 * Show warning modal when field selectors have changed
 */
function showFieldChangeWarningModal(failedFields, profileId) {
    // Don't show multiple modals
    if (document.getElementById('ff-field-change-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ff-field-change-modal';
    modal.innerHTML = `
        <div class="ff-modal-content">
            <div class="ff-modal-header">
                <button class="ff-modal-close" id="ff-modal-close-btn">
                    <i class="fas fa-times"></i>
                </button>
                <div class="ff-modal-warning-icon">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <h2 class="ff-modal-title">${failedFields.length} field${failedFields.length === 1 ? '' : 's'} couldn't be filled</h2>
                <p class="ff-modal-subtitle">These fields weren't found on the page &mdash; it likely changed since you recorded this profile.</p>
            </div>
            <div class="ff-modal-body">
                <p class="ff-modal-explanation">
                    Skipped field${failedFields.length === 1 ? '' : 's'}:
                </p>
                <ul class="ff-failed-fields-list">
                    ${failedFields.map(f => `
                        <li>
                            <div class="ff-failed-field-name">${escapeHtml(f.name || f.selector)}</div>
                            <div class="ff-failed-field-details">
                                <span class="ff-badge ff-badge-${(f.action || 'fill').toLowerCase()}">${(f.action || 'fill').toUpperCase()}</span>
                                ${f.value ? `<span class="ff-failed-value" title="${escapeHtml(f.value)}">Value: ${escapeHtml(f.value.length > 50 ? f.value.substring(0, 47) + '...' : f.value)}</span>` : ''}
                            </div>
                        </li>
                    `).join('')}
                </ul>
                <p class="ff-modal-explanation" style="margin-top: 12px;">
                    Re-record to fix only these fields &mdash; the rest of your profile stays the same.
                </p>
            </div>
            <div class="ff-modal-actions">
                <button class="ff-action-btn ff-btn-register" id="ff-btn-register">
                    <i class="fas fa-circle"></i>
                    <span>Re-record these fields</span>
                </button>
                <button class="ff-action-btn ff-btn-close" id="ff-btn-close-alert">
                    Dismiss
                </button>
            </div>
        </div>
    `;

    // Add styles
    if (!document.getElementById('ff-field-change-modal-styles')) {
        const style = document.createElement('style');
        style.id = 'ff-field-change-modal-styles';
        style.textContent = `
            #ff-field-change-modal {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                z-index: 2147483647;
                font-family: 'Segoe UI', Arial, sans-serif;
            }
            .ff-modal-content {
                position: relative;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 16px;
                padding: 0;
                max-width: 450px;
                width: 90vw;
                max-height: 85vh;
                overflow-y: auto;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
                border: 2px solid rgba(239, 68, 68, 0.3);
                direction: ltr;
            }
            .ff-modal-header {
                position: relative;
                padding: 20px 20px 12px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            .ff-modal-close {
                position: absolute;
                top: 12px;
                left: 12px;
                background: rgba(255, 255, 255, 0.1);
                border: none;
                color: white;
                font-size: 16px;
                cursor: pointer;
                padding: 6px 10px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .ff-modal-close:hover {
                background: rgba(255, 255, 255, 0.2);
            }
            .ff-modal-warning-icon {
                text-align: center;
                margin-bottom: 8px;
            }
            .ff-modal-warning-icon i {
                font-size: 36px;
                color: #ef4444;
            }
            .ff-modal-title {
                color: white;
                font-size: 18px;
                font-weight: 700;
                margin: 0 0 6px;
                text-align: center;
            }
            .ff-modal-subtitle {
                color: rgba(255, 255, 255, 0.7);
                font-size: 13px;
                margin: 0;
                text-align: center;
            }
            .ff-modal-body {
                padding: 16px 20px;
            }
            .ff-modal-explanation {
                color: rgba(255, 255, 255, 0.8);
                font-size: 13px;
                margin: 0 0 8px;
            }
            .ff-failed-fields-list {
                margin: 0;
                padding: 0;
                list-style: none;
                max-height: 200px;
                overflow-y: auto;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                padding: 10px;
            }
            .ff-failed-fields-list li {
                margin-bottom: 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            }
            .ff-failed-fields-list li:last-child {
                border-bottom: none;
                margin-bottom: 0;
            }
            .ff-failed-field-name {
                font-weight: 600;
                color: #ef4444;
                margin-bottom: 4px;
                word-break: break-all;
            }
            .ff-failed-field-details {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            .ff-badge {
                font-size: 9px;
                padding: 2px 6px;
                border-radius: 4px;
                font-weight: 700;
                text-transform: uppercase;
            }
            .ff-badge-fill { background: #3b82f6; color: white; }
            .ff-badge-click { background: #10b981; color: white; }
            .ff-badge-wait { background: #f59e0b; color: white; }
            .ff-failed-value {
                font-size: 10px;
                color: rgba(255, 255, 255, 0.5);
                font-family: monospace;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 250px;
            }
            .ff-modal-actions {
                padding: 12px 20px 20px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ff-action-btn {
                padding: 12px 16px;
                border: none;
                border-radius: 10px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-family: 'Segoe UI', Arial, sans-serif;
            }
            .ff-btn-register {
                background: #dc2626;
                color: white;
            }
            .ff-btn-register:hover {
                background: #b91c1c;
                transform: translateY(-2px);
            }
            .ff-btn-register i {
                font-size: 12px;
            }
            .ff-btn-edit {
                background: #3b82f6;
                color: white;
            }
            .ff-btn-edit:hover {
                background: #2563eb;
                transform: translateY(-2px);
            }
            .ff-btn-close {
                background: rgba(255, 255, 255, 0.05);
                color: white;
            }
            .ff-btn-close:hover {
                background: rgba(255, 255, 255, 0.1);
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(modal);

    // Close button
    modal.querySelector('#ff-modal-close-btn').addEventListener('click', () => {
        modal.remove();
    });

    // Close alert button
    modal.querySelector('#ff-btn-close-alert').addEventListener('click', () => {
        modal.remove();
    });

    // Register button - Start recording
    modal.querySelector('#ff-btn-register').addEventListener('click', async () => {
        modal.remove();

        // Store failed fields for later deletion/matching
        await chrome.storage.local.set({
            failedFields: failedFields,
            profileIdForReplacement: profileId
        });

        // Set append mode first
        currentAppendToProfileId = profileId;

        // Also save to sync storage for popup detection
        await chrome.storage.sync.set({
            appendToProfileId: profileId,
            isRecordingActive: true
        });

        // Start recording with append mode
        chrome.runtime.sendMessage({
            action: 'startRecordingForReplacement',
            profileId: profileId
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Error starting recording:', chrome.runtime.lastError);
                return;
            }

            // Start recording in content script
            startRecording();

            // Show recording indicator
            showRecordingIndicator();
        });
    });

}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// Measure — on-page tool: hover an element for its size / padding / margin;
// click two elements to measure the gap (or the 4 insets when one is inside
// the other); alignment guides extend across the viewport. Editing elements
// lives in the Inspector tool. No AI, no network.
// ============================================================================
let liState = null;

// Inline SVG icons (FontAwesome isn't available inside the page). currentColor.
const LI_IC = (() => {
    const w = (p) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    return {
        ruler: w('<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>'),
        x: w('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')
    };
})();

function openMeasureTool() {
    if (liState) { closeMeasureTool(); return; } // card acts as a toggle
    qaCancelAllTools(); // stopInspectMode() + closeMeasureTool() (already null here) + qaClosePanel()
    liState = { hoverEl: null, anchor: null, target: null };
    liInjectStyles();
    liBuildToolbar();
    liBuildLayer();
    document.addEventListener('mousemove', liOnMove, true);
    document.addEventListener('click', liOnClick, true);
    document.addEventListener('contextmenu', liOnContext, true);
    document.addEventListener('keydown', liOnKey, true);
    window.addEventListener('scroll', liOnScroll, true);
    window.addEventListener('resize', liOnScroll, true);
}

function closeMeasureTool() {
    if (!liState) return;
    document.removeEventListener('mousemove', liOnMove, true);
    document.removeEventListener('click', liOnClick, true);
    document.removeEventListener('contextmenu', liOnContext, true);
    document.removeEventListener('keydown', liOnKey, true);
    window.removeEventListener('scroll', liOnScroll, true);
    window.removeEventListener('resize', liOnScroll, true);
    const ids = ['qa-li-bar', 'qa-li-layer', 'qa-li-style'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
    liState = null;
    try { chrome.runtime.sendMessage({ action: 'measureEnded' }).catch(() => { }); } catch (e) { }
}

// clear the current measurement (anchor/target) and return to plain hover
function liClearMeasure() {
    liState.anchor = null; liState.target = null;
    liRenderMeasure();
}

function liOnContext(e) {
    if (!liState || (!liState.anchor && !liState.target)) return;
    e.preventDefault();
    liClearMeasure();
}

function liInjectStyles() {
    if (document.getElementById('qa-li-style')) return;
    const s = document.createElement('style');
    s.id = 'qa-li-style';
    s.textContent = `
#qa-li-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483640;}
.qa-li-box{position:fixed;pointer-events:none;box-sizing:border-box;}
.qa-li-lbl{position:fixed;pointer-events:none;background:#7c3aed;color:#fff;font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;padding:1px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);z-index:2;}
.qa-li-lbl.gap{background:#f43f5e;}
.qa-li-line{position:fixed;pointer-events:none;height:0;border-top:1px dashed #f43f5e;z-index:1;}
#qa-li-bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:4px;background:#17151f;color:#fff;padding:5px 8px;border-radius:11px;box-shadow:0 8px 28px rgba(0,0,0,.5);font:13px/1 -apple-system,Segoe UI,sans-serif;border:1px solid #2a2738;direction:ltr;}
#qa-li-bar button{all:unset;box-sizing:border-box!important;cursor:pointer!important;margin:0!important;border:none!important;box-shadow:none!important;text-transform:none!important;letter-spacing:normal!important;padding:7px!important;border-radius:8px!important;color:#b9b6c8;background:transparent;display:inline-flex!important;align-items:center!important;gap:6px!important;font:500 13px/1 -apple-system,Segoe UI,sans-serif!important;}
#qa-li-bar button svg{width:15px!important;height:15px!important;flex:0 0 auto!important;}
#qa-li-bar button:hover{background:#262335;color:#fff;}
#qa-li-bar .qa-li-title{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#fff;padding:0 4px;}
#qa-li-bar .qa-li-title svg{width:15px;height:15px;}
#qa-li-bar .sep{width:1px;height:22px;background:#2a2738;margin:0 3px;}
#qa-li-bar .qa-li-x:hover{background:#3a1d24;color:#f87171;}
#qa-li-bar .qa-li-hint{font-size:11px;color:#7e7b90;max-width:240px;padding:0 2px;}
#qa-li-bar,#qa-li-bar *,#qa-li-layer,#qa-li-layer *{outline:none!important;}`;
    (document.head || document.documentElement).appendChild(s);
}

function liBuildToolbar() {
    const bar = document.createElement('div');
    bar.id = 'qa-li-bar';
    bar.innerHTML = `
<span class="qa-li-title">${LI_IC.ruler} Measure</span>
<span class="qa-li-hint">Hover for size · click two for gap · Esc / right-click to reset</span>
<span class="sep"></span>
<button class="qa-li-x ic" title="Close (Esc)">${LI_IC.x}</button>`;
    document.body.appendChild(bar);
    bar.querySelector('.qa-li-x').addEventListener('click', closeMeasureTool);
}

function liBuildLayer() {
    const l = document.createElement('div');
    l.id = 'qa-li-layer';
    document.body.appendChild(l);
}

function liIsUi(el) { return !el || (el.closest && el.closest('#qa-li-bar,#qa-li-layer')); }

function liOnMove(e) {
    if (!liState) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (liIsUi(el)) return;
    liState.hoverEl = el;
    liRenderMeasure();
}

function liOnClick(e) {
    if (!liState) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (liIsUi(el)) return; // let our own buttons work
    e.preventDefault(); e.stopPropagation();
    if (!liState.anchor) { liState.anchor = el; liState.target = null; }
    else if (!liState.target) { liState.target = el; }
    else { liState.anchor = null; liState.target = null; liState.hoverEl = el; } // 3rd click clears → plain hover
    liRenderMeasure();
}

function liOnKey(e) {
    if (!liState) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        // Esc clears an active measurement first; press again to close the tool
        if (liState.anchor || liState.target) liClearMeasure();
        else closeMeasureTool();
    }
}

function liOnScroll() {
    if (!liState) return;
    liRenderMeasure();
}


function liBox(r, css) {
    const d = document.createElement('div');
    d.className = 'qa-li-box';
    d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;${css}`;
    return d;
}
function liLabel(x, y, text, cls) {
    const d = document.createElement('div');
    d.className = 'qa-li-lbl' + (cls ? ' ' + cls : '');
    d.textContent = text;
    d.style.left = Math.max(2, x) + 'px';
    d.style.top = Math.max(2, y) + 'px';
    return d;
}
function liLine(x1, y1, x2, y2) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const d = document.createElement('div');
    d.className = 'qa-li-line';
    d.style.cssText = `left:${x1}px;top:${y1}px;width:${len}px;transform:rotate(${ang}deg);transform-origin:0 0;`;
    return d;
}

function liRenderMeasure() {
    const layer = document.getElementById('qa-li-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const A = liState.anchor, T = liState.target, H = liState.hoverEl;

    if (A) {
        const ra = A.getBoundingClientRect();
        layer.appendChild(liBox(ra, 'outline:2px solid #7c3aed;background:rgba(124,58,237,.08);'));
        const second = T || (H && H !== A ? H : null);
        if (second) {
            const rb = second.getBoundingClientRect();
            layer.appendChild(liBox(rb, 'outline:2px solid #f43f5e;background:rgba(244,63,94,.08);'));
            liDrawGap(layer, ra, rb);
        }
        return;
    }

    if (!H) return;
    const r = H.getBoundingClientRect();
    // alignment guides across the whole viewport at the element's 4 edges
    liGuide(layer, true, r.left); liGuide(layer, true, r.right);
    liGuide(layer, false, r.top); liGuide(layer, false, r.bottom);
    const cs = getComputedStyle(H);
    // margin band (outside)
    const m = { t: parseFloat(cs.marginTop) || 0, r: parseFloat(cs.marginRight) || 0, b: parseFloat(cs.marginBottom) || 0, l: parseFloat(cs.marginLeft) || 0 };
    if (m.t || m.r || m.b || m.l) {
        const mr = { left: r.left - m.l, top: r.top - m.t, width: r.width + m.l + m.r, height: r.height + m.t + m.b };
        layer.appendChild(liBox(mr, 'outline:1px dashed rgba(245,158,11,.7);background:rgba(245,158,11,.10);'));
    }
    // element box
    layer.appendChild(liBox(r, 'outline:2px solid #7c3aed;background:rgba(124,58,237,.10);'));
    // padding band (inside)
    const p = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    if (p.t || p.r || p.b || p.l) {
        const pr = { left: r.left + p.l, top: r.top + p.t, width: Math.max(0, r.width - p.l - p.r), height: Math.max(0, r.height - p.t - p.b) };
        layer.appendChild(liBox(pr, 'outline:1px dashed rgba(16,185,129,.8);background:rgba(16,185,129,.10);'));
    }
    // size label
    const sizeTxt = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    const ly = r.top > 22 ? r.top - 20 : r.bottom + 4;
    layer.appendChild(liLabel(r.left, ly, sizeTxt));
}

// A single gap measurement: a line + px label. `vertical` picks the axis.
function liGapLine(layer, x1, y1, x2, y2, vertical) {
    const dist = vertical ? Math.abs(y2 - y1) : Math.abs(x2 - x1);
    if (dist < 1) return;
    layer.appendChild(liLine(x1, y1, x2, y2));
    const lx = vertical ? x1 + 4 : (x1 + x2) / 2 - 12;
    const ly = vertical ? (y1 + y2) / 2 - 8 : Math.min(y1, y2) - 20;
    layer.appendChild(liLabel(lx, ly, `${Math.round(dist)}px`, 'gap'));
}

// Distances between two element rects. If they overlap (e.g. a button inside a
// card) we show the 4 edge-to-edge insets; otherwise the nearest-edge gap.
function liDrawGap(layer, a, b) {
    const overlap = !(b.left >= a.right || a.left >= b.right || b.top >= a.bottom || a.top >= b.bottom);
    if (overlap) {
        const cx = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
        const cy = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
        liGapLine(layer, cx, a.top, cx, b.top, true);       // top inset
        liGapLine(layer, cx, a.bottom, cx, b.bottom, true); // bottom inset
        liGapLine(layer, a.left, cy, b.left, cy, false);    // left inset
        liGapLine(layer, a.right, cy, b.right, cy, false);  // right inset
        return;
    }
    // not overlapping → single horizontal / vertical gap between nearest edges
    let hx1 = null, hx2 = null;
    if (b.left >= a.right) { hx1 = a.right; hx2 = b.left; }
    else if (a.left >= b.right) { hx1 = b.right; hx2 = a.left; }
    if (hx1 !== null) {
        const ovTop = Math.max(a.top, b.top), ovBot = Math.min(a.bottom, b.bottom);
        const hy = ovBot > ovTop ? (ovTop + ovBot) / 2 : ((a.top + a.bottom) / 2 + (b.top + b.bottom) / 2) / 2;
        liGapLine(layer, hx1, hy, hx2, hy, false);
    }
    let vy1 = null, vy2 = null;
    if (b.top >= a.bottom) { vy1 = a.bottom; vy2 = b.top; }
    else if (a.top >= b.bottom) { vy1 = b.bottom; vy2 = a.top; }
    if (vy1 !== null) {
        const ovL = Math.max(a.left, b.left), ovR = Math.min(a.right, b.right);
        const vx = ovR > ovL ? (ovL + ovR) / 2 : ((a.left + a.right) / 2 + (b.left + b.right) / 2) / 2;
        liGapLine(layer, vx, vy1, vx, vy2, true);
    }
}

// Full-viewport dashed guide lines at an element's 4 edges (alignment check).
function liGuide(layer, vertical, pos) {
    const d = document.createElement('div');
    d.className = 'qa-li-guide';
    if (vertical) d.style.cssText = `position:fixed;left:${pos}px;top:0;width:0;height:100vh;border-left:1px dashed rgba(124,58,237,.75);pointer-events:none;`;
    else d.style.cssText = `position:fixed;top:${pos}px;left:0;height:0;width:100vw;border-top:1px dashed rgba(124,58,237,.75);pointer-events:none;`;
    layer.appendChild(d);
}

function liToast(msg) {
    const t = document.createElement('div');
    t.className = 'qa-li-toast';
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1e1b2e;color:#fff;padding:9px 16px;border-radius:8px;font:13px -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
}
// ============================================================================
// Text Match — paste a reference text (one item per line). Each line is first
// LOCATED on the page (anchor search via word n-grams, so common repeated
// words elsewhere on the page don't confuse it), then compared WORD-BY-WORD
// against that exact spot. Fully sensitive to case, punctuation, symbols and
// digits - the only thing ignored is characters invisible to a human reader
// (zero-width/bidi marks, Arabic tatweel used for text-justification
// stretching). Matching words turn GREEN, differing words turn RED, both
// highlighted directly on the page. Works for Arabic & English. No AI.
// ============================================================================
const TM_IC = (() => {
    const w = (p) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    return {
        x: w('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        check: w('<path d="M20 6 9 17l-5-5"/>'),
        target: w('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
        min: w('<path d="M5 12h14"/>'),
        max: w('<rect x="5" y="5" width="14" height="14" rx="2"/>')
    };
})();

const TM_GAP = 15;     // max run of consecutive differing words to mark red
const TM_MARGIN = 10;  // page-word slack around an anchor's estimated window

// Concatenate all VISIBLE text nodes into one string + a per-char node map,
// so any span can be turned back into a DOM Range. A '\n' separates nodes so
// two adjacent elements' text never runs together with no space.
// When the user has picked a section, only that subtree is read. Anything outside it
// is invisible to the check, so repeated boilerplate (nav, footer, a sidebar carrying
// the same words) can no longer steal an anchor from the part being verified.
let tmScopeRoot = null;
function tmRoot() {
    return (tmScopeRoot && document.contains(tmScopeRoot)) ? tmScopeRoot : document.body;
}

function tmCollect() {
    const rawArr = [], nodeMap = [];
    const walker = document.createTreeWalker(tmRoot(), NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
            const p = n.parentElement;
            if (!p || p.closest('#qa-tm, script, style, noscript')) return NodeFilter.FILTER_REJECT;
            // checkVisibility also catches hidden ANCESTORS (e.g. a duplicate
            // mobile menu inside display:none) whose descendants still report
            // visible computed styles - matching there paints nothing visible
            if (typeof p.checkVisibility === 'function') {
                if (!p.checkVisibility()) return NodeFilter.FILTER_REJECT;
            } else {
                const st = getComputedStyle(p);
                if (st.display === 'none' || st.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let n, total = 0;
    while ((n = walker.nextNode())) {
        const v = n.nodeValue;
        for (let k = 0; k < v.length; k++) { rawArr.push(v[k]); nodeMap.push({ node: n, offset: k }); }
        // node-boundary marker: '\x00' (never appears in real text) so the
        // tokenizer can tell "two nodes glued with no space" (<b>word</b>:)
        // apart from real whitespace between words
        rawArr.push('\x00'); nodeMap.push(null);
        total += v.length;
        if (total > 400000) break;
    }
    return { raw: rawArr.join(''), nodeMap };
}

// Characters invisible to a human reader: zero-width/bidi marks + Arabic
// tatweel (used for text-justification stretching). These are stripped before
// comparison since they're rendering artifacts, not real content.
function tmIsInvisible(code) {
    return code === 0x0640 || (code >= 0x200B && code <= 0x200F) || (code >= 0x202A && code <= 0x202E) || (code >= 0x2060 && code <= 0x2064) || code === 0xFEFF;
}
// Normalize a word for comparison (case-folded either way):
//   strict=false : keep ONLY letters & digits - punctuation/symbols dropped,
//                  so "data." == "data"
//   strict=true  : keep visible punctuation & symbols too (only invisible
//                  marks and tatweel dropped), so "data." != "data"
function tmClean(word, strict) {
    const n = word.normalize('NFKC');
    let out = '';
    for (const ch of n) {
        const c = ch.codePointAt(0);
        if (c === 0x0640 || tmIsInvisible(c)) continue;  // tatweel + invisible marks
        if (strict || /[\p{L}\p{N}]/u.test(ch)) out += ch;
    }
    return out.toLowerCase();
}

// Split visible page text into whitespace-delimited word tokens, each with its
// exact DOM Range. A pure-symbol fragment glued to the previous token with no
// real whitespace (only a node boundary) is MERGED into it, so markup like
// "<b>WORD</b>:" compares as "WORD:" and not as a word plus an orphan ":".
function tmPageTokens(cap, strict) {
    const { raw, nodeMap } = tmCollect();
    const isSep = (c) => c === '\x00' || /\s/.test(c);
    const toks = [];
    let i = 0;
    while (i < raw.length) {
        if (isSep(raw[i])) { i++; continue; }
        let j = i;
        while (j < raw.length && !isSep(raw[j])) j++;
        const s = nodeMap[i], e = nodeMap[j - 1];
        const rawWord = raw.slice(i, j);
        const word = tmClean(rawWord, strict);
        if (s && e && word) {
            const prev = toks[toks.length - 1];
            // gap between previous token and this one is "soft" when it holds
            // only node-boundary markers (no real spaces) -> same visual word
            let soft = false;
            if (prev && prev.rawEnd !== undefined) {
                soft = true;
                for (let g = prev.rawEnd; g < i; g++) { if (raw[g] !== '\x00') { soft = false; break; } }
            }
            const pureSym = !/[\p{L}\p{N}]/u.test(rawWord);
            const prevPureSym = prev && !/[\p{L}\p{N}]/u.test(prev.rawWord);
            if (soft && (pureSym || prevPureSym)) {
                prev.rawWord += rawWord;
                prev.word = tmClean(prev.rawWord, strict);
                prev.e = e; prev.rawEnd = j;
            } else {
                toks.push({ word, s, e, rawWord, rawEnd: j });
            }
        }
        i = j;
        if (toks.length >= cap) break;
    }
    return toks;
}

// Build word n-gram -> [page start indices] maps for n = 2, 3, 4 (skips n = 1;
// single common words like "in"/"of" would vote for too many wrong offsets).
function tmBuildNgramMaps(pageWords) {
    const maps = {};
    for (const n of [2, 3, 4]) {
        const m = new Map();
        for (let i = 0; i + n <= pageWords.length; i++) {
            const key = n + '' + pageWords.slice(i, i + n).join('');
            let arr = m.get(key);
            if (!arr) { arr = []; m.set(key, arr); }
            arr.push(i);
        }
        maps[n] = m;
    }
    return maps;
}

// Estimate WHERE in the page a line's word[0] would sit, via n-gram voting:
// every n-gram of the line that also occurs in the page casts a vote for
// offset = pagePos - lineIdx. The offset with the most (weighted) votes wins -
// the true location gets many consistent votes; coincidental repeats elsewhere
// only ever cast a handful of scattered ones.
function tmBestOffset(lineWords, ngramMaps) {
    const votes = new Map();
    for (const n of [4, 3, 2]) {
        if (lineWords.length < n) continue;
        const map = ngramMaps[n];
        const weight = n * n;
        for (let i = 0; i + n <= lineWords.length; i++) {
            const key = n + '' + lineWords.slice(i, i + n).join('');
            const positions = map.get(key);
            if (!positions) continue;
            for (const p of positions) {
                const offset = p - i;
                votes.set(offset, (votes.get(offset) || 0) + weight);
            }
        }
    }
    let bestOffset = null, bestVotes = 0;
    for (const [off, v] of votes) { if (v > bestVotes) { bestVotes = v; bestOffset = off; } }
    return bestVotes > 0 ? bestOffset : null;
}

// Word-level LCS (exact equality) between two word arrays -> matched
// [aIdx, bIdx] pairs, in order. O(n*m) DP with a rolling Uint16 table.
function tmLCS(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return [];
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        const rowi = i * W, rowi1 = (i + 1) * W;
        for (let j = m - 1; j >= 0; j--) {
            dp[rowi + j] = (a[i] === b[j])
                ? dp[rowi1 + (j + 1)] + 1
                : Math.max(dp[rowi1 + j], dp[rowi + (j + 1)]);
        }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) i++;
        else j++;
    }
    return pairs;
}

function tmClearHighlight() {
    try { if (window.CSS && CSS.highlights) { CSS.highlights.delete('qa-tm-found'); CSS.highlights.delete('qa-tm-diff'); } } catch (e) { }
}

function closeTextMatchPanel() {
    tmClearHighlight();
    // Closing the panel is a reset: reopening must start on the whole page again,
    // otherwise a section chosen in an earlier session silently narrows the next check.
    tmScopeRoot = null;
    const p = document.getElementById('qa-tm');
    if (p) p.remove();
    const s = document.getElementById('qa-tm-style');
    if (s) s.remove();
    // if the panel is closed mid-pick, take the picker's overlay with it
    ['qa-tm-pickbox', 'qa-tm-picktip'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
}

function openTextMatchPanel() {
    if (document.getElementById('qa-tm')) { closeTextMatchPanel(); return; } // toggle
    qaCancelAllTools();

    const style = document.createElement('style');
    style.id = 'qa-tm-style';
    style.textContent = `
::highlight(qa-tm-found){background:rgba(16,185,129,.45);color:inherit;}
::highlight(qa-tm-diff){background:rgba(244,63,94,.5);color:inherit;}
#qa-tm{position:fixed;top:16px;right:16px;width:330px;max-height:88vh;z-index:2147483647;display:flex;flex-direction:column;direction:ltr;
  background:#17151f;color:#e5e7eb;border:1px solid #2a2738;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.6);
  font:13px/1.45 -apple-system,Segoe UI,sans-serif;overflow:hidden;}
#qa-tm *{box-sizing:border-box;}
#qa-tm .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:#1c1a26;border-bottom:1px solid #2a2738;cursor:move;user-select:none;}
#qa-tm .hd .ttl{font-weight:600;display:flex;align-items:center;gap:7px;}
#qa-tm .hd .ttl svg{width:15px;height:15px;color:#34d399;}
#qa-tm .iconbtn{all:unset;cursor:pointer;color:#8b8898;padding:5px;border-radius:7px;display:flex;}
#qa-tm .iconbtn:hover{background:#3a1d24;color:#f87171;}
#qa-tm #qa-tm-min:hover{background:#262335;color:#fff;}
#qa-tm.min{width:auto;}
#qa-tm.min .bd{display:none;}
#qa-tm .bd{padding:13px;overflow-y:auto;}
#qa-tm textarea{width:100%;min-height:120px;max-height:260px;resize:vertical;background:#13111c;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:9px 10px;font:13px/1.6 -apple-system,Segoe UI,sans-serif;}
#qa-tm textarea:focus{outline:none;border-color:#7c3aed;}
#qa-tm .hint{font-size:11px;color:#6b6878;margin:6px 2px 10px;}
#qa-tm .opt{display:flex;align-items:flex-start;gap:7px;font-size:11px;color:#b9b6c8;margin:8px 2px 2px;cursor:pointer;line-height:1.45;}
#qa-tm .opt input{width:13px;height:13px;margin-top:1px;accent-color:#7c3aed;cursor:pointer;flex:0 0 auto;}
#qa-tm .go{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;width:100%;background:#7c3aed;color:#fff;font-weight:600;font-size:13px;padding:10px 0;border-radius:9px;}
#qa-tm .go:hover{background:#6d28d9;}
#qa-tm .result{margin-top:14px;display:none;}
#qa-tm .result.show{display:block;}
#qa-tm .counts{display:flex;gap:8px;}
#qa-tm .count{flex:1;text-align:center;padding:12px 0;border-radius:10px;font-weight:700;}
#qa-tm .count .n{font-size:22px;display:block;line-height:1;}
#qa-tm .count .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.85;margin-top:4px;}
#qa-tm .count.ok{background:rgba(16,185,129,.14);color:#34d399;border:1px solid rgba(16,185,129,.35);}
#qa-tm .count.no{background:rgba(244,63,94,.14);color:#f87171;border:1px solid rgba(244,63,94,.35);}
#qa-tm .note{font-size:11px;color:#6b6878;margin-top:9px;text-align:center;}
#qa-tm .err{color:#f87171;font-size:12px;margin-top:10px;}
#qa-tm .difflist{display:none;margin-top:10px;max-height:190px;overflow-y:auto;}
#qa-tm .difflist.show{display:block;}
#qa-tm .drow{padding:6px 9px;border-radius:8px;background:#13111c;border:1px solid #2a2738;margin-bottom:6px;font-size:12px;line-height:1.5;cursor:pointer;word-break:break-word;}
#qa-tm .drow:hover{border-color:#7c3aed;}
#qa-tm .drow .bad{color:#f87171;font-weight:700;}
#qa-tm .drow .ctx{color:#8b8898;}
#qa-tm .drow .miss{color:#f59e0b;font-size:10px;margin:0 4px;}
#qa-tm .scoperow{display:flex;align-items:center;gap:7px;margin-bottom:8px;}
#qa-tm .scopebtn{display:inline-flex;align-items:center;gap:5px;background:#241f33;color:#c9c4d8;
  border:1px solid #3a3350;border-radius:7px;padding:5px 9px;font-size:11px;font-weight:600;
  cursor:pointer;white-space:nowrap;}
#qa-tm .scopebtn:hover{border-color:#7c3aed;color:#fff;}
#qa-tm .scopebtn.on{background:#7c3aed;border-color:#7c3aed;color:#fff;}
#qa-tm .scopelbl{flex:1 1 auto;min-width:0;font-size:10.5px;color:#8b8898;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
#qa-tm .scopelbl.set{color:#a78bfa;font-weight:600;}
#qa-tm .scopeclr{flex:0 0 auto;background:none;border:none;color:#8b8898;cursor:pointer;
  padding:2px;line-height:0;}
#qa-tm .scopeclr:hover{color:#f87171;}
/* picker overlay lives outside the panel so page scrolling never detaches it */
#qa-tm-pickbox{position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #7c3aed;
  background:rgba(124,58,237,.14);border-radius:3px;transition:all .05s linear;}
#qa-tm-picktip{position:fixed;pointer-events:none;z-index:2147483646;background:#1a1626;
  color:#e9e6f2;border:1px solid #7c3aed;border-radius:7px;padding:6px 10px;font-size:11.5px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  box-shadow:0 8px 26px rgba(0,0,0,.5);max-width:320px;}
#qa-tm-picktip b{color:#a78bfa;}`;
    (document.head || document.documentElement).appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'qa-tm';
    panel.innerHTML = `
<div class="hd">
  <span class="ttl">${TM_IC.check} Text Match <span style="color:#6b6878;font-size:10px;font-weight:400;">v8</span></span>
  <span style="display:flex;gap:2px;">
    <button class="iconbtn" id="qa-tm-min" title="Hide / show the panel">${TM_IC.min}</button>
    <button class="iconbtn" id="qa-tm-close" title="Close">${TM_IC.x}</button>
  </span>
</div>
<div class="bd">
  <div class="scoperow">
    <button class="scopebtn" id="qa-tm-pick" title="Click an area of the page to limit the check to it">${TM_IC.target} Select section</button>
    <span class="scopelbl" id="qa-tm-scope">Whole page</span>
    <button class="scopeclr" id="qa-tm-scope-clear" title="Check the whole page again" style="display:none;">${TM_IC.x}</button>
  </div>
  <textarea id="qa-tm-input" placeholder="Paste the reference text — one item per line (Arabic or English)" spellcheck="false" dir="auto"></textarea>
  <label class="opt"><input type="checkbox" id="qa-tm-strict" checked> Strict symbols — a dot or comma counts as a difference (data &ne; data.)</label>
  <div class="hint">Matches green, differences red, both on the page (case is always ignored)</div>
  <button class="go" id="qa-tm-run">Check</button>
  <div class="result" id="qa-tm-result">
    <div class="counts">
      <div class="count ok"><span class="n" id="qa-tm-match">0</span><span class="l">Matched</span></div>
      <div class="count no"><span class="n" id="qa-tm-diff">0</span><span class="l">Different</span></div>
    </div>
    <div class="difflist" id="qa-tm-difflist"></div>
    <div class="note" id="qa-tm-note"></div>
  </div>
  <div class="err" id="qa-tm-err"></div>
</div>`;
    document.body.appendChild(panel);

    const ta = panel.querySelector('#qa-tm-input');
    const result = panel.querySelector('#qa-tm-result');
    const errEl = panel.querySelector('#qa-tm-err');
    let lastDiffItems = [];   // diff rows of the last run (for click-to-scroll)

    // ── Section picker ──────────────────────────────────────────────────────
    // Hover any element to outline it, click to make it the only text the check
    // reads. Esc cancels. The panel hides while picking so it can't be picked.
    const scopeLbl = panel.querySelector('#qa-tm-scope');
    const scopeClr = panel.querySelector('#qa-tm-scope-clear');
    const pickBtn = panel.querySelector('#qa-tm-pick');

    const tmDescribe = (el) => {
        if (!el) return 'Whole page';
        let s = el.tagName.toLowerCase();
        if (el.id) return s + '#' + el.id;
        const cls = (el.className && typeof el.className === 'string')
            ? el.className.trim().split(/\s+/).filter(c => !c.startsWith('qa-')).slice(0, 2) : [];
        if (cls.length) s += '.' + cls.join('.');
        const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
        return txt ? `${s} — "${txt.slice(0, 40)}${txt.length > 40 ? '…' : ''}"` : s;
    };

    const paintScope = () => {
        const on = !!(tmScopeRoot && document.contains(tmScopeRoot));
        if (!on) tmScopeRoot = null;
        scopeLbl.textContent = on ? tmDescribe(tmScopeRoot) : 'Whole page';
        scopeLbl.title = scopeLbl.textContent;
        scopeLbl.classList.toggle('set', on);
        scopeClr.style.display = on ? '' : 'none';
    };

    let picking = false;
    const startPick = () => {
        if (picking) return;
        picking = true;
        pickBtn.classList.add('on');
        panel.style.visibility = 'hidden';       // keep layout, just get it out of the way

        const box = document.createElement('div'); box.id = 'qa-tm-pickbox';
        const tip = document.createElement('div'); tip.id = 'qa-tm-picktip';
        tip.innerHTML = 'Hover an area &nbsp;·&nbsp; scroll to widen &nbsp;·&nbsp; click to use';
        document.body.appendChild(box); document.body.appendChild(tip);

        // `deepest` is whatever is under the cursor; `hover` is what we would actually
        // take. They differ once the user walks UP the tree - elementFromPoint always
        // returns the innermost node, so hitting a container by aiming at its 3px of
        // padding is hopeless. Wheel / arrow keys widen and narrow the selection instead.
        let deepest = null, hover = null, lastPt = { x: 0, y: 0 };

        const draw = () => {
            if (!hover) return;
            const r = hover.getBoundingClientRect();
            box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
            box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
            const depth = (() => { let d = 0, n = hover; while (n && n !== deepest) { d++; n = n.parentElement; } return d; })();
            tip.innerHTML =
                `<b>${tmDescribe(hover).replace(/</g, '&lt;')}</b>` +
                `<br>Scroll wheel or ↑ ↓ to widen / narrow` +
                (depth ? ` &nbsp;<span style="color:#8b8898">(${depth} level${depth > 1 ? 's' : ''} up)</span>` : '') +
                `<br>Click to use &nbsp;·&nbsp; Esc to cancel`;
            const ty = r.top > 60 ? r.top - tip.offsetHeight - 8 : r.bottom + 8;
            tip.style.left = Math.max(8, Math.min(lastPt.x + 12, innerWidth - tip.offsetWidth - 10)) + 'px';
            tip.style.top = Math.max(8, ty) + 'px';
        };

        const onMove = (e) => {
            lastPt = { x: e.clientX, y: e.clientY };
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || el.closest('#qa-tm, #qa-tm-pickbox, #qa-tm-picktip')) return;
            if (el === deepest) { draw(); return; }   // same element, just reposition the tip
            deepest = el; hover = el;                 // moving to a new element resets the walk
            draw();
        };

        // widen = climb to the parent; narrow = come back down the same path
        const widen = () => {
            if (!hover) return;
            const p = hover.parentElement;
            if (p && p !== document.documentElement && !p.closest('#qa-tm')) { hover = p; draw(); }
        };
        const narrow = () => {
            if (!hover || hover === deepest) return;
            // walk down from `hover` towards `deepest` by one step
            let n = deepest;
            while (n && n.parentElement !== hover) n = n.parentElement;
            if (n) { hover = n; draw(); }
        };

        const onWheel = (e) => { e.preventDefault(); (e.deltaY < 0 ? widen : narrow)(); };

        // capture phase + preventDefault so the click picks instead of following a link
        const onClick = (e) => {
            if (!hover) return;
            e.preventDefault(); e.stopPropagation();
            tmScopeRoot = hover;
            stopPick();
            paintScope();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); stopPick(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); widen(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); narrow(); return; }
            if (e.key === 'Enter' && hover) { e.preventDefault(); tmScopeRoot = hover; stopPick(); paintScope(); }
        };

        function stopPick() {
            picking = false;
            pickBtn.classList.remove('on');
            panel.style.visibility = '';
            box.remove(); tip.remove();
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('wheel', onWheel, { capture: true });
        }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    };

    pickBtn.addEventListener('click', startPick);
    scopeClr.addEventListener('click', () => { tmScopeRoot = null; paintScope(); });
    paintScope();

    const runCheck = () => {
        errEl.textContent = '';
        tmClearHighlight();
        const rawLines = ta.value.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 1000);
        if (!rawLines.length) { result.classList.remove('show'); errEl.textContent = 'Paste some text first.'; return; }

        // page word tokens (without our own panel), + n-gram index for anchoring
        const strict = panel.querySelector('#qa-tm-strict').checked;
        panel.style.display = 'none';
        const pageToks = tmPageTokens(20000, strict);
        panel.style.display = '';
        if (!pageToks.length) {
            result.classList.remove('show');
            errEl.textContent = tmScopeRoot
                ? 'The selected section has no readable text. Pick a wider area or clear the selection.'
                : 'No readable text found on this page.';
            return;
        }
        const pageWords = pageToks.map(t => t.word);
        const ngramMaps = tmBuildNgramMaps(pageWords);
        // word -> first index & occurrence count, for the short-line fallback anchor
        const pageFirst = new Map(), pageCount = new Map();
        for (let i = 0; i < pageWords.length; i++) {
            const w = pageWords[i];
            pageCount.set(w, (pageCount.get(w) || 0) + 1);
            if (!pageFirst.has(w)) pageFirst.set(w, i);
        }

        const canHL = window.CSS && CSS.highlights && typeof Highlight !== 'undefined';
        let matchCount = 0, unlocated = 0, missingCount = 0;
        // indices are collected in sets and painted at the END: a page word
        // matched by ANY line is green, and is NEVER also painted red - the two
        // translucent colours would composite into a misleading third colour
        const greenIdx = new Set(), redIdx = new Set();
        // token index -> the reference word it was compared against; lets the
        // painter colour ONLY the differing characters (e.g. just the "." of
        // "data.") red and keep the matching part green
        const redRef = new Map();
        // lenient form -> raw reference word, across ALL lines; lets later
        // passes recover the ref counterpart of an unclaimed page word
        const refLenMap = new Map();
        const diffItems = [];   // { start, end, sTok, eTok, before, words, after, missing? }

        const addRange = (hl, tok) => {
            try { const r = document.createRange(); r.setStart(tok.s.node, tok.s.offset); r.setEnd(tok.e.node, tok.e.offset + 1); hl.add(r); return true; }
            catch (e) { return false; }
        };

        // a whole line that isn't on the page at all: count it and list it as
        // "(not on page)" - but paint NOTHING (no location to point at)
        const notFoundRow = (lineWords) => {
            unlocated += lineWords.length;
            diffItems.push({
                start: 0, end: 0, sTok: null, eTok: null, before: '', after: '',
                words: lineWords.slice(0, 8).join(' ') + (lineWords.length > 8 ? ' …' : ''),
                missing: true
            });
        };

        // lenient (symbols-ignored) view of the page tokens, built on demand -
        // used in strict mode to find lines whose only differences are symbols
        let lenPage = null;
        const getLenPage = () => {
            if (!lenPage) {
                const words = [], idx = [];
                for (let i = 0; i < pageToks.length; i++) {
                    const w = tmClean(pageToks[i].word, false);
                    if (w) { words.push(w); idx.push(i); }
                }
                lenPage = { words, idx };
            }
            return lenPage;
        };

        for (const line of rawLines) {
            const rawWords = line.split(/\s+/).filter(Boolean).slice(0, 2000);
            const lineEntries = rawWords.map(w => ({ raw: w, w: tmClean(w, strict) })).filter(e => e.w);
            const lineWords = lineEntries.map(e => e.w);
            if (!lineWords.length) continue;
            for (const e of lineEntries) {
                const len = tmClean(e.raw, false);
                if (len && !refLenMap.has(len)) refLenMap.set(len, e.raw);
            }

            // FIRST: exact full-sequence occurrences anywhere on the page -
            // highlight EVERY one of them green (the same text can legitimately
            // appear in several places: breadcrumb, heading, body...)
            let exactHit = false;
            for (let i = 0; i + lineWords.length <= pageWords.length; i++) {
                let k = 0;
                while (k < lineWords.length && pageWords[i + k] === lineWords[k]) k++;
                if (k === lineWords.length) {
                    exactHit = true;
                    for (let j = 0; j < lineWords.length; j++) greenIdx.add(i + j);
                    i += lineWords.length - 1;
                }
            }
            if (exactHit) { matchCount += lineWords.length; continue; }

            // STRICT MODE FALLBACK: the line isn't on the page character-for-
            // character - look for it IGNORING symbols. If found, the words
            // whose symbols differ are the real differences: paint them RED in
            // place (e.g. page "الرؤية" vs reference "الرؤية:").
            if (strict) {
                const refPairs = rawWords.map(w => ({ raw: w, strict: tmClean(w, true), len: tmClean(w, false) })).filter(p => p.len);
                const refLen = refPairs.map(p => p.len);
                // pure-symbol reference words ("&", "-", "/") vanish from the
                // lenient view - keep their strict forms to judge the page's
                // own standalone symbols inside the matched span
                const refSymSet = new Set(rawWords.map(w => tmClean(w, true)).filter(w => w && !/[\p{L}\p{N}]/u.test(w)));
                if (refLen.length) {
                    const lp = getLenPage();
                    let lenHit = false;
                    for (let i = 0; i + refLen.length <= lp.words.length; i++) {
                        let k = 0;
                        while (k < refLen.length && lp.words[i + k] === refLen[k]) k++;
                        if (k !== refLen.length) continue;
                        for (let j = 0; j < refLen.length; j++) {
                            const tokI = lp.idx[i + j];
                            if (pageToks[tokI].word === refPairs[j].strict) {
                                greenIdx.add(tokI);
                                if (!lenHit) matchCount++;
                            } else {
                                redIdx.add(tokI);
                                redRef.set(tokI, refPairs[j].raw);
                                if (!lenHit) diffItems.push({
                                    start: tokI, end: tokI + 1,
                                    sTok: pageToks[tokI], eTok: pageToks[tokI],
                                    before: tokI > 0 ? pageToks[tokI - 1].word : '',
                                    words: pageToks[tokI].word,
                                    after: tokI + 1 < pageToks.length ? pageToks[tokI + 1].word : ''
                                });
                            }
                        }
                        // standalone page symbols inside the span ("&" between
                        // "Zakat" and "Tax") are invisible to the lenient view:
                        // green them when the reference has that symbol too,
                        // red them otherwise
                        for (let t = lp.idx[i]; t <= lp.idx[i + refLen.length - 1]; t++) {
                            if (greenIdx.has(t) || redIdx.has(t)) continue;
                            if (refSymSet.has(pageToks[t].word)) greenIdx.add(t);
                            else redIdx.add(t);
                        }
                        lenHit = true;
                        i += refLen.length - 1;
                    }
                    if (lenHit) continue;
                }
            }

            // single word not found anywhere - nothing to anchor a diff on
            if (lineWords.length === 1) { notFoundRow(lineWords); continue; }

            let offset = tmBestOffset(lineWords, ngramMaps);
            if (offset === null) {
                // n-gram anchoring failed (e.g. a short line where every word
                // differs slightly by case/punctuation). Fall back to the RAREST
                // reference word that does appear on the page - the fewer times
                // it occurs, the more reliable it is as an anchor.
                let bc = Infinity;
                for (let i = 0; i < lineWords.length; i++) {
                    const c = pageCount.get(lineWords[i]);
                    // only a RARE word is a trustworthy anchor - a common word
                    // ("in"/"of"...) would drag the diff to a random spot
                    if (c && c < bc && c <= 5) { bc = c; offset = pageFirst.get(lineWords[i]) - i; }
                }
            }
            if (offset === null) { notFoundRow(lineWords); continue; } // line not found anywhere on the page

            // The window starts EXACTLY at the estimated location: any leading
            // slack lets LCS grab an identical word from NEIGHBOURING content
            // (menus, breadcrumbs) before the real match and mispaint the area
            // between them. Trailing slack stays generous for extra words
            // inserted inside the paragraph.
            const winStart = Math.max(0, offset);
            const winEnd = Math.min(pageWords.length, offset + lineWords.length + TM_MARGIN);
            const windowWords = pageWords.slice(winStart, winEnd);

            const pairs = tmLCS(lineWords, windowWords);
            // GUARD: if fewer than half the line's words matched at this spot,
            // the line isn't really here (the anchor latched onto a few common
            // words somewhere random) - report it as not-found, paint nothing.
            if (!pairs.length || pairs.length < Math.ceil(lineWords.length * 0.5)) {
                notFoundRow(lineWords);
                continue;
            }
            matchCount += pairs.length;

            // GREEN: every matched page word
            for (const [, wIdx] of pairs) greenIdx.add(winStart + wIdx);

            // mark page window words [a, b) as differing (painted at the end)
            // and record it (with one context word each side) for the panel list
            const redRange = (a, b) => {
                a = Math.max(0, a); b = Math.min(windowWords.length, b);
                if (b <= a) return;
                for (let wi = a; wi < b; wi++) redIdx.add(winStart + wi);
                diffItems.push({
                    start: winStart + a, end: winStart + b,
                    sTok: pageToks[winStart + a], eTok: pageToks[winStart + b - 1],
                    before: windowWords[a - 1] || '',
                    words: windowWords.slice(a, b).join(' '),
                    after: windowWords[b] || ''
                });
            };

            // LEADING difference: if the pasted line has words BEFORE its first
            // match, the same count of page words right before the match are the
            // differing versions (e.g. a changed first word). Anything earlier is
            // just margin / neighbouring page content, so it is NOT coloured.
            const leadRef = pairs[0][0];
            if (leadRef > 0) {
                redRange(pairs[0][1] - leadRef, pairs[0][1]);
                // 1:1 substitution -> remember each ref word for char-level paint
                if (pairs[0][1] - leadRef >= 0) for (let t = 0; t < leadRef; t++) redRef.set(winStart + pairs[0][1] - leadRef + t, lineEntries[t].raw);
            }

            // INTERIOR differences: page words between two matched words
            for (let k = 0; k < pairs.length - 1; k++) {
                const pageA = pairs[k][1], pageB = pairs[k + 1][1];
                const refA = pairs[k][0], refB = pairs[k + 1][0];
                const refGap = refB - refA - 1;
                const pageGap = pageB - pageA - 1;
                if (pageGap > 0 && pageGap <= TM_GAP) {
                    redRange(pageA + 1, pageB); // substitution / interior insert
                    // 1:1 substitution -> remember each ref word for char-level paint
                    if (refGap === pageGap) for (let t = 1; t <= refGap; t++) redRef.set(winStart + pageA + t, lineEntries[refA + t].raw);
                }
                else if (refGap > 0 && pageGap === 0) {
                    // reference words missing from the page entirely
                    missingCount += refGap;
                    diffItems.push({
                        start: winStart + pageA, end: winStart + pageA + 1,
                        sTok: pageToks[winStart + pageA], eTok: pageToks[winStart + pageA],
                        before: windowWords[pageA] || '',
                        words: lineWords.slice(refA + 1, refB).join(' '),
                        after: windowWords[pageB] || '',
                        missing: true
                    });
                }
            }

            // TRAILING difference: words in the pasted line AFTER its last match
            // (e.g. "data" vs "data." at the end) -> the page words right after
            // the last match are the differing versions.
            const tailRef = (lineWords.length - 1) - pairs[pairs.length - 1][0];
            if (tailRef > 0) {
                const lastP = pairs[pairs.length - 1][1], lastR = pairs[pairs.length - 1][0];
                redRange(lastP + 1, lastP + 1 + tailRef);
                for (let t = 1; t <= tailRef; t++) { if (lastP + t < windowWords.length) redRef.set(winStart + lastP + t, lineEntries[lastR + t].raw); }
            }
        }

        // EXTRA-ON-PAGE pass: a short run of page words wedged BETWEEN two
        // matched (green) words that no line accounted for - e.g. the page
        // still has "الإنجاز:" but the reference doesn't - is a real difference.
        // Pure-symbol tokens (bullets, dashes) are skipped as styling noise.
        {
            const g = [...greenIdx].sort((a, b) => a - b);
            for (let k = 0; k < g.length - 1; k++) {
                const a = g[k], b = g[k + 1];
                const gap = b - a - 1;
                if (gap < 1 || gap > 3) continue;
                let ok = true;
                for (let i = a + 1; i < b; i++) {
                    if (greenIdx.has(i) || redIdx.has(i) || !/[\p{L}\p{N}]/u.test(pageToks[i].word)) { ok = false; break; }
                }
                if (!ok) continue;
                for (let i = a + 1; i < b; i++) {
                    redIdx.add(i);
                    // recover the ref counterpart (if any) for char-level paint
                    const rr = refLenMap.get(tmClean(pageToks[i].rawWord, false));
                    if (rr) redRef.set(i, rr);
                }
                diffItems.push({
                    start: a + 1, end: b,
                    sTok: pageToks[a + 1], eTok: pageToks[b - 1],
                    before: pageToks[a].word,
                    words: pageToks.slice(a + 1, b).map(t => t.word).join(' '),
                    after: pageToks[b].word
                });
            }
        }

        // PAINT: green wins over red (no colour compositing), red = never matched.
        // When the differing word has a known reference counterpart, only the
        // characters that actually differ go red (e.g. just the "." of "data.")
        // and the matching part stays green.
        let diffCount = missingCount;
        if (canHL) {
            const green = new Highlight(), red = new Highlight();
            for (const i of greenIdx) addRange(green, pageToks[i]);
            for (const i of redIdx) {
                if (greenIdx.has(i)) continue;
                const tok = pageToks[i], refRaw = redRef.get(i);
                // char-level split needs the token to live in a single text node
                if (refRaw && tok.s.node === tok.e.node) {
                    const a = tok.rawWord, b = refRaw;
                    let p = 0;
                    while (p < a.length && p < b.length && a[p].toLowerCase() === b[p].toLowerCase()) p++;
                    let sfx = 0;
                    while (sfx < a.length - p && sfx < b.length - p && a[a.length - 1 - sfx].toLowerCase() === b[b.length - 1 - sfx].toLowerCase()) sfx++;
                    const dS = p, dE = a.length - sfx;
                    if (dE <= dS) {
                        // the page word has NO differing characters - the ref just
                        // carries extra symbols the page lacks (e.g. ref "الرؤية:"
                        // vs page "الرؤية") -> treat as a normal match
                        greenIdx.add(i);
                        addRange(green, tok);
                        continue;
                    }
                    if (dS > 0 || dE < a.length) {
                        // only part of the word differs -> red just those chars
                        diffCount++;
                        const base = tok.s.offset;
                        const sub = (hl, from, to) => {
                            if (to <= from) return;
                            try { const r = document.createRange(); r.setStart(tok.s.node, base + from); r.setEnd(tok.s.node, base + to); hl.add(r); } catch (e) { }
                        };
                        sub(green, 0, dS); sub(red, dS, dE); sub(green, dE, a.length);
                        continue;
                    }
                }
                diffCount++;
                addRange(red, tok);
            }
            CSS.highlights.set('qa-tm-found', green);
            CSS.highlights.set('qa-tm-diff', red);
        } else {
            for (const i of redIdx) if (!greenIdx.has(i)) diffCount++;
        }

        // drop diff rows whose words all turned out green via another line
        const finalItems = diffItems.filter(d => {
            if (d.missing) return true;
            for (let i = d.start; i < d.end; i++) if (!greenIdx.has(i)) return true;
            return false;
        });

        // words of whole-missing lines ("not on page") are differences too
        diffCount += unlocated;
        panel.querySelector('#qa-tm-match').textContent = matchCount;
        panel.querySelector('#qa-tm-diff').textContent = diffCount;
        // list every difference with one context word each side; click scrolls to it.
        // Words with a known ref counterpart show ONLY the differing chars red.
        const rowWordsHtml = (d) => {
            if (d.missing || !d.end || d.end <= d.start) return `<span class="bad">${escapeHtml(d.words)}</span>`;
            const grey = (t) => t ? `<span class="ctx">${escapeHtml(t)}</span>` : '';
            const parts = [];
            for (let i = d.start; i < d.end; i++) {
                const a = pageToks[i].rawWord;
                if (greenIdx.has(i)) { parts.push(grey(a)); continue; }
                const b = redRef.get(i);
                if (b) {
                    let p = 0; while (p < a.length && p < b.length && a[p].toLowerCase() === b[p].toLowerCase()) p++;
                    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s].toLowerCase() === b[b.length - 1 - s].toLowerCase()) s++;
                    const dS = p, dE = a.length - s;
                    if (dE <= dS) { parts.push(grey(a)); continue; }                 // subset -> matched
                    if (dS > 0 || dE < a.length) {                                   // partial -> red only the diff chars
                        parts.push(grey(a.slice(0, dS)) + `<span class="bad">${escapeHtml(a.slice(dS, dE))}</span>` + grey(a.slice(dE)));
                        continue;
                    }
                }
                parts.push(`<span class="bad">${escapeHtml(a)}</span>`);
            }
            return parts.join(' ');
        };
        lastDiffItems = finalItems;
        const dl = panel.querySelector('#qa-tm-difflist');
        if (finalItems.length) {
            dl.innerHTML = finalItems.slice(0, 100).map((d, i) =>
                `<div class="drow" data-i="${i}" dir="auto"><span class="ctx">… ${escapeHtml(d.before)} </span>${rowWordsHtml(d)}${d.missing ? '<span class="miss">(not on page)</span>' : ''}<span class="ctx"> ${escapeHtml(d.after)} …</span></div>`).join('');
            dl.classList.add('show');
        } else { dl.innerHTML = ''; dl.classList.remove('show'); }
        result.classList.add('show');

        const note = panel.querySelector('#qa-tm-note');
        if (!matchCount && !diffCount) note.textContent = 'No matching text found on the page.';
        else {
            let msg = canHL ? 'Green = matches · red = differs on the page.' : 'Highlighting not supported in this browser.';
            if (unlocated > 0) msg += ` ${unlocated} word${unlocated > 1 ? 's' : ''} not found anywhere on the page.`;
            note.textContent = msg;
        }
        let firstIdx = null;
        for (const i of greenIdx) if (firstIdx === null || i < firstIdx) firstIdx = i;
        const firstNode = firstIdx !== null ? pageToks[firstIdx].s.node : null;
        if (firstNode && firstNode.parentElement) { try { firstNode.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { } }
    };

    panel.querySelector('#qa-tm-run').addEventListener('click', runCheck);
    // toggling strict mode re-runs the check immediately if there's input
    panel.querySelector('#qa-tm-strict').addEventListener('change', () => { if (ta.value.trim()) runCheck(); });
    panel.querySelector('#qa-tm-close').addEventListener('click', closeTextMatchPanel);
    // minimize: collapse to just the header strip (highlights stay on the page)
    panel.querySelector('#qa-tm-min').addEventListener('click', (e) => {
        const min = panel.classList.toggle('min');
        e.currentTarget.innerHTML = min ? TM_IC.max : TM_IC.min;
    });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCheck(); } });
    // clicking a difference row scrolls to that spot and flashes a black
    // outline around the exact words so the user sees precisely where it is
    panel.querySelector('#qa-tm-difflist').addEventListener('click', (e) => {
        const row = e.target.closest('.drow');
        if (!row) return;
        const d = lastDiffItems[+row.dataset.i];
        if (!d || !d.sTok || !d.sTok.s.node.parentElement) return;
        try {
            const r = document.createRange();
            r.setStart(d.sTok.s.node, d.sTok.s.offset);
            r.setEnd(d.eTok.e.node, d.eTok.e.offset + 1);
            // The same marker the review tool uses. This used to guess at the scroll
            // with a 550ms timeout and then draw at fixed viewport coordinates - so
            // if the smooth scroll had not finished, the box landed above or below
            // the words, and any later scroll left it stranded over whatever had
            // moved into its place.
            reviewFlashRange(r);
        } catch (err) { }
    });

    // drag by header
    let off = null;
    const head = panel.querySelector('.hd');
    const down = (e) => { if (e.target.closest('button')) return; const r = panel.getBoundingClientRect(); off = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); };
    const move = (e) => { if (!off) return; panel.style.right = 'auto'; panel.style.left = Math.max(4, Math.min(innerWidth - 80, e.clientX - off.dx)) + 'px'; panel.style.top = Math.max(4, Math.min(innerHeight - 50, e.clientY - off.dy)) + 'px'; };
    const up = () => { off = null; };
    head.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);

    ta.focus();
}
// ============================================================================
// Shared: add a minimize button to an on-page panel - collapses everything
// except the header strip (highlights/state stay); click again to restore.
// ============================================================================
function qaAddMinimize(panel, headerEl, beforeBtn) {
    if (!panel || !headerEl || panel.querySelector('.qa-minbtn')) return;
    const MIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>';
    const MAX = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    const btn = document.createElement('button');
    btn.className = 'qa-minbtn';
    btn.title = 'Hide / show the panel';
    btn.innerHTML = MIN;
    btn.style.cssText = 'background:rgba(255,255,255,0.1);border:none;color:#fff;cursor:pointer;width:26px;height:26px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;margin-right:6px;flex:0 0 auto;';
    let min = false;
    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        min = !min;
        for (const ch of panel.children) {
            if (ch === headerEl || ch.tagName === 'STYLE') continue;
            ch.style.display = min ? 'none' : '';
        }
        btn.innerHTML = min ? MAX : MIN;
    });
    if (beforeBtn && beforeBtn.parentElement) {
        // keep the two buttons glued together even in space-between headers
        const wrap = document.createElement('span');
        wrap.style.cssText = 'display:inline-flex;align-items:center;flex:0 0 auto;';
        beforeBtn.parentElement.insertBefore(wrap, beforeBtn);
        wrap.appendChild(btn);
        wrap.appendChild(beforeBtn);
    } else headerEl.appendChild(btn);
}

// ============================================================================
// API Data Export — paste a "Copy as fetch" request from DevTools; the tool
// replays it through the background (no CORS wall), auto-paginates through
// every page, and downloads the whole dataset as CSV. No AI.
// ============================================================================
const AX_IC = (() => {
    const w = (p) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    return {
        x: w('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        db: w('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'),
        down: w('<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>')
    };
})();

// headers a fetch/service-worker cannot (or shouldn't) set - stripped on replay
const AX_SKIP_HEADERS = new Set(['host', 'connection', 'content-length', 'origin', 'referer', 'user-agent',
    'cookie', 'accept-encoding', 'pragma', 'cache-control', 'dnt', 'upgrade-insecure-requests', 'te',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'sec-ch-ua', 'sec-ch-ua-mobile',
    'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list', 'sec-ch-ua-model', 'sec-ch-ua-bitness', 'sec-ch-ua-wow64', 'proxy-authorization']);

// pull a balanced {...} out of a string starting at index i (string-aware)
function axBalanced(str, i) {
    let depth = 0, q = null;
    for (let k = i; k < str.length; k++) {
        const c = str[k];
        if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return str.slice(i, k + 1); }
    }
    return null;
}

// parse a "Copy as fetch" snippet (or a bare URL) into {url, method, headers, body}
function axParseFetch(text) {
    text = (text || '').trim();
    const m = text.match(/fetch\(\s*(["'`])([\s\S]*?)\1/);
    let url, headers = {}, method = 'GET', body = null;
    if (m) {
        url = m[2];
        const rest = text.slice(m.index + m[0].length);
        const oi = rest.indexOf('{');
        if (oi !== -1) {
            const objStr = axBalanced(rest, oi);
            if (objStr) {
                try {
                    const opts = JSON.parse(objStr);
                    headers = opts.headers || {};
                    method = (opts.method || 'GET').toUpperCase();
                    body = opts.body != null ? opts.body : null;
                } catch (e) { return { error: 'Could not read the fetch options — paste the exact "Copy as fetch" output.' }; }
            }
        }
    } else if (/^https?:\/\//i.test(text)) {
        url = text.split(/\s/)[0];
    } else {
        return { error: 'Paste a "Copy as fetch" snippet (DevTools → Network → right-click a request), or a URL.' };
    }
    const clean = {};
    for (const k of Object.keys(headers)) { if (!AX_SKIP_HEADERS.has(k.toLowerCase())) clean[k] = headers[k]; }
    // Force Accept to application/json. This tool only reads JSON, and a wildcard Accept like
    // "application/json, text/plain, */*" (what browsers copy) lets a framework such as ABP
    // pick HTML on error - so a rejected request comes back as a full themed error PAGE with
    // no readable reason. Asking strictly for JSON makes it answer with a JSON error object
    // (the actual message), and can itself resolve a 400 caused by content negotiation.
    for (const k of Object.keys(clean)) { if (k.toLowerCase() === 'accept') delete clean[k]; }
    clean['Accept'] = 'application/json';
    return { url, method, headers: clean, body };
}

// Pagination can live in the POST BODY, not just the URL query (ABP's skipCount/maxResultCount
// is the common case). Parse a JSON body and find the skip/page + size keys, so the walker can
// advance them per page instead of re-requesting page 1 forever.
function axDetectBodyPaging(body) {
    if (typeof body !== 'string' || !body.trim().startsWith('{')) return null;
    let root; try { root = JSON.parse(body); } catch (e) { return null; }
    if (!root || typeof root !== 'object') return null;
    const SKIP = ['skipcount', 'skip', 'offset', 'start', 'startindex', 'from'];
    const SIZE = ['maxresultcount', 'maxrecords', 'take', 'limit', 'top', 'pagesize', 'perpage', 'per_page', 'size', 'rows'];
    const PAGE = ['pagenumber', 'pageindex', 'page', 'pageno'];
    // The paging keys may sit in a nested object (OutSystems: screenData.variables.<X>Pagination
    // .StartIndex/MaxRecords). Walk breadth-first so the shallowest match wins; objPath is where
    // the walker writes the advanced values back.
    const queue = [{ obj: root, path: [] }];
    while (queue.length) {
        const { obj, path } = queue.shift();
        const lc = {}; for (const k of Object.keys(obj)) lc[k.toLowerCase()] = k;
        const find = (names) => { for (const n of names) { const real = lc[n]; if (real !== undefined && /^\d+$/.test(String(obj[real]).trim())) return real; } return null; };
        const sizeKey = find(SIZE), skipKey = find(SKIP), pageKey = find(PAGE);
        const size = sizeKey ? (parseInt(obj[sizeKey]) || 100) : 100;
        if (skipKey) return { where: 'body', objPath: path, mode: 'skip', skipParam: skipKey, sizeParam: sizeKey, size, start: parseInt(obj[skipKey]) || 0 };
        if (pageKey) return { where: 'body', objPath: path, mode: 'page', pageParam: pageKey, sizeParam: sizeKey, size, start: parseInt(obj[pageKey]) || 1 };
        if (path.length < 6) for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) queue.push({ obj: v, path: path.concat(k) });
        }
    }
    return null;
}

// figure out the pagination scheme from the URL's query string. Any "offset"
// param + any "size" param counts as skip-mode (handles mixed conventions like
// DummyJSON's skip+limit); otherwise a "page" param + optional "size" param.
function axDetectPagination(urlStr) {
    let u; try { u = new URL(urlStr); } catch (e) { return null; }
    const sp = u.searchParams;
    const lc = {}; for (const [k] of sp) lc[k.toLowerCase()] = k;   // lower -> real casing
    // The value must be a plain integer: names like `from` double as date
    // filters (from=2024-01-01), and rewriting those would corrupt the query.
    const find = (names) => {
        for (const n of names) {
            const real = lc[n];
            if (real === undefined) continue;
            const v = (sp.get(real) || '').trim();
            if (/^\d+$/.test(v)) return real;
        }
        return null;
    };

    const SKIP = ['skipcount', 'skip', '_start', 'offset', '$skip', 'start', 'startindex', 'from'];
    const SIZE = ['maxresultcount', 'take', 'limit', '_limit', '$top', 'top', 'pagesize', 'perpage', 'per_page', 'size', 'rows'];
    const PAGE = ['pagenumber', 'pageindex', 'page', '_page', 'pageno'];

    const sizeKey = find(SIZE);
    const skipKey = find(SKIP);
    const pageKey = find(PAGE);
    const size = sizeKey ? (parseInt(sp.get(sizeKey)) || 100) : 100;

    if (skipKey) return { mode: 'skip', skipParam: skipKey, sizeParam: sizeKey || 'maxResultCount', size, start: parseInt(sp.get(skipKey)) || 0 };
    if (pageKey) return { mode: 'page', pageParam: pageKey, sizeParam: sizeKey, size, start: parseInt(sp.get(pageKey)) || 1 };
    return null;
}

// Turn a server error response into one readable line. ABP/most APIs return a JSON error
// object; a framework error PAGE comes back as HTML - say so instead of dumping markup.
function axServerReason(text) {
    if (!text) return '';
    const t = String(text).trim();
    if (/^\s*</.test(t) || /^<!doctype/i.test(t)) {
        const m = t.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return 'The server returned an error page' + (m ? ' ("' + m[1].trim().slice(0, 80) + '")' : '') + '. The request was rejected — the endpoint may expect different parameters.';
    }
    try {
        const j = JSON.parse(t);
        const e = j && (j.error || j);
        const msg = e && (e.message || e.details || e.title || e.error_description);
        if (msg) return String(msg).slice(0, 200);
    } catch (e) { }
    return t.slice(0, 200);
}

function axExtractItems(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object') {
        for (const k of ['items', 'data', 'results', 'value', 'records', 'rows', 'list', 'content']) if (Array.isArray(json[k])) return json[k];
        for (const k in json) if (Array.isArray(json[k])) return json[k];
        // Nothing at the top level: the rows are nested (OutSystems: data.<Output>.List). Take
        // the largest array of records anywhere below; the shallowest one wins a tie.
        let best = [];
        const queue = [{ v: json, d: 0 }];
        while (queue.length) {
            const { v, d } = queue.shift();
            if (Array.isArray(v)) {
                if (v.length > best.length && v.some((x) => x && typeof x === 'object' && !Array.isArray(x))) best = v;
                continue;
            }
            if (d < 6) for (const k in v) if (v[k] && typeof v[k] === 'object') queue.push({ v: v[k], d: d + 1 });
        }
        return best;
    }
    return [];
}
function axExtractTotal(json) {
    if (!json || typeof json !== 'object') return null;
    const KEYS = ['totalcount', 'total', 'count', 'totalrecords', 'totalitems', 'recordstotal', 'totalelements'];
    // Top level first (exact numbers), then nested objects. OutSystems serializes Long Integer
    // as a string ("TotalCount":"118"), so numeric strings count there.
    const queue = [{ v: json, d: 0 }];
    while (queue.length) {
        const { v, d } = queue.shift();
        const lc = {}; for (const k of Object.keys(v)) lc[k.toLowerCase()] = k;
        for (const n of KEYS) {
            const real = lc[n]; if (real === undefined) continue;
            const x = v[real];
            if (typeof x === 'number') return x;
            if (typeof x === 'string' && /^\d+$/.test(x.trim())) return parseInt(x);
        }
        if (d < 6) for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) queue.push({ v: v[k], d: d + 1 });
    }
    return null;
}

function axBgFetch(url, method, headers, body) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'apiFetch', url, method, headers, body }, (r) => {
            if (chrome.runtime.lastError) resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message });
            else resolve(r || { ok: false, status: 0, error: 'No response' });
        });
    });
}

function axSameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
}

// Same-origin requests run in the PAGE context (this content script): that
// reuses the page's cert trust + cookies and dodges CORS — essential for
// internal HTTPS sites with self-signed certs, where a background fetch fails
// with "Failed to fetch" (HTTP 0). Cross-origin requests still go via bg.
// A request carrying an Authorization token authenticates by THAT token - it needs no
// cookies. Worse, sending the session cookie too makes a framework like ABP switch to
// cookie-auth and then demand an anti-forgery token for the POST, which we don't have, so
// it answers 400. (A real cross-site browser call drops the cookie via SameSite anyway, so
// omitting it just matches what the browser already does.) Cookie-only sites keep 'include'.
function axCredentials(headers) {
    const hasAuth = Object.keys(headers || {}).some((k) => k.toLowerCase() === 'authorization');
    return hasAuth ? 'omit' : 'include';
}

async function axFetch(url, method, headers, body) {
    // Same-origin: fetch straight from this page - it already trusts the cert and holds the
    // session cookies.
    if (axSameOrigin(url)) {
        try {
            const opts = { method: method || 'GET', headers: headers || {}, credentials: axCredentials(headers), redirect: 'follow' };
            if (body != null && !/^(GET|HEAD)$/i.test(opts.method)) opts.body = body;
            const resp = await fetch(url, opts);
            const text = await resp.text();
            return { ok: resp.ok, status: resp.status, text };
        } catch (e) {
            return { ok: false, status: 0, error: String((e && e.message) || e) };
        }
    }
    // Cross-origin: hand it to the background, which runs it inside a real tab (this app's
    // tab first - it demonstrably reaches this API in normal use, so its CORS + session +
    // accepted certificate all apply). A raw background fetch is the last resort.
    return axBgFetch(url, method, headers, body);
}

function axToCsv(items) {
    const cols = [...new Set(items.flatMap(i => (i && typeof i === 'object') ? Object.keys(i) : []))];
    const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `"${s.replace(/"/g, '""')}"`;
    };
    return '﻿' + [cols.join(','), ...items.map(it => cols.map(c => esc(it ? it[c] : '')).join(','))].join('\r\n');
}
function axDownload(text, name) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function closeApiExportPanel() {
    const p = document.getElementById('qa-ax'); if (p) p.remove();
    const s = document.getElementById('qa-ax-style'); if (s) s.remove();
    document.querySelectorAll('.qa-tbl-hl').forEach((e) => e.classList.remove('qa-tbl-hl'));
}

let axLastRows = null;

// ── Generic HTML data detection (no site-specific classes) ──────────────────────
// The data on a page is whatever REPEATS: table rows, cards, list items. Find every
// container whose direct children share one structure and repeat ≥ 3 times - those
// children are the "rows". Works the same on a <table>, a grid of <div> cards, or a <ul>.
const AX_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'PATH', 'BR', 'HR', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);

// A structural signature of an element: tag + its class list. Two siblings with the same
// signature are "the same kind of thing" (two cards, two rows).
function axSig(el) {
    const cls = (el.getAttribute && el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).sort().join('.');
    return el.tagName + (cls ? '.' + cls : '');
}

function axVisible(el) {
    if (!el || !el.getClientRects) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
}

// Every repeating group on the page, richest first.
function axFindGroups() {
    const groups = [];
    const containers = document.querySelectorAll('*');
    for (const parent of containers) {
        if (AX_SKIP_TAGS.has(parent.tagName)) continue;
        const kids = Array.from(parent.children).filter((c) => !AX_SKIP_TAGS.has(c.tagName));
        if (kids.length < 3) continue;
        // tbody wrapping tr, or a grid wrapping cards: bucket the children by signature
        const buckets = new Map();
        for (const k of kids) {
            const s = axSig(k);
            (buckets.get(s) || buckets.set(s, []).get(s)).push(k);
        }
        for (const [sig, items] of buckets) {
            if (items.length < 3) continue;
            const visItems = items.filter(axVisible);
            if (visItems.length < 3) continue;
            const text = visItems.reduce((n, it) => n + (it.innerText || '').trim().length, 0);
            if (text < 10) continue;
            groups.push({ parent, sig, items: visItems, count: visItems.length, text });
        }
    }
    // Prefer many rows AND lots of text; drop groups nested inside a bigger chosen one later.
    groups.sort((a, b) => (b.count * Math.log(b.text + 10)) - (a.count * Math.log(a.text + 10)));
    // De-duplicate: if one group's items each CONTAIN another group's items, keep the outer.
    const kept = [];
    for (const g of groups) {
        if (kept.some((k) => k.items.some((ki) => ki.contains(g.items[0]) || g.items[0].contains(ki) && g.parent !== k.parent && k.parent.contains(g.parent)))) continue;
        kept.push(g);
        if (kept.length >= 8) break;
    }
    return kept;
}

// Extract the fields of one item as {key,value} cells. A "field" is a descendant that owns
// its own text (not just text bubbling up from children) or is a link. The column key is a
// readable, stable name derived from the field's class or tag, so the same field lines up
// across every item.
function axItemCells(item) {
    const cells = [];
    const keyCount = {};
    const nameOf = (el) => {
        const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
            .filter((c) => !/^(d-|col-|row|text-|bg-|p-|m-|px-|py-|mb-|mt-|gap-|rounded|border|flex|align|justify|w-|h-)/.test(c));
        let base = cls[0] || el.getAttribute('data-label') || el.tagName.toLowerCase();
        base = base.replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'field';
        keyCount[base] = (keyCount[base] || 0) + 1;
        return keyCount[base] > 1 ? base + ' ' + keyCount[base] : base;
    };
    const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    const walk = (el) => {
        for (const ch of el.children) {
            if (AX_SKIP_TAGS.has(ch.tagName) || !axVisible(ch)) continue;
            const isLink = ch.tagName === 'A' && ch.getAttribute('href');
            const t = (ch.innerText || '').trim().replace(/\s+/g, ' ');
            if ((ownText(ch) || isLink) && t) {
                cells.push({ key: nameOf(ch), value: t });
                if (isLink) cells.push({ key: nameOf(ch) + ' link', value: ch.href });
            } else if (ch.children.length) {
                walk(ch);
            } else if (t) {
                cells.push({ key: nameOf(ch), value: t });
            }
        }
    };
    walk(item);
    // Fallback: an item with no inner structure at all -> its whole text is one column.
    if (!cells.length) { const t = (item.innerText || '').trim().replace(/\s+/g, ' '); if (t) cells.push({ key: 'text', value: t }); }
    return cells;
}

// Turn a group's items into rows of aligned columns.
function axScrapeGroup(items) {
    const rows = [];
    for (const it of items) {
        const cells = axItemCells(it);
        const row = {};
        for (const c of cells) { if (!(c.key in row)) row[c.key] = c.value; }
        if (Object.keys(row).length) rows.push(row);
    }
    return rows;
}

// A page's "next" control, if any: pagination libraries all mark it one of these ways.
function axFindNext() {
    const cand = Array.from(document.querySelectorAll(
        'a[rel="next"], [aria-label*="next" i], [class*="next" i], li.next > a, button[title*="next" i], .pagination a, .paginate_button.next'));
    const byText = Array.from(document.querySelectorAll('a, button')).filter((b) => {
        const t = (b.innerText || b.textContent || '').trim();
        return t === '›' || t === '»' || t === '>' || /^next$/i.test(t) || t === 'التالي' || t === 'التالى';
    });
    const all = [...new Set([...cand, ...byText])];
    for (const el of all) {
        if (!axVisible(el)) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true'
            || /disabled/.test(el.className) || (el.closest('li') && /disabled/.test(el.closest('li').className));
        if (!disabled) return el;
    }
    return null;
}

function openApiExportPanel() {
    if (document.getElementById('qa-ax')) { closeApiExportPanel(); return; }
    qaCancelAllTools();
    const style = document.createElement('style');
    style.id = 'qa-ax-style';
    style.textContent = `
#qa-ax{position:fixed;top:16px;right:16px;width:380px;max-height:88vh;z-index:2147483647;display:flex;flex-direction:column;direction:ltr;
  background:#17151f;color:#e5e7eb;border:1px solid #2a2738;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.6);font:13px/1.45 -apple-system,Segoe UI,sans-serif;overflow:hidden;}
#qa-ax *{box-sizing:border-box;}
#qa-ax .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:#1c1a26;border-bottom:1px solid #2a2738;cursor:move;user-select:none;}
#qa-ax .ttl{font-weight:600;display:flex;align-items:center;gap:7px;}
#qa-ax .ttl svg{color:#34d399;}
#qa-ax .iconbtn{all:unset;cursor:pointer;color:#8b8898;padding:5px;border-radius:7px;display:flex;}
#qa-ax .iconbtn:hover{background:#3a1d24;color:#f87171;}
#qa-ax .bd{padding:13px;overflow-y:auto;}
#qa-ax textarea{width:100%;height:150px;resize:vertical;background:#0f0e16;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:9px 10px;font:11.5px/1.5 Consolas,monospace;outline:none;}
#qa-ax textarea:focus{border-color:#7c3aed;}
#qa-ax .hint{font-size:11px;color:#6b6878;margin:7px 2px 10px;line-height:1.5;}
#qa-ax .row{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
#qa-ax .row label{font-size:11.5px;color:#a9a6b8;}
#qa-ax .row input{width:110px;background:#0f0e16;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:6px 8px;font-size:12px;outline:none;}
#qa-ax .go{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;width:100%;background:#7c3aed;color:#fff;font-weight:600;font-size:13px;padding:11px 0;border-radius:9px;}
#qa-ax .go:hover{background:#6d28d9;}
#qa-ax .go[disabled]{opacity:.6;cursor:default;}
#qa-ax .spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:qaaxspin .7s linear infinite;}
@keyframes qaaxspin{to{transform:rotate(360deg)}}
#qa-ax .prog{margin-top:12px;display:none;}
#qa-ax .prog.show{display:block;}
#qa-ax .bar{height:8px;background:#0f0e16;border:1px solid #2a2738;border-radius:6px;overflow:hidden;}
#qa-ax .bar>i{display:block;height:100%;width:0;background:#7c3aed;transition:width .2s;}
#qa-ax .pmeta{font-size:11.5px;color:#a9a6b8;margin-top:6px;text-align:center;font-variant-numeric:tabular-nums;}
#qa-ax .done{margin-top:12px;display:none;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.35);border-radius:10px;padding:12px;text-align:center;}
#qa-ax .done.show{display:block;}
#qa-ax .done .n{font-size:22px;font-weight:800;color:#34d399;}
#qa-ax .done .l{font-size:11px;color:#94a3b8;margin:2px 0 10px;}
#qa-ax .done button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:#1d1a28;border:1px solid #2a2738;color:#e5e7eb;border-radius:8px;padding:7px 14px;font-weight:600;font-size:12px;}
#qa-ax .done button:hover{background:#262335;}
#qa-ax .err{color:#f87171;font-size:12px;margin-top:10px;word-break:break-word;}
#qa-ax .modes{display:flex;gap:6px;margin-bottom:12px;background:#0f0e16;border:1px solid #2a2738;border-radius:9px;padding:3px;}
#qa-ax .mode{flex:1;text-align:center;cursor:pointer;font-size:12px;font-weight:600;color:#8b8898;padding:7px 0;border-radius:7px;user-select:none;display:flex;align-items:center;justify-content:center;gap:6px;}
#qa-ax .mode.on{background:#7c3aed;color:#fff;}
#qa-ax .tables{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;max-height:170px;overflow:auto;}
#qa-ax .tbl{display:flex;align-items:center;gap:9px;cursor:pointer;background:#0f0e16;border:1px solid #2a2738;border-left-width:3px;border-radius:8px;padding:8px 10px;text-align:left;}
#qa-ax .tbl:hover{border-color:#7c3aed;}
#qa-ax .tbl.on{border-left-color:#34d399;background:#161326;}
#qa-ax .tbl .tn{flex:1;min-width:0;font-size:12px;color:#e5e7eb;}
#qa-ax .tbl .tn small{display:block;color:#8b8898;font-size:10.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#qa-ax .tbl .tc{flex-shrink:0;background:rgba(124,58,237,.25);color:#c4b5fd;border-radius:10px;padding:1px 8px;font-size:10.5px;font-weight:700;}
#qa-ax .empty2{font-size:11.5px;color:#6b6878;text-align:center;padding:14px 6px;line-height:1.5;}
#qa-ax .chk{display:flex;align-items:center;gap:7px;margin-bottom:10px;font-size:11.5px;color:#a9a6b8;cursor:pointer;user-select:none;}
#qa-ax .chk input{width:auto;accent-color:#7c3aed;}
#qa-ax .qa-tbl-hl{outline:3px solid #7c3aed !important;outline-offset:1px;transition:outline .1s;}`;
    (document.head || document.documentElement).appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'qa-ax';
    panel.innerHTML = `
<div class="hd">
  <span class="ttl">${AX_IC.db} API Data Export</span>
  <button class="iconbtn" id="qa-ax-close" title="Close">${AX_IC.x}</button>
</div>
<div class="bd">
  <div class="modes">
    <div class="mode on" data-m="json">JSON API</div>
    <div class="mode" data-m="html">HTML / Table</div>
  </div>

  <div id="qa-ax-json">
    <textarea id="qa-ax-in" spellcheck="false" placeholder='Paste "Copy as fetch" here…\n\nDevTools → Network → right-click the request → Copy → Copy as fetch'></textarea>
    <div class="hint">The tool replays the request, walks every page automatically, and saves all rows as CSV. Pagination (skipCount/pageNumber…) is detected from the URL or the request body.</div>
    <div class="row">
      <label>Max rows (safety)</label><input type="number" id="qa-ax-max" value="100000" min="1">
    </div>
    <button class="go" id="qa-ax-run">Fetch &amp; Export CSV</button>
  </div>

  <div id="qa-ax-html" style="display:none;">
    <div class="hint" style="margin-top:0;">Repeating blocks on this page (tables, cards, lists). Pick the one that holds your data — hover to highlight it.</div>
    <div class="tables" id="qa-ax-tables"></div>
    <label class="chk"><input type="checkbox" id="qa-ax-next" checked> Walk pages by clicking the “next” button</label>
    <div class="row">
      <label>Max pages</label><input type="number" id="qa-ax-maxp" value="500" min="1">
    </div>
    <button class="go" id="qa-ax-hrun" disabled>Scrape &amp; Export CSV</button>
  </div>

  <div class="prog" id="qa-ax-prog"><div class="bar"><i id="qa-ax-fill"></i></div><div class="pmeta" id="qa-ax-meta"></div></div>
  <div class="done" id="qa-ax-done"><div class="n" id="qa-ax-count">0</div><div class="l">rows exported</div><button id="qa-ax-again">${AX_IC.down} Download CSV again</button></div>
  <div class="err" id="qa-ax-err"></div>
</div>`;
    document.body.appendChild(panel);

    const $ = (s) => panel.querySelector(s);
    const err = $('#qa-ax-err'), prog = $('#qa-ax-prog'), fill = $('#qa-ax-fill'), meta = $('#qa-ax-meta'),
        done = $('#qa-ax-done'), runBtn = $('#qa-ax-run');
    let busy = false;

    const run = async () => {
        if (busy) return;
        err.textContent = ''; done.classList.remove('show');
        const parsed = axParseFetch($('#qa-ax-in').value);
        if (parsed.error) { err.textContent = parsed.error; return; }
        const maxRows = Math.max(1, parseInt($('#qa-ax-max').value) || 100000);
        // Pagination lives in the URL query OR the POST body. The body case (ABP's
        // skipCount/maxResultCount) was invisible before, so the walker kept re-requesting
        // page 1 - and some servers reject the unchanged repeat with a 400.
        const pag = axDetectPagination(parsed.url) || axDetectBodyPaging(parsed.body);

        busy = true; runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span> Fetching…';
        prog.classList.add('show'); fill.style.width = '0'; meta.textContent = 'Starting…';

        let all = [], total = null, cur = pag ? pag.start : 0, guard = 0;
        try {
            while (guard++ < 100000) {
                let pageUrl = parsed.url;
                let pageBody = parsed.body;
                if (pag && pag.where === 'body') {
                    // advance the skip/page value inside the JSON body
                    let root = {}; try { root = JSON.parse(parsed.body); } catch (e) { }
                    let o = root; for (const k of (pag.objPath || [])) o = o[k];
                    if (pag.mode === 'skip') { o[pag.skipParam] = cur; if (pag.sizeParam) o[pag.sizeParam] = pag.size; }
                    else { o[pag.pageParam] = cur; if (pag.sizeParam) o[pag.sizeParam] = pag.size; }
                    pageBody = JSON.stringify(root);
                } else if (pag) {
                    const u = new URL(parsed.url);
                    if (pag.mode === 'skip') { u.searchParams.set(pag.skipParam, String(cur)); u.searchParams.set(pag.sizeParam, String(pag.size)); }
                    else { u.searchParams.set(pag.pageParam, String(cur)); if (pag.sizeParam) u.searchParams.set(pag.sizeParam, String(pag.size)); }
                    pageUrl = u.toString();
                }
                const r = await axFetch(pageUrl, parsed.method, parsed.headers, pageBody);
                if (!r.ok) {
                    if (r.status === 401 || r.status === 403) throw new Error('Unauthorized (' + r.status + ') — the token/session expired. Reload the page, re-copy the request, and paste again.');
                    if (r.status === 0) throw new Error(`Could not reach the server (${r.error || 'Failed to fetch'}). Open the site in a tab first and accept any certificate warning, then retry.`);
                    // Show WHAT the server said - the reason for the rejection, not just the code.
                    throw new Error(`Request failed (HTTP ${r.status}). ${axServerReason(r.text)}`);
                }
                let json; try { json = JSON.parse(r.text); } catch (e) { throw new Error('Response is not JSON — this endpoint may not return data rows.'); }
                const items = axExtractItems(json);
                const t = axExtractTotal(json); if (t != null) total = t;
                all = all.concat(items);
                const pct = total ? Math.min(100, Math.round(all.length / total * 100)) : 0;
                fill.style.width = (total ? pct : 100) + '%';
                meta.textContent = total ? `${all.length} / ${total}` : `${all.length} rows…`;
                if (!pag) break;
                if (!items.length) break;                       // a truly empty page = the end
                if (total != null && all.length >= total) break;
                // A short page means "the end" ONLY when there's no total to trust. With a
                // known total, keep going: some pages come back filtered/short in the middle,
                // and stopping on the first one is what cut an export off at 19 of 118.
                if (total == null && items.length < pag.size) break;
                if (all.length >= maxRows) { all = all.slice(0, maxRows); break; }
                // Skip/offset mode advances by how many rows we ACTUALLY received, not the
                // requested size - so a short page in the middle doesn't skip the rows right
                // after it (advancing by size would leave a gap).
                cur += (pag.mode === 'skip') ? items.length : 1;
            }
        } catch (e) {
            busy = false; runBtn.disabled = false; runBtn.innerHTML = 'Fetch &amp; Export CSV';
            err.textContent = String(e.message || e);
            return;
        }

        busy = false; runBtn.disabled = false; runBtn.innerHTML = 'Fetch &amp; Export CSV';
        if (!all.length) { err.textContent = 'The request returned no data rows.'; prog.classList.remove('show'); return; }
        fill.style.width = '100%';
        let host = 'data'; try { host = new URL(parsed.url).hostname.replace(/^www\./, ''); } catch (e) { }
        const name = `${host}-${all.length}rows.csv`;
        axLastRows = { csv: axToCsv(all), name };
        axDownload(axLastRows.csv, axLastRows.name);
        $('#qa-ax-count').textContent = all.length.toLocaleString();
        done.classList.add('show');
    };

    runBtn.addEventListener('click', run);

    // ── HTML / Table mode ──────────────────────────────────────────────────────
    let axGroups = [], axPickedGroup = null;
    const hrun = $('#qa-ax-hrun');

    function renderTables() {
        document.querySelectorAll('.qa-tbl-hl').forEach((e) => e.classList.remove('qa-tbl-hl'));
        axGroups = axFindGroups();
        axPickedGroup = null; hrun.disabled = true;
        const box = $('#qa-ax-tables');
        if (!axGroups.length) { box.innerHTML = '<div class="empty2">No repeating data blocks found on this page.<br>Open a page that shows a list or table, then reopen this tool.</div>'; return; }
        box.innerHTML = '';
        axGroups.forEach((g, i) => {
            const sample = axItemCells(g.items[0]).slice(0, 3).map((c) => c.value).join(' · ').slice(0, 60);
            const cols = Object.keys(axScrapeGroup(g.items.slice(0, 1))[0] || {}).length;
            const el = document.createElement('div');
            el.className = 'tbl'; el.dataset.i = i;
            el.innerHTML = `<div class="tn">${dEsc((g.items[0].tagName === 'TR' ? 'Table rows' : 'Cards / list'))} <small>${dEsc(sample || '…')}</small></div>
                <span class="tc">${g.count} × ${cols || '?'}</span>`;
            box.appendChild(el);
        });
    }
    const dEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

    $('#qa-ax-tables').addEventListener('mouseover', (e) => {
        const t = e.target.closest('.tbl'); if (!t) return;
        document.querySelectorAll('.qa-tbl-hl').forEach((x) => x.classList.remove('qa-tbl-hl'));
        const g = axGroups[+t.dataset.i]; if (g) g.items.forEach((it) => it.classList.add('qa-tbl-hl'));
    });
    $('#qa-ax-tables').addEventListener('click', (e) => {
        const t = e.target.closest('.tbl'); if (!t) return;
        $('#qa-ax-tables').querySelectorAll('.tbl').forEach((x) => x.classList.remove('on'));
        t.classList.add('on');
        axPickedGroup = +t.dataset.i; hrun.disabled = false;
        const g = axGroups[axPickedGroup];
        if (g) { try { g.items[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { } }
    });

    // mode switch
    panel.querySelectorAll('.mode').forEach((m) => m.addEventListener('click', () => {
        panel.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === m));
        const isHtml = m.dataset.m === 'html';
        $('#qa-ax-json').style.display = isHtml ? 'none' : '';
        $('#qa-ax-html').style.display = isHtml ? '' : 'none';
        err.textContent = ''; done.classList.remove('show'); prog.classList.remove('show');
        if (isHtml) renderTables();
        else document.querySelectorAll('.qa-tbl-hl').forEach((x) => x.classList.remove('qa-tbl-hl'));
    }));

    const rowSig = (rows) => rows.length + '|' + JSON.stringify(rows[0] || {}) + '|' + JSON.stringify(rows[rows.length - 1] || {});

    const hrunFn = async () => {
        if (busy || axPickedGroup == null) return;
        err.textContent = ''; done.classList.remove('show');
        const walkPages = $('#qa-ax-next').checked;
        const maxPages = Math.max(1, parseInt($('#qa-ax-maxp').value) || 500);
        busy = true; hrun.disabled = true; hrun.innerHTML = '<span class="spin"></span> Scraping…';
        prog.classList.add('show'); fill.style.width = '0'; meta.textContent = 'Scraping…';
        document.querySelectorAll('.qa-tbl-hl').forEach((x) => x.classList.remove('qa-tbl-hl'));

        const seen = new Set(), all = [];
        const sigOfRow = (r) => JSON.stringify(Object.values(r));
        // re-find the picked group each page by its structure signature, since the page's
        // rows are replaced when you paginate.
        const wantSig = axGroups[axPickedGroup].sig;
        const grabCurrent = () => {
            const gs = axFindGroups().filter((g) => g.sig === wantSig);
            const g = gs.sort((a, b) => b.count - a.count)[0];
            return g ? axScrapeGroup(g.items) : [];
        };
        try {
            let page = 0, lastSig = '';
            while (page++ < maxPages) {
                const rows = grabCurrent();
                let added = 0;
                for (const r of rows) { const s = sigOfRow(r); if (!seen.has(s)) { seen.add(s); all.push(r); added++; } }
                meta.textContent = `${all.length} rows · page ${page}`;
                fill.style.width = Math.min(95, page * 3) + '%';
                if (!walkPages) break;
                const nowSig = rowSig(rows);
                if (nowSig === lastSig && added === 0) break;   // nothing new -> done
                lastSig = nowSig;
                const next = axFindNext();
                if (!next) break;
                next.scrollIntoView({ block: 'center' });
                next.click();
                // wait for the rows to actually change
                const before = nowSig;
                let changed = false;
                for (let i = 0; i < 40; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (rowSig(grabCurrent()) !== before) { changed = true; break; }
                }
                if (!changed) break;
            }
        } catch (e) {
            busy = false; hrun.disabled = false; hrun.innerHTML = 'Scrape &amp; Export CSV';
            err.textContent = String(e.message || e); return;
        }

        busy = false; hrun.disabled = false; hrun.innerHTML = 'Scrape &amp; Export CSV';
        if (!all.length) { err.textContent = 'Could not read any rows from that block.'; prog.classList.remove('show'); return; }
        fill.style.width = '100%';
        const host = location.hostname.replace(/^www\./, '');
        const name = `${host}-${all.length}rows.csv`;
        axLastRows = { csv: axToCsv(all), name };
        axDownload(axLastRows.csv, axLastRows.name);
        $('#qa-ax-count').textContent = all.length.toLocaleString();
        done.classList.add('show');
    };
    hrun.addEventListener('click', hrunFn);

    $('#qa-ax-again').addEventListener('click', () => { if (axLastRows) axDownload(axLastRows.csv, axLastRows.name); });
    $('#qa-ax-close').addEventListener('click', closeApiExportPanel);
    qaAddMinimize(panel, panel.querySelector('.hd'), $('#qa-ax-close'));

    // drag by header
    let off = null; const head = panel.querySelector('.hd');
    head.addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; const r = panel.getBoundingClientRect(); off = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!off) return; panel.style.right = 'auto'; panel.style.left = Math.max(4, Math.min(innerWidth - 80, e.clientX - off.dx)) + 'px'; panel.style.top = Math.max(4, Math.min(innerHeight - 50, e.clientY - off.dy)) + 'px'; });
    document.addEventListener('mouseup', () => { off = null; });

    panel.querySelector('#qa-ax-in').focus();
}

// ============================================================================
// Time Machine — override the page's clock (window.Date) to any date/time
// ============================================================================
const TMX_IC = {
    clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

function tmxToInput(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function tmxFmt(ms) {
    try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }); } catch (e) { return String(ms); }
}
function closeTimeMachinePanel() { const p = document.getElementById('qa-tmx'); if (p) p.remove(); const s = document.getElementById('qa-tmx-style'); if (s) s.remove(); if (window.__qaTmxTick) { clearInterval(window.__qaTmxTick); window.__qaTmxTick = null; } }

function openTimeMachinePanel() {
    if (document.getElementById('qa-tmx')) { closeTimeMachinePanel(); return; }
    qaCancelAllTools();
    const style = document.createElement('style');
    style.id = 'qa-tmx-style';
    style.textContent = `
#qa-tmx{position:fixed;top:16px;right:16px;width:340px;z-index:2147483647;display:flex;flex-direction:column;direction:ltr;
  background:#17151f;color:#e5e7eb;border:1px solid #2a2738;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.6);font:13px/1.45 -apple-system,Segoe UI,sans-serif;overflow:hidden;}
#qa-tmx *{box-sizing:border-box;}
#qa-tmx .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;background:#1c1a26;border-bottom:1px solid #2a2738;cursor:move;user-select:none;}
#qa-tmx .ttl{font-weight:600;display:flex;align-items:center;gap:7px;}
#qa-tmx .ttl svg{color:#38bdf8;}
#qa-tmx .iconbtn{all:unset;cursor:pointer;color:#8b8898;padding:5px;border-radius:7px;display:flex;}
#qa-tmx .iconbtn:hover{background:#3a1d24;color:#f87171;}
#qa-tmx .bd{padding:13px;}
#qa-tmx label.lbl{display:block;font-size:11.5px;color:#a9a6b8;margin:0 2px 5px;}
#qa-tmx input[type=datetime-local]{width:100%;background:#0f0e16;border:1px solid #2a2738;color:#fff;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;color-scheme:dark;}
#qa-tmx input[type=datetime-local]:focus{border-color:#38bdf8;}
#qa-tmx .presets{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0 12px;}
#qa-tmx .presets button{all:unset;cursor:pointer;font-size:11px;color:#cbd5e1;background:#0f0e16;border:1px solid #2a2738;border-radius:7px;padding:5px 8px;flex:0 0 auto;}
#qa-tmx .presets button:hover{border-color:#38bdf8;color:#fff;}
#qa-tmx .seg{display:flex;background:#0f0e16;border:1px solid #2a2738;border-radius:9px;padding:3px;margin-bottom:12px;}
#qa-tmx .seg button{all:unset;cursor:pointer;flex:1;text-align:center;font-size:12px;padding:7px 0;border-radius:6px;color:#a9a6b8;}
#qa-tmx .seg button.on{background:#38bdf8;color:#0b1220;font-weight:700;}
#qa-tmx .seg small{display:block;font-size:9.5px;opacity:.75;font-weight:400;}
#qa-tmx .acts{display:flex;gap:8px;}
#qa-tmx .go{all:unset;cursor:pointer;flex:1;text-align:center;background:#38bdf8;color:#0b1220;font-weight:700;font-size:13px;padding:10px 0;border-radius:9px;}
#qa-tmx .go:hover{background:#0ea5e9;}
#qa-tmx .reset{all:unset;cursor:pointer;text-align:center;background:#1d1a28;border:1px solid #2a2738;color:#e5e7eb;font-weight:600;font-size:12.5px;padding:10px 16px;border-radius:9px;}
#qa-tmx .reset:hover{background:#262335;}
#qa-tmx .status{display:none;margin-top:12px;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.32);border-radius:10px;padding:11px 12px;}
#qa-tmx .status.on{display:block;}
#qa-tmx .status .now{font-size:16px;font-weight:800;color:#7dd3fc;font-variant-numeric:tabular-nums;}
#qa-tmx .status .sub{font-size:11px;color:#94a3b8;margin-top:3px;}
#qa-tmx .status .real{font-size:10.5px;color:#6b6878;margin-top:6px;}
#qa-tmx .hint{font-size:11px;color:#6b6878;margin-top:11px;line-height:1.5;}
#qa-tmx .hint a{color:#7dd3fc;cursor:pointer;text-decoration:underline;}`;
    (document.head || document.documentElement).appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'qa-tmx';
    panel.innerHTML = `
<div class="hd">
  <span class="ttl">${TMX_IC.clock} Time Machine</span>
  <button class="iconbtn" id="qa-tmx-close" title="Close">${TMX_IC.x}</button>
</div>
<div class="bd">
  <label class="lbl">Set the page's clock to</label>
  <input type="datetime-local" id="qa-tmx-dt" step="1">
  <div class="presets">
    <button data-d="-365">−1y</button><button data-d="-30">−1mo</button><button data-d="-7">−1w</button><button data-d="-1">−1d</button>
    <button data-d="1">+1d</button><button data-d="7">+1w</button><button data-d="30">+1mo</button><button data-d="365">+1y</button>
  </div>
  <div class="seg" id="qa-tmx-seg">
    <button data-m="advance" class="on">Advance<small>clock keeps ticking</small></button>
    <button data-m="freeze">Freeze<small>time stands still</small></button>
  </div>
  <div class="acts">
    <button class="go" id="qa-tmx-apply">Apply</button>
    <button class="reset" id="qa-tmx-reset">Reset</button>
  </div>
  <div class="status" id="qa-tmx-status">
    <div class="now" id="qa-tmx-now">—</div>
    <div class="sub" id="qa-tmx-sub"></div>
    <div class="real" id="qa-tmx-real"></div>
  </div>
  <div class="hint">The page sees this time via <b>Date</b> / <b>Date.now()</b>. Scripts that read the clock only on load? <a id="qa-tmx-reload">Reload the page</a> — the override re-applies automatically.</div>
</div>`;
    document.body.appendChild(panel);

    const $ = (s) => panel.querySelector(s);
    const dt = $('#qa-tmx-dt'), statusEl = $('#qa-tmx-status');
    let mode = 'advance', active = null;   // active = {mode, targetMs, anchorMs}
    dt.value = tmxToInput(Date.now());

    $('#qa-tmx-seg').addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        mode = b.dataset.m;
        for (const x of $('#qa-tmx-seg').children) x.classList.toggle('on', x === b);
    });
    panel.querySelectorAll('.presets button').forEach(b => b.addEventListener('click', () => {
        const base = dt.value ? new Date(dt.value).getTime() : Date.now();
        dt.value = tmxToInput(base + parseInt(b.dataset.d) * 86400000);
    }));

    const stopTick = () => { if (window.__qaTmxTick) { clearInterval(window.__qaTmxTick); window.__qaTmxTick = null; } };
    const paint = () => {
        if (!active) { statusEl.classList.remove('on'); stopTick(); return; }
        statusEl.classList.add('on');
        const compute = () => active.mode === 'freeze' ? active.targetMs : active.targetMs + (Date.now() - active.anchorMs);
        const tick = () => {
            $('#qa-tmx-now').textContent = tmxFmt(compute());
            $('#qa-tmx-sub').textContent = active.mode === 'freeze' ? 'Frozen' : 'Advancing in real time';
            $('#qa-tmx-real').textContent = 'Real time: ' + tmxFmt(Date.now());
        };
        tick(); stopTick(); if (active.mode !== 'freeze') window.__qaTmxTick = setInterval(tick, 1000);
    };

    $('#qa-tmx-apply').addEventListener('click', () => {
        const targetMs = dt.value ? new Date(dt.value).getTime() : Date.now();
        if (isNaN(targetMs)) return;
        chrome.runtime.sendMessage({ action: 'timeMachineApply', mode, targetMs }, (r) => {
            if (r && r.ok && r.cfg) { active = r.cfg; paint(); }
        });
    });
    $('#qa-tmx-reset').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'timeMachineReset' }, () => { active = null; paint(); });
    });
    $('#qa-tmx-reload').addEventListener('click', () => location.reload());
    $('#qa-tmx-close').addEventListener('click', closeTimeMachinePanel);
    qaAddMinimize(panel, panel.querySelector('.hd'), $('#qa-tmx-close'));

    // restore existing state for this tab
    chrome.runtime.sendMessage({ action: 'timeMachineStatus' }, (r) => {
        if (r && r.cfg) { active = r.cfg; mode = active.mode; dt.value = tmxToInput(active.mode === 'freeze' ? active.targetMs : active.targetMs + (Date.now() - active.anchorMs)); for (const x of $('#qa-tmx-seg').children) x.classList.toggle('on', x.dataset.m === mode); paint(); }
    });

    // drag by header
    let off = null; const head = panel.querySelector('.hd');
    head.addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; const rc = panel.getBoundingClientRect(); off = { dx: e.clientX - rc.left, dy: e.clientY - rc.top }; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (!off) return; panel.style.right = 'auto'; panel.style.left = Math.max(4, Math.min(innerWidth - 80, e.clientX - off.dx)) + 'px'; panel.style.top = Math.max(4, Math.min(innerHeight - 50, e.clientY - off.dy)) + 'px'; });
    document.addEventListener('mouseup', () => { off = null; });
}

} // end idempotency guard (window.__qaToolboxContentLoaded)
