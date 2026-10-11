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
    // keep what was typed in the other fields - the list is redrawn from currentFields
    syncFieldInputs();
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
        dateSeparator: '/',
        dateTime: 'none'
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
        const numberRangeCb = item.querySelector('.number-range-cb');
        const sequentialCb = item.querySelector('.sequential-cb');
        const smartDateCb = item.querySelector('.smart-date-cb');
        const digitsInput = item.querySelector('.digits-input');
        const rangeMinInput = item.querySelector('.range-min');
        const rangeMaxInput = item.querySelector('.range-max');

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
                numberRange: numberRangeCb?.checked || false,
                sequentialSelect: sequentialCb?.checked || false,
                isSmartDate: smartDateCb?.checked || false,
                dateDirection: dateDirection || 'future',
                dateFormat: dateFormat || 'DD/MM/YYYY',
                dateSeparator: dateSeparator || '/',
                dateTime: item.querySelector('.date-time')?.value || currentFields[index]?.dateTime || 'none',
                seqMode: item.querySelector('.seq-mode')?.value || currentFields[index]?.seqMode || 'order',
                seqOnly: (item.querySelector('.seq-only')?.value ?? currentFields[index]?.seqOnly ?? '').trim(),
                // the field's own value: each field renders TWO digits boxes (text + number),
                // so the first one in the DOM was not always the one that was edited
                digits: currentFields[index]?.digits || parseInt(digitsInput?.value) || 5,
                numberPrefix: (currentFields[index]?.numberPrefix || '').replace(/\D/g, ''),
                rangeMin: rangeMinInput && rangeMinInput.value !== '' ? parseInt(rangeMinInput.value) : (currentFields[index]?.rangeMin ?? 1),
                rangeMax: rangeMaxInput && rangeMaxInput.value !== '' ? parseInt(rangeMaxInput.value) : (currentFields[index]?.rangeMax ?? 100)
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
    const availableCategories = result.formFillerCategories || ["General"];

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

            const time = item.querySelector('.date-time');
            if (time) currentFields[idx].dateTime = time.value;

            const seqMode = item.querySelector('.seq-mode');
            if (seqMode) currentFields[idx].seqMode = seqMode.value;
            const seqOnly = item.querySelector('.seq-only');
            if (seqOnly) currentFields[idx].seqOnly = seqOnly.value;

            // Number range bounds (preserve typed-but-not-blurred values across re-render)
            const rMin = item.querySelector('.range-min');
            if (rMin && rMin.value !== '') currentFields[idx].rangeMin = parseInt(rMin.value);
            const rMax = item.querySelector('.range-max');
            if (rMax && rMax.value !== '') currentFields[idx].rangeMax = parseInt(rMax.value);
        }
    });
}

