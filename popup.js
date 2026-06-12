let profiles = [];
let currentFields = [];
let isRecording = false;
let appendToId = null;
let expandedCategories = new Set();
let availableCategories = []; // Global list of category names
let userExpandedCategories = new Set(); // To remember state before search
let currentTabUrl = '';
let smartFilterActive = true;

// Load profiles
document.addEventListener('DOMContentLoaded', async () => {
    // Get current tab URL for smart filtering
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tabs[0]?.url || '';

    await loadProfiles();
    await loadCategories();

    // Settings Button - Open separate tab
    document.getElementById('settingsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'settings.html' });
    });

    // Smart Filter "Show All"
    document.getElementById('showAllBtn').addEventListener('click', () => {
        smartFilterActive = false;
        renderProfiles();
    });

    // Check if already recording - first from storage, then from content script
    const storageResult = await chrome.storage.sync.get(['appendToProfileId', 'isRecordingActive']);
    appendToId = storageResult.appendToProfileId || null;
    isRecording = storageResult.isRecordingActive || false;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // First check storage for recording state
    if (storageResult.isRecordingActive) {
        isRecording = true;
        updateRecordButton();
    } else {
        // Then try to get status from content script
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getRecordingStatus' });
            if (response && response.isRecording) {
                isRecording = true;
                updateRecordButton();
            } else {
                // Not recording, clean up
                if (appendToId) {
                    await chrome.storage.sync.remove('appendToProfileId');
                    appendToId = null;
                }
                isRecording = false;
                updateRecordButton();
            }
        } catch (e) {
            // Content script not available - check storage to determine state
            if (storageResult.isRecordingActive) {
                isRecording = true;
                updateRecordButton();
            } else {
                // Clean up stale state
                if (appendToId) {
                    await chrome.storage.sync.remove('appendToProfileId');
                    appendToId = null;
                }
                isRecording = false;
            }
        }
    }

    renderProfiles();

    // Search input handler
    document.getElementById('searchInput').addEventListener('input', () => {
        renderProfiles();
    });

    // Category filter handler
    document.getElementById('categoryFilter').addEventListener('change', () => {
        renderProfiles();
    });
});

// Record button
document.getElementById('recordBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first to record', 'error');
        return;
    }

    if (!isRecording) {
        // Limit: max 5 profiles per exact URL - block before recording even starts
        try {
            const normalizeUrl = (u) => String(u || '').split('#')[0].trim().replace(/\/+$/, '');
            const currentUrl = normalizeUrl(tab.url);
            const sameUrlCount = (profiles || []).filter(p => p && p.url && normalizeUrl(p.url) === currentUrl).length;
            if (sameUrlCount >= 5) {
                showToastMessage('Limit reached: 5 profiles already exist for this page', 'error');
                return;
            }
        } catch (e) { }

        try {
            appendToId = null;
            await chrome.storage.sync.remove('appendToProfileId');
            await chrome.storage.sync.set({ isRecordingActive: true });

            await chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
            isRecording = true;
            updateRecordButton();
            renderProfiles();
            window.close();
        } catch (e) {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            setTimeout(async () => {
                appendToId = null;
                await chrome.storage.sync.remove('appendToProfileId');
                await chrome.storage.sync.set({ isRecordingActive: true });
                await chrome.tabs.sendMessage(tab.id, { action: 'startRecording' });
                isRecording = true;
                renderProfiles();
                window.close();
            }, 100);
        }
    } else {
        // Try to stop recording
        let fields = null;
        let recordedUrl = '';

        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'stopRecording' });
            if (response && response.fields) {
                fields = response.fields;
                recordedUrl = response.url || '';
            }
        } catch (e) {
            // Content script not available - try to get fields from storage
            console.log('Content script not available, checking storage...');
            try {
                const storageData = await chrome.storage.local.get(['recordedFields', 'recordedUrl']);
                if (storageData.recordedFields && storageData.recordedFields.length > 0) {
                    fields = storageData.recordedFields;
                    recordedUrl = storageData.recordedUrl || '';
                }
            } catch (storageErr) {
                console.log('Storage check failed:', storageErr);
            }
        }

        // Clean up recording state
        isRecording = false;
        updateRecordButton();

        // Get appendToProfileId before removing it
        const result = await chrome.storage.sync.get(['appendToProfileId']);
        const activeAppendId = appendToId || result.appendToProfileId;

        // Check if there are failed field selectors (replacement mode)
        const storageData = await chrome.storage.local.get(['failedFieldSelectors']);
        const hasFailedSelectors = storageData.failedFieldSelectors && storageData.failedFieldSelectors.length > 0;

        if (fields && fields.length > 0) {
            // Send to background to handle (supports replacement mode)
            chrome.runtime.sendMessage({
                action: 'handleStopRecording',
                fields: fields,
                url: recordedUrl,
                appendToProfileId: activeAppendId,
                isReplacementMode: hasFailedSelectors && activeAppendId ? true : false
            }, async (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Background error:', chrome.runtime.lastError);
                    showToastMessage('Error saving fields', 'error');
                } else {
                    if (response && response.success) {
                        if (activeAppendId && response.replacedCount !== undefined) {
                            showToastMessage(`Replaced ${response.replacedCount} field(s)`, 'success');
                        } else if (activeAppendId && response.addedCount !== undefined) {
                            showToastMessage(`Added ${response.addedCount} new field(s)`, 'success');
                        } else if (response.noNewFields) {
                            showToastMessage('No new fields to add', 'error');
                        } else if (response.newProfile) {
                            showToastMessage('New profile created', 'success');
                        }
                    }
                }

                // Clean up
                await chrome.storage.sync.remove(['isRecordingActive', 'appendToProfileId']);
                await chrome.storage.local.remove(['recordedFields', 'recordedUrl', 'failedFieldSelectors', 'profileIdForReplacement']);
                appendToId = null;
                renderProfiles();
            });
        } else {
            showToastMessage('No fields recorded', 'error');
            await chrome.storage.sync.remove(['isRecordingActive', 'appendToProfileId']);
            await chrome.storage.local.remove(['recordedFields', 'recordedUrl', 'failedFieldSelectors', 'profileIdForReplacement']);
            appendToId = null;
            renderProfiles();
        }
    }
});

