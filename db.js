// IndexedDB wrapper for Form Filler profiles
// Provides unlimited storage (up to 50% of disk space)

const DB_NAME = 'FormFillerDB';
const DB_VERSION = 1;
const PROFILES_STORE = 'profiles';

let dbInstance = null;

/**
 * Initialize IndexedDB
 * @returns {Promise<IDBDatabase>}
 */
async function initDB() {
    if (dbInstance) return dbInstance;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('IndexedDB error:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            dbInstance = request.result;
            console.log('IndexedDB initialized successfully');
            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Create profiles store if it doesn't exist
            if (!db.objectStoreNames.contains(PROFILES_STORE)) {
                const store = db.createObjectStore(PROFILES_STORE, { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('category', 'category', { unique: false });
                store.createIndex('lastModified', 'lastModified', { unique: false });
                console.log('Created profiles store');
            }
        };
    });
}

/**
 * Get all profiles from IndexedDB
 * @returns {Promise<Array>}
 */
async function getAllProfiles() {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readonly');
        const store = transaction.objectStore(PROFILES_STORE);
        const request = store.getAll();

        request.onsuccess = () => {
            resolve(request.result || []);
        };

        request.onerror = () => {
            console.error('Error getting profiles:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Get a single profile by ID
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
async function getProfile(id) {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readonly');
        const store = transaction.objectStore(PROFILES_STORE);
        const request = store.get(id);

        request.onsuccess = () => {
            resolve(request.result || null);
        };

        request.onerror = () => {
            console.error('Error getting profile:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Save or update a single profile
 * @param {Object} profile 
 * @returns {Promise<void>}
 */
async function saveProfile(profile) {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readwrite');
        const store = transaction.objectStore(PROFILES_STORE);
        const request = store.put(profile);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            console.error('Error saving profile:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Save all profiles (replaces existing data)
 * @param {Array} profiles 
 * @returns {Promise<void>}
 */
async function saveAllProfiles(profiles) {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readwrite');
        const store = transaction.objectStore(PROFILES_STORE);

        // Clear existing data
        const clearRequest = store.clear();

        clearRequest.onsuccess = () => {
            // Add all profiles
            let completed = 0;
            const total = profiles.length;

            if (total === 0) {
                resolve();
                return;
            }

            profiles.forEach(profile => {
                const addRequest = store.put(profile);
                addRequest.onsuccess = () => {
                    completed++;
                    if (completed === total) {
                        resolve();
                    }
                };
                addRequest.onerror = () => {
                    reject(addRequest.error);
                };
            });
        };

        clearRequest.onerror = () => {
            reject(clearRequest.error);
        };
    });
}

/**
 * Delete a profile by ID
 * @param {string} id 
 * @returns {Promise<void>}
 */
async function deleteProfile(id) {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readwrite');
        const store = transaction.objectStore(PROFILES_STORE);
        const request = store.delete(id);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            console.error('Error deleting profile:', request.error);
            reject(request.error);
        };
    });
}

/**
 * Delete multiple profiles by IDs
 * @param {Array<string>} ids 
 * @returns {Promise<void>}
 */
async function deleteProfiles(ids) {
    const db = await initDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROFILES_STORE], 'readwrite');
        const store = transaction.objectStore(PROFILES_STORE);

        let completed = 0;
        const total = ids.length;

        if (total === 0) {
            resolve();
            return;
        }

        ids.forEach(id => {
            const request = store.delete(id);
            request.onsuccess = () => {
                completed++;
                if (completed === total) {
                    resolve();
                }
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    });
}

/**
 * Migrate profiles from chrome.storage.local to IndexedDB
 * @returns {Promise<number>} Number of profiles migrated
 */
async function migrateFromLocalStorage() {
    return new Promise(async (resolve) => {
        try {
            // Check if already migrated
            const existingProfiles = await getAllProfiles();
            if (existingProfiles.length > 0) {
                console.log('IndexedDB already has profiles, skipping migration');
                resolve(0);
                return;
            }

            // Get profiles from local storage
            chrome.storage.local.get(['formFillerProfiles'], async (result) => {
                const profiles = result.formFillerProfiles || [];

                if (profiles.length > 0) {
                    // Sanitize and migrate before saving to IndexedDB
                    const sanitizedProfiles = profiles.map(p => {
                        const profile = { ...p };
                        if (!profile.url && profile.domain) {
                            profile.url = profile.domain;
                        }
                        if (typeof profile.url === 'undefined') {
                            profile.url = '';
                        }
                        return profile;
                    });

                    await saveAllProfiles(sanitizedProfiles);
                    console.log(`Migrated ${profiles.length} profiles to IndexedDB (sanitized)`);

                    // Clear from local storage to free space
                    chrome.storage.local.remove('formFillerProfiles', () => {
                        console.log('Cleared profiles from local storage');
                    });

                    resolve(profiles.length);
                } else {
                    console.log('No profiles to migrate');
                    resolve(0);
                }
            });
        } catch (err) {
            console.error('Migration error:', err);
            resolve(0);
        }
    });
}

/**
 * Get storage statistics
 * @returns {Promise<Object>}
 */
async function getStorageStats() {
    const profiles = await getAllProfiles();
    const totalFields = profiles.reduce((sum, p) => sum + (p.fields?.length || 0), 0);

    // Estimate size
    const dataSize = new Blob([JSON.stringify(profiles)]).size;

    return {
        profileCount: profiles.length,
        fieldCount: totalFields,
        estimatedSizeBytes: dataSize,
        estimatedSizeKB: (dataSize / 1024).toFixed(2),
        estimatedSizeMB: (dataSize / 1024 / 1024).toFixed(2)
    };
}

/**
 * Check if a tab URL matches a profile URL (including sub-paths)
 * @param {string} tabUrl 
 * @param {string} profileUrl 
 * @returns {boolean}
 */
function isUrlMatch(tabUrl, profileUrl) {
    if (!tabUrl || !profileUrl) return false;

    // Normalize URLs for comparison
    const normalize = (u) => {
        if (!u) return '';
        // Strip fragment, remove trailing slash, and ensure protocol
        let val = u.split('#')[0].trim().replace(/\/$/, '');
        if (!val.match(/^[a-zA-Z]+:\/\//)) val = 'https://' + val;
        return val;
    };

    const sTabUrl = normalize(tabUrl);
    const sProfileUrl = normalize(profileUrl);

    // 1. Wildcard Matching Logic
    if (profileUrl.includes('*')) {
        try {
            // Escape special regex characters except *
            let regexStr = sProfileUrl.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            // Replace * with .* to match anything
            regexStr = regexStr.replace(/\*/g, '.*');
            // Create a flexible regex that allows optional trailing slash
            const regex = new RegExp(`^${regexStr}/?$`, 'i');

            // Test both the normalized and original-like standardized versions
            if (regex.test(sTabUrl) || regex.test(sTabUrl + '/')) return true;
        } catch (e) {
            console.warn('Wildcard regex error:', e);
        }
    }

    // 2. Exact or Prefix Matching Logic
    try {
        const tabObj = new URL(sTabUrl + '/'); // Add slash for URL constructor normalization
        const profObj = new URL(sProfileUrl + '/');

        // Origins must match (includes protocol, host, and port)
        if (tabObj.origin !== profObj.origin) return false;

        const tabPath = tabObj.pathname.toLowerCase().replace(/\/$/, '');
        const profPath = profObj.pathname.toLowerCase().replace(/\/$/, '');

        // Exact path match
        if (tabPath === profPath) return true;

        // Sub-path match
        return tabPath.startsWith(profPath + '/');
    } catch (e) {
        // Fallback for non-standard URLs
        return sTabUrl === sProfileUrl || sTabUrl.startsWith(sProfileUrl + '/');
    }
}

// Export for use in both window (popup/editor) and service worker (background)
const exportTarget = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window);
exportTarget.FormFillerDB = {
    initDB,
    getAllProfiles,
    getProfile,
    saveProfile,
    saveAllProfiles,
    deleteProfile,
    deleteProfiles,
    migrateFromLocalStorage,
    getStorageStats,
    isUrlMatch
};
