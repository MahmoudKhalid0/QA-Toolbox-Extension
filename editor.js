let profiles = [];
let currentFields = [];
let editingId = null;

// Maximum number of profiles allowed for the same exact URL
const MAX_PROFILES_PER_URL = 5;

// Get profile ID from URL
const urlParams = new URLSearchParams(window.location.search);
editingId = urlParams.get('id');
const isNew = urlParams.get('new') === 'true';

document.addEventListener('DOMContentLoaded', async () => {
    await loadProfiles();
    await populateCategoryDropdown();
    setupSubProfileCheckbox();

    // Check if current profile has children - if so, hide sub-profile option
    if (editingId) {
        const hasChildren = profiles.some(p => String(p.parentProfileId) === String(editingId));
        if (hasChildren) {
            document.querySelector('.sub-profile-section').style.display = 'none';
        }
    }

    if (isNew) {
        document.getElementById('pageTitle').textContent = 'New Profile';

        // Check if we should load from storage (for large field sets or recorded data)
        const fromStorage = urlParams.get('fromStorage') === 'true';
        if (fromStorage) {
            const storageData = await chrome.storage.local.get(['pendingNewProfile']);
            if (storageData.pendingNewProfile && storageData.pendingNewProfile.fields) {
                currentFields = storageData.pendingNewProfile.fields.map(f => ({
                    ...f,
                    uniqueText: false,
                    uniqueNumber: false,
                    digits: 5
                }));

                const capturedUrl = storageData.pendingNewProfile.url;
                if (capturedUrl) {
                    document.getElementById('profileUrl').value = capturedUrl;
                    document.body.dataset.capturedUrl = capturedUrl;
                }

                document.getElementById('pageTitle').textContent = 'Save Recorded Profile';
                // Clear storage after loading
                await chrome.storage.local.remove('pendingNewProfile');
            }
        }
    } else if (editingId) {
        // Robust ID comparison (string vs number)
        const profile = profiles.find(p => String(p.id) === String(editingId));
        if (profile) {
            document.getElementById('profileName').value = profile.name;
            document.getElementById('profileCategory').value = profile.category || 'General';
            document.getElementById('profileUrl').value = profile.url || '';
            currentFields = profile.fields.map(f => ({
                ...f,
                uniqueText: f.uniqueText || false,
                uniqueNumber: f.uniqueNumber || false,
                digits: f.digits || 5
            }));
            document.getElementById('pageTitle').textContent = 'Edit: ' + profile.name;

            // Load sub-profile data if exists
            if (profile.parentProfileId) {
                const parentProfile = profiles.find(p => p.id === profile.parentProfileId);
                if (parentProfile) {
                    document.getElementById('isSubProfileCheck').checked = true;
                    document.getElementById('parentProfileSection').style.display = 'block';
                    selectParentProfile(profile.parentProfileId, parentProfile.name);
                }
            }

            // ✅ CHECK FOR RECORDED FIELDS from stop button (append mode)
            const storageData = await chrome.storage.local.get(['recordedFields', 'recordedUrl']);
            if (storageData.recordedFields && storageData.recordedFields.length > 0) {
                console.log('Found recordedFields in storage:', storageData.recordedFields.length);

                // Get existing selectors to avoid duplicates
                const existingSelectors = new Set(currentFields.map(f => f.selector));

                // Filter and add new fields
                const newFields = storageData.recordedFields
                    .filter(f => !existingSelectors.has(f.selector))
                    .map(f => ({
                        ...f,
                        uniqueText: false,
                        uniqueNumber: false,
                        digits: 5
                    }));

                if (newFields.length > 0) {
                    currentFields = [...currentFields, ...newFields];
                    console.log('Added', newFields.length, 'new fields to profile');
                    showToast(`Added ${newFields.length} new field(s)`, 'success');
                }

                // Clear recordedFields from storage
                await chrome.storage.local.remove(['recordedFields', 'recordedUrl']);
            }
        }
    }

    // Check for recorded fields from URL (legacy support)
    const recordedFieldsStr = urlParams.get('fields');
    if (recordedFieldsStr) {
        try {
            const parsed = JSON.parse(decodeURIComponent(recordedFieldsStr));
            currentFields = parsed.map(f => ({
                ...f,
                uniqueText: false,
                uniqueNumber: false,
                digits: 5
            }));
            document.getElementById('pageTitle').textContent = 'Save Recorded Profile';
        } catch (e) { }
    }

    renderFields();

    // Page URL is now editable for all profiles
    const urlInput = document.getElementById('profileUrl');
    if (urlInput) {
        urlInput.readOnly = false;
        urlInput.style.opacity = '1';
        urlInput.style.cursor = 'text';
        urlInput.title = 'Edit the page URL for this profile';
    }

    // Scroll to new fields if requested (from replacement mode)
    const scrollToNew = urlParams.get('scrollToNew') === 'true';
    const newFieldsCount = parseInt(urlParams.get('newFieldsCount')) || 0;
    if (scrollToNew && newFieldsCount > 0) {
        setTimeout(() => {
            const fieldItems = document.querySelectorAll('.field-item');
            if (fieldItems.length >= newFieldsCount) {
                // Scroll to the first new field (last newFieldsCount items)
                const firstNewFieldIndex = fieldItems.length - newFieldsCount;
                const firstNewField = fieldItems[firstNewFieldIndex];
                if (firstNewField) {
                    firstNewField.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Highlight the new fields
                    for (let i = firstNewFieldIndex; i < fieldItems.length; i++) {
                        fieldItems[i].style.background = 'rgba(16, 185, 129, 0.2)';
                        fieldItems[i].style.border = '2px solid #10b981';
                        setTimeout(() => {
                            fieldItems[i].style.background = '';
                            fieldItems[i].style.border = '';
                        }, 3000);
                    }
                }
            }
        }, 500);
    }

});