function updateRecordButton() {
    const btn = document.getElementById('recordBtn');
    if (isRecording) {
        btn.innerHTML = '<i class="fas fa-stop"></i>';
        btn.title = 'Stop Recording';
        btn.classList.add('recording');
    } else {
        btn.innerHTML = '<i class="fas fa-circle"></i>';
        btn.title = 'Record Form';
        btn.classList.remove('recording');
    }
}

document.getElementById('addBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?new=true') });
});

// AI Create Profile button - scans the form, generates data via Claude, saves and fills
document.getElementById('aiBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        showToastMessage('Open a website first', 'error');
        return;
    }

    const btn = document.getElementById('aiBtn');
    btn.classList.add('loading');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner"></i>';
    showToastMessage('AI is analyzing the form...', 'success');

    // Make sure the content script is available on the page
    try {
        await chrome.tabs.sendMessage(tab.id, { action: 'getRecordingStatus' });
    } catch (e) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    chrome.runtime.sendMessage({ action: 'aiCreateProfile', tabId: tab.id }, async (response) => {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>';

        if (chrome.runtime.lastError || !response) {
            showToastMessage('AI profile failed: ' + (chrome.runtime.lastError?.message || 'no response'), 'error');
            return;
        }

        if (response.success) {
            await loadProfiles();
            renderProfiles();
            if (response.saved) {
                showToastMessage(`"${truncateName(response.profileName)}" created & filled (${response.fieldCount} fields)`, 'success');
            } else if (response.prompted) {
                showToastMessage(`Form filled (${response.fieldCount} fields) — confirm saving on the page`, 'success');
            } else {
                showToastMessage(`Form filled (${response.fieldCount} fields)`, 'success');
            }
        } else {
            const messages = {
                no_api_key: 'AI is not configured in this build of the extension',
                no_fields: 'No form fields found on this page',
                no_values: 'AI could not generate values for this form',
                profile_limit: 'Limit reached: 5 profiles already exist for this page',
                // Legacy code from an older service worker (cleared by reloading the extension)
                profile_exists: 'A profile for this page already exists'
            };
            showToastMessage(messages[response.error] || ('AI failed: ' + (response.error || 'unknown error') + ' — try reloading the extension'), 'error');
        }
    });
});

