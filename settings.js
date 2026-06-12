let availableCategories = [];

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadCategories();

    // Toggle Handlers
    document.getElementById('floatingButtonToggle').addEventListener('change', (e) => updateSetting('showFloatingButton', e.target.checked));
    document.getElementById('autoCloseToggle').addEventListener('change', (e) => updateSetting('autoClose', e.target.checked));

    // AI Save Behavior Handler
    document.getElementById('aiSaveBehaviorSelect').addEventListener('change', async (e) => {
        await chrome.storage.local.set({ aiSaveBehavior: e.target.value });
        showToast('Settings saved!');
    });

    // Category Handlers
    document.getElementById('addCategoryBtn').addEventListener('click', addCategory);
    document.getElementById('newCategoryInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') addCategory(); });

    // Backup Handlers
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importInput').click());
    document.getElementById('importInput').addEventListener('change', importData);
});

async function loadSettings() {
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5, showFloatingButton: true, autoClose: false };

    document.getElementById('floatingButtonToggle').checked = !!settings.showFloatingButton;
    document.getElementById('autoCloseToggle').checked = !!settings.autoClose;

    // AI save behavior lives in local storage (set here or via the on-page prompt)
    const aiResult = await chrome.storage.local.get(['aiSaveBehavior', 'aiAutoSaveProfiles']);
    const behavior = aiResult.aiSaveBehavior || (aiResult.aiAutoSaveProfiles ? 'always' : 'ask');
    document.getElementById('aiSaveBehaviorSelect').value = behavior;
}

async function updateSetting(key, value) {
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5 };

    // Explicitly handle boolean types for toggles
    if (key === 'showFloatingButton' || key === 'autoClose') {
        settings[key] = !!value;
    } else {
        settings[key] = value;
    }

    await chrome.storage.sync.set({ formFillerSettings: settings });
    showToast('Settings saved!');

    if (key === 'showFloatingButton') {
        const tabs = await chrome.tabs.query({});
        tabs.forEach(tab => {
            if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { action: 'updateFloatingButton', enabled: value }).catch(() => { });
            }
        });
    }
}

async function loadCategories() {
    const result = await chrome.storage.sync.get(['formFillerCategories']);
    availableCategories = result.formFillerCategories || ["General", "Work", "Personal", "Testing", "عام"];

    // Ensure "عام" always exists
    if (!availableCategories.some(c => c === "عام")) {
        availableCategories.push("عام");
        await chrome.storage.sync.set({ formFillerCategories: availableCategories });
    }

    renderCategories();
}

async function renderCategories() {
    const list = document.getElementById('categoryList');

    // Get all profiles to check which categories are in use
    let profiles = [];
    try {
        profiles = await FormFillerDB.getAllProfiles();
    } catch (e) {
        console.error("Error fetching profiles for category check:", e);
    }

    const usedCategories = new Set(profiles.map(p => p.category).filter(Boolean));

    list.innerHTML = availableCategories.map(cat => {
        const isAam = cat === "عام";
        const isUsed = usedCategories.has(cat);
        const canDelete = !isAam && !isUsed;

        return `
            <div class="category-item">
                <span>${cat} ${isUsed ? '<small style="color:#666; font-size:10px; margin-left:8px;">(In use)</small>' : ''}</span>
                ${canDelete ?
                `<button class="btn-delete-cat" data-name="${cat}"><i class="fas fa-trash"></i></button>` :
                `<span style="color: #444; font-size: 12px;" title="${isAam ? 'Default category cannot be deleted' : 'Category is in use and cannot be deleted'}"><i class="fas fa-lock"></i></span>`
            }
            </div>
        `;
    }).join('');

    list.querySelectorAll('.btn-delete-cat').forEach(btn => {
        btn.addEventListener('click', () => deleteCategory(btn.dataset.name));
    });
}

async function deleteCategory(name) {
    if (name === "عام") {
        showToast('Cannot delete default category');
        return;
    }

    // Extra safety check: check if used by profiles
    const profiles = await FormFillerDB.getAllProfiles();
    const isUsed = profiles.some(p => p.category === name);
    if (isUsed) {
        showToast('Cannot delete category because it is in use');
        return;
    }

    availableCategories = availableCategories.filter(c => c !== name);
    await chrome.storage.sync.set({ formFillerCategories: availableCategories });
    renderCategories();
    showToast('Category deleted');
}

async function addCategory() {
    const input = document.getElementById('newCategoryInput');
    const name = input.value.trim();
    if (!name) return;
    if (availableCategories.some(c => c.toLowerCase() === name.toLowerCase())) {
        showToast('Category already exists');
        return;
    }
    availableCategories.push(name);
    await chrome.storage.sync.set({ formFillerCategories: availableCategories });
    input.value = '';
    renderCategories();
    showToast('Category added');
}