// Back button
document.getElementById('backBtn').addEventListener('click', () => {
    window.close();
});

// Add field
document.getElementById('addFieldBtn').addEventListener('click', () => {
    currentFields.push({
        selector: '',
        value: '',
        actionType: 'fill', // Default action
        uniqueText: false,
        uniqueNumber: false,
        digits: 5,
        isSmartDate: false,
        dateDirection: 'future',
        dateFormat: 'DD/MM/YYYY',
        dateSeparator: '/'
    });
    renderFields();
});

// Guide Modal
document.getElementById('showGuideBtn')?.addEventListener('click', () => {
    document.getElementById('guideModal').style.display = 'flex';
});

document.getElementById('closeGuideBtn')?.addEventListener('click', () => {
    document.getElementById('guideModal').style.display = 'none';
});

// Copy Fields Toggle
document.getElementById('copyFieldsBtn').addEventListener('click', () => {
    const section = document.getElementById('copyFieldsSection');
    const isVisible = section.style.display === 'block';

    if (isVisible) {
        section.style.display = 'none';
    } else {
        section.style.display = 'block';
        document.getElementById('copyProfileSearch').focus();
        populateCopyProfileDropdown();
    }
});

document.getElementById('cancelCopyBtn').addEventListener('click', () => {
    document.getElementById('copyFieldsSection').style.display = 'none';
});

// Search input for Copy Fields
document.getElementById('copyProfileSearch').addEventListener('focus', () => {
    document.getElementById('copyProfileDropdown').style.display = 'block';
    populateCopyProfileDropdown(document.getElementById('copyProfileSearch').value);
});

document.getElementById('copyProfileSearch').addEventListener('input', () => {
    document.getElementById('copyProfileDropdown').style.display = 'block';
    populateCopyProfileDropdown(document.getElementById('copyProfileSearch').value);
});

// Close copy dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('#copyFieldsSection')) {
        document.getElementById('copyProfileDropdown').style.display = 'none';
    }
});