async function loadProfiles() {
    try {
        // Try to migrate from local storage first
        await FormFillerDB.migrateFromLocalStorage();
        // Load from IndexedDB
        profiles = await FormFillerDB.getAllProfiles();
    } catch (err) {
        console.error('Error loading profiles:', err);
        // Fallback to local storage
        const result = await chrome.storage.local.get(['formFillerProfiles']);
        profiles = result.formFillerProfiles || [];
    }
}

async function saveProfiles() {
    try {
        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'saveProfiles', profiles }, (response) => {
                if (response && response.success) resolve();
                else reject(new Error(response?.error || 'Failed to save profiles'));
            });
        });
    } catch (err) {
        console.error('Error saving profiles:', err);
        // Fallback to local storage
        await chrome.storage.local.set({ formFillerProfiles: profiles });
    }
}

async function loadCategories() {
    const result = await chrome.storage.sync.get(['formFillerCategories']);
    availableCategories = result.formFillerCategories || [];
}


function renderProfiles() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const categoryFilter = document.getElementById('categoryFilter').value;
    const container = document.getElementById('profilesList');
    const banner = document.getElementById('smartFilterBanner');
    const bannerText = document.getElementById('smartFilterText');

    profiles.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

    // 1. URL-Aware Filtering Logic
    let matchingProfiles = [];
    if (currentTabUrl) {
        let matching = profiles.filter(p => {
            if (!p.url) return false;
            try {
                return FormFillerDB.isUrlMatch(currentTabUrl, p.url);
            } catch (e) {
                return currentTabUrl.startsWith(p.url);
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

        matchingProfiles = matching;
    }

    let isFilteringSmartly = smartFilterActive && matchingProfiles.length > 0 && !searchTerm && categoryFilter === 'all';

    if (isFilteringSmartly) {
        banner.classList.add('active');
        bannerText.textContent = `Showing ${matchingProfiles.length} profile${matchingProfiles.length > 1 ? 's' : ''} for this page`;
    } else {
        banner.classList.remove('active');
    }

    let baseProfiles = isFilteringSmartly ? matchingProfiles : profiles;

    let filteredProfiles = baseProfiles.filter(p => {
        const nameMatch = p.name.toLowerCase().includes(searchTerm);
        const categoryMatch = categoryFilter === 'all' || p.category === categoryFilter;
        return nameMatch && categoryMatch;
    });

    const categorySelect = document.getElementById('categoryFilter');
    const currentSelection = categorySelect.value;
    categorySelect.innerHTML = '<option value="all">All Categories</option>' +
        availableCategories.sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    categorySelect.value = availableCategories.includes(currentSelection) ? currentSelection : 'all';

    if (profiles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-user-plus"></i></div>
                <h3>No profiles yet</h3>
                <p>Press the red button to record a form,<br>or click + to add manually.</p>
            </div>
        `;
        return;
    }

    if (filteredProfiles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fas fa-search"></i></div>
                <h3>No results</h3>
                <p>No profiles match your search</p>
            </div>
        `;
        return;
    }

    const groups = {};
    filteredProfiles.forEach(p => {
        const cat = p.category || 'General';
        if (!groups[cat]) groups[cat] = { profiles: [], lastModified: 0 };
        groups[cat].profiles.push(p);
        groups[cat].lastModified = Math.max(groups[cat].lastModified, p.lastModified || 0);
    });

    const sortedCategories = Object.keys(groups).sort((a, b) => groups[b].lastModified - groups[a].lastModified);

    // Accordion Logic
    if (searchTerm || categoryFilter !== 'all' || isFilteringSmartly) {
        // Expand all categories when searching, filtering by category, or in Smart Mode
        expandedCategories = new Set(sortedCategories);
    } else {
        if (userExpandedCategories.size > 0) {
            expandedCategories = new Set(userExpandedCategories);
        } else if (expandedCategories.size === 0 && sortedCategories.length > 0) {
            expandedCategories.add(sortedCategories[0]);
            userExpandedCategories.add(sortedCategories[0]);
        }
    }

    container.innerHTML = sortedCategories.map(catName => {
        const group = groups[catName];
        const isExpanded = expandedCategories.has(catName);

        // Separate parent profiles (no parent) and sub-profiles
        const parentProfiles = group.profiles.filter(p => !p.parentProfileId);
        const subProfiles = group.profiles.filter(p => p.parentProfileId);

        // Build hierarchical structure
        const renderHierarchy = () => {
            let html = '';
            parentProfiles.forEach(parent => {
                // Render parent profile
                html += renderProfileCard(parent);

                // Find and render children of this parent
                const children = subProfiles.filter(sp => sp.parentProfileId === parent.id);
                if (children.length > 0) {
                    html += `<div class="sub-profiles-container" style="margin-left: 20px; border-left: 2px solid rgba(102, 126, 234, 0.3); padding-left: 12px;">`;
                    children.forEach(child => {
                        html += renderProfileCard(child, true);
                    });
                    html += `</div>`;
                }
            });

            // Render orphan sub-profiles (parent deleted or not in this category)
            const orphanSubProfiles = subProfiles.filter(sp => !parentProfiles.find(p => p.id === sp.parentProfileId));
            orphanSubProfiles.forEach(orphan => {
                html += renderProfileCard(orphan, true);
            });

            return html;
        };

        return `
            <div class="category-group ${isExpanded ? 'expanded' : ''}" data-category="${escapeHtml(catName)}">
                <div class="category-header">
                    <div class="category-title-container">
                        <div class="category-icon"><i class="fas fa-folder"></i></div>
                        <span class="category-title">${escapeHtml(catName)}</span>
                        <span class="category-count">${group.profiles.length}</span>
                    </div>
                    <i class="fas fa-chevron-down category-chevron"></i>
                </div>
                <div class="category-content">
                    ${renderHierarchy()}
                </div>
            </div>
        `;
    }).join('');

    attachProfileListeners(container);

    container.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('click', () => {
            const group = header.closest('.category-group');
            const catName = group.dataset.category;

            if (searchTerm) {
                if (expandedCategories.has(catName)) {
                    expandedCategories.delete(catName);
                    group.classList.remove('expanded');
                } else {
                    expandedCategories.add(catName);
                    group.classList.add('expanded');
                }
                return;
            }

            if (expandedCategories.has(catName)) {
                expandedCategories.clear();
                userExpandedCategories.clear();
                group.classList.remove('expanded');
            } else {
                // Collapse current and expand new manually to avoid full re-render jump
                container.querySelectorAll('.category-group').forEach(g => {
                    g.classList.remove('expanded');
                });

                expandedCategories.clear();
                userExpandedCategories.clear();

                expandedCategories.add(catName);
                userExpandedCategories.add(catName);
                group.classList.add('expanded');
            }
        });
    });
}

