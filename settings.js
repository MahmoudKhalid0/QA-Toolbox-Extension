let availableCategories = [];

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadCategories();

    // Toggle Handlers
    document.getElementById('floatingButtonToggle').addEventListener('change', (e) => updateSetting('showFloatingButton', e.target.checked));
    document.getElementById('fieldAiIconToggle').addEventListener('change', (e) => updateSetting('fieldAiIcon', e.target.checked));
    document.getElementById('charCounterToggle').addEventListener('change', (e) => updateSetting('charCounter', e.target.checked));
    document.getElementById('selectionAiToggle').addEventListener('change', (e) => updateSetting('selectionAiTools', e.target.checked));

    // Clear Browsing Data settings
    initClearData();

    // AI Save Behavior Handler
    document.getElementById('aiSaveBehaviorSelect').addEventListener('change', async (e) => {
        await chrome.storage.local.set({ aiSaveBehavior: e.target.value });
        chrome.runtime.sendMessage({ action: 'scheduleCloudPush' }).catch(() => { });
        showToast('Settings saved!');
    });

    // Category Handlers
    document.getElementById('addCategoryBtn').addEventListener('click', addCategory);
    document.getElementById('newCategoryInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') addCategory(); });

    // Backup Handlers
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importInput').click());
    document.getElementById('importInput').addEventListener('change', importData);

    // Cloud Sync Handlers
    refreshSyncUi();
    document.getElementById('syncSignInBtn').addEventListener('click', syncSignIn);
    document.getElementById('syncNowBtn').addEventListener('click', syncNow);
    document.getElementById('syncSignOutBtn').addEventListener('click', syncSignOut);

    // Opened via the side panel's Login button - start the Google sign-in directly
    if (new URLSearchParams(location.search).get('signin')) {
        const meta = await chrome.runtime.sendMessage({ action: 'syncStatus' }).catch(() => null);
        if (!meta || !meta.signedIn) {
            document.getElementById('syncSignedOut').scrollIntoView({ behavior: 'smooth', block: 'center' });
            syncSignIn();
        }
    }
});

// Data changed elsewhere (cloud sync, recording, editor) - refresh the page UI
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'profilesUpdated') {
        loadSettings();
        loadCategories();
        refreshSyncUi();
    }
});

// ---- Cloud Sync UI ----

function formatSyncTime(ts) {
    if (!ts) return 'Not synced yet';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'Synced just now';
    if (mins < 60) return `Synced ${mins} min ago`;
    return 'Synced ' + new Date(ts).toLocaleString();
}

async function refreshSyncUi() {
    const meta = await chrome.runtime.sendMessage({ action: 'syncStatus' }).catch(() => null);
    const signedOut = document.getElementById('syncSignedOut');
    const signedIn = document.getElementById('syncSignedIn');
    if (meta && meta.signedIn) {
        signedOut.style.display = 'none';
        signedIn.style.display = 'block';
        document.getElementById('syncEmail').textContent = meta.email || 'Google account';
        document.getElementById('syncStatusText').textContent =
            meta.lastError ? `Sync error: ${meta.lastError}` : formatSyncTime(meta.lastSyncAt);
    } else {
        signedOut.style.display = 'block';
        signedIn.style.display = 'none';
    }
}