function populateCopyProfileDropdown(searchTerm = '') {
    const dropdown = document.getElementById('copyProfileDropdown');

    // Filter: exclude current profile
    const availableProfiles = profiles.filter(p => p.id !== editingId);

    const filteredProfiles = searchTerm
        ? availableProfiles.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
        : availableProfiles;

    if (filteredProfiles.length === 0) {
        dropdown.innerHTML = `
            <div style="padding: 16px; text-align: center; color: #666;">
                <i class="fas fa-search" style="font-size: 20px; margin-bottom: 8px; display: block;"></i>
                ${searchTerm ? 'No matching profiles found' : 'No available profiles'}
            </div>
        `;
    } else {
        dropdown.innerHTML = filteredProfiles.map(p => `
            <div class="copy-profile-option" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" 
                 style="padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; transition: background 0.2s; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div style="width: 32px; height: 32px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: white; flex-shrink: 0;">
                    ${p.name.charAt(0).toUpperCase()}
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="color: white; font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.name)}</div>
                    <div style="color: #10b981; font-size: 11px;">${escapeHtml(p.category || 'General')} • ${p.fields?.length || 0} fields</div>
                </div>
            </div>
        `).join('');

        dropdown.querySelectorAll('.copy-profile-option').forEach(option => {
            option.addEventListener('mouseenter', () => {
                option.style.background = 'rgba(16, 185, 129, 0.2)';
            });
            option.addEventListener('mouseleave', () => {
                option.style.background = 'transparent';
            });
            option.addEventListener('click', () => {
                copyFieldsFromProfile(option.dataset.id);
            });
        });
    }
}

async function copyFieldsFromProfile(id) {
    const profile = profiles.find(p => p.id === id);
    if (!profile || !profile.fields) return;

    // Sync current inputs before appending
    syncFieldInputs();

    const newFields = profile.fields.map(f => ({
        ...f,
        uniqueText: f.uniqueText || false,
        uniqueNumber: f.uniqueNumber || false,
        digits: f.digits || 5
    }));

    currentFields = [...currentFields, ...newFields];
    renderFields();

    document.getElementById('copyFieldsSection').style.display = 'none';
    document.getElementById('copyProfileSearch').value = '';
    showToast(`Copied ${newFields.length} field(s) from ${profile.name}`, 'success');
}

// Close guide when clicking outside the content
document.getElementById('guideModal').addEventListener('click', (e) => {
    if (e.target.id === 'guideModal') {
        document.getElementById('guideModal').style.display = 'none';
    }
});


// Cancel
document.getElementById('cancelBtn').addEventListener('click', () => {
    window.close();
});