async function exportData() {
    try {
        const profiles = await FormFillerDB.getAllProfiles();

        if (profiles.length === 0) {
            showToast('No profiles to export');
            return;
        }

        const categories = availableCategories;
        const exportDate = new Date();

        const data = {
            profiles,
            categories,
            version: '1.0',
            timestamp: exportDate.getTime(),
            exportDate: exportDate.toISOString(),
            profileCount: profiles.length,
            fieldCount: profiles.reduce((sum, p) => sum + (p.fields?.length || 0), 0)
        };

        console.log('Exporting data:', {
            profiles: profiles.length,
            categories: categories.length,
            totalFields: data.fieldCount
        });

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `form-filler-backup-${exportDate.toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Exported ${profiles.length} profile(s) successfully`);
    } catch (e) {
        console.error('Export error:', e);
        showToast('Export failed: ' + e.message);
    }
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Reset file input to allow re-importing the same file
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);

            // Validate file structure
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid backup file format');
            }

            if (!data.profiles || !Array.isArray(data.profiles)) {
                throw new Error('Backup file must contain a profiles array');
            }

            if (data.profiles.length === 0) {
                showToast('Backup file contains no profiles');
                return;
            }

            // Log import info
            console.log('Importing backup file:', {
                version: data.version || 'unknown',
                exportDate: data.exportDate || (data.timestamp ? new Date(data.timestamp).toISOString() : 'unknown'),
                profiles: data.profiles.length,
                categories: data.categories?.length || 0,
                totalFields: data.fieldCount || data.profiles.reduce((sum, p) => sum + (p.fields?.length || 0), 0)
            });

            // Sanitize and migrate profiles
            const sanitizedProfiles = data.profiles.map((p, index) => {
                try {
                    const profile = { ...p };

                    // Ensure required profile fields
                    if (!profile.id) {
                        // Generate new ID if missing
                        profile.id = `imported_${Date.now()}_${index}`;
                    }
                    if (!profile.name) {
                        profile.name = `Imported Profile ${index + 1}`;
                    }

                    // Migrate domain to url if url is missing
                    if (!profile.url && profile.domain) {
                        profile.url = profile.domain;
                    }
                    // Ensure url exists
                    if (typeof profile.url === 'undefined') {
                        profile.url = '';
                    }

                    // Ensure category exists
                    if (!profile.category) {
                        profile.category = 'عام';
                    }

                    // Sanitize fields - preserve all new fields
                    if (profile.fields && Array.isArray(profile.fields)) {
                        profile.fields = profile.fields.map((f, fieldIndex) => {
                            try {
                                return {
                                    ...f,
                                    // Required fields
                                    selector: f.selector || '',
                                    value: f.value || '',
                                    // Action type (fill, click, wait)
                                    actionType: f.actionType || 'fill',
                                    type: f.type || 'text',
                                    // Smart variables
                                    uniqueText: !!f.uniqueText,
                                    uniqueNumber: !!f.uniqueNumber,
                                    sequentialSelect: f.sequentialSelect !== undefined ? !!f.sequentialSelect : (f.isSequential !== undefined ? !!f.isSequential : false),
                                    // Smart date settings
                                    isSmartDate: !!f.isSmartDate,
                                    dateDirection: f.dateDirection || 'future',
                                    dateFormat: f.dateFormat || 'DD/MM/YYYY',
                                    dateSeparator: f.dateSeparator || '/',
                                    // Unique number digits (1-50)
                                    digits: (f.digits !== undefined && f.digits !== null) ? Math.min(Math.max(parseInt(f.digits) || 5, 1), 50) : 5
                                };
                            } catch (fieldError) {
                                console.error(`Error sanitizing field ${fieldIndex} in profile ${profile.name}:`, fieldError);
                                // Return minimal valid field
                                return {
                                    selector: f.selector || '',
                                    value: f.value || '',
                                    actionType: 'fill',
                                    type: 'text',
                                    uniqueText: false,
                                    uniqueNumber: false,
                                    sequentialSelect: false,
                                    isSmartDate: false,
                                    dateDirection: 'future',
                                    dateFormat: 'DD/MM/YYYY',
                                    dateSeparator: '/',
                                    digits: 5
                                };
                            }
                        }).filter(f => f.selector); // Remove fields with empty selectors
                    } else {
                        profile.fields = [];
                    }

                    // Ensure other required fields
                    if (!profile.lastModified) {
                        profile.lastModified = Date.now();
                    }
                    if (typeof profile.onReload === 'undefined') {
                        profile.onReload = false;
                    }

                    return profile;
                } catch (profileError) {
                    console.error(`Error sanitizing profile ${index}:`, profileError);
                    // Return minimal valid profile
                    return {
                        id: `imported_${Date.now()}_${index}`,
                        name: `Imported Profile ${index + 1}`,
                        category: 'عام',
                        url: '',
                        fields: [],
                        onReload: false,
                        lastModified: Date.now()
                    };
                }
            });

            // Merge profiles
            const existingProfiles = await FormFillerDB.getAllProfiles();
            const existingIds = new Set(existingProfiles.map(p => String(p.id)));

            const newProfiles = sanitizedProfiles.filter(p => !existingIds.has(String(p.id)));
            const updatedProfiles = sanitizedProfiles.filter(p => existingIds.has(String(p.id)));
            const mergedProfiles = [...existingProfiles, ...newProfiles];

            console.log(`Import: ${newProfiles.length} new profiles, ${updatedProfiles.length} existing profiles (skipped)`);

            await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'saveProfiles', profiles: mergedProfiles }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (response && response.success) {
                        resolve();
                    } else {
                        reject(new Error(response?.error || 'Failed to save profiles'));
                    }
                });
            });

            // Merge categories
            if (data.categories && Array.isArray(data.categories)) {
                const catSet = new Set([...availableCategories, ...data.categories]);
                availableCategories = Array.from(catSet);
                await chrome.storage.sync.set({ formFillerCategories: availableCategories });
                console.log('Merged categories:', availableCategories.length);
            }

            renderCategories();

            if (newProfiles.length > 0) {
                showToast(`Successfully imported ${newProfiles.length} profile(s)`);
            } else {
                showToast('No new profiles to import (all profiles already exist)');
            }
        } catch (err) {
            console.error('Import error:', err);
            showToast('Import failed: ' + err.message);
        }
    };

    reader.onerror = () => {
        showToast('Failed to read backup file');
    };

    reader.readAsText(file);
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}