async function syncSignIn() {
    const btn = document.getElementById('syncSignInBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
    const result = await chrome.runtime.sendMessage({ action: 'syncSignIn' }).catch(e => ({ error: String(e) }));
    btn.disabled = false;
    btn.innerHTML = '<i class="fab fa-google"></i> Sign in with Google';
    if (result && result.success) {
        showToast('Signed in - data synced!');
        await loadCategories(); // sync may have merged categories from the cloud
    } else {
        showToast(result && result.error ? `Sign-in failed: ${result.error}` : 'Sign-in failed');
    }
    refreshSyncUi();
}

async function syncNow() {
    const btn = document.getElementById('syncNowBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
    const result = await chrome.runtime.sendMessage({ action: 'syncNow' }).catch(e => ({ error: String(e) }));
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-rotate"></i> Sync Now';
    showToast(result && result.success ? 'Sync complete!' : 'Sync failed - check your connection');
    if (result && result.success) await loadCategories();
    refreshSyncUi();
}

async function syncSignOut() {
    await chrome.runtime.sendMessage({ action: 'syncSignOut' }).catch(() => { });
    showToast('Signed out. Your local data stays on this device.');
    refreshSyncUi();
}

// ---- Clear Browsing Data settings (stored in local as 'qaClearData') ----
const CLR_TYPES = [
    ['cache', 'Cache'], ['cacheStorage', 'Cache Storage'], ['cookies', 'Cookies'],
    ['fileSystems', 'File Systems'], ['indexedDB', 'IndexedDB'], ['localStorage', 'Local Storage'],
    ['serviceWorkers', 'Service Workers'], ['webSQL', 'WebSQL'],
    ['downloads', 'Downloads'], ['formData', 'Form Data'], ['history', 'History'], ['passwords', 'Passwords']
];
const CLR_DEFAULT = {
    activeTab: true, span: 0, reload: true, confirm: false,
    types: { cache: true, cacheStorage: true, cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, fileSystems: false, webSQL: false, downloads: false, formData: false, history: false, passwords: false }
};

async function initClearData() {
    const res = await chrome.storage.local.get('qaClearData');
    const cfg = Object.assign({}, CLR_DEFAULT, res.qaClearData || {});
    cfg.types = Object.assign({}, CLR_DEFAULT.types, cfg.types || {});
    cfg.auto = Object.assign({ startup: false, tabClose: false, domains: [] }, cfg.auto || {});

    const save = () => { chrome.storage.local.set({ qaClearData: cfg }); showToast('Settings saved!'); };

    document.getElementById('clrActiveTab').checked = cfg.activeTab !== false;
    document.getElementById('clrReload').checked = cfg.reload !== false;
    document.getElementById('clrConfirm').checked = !!cfg.confirm;
    document.getElementById('clrSpan').value = String(cfg.span || 0);

    // Automation
    document.getElementById('autoStartup').checked = !!cfg.auto.startup;
    document.getElementById('autoTabClose').checked = !!cfg.auto.tabClose;
    document.getElementById('autoStartup').addEventListener('change', (e) => { cfg.auto.startup = e.target.checked; save(); });
    document.getElementById('autoTabClose').addEventListener('change', (e) => { cfg.auto.tabClose = e.target.checked; save(); });

    // Automation domains list
    const domListEl = document.getElementById('autoDomainList');
    const domInput = document.getElementById('autoDomainInput');
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const renderDomains = () => {
        const ds = cfg.auto.domains || [];
        domListEl.innerHTML = !ds.length
            ? '<div style="font-size:12px; color:#64748b;">No domains — clears all sites.</div>'
            : ds.map((d, i) => `<div class="category-item"><span>${esc(d)}</span><button class="btn-delete-cat" data-domdel="${i}" title="Remove"><i class="fas fa-xmark"></i></button></div>`).join('');
    };
    const addDomain = () => {
        let d = (domInput.value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
        if (!d || !/\./.test(d)) { domInput.style.borderColor = '#ef4444'; return; }
        domInput.style.borderColor = '';
        if (!cfg.auto.domains.includes(d)) cfg.auto.domains.push(d);
        domInput.value = ''; save(); renderDomains();
    };
    renderDomains();
    document.getElementById('autoDomainAdd').addEventListener('click', addDomain);
    domInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addDomain(); });
    domInput.addEventListener('blur', () => { if (domInput.value.trim()) addDomain(); }); // don't lose a typed-but-unadded domain
    domListEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-domdel]'); if (!b) return;
        cfg.auto.domains.splice(+b.dataset.domdel, 1); save(); renderDomains();
    });

    // In "Active tab only": these are blocked (privacy-sensitive, browser-wide).
    // Cache is still allowed but always clears all sites.
    const SITE_DISABLED = ['downloads', 'formData', 'history', 'passwords'];
    const typesEl = document.getElementById('clrTypes');
    const renderTypes = () => {
        const siteMode = document.getElementById('clrActiveTab').checked;
        typesEl.innerHTML = CLR_TYPES.map(([k, label]) => {
            const disabled = siteMode && SITE_DISABLED.includes(k);
            const allSites = siteMode && k === 'cache';
            const tag = disabled ? ' <span style="color:#64748b; font-size:11px;">all sites only</span>'
                : allSites ? ' <span style="color:#f59e0b; font-size:11px;">&#9888; all sites</span>' : '';
            return `<label class="clr-chk ${disabled ? 'dim' : ''}"${disabled ? ' title="Turn off Active tab only to clear this for all sites"' : ''}>
                <input type="checkbox" data-type="${k}" ${cfg.types[k] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                <span>${label}${tag}</span></label>`;
        }).join('');
    };
    renderTypes();

    document.getElementById('clrActiveTab').addEventListener('change', (e) => { cfg.activeTab = e.target.checked; save(); renderTypes(); });
    document.getElementById('clrReload').addEventListener('change', (e) => { cfg.reload = e.target.checked; save(); });
    document.getElementById('clrConfirm').addEventListener('change', (e) => { cfg.confirm = e.target.checked; save(); });
    document.getElementById('clrSpan').addEventListener('change', (e) => { cfg.span = parseInt(e.target.value, 10) || 0; save(); });
    typesEl.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-type]'); if (!cb) return;
        cfg.types[cb.dataset.type] = cb.checked; save();
    });
    document.querySelectorAll('.clr-sel').forEach(a => a.addEventListener('click', () => {
        const sel = a.dataset.sel;
        CLR_TYPES.forEach(([k]) => { cfg.types[k] = sel === 'all' ? true : sel === 'none' ? false : CLR_DEFAULT.types[k]; });
        renderTypes(); save();
    }));
}