// Save
document.getElementById('saveBtn').addEventListener('click', async () => {
    console.log('Save button clicked');

    const name = document.getElementById('profileName').value.trim();
    const category = document.getElementById('profileCategory').value;
    const profileUrl = document.getElementById('profileUrl').value.trim();
    const isSubProfile = document.getElementById('isSubProfileCheck').checked;
    const parentProfileId = document.getElementById('parentProfileSelect').value;

    console.log('Form values:', { name, category, profileUrl, isSubProfile, parentProfileId, editingId, isNew });

    let hasError = false;
    if (!name) {
        document.getElementById('profileName').style.borderColor = '#ef4444';
        hasError = true;
        console.log('Error: name is empty');
    } else {
        document.getElementById('profileName').style.borderColor = 'rgba(255,255,255,0.1)';
    }

    if (!category) {
        document.getElementById('profileCategory').style.borderColor = '#ef4444';
        hasError = true;
    } else {
        document.getElementById('profileCategory').style.borderColor = 'rgba(255,255,255,0.1)';
    }

    if (!profileUrl) {
        document.getElementById('profileUrl').style.borderColor = '#ef4444';
        hasError = true;
    } else {
        document.getElementById('profileUrl').style.borderColor = 'rgba(255,255,255,0.1)';
    }

    // Validate parent profile if sub-profile is checked
    if (isSubProfile && !parentProfileId) {
        document.getElementById('parentProfileSelect').style.borderColor = '#ef4444';
        hasError = true;
        console.log('Error: isSubProfile checked but no parentProfileId');
    } else {
        document.getElementById('parentProfileSelect').style.borderColor = 'rgba(255,255,255,0.1)';
    }

    if (hasError) {
        showToast('Please fill all mandatory fields', 'error');
        console.log('Returning due to validation errors');
        return;
    }

    // Limit: max MAX_PROFILES_PER_URL profiles per exact URL (hash/trailing slash ignored).
    // Editing a profile WITHOUT changing its URL is always allowed (so profiles from
    // before this limit existed remain editable).
    try {
        const normalizeUrl = (u) => String(u || '').split('#')[0].trim().replace(/\/+$/, '');
        const targetUrl = normalizeUrl(profileUrl);
        const editedProfile = editingId ? profiles.find(p => String(p.id) === String(editingId)) : null;
        const urlUnchanged = !!(editedProfile && normalizeUrl(editedProfile.url) === targetUrl);

        if (!urlUnchanged && targetUrl) {
            const sameUrlCount = profiles.filter(p =>
                p && p.url &&
                String(p.id) !== String(editingId) &&
                normalizeUrl(p.url) === targetUrl
            ).length;

            if (sameUrlCount >= MAX_PROFILES_PER_URL) {
                document.getElementById('profileUrl').style.borderColor = '#ef4444';
                showToast(`Limit reached: ${MAX_PROFILES_PER_URL} profiles already exist for this URL`, 'error');
                return;
            }
        }
    } catch (limitErr) {
        console.warn('URL limit check failed, allowing save:', limitErr);
    }

    const fieldItems = document.querySelectorAll('.field-item');
    console.log('Field items count:', fieldItems.length);

    const fields = [];
    fieldItems.forEach((item, index) => {
        const inputs = item.querySelectorAll('.field-input');
        const uniqueTextCb = item.querySelector('.unique-text-cb');
        const uniqueNumberCb = item.querySelector('.unique-number-cb');
        const sequentialCb = item.querySelector('.sequential-cb');
        const smartDateCb = item.querySelector('.smart-date-cb');
        const digitsInput = item.querySelector('.digits-input');

        // Smart Date Settings
        const dateDirection = item.querySelector('.date-direction')?.value;
        const dateFormat = item.querySelector('.date-format')?.value;
        const dateSeparator = item.querySelector('.date-separator')?.value;

        if (inputs[0].value.trim() || currentFields[index]?.actionType === 'wait') {
            fields.push({
                selector: inputs[0].value.trim(),
                value: inputs[1].value,
                actionType: currentFields[index]?.actionType || 'fill',
                type: currentFields[index]?.type || 'text',
                uniqueText: uniqueTextCb?.checked || false,
                uniqueNumber: uniqueNumberCb?.checked || false,
                sequentialSelect: sequentialCb?.checked || false,
                isSmartDate: smartDateCb?.checked || false,
                dateDirection: dateDirection || 'future',
                dateFormat: dateFormat || 'DD/MM/YYYY',
                dateSeparator: dateSeparator || '/',
                digits: parseInt(digitsInput?.value) || 5
            });
        }
    });

    console.log('Collected fields:', fields.length);

    if (fields.length === 0) {
        showToast('Add at least one field', 'error');
        console.log('Returning: no fields');
        return;
    }

    const capturedUrl = urlParams.get('url') || document.body.dataset.capturedUrl || '';
    const lastModified = Date.now();

    console.log('capturedUrl:', capturedUrl);
    console.log('Profiles before save:', profiles.length);

    try {
        if (editingId && !isNew) {
            console.log('Editing existing profile with id:', editingId);
            const index = profiles.findIndex(p => p.id === editingId);
            console.log('Found at index:', index);
            if (index >= 0) {
                profiles[index] = {
                    ...profiles[index],
                    name,
                    category,
                    url: profileUrl,
                    fields,
                    lastModified,
                    parentProfileId: isSubProfile ? parentProfileId : null
                };
                console.log('Updated profile:', profiles[index]);
            }
        } else {
            console.log('Creating new profile');
            const newProfile = {
                id: Date.now().toString(),
                name,
                category,
                url: profileUrl,
                fields,
                onReload: false,
                lastModified,
                parentProfileId: isSubProfile ? parentProfileId : null
            };
            console.log('New profile:', newProfile);
            profiles.push(newProfile);
        }

        // Update children's category to match parent's category
        if (!isSubProfile) {
            profiles.forEach((p, idx) => {
                if (p.parentProfileId === (editingId || profiles[profiles.length - 1].id)) {
                    profiles[idx].category = category;
                }
            });
        }

        console.log('Profiles after changes:', profiles.length);
        console.log('Saving to storage...');

        await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'saveProfiles', profiles }, (response) => {
                if (response && response.success) resolve();
                else reject(new Error(response?.error || 'Failed to save profiles'));
            });
        });

        console.log('Saved successfully!');
        showToast('Profile saved!', 'success');

        setTimeout(() => {
            window.close();
        }, 1000);
    } catch (err) {
        console.error('Save error:', err);
        showToast('Error saving profile: ' + err.message, 'error');
    }
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

