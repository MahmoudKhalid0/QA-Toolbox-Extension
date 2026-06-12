// Content script for recording form fills
let isRecording = false;
let recordedFields = [];
let mutationObserver = null;
let currentAppendToProfileId = null;  // Store appendToProfileId locally
let recordedElementMap = new WeakMap(); // Map elements to their index in recordedFields
let lastCapture = { time: 0, value: '', element: null }; // For temporal deduplication
let lastComboboxInput = null; // Last custom dropdown (input[role="combobox"]) the user opened

// Check with background if recording should be active on page load
chrome.runtime.sendMessage({ action: 'getRecordingState' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.isRecording) {
        currentAppendToProfileId = response.appendToProfileId || null;
        console.log('Resuming recording, appendToProfileId:', currentAppendToProfileId);
        startRecording();
    }
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
        sendResponse(scanPageFormFields());
    }
    if (request.action === 'showAiSavePrompt') {
        showAiSavePromptModal(request.profile);
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
            if (response && response.settings && response.settings.showFloatingButton) {
                chrome.runtime.sendMessage({ action: 'getMatchingProfiles', url: currentUrl }, (profRes) => {
                    if (chrome.runtime.lastError) return;
                    if (profRes && profRes.profiles && profRes.profiles.length > 0) {
                        matchingProfiles = profRes.profiles;
                        createFloatingButton();
                    } else {
                        cleanupFloatingButton();
                    }
                });
            } else {
                cleanupFloatingButton();
            }
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
    return recordedFields;
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
function scanPageFormFields() {
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

        // Custom dropdowns: try to read the options from the linked listbox (it may
        // not be in the DOM until the dropdown is opened - that's handled at fill time)
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

        if (fields.length === 0) {
            console.log('No fields recorded');
            hideRecordingIndicator();
            return;
        }

        // Send everything to background - it will handle all logic via IndexedDB
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

function flashElement(element) {
    const original = {
        outline: element.style.outline,
        outlineOffset: element.style.outlineOffset,
        transition: element.style.transition
    };

    element.style.transition = 'all 0.2s';
    element.style.outline = '3px solid #10b981';
    element.style.outlineOffset = '2px';

    setTimeout(() => {
        element.style.outline = original.outline;
        element.style.outlineOffset = original.outlineOffset;
        element.style.transition = original.transition;
    }, 600);
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
            const item = e.target.closest('.ff-menu-item');
            if (item && !item.classList.contains('no-click')) {
                const profileId = item.dataset.id;
                const profile = matchingProfiles.find(p => String(p.id) === String(profileId));
                if (profile) {
                    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
                        const settings = (response && response.settings) ? response.settings : { randomDigits: 5 };
                        fillFormFields({ fields: profile.fields, settings, profileId: profile.id, profileUrl: profile.url }).then(() => {
                            menu.style.display = 'none';
                        });
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
        let menuHtml = `
            <div class="ff-menu-header">Matching Profiles</div>
            <div class="ff-search-container" style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div style="position:relative;">
                    <i class="fas fa-search" style="position:absolute; left:10px; top:50%; transform:translateY(-50%); font-size:12px; color:#666;"></i>
                    <input type="text" id="ff-menu-search" placeholder="Search profiles..." 
                        style="width:100%; padding:8px 8px 8px 30px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:white; font-size:12px; outline:none;" 
                        value="${filter}">
                </div>
            </div>
            <div class="ff-menu-list" style="max-height: 400px; overflow-y: auto;">
        `;

        const truncateName = (name) => {
            if (!name) return '';
            return name.length > 30 ? name.substring(0, 30) + '...' : name;
        };

        const filteredProfiles = matchingProfiles.filter(p =>
            p.name.toLowerCase().includes(filter.toLowerCase()) ||
            (p.category && p.category.toLowerCase().includes(filter.toLowerCase()))
        );

        if (filteredProfiles.length === 0) {
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
            console.error('Selector error:', selector, e);
            return [];
        }
    }

    function isElementVisible(el) {
        if (!el) return false;
        // Elements with position: fixed have offsetParent === null but are visible.
        // offsetWidth/Height check + getClientRects is more robust.
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
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
                <h2 class="ff-modal-title">Selector(s) mismatch detected.</h2>
                <p class="ff-modal-subtitle">Some fields could not be located because their selectors have changed.</p>
            </div>
            <div class="ff-modal-body">
                <p class="ff-modal-explanation">
                    Can't locate the following fields:
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
                    Please re-record the form to update these selectors.
                </p>
            </div>
            <div class="ff-modal-actions">
                <button class="ff-action-btn ff-btn-register" id="ff-btn-register">
                    <i class="fas fa-circle"></i>
                    <span>Re-record Fields</span>
                </button>
                <button class="ff-action-btn ff-btn-close" id="ff-btn-close-alert">
                    Close
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

