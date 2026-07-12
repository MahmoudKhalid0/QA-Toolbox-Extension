// Local capture library (IndexedDB).
//
// Every capture is saved here the moment it is taken, together with the page
// context collected at that instant — console errors, failed requests, URL,
// browser, viewport. Uploading to the cloud is optional and only adds a link.
//
// Blobs, not data URLs: a 4K screenshot is ~8 MB as base64 but ~3 MB as a Blob,
// and IndexedDB stores Blobs natively.
//
// Loaded by the service worker (importScripts) and by the gallery page (<script>).

const CAP_DB_NAME = 'qa-captures';
const CAP_DB_VERSION = 2;
const CAP_STORE = 'items';
// Hand-off store: a capture on its way to the editor but not yet in the library
// (the library only ever holds what was saved or shared). It exists so a
// recording can travel as a Blob. It used to travel as a base64 data URL - the
// recorder turned the Blob into a ~33%-larger string on the main thread, pushed
// that string through a runtime message, the worker wrote it into
// chrome.storage.local, the editor read it back out and re-parsed it. For a
// long recording that is tens of megabytes copied and re-encoded four times over
// before a single frame could be shown - which is the whole of the wait between
// hitting Stop and the editor appearing.
const CAP_PENDING = 'pending';

function capOpenDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(CAP_DB_NAME, CAP_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(CAP_STORE)) {
                const store = db.createObjectStore(CAP_STORE, { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt');
                store.createIndex('type', 'type');
            }
            if (!db.objectStoreNames.contains(CAP_PENDING)) {
                db.createObjectStore(CAP_PENDING, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Same as capTx, against the hand-off store.
function capPendingTx(mode, fn) {
    return capOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(CAP_PENDING, mode);
        let value;
        try {
            const req = fn(tx.objectStore(CAP_PENDING));
            if (req && 'onsuccess' in req) req.onsuccess = () => { value = req.result; };
        } catch (e) { db.close(); reject(e); return; }
        tx.oncomplete = () => { db.close(); resolve(value); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
    }));
}

function capPutPending(id, blob) {
    return capPendingTx('readwrite', (store) => store.put({ id: String(id), blob, createdAt: Date.now() }));
}

function capGetPending(id) {
    return capPendingTx('readonly', (store) => store.get(String(id))).then(v => (v && v.blob) || null);
}

function capDropPending(id) {
    return capPendingTx('readwrite', (store) => store.delete(String(id)));
}

// A recording the editor was never opened for (the tab was closed, the browser
// crashed) would otherwise sit in the database for good.
async function capSweepPending(maxAgeMs = 24 * 60 * 60 * 1000) {
    const all = await capPendingTx('readonly', (store) => store.getAll());
    const stale = (all || []).filter(r => Date.now() - (r.createdAt || 0) > maxAgeMs);
    for (const r of stale) await capDropPending(r.id);
    return stale.length;
}

// Runs fn(store) inside a transaction and resolves with whatever fn's request
// yielded, after the transaction commits.
function capTx(mode, fn) {
    return capOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(CAP_STORE, mode);
        let value;
        try {
            const req = fn(tx.objectStore(CAP_STORE));
            if (req && 'onsuccess' in req) req.onsuccess = () => { value = req.result; };
        } catch (e) { db.close(); reject(e); return; }
        tx.oncomplete = () => { db.close(); resolve(value); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
    }));
}

// ── thumbnails ──────────────────────────────────────────────────────────────
// Generated where the capture happens (the worker has OffscreenCanvas), so the
// gallery never has to decode full-size images just to draw a grid.

async function capMakeThumb(blob, maxW = 480) {
    try {
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, maxW / bmp.width);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close();
        return await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
    } catch (e) {
        return null;   // videos, or a codec the worker cannot decode
    }
}

const capDataUrlToBlob = (dataUrl) => fetch(dataUrl).then(r => r.blob());

// ── public API ──────────────────────────────────────────────────────────────

async function capSave(record) {
    const item = Object.assign({
        id: String(record.id || Date.now()),
        type: 'image',
        title: 'Capture',
        pageUrl: '',
        createdAt: Date.now(),
        ctx: null,
        cloudUrl: null
    }, record);

    if (!item.blob && item.dataUrl) item.blob = await capDataUrlToBlob(item.dataUrl);
    delete item.dataUrl;
    if (!item.blob) throw new Error('capSave: nothing to store');

    item.size = item.blob.size;
    if (!item.thumb && item.type === 'image') item.thumb = await capMakeThumb(item.blob);

    await capTx('readwrite', (store) => store.put(item));
    return item.id;
}

// Metadata only: the full-size blob never enters the grid.
function capList() {
    return capOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(CAP_STORE, 'readonly');
        const out = [];
        tx.objectStore(CAP_STORE).openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return;
            const { blob, ...meta } = c.value;
            out.push(meta);
            c.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(out.sort((a, b) => b.createdAt - a.createdAt)); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    }));
}

function capGet(id) {
    return capTx('readonly', (store) => store.get(String(id))).then(v => v || null);
}

function capDelete(id) {
    return capTx('readwrite', (store) => store.delete(String(id)));
}

function capClear() {
    return capTx('readwrite', (store) => store.clear());
}

async function capPatch(id, patch) {
    const existing = await capGet(id);
    if (!existing) return null;
    const merged = Object.assign(existing, patch);
    if (patch.blob && merged.type === 'image') merged.thumb = await capMakeThumb(patch.blob);
    merged.size = merged.blob ? merged.blob.size : merged.size;
    await capTx('readwrite', (store) => store.put(merged));
    return merged.id;
}

const capStoreExport = typeof globalThis !== 'undefined' ? globalThis : self;
capStoreExport.CapStore = {
    save: capSave,
    list: capList,
    get: capGet,
    patch: capPatch,
    remove: capDelete,
    clear: capClear,
    dataUrlToBlob: capDataUrlToBlob,
    // Blob hand-off from the recorder to the editor - no base64 anywhere.
    putPending: capPutPending,
    getPending: capGetPending,
    dropPending: capDropPending,
    sweepPending: capSweepPending
};