function truncateName(name, maxLength = 20) {
    if (!name) return '';
    return name.length > maxLength ? name.substring(0, maxLength) + '...' : name;
}

function renderProfileCard(profile, isSubProfile = false) {
    const isThisRecording = isRecording && appendToId === profile.id;
    const isOtherRecording = isRecording && appendToId !== profile.id && appendToId !== null;
    const isGeneralRecording = isRecording && appendToId === null;

    // Find parent profile name if this is a sub-profile
    let parentName = '';
    if (profile.parentProfileId) {
        const parent = profiles.find(p => p.id === profile.parentProfileId);
        parentName = parent ? parent.name : '';
    }

    const subProfileStyle = isSubProfile ? 'background: linear-gradient(135deg, #1a1a2e 0%, #1e2945 100%); border-left: 3px solid #667eea;' : '';
    const avatarStyle = isSubProfile
        ? 'width:28px;height:28px;background:linear-gradient(135deg,#764ba2 0%,#667eea 100%);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:white;'
        : 'width:36px;height:36px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:white;';

    return `
        <div class="profile-card ${isThisRecording ? 'recording-active' : ''} ${isSubProfile ? 'sub-profile-card' : ''}" style="padding:${isSubProfile ? '12px' : '16px'}; opacity: ${isOtherRecording || isGeneralRecording ? '0.6' : '1'}; ${subProfileStyle}">
            <div class="profile-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${isSubProfile ? '10px' : '14px'};">
                <div style="display:flex;align-items:center;gap:${isSubProfile ? '8px' : '12px'};">
                    ${isSubProfile ? '<i class="fas fa-level-up-alt" style="color:#667eea;font-size:10px;transform:rotate(90deg);margin-right:4px;"></i>' : ''}
                    <div class="profile-avatar" style="${avatarStyle}">${(profile.name || '?').charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="profile-name" title="${escapeHtml(profile.name)}" style="font-size:${isSubProfile ? '13px' : '14px'};font-weight:600;color:white;">${escapeHtml(truncateName(profile.name))}</div>
                        ${isSubProfile && parentName ? `<div title="${escapeHtml(parentName)}" style="font-size:10px;color:#667eea;margin-top:2px;"><i class="fas fa-link" style="margin-right:4px;"></i>تابع لـ: ${escapeHtml(truncateName(parentName))}</div>` : ''}
                    </div>
                </div>
                <div class="profile-meta" style="font-size:${isSubProfile ? '10px' : '11px'};color:#666;background:rgba(255,255,255,0.03);padding:3px 8px;border-radius:6px;">${profile.fields?.length || 0} fields</div>
            </div>
            <div class="profile-actions" style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">
                <div class="toggle-container" title="Auto-fill form on page reload" style="padding: 3px 8px; font-size: 10px;">
                    <span>On Reload</span>
                    <label class="switch" style="transform: scale(${isSubProfile ? '0.75' : '0.85'});">
                        <input type="checkbox" class="on-reload-toggle" data-id="${profile.id}" ${profile.onReload ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                </div>
                <button class="action-btn btn-fill" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="height:${isSubProfile ? '28px' : '32px'}; font-size:${isSubProfile ? '10px' : '11px'}; padding:0 ${isSubProfile ? '10px' : '12px'};">
                    <i class="fas fa-magic"></i> Fill
                </button>
                <button class="action-btn btn-record-more ${isThisRecording ? 'active' : ''}" data-id="${profile.id}" title="${isThisRecording ? 'Stop Recording' : 'Record More Fields'}" ${isOtherRecording || isGeneralRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas ${isThisRecording ? 'fa-stop' : 'fa-circle'}"></i>
                </button>
                <button class="action-btn btn-edit" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas fa-pen"></i>
                </button>
                <button class="action-btn btn-delete" data-id="${profile.id}" ${isRecording ? 'disabled' : ''} style="width:${isSubProfile ? '28px' : '32px'}; height:${isSubProfile ? '28px' : '32px'};">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

function attachProfileListeners(container) {
    container.querySelectorAll('.on-reload-toggle').forEach(chk => {
        chk.addEventListener('change', async () => {
            const index = profiles.findIndex(p => p.id === chk.dataset.id);
            if (index >= 0) {
                profiles[index].onReload = chk.checked;
                await saveProfiles();
            }
        });
    });

    container.querySelectorAll('.btn-record-more').forEach(btn => {
        btn.addEventListener('click', async () => {
            const profileId = btn.dataset.id;
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // If already recording for this profile, trigger stop
            if (isRecording && appendToId === profileId) {
                document.getElementById('recordBtn').click();
                return;
            }

            // Find the profile to get its fields and URL
            const profile = profiles.find(p => String(p.id) === String(profileId));
            if (!profile) {
                showToastMessage('Profile not found', 'error');
                return;
            }

            console.log('Starting recording for profile:', profileId, 'Fields count:', profile.fields?.length);

            // Set append mode and save to storage
            appendToId = profileId;
            await chrome.storage.sync.set({
                appendToProfileId: profileId,
                isRecordingActive: true
            });

            // Check for failed fields before starting recording
            const checkFailedFields = async () => {
                try {
                    console.log('Sending startRecording with failed fields check');
                    await chrome.tabs.sendMessage(tab.id, {
                        action: 'startRecording',
                        appendToProfileId: profileId,
                        checkFailedFields: true,
                        fields: profile.fields,
                        profileUrl: profile.url
                    });
                } catch (e) {
                    console.log('Content script not loaded, injecting...', e);
                    // Content script might not be loaded, inject it first
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    setTimeout(async () => {
                        console.log('Retrying startRecording after injection');
                        await chrome.tabs.sendMessage(tab.id, {
                            action: 'startRecording',
                            appendToProfileId: profileId,
                            checkFailedFields: true,
                            fields: profile.fields,
                            profileUrl: profile.url
                        });
                    }, 100);
                }
            };

            try {
                await checkFailedFields();
                isRecording = true;
                updateRecordButton();
                renderProfiles();
                showToastMessage('Recording started', 'success');
            } catch (e) {
                // Fallback: try without checking failed fields
                try {
                    await chrome.tabs.sendMessage(tab.id, {
                        action: 'startRecording',
                        appendToProfileId: profileId
                    });
                    isRecording = true;
                    updateRecordButton();
                    renderProfiles();
                    showToastMessage('Recording started', 'success');
                } catch (e2) {
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    setTimeout(async () => {
                        await chrome.tabs.sendMessage(tab.id, {
                            action: 'startRecording',
                            appendToProfileId: profileId
                        });
                        isRecording = true;
                        updateRecordButton();
                        renderProfiles();
                        showToastMessage('Recording started', 'success');
                    }, 100);
                }
            }
        });
    });

    container.querySelectorAll('.btn-fill').forEach(btn => {
        btn.addEventListener('click', () => {
            fillForm(btn.dataset.id);
        });
    });

    container.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => editProfile(btn.dataset.id));
    });

    container.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteProfile(btn.dataset.id));
    });
}

function editProfile(id) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${id}`) });
}