function renderFields() {
    const container = document.getElementById('fieldsContainer');
    container.innerHTML = currentFields.map((field, index) => {
        const actionType = field.actionType || 'fill';
        const isOptionActive = field.uniqueText || field.uniqueNumber || field.numberRange || field.sequentialSelect || field.isSmartDate;

        // Locked if not 'fill' or if options are active
        const isValueDisabled = (actionType !== 'fill' && actionType !== 'wait') || isOptionActive;
        const valuePlaceholder = actionType === 'wait' ? 'Duration (sec)' : 'Value';
        const valueClass = actionType === 'wait' ? 'field-input wait-sec-input' : 'field-input';

        return `
        <div class="field-item" data-index="${index}">
            <div class="field-head">
            <span class="field-drag" title="Drag to move this field" draggable="true"><i class="fas fa-grip-vertical"></i></span>
            <span class="field-num">${index + 1}</span>
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
            <span class="field-move">
                <button type="button" class="btn-move" data-dir="-1" title="Move up" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="btn-move" data-dir="1" title="Move down" ${index === currentFields.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
            </span>
            </div>

            <div class="field-row">
                <input type="text" class="field-input selector" value="${escapeHtml(field.selector)}" placeholder="${actionType === 'wait' ? 'N/A' : 'CSS Selector or XPath'}" ${actionType === 'wait' ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}>
                <div class="value-wrap">
                <input type="${actionType === 'wait' ? 'number' : 'text'}"
                    class="${valueClass}"
                    value="${escapeHtml(field.value)}" 
                    placeholder="${valuePlaceholder}" 
                    ${actionType === 'wait' ? 'min="0" step="0.1"' : ''}
                    ${isValueDisabled ? 'disabled style="opacity:0.5; background:rgba(255,255,255,0.02); cursor:not-allowed;"' : ''} 
                    title="${isValueDisabled ? (actionType === 'click' ? 'No value needed for click' : 'Value is managed automatically') : 'Enter value'}">
                ${actionType === 'fill' && !isValueDisabled ? '<button type="button" class="btn-var" title="Insert a smart variable (random name, city, date…)">{x}</button>' : ''}
                </div>
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
                    <input type="number" class="digits-input" value="${field.digits || 5}" min="1" max="50" title="Total number of digits (1-50), including the starting digits" ${!field.uniqueNumber ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
                    <input type="text" class="prefix-input" inputmode="numeric" maxlength="20" value="${escapeHtml(field.numberPrefix || '')}" placeholder="Starts with" title="Digits the number always starts with (e.g. 05) - the rest is filled in" ${!field.uniqueNumber ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
                </label>
                <label class="field-option ${field.numberRange ? 'active' : ''}">
                    <input type="checkbox" class="number-range-cb" ${field.numberRange ? 'checked' : ''}>
                    <i class="fas fa-arrow-down-1-9"></i> Number range
                    <input type="number" class="range-input range-min" value="${field.rangeMin ?? 1}" title="Minimum value" ${!field.numberRange ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
                    <span class="range-sep">–</span>
                    <input type="number" class="range-input range-max" value="${field.rangeMax ?? 100}" title="Maximum value" ${!field.numberRange ? 'disabled style="opacity:0.3; pointer-events:none;"' : ''}>
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

            ${field.sequentialSelect && actionType === 'fill' ? `
            <div class="date-settings-panel seq-settings-panel">
                <div class="date-group">
                    <label>Order</label>
                    <select class="date-select seq-mode">
                        <option value="order" ${field.seqMode !== 'random' ? 'selected' : ''}>In order (next one each fill)</option>
                        <option value="random" ${field.seqMode === 'random' ? 'selected' : ''}>Random</option>
                    </select>
                </div>
                <div class="date-group seq-only-group">
                    <label>Only these <span style="text-transform:none;opacity:.7;">(optional)</span></label>
                    <input type="text" class="date-select seq-only" value="${escapeHtml(field.seqOnly || '')}" placeholder="e.g. Pending, Approved - empty = all options" title="Pick only from these options (comma-separated, as written in the list). Empty = every option.">
                </div>
            </div>
            ` : ''}

            ${field.isSmartDate && actionType === 'fill' ? `
            <div class="date-settings-panel">
                <div class="date-group">
                    <label>Direction</label>
                    <select class="date-select date-direction">
                        <option value="future" ${field.dateDirection === 'future' ? 'selected' : ''}>Future · 1 month</option>
                        <option value="past" ${field.dateDirection === 'past' ? 'selected' : ''}>Past · 1 month</option>
                        <option value="random" ${field.dateDirection === 'random' ? 'selected' : ''}>Random · ±1 month</option>
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
                <div class="date-group">
                    <label>Time</label>
                    <select class="date-select date-time">
                        <option value="none" ${!field.dateTime || field.dateTime === 'none' ? 'selected' : ''}>No time</option>
                        <option value="12" ${field.dateTime === '12' ? 'selected' : ''}>11:00 AM</option>
                        <option value="12dash" ${field.dateTime === '12dash' ? 'selected' : ''}>- 11:00 AM</option>
                        <option value="24" ${field.dateTime === '24' ? 'selected' : ''}>23:00 (24h)</option>
                        <option value="24dash" ${field.dateTime === '24dash' ? 'selected' : ''}>- 23:00 (24h)</option>
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
                currentFields[idx].numberRange = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
            }

            renderFields();
        });
    });

    // Remove button handlers
    // ── Reorder: ↑ ↓, or drag by the grip ──
    // The fill runs top to bottom, so the order is the order the page is filled in.
    const moveField = (from, to) => {
        if (from === to || to < 0 || to >= currentFields.length) return;
        syncFieldInputs();                       // keep unsaved typing
        const [f] = currentFields.splice(from, 1);
        currentFields.splice(to, 0, f);
        renderFields();
        const moved = document.querySelectorAll('.field-item')[to];
        if (moved) { moved.classList.add('just-moved'); setTimeout(() => moved.classList.remove('just-moved'), 700); }
    };
    container.querySelectorAll('.btn-move').forEach((btn) => {
        btn.addEventListener('click', () => {
            const i = parseInt(btn.closest('.field-item').dataset.index);
            moveField(i, i + parseInt(btn.dataset.dir));
        });
    });
    let dragFrom = -1;
    container.querySelectorAll('.field-drag').forEach((grip) => {
        grip.addEventListener('dragstart', (e) => {
            const item = grip.closest('.field-item');
            dragFrom = parseInt(item.dataset.index);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(dragFrom)); e.dataTransfer.setDragImage(item, 20, 20); } catch (err) { }
        });
        grip.addEventListener('dragend', () => {
            dragFrom = -1;
            container.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
        });
    });
    container.querySelectorAll('.field-item').forEach((item) => {
        item.addEventListener('dragover', (e) => {
            if (dragFrom < 0) return;
            e.preventDefault();
            const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
            container.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
            item.classList.add(after ? 'drop-after' : 'drop-before');
        });
        item.addEventListener('drop', (e) => {
            if (dragFrom < 0) return;
            e.preventDefault();
            const over = parseInt(item.dataset.index);
            const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
            let to = over + (after ? 1 : 0);
            if (to > dragFrom) to--;            // the dragged one leaves its old place first
            const from = dragFrom; dragFrom = -1;
            moveField(from, to);
        });
    });

    container.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            syncFieldInputs();     // keep the other fields' unsaved typing
            currentFields.splice(parseInt(btn.dataset.index), 1);
            renderFields();
        });
    });

    // Checkbox handlers - Mutually Exclusive and Mutually Disabling Input
    container.querySelectorAll('.unique-text-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            // the FIELD's index: Click / Wait fields have no checkboxes, so the position in
            // this list is not the field's position (it ticked another field's box)
            const idx = parseInt(cb.closest('.field-item').dataset.index);
            if (!currentFields[idx]) return;
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].uniqueText = true;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].numberRange = false;
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

    container.querySelectorAll('.unique-number-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            // the FIELD's index: Click / Wait fields have no checkboxes, so the position in
            // this list is not the field's position (it ticked another field's box)
            const idx = parseInt(cb.closest('.field-item').dataset.index);
            if (!currentFields[idx]) return;
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].uniqueNumber = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].numberRange = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
            } else {
                currentFields[idx].uniqueNumber = false;
            }
            renderFields();
        });
    });

    // Number range checkbox handler
    container.querySelectorAll('.number-range-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            // the FIELD's index: Click / Wait fields have no checkboxes, so the position in
            // this list is not the field's position (it ticked another field's box)
            const idx = parseInt(cb.closest('.field-item').dataset.index);
            if (!currentFields[idx]) return;
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].numberRange = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].sequentialSelect = false;
                currentFields[idx].isSmartDate = false;
                // Initialize range bounds if not set
                if (currentFields[idx].rangeMin === undefined) currentFields[idx].rangeMin = 1;
                if (currentFields[idx].rangeMax === undefined) currentFields[idx].rangeMax = 100;
            } else {
                currentFields[idx].numberRange = false;
            }
            renderFields();
        });
    });

    // Number range min/max input handlers (read field index from the parent item)
    container.querySelectorAll('.range-min, .range-max').forEach((input) => {
        input.addEventListener('change', () => {
            const item = input.closest('.field-item');
            const idx = item ? parseInt(item.dataset.index) : -1;
            if (!currentFields[idx]) return;
            let v = parseInt(input.value);
            if (isNaN(v)) v = input.classList.contains('range-min') ? 1 : 100;
            input.value = v;
            if (input.classList.contains('range-min')) currentFields[idx].rangeMin = v;
            else currentFields[idx].rangeMax = v;
        });
        input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    });

    // Sequential checkbox handler
    container.querySelectorAll('.sequential-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            // the FIELD's index: Click / Wait fields have no checkboxes, so the position in
            // this list is not the field's position (it ticked another field's box)
            const idx = parseInt(cb.closest('.field-item').dataset.index);
            if (!currentFields[idx]) return;
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].sequentialSelect = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].numberRange = false;
                currentFields[idx].isSmartDate = false;
            } else {
                currentFields[idx].sequentialSelect = false;
            }
            renderFields();
        });
    });

    // Smart Date checkbox handler
    container.querySelectorAll('.smart-date-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            // the FIELD's index: Click / Wait fields have no checkboxes, so the position in
            // this list is not the field's position (it ticked another field's box)
            const idx = parseInt(cb.closest('.field-item').dataset.index);
            if (!currentFields[idx]) return;
            syncFieldInputs();
            if (cb.checked) {
                currentFields[idx].isSmartDate = true;
                currentFields[idx].uniqueText = false;
                currentFields[idx].uniqueNumber = false;
                currentFields[idx].numberRange = false;
                currentFields[idx].sequentialSelect = false;
            } else {
                currentFields[idx].isSmartDate = false;
            }
            renderFields();
        });
    });

    // Digits input handler.
    // NOTE: every field renders two .digits-input elements (one under Unique text,
    // one under Unique number), so the forEach index does NOT map to the field
    // index — read the field index from the parent .field-item instead.
    container.querySelectorAll('.digits-input').forEach((input) => {
        input.addEventListener('change', () => {
            const item = input.closest('.field-item');
            const idx = item ? parseInt(item.dataset.index) : -1;
            if (!currentFields[idx]) return;
            let value = parseInt(input.value);
            if (isNaN(value)) value = 5;
            value = Math.max(1, Math.min(50, value));  // clamp 1–50
            input.value = value;
            currentFields[idx].digits = value;
        });
        input.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    // "Starts with" for Unique number: digits only
    container.querySelectorAll('.prefix-input').forEach((input) => {
        input.addEventListener('input', () => {
            const item = input.closest('.field-item');
            const idx = item ? parseInt(item.dataset.index) : -1;
            const clean = input.value.replace(/\D/g, '');
            if (clean !== input.value) input.value = clean;
            if (currentFields[idx]) currentFields[idx].numberPrefix = clean;
        });
        input.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
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


// ── Smart variable picker ──
// {x} next to a value opens the variables (grouped, searchable, each with a sample of what
// it produces); a click inserts it where the cursor is - no copying from the guide.
(function () {
    const GROUPS = [
        ['Identity', ['full_name', 'first_name', 'last_name', 'random_name', 'username']],
        ['Arabic · عربي', ['full_name_ar', 'first_name_ar', 'last_name_ar', 'address_ar', 'city_ar', 'country_ar', 'company_ar', 'job_title_ar', 'long_text_ar']],
        ['Contact', ['email', 'phone', 'url', 'zip_code']],
        ['Location', ['address', 'city', 'country']],
        ['Dates', ['date', 'time', 'datetime', 'year', 'month', 'day']],
        ['Text & work', ['company', 'job_title', 'long_text', 'age']],
        ['System', ['password', 'guid', 'bool', 'color']],
    ];
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sample = (k) => { try { return self.QASmartVars ? self.QASmartVars.resolve('{{' + k + '}}') : ''; } catch (e) { return ''; } };
    let pop = null, target = null;
    const close = () => { if (pop) pop.remove(); pop = null; target = null; };
    function draw(q) {
        const list = pop.querySelector('.vp-list');
        q = (q || '').toLowerCase().trim();
        list.innerHTML = GROUPS.map(([g, keys]) => {
            const ks = keys.filter((k) => !q || k.includes(q) || g.toLowerCase().includes(q));
            if (!ks.length) return '';
            return `<div class="vp-g">${esc(g)}</div>` + ks.map((k) => {
                const s = sample(k);
                return `<button type="button" class="vp-i" data-k="${k}"><code>{{${k}}}</code><span class="vp-s" dir="auto">${esc(s.length > 42 ? s.slice(0, 42) + '…' : s)}</span></button>`;
            }).join('');
        }).join('') || '<div class="vp-none">No variable matches</div>';
    }
    function open(btn) {
        close();
        target = btn.parentElement.querySelector('.field-input');
        pop = document.createElement('div');
        pop.className = 'var-pop';
        pop.innerHTML = '<input class="vp-q" placeholder="Search variables… (name, city, ar)" spellcheck="false"><div class="vp-list"></div>';
        document.body.appendChild(pop);
        draw('');
        const r = btn.getBoundingClientRect();
        const w = 330, h = Math.min(380, innerHeight - 20);
        pop.style.width = w + 'px'; pop.style.maxHeight = h + 'px';
        pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
        pop.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
        const q = pop.querySelector('.vp-q');
        q.addEventListener('input', () => draw(q.value));
        q.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Enter') { const first = pop.querySelector('.vp-i'); if (first) first.click(); }
        });
        pop.addEventListener('mousedown', (e) => { if (e.target.closest('.vp-i')) e.preventDefault(); });   // keep the caret in the field
        pop.addEventListener('click', (e) => {
            const it = e.target.closest('.vp-i'); if (!it || !target) return;
            const tok = '{{' + it.dataset.k + '}}';
            const a = target.selectionStart != null ? target.selectionStart : target.value.length;
            const z = target.selectionEnd != null ? target.selectionEnd : a;
            target.value = target.value.slice(0, a) + tok + target.value.slice(z);
            target.focus();
            try { target.setSelectionRange(a + tok.length, a + tok.length); } catch (err) { }
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            close();
        });
        setTimeout(() => q.focus(), 0);
    }
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-var');
        if (btn) { e.preventDefault(); if (pop && target === btn.parentElement.querySelector('.field-input')) close(); else open(btn); return; }
        if (pop && !e.target.closest('.var-pop')) close();
    });
    window.addEventListener('resize', close);
    document.addEventListener('scroll', (e) => { if (pop && !(e.target.closest && e.target.closest('.var-pop'))) close(); }, true);
})();