async function populateCategoryDropdown() {
    const result = await chrome.storage.sync.get(['formFillerCategories']);
    const availableCategories = result.formFillerCategories || ["General", "Work", "Personal", "Testing"];

    const select = document.getElementById('profileCategory');
    select.innerHTML = '<option value="" disabled selected>-- Select Category --</option>' +
        availableCategories.sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    // If we are editing, set the value after population
    if (editingId) {
        const profile = profiles.find(p => p.id === editingId);
        if (profile) {
            select.value = profile.category || 'General';
        }
    }
}

// Populate parent profile dropdown with only parent profiles (not sub-profiles)
function populateParentProfileDropdown(searchTerm = '') {
    const dropdown = document.getElementById('parentProfileDropdown');

    // Filter: exclude current profile AND exclude profiles that are already sub-profiles
    const availableProfiles = profiles.filter(p =>
        p.id !== editingId &&
        !p.parentProfileId
    );

    const filteredProfiles = searchTerm
        ? availableProfiles.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
        : availableProfiles;

    if (filteredProfiles.length === 0) {
        dropdown.innerHTML = `
            <div style="padding: 16px; text-align: center; color: #666;">
                <i class="fas fa-search" style="font-size: 20px; margin-bottom: 8px; display: block;"></i>
                ${searchTerm ? 'No matching profiles found' : 'No available parent profiles'}
            </div>
        `;
    } else {
        dropdown.innerHTML = filteredProfiles.map(p => `
            <div class="parent-profile-option" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" 
                 style="padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; transition: background 0.2s; border-bottom: 1px solid rgba(255,255,255,0.05);">
                <div style="width: 32px; height: 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: white; flex-shrink: 0;">
                    ${p.name.charAt(0).toUpperCase()}
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="color: white; font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.name)}</div>
                    <div style="color: #667eea; font-size: 11px;">${escapeHtml(p.category || 'General')} • ${p.fields?.length || 0} fields</div>
                </div>
            </div>
        `).join('');

        // Add hover effect and click handlers
        dropdown.querySelectorAll('.parent-profile-option').forEach(option => {
            option.addEventListener('mouseenter', () => {
                option.style.background = 'rgba(102, 126, 234, 0.2)';
            });
            option.addEventListener('mouseleave', () => {
                option.style.background = 'transparent';
            });
            option.addEventListener('click', () => {
                selectParentProfile(option.dataset.id, option.dataset.name);
            });
        });
    }
}

function selectParentProfile(id, name) {
    document.getElementById('parentProfileSelect').value = id;
    document.getElementById('parentProfileSearch').value = '';
    document.getElementById('parentProfileDropdown').style.display = 'none';
    document.getElementById('selectedParentDisplay').style.display = 'block';
    document.getElementById('selectedParentName').textContent = name;
    document.getElementById('parentProfileSearch').style.display = 'none';

    // Copy category from parent profile and lock the dropdown
    const parentProfile = profiles.find(p => p.id === id);
    if (parentProfile) {
        const categorySelect = document.getElementById('profileCategory');
        categorySelect.value = parentProfile.category || 'General';
        categorySelect.disabled = true;
        categorySelect.style.opacity = '0.6';
        categorySelect.style.cursor = 'not-allowed';
        categorySelect.title = 'Category is inherited from parent profile';
    }
}