async function fillForm(profileId) {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5 };
    try {
        chrome.tabs.sendMessage(tab.id, {
            action: 'fillForm',
            fields: profile.fields,
            settings,
            profileId: profile.id,
            profileUrl: profile.url
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Fill error:', chrome.runtime.lastError);
                showToastMessage('Open the profile web page first', 'error');
            } else if (response && response.error === 'url_mismatch') {
                showToastMessage('Please open the profile page first', 'error');
            } else {
                showToastMessage('Form filled!', 'success');
            }
        });

        // Auto-close logic: Strictly check if setting is enabled
        console.log('Fill success. Settings:', settings);
        if (settings.autoClose === true) {
            console.log('Auto-closing popup...');
            // Reduced delay for faster close
            setTimeout(() => {
                window.close();
            }, 100);
        }
    } catch (e) {
        showToastMessage('Error filling form', 'error');
    }
}

// Toast and Utility functions

let deleteTargetId = null;
let deleteChildrenIds = [];

function deleteProfile(id) {
    deleteTargetId = id;

    // Check if this profile has sub-profiles
    deleteChildrenIds = profiles.filter(p => p.parentProfileId === id).map(p => p.id);

    const modal = document.getElementById('deleteModal');
    const messageEl = document.getElementById('deleteModalMessage');

    if (deleteChildrenIds.length > 0) {
        messageEl.innerHTML = `<span style="color:#ef4444;font-weight:600;">Warning:</span> This will also delete <strong>${deleteChildrenIds.length}</strong> sub-profile${deleteChildrenIds.length > 1 ? 's' : ''}.`;
    } else {
        messageEl.textContent = 'This action cannot be undone.';
    }

    if (modal) modal.classList.add('active');
    else if (confirm('Are you sure you want to delete this profile?')) {
        profiles = profiles.filter(p => p.id !== id && p.parentProfileId !== id);
        saveProfiles().then(() => renderProfiles());
    }
}

