// Background script for Form Filler
importScripts('db.js');
importScripts('config.js');

// Migration: Move profiles from sync/local storage to IndexedDB
(async () => {
    try {
        // First migrate from sync to local (for backwards compatibility)
        const syncResult = await chrome.storage.sync.get(['formFillerProfiles']);
        if (syncResult.formFillerProfiles && syncResult.formFillerProfiles.length > 0) {
            // Save temporary to local
            await chrome.storage.local.set({ formFillerProfiles: syncResult.formFillerProfiles });
            await chrome.storage.sync.remove('formFillerProfiles');
            console.log('Moved profiles from sync to local storage');
        }

        // Then migrate from local to IndexedDB
        const migrated = await FormFillerDB.migrateFromLocalStorage();
        if (migrated > 0) {
            console.log('Migration to IndexedDB complete:', migrated, 'profiles');
        }
    } catch (e) {
        console.error('Migration error:', e);
    }
})();

// In-memory recording state (replaces chrome.storage.sync for recording state)
let recordingState = {
    isRecording: false,
    appendToProfileId: null,
    isReplacementMode: false
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'openEditorWithFields') {
        (async () => {
            let appendToId = request.appendToProfileId;
            if (!appendToId) {
                const syncResult = await chrome.storage.sync.get(['appendToProfileId']);
                appendToId = syncResult.appendToProfileId;
            }

            console.log('=== openEditorWithFields ===');
            console.log('appendToProfileId:', appendToId);

            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }

            if (appendToId) {
                console.log('Searching for profile ID:', appendToId, 'Type:', typeof appendToId);
                console.log('Total profiles loaded:', profiles.length);
                if (profiles.length > 0) {
                    console.log('First profile ID example:', profiles[0].id, 'Type:', typeof profiles[0].id);
                }

                // Be robust with ID comparison (string vs number)
                const profileIndex = profiles.findIndex(p => {
                    const match = String(p.id) === String(appendToId);
                    if (match) console.log('MATCH FOUND at index', profiles.indexOf(p));
                    return match;
                });
                console.log('Profile index result:', profileIndex);

                if (profileIndex >= 0) {
                    console.log('SUCCESS: Profile found to append to:', profiles[profileIndex].name);
                    const existingSelectors = new Set(profiles[profileIndex].fields.map(f => f.selector));
                    const newFields = request.fields
                        .filter(f => !existingSelectors.has(f.selector))
                        .map(f => ({ ...f, uniqueText: false, uniqueNumber: false, digits: 5 }));

                    // Clear state immediately since we are processing
                    await chrome.storage.sync.remove(['appendToProfileId', 'isRecordingActive']);
                    await chrome.storage.local.remove(['currentAppendToProfileId', 'recordedFields', 'recordedUrl']);

                    if (newFields.length > 0) {
                        profiles[profileIndex].fields = [...profiles[profileIndex].fields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                        } catch (err) {
                            await chrome.storage.local.set({ formFillerProfiles: profiles });
                        }

                        chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${appendToId}`) });
                        sendResponse({ success: true, addedCount: newFields.length });
                    } else {
                        // No new fields were added
                        sendResponse({ success: true, noNewFields: true });
                    }
                    return;
                }
            }

            // If not appending or profile not found, handle as new profile
            await chrome.storage.local.set({
                pendingNewProfile: { fields: request.fields, url: request.url || '' }
            });
            chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
            sendResponse({ success: true });
        })();
        return true;
    }

    if (request.action === 'openNewProfileEditor') {
        chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
        return true;
    }

    if (request.action === 'openEditorPage') {
        chrome.tabs.create({ url: request.url });
        return true;
    }

    // Get profiles - for content.js to access IndexedDB
    if (request.action === 'getProfiles') {
        (async () => {
            try {
                const profiles = await FormFillerDB.getAllProfiles();
                sendResponse({ profiles: profiles });
            } catch (err) {
                const result = await chrome.storage.local.get(['formFillerProfiles']);
                sendResponse({ profiles: result.formFillerProfiles || [] });
            }
        })();
        return true;
    }

    // Save profiles - for content.js or editor.js
    if (request.action === 'saveProfiles') {
        (async () => {
            try {
                await FormFillerDB.saveAllProfiles(request.profiles);
                broadcastProfilesUpdated();
                sendResponse({ success: true });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // Get recording state for content.js on page load
    if (request.action === 'getRecordingState') {
        sendResponse({
            isRecording: recordingState.isRecording,
            appendToProfileId: recordingState.appendToProfileId,
            isReplacementMode: recordingState.isReplacementMode || false
        });
        return true;
    }

    // Handle stop recording from content.js - ALL LOGIC VIA INDEXEDDB
    if (request.action === 'handleStopRecording') {
        (async () => {
            const fields = request.fields;
            const appendToId = request.appendToProfileId;
            const url = request.url;

            console.log('=== handleStopRecording ===');
            console.log('Fields:', fields?.length, 'AppendTo:', appendToId);

            // Check if this is replacement mode (from state or request or storage)
            const storageData = await chrome.storage.local.get(['failedFields', 'profileIdForReplacement']);
            const failedFields = storageData.failedFields || [];
            const hasFailedFields = failedFields.length > 0;
            const profileIdMatches = hasFailedFields && storageData.profileIdForReplacement && String(storageData.profileIdForReplacement) === String(appendToId);
            const isReplacementMode = recordingState.isReplacementMode || request.isReplacementMode || profileIdMatches;

            console.log('Replacement mode check:', {
                isReplacementMode,
                hasFailedFields,
                profileIdMatches,
                failedFieldsCount: failedFields.length,
                appendToId,
                storedProfileId: storageData.profileIdForReplacement
            });

            // Clear recording state
            recordingState.isRecording = false;
            recordingState.appendToProfileId = null;
            recordingState.isReplacementMode = false;

            if (!fields || fields.length === 0) {
                sendResponse({ success: true, message: 'No fields' });
                return;
            }

            // Load profiles from IndexedDB
            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                console.error('Error loading profiles:', err);
                sendResponse({ success: false, error: err.message });
                return;
            }

            console.log('Profiles loaded:', profiles.length);

            if (appendToId) {
                // Find profile with String comparison
                const profileIndex = profiles.findIndex(p => String(p.id) === String(appendToId));
                console.log('Profile index:', profileIndex);

                if (profileIndex >= 0) {
                    if (isReplacementMode && failedFields.length > 0) {
                        // REPLACEMENT MODE: Only remove fields that have a "replacement" (matched by value)
                        console.log('Replacement mode: Checking replacements for', failedFields.length, 'failed fields');

                        // Determine which fields to remove (those that have a new field with the same value)
                        const newValues = new Set(fields.map(f => f.value));
                        const selectorsToRemove = failedFields
                            .filter(ff => newValues.has(ff.value))
                            .map(ff => ff.selector);

                        console.log('Selectors to remove (matched by value):', selectorsToRemove);

                        // Keep fields that are NOT in the removal list
                        const remainingFields = profiles[profileIndex].fields.filter(
                            f => !selectorsToRemove.includes(f.selector)
                        );

                        const existingSelectors = new Set(remainingFields.map(f => f.selector));

                        // Add ONLY new fields (that don't already exist in remaining)
                        const newFields = fields
                            .filter(f => !existingSelectors.has(f.selector))
                            .map(f => ({
                                ...f,
                                uniqueText: false,
                                uniqueNumber: false,
                                digits: 5
                            }));

                        profiles[profileIndex].fields = [...remainingFields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                            broadcastProfilesUpdated();
                            console.log('Saved smart-merged profile to IndexedDB');
                        } catch (err) {
                            console.error('Save error:', err);
                        }

                        // Clear failed fields from storage
                        await chrome.storage.local.remove(['failedFields', 'profileIdForReplacement']);

                        // Open editor with scroll to new fields (only if there are new fields)
                        if (newFields.length > 0) {
                            chrome.tabs.create({
                                url: chrome.runtime.getURL(`editor.html?id=${appendToId}&scrollToNew=true&newFieldsCount=${newFields.length}`)
                            });
                            sendResponse({ success: true, replacedCount: newFields.length });
                        } else {
                            sendResponse({ success: true, noNewFields: true });
                        }
                        return;
                    } else {
                        // NORMAL APPEND MODE: Just add new fields
                        // Get existing selectors
                        const existingSelectors = new Set(
                            profiles[profileIndex].fields.map(f => f.selector)
                        );

                        // Filter duplicates
                        const newFields = fields
                            .filter(f => !existingSelectors.has(f.selector))
                            .map(f => ({ ...f, uniqueText: false, uniqueNumber: false, digits: 5 }));

                        if (newFields.length === 0) {
                            console.log('No new fields to add');
                            sendResponse({ success: true, noNewFields: true });
                            return;
                        }

                        // Add fields and save
                        profiles[profileIndex].fields = [...profiles[profileIndex].fields, ...newFields];
                        profiles[profileIndex].lastModified = Date.now();

                        try {
                            await FormFillerDB.saveAllProfiles(profiles);
                            broadcastProfilesUpdated();
                            console.log('Saved to IndexedDB');
                        } catch (err) {
                            console.error('Save error:', err);
                        }

                        // Open editor
                        chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${appendToId}`) });
                        sendResponse({ success: true, addedCount: newFields.length });
                        return;
                    }
                }
            }

            // New profile - save pending fields
            await chrome.storage.local.set({ pendingNewProfile: { fields, url } });

            chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true&fromStorage=true') });
            sendResponse({ success: true, newProfile: true });
        })();
        return true;
    }

    if (request.action === 'getMatchingProfiles') {
        (async () => {
            const url = request.url;
            let profiles = [];
            try {
                await FormFillerDB.initDB();
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }
            // Smart Filter Logic: Use isUrlMatch helper (handles sub-paths, ports, query params)
            const matching = profiles.filter(p => {
                if (!p.url) return false;
                try {
                    return FormFillerDB.isUrlMatch(url, p.url);
                } catch (e) {
                    console.error('Matching error:', e);
                    return false;
                }
            });

            // Collect parent IDs of matching profiles to ensure structure remains
            const parentIds = new Set(matching.filter(p => p.parentProfileId).map(p => p.parentProfileId));

            // Add parents if they aren't already in the matching list
            parentIds.forEach(parentId => {
                if (!matching.some(p => String(p.id) === String(parentId))) {
                    const parent = profiles.find(p => String(p.id) === String(parentId));
                    if (parent) matching.push(parent);
                }
            });

            sendResponse({ profiles: matching });
        })();
        return true;
    }

    if (request.action === 'getSettings') {
        chrome.storage.sync.get(['formFillerSettings'], (result) => {
            const defaultSettings = { randomDigits: 5, showFloatingButton: true, autoClose: false };
            sendResponse({ settings: result.formFillerSettings || defaultSettings });
        });
        return true;
    }

    if (request.action === 'checkUrlMatch') {
        try {
            const matches = FormFillerDB.isUrlMatch(request.currentUrl, request.profileUrl);
            sendResponse({ matches });
        } catch (e) {
            sendResponse({ matches: false });
        }
        return true;
    }

    if (request.action === 'startRecordingForReplacement') {
        recordingState.isRecording = true;
        recordingState.appendToProfileId = request.profileId;
        recordingState.isReplacementMode = true; // Flag for replacement mode

        // Save to storage so popup can detect recording state
        chrome.storage.sync.set({
            appendToProfileId: request.profileId,
            isRecordingActive: true
        });

        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'fillProfile') {
        (async () => {
            const { profileId } = request;
            const tabId = sender.tab.id;
            let profiles = [];
            try {
                profiles = await FormFillerDB.getAllProfiles();
            } catch (err) {
                const localResult = await chrome.storage.local.get(['formFillerProfiles']);
                profiles = localResult.formFillerProfiles || [];
            }
            const profile = profiles.find(p => String(p.id) === String(profileId));
            if (profile) {
                const syncResult = await chrome.storage.sync.get(['formFillerSettings']);
                const settings = syncResult.formFillerSettings || { randomDigits: 5 };
                try {
                    // Use the content script's fill engine (the single up-to-date one,
                    // with richtext/checkbox/radio/combobox support) instead of injecting
                    // the legacy copy below. The sender IS the content script, so it exists.
                    await chrome.tabs.sendMessage(tabId, {
                        action: 'fillForm',
                        fields: profile.fields,
                        settings,
                        profileId: profile.id,
                        profileUrl: profile.url
                    });
                    sendResponse({ success: true });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            } else {
                sendResponse({ success: false, error: 'Profile not found' });
            }
        })();
        return true;
    }

    // AI Profile: scan the form on the tab, generate data via Claude, save the profile, and fill the form
    if (request.action === 'aiCreateProfile') {
        (async () => {
            try {
                const tabId = request.tabId;

                const apiKey = AI_CONFIG.apiKey;
                if (!apiKey) {
                    sendResponse({ success: false, error: 'no_api_key' });
                    return;
                }

                // Limit: max 5 profiles per exact URL (hash/trailing slash ignored).
                // Checked before scanning or calling the API - saves tokens when at the limit.
                const tab = await chrome.tabs.get(tabId);
                const normalizeUrl = (u) => String(u || '').split('#')[0].trim().replace(/\/+$/, '');
                const currentUrl = normalizeUrl(tab && tab.url);
                try {
                    const existingProfiles = await FormFillerDB.getAllProfiles();
                    const sameUrlCount = existingProfiles.filter(p => p && p.url && normalizeUrl(p.url) === currentUrl).length;
                    if (sameUrlCount >= 5) {
                        sendResponse({ success: false, error: 'profile_limit' });
                        return;
                    }
                } catch (e) { }

                const catResult = await chrome.storage.sync.get(['formFillerCategories']);
                let categories = catResult.formFillerCategories || [];
                if (categories.length === 0) categories = ['عام'];

                const settingsRes = await chrome.storage.sync.get(['formFillerSettings']);
                const settings = settingsRes.formFillerSettings || { randomDigits: 5 };

                const profileId = 'ai_' + Date.now();
                const allFields = [];
                const knownSelectors = new Set();
                let profileName = '';
                let aiCategory = '';
                let pageUrl = '';
                let sawAnyField = false;

                // Multi-pass: filling fields can reveal new conditional fields,
                // so re-scan after each fill and handle anything new (max 3 passes)
                for (let pass = 0; pass < 3; pass++) {
                    const scan = await chrome.tabs.sendMessage(tabId, { action: 'scanFormFields' });
                    if (!scan || !scan.fields) break;
                    if (!pageUrl) pageUrl = scan.url;
                    if (scan.fields.length > 0) sawAnyField = true;

                    // Only fields not handled in a previous pass, re-indexed for the AI
                    const newScanned = scan.fields
                        .filter(f => !knownSelectors.has(f.selector))
                        .map((f, i) => ({ ...f, index: i }));
                    if (newScanned.length === 0) break;
                    newScanned.forEach(f => knownSelectors.add(f.selector));

                    const ai = await generateProfileWithAI(apiKey, { ...scan, fields: newScanned }, categories, pass > 0);
                    if (!profileName) {
                        profileName = ai.profileName || 'AI Profile';
                        aiCategory = ai.category;
                    }

                    const passFields = mapAiValuesToFields(ai, newScanned);
                    if (passFields.length === 0) break;
                    allFields.push(...passFields);

                    // Fill this pass now - this is what triggers conditional fields to appear.
                    // profileUrl is empty on purpose: skips the URL check and the failed-fields modal.
                    try {
                        await chrome.tabs.sendMessage(tabId, {
                            action: 'fillForm',
                            fields: passFields,
                            settings,
                            profileId: profileId,
                            profileUrl: ''
                        });
                    } catch (fillErr) {
                        console.warn('AI fill failed:', fillErr);
                        break;
                    }

                    // Give the page a moment to render any conditional fields
                    await new Promise(r => setTimeout(r, 1200));
                }

                if (!sawAnyField) {
                    sendResponse({ success: false, error: 'no_fields' });
                    return;
                }
                if (allFields.length === 0) {
                    sendResponse({ success: false, error: 'no_values' });
                    return;
                }

                const profile = {
                    id: profileId,
                    name: profileName || 'AI Profile',
                    category: categories.includes(aiCategory) ? aiCategory : 'عام',
                    url: pageUrl,
                    fields: allFields,
                    onReload: false,
                    createdByAI: true,
                    lastModified: Date.now()
                };

                // Saving behavior: 'ask' (default) shows the on-page prompt,
                // 'always' saves silently, 'never' fills only and stays quiet
                const flagRes = await chrome.storage.local.get(['aiSaveBehavior', 'aiAutoSaveProfiles']);
                const behavior = flagRes.aiSaveBehavior || (flagRes.aiAutoSaveProfiles ? 'always' : 'ask');

                let saved = false;
                let prompted = false;
                if (behavior === 'always') {
                    // saveProfile upserts by id - updates the existing AI profile or adds a new one
                    await FormFillerDB.saveProfile(profile);
                    broadcastProfilesUpdated();
                    saved = true;
                } else if (behavior !== 'never') {
                    chrome.tabs.sendMessage(tabId, { action: 'showAiSavePrompt', profile }).catch(() => { });
                    prompted = true;
                }

                sendResponse({ success: true, saved, prompted, profileName: profile.name, fieldCount: allFields.length });
            } catch (e) {
                console.error('aiCreateProfile error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Save an AI-generated profile after the user confirmed via the on-page prompt
    if (request.action === 'saveAiProfile') {
        (async () => {
            try {
                // Upsert by id - updates an existing AI profile or adds a new one
                await FormFillerDB.saveProfile(request.profile);
                broadcastProfilesUpdated();

                if (request.dontAskAgain) {
                    await chrome.storage.local.set({ aiSaveBehavior: 'always' });
                }

                sendResponse({ success: true });
            } catch (e) {
                console.error('saveAiProfile error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Fill a rich text editor from the page's MAIN world. Editors like CKEditor 5
    // keep their content in a JS model that reverts direct DOM writes, and their
    // APIs (el.ckeditorInstance) are invisible to the content script's isolated world.
    if (request.action === 'fillRichText') {
        (async () => {
            try {
                const tabId = sender.tab.id;
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func: (selector, value) => {
                        const getEl = (sel) => {
                            try {
                                if (sel.startsWith('/') || sel.startsWith('(')) {
                                    const q = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                    return q.singleNodeValue;
                                }
                                return document.querySelector(sel);
                            } catch (e) { return null; }
                        };
                        const el = getEl(selector);
                        if (!el) return false;

                        // Plain text escaped as paragraphs, for editors that take HTML
                        const escHtml = String(value)
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .split('\n').filter(s => s.trim()).map(s => '<p>' + s + '</p>').join('');

                        // CKEditor 5: official API attached to the editable element
                        if (el.ckeditorInstance) {
                            el.ckeditorInstance.setData(escHtml || '<p></p>');
                            return true;
                        }

                        // Quill
                        const quillRoot = el.closest('.ql-container');
                        if (quillRoot && quillRoot.__quill) {
                            quillRoot.__quill.setText(String(value));
                            return true;
                        }

                        // TinyMCE (inline mode: the editable element's id is the editor id)
                        try {
                            if (window.tinymce && el.id && window.tinymce.get(el.id)) {
                                window.tinymce.get(el.id).setContent(escHtml || '');
                                return true;
                            }
                        } catch (e) { }

                        // CKEditor 4 (inline mode): match the instance whose editable is this element
                        try {
                            if (window.CKEDITOR && window.CKEDITOR.instances) {
                                for (const k in window.CKEDITOR.instances) {
                                    const inst = window.CKEDITOR.instances[k];
                                    const editable = inst && inst.editable && inst.editable();
                                    if (editable && editable.$ === el) {
                                        inst.setData(escHtml || '');
                                        return true;
                                    }
                                }
                            }
                        } catch (e) { }

                        // Generic contenteditable: type through the page's input pipeline
                        try {
                            el.focus();
                            const selObj = window.getSelection();
                            const range = document.createRange();
                            range.selectNodeContents(el);
                            selObj.removeAllRanges();
                            selObj.addRange(range);
                            const ok = document.execCommand('insertText', false, String(value));
                            if (!ok) {
                                el.textContent = String(value);
                                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
                            }
                            el.blur();
                            return true;
                        } catch (e) { return false; }
                    },
                    args: [request.selector, request.value]
                });
                sendResponse({ success: !!(results && results[0] && results[0].result) });
            } catch (e) {
                console.error('fillRichText error:', e);
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // Persist the user's AI saving preference ('ask' | 'always' | 'never')
    if (request.action === 'setAiSaveBehavior') {
        (async () => {
            await chrome.storage.local.set({ aiSaveBehavior: request.behavior });
            sendResponse({ success: true });
        })();
        return true;
    }

    return true;
});

// Convert AI-generated values into profile field objects (same shape as recorded
// profiles), normalizing select values so el.value assignment works.
function mapAiValuesToFields(ai, scannedFields) {
    const fields = [];
    for (const item of (ai.values || [])) {
        const scanned = scannedFields.find(f => f.index === item.index);
        if (!scanned || item.value === undefined || item.value === null || item.value === '') continue;

        let value = String(item.value);

        // Selects & radio groups: the AI sometimes returns the option's visible
        // text instead of its value attribute. Normalize to the real option value.
        if ((scanned.tag === 'select' || scanned.type === 'radio') && Array.isArray(scanned.options) && scanned.options.length > 0) {
            const wanted = value.trim().toLowerCase();
            const match =
                scanned.options.find(o => String(o.value).trim().toLowerCase() === wanted) ||
                scanned.options.find(o => String(o.text).trim().toLowerCase() === wanted) ||
                scanned.options.find(o => wanted.length > 1 && String(o.text).trim().toLowerCase().includes(wanted));
            if (match) {
                value = String(match.value);
            } else {
                // No matching option at all - pick the first real option instead of leaving it unselected
                value = String(scanned.options[0].value);
            }
        }

        // Selects, radio groups, and custom comboboxes use the Sequential feature:
        // first fill picks a RANDOM option, then each fill cycles to the next one
        const isChoiceField = scanned.tag === 'select' || scanned.type === 'radio' || scanned.type === 'combobox';

        fields.push({
            selector: scanned.selector,
            value: value,
            actionType: 'fill',
            type: scanned.type || 'text',
            uniqueText: false,
            uniqueNumber: false,
            sequentialSelect: isChoiceField,
            isSmartDate: false,
            dateDirection: 'future',
            dateFormat: 'DD/MM/YYYY',
            dateSeparator: '/',
            digits: 5
        });
    }
    return fields;
}

// Call the Claude API to generate test data for the scanned form fields.
// Uses structured outputs (json_schema) so the response is always valid JSON.
async function generateProfileWithAI(apiKey, scan, categories, isFollowUp = false) {
    const schema = {
        type: 'object',
        properties: {
            profileName: {
                type: 'string',
                description: 'Short descriptive profile name based on the site and form purpose'
            },
            category: { type: 'string', enum: categories },
            values: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'integer', description: 'The index of the form field this value belongs to' },
                        value: { type: 'string', description: 'The generated test value for this field' }
                    },
                    required: ['index', 'value'],
                    additionalProperties: false
                }
            }
        },
        required: ['profileName', 'category', 'values'],
        additionalProperties: false
    };

    const prompt = [
        'You are generating realistic fake test data for a form-filling browser extension.',
        'Analyze the page context and the form fields below, then generate an appropriate test value for every field.',
        ...(isFollowUp ? [
            '',
            'NOTE: These fields appeared dynamically AFTER earlier fields on the same form were filled (conditional fields). Generate values consistent with a single coherent test submission.'
        ] : []),
        '',
        'Rules:',
        '- Match the language and locale of the page (e.g. Arabic page -> Arabic names, matching phone formats).',
        '- Data must look realistic but be entirely fictional (fake emails, phone numbers, names).',
        '- For select fields, the value MUST be exactly one of the provided option "value" strings (never the display text, never a placeholder option like "Select...").',
        '- For checkbox fields, return "true" to check the box or "false" to leave it unchecked. Terms, conditions, consent, and agreement checkboxes must be "true".',
        '- For radio fields, the value MUST be exactly one of the provided option "value" strings (pick the most sensible choice for a test submission).',
        '- For combobox fields (custom dropdowns), return the visible TEXT of the option to choose. If options are provided pick one exactly; if not, return a short plausible choice based on the field label and the extension will pick the closest match.',
        '- For richtext fields (rich text editors), write 2-4 sentences of realistic PLAIN text (no HTML, no markdown) matching the field label and the page language.',
        '- Respect maxLength and the input type: email -> valid email format, tel -> phone number, number -> digits only, date -> YYYY-MM-DD, password -> strong password.',
        '- If there are password and confirm-password fields, use the same password for both.',
        '- Return one entry per field index. Skip a field only if no sensible value exists for it.',
        '- profileName: short descriptive name based on the site and form purpose.',
        '- category: pick the most fitting category from the allowed list.',
        '',
        `Page context: ${JSON.stringify(scan.pageContext)}`,
        `Page URL: ${scan.url}`,
        '',
        `Form fields: ${JSON.stringify(scan.fields)}`
    ].join('\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: AI_CONFIG.model,
            max_tokens: 8192,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) {
        let message = `Claude API error (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error && err.error.message) message = err.error.message;
        } catch (e) { }
        throw new Error(message);
    }

    const data = await response.json();
    if (data.stop_reason === 'refusal') {
        throw new Error('The AI declined to process this request');
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
        throw new Error('Empty AI response');
    }

    return JSON.parse(textBlock.text);
}

function broadcastProfilesUpdated() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && !tab.url.startsWith('chrome://')) {
                chrome.tabs.sendMessage(tab.id, { action: 'recheckFloatingButton' }).catch(() => { });
            }
        });
    });
}

// Auto-fill logic for "On Reload"
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        // Load profiles from IndexedDB
        let profiles = [];
        try {
            profiles = await FormFillerDB.getAllProfiles();
        } catch (err) {
            const localResult = await chrome.storage.local.get(['formFillerProfiles']);
            profiles = localResult.formFillerProfiles || [];
        }

        const match = profiles.find(p => {
            if (!p.url || !p.onReload || !p.fields || p.fields.length === 0) return false;
            try {
                return FormFillerDB.isUrlMatch(tab.url, p.url);
            } catch (e) {
                return false;
            }
        });

        if (match) {
            const settingsRes = await chrome.storage.sync.get(['formFillerSettings']);
            const settings = settingsRes.formFillerSettings || { randomDigits: 5 };

            // Wait 1 second for dynamic content to load
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, {
                    action: 'fillForm',
                    fields: match.fields,
                    settings,
                    profileId: match.id,
                    profileUrl: match.url
                }).catch(() => { });
            }, 1000);
        }
    }
});

// FAB Reactivity: Listen for tab updates (URL changes or full reloads)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Notify on URL change or completion to catch dynamic changes faster
    if ((changeInfo.url || changeInfo.status === 'complete') && tab.url && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tabId, { action: 'recheckFloatingButton' }).catch(() => { });
    }
});

// Support for Single Page Applications (SPAs) that use history API
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
    if (details.url && !details.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(details.tabId, { action: 'recheckFloatingButton' }).catch(() => { });
    }
});

/** 
 * Helper functions for form filling. 
 * These must be duplicated here because they are injected into the page scope.
 */
async function fillFormFields(fieldsData) {
    const { fields, settings, profileId } = fieldsData;

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
        for (const el of elements) {
            if (el.offsetParent === null) continue;

            if (action === 'click') {
                el.click();
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

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
                    let currentIndex = allIndices[key] !== undefined ? allIndices[key] : -1;
                    let nextIndex = (currentIndex + 1) % options.length;
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

            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if (updatedAny) chrome.storage.local.set({ [storageKey]: allIndices });
}