function clearParentProfile() {
    document.getElementById('parentProfileSelect').value = '';
    document.getElementById('selectedParentDisplay').style.display = 'none';
    document.getElementById('parentProfileSearch').style.display = 'block';
    document.getElementById('parentProfileSearch').value = '';
    document.getElementById('parentProfileSearch').style.borderColor = 'rgba(255,255,255,0.1)';

    // Unlock category dropdown
    const categorySelect = document.getElementById('profileCategory');
    categorySelect.disabled = false;
    categorySelect.style.opacity = '1';
    categorySelect.style.cursor = 'pointer';
    categorySelect.title = '';
}

// Setup sub-profile checkbox toggle and search functionality
function setupSubProfileCheckbox() {
    const checkbox = document.getElementById('isSubProfileCheck');
    const parentSection = document.getElementById('parentProfileSection');
    const searchInput = document.getElementById('parentProfileSearch');
    const dropdown = document.getElementById('parentProfileDropdown');
    const clearBtn = document.getElementById('clearParentBtn');

    checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
            parentSection.style.display = 'block';
            populateParentProfileDropdown();
        } else {
            parentSection.style.display = 'none';
            clearParentProfile();
        }
    });

    // Search input handlers
    searchInput.addEventListener('focus', () => {
        dropdown.style.display = 'block';
        populateParentProfileDropdown(searchInput.value);
    });

    searchInput.addEventListener('input', () => {
        dropdown.style.display = 'block';
        populateParentProfileDropdown(searchInput.value);
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.parent-profile-search-container')) {
            dropdown.style.display = 'none';
        }
    });

    // Clear button handler
    clearBtn.addEventListener('click', () => {
        clearParentProfile();
    });
}

// Helper function to sync field inputs from DOM to currentFields array
function syncFieldInputs() {
    const fieldItems = document.querySelectorAll('.field-item');
    fieldItems.forEach((item, idx) => {
        const selectorInput = item.querySelector('.field-input.selector');
        const valueInput = item.querySelectorAll('.field-input')[1];
        if (selectorInput && currentFields[idx] && currentFields[idx].actionType !== 'wait') {
            currentFields[idx].selector = selectorInput.value;
        }
        if (valueInput && currentFields[idx]) {
            let val = valueInput.value;
            if (currentFields[idx].actionType === 'wait') {
                const numericVal = parseFloat(val);
                if (!isNaN(numericVal) && numericVal < 0) {
                    val = "0";
                    valueInput.value = "0";
                }
            }
            currentFields[idx].value = val;
        }

        // Sync Action Type
        const activeActionBtn = item.querySelector('.action-type-btn.active');
        if (activeActionBtn && currentFields[idx]) {
            currentFields[idx].actionType = activeActionBtn.dataset.type;
        }

        // Sync Smart Date settings
        if (currentFields[idx]) {
            const smartDateCb = item.querySelector('.smart-date-cb');
            if (smartDateCb) currentFields[idx].isSmartDate = smartDateCb.checked;

            const direction = item.querySelector('.date-direction');
            if (direction) currentFields[idx].dateDirection = direction.value;

            const format = item.querySelector('.date-format');
            if (format) currentFields[idx].dateFormat = format.value;

            const separator = item.querySelector('.date-separator');
            if (separator) currentFields[idx].dateSeparator = separator.value;
        }
    });
}