document.getElementById('cancelDeleteBtn')?.addEventListener('click', () => {
    document.getElementById('deleteModal').classList.remove('active');
    deleteTargetId = null;
    deleteChildrenIds = [];
});

document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    if (deleteTargetId) {
        // Delete the profile and all its sub-profiles
        profiles = profiles.filter(p => p.id !== deleteTargetId && p.parentProfileId !== deleteTargetId);
        await saveProfiles();
        renderProfiles();

        const deletedCount = 1 + deleteChildrenIds.length;
        showToastMessage(`${deletedCount} profile${deletedCount > 1 ? 's' : ''} deleted`, 'success');
    }
    document.getElementById('deleteModal').classList.remove('active');
    deleteTargetId = null;
    deleteChildrenIds = [];
});

function showToastMessage(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const icon = toast.querySelector('i');
    const text = toast.querySelector('span');
    text.textContent = message;
    if (type === 'error') {
        toast.style.background = '#ef4444';
        icon.className = 'fas fa-exclamation-circle';
    } else {
        toast.style.background = '#10b981';
        icon.className = 'fas fa-check-circle';
    }
    toast.classList.add('show');
    // Clear any previous hide timer so back-to-back toasts get the full duration
    if (toast._hideTimer) clearTimeout(toast._hideTimer);
    // Errors stay longer - the user needs time to read what went wrong
    const duration = type === 'error' ? 6000 : 4000;
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), duration);
}


function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}
