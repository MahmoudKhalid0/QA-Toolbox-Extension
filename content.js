// Content script for recording form fills
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
        (async () => { sendResponse(await scanPageFormFields(request.captureCombo !== false)); })();
        return true;
    }
    if (request.action === 'showAiSavePrompt') {
        showAiSavePromptModal(request.profile);
    }
    if (request.action === 'startInspectMode') {
        startInspectMode();
        sendResponse({ success: true });
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
    if (request.action === 'runSecurityScan') {
        runSecurityScan();
        sendResponse({ success: true });
    }
    if (request.action === 'runPerformance') {
        runPerformance();
        sendResponse({ success: true });
    }
    if (request.action === 'openResponsive') {
        openResponsiveOverlay();
        sendResponse({ success: true });
    }
    if (request.action === 'openStorage') {
        openStoragePanel();
        sendResponse({ success: true });
    }
    if (request.action === 'arStart') { arArm(request.seconds); sendResponse({ success: true }); }
    if (request.action === 'arStop') { arArm(0); sendResponse({ success: true }); }
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
                createFloatingButton();
            });
        });
    }, 100);
}

function cleanupFloatingButton() {
    const btn = document.getElementById('ff-floating-btn');
    if (btn) btn.remove();
    const menu = document.getElementById('ff-floating-menu');
    if (menu) menu.remove();
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
async function captureComboboxOptions(el) {
    try {
        el.focus();
        el.click();
        await new Promise(r => setTimeout(r, 220));
        const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        let listbox = listId ? document.getElementById(listId) : null;
        if (!listbox || !isElementVisible(listbox)) {
            listbox = Array.from(document.querySelectorAll('[role="listbox"]')).find(lb => isElementVisible(lb)) || null;
        }
        let opts = [];
        if (listbox) {
            let nodes = Array.from(listbox.querySelectorAll('[role="option"]'));
            if (nodes.length === 0) nodes = Array.from(listbox.querySelectorAll('li'));
            opts = nodes.map(o => (o.innerText || '').trim()).filter(Boolean).slice(0, 30);
        }
        // Close the dropdown again so it doesn't interfere with the rest of the scan
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        el.blur();
        await new Promise(r => setTimeout(r, 40));
        return opts;
    } catch (e) {
        return [];
    }
}

async function scanPageFormFields(captureCombo = true) {
    const skipTypes = ['hidden', 'submit', 'button', 'reset', 'image', 'file'];
    const fields = [];
    const seenSelectors = new Set();
    const seenRadioGroups = new Set();
    const MAX_FIELDS = 60;

    const getLabel = (el) => {
        try {
            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label && label.innerText.trim()) return label.innerText.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel && parentLabel.innerText.trim()) return parentLabel.innerText.trim();
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        } catch (e) { }
        return '';
    };

    const elements = document.querySelectorAll('input, select, textarea');
    for (const el of elements) {
        if (fields.length >= MAX_FIELDS) break;

        const tagName = el.tagName.toLowerCase();
        let type = (el.type || tagName).toLowerCase();
        const isCombobox = tagName === 'input' && el.getAttribute('role') === 'combobox';
        if (isCombobox) type = 'combobox';
        if (tagName === 'input' && skipTypes.includes(type)) continue;
        if (el.disabled) continue;
        // Custom dropdowns are often readonly inputs - keep those
        if (el.readOnly && !isCombobox) continue;
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
            name: el.name || '',
            label: label.substring(0, 120),
            placeholder: el.placeholder || '',
            required: !!el.required,
            maxLength: el.maxLength > 0 ? el.maxLength : null
        };

        if (tagName === 'select') {
            field.options = Array.from(el.options)
                .filter(o => o.value && o.value.trim() !== '')
                .slice(0, 30)
                .map(o => ({ value: o.value, text: o.text.trim().substring(0, 60) }));
        }

        if (type === 'checkbox') {
            field.checked = el.checked;
        }

        // Custom dropdowns: read the options so the AI can pick a real one (and
        // write dependent text fields to match it). Try the linked listbox first;
        // if it isn't in the DOM yet, briefly open the dropdown to capture them.
        if (isCombobox) {
            const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            const listbox = listId ? document.getElementById(listId) : null;
            if (listbox) {
                const opts = Array.from(listbox.querySelectorAll('[role="option"], li'))
                    .map(o => (o.innerText || '').trim())
                    .filter(Boolean)
                    .slice(0, 30);
                if (opts.length > 0) {
                    field.options = opts.map(t => ({ value: t.substring(0, 60), text: t.substring(0, 60) }));
                }
            }
            if (captureCombo && (!field.options || field.options.length === 0)) {
                const opts = await captureComboboxOptions(el);
                if (opts.length > 0) {
                    field.options = opts.map(t => ({ value: t.substring(0, 60), text: t.substring(0, 60) }));
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
    stopInspectMode();
    closeInspectorPanel();

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
    cancel.innerHTML = '<span><i class="fas fa-crosshairs" style="color:#8b5cf6;margin-left:4px;"></i> Pick an element</span>' +
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

function closeInspectorPanel() {
    if (inspectorDragCleanup) {
        inspectorDragCleanup();
        inspectorDragCleanup = null;
    }
    const p = document.getElementById('ff-insp-panel');
    if (p) p.remove();
    inspectedElement = null;
    inspectedOriginalStyle = null;
}

function showInspectorPanel(el) {
    closeInspectorPanel();
    inspectedElement = el;
    inspectedOriginalStyle = el.getAttribute('style');

    let selector = '';
    try { selector = generateSelector(el); } catch (e) { }

    const attrs = Array.from(el.attributes || []).map(a => ({ name: a.name, value: a.value }));
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const tagLabel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');

    // Always replace the injected styles - a stale <style> from a previous
    // extension version can linger in the page DOM and hide style updates
    {
        const oldStyles = document.getElementById('ff-insp-styles');
        if (oldStyles) oldStyles.remove();
        const style = document.createElement('style');
        style.id = 'ff-insp-styles';
        style.textContent = `
            #ff-insp-panel {
                --ff-mono: 'Segoe UI', Tahoma, Arial, sans-serif;
                position: fixed; top: 16px; right: 16px; width: 360px; max-height: 88vh;
                z-index: 2147483647; display: flex; flex-direction: column;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 2px solid rgba(14, 165, 233, 0.45); border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.7);
                font-family: 'Segoe UI', Arial, sans-serif; color: #fff; direction: ltr;
            }
            #ff-insp-panel * { box-sizing: border-box; }
            .ff-insp-head {
                display: flex; align-items: center; justify-content: space-between;
                padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1);
                cursor: move; user-select: none;
            }
            .ff-insp-tag { font: 600 13px/1.4 var(--ff-mono); color: #ffffff; word-break: break-all; }
            .ff-insp-head-btns { display: flex; gap: 6px; flex-shrink: 0; margin-left: 8px; }
            .ff-insp-head-btns button {
                background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer;
                width: 26px; height: 26px; border-radius: 6px; font-size: 13px;
            }
            .ff-insp-head-btns button:hover { background: rgba(255,255,255,0.22); }
            .ff-insp-body { overflow-y: auto; padding: 10px 14px 14px; }
            .ff-insp-section { margin-bottom: 14px; }
            .ff-insp-sec-title {
                display: flex; align-items: center; justify-content: space-between;
                font-size: 11px; font-weight: 700; text-transform: uppercase;
                color: rgba(255,255,255,0.55); margin-bottom: 6px; letter-spacing: 0.5px;
            }
            .ff-insp-sec-title button {
                background: rgba(14,165,233,0.18); border: 1px solid rgba(14,165,233,0.4);
                color: #38bdf8; cursor: pointer; font-size: 10px; padding: 2px 8px; border-radius: 5px;
            }
            .ff-insp-sec-title button:hover { background: rgba(14,165,233,0.32); }
            .ff-insp-selector {
                background: rgba(0,0,0,0.35); border-radius: 7px; padding: 8px 10px;
                font: 12px/1.6 var(--ff-mono); color: #c7d2fe; word-break: break-all;
            }
            .ff-insp-list {
                background: rgba(0,0,0,0.35); border-radius: 7px; padding: 6px 10px;
                max-height: 160px; overflow-y: auto; font: 12px/1.9 var(--ff-mono);
            }
            .ff-insp-list .ff-insp-row { word-break: break-all; }
            .ff-insp-list .ff-insp-k { color: #a5b4fc; font-weight: 600; }
            .ff-insp-list .ff-insp-v { color: #ffffff; }
            .ff-insp-rule { margin-bottom: 8px; }
            .ff-insp-rule .ff-insp-sel { color: #fbbf24; font-weight: 600; word-break: break-all; cursor: pointer; }
            .ff-insp-rule .ff-insp-sel:hover { background: rgba(255,255,255,0.07); border-radius: 3px; }
            .ff-insp-swatch {
                -webkit-appearance: none; appearance: none;
                display: inline-block; width: 12px; height: 12px; border-radius: 2px;
                border: 1px solid rgba(255,255,255,0.5); margin: 0 4px 0 0; padding: 0;
                vertical-align: middle; cursor: pointer; background: none;
            }
            .ff-insp-swatch::-webkit-color-swatch-wrapper { padding: 0; }
            .ff-insp-swatch::-webkit-color-swatch { border: none; border-radius: 1px; }
            .ff-insp-swatch:hover { transform: scale(1.35); border-color: #fff; }
            .ff-insp-off .ff-insp-swatch { pointer-events: none; opacity: 0.4; }
            .ff-insp-decl { padding-left: 6px; }
            .ff-insp-dchk {
                width: 11px; height: 11px; margin: 0 5px 0 0; accent-color: #6366f1;
                cursor: pointer; vertical-align: middle;
            }
            .ff-insp-off .ff-insp-k, .ff-insp-off .ff-insp-v { text-decoration: line-through; opacity: 0.45; }
            .ff-insp-decl .ff-insp-k, .ff-insp-decl .ff-insp-v { cursor: text; }
            .ff-insp-decl .ff-insp-k:hover, .ff-insp-decl .ff-insp-v:hover { text-decoration: underline; }
            .ff-insp-edit {
                background: rgba(0,0,0,0.5); border: 1px solid #6366f1; color: #fff;
                font: inherit; border-radius: 4px; padding: 0 4px; outline: none; max-width: 220px;
            }
            .ff-insp-edit::-webkit-calendar-picker-indicator { display: none !important; }
            .ff-insp-empty { color: rgba(255,255,255,0.35); font-style: italic; }
            #ff-insp-style-filter, #ff-insp-css {
                width: 100%; background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.12); border-radius: 7px;
                color: #ffffff; font: 12px/1.6 var(--ff-mono); padding: 7px 10px; outline: none;
            }
            #ff-insp-style-filter { margin-bottom: 6px; }
            #ff-insp-style-filter:focus, #ff-insp-css:focus { border-color: #0ea5e9; }
            #ff-insp-css { min-height: 64px; resize: vertical; }
            .ff-insp-actions { display: flex; gap: 8px; margin-top: 8px; }
            .ff-insp-actions button {
                flex: 1; border: none; border-radius: 8px; padding: 8px 10px;
                font-size: 12px; font-weight: 600; cursor: pointer;
            }
            #ff-insp-apply { background: linear-gradient(135deg, #0ea5e9, #6366f1); color: #fff; }
            #ff-insp-apply:hover { filter: brightness(1.15); }
            #ff-insp-reset { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
            #ff-insp-reset:hover { background: rgba(255,255,255,0.2); color: #fff; }
            .ff-insp-feedback { font-size: 11px; color: #4ade80; margin-top: 6px; min-height: 14px; }
            .ff-insp-css-wrap { position: relative; }
            #ff-insp-suggest {
                position: absolute; left: 0; right: 0; top: 100%; margin-top: 2px;
                z-index: 10; display: none; background: #1e293b;
                border: 1px solid rgba(99,102,241,0.5); border-radius: 7px;
                max-height: 150px; overflow-y: auto; font: 12px/2 var(--ff-mono);
                box-shadow: 0 6px 18px rgba(0,0,0,0.5);
            }
            .ff-insp-sg { padding: 3px 10px; cursor: pointer; color: #ffffff; }
            .ff-insp-sg.active, .ff-insp-sg:hover { background: rgba(99,102,241,0.3); color: #fff; }
        `;
        document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = 'ff-insp-panel';
    panel.innerHTML = `
        <div class="ff-insp-head">
            <span class="ff-insp-tag">${escapeHtml(tagLabel)}</span>
            <div class="ff-insp-head-btns">
                <button id="ff-insp-repick" title="Pick another element">&#8982;</button>
                <button id="ff-insp-close" title="Close">&#10005;</button>
            </div>
        </div>
        <div class="ff-insp-body">
            <div class="ff-insp-section">
                <div class="ff-insp-sec-title"><span>Selector</span><button id="ff-insp-copy-selector">Copy</button></div>
                <div class="ff-insp-selector">${escapeHtml(selector || '(none)')}</div>
            </div>
            <div class="ff-insp-section">
                <div class="ff-insp-sec-title"><span>Attributes (${attrs.length})</span><button id="ff-insp-copy-attrs">Copy</button></div>
                <div class="ff-insp-list">${attrs.length === 0 ? '<div class="ff-insp-empty">No attributes</div>' : attrs.map(a =>
                    `<div class="ff-insp-row"><span class="ff-insp-k">${escapeHtml(a.name)}</span>="<span class="ff-insp-v">${escapeHtml(a.value)}</span>"</div>`
                ).join('')}</div>
            </div>
            <div class="ff-insp-section">
                <div class="ff-insp-sec-title"><span>CSS Rules</span><button id="ff-insp-copy-styles">Copy</button></div>
                <input id="ff-insp-style-filter" type="text" placeholder="Filter properties... (e.g. font, margin)">
                <div class="ff-insp-list" id="ff-insp-style-list"></div>
            </div>
            <div class="ff-insp-section">
                <div class="ff-insp-sec-title"><span>Apply Custom Style</span></div>
                <div class="ff-insp-css-wrap">
                    <textarea id="ff-insp-css" placeholder="background: red;  —or—  .new { color: red; }" dir="ltr" spellcheck="false"></textarea>
                    <div id="ff-insp-suggest"></div>
                </div>
                <div class="ff-insp-actions">
                    <button id="ff-insp-apply">Apply</button>
                    <button id="ff-insp-reset">Reset</button>
                </div>
                <div class="ff-insp-feedback" id="ff-insp-feedback"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // ---- Drag the panel around by its header ----
    let dragOffset = null;
    const headEl = panel.querySelector('.ff-insp-head');
    const onDragStart = (e) => {
        if (e.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
    };
    const onDragMove = (e) => {
        if (!dragOffset) return;
        panel.style.right = 'auto';
        panel.style.left = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - dragOffset.dx)) + 'px';
        panel.style.top = Math.max(4, Math.min(window.innerHeight - 50, e.clientY - dragOffset.dy)) + 'px';
    };
    const onDragEnd = () => { dragOffset = null; };
    headEl.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    inspectorDragCleanup = () => {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
    };

    // ---- CSS property autocomplete for the custom-style box ----
    // Full property list from the browser itself + common shorthands
    const cssProps = (() => {
        const set = new Set(['margin', 'padding', 'border', 'background', 'font', 'flex', 'gap', 'inset', 'outline', 'overflow', 'transition', 'animation', 'grid', 'border-radius', 'box-shadow', 'text-decoration']);
        try {
            const cs = getComputedStyle(document.documentElement);
            for (let i = 0; i < cs.length; i++) set.add(cs.item(i));
        } catch (e) { }
        return Array.from(set).filter(p => !p.startsWith('-')).sort();
    })();

    const cssBox = panel.querySelector('#ff-insp-css');
    const suggestBox = panel.querySelector('#ff-insp-suggest');
    let suggestItems = [];
    let suggestIndex = 0;

    const hideSuggest = () => {
        suggestBox.style.display = 'none';
        suggestItems = [];
    };

    const acceptSuggestion = (prop) => {
        const pos = cssBox.selectionStart;
        const before = cssBox.value.slice(0, pos);
        const after = cssBox.value.slice(pos);
        const segStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1;
        const leading = before.slice(segStart).match(/^\s*/)[0];
        const newBefore = before.slice(0, segStart) + leading + prop + ': ';
        cssBox.value = newBefore + after;
        cssBox.setSelectionRange(newBefore.length, newBefore.length);
        cssBox.focus();
        hideSuggest();
    };

    const highlightSuggest = () => {
        suggestBox.querySelectorAll('.ff-insp-sg').forEach((n, i) => {
            n.classList.toggle('active', i === suggestIndex);
        });
    };

    const updateSuggest = () => {
        const pos = cssBox.selectionStart;
        const before = cssBox.value.slice(0, pos);
        const segStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1;
        const seg = before.slice(segStart);
        // Already typing a value (past the colon) - no property suggestions
        if (seg.includes(':')) { hideSuggest(); return; }
        const token = seg.trim().toLowerCase();
        if (!token) { hideSuggest(); return; }

        suggestItems = cssProps.filter(p => p.startsWith(token) && p !== token).slice(0, 8);
        if (suggestItems.length === 0) { hideSuggest(); return; }

        suggestIndex = 0;
        suggestBox.innerHTML = suggestItems.map((p, i) =>
            `<div class="ff-insp-sg${i === 0 ? ' active' : ''}" data-prop="${p}">${p}</div>`
        ).join('');
        suggestBox.style.display = 'block';
        suggestBox.querySelectorAll('.ff-insp-sg').forEach(n => {
            n.addEventListener('mousedown', (e) => {
                e.preventDefault();
                acceptSuggestion(n.dataset.prop);
            });
        });
    };

    cssBox.addEventListener('input', updateSuggest);
    cssBox.addEventListener('blur', () => setTimeout(hideSuggest, 150));
    cssBox.addEventListener('keydown', (e) => {
        if (suggestItems.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            suggestIndex = (suggestIndex + 1) % suggestItems.length;
            highlightSuggest();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
            highlightSuggest();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            acceptSuggestion(suggestItems[suggestIndex]);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            hideSuggest();
        }
    });

    // Live-editing state for the CSS Rules list (DevTools-style):
    // edits/toggles mutate the page's real CSSStyleDeclaration objects.
    const disabledDecls = new Map(); // CSSStyleDeclaration -> [{prop, value, priority}]
    const touchedRules = new Map();  // CSSStyleDeclaration -> original cssText (for Reset)
    let currentBlocks = [];          // blocks currently rendered, indexes match data-b

    // Collect the actual CSS rules that match the element, grouped per selector
    // (like the DevTools Styles pane): [{ selector, style, decls: [{prop, value, disabled}] }]
    const getMatchedCssBlocks = () => {
        const el = inspectedElement;
        if (!el) return [];
        const blocks = [];
        const addBlock = (selector, style) => {
            const decls = [];
            for (const d of style.cssText.split(';')) {
                const i = d.indexOf(':');
                if (i > 0) decls.push({ prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim(), disabled: false });
            }
            // Re-insert disabled declarations at the position they were disabled from
            const offs = (disabledDecls.get(style) || []).slice().sort((a, b) => a.idx - b.idx);
            for (const d of offs) {
                decls.splice(Math.min(d.idx ?? decls.length, decls.length), 0,
                    { prop: d.prop, value: d.value + (d.priority ? ' !important' : ''), disabled: true });
            }
            if (decls.length) blocks.push({ selector, style, decls });
        };
        const collect = (rules) => {
            for (const rule of rules) {
                try {
                    if (rule.selectorText && rule.style) {
                        if (el.matches(rule.selectorText)) addBlock(rule.selectorText, rule.style);
                    } else if (rule.cssRules && (!rule.media || matchMedia(rule.media.mediaText).matches)) {
                        collect(rule.cssRules); // @media / @supports blocks
                    }
                } catch (e) { }
            }
        };
        for (const sheet of document.styleSheets) {
            try { collect(sheet.cssRules); } catch (e) { } // cross-origin sheets are unreadable
        }
        // Later rules win the cascade - show them first, with inline style on top
        blocks.reverse();
        if (el.getAttribute('style') || disabledDecls.has(el.style)) {
            addBlock('element.style', el.style);
            if (blocks.length && blocks[blocks.length - 1].selector === 'element.style') {
                blocks.unshift(blocks.pop());
            }
        }
        return blocks;
    };

    // Prepend a small color swatch to color values (rgb/rgba/hsl/hex), DevTools-style.
    // var(--x) references are resolved against the inspected element to find the
    // actual color. Works on already-escaped HTML - color tokens contain no
    // HTML-sensitive chars.
    const colorizeValue = (escapedValue) =>
        escapedValue.replace(/(var\(--[^)]*\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g, (m) => {
            let color = m;
            if (m.startsWith('var(')) {
                const name = m.match(/--[\w-]+/);
                color = '';
                if (name && inspectedElement) {
                    try { color = getComputedStyle(inspectedElement).getPropertyValue(name[0]).trim(); } catch (e) { }
                }
                // Custom props can hold anything (sizes, fonts) - only swatch real colors
                if (!color || !CSS.supports('color', color)) return m;
            }
            // A real color input: clicking it opens the native picker directly
            // (a trusted click - programmatic .click() on a hidden input is not)
            return `<input type="color" class="ff-insp-swatch" data-color="${m}" title="Click to pick a color" value="${toHexColor(color)}">${m}`;
        });

    const filterBlocks = (filter) => {
        let blocks = getMatchedCssBlocks();
        if (filter && filter.trim()) {
            const f = filter.trim().toLowerCase();
            blocks = blocks
                .map(b => ({ ...b, decls: b.decls.filter(d => (d.prop + ': ' + d.value).toLowerCase().includes(f)) }))
                .filter(b => b.decls.length > 0);
        }
        return blocks;
    };

    const renderStyleList = (filter) => {
        const listEl = panel.querySelector('#ff-insp-style-list');
        if (!inspectedElement) return;
        const blocks = filterBlocks(filter);

        if (blocks.length === 0) {
            // Fallback: flat computed values (no readable rules, or nothing matched the filter)
            currentBlocks = [];
            const cs = getComputedStyle(inspectedElement);
            let props;
            if (filter && filter.trim()) {
                const f = filter.trim().toLowerCase();
                props = [];
                for (let i = 0; i < cs.length; i++) {
                    if (cs.item(i).includes(f)) props.push(cs.item(i));
                }
            } else {
                props = INSPECTOR_COMMON_PROPS;
            }
            listEl.innerHTML = props.length === 0
                ? '<div class="ff-insp-empty">No matching properties</div>'
                : props.map(p =>
                    `<div class="ff-insp-row"><span class="ff-insp-k">${escapeHtml(p)}</span>: <span class="ff-insp-v">${colorizeValue(escapeHtml(cs.getPropertyValue(p)))}</span>;</div>`
                ).join('');
            return;
        }

        currentBlocks = blocks;
        listEl.innerHTML = blocks.map((b, bi) => {
            const rows = b.decls.map(d =>
                `<div class="ff-insp-row ff-insp-decl${d.disabled ? ' ff-insp-off' : ''}" data-b="${bi}" data-prop="${escapeHtml(d.prop)}">` +
                `<input type="checkbox" class="ff-insp-dchk"${d.disabled ? '' : ' checked'} title="${d.disabled ? 'Enable' : 'Disable'} this property">` +
                `<span class="ff-insp-k">${escapeHtml(d.prop)}</span>: <span class="ff-insp-v">${colorizeValue(escapeHtml(d.value))}</span>;</div>`
            ).join('');
            return `<div class="ff-insp-rule" data-b="${bi}"><div class="ff-insp-sel" title="Click to add a property">${escapeHtml(b.selector)} {</div>${rows}<div class="ff-insp-sel" title="Click to add a property">}</div></div>`;
        }).join('');
    };

    // ---- Live editing of the CSS Rules list (toggle + inline edit) ----
    const styleListEl = panel.querySelector('#ff-insp-style-list');
    const currentFilter = () => panel.querySelector('#ff-insp-style-filter').value;

    // Native autocomplete for property names while editing
    const propDatalist = document.createElement('datalist');
    propDatalist.id = 'ff-insp-props';
    propDatalist.innerHTML = cssProps.map(p => `<option value="${p}"></option>`).join('');
    panel.appendChild(propDatalist);

    // Value autocomplete: refilled per property via CSS.supports
    const valDatalist = document.createElement('datalist');
    valDatalist.id = 'ff-insp-vals';
    panel.appendChild(valDatalist);
    const fillValueSuggestions = (prop) => {
        let vals = [];
        try { vals = INSPECTOR_VALUE_KEYWORDS.filter(k => CSS.supports(prop, k)); } catch (e) { }
        valDatalist.innerHTML = vals.map(v => `<option value="${v}"></option>`).join('');
    };

    // Snapshot a rule before its first mutation so Reset can restore it
    const snapshotRule = (style) => {
        if (!touchedRules.has(style)) touchedRules.set(style, style.cssText);
    };

    // Checkbox: enable/disable a declaration (mutates the real rule, like DevTools)
    styleListEl.addEventListener('change', (e) => {
        if (!e.target.classList.contains('ff-insp-dchk')) return;
        const row = e.target.closest('.ff-insp-decl');
        const b = currentBlocks[+row.dataset.b];
        if (!b) return;
        const prop = row.dataset.prop;
        snapshotRule(b.style);
        const list = disabledDecls.get(b.style) || [];
        if (e.target.checked) {
            const d = list.find(x => x.prop === prop);
            if (d) {
                disabledDecls.set(b.style, list.filter(x => x !== d));
                // Rebuild the declaration block with the property back at its
                // original position - setProperty would append it at the end
                try {
                    const parts = b.style.cssText.split(';').map(s => s.trim()).filter(Boolean);
                    parts.splice(Math.min(d.idx ?? parts.length, parts.length), 0,
                        `${d.prop}: ${d.value}${d.priority ? ' !important' : ''}`);
                    b.style.cssText = parts.join('; ');
                } catch (err) { }
            }
        } else {
            list.push({
                prop,
                value: b.style.getPropertyValue(prop),
                priority: b.style.getPropertyPriority(prop),
                idx: b.decls.findIndex(x => x.prop === prop)
            });
            disabledDecls.set(b.style, list);
            try { b.style.removeProperty(prop); } catch (err) { }
        }
        renderStyleList(currentFilter());
    });

    // Convert any CSS color to #rrggbb for the native color picker
    const toHexColor = (color) => {
        try {
            const ctx = document.createElement('canvas').getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillStyle = color;
            const v = ctx.fillStyle;
            if (v.startsWith('#')) return v;
            const nums = v.match(/\d+(\.\d+)?/g);
            if (nums) return '#' + nums.slice(0, 3).map(n => Math.round(+n).toString(16).padStart(2, '0')).join('');
        } catch (e) { }
        return '#000000';
    };

    // The swatch IS a color input - picking a color updates the declaration
    // live. The replacement runs on the same displayed value string the token
    // was extracted from (getPropertyValue can serialize differently, or be
    // empty for shorthands holding var(), silently breaking the replacement).
    styleListEl.addEventListener('input', (e) => {
        const sw = e.target;
        if (!sw.classList.contains('ff-insp-swatch')) return;
        const row = sw.closest('.ff-insp-decl');
        const b = row && currentBlocks[+row.dataset.b];
        if (!b) return;
        const prop = row.dataset.prop;
        if (sw.dataset.curval === undefined) {
            const decl = b.decls.find(x => x.prop === prop && !x.disabled);
            sw.dataset.curval = decl ? decl.value : (b.style.getPropertyValue(prop) || sw.dataset.color);
        }
        snapshotRule(b.style);
        const raw = sw.dataset.curval.replace(sw.dataset.color, sw.value);
        sw.dataset.curval = raw;
        sw.dataset.color = sw.value;
        const imp = /!important/i.test(raw);
        try { b.style.setProperty(prop, raw.replace(/\s*!important\s*/i, ' ').trim(), imp ? 'important' : ''); } catch (err) { }
    });

    // Picker closed - re-render so the value text shows the final color
    styleListEl.addEventListener('change', (e) => {
        if (e.target.classList.contains('ff-insp-swatch')) renderStyleList(currentFilter());
    });

    // Edit a property name or value in place. Value edits preview live while
    // typing; Arrow Up/Down steps numbers (+Shift=10, +Alt=0.1); Tab on a
    // property jumps to its value; Esc undoes.
    const beginInlineEdit = (row, span, isProp) => {
        const b = currentBlocks[+row.dataset.b];
        if (!b) return;
        const prop = row.dataset.prop;
        const priority = b.style.getPropertyPriority(prop);
        const origValue = b.style.getPropertyValue(prop);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ff-insp-edit';
        if (isProp) {
            input.value = prop;
            input.setAttribute('list', 'ff-insp-props');
        } else {
            input.value = origValue + (priority ? ' !important' : '');
            input.setAttribute('list', 'ff-insp-vals');
            fillValueSuggestions(prop);
        }
        const fit = () => { input.style.width = Math.min(34, Math.max(6, input.value.length + 2)) + 'ch'; };
        fit();
        span.replaceWith(input);
        input.focus();
        input.select();

        const applyValue = (raw) => {
            const imp = /!important$/i.test(raw);
            const clean = raw.replace(/!important$/i, '').trim();
            if (!clean) return;
            try { b.style.setProperty(prop, clean, imp ? 'important' : ''); } catch (e) { }
        };

        let done = false;
        const finish = (commit, thenEditValue) => {
            if (done) return;
            done = true;
            const v = input.value.trim();
            snapshotRule(b.style);
            try {
                if (isProp) {
                    if (commit && v && v !== prop) {
                        b.style.removeProperty(prop);
                        b.style.setProperty(v, origValue, priority);
                    }
                } else if (commit) {
                    if (!v) b.style.removeProperty(prop);
                    else applyValue(v);
                } else {
                    // Cancelled - undo the live preview
                    b.style.setProperty(prop, origValue, priority);
                }
            } catch (err) { }
            renderStyleList(currentFilter());
            if (thenEditValue) {
                const newProp = (isProp && commit && v) ? v : prop;
                const nrow = styleListEl.querySelector(`.ff-insp-decl[data-b="${row.dataset.b}"][data-prop="${newProp}"]`);
                const nspan = nrow && nrow.querySelector('.ff-insp-v');
                if (nspan) beginInlineEdit(nrow, nspan, false);
            }
        };

        input.addEventListener('input', (ev) => {
            fit();
            if (isProp) {
                // Picked a property from the autocomplete list - commit it and
                // jump straight to editing its value
                if (ev.inputType === 'insertReplacementText') finish(true, true);
                return;
            }
            snapshotRule(b.style);
            applyValue(input.value.trim());
            // Picked a value from the list - commit right away
            if (ev.inputType === 'insertReplacementText') finish(true);
        });
        input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, isProp); }
            else if (ev.key === 'Escape') finish(false);
            else if (!isProp && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
                ev.preventDefault();
                const delta = (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
                input.value = input.value.replace(/-?\d*\.?\d+/, (n) => String(+(parseFloat(n) + delta).toFixed(3)));
                fit();
                snapshotRule(b.style);
                applyValue(input.value.trim());
            }
        });
        input.addEventListener('blur', () => finish(true));
    };

    // Click a rule's selector line (or closing brace) to add a new declaration
    const startAddDecl = (b, ruleDiv) => {
        const existing = ruleDiv.querySelector('.ff-insp-new input');
        if (existing) { existing.focus(); return; }
        const row = document.createElement('div');
        row.className = 'ff-insp-row ff-insp-decl ff-insp-new';
        const propIn = document.createElement('input');
        propIn.className = 'ff-insp-edit';
        propIn.placeholder = 'property';
        propIn.setAttribute('list', 'ff-insp-props');
        row.appendChild(propIn);
        ruleDiv.insertBefore(row, ruleDiv.lastElementChild);
        propIn.focus();

        let stage = 'prop';
        const commit = (prop, val) => {
            stage = 'done';
            if (prop && val) {
                snapshotRule(b.style);
                const imp = /!important$/i.test(val);
                try { b.style.setProperty(prop, val.replace(/!important$/i, '').trim(), imp ? 'important' : ''); } catch (e) { }
            }
            renderStyleList(currentFilter());
        };
        const toValueStage = () => {
            if (stage !== 'prop') return;
            const typed = propIn.value.trim();
            if (!typed) { stage = 'done'; row.remove(); return; }
            // "prop: value" typed in one go also works
            const ci = typed.indexOf(':');
            if (ci > 0) { commit(typed.slice(0, ci).trim(), typed.slice(ci + 1).replace(/;$/, '').trim()); return; }
            stage = 'value';
            const sep = document.createElement('span');
            sep.textContent = ': ';
            row.appendChild(sep);
            const valIn = document.createElement('input');
            valIn.className = 'ff-insp-edit';
            valIn.placeholder = 'value';
            valIn.setAttribute('list', 'ff-insp-vals');
            fillValueSuggestions(typed);
            row.appendChild(valIn);
            valIn.focus();
            valIn.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); commit(typed, valIn.value.replace(/;$/, '').trim()); }
                else if (ev.key === 'Escape') { stage = 'done'; renderStyleList(currentFilter()); }
            });
            // Picking a value from the autocomplete list commits right away
            valIn.addEventListener('input', (ev) => {
                if (ev.inputType === 'insertReplacementText') commit(typed, valIn.value.replace(/;$/, '').trim());
            });
            valIn.addEventListener('blur', () => { if (stage === 'value') commit(typed, valIn.value.replace(/;$/, '').trim()); });
        };
        propIn.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); toValueStage(); }
            else if (ev.key === 'Escape') { stage = 'done'; row.remove(); }
        });
        // Picking a property from the autocomplete list moves on to the value
        propIn.addEventListener('input', (ev) => {
            if (ev.inputType === 'insertReplacementText') toValueStage();
        });
        propIn.addEventListener('blur', () => setTimeout(toValueStage, 120));
    };

    styleListEl.addEventListener('click', (e) => {
        // Inputs handle themselves (checkboxes, color swatches, edit fields)
        if (e.target.tagName === 'INPUT') return;
        const row = e.target.closest('.ff-insp-decl');

        // Selector line -> add a new declaration to the rule
        const selLine = e.target.closest('.ff-insp-sel');
        if (selLine) {
            const ruleDiv = selLine.closest('.ff-insp-rule');
            const b = ruleDiv && currentBlocks[+ruleDiv.dataset.b];
            if (b) startAddDecl(b, ruleDiv);
            return;
        }

        // Property name / value -> edit in place
        const span = e.target.closest('.ff-insp-k, .ff-insp-v');
        if (!span || !row || row.classList.contains('ff-insp-off') || row.classList.contains('ff-insp-new')) return;
        beginInlineEdit(row, span, span.classList.contains('ff-insp-k'));
    });

    const copyText = (text, btn) => {
        ffCopyText(text).then(() => {
            const old = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = old; }, 1200);
        }).catch(() => { });
    };

    const stylesAsText = () => {
        const filter = panel.querySelector('#ff-insp-style-filter').value;
        const blocks = filterBlocks(filter);
        if (blocks.length > 0) {
            return blocks.map(b =>
                `${b.selector} {\n${b.decls.filter(d => !d.disabled).map(d => `    ${d.prop}: ${d.value};`).join('\n')}\n}`
            ).join('\n\n');
        }
        // Fallback: flat computed values
        const cs = getComputedStyle(inspectedElement);
        let props;
        if (filter && filter.trim()) {
            const f = filter.trim().toLowerCase();
            props = [];
            for (let i = 0; i < cs.length; i++) {
                if (cs.item(i).includes(f)) props.push(cs.item(i));
            }
        } else {
            props = INSPECTOR_COMMON_PROPS;
        }
        return props.map(p => `${p}: ${cs.getPropertyValue(p)};`).join('\n');
    };

    panel.querySelector('#ff-insp-close').addEventListener('click', closeInspectorPanel);
    panel.querySelector('#ff-insp-repick').addEventListener('click', () => {
        closeInspectorPanel();
        startInspectMode();
    });
    panel.querySelector('#ff-insp-copy-selector').addEventListener('click', (e) => copyText(selector, e.target));
    panel.querySelector('#ff-insp-copy-attrs').addEventListener('click', (e) =>
        copyText(attrs.map(a => `${a.name}="${a.value}"`).join('\n'), e.target));
    panel.querySelector('#ff-insp-copy-styles').addEventListener('click', (e) => copyText(stylesAsText(), e.target));

    let filterTimer = null;
    panel.querySelector('#ff-insp-style-filter').addEventListener('input', (e) => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => renderStyleList(e.target.value), 200);
    });

    panel.querySelector('#ff-insp-apply').addEventListener('click', () => {
        if (!inspectedElement) return;
        const cssText = panel.querySelector('#ff-insp-css').value.trim();
        const feedback = panel.querySelector('#ff-insp-feedback');
        if (!cssText) return;

        // Full CSS rules with selectors (.new { color: red; }) - inject as a live
        // stylesheet so they apply to every matching element on the page
        if (cssText.includes('{')) {
            let styleEl = document.getElementById('ff-insp-custom-css');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'ff-insp-custom-css';
                document.head.appendChild(styleEl);
            }
            styleEl.textContent = cssText;
            const ruleCount = styleEl.sheet ? styleEl.sheet.cssRules.length : 0;
            feedback.textContent = ruleCount > 0 ? `Applied ${ruleCount} CSS rule${ruleCount === 1 ? '' : 's'} to the page` : 'Invalid CSS - check the syntax';
            feedback.style.color = ruleCount > 0 ? '#4ade80' : '#f87171';
            renderStyleList(panel.querySelector('#ff-insp-style-filter').value);
            return;
        }

        // Plain declarations - applied inline to the picked element
        let applied = 0;
        cssText.split(';').forEach(decl => {
            const idx = decl.indexOf(':');
            if (idx <= 0) return;
            const prop = decl.slice(0, idx).trim();
            const value = decl.slice(idx + 1).trim();
            if (!prop || !value) return;
            try {
                // !important so the style wins over the page's own rules, like DevTools
                inspectedElement.style.setProperty(prop, value.replace(/!important$/i, '').trim(), 'important');
                applied++;
            } catch (err) { }
        });

        feedback.textContent = applied > 0 ? `Applied ${applied} propert${applied === 1 ? 'y' : 'ies'}` : 'Nothing applied - use "prop: value;" format';
        feedback.style.color = applied > 0 ? '#4ade80' : '#f87171';
        renderStyleList(panel.querySelector('#ff-insp-style-filter').value);
    });

    panel.querySelector('#ff-insp-reset').addEventListener('click', () => {
        if (!inspectedElement) return;
        // Restore stylesheet rules edited/disabled from the CSS Rules list
        touchedRules.forEach((cssText, style) => { try { style.cssText = cssText; } catch (e) { } });
        touchedRules.clear();
        disabledDecls.clear();
        if (inspectedOriginalStyle === null) inspectedElement.removeAttribute('style');
        else inspectedElement.setAttribute('style', inspectedOriginalStyle);
        const customCss = document.getElementById('ff-insp-custom-css');
        if (customCss) customCss.remove();
        const feedback = panel.querySelector('#ff-insp-feedback');
        feedback.textContent = 'Styles reset to original';
        feedback.style.color = '#4ade80';
        renderStyleList(panel.querySelector('#ff-insp-style-filter').value);
    });

    renderStyleList('');
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

        // Try name, placeholder, or aria-label for relative XPath
        const attributes = ['name', 'placeholder', 'aria-label'];
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
        selectionAiEnabled = s.selectionAiTools !== false;
        if (!selectionAiEnabled) hideSelectionTools();
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

document.addEventListener('mouseup', () => setTimeout(() => { updateCharCounter(); updateSelectionTools(); }, 0), true);
document.addEventListener('keyup', (e) => {
    // Selection via keyboard (Shift+arrows, Ctrl+A)
    if (e.shiftKey || e.key === 'a' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        setTimeout(() => { updateCharCounter(); updateSelectionTools(); }, 0);
    }
}, true);
document.addEventListener('selectionchange', () => {
    // Hide promptly when the selection is cleared
    const t = window.getSelection() ? window.getSelection().toString() : '';
    if (!t.trim()) { hideCharCounter(); hideSelectionTools(); }
});

// ==================== Selection AI tools (translate / review) ====================
// A small icon appears next to a text selection; clicking it offers Translate
// (AR<->EN) and Review language (spelling + grammar). Uses the smart model.

let selectionAiEnabled = true;
let selectedTextForAi = '';

function hideSelectionTools() {
    const icon = document.getElementById('ff-sel-icon');
    if (icon) icon.remove();
    const menu = document.getElementById('ff-sel-menu');
    if (menu) menu.remove();
}

function updateSelectionTools() {
    if (!selectionAiEnabled) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    // Ignore tiny selections and selections inside our own UI
    if (!text || text.length < 2) { hideSelectionTools(); return; }
    if (sel.anchorNode && sel.anchorNode.parentElement &&
        sel.anchorNode.parentElement.closest('#ff-sel-icon, #ff-sel-menu, #ff-char-counter, #ff-ai-field-icon, #ff-ai-field-menu, #ff-sel-result')) return;

    selectedTextForAi = text;

    let icon = document.getElementById('ff-sel-icon');
    if (!icon) {
        icon = document.createElement('div');
        icon.id = 'ff-sel-icon';
        icon.title = 'Translate or review the selection';
        icon.style.cssText = 'position:fixed;z-index:2147483646;width:24px;height:24px;border-radius:7px;' +
            'background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;display:flex;align-items:center;justify-content:center;' +
            'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);font-size:12px;';
        icon.innerHTML = '<i class="fas fa-language"></i>';
        icon.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
        icon.addEventListener('click', (e) => { e.stopPropagation(); toggleSelectionMenu(); });
        document.body.appendChild(icon);
    }
    positionSelectionIcon();
}

// Keep the selection icon pinned to the selection - recompute on scroll/resize
function positionSelectionIcon() {
    const icon = document.getElementById('ff-sel-icon');
    if (!icon || icon.style.display === 'none') return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.toString().trim()) return;
    try {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        let top = r.top - 30; if (top < 4) top = r.bottom + 6;
        let left = r.right - 24; left = Math.max(4, Math.min(left, window.innerWidth - 28));
        icon.style.top = top + 'px';
        icon.style.left = left + 'px';
        // The open menu moves with the icon too
        const menu = document.getElementById('ff-sel-menu');
        if (menu) {
            const ir = icon.getBoundingClientRect();
            let mt = ir.bottom + 4;
            if (mt + menu.offsetHeight > window.innerHeight - 6) mt = ir.top - menu.offsetHeight - 4;
            menu.style.top = mt + 'px';
            menu.style.left = Math.max(4, Math.min(ir.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 6)) + 'px';
        }
    } catch (e) { }
}
window.addEventListener('scroll', positionSelectionIcon, true);
window.addEventListener('resize', positionSelectionIcon, true);

function toggleSelectionMenu() {
    const existing = document.getElementById('ff-sel-menu');
    if (existing) { existing.remove(); return; }
    const icon = document.getElementById('ff-sel-icon');
    if (!icon) return;

    const menu = document.createElement('div');
    menu.id = 'ff-sel-menu';
    menu.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(15,15,35,0.97);backdrop-filter:blur(8px);' +
        'border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:5px;box-shadow:0 8px 28px rgba(0,0,0,0.5);' +
        'font-family:\'Segoe UI\',Arial,sans-serif;min-width:175px;';
    menu.innerHTML = `
        <div class="ff-sel-opt" data-act="translate" style="display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:7px;cursor:pointer;color:#e0e0e0;font-size:13px;">
            <i class="fas fa-language" style="color:#38bdf8;"></i> Translate (AR &#8596; EN)
        </div>
        <div class="ff-sel-opt" data-act="review" style="display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:7px;cursor:pointer;color:#e0e0e0;font-size:13px;">
            <i class="fas fa-spell-check" style="color:#4ade80;"></i> Review language
        </div>`;
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.querySelectorAll('.ff-sel-opt').forEach(opt => {
        opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(99,102,241,0.25)'; });
        opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const act = opt.dataset.act;
            const text = selectedTextForAi;
            hideSelectionTools();
            runSelectionAi(act, text);
        });
    });
    document.body.appendChild(menu);
    const ir = icon.getBoundingClientRect();
    let top = ir.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 6) top = ir.top - menu.offsetHeight - 4;
    menu.style.top = top + 'px';
    menu.style.left = Math.max(4, Math.min(ir.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 6)) + 'px';

    const onOutside = (ev) => {
        if (ev.target.closest && ev.target.closest('#ff-sel-icon, #ff-sel-menu')) return;
        document.removeEventListener('mousedown', onOutside, true);
        hideSelectionTools();
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

function runSelectionAi(act, text) {
    if (!text) return;
    const isTranslate = act === 'translate';
    showFabAiStatus('loading', isTranslate ? 'Translating…' : 'Reviewing language…');
    chrome.runtime.sendMessage(
        { action: isTranslate ? 'aiTranslateText' : 'aiReviewText', text },
        (resp) => {
            if (chrome.runtime.lastError || !resp || resp.error) {
                const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown';
                showFabAiStatus('error', err === 'no_api_key' ? 'AI key is not configured' : ('Failed: ' + err));
                return;
            }
            if (isTranslate) {
                showFabAiStatus('success', 'Translated');
                showSelectionResult('Translation', resp.text || '');
            } else {
                showFabAiStatus('success', 'Reviewed');
                showReviewResult(resp.review || { isCorrect: true, issues: [] });
            }
        }
    );
}

const REVIEW_TYPE_COLORS = {
    spelling: '#fca5a5', grammar: '#fcd34d', 'word-choice': '#c4b5fd', punctuation: '#7dd3fc', spacing: '#fdba74', other: '#cbd5e1'
};
// Localized labels for the issue type (shown in the offending text's language)
const REVIEW_TYPE_LABELS_AR = {
    spelling: 'إملاء', grammar: 'نحو', 'word-choice': 'اختيار كلمة', punctuation: 'ترقيم', spacing: 'مسافات', other: 'أخرى'
};
function reviewTypeLabel(type, rtl) {
    if (rtl && REVIEW_TYPE_LABELS_AR[type]) return REVIEW_TYPE_LABELS_AR[type];
    return type;
}

// Download the review issues as a CSV file (UTF-8 with BOM for Excel/Arabic)
function downloadReviewCsv(issues) {
    const rows = [['#', 'Type', 'Original', 'Correction', 'Context', 'Explanation']];
    issues.forEach((it, i) => rows.push([
        i + 1, it.type || '', it.original || '', it.correction || '', it.context || '', it.explanation || ''
    ]));
    const csv = rows.map(r => r.map(c => {
        const s = String(c == null ? '' : c).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `language-review-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Render the structured language review: each mistake as wrong -> correct + why
function showReviewResult(review) {
    const old = document.getElementById('ff-sel-result');
    if (old) old.remove();
    const issues = review.issues || [];

    const body = (review.isCorrect || issues.length === 0)
        ? '<div style="padding:16px;text-align:center;color:#6ee7b7;"><i class="fas fa-circle-check"></i> No mistakes found.</div>'
        : issues.map(it => {
            const rtl = /[؀-ۿ]/.test((it.context || '') + (it.original || '') + (it.explanation || ''));
            // Show the surrounding context with the wrong fragment highlighted in place
            let ctx = '';
            if (it.context) {
                const safe = escapeHtml(it.context);
                const wrong = escapeHtml(it.original);
                const highlighted = (wrong && safe.includes(wrong))
                    ? safe.replace(wrong, `<mark class="rv-mark">${wrong}</mark>`)
                    : safe;
                ctx = `<div class="rv-ctx">…${highlighted}…</div>`;
            }
            return `<div class="rv-item" style="${rtl ? 'direction:rtl;' : ''}">
                <div class="rv-line"><span class="rv-wrong">${escapeHtml(it.original)}</span><svg class="rv-arrow" width="13" height="13" viewBox="0 0 24 24" fill="#94a3b8" aria-hidden="true"><path d="M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z"/></svg><span class="rv-right">${escapeHtml(it.correction)}</span></div>
                ${ctx}
                <div class="rv-meta"><span class="rv-tag" style="color:${REVIEW_TYPE_COLORS[it.type] || '#cbd5e1'};">${escapeHtml(reviewTypeLabel(it.type, rtl))}</span> ${escapeHtml(it.explanation)}</div>
            </div>`;
        }).join('');

    const panel = document.createElement('div');
    panel.id = 'ff-sel-result';
    panel.innerHTML = `
        <style>
            #ff-sel-result { position: fixed; top: 16px; right: 16px; width: 380px; max-height: 82vh; z-index: 2147483647; display: flex; flex-direction: column; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 2px solid rgba(139,92,246,0.5); border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,0.7); color: #fff; font-family: 'Segoe UI', Arial, sans-serif; }
            #ff-sel-result .sr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: move; user-select: none; }
            #ff-sel-result .sr-title { font: 700 13px/1.4 'Segoe UI', Arial; }
            #ff-sel-result .sr-btns { display: flex; gap: 6px; }
            #ff-sel-result .sr-btns button { background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; font-size: 13px; }
            #ff-sel-result .sr-btns button:hover { background: rgba(255,255,255,0.22); }
            #ff-sel-result .sr-body { overflow-y: auto; padding: 8px 12px 12px; }
            #ff-sel-result .rv-item { background: rgba(0,0,0,0.3); border-radius: 9px; padding: 10px 12px; margin-top: 8px; }
            #ff-sel-result .rv-line { font-size: 14px; line-height: 1.7; word-break: break-word; direction: ltr; text-align: left; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
            #ff-sel-result .rv-wrong { color: #fca5a5; text-decoration: line-through; text-decoration-color: rgba(239,68,68,0.5); unicode-bidi: isolate; }
            #ff-sel-result .rv-right { unicode-bidi: isolate; }
            #ff-sel-result .rv-arrow { flex-shrink: 0; margin: 0 4px; }
            #ff-sel-result .rv-right { color: #6ee7b7; font-weight: 600; }
            #ff-sel-result .rv-ctx { font-size: 12.5px; color: #94a3b8; margin-top: 6px; line-height: 1.7; background: rgba(255,255,255,0.04); border-radius: 6px; padding: 5px 8px; word-break: break-word; }
            #ff-sel-result .rv-mark { background: rgba(239,68,68,0.3); color: #fecaca; border-radius: 3px; padding: 0 2px; }
            #ff-sel-result .rv-meta { font-size: 12px; color: #94a3b8; margin-top: 5px; line-height: 1.5; }
            #ff-sel-result .rv-tag { font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; margin-right: 5px; }
        </style>
        <div class="sr-head">
            <span class="sr-title">&#128221; Language Review${issues.length ? ' (' + issues.length + ')' : ''}</span>
            <div class="sr-btns">
                ${issues.length ? '<button id="sr-csv" title="Download as CSV"><i class="fas fa-file-csv"></i></button>' : ''}
                <button id="sr-close" title="Close">&#10005;</button>
            </div>
        </div>
        <div class="sr-body">${body}</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#sr-close').addEventListener('click', () => panel.remove());
    const csvBtn = panel.querySelector('#sr-csv');
    if (csvBtn) csvBtn.addEventListener('click', () => downloadReviewCsv(issues));

    let drag = null;
    const head = panel.querySelector('.sr-head');
    head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (!drag) return; panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px'; panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { drag = null; });
}

function showSelectionResult(title, text) {
    const old = document.getElementById('ff-sel-result');
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'ff-sel-result';
    panel.innerHTML = `
        <style>
            #ff-sel-result {
                position: fixed; top: 16px; right: 16px; width: 360px; max-height: 80vh;
                z-index: 2147483647; display: flex; flex-direction: column;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border: 2px solid rgba(139, 92, 246, 0.5); border-radius: 14px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.7); color: #fff;
                font-family: 'Segoe UI', Arial, sans-serif;
            }
            #ff-sel-result .sr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: move; user-select: none; }
            #ff-sel-result .sr-title { font: 700 13px/1.4 'Segoe UI', Arial; }
            #ff-sel-result .sr-btns button { background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; font-size: 13px; margin-left: 4px; }
            #ff-sel-result .sr-btns button:hover { background: rgba(255,255,255,0.22); }
            #ff-sel-result .sr-text { margin: 12px 14px; padding: 10px 12px; background: rgba(0,0,0,0.35); border-radius: 8px; font: 13.5px/1.8 'Segoe UI', Tahoma, sans-serif; color: #e2e8f0; white-space: pre-wrap; word-break: break-word; overflow-y: auto; }
            #ff-sel-result .sr-copy { margin: 0 14px 14px; border: none; border-radius: 8px; padding: 9px; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff; background: linear-gradient(135deg, #8b5cf6, #6366f1); }
            #ff-sel-result .sr-copy:hover { filter: brightness(1.12); }
        </style>
        <div class="sr-head">
            <span class="sr-title">${escapeHtml(title)}</span>
            <div class="sr-btns"><button id="sr-close" title="Close">&#10005;</button></div>
        </div>
        <div class="sr-text" id="sr-text"></div>
        <button class="sr-copy" id="sr-copy"><i class="fas fa-copy"></i> Copy</button>
    `;
    document.body.appendChild(panel);
    const textEl = panel.querySelector('#sr-text');
    textEl.textContent = text;
    // Align the result by the OUTPUT language: Arabic -> RTL/right, else LTR/left
    // (explicit both ways so it doesn't inherit the page's direction).
    const isRtl = /[؀-ۿݐ-ݿ]/.test(text);
    textEl.style.direction = isRtl ? 'rtl' : 'ltr';
    textEl.style.textAlign = isRtl ? 'right' : 'left';
    panel.querySelector('#sr-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#sr-copy').addEventListener('click', (e) => {
        ffCopyText(text).then(() => {
            const b = e.currentTarget; const o = b.innerHTML;
            b.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => { b.innerHTML = o; }, 1400);
        }).catch(() => { });
    });

    // Drag by header
    let drag = null;
    const head = panel.querySelector('.sr-head');
    head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (!drag) return; panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px'; panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { drag = null; });
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
        'font-family:\'Segoe UI\',Arial,sans-serif;min-width:160px;';
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
    if (qaActiveTool) { qaToolDone(qaActiveTool); qaActiveTool = null; } // unlock the card
}

// Open the floating panel; returns the .qa-body element to fill.
function qaOpenPanel(titleHtml, tool) {
    qaClosePanel();
    qaScanCtrl = new AbortController();
    qaActiveTool = tool || null;
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
            #qa-result-panel .qa-sum { display: flex; gap: 8px; margin-bottom: 12px; }
            #qa-result-panel .qa-stat { flex: 1; background: rgba(255,255,255,0.05); border-radius: 10px; padding: 9px; text-align: center; }
            #qa-result-panel .qa-stat .n { font-size: 19px; font-weight: 800; }
            #qa-result-panel .qa-stat .l { font-size: 9.5px; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }
            #qa-result-panel .qa-stat.ok .n { color: #6ee7b7; } #qa-result-panel .qa-stat.bad .n { color: #f87171; }
            #qa-result-panel .lhrow { display: flex; gap: 8px; align-items: center; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,0.03); border-left: 3px solid #475569; margin-bottom: 4px; }
            #qa-result-panel .lhst { font-weight: 700; font-size: 10.5px; font-family: Consolas, monospace; min-width: 30px; text-align: center; flex-shrink: 0; }
            #qa-result-panel .s-ok.lhrow, #qa-result-panel .lhrow.s-ok { border-left-color: #10b981; } #qa-result-panel .lhst.s-ok { color: #6ee7b7; }
            #qa-result-panel .lhrow.s-redir { border-left-color: #f59e0b; } #qa-result-panel .lhst.s-redir { color: #fcd34d; }
            #qa-result-panel .lhrow.s-auth { border-left-color: #0ea5e9; } #qa-result-panel .lhst.s-auth { color: #7dd3fc; }
            #qa-result-panel .lhrow.s-forbid { border-left-color: #a855f7; } #qa-result-panel .lhst.s-forbid { color: #c084fc; }
            #qa-result-panel .lhrow.s-broken { border-left-color: #ef4444; background: rgba(239,68,68,0.07); } #qa-result-panel .lhst.s-broken { color: #f87171; }
            #qa-result-panel .lhrow.s-soft { border-left-color: #fb923c; background: rgba(251,146,60,0.08); } #qa-result-panel .lhst.s-soft { color: #fdba74; }
            #qa-result-panel .lhrow.s-unknown { border-left-color: #64748b; } #qa-result-panel .lhst.s-unknown { color: #94a3b8; }
            #qa-result-panel .lhrow.s-nourl { border-left-color: #2dd4bf; background: rgba(45,212,191,0.06); } #qa-result-panel .lhst.s-nourl { color: #5eead4; font-size: 8.5px; }
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
            #qa-result-panel .pf-res { display: flex; justify-content: space-between; font-size: 11.5px; color: #cbd5e1; padding: 4px 2px; border-bottom: 1px solid rgba(255,255,255,0.04); }
            #qa-result-panel .pf-slow { background: rgba(255,255,255,0.03); border-radius: 7px; padding: 6px 8px; margin-bottom: 4px; }
            #qa-result-panel .pf-slow-top { display: flex; gap: 8px; font-size: 10.5px; }
            #qa-result-panel .pf-slow-dur { color: #fca5a5; font-weight: 700; font-family: Consolas, monospace; }
            #qa-result-panel .pf-slow-type { color: #a5b4fc; } #qa-result-panel .pf-slow-sz { color: #94a3b8; margin-left: auto; }
            #qa-result-panel .pf-slow-url { font-size: 10px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; direction: ltr; }
        </style>
        <div class="qa-head">
            <span class="qa-title">${titleHtml}</span>
            <button class="qa-close" id="qa-close" title="Close">&#10005;</button>
        </div>
        <div class="qa-body" id="qa-body"><div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Working…</div></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#qa-close').addEventListener('click', qaClosePanel);

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
function lhClassify(r) {
    if (r.soft) return { kind: 's-soft', label: '200⚠' };
    const s = r.status;
    if (s >= 200 && s < 300) return { kind: 's-ok', label: String(s) };
    if (s >= 300 && s < 400) return { kind: 's-redir', label: String(s) };
    if (s === 401) return { kind: 's-auth', label: '401' };
    if (s === 403) return { kind: 's-forbid', label: '403' };
    if (s >= 400) return { kind: 's-broken', label: String(s) };
    return { kind: 's-unknown', label: r.error ? 'ERR' : '0' };
}
const LH_COLORS = { 's-ok': '#10b981', 's-redir': '#f59e0b', 's-auth': '#0ea5e9', 's-forbid': '#a855f7', 's-broken': '#ef4444', 's-unknown': '#64748b', 's-soft': '#fb923c' };
function lhIsBroken(r) { return r.soft || (r.status >= 400 && r.status !== 401 && r.status !== 403) || (r.status === 0 && r.error && r.error !== 'Timeout'); }

function qaToolDone(tool) { try { chrome.runtime.sendMessage({ action: 'toolScanDone', tool }); } catch (e) { } }

async function runLinkHealth() {
    const body = qaOpenPanel('&#128279; Link Health', 'links');
    try {
        await runLinkHealthInner(body);
    } finally {
        if (!qaAborted()) { qaToolDone('links'); qaActiveTool = null; }
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
    body.innerHTML = `<div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Checking ${links.length} link(s)…</div>`;

    const origin = location.origin;
    const same = links.filter(l => { try { return new URL(l.href).origin === origin; } catch (e) { return false; } });
    const cross = links.filter(l => !same.includes(l));

    function sniff(u, method) {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
        const onAbort = () => { try { ctrl.abort(); } catch (e) { } };
        if (myCtrl) myCtrl.signal.addEventListener('abort', onAbort);
        const cleanup = () => { clearTimeout(timer); if (myCtrl) myCtrl.signal.removeEventListener('abort', onAbort); };
        return fetch(u, { method: method || 'GET', redirect: 'follow', signal: ctrl.signal })
            .then(async r => {
                let len = null;
                if ((method || 'GET') === 'GET') { let t = ''; try { t = await r.text(); } catch (e) { } len = t.replace(/\s+/g, ' ').trim().length; }
                cleanup();
                return { status: r.status, ok: r.ok, redirected: r.redirected, finalUrl: r.url, len };
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

    async function checkHere(list) {
        const out = new Array(list.length); let i = 0;
        async function worker() {
            while (i < list.length) {
                if (aborted()) return; // panel closed → stop
                const idx = i++; const href = list[idx].href;
                // In soft-404 mode we GET (need the body length); otherwise HEAD is enough.
                const res = await sniff(href, softMode ? 'GET' : 'HEAD');
                if (res.status === 405 || res.status === 501) Object.assign(res, await sniff(href, 'GET'));
                if (softMode && res.status >= 200 && res.status < 400) res.soft = isSoft(href, res);
                out[idx] = res;
            }
        }
        await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
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

    const [sameRes, crossRes] = await Promise.all([
        same.length ? checkHere(same) : Promise.resolve([]),
        cross.length ? checkBg(cross) : Promise.resolve([])
    ]);
    if (aborted()) return; // panel closed mid-scan
    same.forEach((l, i) => Object.assign(l, sameRes[i] || { status: 0, ok: false }));
    cross.forEach((l, i) => Object.assign(l, crossRes[i] || { status: 0, ok: false }));

    // Colour the actual links on the page by status
    links.forEach(l => {
        const c = lhClassify(l); const color = LH_COLORS[c.kind];
        l.els.forEach(el => {
            if (!el.isConnected) return;
            el.style.setProperty('outline', `2px solid ${color}`, 'important');
            el.style.setProperty('outline-offset', '1px', 'important');
            el.setAttribute('data-qa-link', c.label);
            el.title = `QA Link Health: ${l.soft ? 'Soft 404 — HTTP 200 but the page looks like a not-found/redirect' : (l.status === 0 ? (l.error || 'Unreachable') : l.status)}`;
        });
    });

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
    const okCount = links.filter(l => l.status >= 200 && l.status < 400 && !l.soft).length;

    let html = `<div class="qa-sum">
        <div class="qa-stat"><div class="n">${links.length}</div><div class="l">Checked</div></div>
        <div class="qa-stat ok"><div class="n">${okCount}</div><div class="l">OK</div></div>
        <div class="qa-stat bad"><div class="n">${lhBrokenCache.length}</div><div class="l">Broken</div></div>
        <div class="qa-stat nourl"><div class="n">${lhNoUrl.length}</div><div class="l">No URL</div></div>
    </div>`;
    if (lhBrokenCache.length) html += `<button class="qa-btn" id="lh-explain"><i class="fas fa-wand-magic-sparkles"></i> Explain &amp; Fix (${lhBrokenCache.length})</button>`;
    html += rows.map(({ l, c }) => `<div class="lhrow ${c.kind}">
        <span class="lhst ${c.kind}">${qaEsc(c.label)}</span>
        <div class="lhinfo"><div class="lhhref">${qaEsc(l.href)}</div>${l.text ? `<div class="lhtext">${qaEsc(l.text)}</div>` : ''}</div>
    </div>`).join('');

    if (lhNoUrl.length) {
        html += `<div class="qa-grp">Links without a real URL (${lhNoUrl.length})</div>`;
        html += lhNoUrl.map(n => `<div class="lhrow s-nourl">
            <span class="lhst s-nourl" title="${qaEsc(n.reason)}">NO&nbsp;URL</span>
            <div class="lhinfo"><div class="lhtext" style="color:#cbd5e1;">${qaEsc(n.text || '(no text)')}</div><div class="lhtext">${qaEsc(n.reason)}${n.handler ? ' · has JS handler' : ''}</div></div>
        </div>`).join('');
    }
    body.innerHTML = html;

    const ex = body.querySelector('#lh-explain');
    if (ex) ex.addEventListener('click', () => {
        ex.disabled = true; ex.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing with AI…';
        chrome.runtime.sendMessage({ action: 'aiExplainLinks', broken: lhBrokenCache, url: location.href }, (resp) => {
            if (chrome.runtime.lastError || !resp || resp.error) {
                ex.disabled = false; ex.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Explain & Fix';
                alert((resp && resp.error === 'no_api_key') ? 'AI key not configured in the extension settings.' : 'AI failed: ' + ((resp && resp.error) || 'error'));
                return;
            }
            const findings = resp.findings || [];
            let h = `<button class="qa-btn" id="lh-back" style="background:rgba(255,255,255,0.12);"><i class="fas fa-arrow-left"></i> Back to links</button>`;
            h += findings.length ? findings.map(f => `<div class="qa-find">
                <h5>${qaEsc(f.title)} <span class="sev ${qaEsc(f.severity)}">${qaEsc(f.severity)}</span></h5>
                <p>${qaEsc(f.cause)}</p><p class="fix"><i class="fas fa-lightbulb"></i> ${qaEsc(f.fix)}</p></div>`).join('')
                : '<div class="qa-empty">The AI found nothing actionable.</div>';
            body.innerHTML = h;
            body.querySelector('#lh-back').addEventListener('click', () => lhRenderResults(body, links));
        });
    });
}

// ---- Security scan (panel on the page; scan runs in the background) ----
function runSecurityScan() {
    const body = qaOpenPanel('&#128737; Security Scan', 'security');
    const myCtrl = qaScanCtrl;
    body.innerHTML = '<div class="qa-empty"><i class="fas fa-spinner fa-spin"></i> Scanning &amp; analyzing with AI…</div>';
    chrome.runtime.sendMessage({ action: 'aiSecurityScan', url: location.href }, (resp) => {
        if (!myCtrl || myCtrl.signal.aborted || myCtrl !== qaScanCtrl) return; // closed or superseded
        qaToolDone('security'); qaActiveTool = null;
        if (chrome.runtime.lastError || !resp || resp.error) {
            body.innerHTML = `<div class="qa-empty">${(resp && resp.error === 'no_api_key') ? 'AI key not configured in the extension settings.' : 'Scan failed: ' + qaEsc((chrome.runtime.lastError && chrome.runtime.lastError.message) || (resp && resp.error) || 'error')}</div>`;
            return;
        }
        secRenderPanel(body, resp.ai || {}, resp.data || { ssl: {}, checks: [], cookies: { total: 0, details: [] } });
    });
}

function secRenderPanel(body, ai, data) {
    const grade = ai.grade === 'good' ? 'good' : ai.grade === 'medium' ? 'mid' : 'bad';
    const score = Math.max(0, Math.min(100, ai.score || 0));
    let html = `<div class="qa-score-wrap">
        <div class="qa-score ${grade}" style="--p:${Math.round(score * 3.6)}deg"><span>${score}</span></div>
        <div class="qa-score-info"><h4>Security score: ${score}/100</h4><p>${qaEsc(ai.summary || '')}</p></div>
    </div>`;
    const findings = ai.findings || [];
    if (findings.length) {
        html += `<div class="qa-grp">AI findings</div>`;
        html += findings.map(f => `<div class="qa-find">
            <h5>${qaEsc(f.title)} <span class="sev ${qaEsc(f.severity)}">${qaEsc(f.severity)}</span></h5>
            <p>${qaEsc(f.cause)}</p><p class="fix"><i class="fas fa-lightbulb"></i> ${qaEsc(f.fix)}</p></div>`).join('');
    } else {
        html += `<div class="qa-empty">No issues found — the page looks solid. ✅</div>`;
    }
    // Scanned facts
    const secrow = (cls, nm, ds) => `<div class="qa-secrow ${cls}"><div><div class="nm">${qaEsc(nm)}</div>${ds ? `<div class="ds">${qaEsc(ds)}</div>` : ''}</div></div>`;
    html += `<div class="qa-grp">Connection</div>`;
    const sslPass = data.ssl.protocol === 'HTTPS' || data.ssl.protocol === 'Local';
    html += secrow(sslPass ? 'pass' : 'fail', 'SSL / HTTPS', `${data.ssl.status} (${data.ssl.protocol})`);
    html += `<div class="qa-grp">Security headers</div>`;
    if (data.headersError) html += `<div class="qa-empty">${qaEsc(data.headersError)}</div>`;
    (data.checks || []).forEach(c => html += secrow(c.impact === 'positive' ? (c.warning ? 'warn' : 'pass') : 'fail', c.name, c.warning || (c.status === 'Passed' ? c.value : c.status)));
    html += `<div class="qa-grp">Cookies (${data.cookies.total})</div>`;
    if (!data.cookies.total) html += secrow('pass', 'No cookies', 'This page set no cookies');
    else (data.cookies.details || []).forEach(c => html += secrow(c.risky ? 'fail' : 'pass', c.name, `HttpOnly:${c.httpOnly ? '✓' : '✗'} Secure:${c.secure ? '✓' : '✗'} SameSite:${c.sameSite}${c.risks && c.risks.length ? ' — ' + c.risks.join(' · ') : ''}`));
    body.innerHTML = html;
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
    try {
        const m = await collectPerf();
        if (qaAborted()) return;
        perfLast = m;
        perfRender(body, m);
    } finally {
        if (!qaAborted()) { qaToolDone('perf'); qaActiveTool = null; }
    }
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

    // Navigation phases as bars
    const phases = m.phases; const maxP = Math.max(1, ...Object.values(phases));
    html += `<div class="qa-grp">Load phases</div>`;
    const labels = { dns: 'DNS', tcp: 'TCP', request: 'Request (TTFB)', response: 'Download', dom: 'DOM build' };
    html += Object.keys(labels).map(k => `<div class="pf-bar-row">
        <div class="pf-bar-l">${labels[k]}</div>
        <div class="pf-bar-track"><div class="pf-bar" style="width:${Math.round((phases[k] / maxP) * 100)}%"></div></div>
        <div class="pf-bar-v">${perfMs(phases[k])}</div>
    </div>`).join('');

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
        const types = Object.keys(cfg.types).filter(k => cfg.types[k]);
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
function stGetStore() { return stSection === 'session' ? sessionStorage : localStorage; }

function openStoragePanel() {
    const old = document.getElementById('qa-storage'); if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'qa-storage';
    panel.innerHTML = `
        <style>
            #qa-storage { position: fixed; top: 16px; right: 16px; width: 390px; max-height: 86vh; z-index: 2147483647; display: flex; flex-direction: column; direction: ltr; text-align: left;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 2px solid rgba(56,189,248,0.5); border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,0.7); color: #fff; font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; }
            #qa-storage .st-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.1); cursor: move; user-select: none; }
            #qa-storage .st-title { font-weight: 700; font-size: 13.5px; }
            #qa-storage .st-close { background: rgba(255,255,255,0.1); border: none; color: #fff; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; font-size: 13px; }
            #qa-storage .st-tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
            #qa-storage .st-tab { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid transparent; color: #cbd5e1; border-radius: 8px; padding: 7px 6px; font-size: 11.5px; cursor: pointer; font-family: inherit; }
            #qa-storage .st-tab.on { background: rgba(56,189,248,0.22); border-color: rgba(56,189,248,0.5); color: #fff; }
            #qa-storage .st-tab span { opacity: 0.7; }
            #qa-storage .st-add { display: flex; gap: 6px; padding: 10px 12px; }
            #qa-storage .st-add input { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; color: #fff; padding: 7px 8px; font-size: 12px; outline: none; }
            #qa-storage .st-add .st-ak { width: 38%; } #qa-storage .st-add .st-av { flex: 1; }
            #qa-storage .st-add button { background: linear-gradient(135deg,#38bdf8,#0ea5e9); border: none; color: #06283d; font-weight: 700; border-radius: 7px; padding: 0 12px; cursor: pointer; }
            #qa-storage .st-body { overflow-y: auto; padding: 0 12px 12px; }
            #qa-storage .st-row { display: flex; align-items: center; gap: 6px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
            #qa-storage .st-k { width: 34%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
            #qa-storage .st-k .st-flags { color: #fbbf24; font-size: 9px; font-weight: 700; margin-left: 4px; }
            #qa-storage .st-v { flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e2e8f0; padding: 6px 7px; font: 11.5px Consolas, monospace; outline: none; }
            #qa-storage .st-v:focus { border-color: #38bdf8; }
            #qa-storage .st-row button { background: rgba(255,255,255,0.08); border: none; color: #94a3b8; cursor: pointer; width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0; }
            #qa-storage .st-row button:hover { background: rgba(255,255,255,0.2); color: #fff; }
            #qa-storage .st-row button.st-del:hover { color: #f87171; }
            #qa-storage .st-empty { text-align: center; color: #64748b; padding: 26px 8px; }
        </style>
        <div class="st-head"><span class="st-title">&#129528; Cookies &amp; Storage</span><button class="st-close" id="st-close" title="Close">&#10005;</button></div>
        <div class="st-tabs">
            <button class="st-tab" data-sec="cookies">Cookies</button>
            <button class="st-tab" data-sec="local">Local Storage</button>
            <button class="st-tab" data-sec="session">Session Storage</button>
        </div>
        <div class="st-add">
            <input class="st-ak" placeholder="name / key"><input class="st-av" placeholder="value"><button id="st-add">Add</button>
        </div>
        <div class="st-body" id="st-body"></div>`;
    document.body.appendChild(panel);

    panel.querySelector('#st-close').addEventListener('click', () => panel.remove());
    panel.querySelectorAll('.st-tab').forEach(b => b.addEventListener('click', () => { stSection = b.dataset.sec; stRefresh(); }));
    panel.querySelector('#st-add').addEventListener('click', stAdd);
    panel.querySelector('#st-body').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-st]'); if (!btn) return;
        const row = btn.closest('.st-row');
        if (btn.dataset.st === 'save') stSave(row.dataset.k, row.querySelector('.st-v').value);
        else if (btn.dataset.st === 'del') stDelete(row.dataset.k);
    });
    panel.querySelector('#st-body').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('st-v')) { const row = e.target.closest('.st-row'); stSave(row.dataset.k, e.target.value); }
    });

    // drag by header
    (function () {
        const head = panel.querySelector('.st-head'); let sx, sy, sl, st;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.st-close') || e.button !== 0) return;
            const r = panel.getBoundingClientRect(); panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.style.right = 'auto';
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top; e.preventDefault();
            const mv = (ev) => { panel.style.left = Math.max(0, Math.min(sl + ev.clientX - sx, innerWidth - panel.offsetWidth)) + 'px'; panel.style.top = Math.max(0, Math.min(st + ev.clientY - sy, innerHeight - 40)) + 'px'; };
            const up = () => { document.removeEventListener('mousemove', mv, true); document.removeEventListener('mouseup', up, true); };
            document.addEventListener('mousemove', mv, true); document.addEventListener('mouseup', up, true);
        });
    })();

    stRefresh();
}

function stRefresh() {
    const panel = document.getElementById('qa-storage'); if (!panel) return;
    panel.querySelectorAll('.st-tab').forEach(b => b.classList.toggle('on', b.dataset.sec === stSection));
    if (stSection === 'cookies') {
        chrome.runtime.sendMessage({ action: 'getCookies', url: location.href }, (resp) => {
            stCookies = (resp && resp.cookies) || [];
            stRenderRows(stCookies.map(c => ({
                k: c.name, v: c.value,
                flags: [c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : '', c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : ''].filter(Boolean).join(' · ')
            })));
        });
    } else {
        const store = stGetStore(); const rows = [];
        for (let i = 0; i < store.length; i++) { const k = store.key(i); rows.push({ k, v: store.getItem(k), flags: '' }); }
        stRenderRows(rows);
    }
}

function stRenderRows(rows) {
    const body = document.getElementById('st-body'); if (!body) return;
    if (!rows.length) { body.innerHTML = '<div class="st-empty">Nothing stored here for this site.</div>'; return; }
    body.innerHTML = rows.map(r => `<div class="st-row" data-k="${qaEsc(r.k)}">
        <div class="st-k" title="${qaEsc(r.k)}">${qaEsc(r.k)}${r.flags ? `<span class="st-flags">${qaEsc(r.flags)}</span>` : ''}</div>
        <input class="st-v" value="${qaEsc(r.v)}">
        <button data-st="save" class="st-save" title="Save">&#10003;</button>
        <button data-st="del" class="st-del" title="Delete">&#10005;</button>
    </div>`).join('');
}

function stSave(key, value) {
    if (stSection === 'cookies') {
        const c = stCookies.find(x => x.name === key); if (!c) return;
        chrome.runtime.sendMessage({ action: 'setCookie', cookie: Object.assign({}, c, { value }) }, () => stToast('Saved'));
    } else {
        try { stGetStore().setItem(key, value); stToast('Saved'); } catch (e) { stToast('Failed: ' + e.message); }
    }
}
function stDelete(key) {
    if (stSection === 'cookies') {
        const c = stCookies.find(x => x.name === key); if (!c) return;
        chrome.runtime.sendMessage({ action: 'removeCookie', cookie: c }, () => stRefresh());
    } else {
        try { stGetStore().removeItem(key); } catch (e) { } stRefresh();
    }
}
function stAdd() {
    const panel = document.getElementById('qa-storage'); if (!panel) return;
    const k = panel.querySelector('.st-ak').value.trim(); const v = panel.querySelector('.st-av').value;
    if (!k) { panel.querySelector('.st-ak').style.borderColor = '#ef4444'; return; }
    if (stSection === 'cookies') {
        const host = location.hostname;
        chrome.runtime.sendMessage({ action: 'setCookie', cookie: { name: k, value: v, path: '/', domain: host, hostOnly: true, secure: location.protocol === 'https:' } }, () => { panel.querySelector('.st-ak').value = ''; panel.querySelector('.st-av').value = ''; stRefresh(); });
    } else {
        try { stGetStore().setItem(k, v); } catch (e) { } panel.querySelector('.st-ak').value = ''; panel.querySelector('.st-av').value = ''; stRefresh();
    }
}
function stToast(msg) {
    const old = document.getElementById('st-toast'); if (old) old.remove();
    const t = document.createElement('div'); t.id = 'st-toast'; t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0ea5e9;color:#fff;padding:8px 16px;border-radius:8px;font:13px Segoe UI,Arial;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.4);';
    document.body.appendChild(t); setTimeout(() => t.remove(), 1300);
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
    rotate: rvIco('<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>'),
    link: rvIco('<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM13 7v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10zm-5 4h8v2H8z"/>'),
    touch: rvIco('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-6a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/>'),
    camera: rvIco('<path d="M9 3 7.5 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>'),
    eye: rvIco('<path d="M12 5C5 5 2 12 2 12s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>'),
    close: rvIco('<path d="M18.3 5.7 12 12l6.3 6.3-1.3 1.4L10.6 13.4 4.3 19.7 3 18.3 9.2 12 3 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/>', 12)
};

function rvDefaultState() {
    const s = { tabs: [], active: 1, nextTab: 1, nextScreen: 1, custom: [], zoom: 0.5, ua: 'desktop', mockup: false, layout: 'row', sync: true, touch: true, outline: false, grid: false, ruler: false };
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
    chrome.storage.local.get(RV_STORE, (res) => {
        const saved = res && res[RV_STORE];
        rvState = saved && saved.tabs && saved.tabs.length ? Object.assign(rvDefaultState(), saved) : rvDefaultState();
        rvState.url = location.href;
        rvState.isolated = null;
        rvState.outline = rvState.grid = rvState.ruler = false; // hidden for now
        if (!rvState.tabs.some(t => t.id === rvState.active)) rvState.active = rvState.tabs[0].id;
        rvBuildOverlay();
    });
}

function rvBuildOverlay() {
    chrome.runtime.sendMessage({ action: 'responsiveDnr', enable: true, ua: rvState.ua }).catch(() => { });
    const o = document.createElement('div');
    o.id = 'qa-rv';
    o.innerHTML = `
        <style>
            #qa-rv { position: fixed; inset: 0; z-index: 2147483647; background: #0f0f17; color: #e2e8f0; direction: ltr; text-align: left;
                font-family: 'Segoe UI', Arial, sans-serif; display: flex; flex-direction: column; }
            #qa-rv * { box-sizing: border-box; }
            #qa-rv .rv-bar { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #16162a; border-bottom: 1px solid rgba(255,255,255,0.08); flex-wrap: wrap; flex-shrink: 0; }
            #qa-rv .rv-brand { font-weight: 700; font-size: 13.5px; color: #fff; display: flex; align-items: center; gap: 7px; }
            #qa-rv .rv-url { flex: 1; min-width: 200px; display: flex; gap: 6px; }
            #qa-rv .rv-url input { flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: #fff; padding: 8px 11px; font-size: 12.5px; outline: none; }
            #qa-rv .rv-btn { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #e2e8f0; border-radius: 8px; padding: 7px 10px; font-size: 12.5px; cursor: pointer; white-space: nowrap; font-family: inherit; display: inline-flex; align-items: center; gap: 5px; }
            #qa-rv .rv-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
            #qa-rv .rv-btn.go { background: linear-gradient(135deg,#8b5cf6,#6366f1); border: none; color: #fff; font-weight: 600; }
            #qa-rv .rv-btn.on { background: rgba(139,92,246,0.3); border-color: rgba(139,92,246,0.6); color: #fff; }
            #qa-rv .rv-btn.close { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.4); }
            #qa-rv select.rv-sel { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #fff; border-radius: 8px; padding: 7px 8px; font-size: 12.5px; outline: none; cursor: pointer; }
            #qa-rv select.rv-sel option { background: #16213e; color: #fff; }
            #qa-rv .rv-zoomwrap { display: inline-flex; align-items: center; gap: 3px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 0 8px 0 4px; }
            #qa-rv .rv-zoomwrap input { width: 44px; background: none; border: none; color: #fff; padding: 7px 2px; font-size: 12.5px; outline: none; text-align: right; }
            #qa-rv .rv-zoomwrap b { color: #94a3b8; font-weight: 400; font-size: 12px; }
            /* Tab bar */
            #qa-rv .rv-tabs { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: #12121f; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; overflow-x: auto; }
            #qa-rv .rv-tab { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.05); border: 1px solid transparent; color: #cbd5e1; border-radius: 8px 8px 0 0; padding: 6px 10px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
            #qa-rv .rv-tab.active { background: #0f0f17; border-color: rgba(139,92,246,0.5); border-bottom-color: transparent; color: #fff; }
            #qa-rv .rv-tabname { outline: none; }
            #qa-rv .rv-tabx { background: none; border: none; color: #64748b; cursor: pointer; font-size: 13px; padding: 0 2px; }
            #qa-rv .rv-tabx:hover { color: #f87171; }
            #qa-rv .rv-tabedit { background: none; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 0 2px; }
            #qa-rv .rv-tabedit:hover { color: #a78bfa; }
            #qa-rv .rv-tabname[contenteditable="true"] { background: rgba(255,255,255,0.1); border-radius: 4px; padding: 0 4px; }
            #qa-rv .rv-tabadd { background: rgba(255,255,255,0.06); border: none; color: #94a3b8; cursor: pointer; border-radius: 6px; width: 26px; height: 26px; font-size: 16px; }
            #qa-rv .rv-tabadd:hover { background: rgba(255,255,255,0.16); color: #fff; }
            #qa-rv .rv-iso { display: none; padding: 7px 12px; background: rgba(139,92,246,0.15); border-bottom: 1px solid rgba(139,92,246,0.3); font-size: 12px; color: #c4b5fd; flex-shrink: 0; }
            #qa-rv .rv-stage { flex: 1; overflow: auto; padding: 18px; }
            #qa-rv .rv-row { display: flex; gap: 20px; align-items: flex-start; min-width: min-content; }
            #qa-rv .rv-row.stack { flex-direction: column; align-items: center; }
            #qa-rv .rv-fhead { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: #cbd5e1; overflow: hidden; }
            #qa-rv .rv-fname { font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: grab; }
            #qa-rv .rv-fname:active { cursor: grabbing; }
            #qa-rv .rv-fdim { font-size: 11px; color: #64748b; font-family: Consolas, monospace; flex-shrink: 0; cursor: text; }
            #qa-rv .rv-fdim:hover { color: #93c5fd; }
            #qa-rv .rv-fdim[contenteditable="true"] { background: rgba(255,255,255,0.1); border-radius: 4px; padding: 0 4px; color: #fff; }
            #qa-rv .rv-fact { display: flex; gap: 3px; flex-shrink: 0; }
            #qa-rv .rv-fact button { background: rgba(255,255,255,0.07); border: none; color: #94a3b8; cursor: pointer; width: 24px; height: 22px; border-radius: 6px; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
            #qa-rv .rv-fact button:hover { background: rgba(255,255,255,0.18); color: #fff; }
            #qa-rv .rv-screen { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,0.5); }
            #qa-rv .rv-inner { overflow: hidden; position: relative; }
            #qa-rv .rv-screen iframe { border: 0; display: block; background: #fff; }
            #qa-rv .rv-grid { position: absolute; inset: 0; pointer-events: none; z-index: 3;
                background-image:
                    repeating-linear-gradient(to right, rgba(139,92,246,0.18) 0 1px, transparent 1px 20px),
                    repeating-linear-gradient(to bottom, rgba(139,92,246,0.18) 0 1px, transparent 1px 20px),
                    repeating-linear-gradient(to right, rgba(139,92,246,0.4) 0 1px, transparent 1px 100px),
                    repeating-linear-gradient(to bottom, rgba(139,92,246,0.4) 0 1px, transparent 1px 100px); }
            #qa-rv .rv-rt, #qa-rv .rv-rl { position: absolute; pointer-events: none; z-index: 4; background: rgba(15,15,23,0.82); color: #93c5fd; font: 9px/1 Consolas, monospace; }
            #qa-rv .rv-rt { top: 0; left: 0; right: 0; height: 14px; border-bottom: 1px solid rgba(255,255,255,0.15); }
            #qa-rv .rv-rl { top: 0; left: 0; bottom: 0; width: 22px; border-right: 1px solid rgba(255,255,255,0.15); }
            #qa-rv .rv-rt span { position: absolute; top: 2px; transform: translateX(2px); }
            #qa-rv .rv-rl span { position: absolute; left: 2px; }
            #qa-rv .rv-rt i, #qa-rv .rv-rl i { position: absolute; background: rgba(147,197,253,0.5); }
            #qa-rv .rv-rt i { top: 0; width: 1px; height: 5px; }
            #qa-rv .rv-rl i { left: 0; height: 1px; width: 5px; }
            #qa-rv .rv-screen.mock { background: #0b0b12; padding: 16px 9px; border-radius: 32px; box-shadow: 0 10px 34px rgba(0,0,0,0.6), inset 0 0 0 2px #2c2c3a; position: relative; }
            #qa-rv .rv-screen.mock .rv-inner { border-radius: 16px; }
            #qa-rv .rv-screen.mock::before { content:''; position:absolute; top:7px; left:50%; transform:translateX(-50%); width:46px; height:7px; background:#2c2c3a; border-radius:5px; }
            #qa-rv .rv-empty { color: #64748b; text-align: center; padding: 60px 20px; width: 100%; }
            /* Custom device dialog */
            #qa-rv .rv-dlg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 5; }
            #qa-rv .rv-dlg-box { background: #1a1a2e; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 18px; width: 300px; }
            #qa-rv .rv-dlg-box h4 { margin: 0 0 12px; font-size: 14px; }
            #qa-rv .rv-dlg-box label { display: block; font-size: 11px; color: #94a3b8; margin: 8px 0 3px; }
            #qa-rv .rv-dlg-box input { width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; color: #fff; padding: 8px; font-size: 13px; outline: none; }
            #qa-rv .rv-dlg-row { display: flex; gap: 8px; }
            #qa-rv .rv-dlg-btns { display: flex; gap: 8px; margin-top: 16px; }
            #qa-rv .rv-dlg-btns button { flex: 1; border: none; border-radius: 8px; padding: 9px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
            #qa-rv .rv-cd-item { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); border-radius: 7px; padding: 7px 10px; margin-bottom: 5px; font-size: 12.5px; }
            #qa-rv .rv-cd-item button { background: none; border: none; color: #64748b; cursor: pointer; font-size: 16px; }
            #qa-rv .rv-cd-item button:hover { color: #f87171; }
        </style>
        <div class="rv-bar">
            <span class="rv-brand">${RV_ICON.mobile} Responsive</span>
            <div class="rv-url"><input type="text" id="rv-url" spellcheck="false"><button class="rv-btn go" id="rv-go">Go</button></div>
            <button class="rv-btn" id="rv-reload" title="Reload all">${RV_ICON.reload}</button>
            <button class="rv-btn" id="rv-rotate" title="Rotate all">${RV_ICON.rotate} Rotate</button>
            <span class="rv-zoomwrap" title="Zoom %"><input type="number" id="rv-zoom" min="10" max="200" step="5"><b>%</b></span>
            <select class="rv-sel" id="rv-ua" title="User-Agent"><option value="desktop">UA: Desktop</option><option value="iphone">UA: iPhone</option><option value="android">UA: Android</option></select>
            <select class="rv-sel" id="rv-layout" title="Layout"><option value="row">Side by side</option><option value="stack">Stacked</option></select>
            <button class="rv-btn" id="rv-mockup" title="Device frame">Mockup</button>
            <button class="rv-btn" id="rv-sync" title="Sync scroll & clicks">${RV_ICON.link} Sync</button>
            <button class="rv-btn" id="rv-touch" title="Touch cursor">${RV_ICON.touch} Touch</button>
            <button class="rv-btn" id="rv-shot" title="Screenshot the whole view">${RV_ICON.camera}</button>
            <select class="rv-sel" id="rv-add" title="Add a device"><option value="">+ Add device</option></select>
            <button class="rv-btn close" id="rv-close" title="Close">${RV_ICON.close}</button>
        </div>
        <div class="rv-tabs" id="rv-tabs"></div>
        <div class="rv-iso" id="rv-iso">Isolation — showing one screen. <button class="rv-btn" id="rv-isoexit" style="margin-left:8px;padding:3px 9px;">Show all</button></div>
        <div class="rv-stage"><div class="rv-row" id="rv-row"></div></div>`;
    document.body.appendChild(o);

    o.querySelector('#rv-url').value = rvState.url;
    o.querySelector('#rv-zoom').value = Math.round(rvState.zoom * 100);
    o.querySelector('#rv-ua').value = rvState.ua;
    o.querySelector('#rv-layout').value = rvState.layout;
    o.querySelector('#rv-mockup').classList.toggle('on', rvState.mockup);
    o.querySelector('#rv-sync').classList.toggle('on', rvState.sync);
    o.querySelector('#rv-touch').classList.toggle('on', rvState.touch);
    rvFillAddMenu();
    rvRender();

    const reloadAll = () => o.querySelectorAll('.rv-screen iframe').forEach(f => { f.src = f.src; });
    o.querySelector('#rv-go').addEventListener('click', () => {
        let v = o.querySelector('#rv-url').value.trim(); if (!v) return;
        if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
        rvState.url = v; o.querySelector('#rv-url').value = v; rvRender();
    });
    o.querySelector('#rv-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') o.querySelector('#rv-go').click(); });
    o.querySelector('#rv-reload').addEventListener('click', reloadAll);
    o.querySelector('#rv-rotate').addEventListener('click', () => { rvActiveTab().screens.forEach(s => s.rotated = !s.rotated); rvSave(); rvRender(); });
    o.querySelector('#rv-zoom').addEventListener('change', (e) => {
        let pct = parseInt(e.target.value, 10); if (!pct) pct = 50;
        pct = Math.max(10, Math.min(200, pct)); e.target.value = pct;
        rvState.zoom = pct / 100; rvSave(); rvRender();
    });
    o.querySelector('#rv-ua').addEventListener('change', (e) => { rvState.ua = e.target.value; rvSave(); chrome.runtime.sendMessage({ action: 'responsiveDnr', enable: true, ua: rvState.ua }, () => setTimeout(reloadAll, 150)); });
    o.querySelector('#rv-layout').addEventListener('change', (e) => { rvState.layout = e.target.value; rvSave(); rvRender(); });
    o.querySelector('#rv-mockup').addEventListener('click', () => { rvState.mockup = !rvState.mockup; o.querySelector('#rv-mockup').classList.toggle('on', rvState.mockup); rvSave(); rvRender(); });
    o.querySelector('#rv-sync').addEventListener('click', () => { rvState.sync = !rvState.sync; o.querySelector('#rv-sync').classList.toggle('on', rvState.sync); rvSave(); });
    o.querySelector('#rv-touch').addEventListener('click', () => { rvState.touch = !rvState.touch; o.querySelector('#rv-touch').classList.toggle('on', rvState.touch); rvSave(); rvWireFrames(); });
    o.querySelector('#rv-add').addEventListener('change', (e) => {
        const v = e.target.value; e.target.value = '';
        if (v === '__custom') { rvCustomDialog(); return; }
        const d = rvLibrary().find(x => x.name === v);
        if (d) { rvActiveTab().screens.push({ id: rvState.nextScreen++, name: d.name, w: d.w, h: d.h, rotated: false }); rvSave(); rvRender(); }
    });
    o.querySelector('#rv-isoexit').addEventListener('click', () => { rvState.isolated = null; rvRender(); });
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
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        const frame = btn.closest('[data-id]'); const id = +frame.dataset.id;
        const tab = rvActiveTab();
        const s = tab.screens.find(x => x.id === id); if (!s) return;
        const act = btn.dataset.act;
        if (act === 'rotate') s.rotated = !s.rotated;
        else if (act === 'remove') { tab.screens = tab.screens.filter(x => x.id !== id); if (rvState.isolated === id) rvState.isolated = null; }
        else if (act === 'isolate') rvState.isolated = (rvState.isolated === id) ? null : id;
        else if (act === 'reload') { const f = frame.querySelector('iframe'); if (f) { f.src = f.src; return; } }
        else if (act === 'shot') {
            const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
            rvScreenshot(frame.querySelector('.rv-inner').getBoundingClientRect(), `${s.name}-${w}x${h}.png`); return;
        }
        rvSave(); rvRender();
    });
    // Edit dimensions inline (type "WxH")
    rvRow.addEventListener('keydown', (e) => { if (e.target.closest('.rv-fdim') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    rvRow.addEventListener('blur', (e) => {
        const dim = e.target.closest('.rv-fdim'); if (!dim) return;
        dim.contentEditable = 'false';
        const s = rvActiveTab().screens.find(x => x.id === +dim.closest('[data-id]').dataset.id);
        const m = (dim.textContent || '').match(/(\d{2,4})\s*[x×*,]\s*(\d{2,4})/i);
        if (s && m) { s.w = +m[1]; s.h = +m[2]; s.rotated = false; rvSave(); }
        rvRender();
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
        if (from >= 0 && to >= 0 && from !== to) { const [m] = screens.splice(from, 1); screens.splice(to, 0, m); rvSave(); rvRender(); }
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

function rvEsc(e) { if (e.key === 'Escape' && document.getElementById('qa-rv')) closeResponsiveOverlay(); }
function closeResponsiveOverlay() {
    const o = document.getElementById('qa-rv'); if (o) o.remove();
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

function rvRender() {
    const o = document.getElementById('qa-rv'); if (!o || !rvState) return;
    rvRenderTabs();
    const row = o.querySelector('#rv-row');
    row.classList.toggle('stack', rvState.layout === 'stack');
    o.querySelector('#rv-iso').style.display = rvState.isolated ? 'block' : 'none';
    const screens = rvActiveTab().screens;
    if (!screens.length) { row.innerHTML = '<div class="rv-empty">No devices in this tab — add one with "+ Add device".</div>'; return; }
    const shown = rvState.isolated ? screens.filter(s => s.id === rvState.isolated) : screens;
    const z = rvState.zoom;
    row.innerHTML = shown.map(s => {
        const w = s.rotated ? s.h : s.w, h = s.rotated ? s.w : s.h;
        const sw = Math.round(w * z), sh = Math.round(h * z);
        const outerW = Math.max(sw + (rvState.mockup ? 18 : 0), 150);
        return `<div data-id="${s.id}" style="flex-shrink:0; width:${outerW}px;">
            <div class="rv-fhead">
                <span class="rv-fname" draggable="true" title="Drag to reorder">${qaEsc(s.name)}</span>
                <span class="rv-fdim" title="Click to edit size">${w}×${h}</span>
                <span class="rv-fact">
                    <button data-act="shot" title="Screenshot">${RV_ICON.camera}</button>
                    <button data-act="isolate" title="Isolate">${RV_ICON.eye}</button>
                    <button data-act="rotate" title="Rotate">${RV_ICON.rotate}</button>
                    <button data-act="reload" title="Reload">${RV_ICON.reload}</button>
                    <button data-act="remove" title="Remove">${RV_ICON.close}</button>
                </span>
            </div>
            <div class="rv-screen ${rvState.mockup ? 'mock' : ''}">
                <div class="rv-inner" style="width:${sw}px;height:${sh}px;">
                    <iframe src="${encodeURI(rvState.url)}" style="width:${w}px;height:${h}px;transform:scale(${z});transform-origin:top left;"></iframe>
                    ${rvState.grid ? '<div class="rv-grid"></div>' : ''}
                    ${rvState.ruler ? rvRulerHtml(w, h, z) : ''}
                </div>
            </div>
        </div>`;
    }).join('');
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
function rvPath(el) {
    const p = []; const body = el.ownerDocument.body;
    while (el && el !== body && el.parentElement) { p.unshift(Array.prototype.indexOf.call(el.parentElement.children, el)); el = el.parentElement; }
    return p;
}
function rvResolve(doc, p) { let el = doc.body; for (const i of p) { if (!el) return null; el = el.children[i]; } return el; }
function rvApplyCursor(doc, on) {
    try {
        let st = doc.getElementById('rv-cursor-style');
        if (on) {
            if (!st) { st = doc.createElement('style'); st.id = 'rv-cursor-style'; doc.head.appendChild(st); }
            st.textContent = `*,*::before,*::after{cursor:${rvTouchCursorValue()} !important;}`;
        } else if (st) { st.remove(); }
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
            rvApplyCursor(doc, rvState.touch);
            rvApplyOutline(doc, rvState.outline);
            if (doc.__rvBound) return;
            doc.__rvBound = true;
            win.addEventListener('scroll', () => {
                if (!rvState.sync || rvSyncing) return;
                rvSyncing = true;
                const sx = win.scrollX, sy = win.scrollY;
                o.querySelectorAll('iframe').forEach(other => { if (other !== f) { try { other.contentWindow.scrollTo(sx, sy); } catch (e) { } } });
                requestAnimationFrame(() => { rvSyncing = false; });
            }, true);
            win.addEventListener('click', (e) => {
                if (!rvState.sync || rvClicking || !e.isTrusted) return;
                rvClicking = true;
                const path = rvPath(e.target);
                o.querySelectorAll('iframe').forEach(other => { if (other !== f) { try { const el = rvResolve(other.contentDocument, path); if (el) el.click(); } catch (e) { } } });
                setTimeout(() => { rvClicking = false; }, 80);
            }, true);
            win.addEventListener('input', (e) => {
                if (!rvState.sync || rvClicking || !e.isTrusted) return;
                const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
                rvClicking = true;
                const path = rvPath(t), val = t.value;
                o.querySelectorAll('iframe').forEach(other => { if (other !== f) { try { const el = rvResolve(other.contentDocument, path); if (el && 'value' in el) { el.value = val; el.dispatchEvent(new other.contentWindow.Event('input', { bubbles: true })); } } catch (e) { } } });
                setTimeout(() => { rvClicking = false; }, 40);
            }, true);
        };
        if (!f.__rvLoadBound) { f.__rvLoadBound = true; f.addEventListener('load', decorate); }
        decorate();
    });
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
}

const FFX_COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
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
                <button class="ffx-copy-icon" data-idx="${idx}" title="Copy">${FFX_COPY_SVG}</button>
            </div>
        </div>`;
    };

    body.addEventListener('click', (e) => {
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
            max-height: 400px;
            overflow-y: auto;
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
        // Standalone "AI Fill" option at the very top (independent of profiles)
        // === Tools group (page utilities) - shown first ===
        let menuHtml = `<div class="ff-menu-header">Tools</div>`;
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
        menuHtml += `<div class="ff-menu-list" style="max-height: 400px; overflow-y: auto;">`;

        const truncateName = (name) => {
            if (!name) return '';
            return name.length > 30 ? name.substring(0, 30) + '...' : name;
        };

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

    // Add FontAwesome if not exists
    if (!document.querySelector('link[href*="font-awesome"]')) {
        const fa = document.createElement('link');
        fa.rel = 'stylesheet';
        fa.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
        document.head.appendChild(fa);
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

    // Custom dropdowns (input[role="combobox"]): open the list, then click the
    // option whose text matches the value. With sequentialSelect, the choice
    // cycles through the options instead (random start, then in order).
    async function fillComboboxField(el, value, field) {
        try {
            el.focus();
            el.click();
            await new Promise(r => setTimeout(r, 400));

            const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            let listbox = listId ? document.getElementById(listId) : null;
            if (!listbox || !isElementVisible(listbox)) {
                const visible = Array.from(document.querySelectorAll('[role="listbox"]')).find(lb => isElementVisible(lb));
                if (visible) listbox = visible;
            }
            if (!listbox) return false;

            let options = Array.from(listbox.querySelectorAll('[role="option"]'));
            if (options.length === 0) options = Array.from(listbox.querySelectorAll('li'));
            options = options.filter(o => o.innerText && o.innerText.trim());
            if (options.length === 0) return false;

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

            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            target.click();
            await new Promise(r => setTimeout(r, 150));

            return true;
        } catch (e) {
            console.warn('Combobox fill failed:', e);
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
    const storageResult = await new Promise(resolve => chrome.storage.local.get([storageKey], resolve));
    const allIndices = storageResult[storageKey] || {};
    let updatedAny = false;

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
            if (el.tagName === 'INPUT' && el.getAttribute('role') === 'combobox') {
                const handled = await fillComboboxField(el, resolveSmartVariables(field.value), field);
                if (handled) continue;
                // Otherwise fall through to the normal value fill as a last resort
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
                    const digits = Math.min(field.digits || 5, 50);
                    let res = "";
                    for (let i = 0; i < digits; i++) res += Math.floor(Math.random() * 10).toString();
                    value = value + res;
                }
                else if (field.uniqueNumber) {
                    const digits = Math.min(field.digits || 5, 50);
                    let res = Math.floor(1 + Math.random() * 9).toString();
                    for (let i = 1; i < digits; i++) res += Math.floor(Math.random() * 10).toString();
                    value = res;
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

    if (updatedAny) chrome.storage.local.set({ [storageKey]: allIndices });

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