async function loadSettings() {
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5, showFloatingButton: true };

    document.getElementById('floatingButtonToggle').checked = !!settings.showFloatingButton;
    document.getElementById('fieldAiIconToggle').checked = settings.fieldAiIcon !== false;
    document.getElementById('charCounterToggle').checked = settings.charCounter !== false;
    document.getElementById('selectionAiToggle').checked = settings.selectionAiTools !== false;

    // AI save behavior lives in local storage (set here or via the on-page prompt)
    const aiResult = await chrome.storage.local.get(['aiSaveBehavior', 'aiAutoSaveProfiles']);
    const behavior = aiResult.aiSaveBehavior || (aiResult.aiAutoSaveProfiles ? 'always' : 'ask');
    document.getElementById('aiSaveBehaviorSelect').value = behavior;
}

async function updateSetting(key, value) {
    const result = await chrome.storage.sync.get(['formFillerSettings']);
    const settings = result.formFillerSettings || { randomDigits: 5 };

    // Explicitly handle boolean types for toggles
    if (key === 'showFloatingButton' || key === 'fieldAiIcon' || key === 'charCounter' || key === 'selectionAiTools') {
        settings[key] = !!value;
    } else {
        settings[key] = value;
    }

    await chrome.storage.sync.set({ formFillerSettings: settings });
    chrome.runtime.sendMessage({ action: 'scheduleCloudPush' }).catch(() => { });
    showToast('Settings saved!');

    // Push the relevant change to open pages
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
        if (!tab.id) return;
        if (key === 'showFloatingButton') {
            chrome.tabs.sendMessage(tab.id, { action: 'recheckFloatingButton' }).catch(() => { });
        }
        if (key === 'fieldAiIcon' || key === 'charCounter' || key === 'selectionAiTools') {
            chrome.tabs.sendMessage(tab.id, { action: 'settingsChanged' }).catch(() => { });
        }
    });
}