function renderFields() {
    const container = document.getElementById('fieldsContainer');
    container.innerHTML = currentFields.map((field, index) => {
        const actionType = field.actionType || 'fill';
        const isOptionActive = field.uniqueText || field.uniqueNumber || field.sequentialSelect || field.isSmartDate;

        // Locked if not 'fill' or if options are active
        const isValueDisabled = (actionType !== 'fill' && actionType !== 'wait') || isOptionActive;
        const valuePlaceholder = actionType === 'wait' ? 'Duration (sec)' : 'Value';
        const valueClass = actionType === 'wait' ? 'field-input wait-sec-input' : 'field-input';

        return `
        <div class="field-item" data-index="${index}">
            <div class="action-type-selector">
                <div class="action-type-btn ${actionType === 'fill' ? 'active' : ''}" data-type="fill" title="Fill a form field">
                    <i class="fas fa-edit"></i> Fill
                </div>
                <div class="action-type-btn ${actionType === 'click' ? 'active' : ''}" data-type="click" title="Click an element (Button, Link, etc.)">
                    <i class="fas fa-mouse-pointer"></i> Click
                </div>
                <div class="action-type-btn ${actionType === 'wait' ? 'active' : ''}" data-type="wait" title="Wait for a specific duration">
                    <i class="fas fa-hourglass-start"></i> Wait
                </div>
            </div>

            <div class="field-row">
                <input type="text" class="field-input selector" value="${escapeHtml(field.selector)}" placeholder="${actionType === 'wait' ? 'N/A' : 'CSS Selector or XPath'}" ${actionType === 'wait' ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}>
                <input type="${actionType === 'wait' ? 'number' : 'text'}" 
                    class="${valueClass}" 
                    value="${escapeHtml(field.value)}" 
                    placeholder="${valuePlaceholder}" 
                    ${actionType === 'wait' ? 'min="0" step="0.1"' : ''}
                    ${isValueDisabled ? 'disabled style="opacity:0.5; background:rgba(255,255,255,0.02); cursor:not-allowed;"' : ''} 
                    title="${isValueDisabled ? (actionType === 'click' ? 'No value needed for click' : 'Value is managed automatically') : 'Enter value'}">
                <button class="btn-remove" data-index="${index}"><i class="fas fa-times"></i></button>
            </div>
            
            ${actionType === 'fill' ? `
            <div class="field-options">
                <label class="field-option ${field.uniqueText ? 'active' : ''}">
                    <input type="checkbox" class="unique-text-cb" ${field.uniqueText ? 'checked' : ''}>
                    <i class="fas fa-font"></i> Unique text
                    <input type="number" class="digits-input" value="${field.digits || 5}" min="1" max="50" title="Number of digits (1-50)" ${!field.uniqueText ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
                </label>
                <label class="field-option ${field.uniqueNumber ? 'active' : ''}">
                    <input type="checkbox" class="unique-number-cb" ${field.uniqueNumber ? 'checked' : ''}>
                    <i class="fas fa-hashtag"></i> Unique number
                    <input type="number" class="digits-input" value="${field.digits || 5}" min="1" max="50" title="Number of digits (1-50)" ${!field.uniqueNumber ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
                </label>
                <label class="field-option ${field.sequentialSelect ? 'active' : ''}">
                    <input type="checkbox" class="sequential-cb" ${field.sequentialSelect ? 'checked' : ''}>
                    <i class="fas fa-list-ol"></i> Sequential
                </label>
                <label class="field-option ${field.isSmartDate ? 'active' : ''}">
                    <input type="checkbox" class="smart-date-cb" ${field.isSmartDate ? 'checked' : ''}>
                    <i class="fas fa-calendar-alt"></i> Smart Date
                </label>
            </div>
            ` : ''}

            ${field.isSmartDate && actionType === 'fill' ? `
            <div class="date-settings-panel">
                <div class="date-group">
                    <label>Direction</label>
                    <select class="date-select date-direction">
                        <option value="future" ${field.dateDirection === 'future' ? 'selected' : ''}>Future (Next 1 month)</option>
                        <option value="past" ${field.dateDirection === 'past' ? 'selected' : ''}>Past (Last 1 month)</option>
                        <option value="random" ${field.dateDirection === 'random' ? 'selected' : ''}>Random (Past/Future 1 month)</option>
                    </select>
                </div>
                <div class="date-group">
                    <label>Format</label>
                    <select class="date-select date-format">
                        <option value="DD/MM/YYYY" ${field.dateFormat === 'DD/MM/YYYY' ? 'selected' : ''}>DD/MM/YYYY</option>
                        <option value="MM/DD/YYYY" ${field.dateFormat === 'MM/DD/YYYY' ? 'selected' : ''}>MM/DD/YYYY</option>
                        <option value="YYYY/MM/DD" ${field.dateFormat === 'YYYY/MM/DD' ? 'selected' : ''}>YYYY/MM/DD</option>
                        <option value="YYYY-MM-DD" ${field.dateFormat === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD (ISO)</option>
                    </select>
                </div>
                <div class="date-group">
                    <label>Separator</label>
                    <select class="date-select date-separator">
                        <option value="/" ${field.dateSeparator === '/' ? 'selected' : ''}>Slash ( / )</option>
                        <option value="-" ${field.dateSeparator === '-' ? 'selected' : ''}>Dash ( - )</option>
                        <option value="." ${field.dateSeparator === '.' ? 'selected' : ''}>Dot ( . )</option>
                    </select>
                </div>
            </div>
            ` : ''}
        </div>
    `;
    }).join('');

    // Action Type Handlers
    container.querySelectorAll('.action-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = btn.closest('.field-item').dataset.index;
            const type = btn.dataset.type;
            syncFieldInputs();
            currentFields[idx].actionType = type;

            // Clean up other options if switching away from 'fill'
            if (type !== 'fill') {
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
            }

            renderFields();
        });
    });

    // Remove button handlers
    container.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            currentFields.splice(parseInt(btn.dataset.index), 1);
            renderFields();
        });
    });

    // Checkbox handlers - Mutually Exclusive and Mutually Disabling Input
    container.querySelectorAll('.unique-text-cb').forEach((cb, idx) => {
        cb.addEventListener('change', () => {
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].uniqueText = true;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
                // Initialize digits if not set
                if (!currentFields[idx].digits) currentFields[idx].digits = 5;
            } else {
                currentFields[idx].uniqueText = false;
            }
            renderFields();
        });
    });

    container.querySelectorAll('.unique-number-cb').forEach((cb, idx) => {
        cb.addEventListener('change', () => {
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].uniqueNumber = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
            } else {
                currentFields[idx].uniqueNumber = false;
            }
            renderFields();
        });
    });

    // Sequential checkbox handler
    container.querySelectorAll('.sequential-cb').forEach((cb, idx) => {
        cb.addEventListener('change', () => {
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].sequentialSelect = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].isSmartDate = false;
            } else {
                currentFields[idx].sequentialSelect = false;
            }
            renderFields();
        });
    });

    // Smart Date checkbox handler
    container.querySelectorAll('.smart-date-cb').forEach((cb, idx) => {
        cb.addEventListener('change', () => {
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].isSmartDate = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].sequentialSelect = false;
            } else {
                currentFields[idx].isSmartDate = false;
            }
            renderFields();
        });
    });

    // Digits input handler
    container.querySelectorAll('.digits-input').forEach((input, idx) => {
        input.addEventListener('change', () => {
            let value = parseInt(input.value) || 5;
            // Validate: min 1, max 50
            value = Math.max(1, Math.min(50, value));
            input.value = value;
            currentFields[idx].digits = value;
        });
        input.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    // Prevent negative signs in wait inputs
    container.querySelectorAll('.wait-sec-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === '-' || e.key === 'e') {
                e.preventDefault();
            }
        });
    });
}

function showToast(message, type) {
    const toast = document.getElementById('toast');
    const text = toast.querySelector('span');
    const icon = toast.querySelector('i');

    text.textContent = message;

    if (type === 'error') {
        toast.style.background = '#ef4444';
        icon.className = 'fas fa-exclamation-circle';
    } else {
        toast.style.background = '#10b981';
        icon.className = 'fas fa-check-circle';
    }

    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
