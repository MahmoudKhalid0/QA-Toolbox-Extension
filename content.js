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
        (async () => { sendResponse(await scanPageFormFields()); })();
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
    if (request.action === 'contextFill') {
        // Respond immediately so the background knows the page received the
        // command (it retries with a fresh injection otherwise)
        sendResponse({ received: true });
        handleContextFill(request.mode);
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

// Floating Button Support
let matchingProfiles = [];
let fabAiFillEnabled = false; // show the standalone "AI Fill" option in the FAB
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
            // The AI-fill option depends on the floating button being enabled
            if (!settings || !settings.showFloatingButton) {
                cleanupFloatingButton();
                return;
            }
            fabAiFillEnabled = !!settings.floatingAiFill;

            chrome.runtime.sendMessage({ action: 'getMatchingProfiles', url: currentUrl }, (profRes) => {
                if (chrome.runtime.lastError) return;
                matchingProfiles = (profRes && profRes.profiles) || [];
                // Show the FAB when there are matching profiles, OR when AI fill is
                // enabled (then it shows on every page, even without a profile)
                if (matchingProfiles.length > 0 || fabAiFillEnabled) {
                    createFloatingButton();
                } else {
                    cleanupFloatingButton();
                }
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
        await new Promise(r => setTimeout(r, 350));
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
        await new Promise(r => setTimeout(r, 80));
        return opts;
    } catch (e) {
        return [];
    }
}

async function scanPageFormFields() {
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
            if (!field.options || field.options.length === 0) {
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
        if (!t || t === hl || t === badge || t === document.documentElement || t === document.body) {
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

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    inspectState = { hl, badge, onMove, onClick, onKey };
}

function stopInspectMode() {
    if (!inspectState) return;
    document.removeEventListener('mousemove', inspectState.onMove, true);
    document.removeEventListener('click', inspectState.onClick, true);
    document.removeEventListener('keydown', inspectState.onKey, true);
    inspectState.hl.remove();
    inspectState.badge.remove();
    inspectState = null;
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
        navigator.clipboard.writeText(text).then(() => {
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

// ==================== Right-click Fill (context menu) ====================
// Right-clicking an editable field offers: fill with valid data (AI) or
// invalid data (AI, for negative testing).

let lastContextTarget = null;
document.addEventListener('contextmenu', (e) => { lastContextTarget = e.target; }, true);

async function handleContextFill(mode) {
    const el = (lastContextTarget && document.contains(lastContextTarget)) ? lastContextTarget : document.activeElement;
    if (!el) return;
    if (!el.isContentEditable && !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;

    const info = collectContextFieldInfo(el);

    // Pulse the field while waiting for the AI value
    const stopPulse = startFieldPulse(el);
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
            console.warn('Context fill failed:', resp.error);
            flashElement(el, '#ef4444');
            return;
        }
        setContextFieldValue(el, resp.value);
        flashElement(el);
    } finally {
        stopPulse();
    }
}

function startFieldPulse(el) {
    const original = {
        outline: el.style.getPropertyValue('outline'),
        outlineOffset: el.style.getPropertyValue('outline-offset'),
        transition: el.style.transition
    };
    el.style.transition = 'outline-color 0.45s';
    // !important so the pulse beats the page's own focus/outline styles
    el.style.setProperty('outline', '3px dashed #6366f1', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
    let on = true;
    const iv = setInterval(() => {
        el.style.setProperty('outline-color', on ? '#c7d2fe' : '#6366f1', 'important');
        on = !on;
    }, 450);
    return () => {
        clearInterval(iv);
        el.style.setProperty('outline', original.outline);
        el.style.setProperty('outline-offset', original.outlineOffset);
        el.style.transition = original.transition;
    };
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
        navigator.clipboard.writeText(copyValues[+btn.dataset.idx] || '').then(() => {
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
            bottom: 25px;
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
            bottom: 95px;
            right: 30px;
            background: rgba(15, 15, 35, 0.95);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 8px;
            width: 280px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            z-index: 999999999;
            display: none;
            flex-direction: column;
            gap: 4px;
            animation: ff-slide-up 0.3s ease-out;
            max-height: 400px;
            overflow-y: auto;
        }
        @keyframes ff-slide-up {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .ff-menu-item {
            padding: 10px 14px;
            border-radius: 10px;
            color: #e0e0e0;
            font-family: 'Segoe UI', sans-serif;
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 12px;
            transition: all 0.2s;
        }
        .ff-menu-item:hover {
            background: rgba(102, 126, 234, 0.2);
            color: white;
        }
        .ff-menu-item i {
            color: #667eea;
            font-size: 16px;
        }
        .ff-menu-header {
            padding: 8px 14px;
            font-size: 11px;
            font-weight: bold;
            color: #667eea;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            margin-bottom: 4px;
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
            <i class="fas fa-bolt"></i>
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
        let menuHtml = '';
        if (fabAiFillEnabled) {
            menuHtml += `
                <div class="ff-menu-item" id="ff-menu-ai-fill" title="Let AI fill this form">
                    <i class="fas fa-wand-magic-sparkles" style="color:#a78bfa;"></i>
                    <span style="font-weight:600;">AI Fill this page</span>
                </div>
            `;
        }

        // The profiles section only appears when there are matching profiles
        if (matchingProfiles.length > 0) {
            if (fabAiFillEnabled) menuHtml += `<div style="height:1px; background:rgba(255,255,255,0.08); margin:6px 4px;"></div>`;
            menuHtml += `
                <div class="ff-menu-header">Matching Profiles</div>
                <div class="ff-search-container" style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
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