async function loadCategories() {
    const result = await chrome.storage.sync.get(['formFillerCategories']);
    availableCategories = result.formFillerCategories || ["General"];

    // "General" is the only built-in category and always exists
    if (!availableCategories.includes("General")) {
        availableCategories.unshift("General");
        await saveCategories();
    }

    renderCategories();
}

// Persist categories with a timestamp so cloud sync can pick the newest list
// (last-write-wins) instead of resurrecting deleted categories
async function saveCategories() {
    await chrome.storage.sync.set({
        formFillerCategories: availableCategories,
        formFillerCategoriesUpdatedAt: Date.now()
    });
    chrome.runtime.sendMessage({ action: 'scheduleCloudPush' }).catch(() => { });
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
        const isGeneral = cat === "General";
        const isUsed = usedCategories.has(cat);
        const canDelete = !isGeneral && !isUsed;

        return `
            <div class="category-item">
                <span>${cat} ${isUsed ? '<small style="color:#666; font-size:10px; margin-left:8px;">(In use)</small>' : ''}</span>
                ${canDelete ?
                `<button class="btn-delete-cat" data-name="${cat}"><i class="fas fa-trash"></i></button>` :
                `<span style="color: #444; font-size: 12px;" title="${isGeneral ? 'Default category cannot be deleted' : 'Category is in use and cannot be deleted'}"><i class="fas fa-lock"></i></span>`
            }
            </div>
        `;
    }).join('');

    list.querySelectorAll('.btn-delete-cat').forEach(btn => {
        btn.addEventListener('click', () => deleteCategory(btn.dataset.name));
    });
}

async function deleteCategory(name) {
    if (name === "General") {
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
    await saveCategories();
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
    await saveCategories();
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
                        profile.category = 'General';
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
                        category: 'General',
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
                await saveCategories();
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

// ── Screenshot & Record settings ────────────────────────────────────────────

(function captureSettings() {
    const eye = document.getElementById('capEyeToggle');
    const delay = document.getElementById('capDelaySeconds');
    if (!eye || !delay) return;

    chrome.storage.local.get(['capEyeEnabled'], (r) => { eye.checked = !!r.capEyeEnabled; });
    eye.addEventListener('change', () => {
        // the background adds/removes the eye across every open tab
        chrome.runtime.sendMessage({ action: 'capEyeSetting', enabled: eye.checked });
        showToast(eye.checked ? 'Capture button shown on pages' : 'Capture button hidden');
    });

    // delaySeconds lives in storage.sync: the capture module already reads it there
    chrome.storage.sync.get(['delaySeconds'], (r) => {
        const v = String(r.delaySeconds || 3);
        if ([...delay.options].some(o => o.value === v)) delay.value = v;
    });
    delay.addEventListener('change', () => {
        chrome.storage.sync.set({ delaySeconds: parseInt(delay.value, 10) }, () => {
            showToast(`Countdown set to ${delay.value}s`);
        });
    });
})();

// ── Section navigation ──────────────────────────────────────────────────────
// Presentation only: the cards and their controls are untouched, just paged.

(function settingsNav() {
    const items = document.querySelectorAll('.nav-item');
    if (!items.length) return;

    const show = (slug) => {
        items.forEach(b => b.classList.toggle('active', b.dataset.pane === slug));
        document.querySelectorAll('.pane').forEach(p => p.classList.toggle('hidden', p.id !== 'pane-' + slug));
        try { localStorage.setItem('qaSettingsPane', slug); } catch (e) { }
    };

    items.forEach(b => b.addEventListener('click', () => show(b.dataset.pane)));

    // ?pane=cloud-sync deep-links here (the panel's "Sign in" link uses it)
    const wanted = new URLSearchParams(location.search).get('pane');
    let saved = null;
    try { saved = localStorage.getItem('qaSettingsPane'); } catch (e) { }
    const target = wanted || saved;
    if (target && document.getElementById('pane-' + target)) show(target);
})();
