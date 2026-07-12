import { getBugConfig, saveBugConfig, azureOrgs, jiraProjects, jiraCreateMeta, jiraCreateFields, jiraFieldSupported, jiraFieldOptions, jiraLinkTypes, jiraIssuePicker, jiraCreateBug, azureFieldOptions, contextHtml } from './trackers.js';

// Helper for custom modals (replaces alert/confirm)
function showCustomModal({ title, message, showInput = false, inputValue = '', primaryText = 'Confirm', secondaryText = 'Cancel' }) {
    const modal = document.getElementById('customModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalInputContainer = document.getElementById('modalInputContainer');
    const modalInput = document.getElementById('modalInput');
    const modalPrimaryBtn = document.getElementById('modalPrimaryBtn');
    const modalSecondaryBtn = document.getElementById('modalSecondaryBtn');
    const modalCloseBtn = document.getElementById('modalCloseBtn');

    if (!modal) return Promise.resolve(showInput ? inputValue : true);

    modalTitle.textContent = title;
    modalMessage.textContent = message;
    if (showInput) {
        modalInputContainer.style.display = 'block';
        modalInput.value = inputValue;
        setTimeout(() => modalInput.focus(), 100);
    } else {
        modalInputContainer.style.display = 'none';
    }
    modalPrimaryBtn.textContent = primaryText;
    modalSecondaryBtn.textContent = secondaryText;
    modalSecondaryBtn.style.display = secondaryText ? 'inline-block' : 'none';

    modal.style.display = 'flex';
    modal.classList.add('show');

    return new Promise((resolve) => {
        const cleanup = (value) => {
            modal.style.display = 'none';
            modal.classList.remove('show');
            modalPrimaryBtn.onclick = null;
            modalSecondaryBtn.onclick = null;
            modalCloseBtn.onclick = null;
            resolve(value);
        };

        modalPrimaryBtn.onclick = () => {
            if (showInput) {
                const val = modalInput.value.trim();
                if (!val) {
                    modalInput.classList.add('shake');
                    setTimeout(() => modalInput.classList.remove('shake'), 400);
                    return;
                }
                cleanup(val);
            } else {
                cleanup(true);
            }
        };

        modalInput.onkeydown = (e) => {
            if (e.key === 'Enter') modalPrimaryBtn.click();
        };

        modalSecondaryBtn.onclick = () => cleanup(false);
        modalCloseBtn.onclick = () => cleanup(false);

        modal.onclick = (e) => {
            if (e.target === modal) cleanup(false);
        };
    });
}

// Helper to show/hide loader
function toggleLoader(show, text = "Processing...") {
    const loader = document.getElementById('globalLoader');
    const loaderText = document.getElementById('loaderText');
    if (loader && loaderText) {
        loaderText.textContent = text;
        if (show) {
            loader.style.display = 'flex';
            loader.classList.add('show');
        } else {
            loader.style.display = 'none';
            loader.classList.remove('show');
        }
    }
    // The page boots hidden (body.booting) so an empty canvas and the image
    // toolbar cannot flash before we know whether this is a picture or a
    // recording. Hiding the loader IS the moment there is something real to
    // look at - and every load path, success or failure, comes through here,
    // so nothing can get stranded behind a blank screen.
    if (!show) document.body.classList.remove('booting');
}

// Helper to convert DataURL to File
// fetch()'s native decoder, not atob() + a byte-by-byte JS loop: for a large
// recording (many MB of base64) the manual loop runs synchronously on the
// main thread and is genuinely slow - this is most of why a long recording
// takes a very long time to actually appear once the editor tab opens.
async function dataURLtoFile(dataurl, filename) {
    const mime = dataurl.match(/^data:(.*?);/)[1];
    const blob = await (await fetch(dataurl)).blob();
    return new File([blob], filename, { type: mime });
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const workspace = document.getElementById('workspace');
const canvasContainer = document.getElementById('canvasContainer');
const overlayContainer = document.getElementById('overlayContainer');
const videoPlayer = document.getElementById('videoPlayer');
const toast = document.getElementById('toast');

const rectBtn = document.getElementById('rectBtn');
const circleBtn = document.getElementById('circleBtn');
const textBtn = document.getElementById('textBtn');
const colorPicker = document.getElementById('colorPicker');
const lineWidthInput = document.getElementById('lineWidth');
// Carries across editor sessions (a fresh tab per capture, otherwise), not
// just across tool switches within one - a page refresh used to snap this
// straight back to the hardcoded default.
const savedLineWidth = localStorage.getItem('qaLineWidth');
if (savedLineWidth) lineWidthInput.value = savedLineWidth;
const saveBtn = document.getElementById('saveBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const copyBtn = document.getElementById('copyBtn');
const arrowBtn = document.getElementById('arrowBtn');
const pencilBtn = document.getElementById('pencilBtn');
const cropBtn = document.getElementById('cropBtn');
const uploadBtn = document.getElementById('uploadBtn');
const imageInput = document.getElementById('imageInput');
const confirmCropBtn = document.getElementById('confirmCropBtn');
const cancelCropBtn = document.getElementById('cancelCropBtn');
const headerCropControls = document.getElementById('headerCropControls');
const lineBtn = document.getElementById('lineBtn');
const deleteBtn = document.getElementById('deleteBtn');
const blurBtn = document.getElementById('blurBtn');
const stepBtn = document.getElementById('stepBtn');
const fillToggleBtn = document.getElementById('fillToggleBtn');
const opacitySlider = document.getElementById('opacitySlider');
const opacityValue = document.getElementById('opacityValue');
const colorPalette = document.getElementById('colorPalette');
const STEP_RADIUS = 14;
const mainShapeBtn = document.getElementById('mainShapeBtn');
const shapesGroup = document.getElementById('shapesGroup');

// Dynamic Fields Elements
const dynamicFieldsContainer = document.getElementById('dynamicFieldsContainer');
const addFieldBtn = document.getElementById('addFieldBtn');
const addFieldMenu = document.getElementById('addFieldMenu');
const fieldSearch = document.getElementById('fieldSearch');
const fieldList = document.getElementById('fieldList');
const cloudUploadBtn = document.getElementById('cloudUploadBtn');

// The pull timer runs every minute at best - opening the editor is also a
// good moment to ask, so a change made on another device shows up sooner.
chrome.runtime.sendMessage({ action: 'pullNow' }).catch(() => { });

// Sharing rides on the same Google account as Cloud Sync. Without one, the
// button can only fail, so it does not appear.
let workspacesCache = null;   // { workspaces: [{id,name}], defaultName } | null
chrome.runtime.sendMessage({ action: 'syncStatus' }).then((meta) => {
    if (cloudUploadBtn && !(meta && meta.signedIn)) cloudUploadBtn.style.display = 'none';
    // Prefetch: by the time Share is clicked, the list is usually already in hand.
    if (meta && meta.signedIn) {
        chrome.runtime.sendMessage({ action: 'listWorkspaces' }).then((res) => {
            if (res && res.success) workspacesCache = res;
        }).catch(() => { });
    }
}).catch(() => { });
const viewHistoryBtn = document.getElementById('viewHistoryBtn');
const reportBugBtn = document.getElementById('reportBugBtn');
const bugModal = document.getElementById('bugModal');

// ── Two-per-row layout: auto-adjust when a field disappears ────────────────
// A field can vanish for reasons that have nothing to do with layout - a
// project with no "Direct Manager" custom field, no "Stage" field, a target
// switch between Azure/Jira. Whatever field is left alone in a pair (or in
// the outer two-column flow) should take the full row instead of leaving a
// dead gap next to it. Driven by a MutationObserver instead of hunting down
// every place in this file that toggles a field's display, so it keeps
// working even for visibility changes added later.
// Walks a 2-column grid's direct children in order and pairs them up; a
// child left alone at the end of a run (odd count, or the very last visible
// item) spans both columns instead of leaving empty space beside it. Used
// both for the modal's own top-level flow and, separately, for each dynamic
// field container - a project can easily add/remove one custom field and
// leave THAT list odd, same problem, same fix.
function reflowPairs(children) {
    let pending = null;
    for (const el of children) {
        if (el.style.display === 'none' || getComputedStyle(el).display === 'none') continue;
        if (pending) {
            pending.style.gridColumn = '';
            el.style.gridColumn = '';
            pending = null;
        } else {
            pending = el;
        }
    }
    if (pending) pending.style.gridColumn = '1 / -1';
}

function reflowFormRow(row) {
    reflowPairs(row.querySelectorAll(':scope > .form-group'));
}

function reflowModalBody(body) {
    const FULL_WIDTH_SELECTOR = '.form-row, .full-row, .ai-assist, #jiraTopFields, ' +
        '#dynamicFieldsContainer, #jiraFieldsContainer, .add-field-section';
    let pending = null;
    for (const el of body.children) {
        if (el.style.display === 'none' || getComputedStyle(el).display === 'none') continue;
        if (el.matches(FULL_WIDTH_SELECTOR)) {
            if (el.classList.contains('form-row')) reflowFormRow(el);
            el.style.gridColumn = '1 / -1';
            pending = null;
            continue;
        }
        if (pending) {
            pending.style.gridColumn = '';
            el.style.gridColumn = '';
            pending = null;
        } else {
            pending = el;
        }
    }
    if (pending) pending.style.gridColumn = '1 / -1';

    // Each dynamic-field container is its own 2-column grid (see editor.css)
    // with however many fields this project/issue type happens to expose -
    // an odd one out here needs the exact same treatment.
    const dynamicFieldsContainer = document.getElementById('dynamicFieldsContainer');
    const jiraFieldsContainer = document.getElementById('jiraFieldsContainer');
    if (dynamicFieldsContainer) reflowPairs(dynamicFieldsContainer.querySelectorAll(':scope > .dynamic-field-wrapper'));
    if (jiraFieldsContainer) reflowPairs(jiraFieldsContainer.querySelectorAll(':scope > .dynamic-field-wrapper'));
}

(() => {
    const body = document.querySelector('#bugModal .modal-body');
    if (!body) return;
    // childList: a field being added or removed (addDynamicField,
    // renderJiraField, the remove-field button) doesn't touch any style or
    // class attribute by itself - without watching childList too, the very
    // case this exists for (a project's field count changing) never fires it.
    const watch = { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true };
    let queued = false;
    const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            // reflowModalBody sets style.gridColumn itself, which would
            // otherwise re-trigger this same observer forever. Stop
            // watching for the duration of our own writes, same as any
            // self-mutating observer needs to.
            observer.disconnect();
            reflowModalBody(body);
            observer.observe(body, watch);
        });
    });
    observer.observe(body, watch);
    requestAnimationFrame(() => reflowModalBody(body));
})();
const submitBugBtn = document.getElementById('submitBugBtn');
const cancelBugBtn = document.getElementById('cancelBugBtn');
const bugTitle = document.getElementById('bugTitle');
const bugDescription = document.getElementById('bugDescription');
const bugOrg = document.getElementById('bugOrg');
const bugProject = document.getElementById('bugProject');
const bugFoundIn = document.getElementById('bugFoundIn');
const bugSeverity = document.getElementById('bugSeverity');
// A hand-picked severity outranks whatever the AI infers on a rerun.
bugSeverity?.addEventListener('change', () => { bugSeverity.dataset.userSet = '1'; });
const bugArea = document.getElementById('bugArea');
const bugIteration = document.getElementById('bugIteration');
const bugParentSearch = document.getElementById('bugParentSearch');
const bugParent = document.getElementById('bugParent');
const bugParentResults = document.getElementById('bugParentResults');
const bugTagsSearch = document.getElementById('bugTagsSearch');
const bugTagsPills = document.getElementById('bugTagsPills');
const bugTagsResults = document.getElementById('bugTagsResults');
const bugTags = document.getElementById('bugTags');
const bugAttachments = document.getElementById('bugAttachments');
const bugAttachmentList = document.getElementById('bugAttachmentList');
const bugAssignedToSearch = document.getElementById('bugAssignedToSearch');
const bugAssignedToPills = document.getElementById('bugAssignedToPills');
const bugAssignedToResults = document.getElementById('bugAssignedToResults');
const bugAssignedTo = document.getElementById('bugAssignedTo');
const bugDirectManagerSearch = document.getElementById('bugDirectManagerSearch');
const bugDirectManagerPills = document.getElementById('bugDirectManagerPills');
const bugDirectManagerResults = document.getElementById('bugDirectManagerResults');
const bugDirectManager = document.getElementById('bugDirectManager');

let currentTool = null;
let isDrawing = false;
let isMoving = false;
let allAdoFields = [];
let activeDynamicFields = new Set();
let isResizing = false;
let isEditing = false;
let isInitializing = false;
let startX, startY;
let currentObject = null;
let currentHandle = null; // 'nw', 'ne', 'sw', 'se', 'r'
let objects = [];
let history = [];
let redoStack = [];

// Pixels are heavy and rarely change; a reference to them is neither. Each
// distinct data URL is kept once here, and a history entry names it by index.
const assets = [];
const assetIndex = new Map();

function assetId(src) {
    if (src == null) return null;
    if (assetIndex.has(src)) return assetIndex.get(src);
    assets.push(src);
    assetIndex.set(src, assets.length - 1);
    return assets.length - 1;
}
const assetSrc = (id) => (id == null ? null : assets[id]);

// An Image element cannot be serialised, and its bytes live in `assets`.
function snapshotObjects() {
    return objects.map((o) => {
        if (o.type === 'image') {
            const { imgElement, imgData, ...rest } = o;
            return { ...rest, asset: assetId(imgData) };
        }
        // The pixelation cache holds a live <canvas> - never belongs in history
        // JSON. Losing it on undo/redo just costs one recompute, not a bug.
        if (o.type === 'blur' && o._pixelCache) {
            const { _pixelCache, ...rest } = o;
            return rest;
        }
        return o;
    });
}

function reviveObjects(saved) {
    return (saved || []).map((o) => {
        if (o.type !== 'image') return o;
        const { asset, ...rest } = o;
        return { ...rest, imgData: assetSrc(asset) };
    });
}
let selectedObjectId = null;
let baseImage = null;
let cropArea = null; // {x, y, w, h}
let isMovingCrop = false;
let isResizingCrop = false;
let cropHandle = null;
let selectedFiles = [];
window.pendingVideo = null;
// The link, when there is one. `isUploaded` answered a question nobody asked -
// what matters is whether Drive is showing what the canvas is showing, and for
// that you need the link and the state that produced it.
let shareUrl = null;

const HANDLE_SIZE = 8;
let hasMoved = false; // Track if current drag/resize actually changed anything
let restoreRequestId = 0; // Prevent race conditions during async restore

// Load image or video from storage
const urlParams = new URLSearchParams(window.location.search);
const captureId = urlParams.get('id');
const pageTitle = urlParams.get('title') || "screenshot";
const isVideoSession = urlParams.get('type') === 'video';

// Helper for visibility
function setMode(mode) {
    if (mode === 'video') {
        document.body.classList.add('video-mode');
        canvas.style.display = 'none';
        videoPlayer.style.display = 'block';
    } else {
        document.body.classList.remove('video-mode');
        canvas.style.display = 'block';
        videoPlayer.style.display = 'none';
    }
}

async function initEditor() {
    toggleLoader(true, "Loading Data...");

    // 1. Recover the link, if this capture was shared before
    if (captureId) {
        chrome.storage.local.get([`cloudUrl_${captureId}`, `cloudHash_${captureId}`], (res) => {
            shareUrl = res[`cloudUrl_${captureId}`] || null;
            sharedImage = res[`cloudHash_${captureId}`] || null;
            updateShareButton();
        });
    }

    // 2. Load the actual data
    if (isVideoSession && captureId) {
        setMode('video');
        chrome.storage.local.get([captureId], async (result) => {
            const data = result[captureId] || sessionStorage.getItem('currentScreenshot');
            if (!data) {
                console.error('Video data not found');
                toggleLoader(false);
                return;
            }

            try {
                let sanitizedTitle = pageTitle.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '_') || 'recording';
                const videoFile = await dataURLtoFile(data, `${sanitizedTitle}.webm`);
                window.pendingVideo = videoFile;

                // Until the first frame decodes, a <video> has no idea how big it
                // is and lays out at its default 300x150 - that was the little
                // box flashing under the loader. Keep it out of the layout until
                // it can size itself, then reveal it.
                videoPlayer.style.visibility = 'hidden';
                videoPlayer.src = URL.createObjectURL(videoFile);
                videoPlayer.onerror = (e) => {
                    console.error("Video player error:", e);
                    videoPlayer.style.visibility = 'visible';
                    toggleLoader(false);
                    showToast("Error loading video playback.");
                };
                videoPlayer.onloadeddata = () => {
                    videoPlayer.style.visibility = 'visible';
                    toggleLoader(false);
                };
                // A safety net, not a "must be done by now" cutoff - a large
                // recording can legitimately still be decoding at 3s in. Hiding
                // the loader unconditionally here made it look like loading had
                // silently finished (or hung) while real work was still going -
                // that is almost certainly what "the video doesn't open" was.
                setTimeout(() => {
                    if (videoPlayer.readyState < 2) {
                        toggleLoader(true, "Still loading a large recording…");
                    }
                }, 3000);
            } catch (err) {
                console.error("Video processing error:", err);
                toggleLoader(false);
                showToast("Error loading the recording.");
            }
        });
    } else if (captureId || sessionStorage.getItem('currentScreenshot')) {
        setMode('image');
        const idToGet = captureId || 'currentScreenshot';
        chrome.storage.local.get([idToGet, 'cropArea', `cloudUrl_${idToGet}`], (result) => {
            if (result[`cloudUrl_${idToGet}`]) {
                shareUrl = result[`cloudUrl_${idToGet}`];
                updateShareButton();
            }

            const data = result[idToGet] || sessionStorage.getItem('currentScreenshot');
            if (!data) {
                console.error('Image data not found');
                toggleLoader(false);
                return;
            }

            // Same flash as the video: an empty canvas lays out at its default
            // 300x150 until the image arrives and gives it a real size. Hold it
            // out of sight until there is something drawn on it.
            canvas.style.visibility = 'hidden';
            const reveal = () => { canvas.style.visibility = 'visible'; };

            const img = new Image();
            img.onload = () => {
                const shouldCrop = urlParams.get('crop') === 'true' && result.cropArea;
                if (shouldCrop) {
                    const { x, y, width, height } = result.cropArea;
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = width;
                    tempCanvas.height = height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(img, x, y, width, height, 0, 0, width, height);

                    const croppedImg = new Image();
                    croppedImg.onload = () => {
                        canvas.width = width;
                        canvas.height = height;
                        baseImage = croppedImg;
                        render();
                        saveHistory(false);
                        updateUndoRedoButtons();
                        reveal();
                        toggleLoader(false);
                    };
                    croppedImg.src = tempCanvas.toDataURL();
                } else {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    baseImage = img;
                    render();
                    saveHistory(false);
                    updateUndoRedoButtons();
                    reveal();
                    toggleLoader(false);
                }
                // Sync session storage for fallback
                if (data) sessionStorage.setItem('currentScreenshot', data);
            };
            img.onerror = () => {
                console.error("Image load error");
                reveal();
                toggleLoader(false);
                showToast("Failed to load image.");
            };
            img.src = data;
        });
    } else {
        toggleLoader(false);
    }
}



// Start initialization
initEditor();


function drawArrow(ctx, fromX, fromY, toX, toY, width) {
    const headLength = 10 + width * 2;
    const angle = Math.atan2(toY - fromY, toX - fromX);

    // Stop shaft at the base of the head
    const shaftEndX = toX - Math.cos(angle) * headLength;
    const shaftEndY = toY - Math.sin(angle) * headLength;

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();

    ctx.save();
    ctx.translate(toX, toY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0); // Tip
    ctx.lineTo(-headLength, -headLength / 2);
    ctx.lineTo(-headLength, headLength / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// Mosaic redaction, not a gaussian blur: a blur can sometimes be reversed or
// guessed at; shrinking to a handful of blocks and stretching back up throws
// the underlying detail away outright, which is the point for a redact tool.
//
// Takes the object (not just x/y/w/h) so the expensive part - getImageData
// plus building/downscaling two offscreen canvases - can be cached on it.
// render() runs on every mousemove, and while the crop tool is active a
// requestAnimationFrame loop calls it continuously for the marching-ants
// animation, so recomputing this from scratch every frame is very noticeable
// lag the moment a blur object exists anywhere on the canvas.
function pixelateRegion(obj) {
    const { x, y, width: w, height: h } = obj;
    const x1 = Math.round(Math.min(x, x + w));
    const y1 = Math.round(Math.min(y, y + h));
    const rw = Math.round(Math.abs(w));
    const rh = Math.round(Math.abs(h));
    if (rw < 1 || rh < 1) return;

    // Clamp to the canvas - getImageData throws on an out-of-bounds rect.
    const cx = Math.max(0, x1), cy = Math.max(0, y1);
    const cw = Math.min(rw - (cx - x1), canvas.width - cx);
    const ch = Math.min(rh - (cy - y1), canvas.height - cy);
    if (cw < 1 || ch < 1) return;

    const cache = obj._pixelCache;
    if (!cache || cache.cx !== cx || cache.cy !== cy || cache.cw !== cw || cache.ch !== ch) {
        const blocks = 12;   // roughly this many mosaic tiles across the longer side
        const tile = Math.max(1, Math.round(Math.max(cw, ch) / blocks));
        const smallW = Math.max(1, Math.round(cw / tile));
        const smallH = Math.max(1, Math.round(ch / tile));

        const src = ctx.getImageData(cx, cy, cw, ch);
        const small = document.createElement('canvas');
        small.width = smallW; small.height = smallH;
        const sctx = small.getContext('2d');
        const full = document.createElement('canvas');
        full.width = cw; full.height = ch;
        full.getContext('2d').putImageData(src, 0, 0);
        // A single big downscale (e.g. 180px -> 12px) does not properly area-average
        // in Chromium without this - it lands closer to nearest-neighbor sampling,
        // which can miss a color entirely instead of blending it into the tile.
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(full, 0, 0, cw, ch, 0, 0, smallW, smallH);

        obj._pixelCache = { cx, cy, cw, ch, smallW, smallH, canvas: small };
    }

    const c = obj._pixelCache;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c.canvas, 0, 0, c.smallW, c.smallH, c.cx, c.cy, c.cw, c.ch);
    ctx.restore();
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baseImage) ctx.drawImage(baseImage, 0, 0);

    objects.forEach(obj => {
        ctx.strokeStyle = obj.color;
        ctx.fillStyle = obj.color;
        ctx.lineWidth = obj.lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = obj.opacity ?? 1;

        if (obj.type === 'rect') {
            if (obj.fill) ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
            else ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
        } else if (obj.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(obj.x, obj.y);
            ctx.lineTo(obj.endX, obj.endY);
            ctx.stroke();
        } else if (obj.type === 'circle') {
            ctx.beginPath();
            ctx.arc(obj.x, obj.y, obj.radius, 0, 2 * Math.PI);
            if (obj.fill) ctx.fill();
            else ctx.stroke();
        } else if (obj.type === 'blur') {
            pixelateRegion(obj);
        } else if (obj.type === 'step') {
            ctx.beginPath();
            ctx.arc(obj.x, obj.y, obj.radius, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = `700 ${Math.round(obj.radius * 1.1)}px 'Outfit', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(obj.number), obj.x, obj.y + 1);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        } else if (obj.type === 'text') {
            ctx.font = `${obj.fontSize}px 'Outfit', sans-serif`;
            ctx.textBaseline = 'top';
            const lines = obj.text.split('\n');
            const lineHeight = obj.fontSize * 1.2;
            lines.forEach((line, i) => {
                ctx.fillText(line, obj.x, obj.y + (i * lineHeight));
            });
        } else if (obj.type === 'arrow') {
            drawArrow(ctx, obj.x, obj.y, obj.endX, obj.endY, obj.lineWidth);
        } else if (obj.type === 'pencil') {
            if (obj.points.length > 1) {
                ctx.beginPath();
                ctx.moveTo(obj.points[0].x, obj.points[0].y);
                for (let i = 1; i < obj.points.length; i++) {
                    ctx.lineTo(obj.points[i].x, obj.points[i].y);
                }
                ctx.stroke();
            }
        } else if (obj.type === 'image' && obj.imgElement) {
            ctx.drawImage(obj.imgElement, obj.x, obj.y, obj.width, obj.height);
        }

        ctx.globalAlpha = 1;   // selection outline is always fully opaque, regardless of the object's own opacity
        if (obj.id === selectedObjectId) drawSelectionBounds(obj);
    });

    // Draw preview of current object being drawn
    if (isDrawing && currentObject) {
        ctx.strokeStyle = currentObject.color;
        ctx.lineWidth = currentObject.lineWidth;
        if (currentObject.type === 'rect') {
            ctx.strokeRect(currentObject.x, currentObject.y, currentObject.width, currentObject.height);
        } else if (currentObject.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(currentObject.x, currentObject.y);
            ctx.lineTo(currentObject.endX, currentObject.endY);
            ctx.stroke();
        } else if (currentObject.type === 'circle') {
            ctx.beginPath();
            ctx.arc(currentObject.x, currentObject.y, currentObject.radius, 0, 2 * Math.PI);
            ctx.stroke();
        } else if (currentObject.type === 'arrow') {
            drawArrow(ctx, currentObject.x, currentObject.y, currentObject.endX, currentObject.endY, currentObject.lineWidth);
        } else if (currentObject.type === 'pencil') {
            if (currentObject.points.length > 1) {
                ctx.beginPath();
                ctx.moveTo(currentObject.points[0].x, currentObject.points[0].y);
                for (let i = 1; i < currentObject.points.length; i++) {
                    ctx.lineTo(currentObject.points[i].x, currentObject.points[i].y);
                }
                ctx.stroke();
            }
        } else if (currentObject.type === 'blur') {
            // Pixelating on every mousemove while dragging would be wasteful -
            // a dashed outline is preview enough; the real effect commits on mouseup.
            // Two strokes, same trick as the crop selection: a solid white
            // contour is invisible over a white/light region of the image, so
            // pair it with a dark dashed line - one of the two always contrasts.
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 3;
            ctx.strokeRect(currentObject.x, currentObject.y, currentObject.width, currentObject.height);
            ctx.strokeStyle = '#111';
            ctx.lineWidth = 1;
            ctx.strokeRect(currentObject.x, currentObject.y, currentObject.width, currentObject.height);
            ctx.restore();
        }
    }

    // Draw Crop Selection
    if (cropArea && (Math.abs(cropArea.w) > 0 || Math.abs(cropArea.h) > 0)) {
        ctx.save();
        // Contouring stroke for better visibility on any background
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(cropArea.x, cropArea.y, cropArea.w, cropArea.h);

        ctx.strokeStyle = '#28a745';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        // Marching ants animation
        ctx.lineDashOffset = (Date.now() / 50) % 20;
        ctx.strokeRect(cropArea.x, cropArea.y, cropArea.w, cropArea.h);

        // Dim outside
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const x1 = Math.min(cropArea.x, cropArea.x + cropArea.w);
        const y1 = Math.min(cropArea.y, cropArea.y + cropArea.h);
        const cw = Math.abs(cropArea.w);
        const ch = Math.abs(cropArea.h);

        // Top
        ctx.fillRect(0, 0, canvas.width, y1);
        // Bottom
        ctx.fillRect(0, y1 + ch, canvas.width, canvas.height - (y1 + ch));
        // Left
        ctx.fillRect(0, y1, x1, ch);
        // Right
        ctx.fillRect(x1 + cw, y1, canvas.width - (x1 + cw), ch);

        // Draw handles for resizing crop
        if (!isDrawing) {
            drawHandle(x1, y1); // NW
            drawHandle(x1 + cw, y1); // NE
            drawHandle(x1, y1 + ch); // SW
            drawHandle(x1 + cw, y1 + ch); // SE
        }

        ctx.restore();
        if (currentTool === 'crop') requestAnimationFrame(render);
    }

    // Update header controls visibility
    if (currentTool === 'crop' && cropArea && (Math.abs(cropArea.w) > 5 || Math.abs(cropArea.h) > 5) && !isDrawing) {
        headerCropControls.style.display = 'flex';
    } else {
        headerCropControls.style.display = 'none';
    }

    // Update delete button state
    if (deleteBtn) {
        deleteBtn.disabled = !selectedObjectId;
    }
}

function drawSelectionBounds(obj) {
    ctx.save();
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);

    let x, y, w, h;
    if (obj.type === 'rect' || obj.type === 'image' || obj.type === 'blur') {
        x = obj.x; y = obj.y; w = obj.width; h = obj.height;
        ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
        // Draw Handles
        drawHandle(x, y); // NW
        drawHandle(x + w, y); // NE
        drawHandle(x, y + h); // SW
        drawHandle(x + w, y + h); // SE
    } else if (obj.type === 'circle') {
        x = obj.x - obj.radius; y = obj.y - obj.radius; w = obj.radius * 2; h = obj.radius * 2;
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, obj.radius + 2, 0, 2 * Math.PI);
        ctx.stroke();
        // Draw Radius Handle
        drawHandle(obj.x + obj.radius, obj.y);
    } else if (obj.type === 'step') {
        // Fixed size, no resize handle - just move or delete.
        ctx.beginPath();
        ctx.arc(obj.x, obj.y, obj.radius + 3, 0, 2 * Math.PI);
        ctx.stroke();
    } else if (obj.type === 'text') {
        x = obj.x; y = obj.y;
        ctx.font = `${obj.fontSize}px 'Outfit', sans-serif`;
        const lines = obj.text.split('\n');
        const lineHeight = obj.fontSize * 1.2;
        let maxW = 0;
        lines.forEach(line => {
            const w = ctx.measureText(line).width;
            if (w > maxW) maxW = w;
        });
        w = maxW; h = lines.length * lineHeight;
        ctx.strokeRect(x - 5, y - 5, w + 10, h + 10);
    } else if (obj.type === 'arrow' || obj.type === 'line') {
        drawHandle(obj.x, obj.y);
        drawHandle(obj.endX, obj.endY);
    } else if (obj.type === 'pencil') {
        const minX = Math.min(...obj.points.map(p => p.x));
        const maxX = Math.max(...obj.points.map(p => p.x));
        const minY = Math.min(...obj.points.map(p => p.y));
        const maxY = Math.max(...obj.points.map(p => p.y));
        ctx.strokeRect(minX - 5, minY - 5, (maxX - minX) + 10, (maxY - minY) + 10);
    }
    ctx.restore();
}

function drawHandle(hx, hy) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_SIZE / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function updateUndoRedoButtons() {
    // Undo cancels an in-progress crop; switching the button off meant that
    // branch of its own handler could never be reached.
    if (currentTool === 'crop') {
        undoBtn.disabled = false;
        redoBtn.disabled = true;
        return;
    }

    undoBtn.disabled = history.length <= 1;
    redoBtn.disabled = redoStack.length === 0;
}

function restoreImages() {
    objects.forEach(obj => {
        if (obj.type === 'image' && obj.imgData && !obj.imgElement) {
            const img = new Image();
            img.onload = () => render();
            img.src = obj.imgData;
            obj.imgElement = img;
        }
    });
}

// What Drive holds, as a fingerprint of its pixels. The history state string
// cannot serve: reopening a capture bakes yesterday's annotations into the base
// image, so the same picture describes itself with a different object list.
let sharedImage = null;

// Selection bounds are painted onto the canvas, and are nobody's edit.
function imageFingerprint() {
    const wasSelected = selectedObjectId;
    if (wasSelected) { selectedObjectId = null; render(); }

    const url = canvas.toDataURL('image/png');
    let h = 0;
    for (let i = 0; i < url.length; i += 61) h = (h * 31 + url.charCodeAt(i)) >>> 0;

    if (wasSelected) { selectedObjectId = wasSelected; render(); }
    return url.length + ':' + h;
}

function updateShareButton() {
    if (!cloudUploadBtn) return;
    cloudUploadBtn.disabled = false;
    cloudUploadBtn.style.opacity = '1';

    // The button answers one question: is Drive showing what the canvas is
    // showing? Not "have you touched anything since".
    if (!shareUrl) {
        cloudUploadBtn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i>';
        cloudUploadBtn.title = 'Share on Google Drive';
    } else if (sharedImage === imageFingerprint()) {
        cloudUploadBtn.innerHTML = '<i class="fas fa-link"></i>';
        cloudUploadBtn.title = 'Copy the share link';
    } else {
        cloudUploadBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i>';
        cloudUploadBtn.title = 'Update the shared image - the link stays the same';
    }
}

function saveHistory(isManualAction = true) {
    const newState = JSON.stringify({
        objects: snapshotObjects(),
        base: assetId(baseImage ? baseImage.src : null)
    });

    // Don't save if it's the same as the last state
    if (history.length > 0 && history[history.length - 1] === newState) {
        return;
    }

    history.push(newState);
    redoStack = [];  // Clear redo stack on new actions
    if (history.length > 30) history.shift();
    updateUndoRedoButtons();
    updateShareButton();
}

function doUndo() {
    // If crop tool is active, first "Undo" just cancels the tool/selection
    if (currentTool === 'crop') {
        cropArea = null;
        setActiveBtn(null);
        currentTool = null;
        render();
        return;
    }

    if (history.length > 1) {
        const currentReqId = ++restoreRequestId;

        // Pop current state
        redoStack.push(history.pop());
        const state = JSON.parse(history[history.length - 1]);

        objects = reviveObjects(state.objects);
        cropArea = null;   // a crop lives in baseImage, not in a selection box

        // Ensure tools are deactivated when moving back in history
        currentTool = null;
        setActiveBtn(null);

        restoreBaseImage(assetSrc(state.base), () => {
            if (currentReqId !== restoreRequestId) return;
            restoreImages();
            selectedObjectId = null;
            render();
            updateUndoRedoButtons();
            updateShareButton();
        });
    }
}

function doRedo() {
    if (redoStack.length > 0) {
        const currentReqId = ++restoreRequestId;
        const next = redoStack.pop();
        history.push(next);
        const state = JSON.parse(next);

        objects = reviveObjects(state.objects);
        cropArea = null;   // a crop lives in baseImage, not in a selection box

        // Deactivate any active tool and UI state
        currentTool = null;
        setActiveBtn(null);

        restoreBaseImage(assetSrc(state.base), () => {
            if (currentReqId !== restoreRequestId) return;
            restoreImages();
            selectedObjectId = null;
            render();
            updateUndoRedoButtons();
            updateShareButton();
        });
    }
}

undoBtn.addEventListener('click', doUndo);
redoBtn.addEventListener('click', doRedo);

// The first thing a hand reaches for. Ctrl+Y and Ctrl+Shift+Z both redo, because
// half the world learned one and half the other.
window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || isEditing) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
});

function restoreBaseImage(src, callback) {
    if (!src) {
        baseImage = null;
        callback();
        return;
    }
    if (baseImage && baseImage.src === src) {
        callback();
        return;
    }
    const img = new Image();
    img.onload = () => {
        baseImage = img;
        canvas.width = img.width;
        canvas.height = img.height;
        callback();
    };
    img.src = src;
}

function setActiveBtn(btn) {
    const shapeTools = [rectBtn, circleBtn, arrowBtn, pencilBtn, lineBtn, blurBtn, stepBtn];
    [rectBtn, circleBtn, textBtn, arrowBtn, pencilBtn, lineBtn, cropBtn, uploadBtn, blurBtn, stepBtn].forEach(b => b && b.classList.remove('active'));

    if (btn) {
        btn.classList.add('active');

        if (shapeTools.includes(btn)) {
            const icon = btn.querySelector('i').className;
            mainShapeBtn.querySelector('i').className = icon;
            mainShapeBtn.classList.add('active');
            shapesGroup.classList.remove('open');
        } else {
            mainShapeBtn.classList.remove('active');
            mainShapeBtn.querySelector('i').className = 'fas fa-shapes';
        }
    } else {
        mainShapeBtn.classList.remove('active');
        mainShapeBtn.querySelector('i').className = 'fas fa-shapes';
    }

    // Show/Hide confirm/cancel crop buttons
    const isCrop = (btn === cropBtn);
    if (!isCrop) {
        headerCropControls.style.display = 'none';
        cropArea = null;
        render();
    }
}

mainShapeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    shapesGroup.classList.toggle('open');
});

// Close dropdown when clicking outside
document.addEventListener('click', () => {
    shapesGroup.classList.remove('open');
});

rectBtn.addEventListener('click', () => {
    currentTool = 'rect';
    setActiveBtn(rectBtn);
});
circleBtn.addEventListener('click', () => {
    currentTool = 'circle';
    setActiveBtn(circleBtn);
});
textBtn.addEventListener('click', () => {
    currentTool = 'text';
    setActiveBtn(textBtn);
});

cropBtn.addEventListener('click', () => {
    currentTool = 'crop';
    setActiveBtn(cropBtn);
    selectedObjectId = null;
    render();
});

uploadBtn.addEventListener('click', () => {
    imageInput.click();
});

cancelCropBtn.addEventListener('click', () => {
    cropArea = null;
    currentTool = null;
    setActiveBtn(null);
    render();
});

imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        showToast("Error: Only images are allowed");
        e.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            const id = Date.now();
            // Start image at a reasonable size
            const maxW = canvas.width * 0.5;
            const maxH = canvas.height * 0.5;
            let w = img.width;
            let h = img.height;
            if (w > maxW) { h *= maxW / w; w = maxW; }
            if (h > maxH) { w *= maxH / h; h = maxH; }

            objects.push({
                id, type: 'image', x: 50, y: 50, width: w, height: h,
                imgData: event.target.result,
                imgElement: img
            });
            selectedObjectId = id;
            setActiveBtn(uploadBtn);  // Activate upload button when image is selected
            saveHistory();
            render();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // Reset for same file re-upload
});

confirmCropBtn.addEventListener('click', () => {
    if (!cropArea || Math.abs(cropArea.w) < 5 || Math.abs(cropArea.h) < 5) return;

    const { x, y, w, h } = cropArea;
    const x1 = Math.min(x, x + w);
    const y1 = Math.min(y, y + h);
    const cw = Math.abs(w);
    const ch = Math.abs(h);

    // Create new canvas for cropped base image
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = cw;
    tempCanvas.height = ch;

    // Draw only the base image (cropped) to the new base
    if (baseImage) {
        tempCtx.drawImage(baseImage, x1, y1, cw, ch, 0, 0, cw, ch);
    }

    // Update base image and adjust objects
    const newBase = new Image();
    newBase.onload = () => {
        canvas.width = cw;
        canvas.height = ch;
        baseImage = newBase;

        // Shift all objects to remain in their relative positions
        objects.forEach(obj => {
            if (obj.type === 'pencil') {
                obj.points.forEach(p => { p.x -= x1; p.y -= y1; });
            } else if (obj.type === 'arrow') {
                obj.x -= x1; obj.y -= y1;
                obj.endX -= x1; obj.endY -= y1;
            } else {
                obj.x -= x1; obj.y -= y1;
            }
        });

        cropArea = null;
        setActiveBtn(null);
        currentTool = null;

        // Ensure we save history AFTER the transformation is complete
        saveHistory();  // Crop changes base image, shapes will be saved
        render();
    };
    newBase.src = tempCanvas.toDataURL();
});

lineBtn.addEventListener('click', () => {
    currentTool = 'line';
    setActiveBtn(lineBtn);
});

arrowBtn.addEventListener('click', () => {
    currentTool = 'arrow';
    setActiveBtn(arrowBtn);
});

pencilBtn.addEventListener('click', () => {
    currentTool = 'pencil';
    setActiveBtn(pencilBtn);
});

blurBtn.addEventListener('click', () => {
    currentTool = 'blur';
    setActiveBtn(blurBtn);
});

stepBtn.addEventListener('click', () => {
    currentTool = 'step';
    setActiveBtn(stepBtn);
});

// Update selected object styles
// `input` fires on every shade the cursor crosses. Paint each one, but a drag
// through the wheel is one edit, and `change` is where it ends.
const applyColour = () => {
    if (!selectedObjectId) return null;
    const obj = objects.find(o => o.id === selectedObjectId);
    if (obj) { obj.color = colorPicker.value; render(); }
    return obj;
};
colorPicker.addEventListener('input', applyColour);
colorPicker.addEventListener('change', () => { if (applyColour()) saveHistory(); });

// Quick presets: same effect as picking the shade from the native picker.
colorPalette.addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    colorPicker.value = swatch.dataset.color;
    colorPicker.dispatchEvent(new Event('input'));
    colorPicker.dispatchEvent(new Event('change'));
});

// Fill only makes sense for rect/circle, but the toggle itself is just state -
// new shapes read it at creation time, same as color/width.
fillToggleBtn.addEventListener('click', () => {
    fillToggleBtn.classList.toggle('active');
    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj && (obj.type === 'rect' || obj.type === 'circle')) {
            obj.fill = fillToggleBtn.classList.contains('active');
            render();
            saveHistory();
        }
    }
});

opacitySlider.addEventListener('input', () => {
    opacityValue.textContent = opacitySlider.value + '%';
    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj) { obj.opacity = parseInt(opacitySlider.value) / 100; render(); }
    }
});
opacitySlider.addEventListener('change', () => {
    if (selectedObjectId) saveHistory();
});

lineWidthInput.addEventListener('input', () => {
    // Validate to prevent negative, zero, or values above 20
    let value = parseInt(lineWidthInput.value);
    if (value < 1 || isNaN(value)) {
        lineWidthInput.value = 1;
        value = 1;
    } else if (value > 20) {
        lineWidthInput.value = 20;
        value = 20;
    }
    localStorage.setItem('qaLineWidth', value);

    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj) {
            obj.lineWidth = parseInt(lineWidthInput.value);
            if (obj.type === 'text') {
                obj.fontSize = obj.lineWidth * 5;
            }
            render();
        }
    }
});

// Typing 12 passes through 1 on the way. One entry, when the value settles.
lineWidthInput.addEventListener('change', () => { if (selectedObjectId) saveHistory(); });

// Global Mouse Events
// document, not canvas: a drag that overshoots the canvas edge (very easy to
// do near the border of a screenshot) would otherwise never receive the
// mousemove/mouseup that finalizes it, leaving isDrawing/isMoving/isResizing
// stuck true forever and silently breaking every tool until the page reloads.
document.addEventListener('mousemove', (e) => {
    if (isEditing) return;
    const rect = canvas.getBoundingClientRect();

    // Calculate scale factor between displayed size and actual canvas size
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // Scale mouse coordinates to match canvas internal coordinates
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    if (currentTool === 'crop' && isDrawing) {
        handleCropDrag(mx, my);
        return;
    }

    if (isMoving || isDrawing || isResizing || isMovingCrop || isResizingCrop) {
        handleDrag(mx, my);
        return;
    }

    // Crop selection's own corner/move handles - same resize-cursor feedback
    // as every other tool's handles, not a flat crosshair the whole time.
    if (currentTool === 'crop' && cropArea) {
        const handle = getCropHandleAt(mx, my);
        if (handle) {
            canvas.style.cursor = getCursorForHandle(handle);
            return;
        }
    }

    // Handle detection
    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        const handle = getHandleAt(mx, my, obj);
        if (handle) {
            canvas.style.cursor = getCursorForHandle(handle);
            return;
        }
    }

    // Hover cursor logic
    const hovered = objects.slice().reverse().find(o => isPointInObject(mx, my, o, 5));
    canvas.style.cursor = hovered ? 'move' : (currentTool ? (currentTool === 'text' ? 'text' : (currentTool === 'crop' ? 'crosshair' : 'crosshair')) : 'default');
});

function getCursorForHandle(handle) {
    if (handle === 'nw' || handle === 'se') return 'nwse-resize';
    if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
    if (handle === 'r') return 'ew-resize';
    if (handle === 'move') return 'move';
    return 'default';
}

function getHandleAt(mx, my, obj) {
    if (!obj) return null;
    const s = HANDLE_SIZE + 4;
    if (obj.type === 'rect' || obj.type === 'image' || obj.type === 'blur') {
        if (dist(mx, my, obj.x, obj.y) < s) return 'nw';
        if (dist(mx, my, obj.x + obj.width, obj.y) < s) return 'ne';
        if (dist(mx, my, obj.x, obj.y + obj.height) < s) return 'sw';
        if (dist(mx, my, obj.x + obj.width, obj.y + obj.height) < s) return 'se';
    } else if (obj.type === 'circle') {
        if (dist(mx, my, obj.x + obj.radius, obj.y) < s) return 'r';
    } else if (obj.type === 'arrow' || obj.type === 'line') {
        if (dist(mx, my, obj.x, obj.y) < s) return 'start';
        if (dist(mx, my, obj.endX, obj.endY) < s) return 'end';
    }
    return null;
}

function getCropHandleAt(mx, my) {
    if (!cropArea) return null;
    const s = HANDLE_SIZE + 4;
    const x1 = Math.min(cropArea.x, cropArea.x + cropArea.w);
    const y1 = Math.min(cropArea.y, cropArea.y + cropArea.h);
    const cw = Math.abs(cropArea.w);
    const ch = Math.abs(cropArea.h);

    if (dist(mx, my, x1, y1) < s) return 'nw';
    if (dist(mx, my, x1 + cw, y1) < s) return 'ne';
    if (dist(mx, my, x1, y1 + ch) < s) return 'sw';
    if (dist(mx, my, x1 + cw, y1 + ch) < s) return 'se';

    // Check if inside to move
    if (mx >= x1 && mx <= x1 + cw && my >= y1 && my <= y1 + ch) return 'move';

    return null;
}

function distSq(v, w) {
    return (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
}

function distToSegment(p, v, w) {
    const l2 = distSq(v, w);
    if (l2 == 0) return Math.sqrt(distSq(p, v));
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt(distSq(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }));
}

function dist(x1, y1, x2, y2) {
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

canvas.addEventListener('mousedown', (e) => {
    if (isEditing) return;
    const rect = canvas.getBoundingClientRect();

    // Calculate scale factor between displayed size and actual canvas size
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // Scale mouse coordinates to match canvas internal coordinates
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;

    // Check handles first
    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        const handle = getHandleAt(startX, startY, obj);
        if (handle) {
            isResizing = true;
            currentHandle = handle;
            currentObject = obj;
            return;
        }
    }

    // New: Check for existing objects FIRST to allow moving them even if a tool is active
    const clicked = objects.slice().reverse().find(o => isPointInObject(startX, startY, o, 5));
    if (clicked && currentTool !== 'crop') {
        selectedObjectId = clicked.id;
        currentObject = clicked;
        isMoving = true;
        colorPicker.value = clicked.color || '#ff0000';
        lineWidthInput.value = clicked.lineWidth || 3;
        fillToggleBtn.classList.toggle('active', !!clicked.fill);
        opacitySlider.value = Math.round((clicked.opacity ?? 1) * 100);
        opacityValue.textContent = opacitySlider.value + '%';

        // Activate the corresponding tool button based on object type
        if (clicked.type === 'rect') { currentTool = 'rect'; setActiveBtn(rectBtn); }
        else if (clicked.type === 'circle') { currentTool = 'circle'; setActiveBtn(circleBtn); }
        else if (clicked.type === 'text') { currentTool = 'text'; setActiveBtn(textBtn); }
        else if (clicked.type === 'line') { currentTool = 'line'; setActiveBtn(lineBtn); }
        else if (clicked.type === 'arrow') { currentTool = 'arrow'; setActiveBtn(arrowBtn); }
        else if (clicked.type === 'pencil') { currentTool = 'pencil'; setActiveBtn(pencilBtn); }
        else if (clicked.type === 'blur') { currentTool = 'blur'; setActiveBtn(blurBtn); }
        else if (clicked.type === 'step') { currentTool = 'step'; setActiveBtn(stepBtn); }
        else if (clicked.type === 'image') { currentTool = null; setActiveBtn(uploadBtn); }

        render();
        return;
    }

    // Priority Tools (Crop, Text, Step) - single click, not a drag
    if (currentTool === 'crop' || currentTool === 'text' || currentTool === 'step') {
        if (currentTool === 'crop' && cropArea) {
            const handle = getCropHandleAt(startX, startY);
            if (handle) {
                if (handle === 'move') {
                    isMovingCrop = true;
                } else {
                    isResizingCrop = true;
                    cropHandle = handle;
                }
                return;
            }
        }

        if (currentTool === 'crop') {
            isDrawing = true;
            selectedObjectId = null;
            currentObject = null;
            cropArea = { x: startX, y: startY, w: 0, h: 0 };
            render();
            return;
        }

        if (currentTool === 'text') {
            startTextInput(startX, startY);
            isDrawing = false;
            render();
            return;
        }

        if (currentTool === 'step') {
            // One click, no drag - a badge drops right where you clicked. The
            // number is however many step markers already exist, so deleting
            // one leaves a gap instead of silently renumbering the rest.
            const number = objects.filter(o => o.type === 'step').length + 1;
            objects.push({
                id: Date.now(), type: 'step', x: startX, y: startY, number,
                color: colorPicker.value, radius: STEP_RADIUS, opacity: parseInt(opacitySlider.value) / 100
            });
            saveHistory();
            render();
            return;
        }
    }

    if (currentTool) {
        isDrawing = true;
        selectedObjectId = null;
        currentObject = null;
        const id = Date.now();
        const opacity = parseInt(opacitySlider.value) / 100;
        const fill = fillToggleBtn.classList.contains('active');
        if (currentTool === 'rect') {
            currentObject = { id, type: 'rect', x: startX, y: startY, width: 0, height: 0, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value), fill, opacity };
        } else if (currentTool === 'circle') {
            currentObject = { id, type: 'circle', x: startX, y: startY, radius: 0, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value), fill, opacity };
        } else if (currentTool === 'line') {
            currentObject = { id, type: 'line', x: startX, y: startY, endX: startX, endY: startY, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value), opacity };
        } else if (currentTool === 'arrow') {
            currentObject = { id, type: 'arrow', x: startX, y: startY, endX: startX, endY: startY, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value), opacity };
        } else if (currentTool === 'pencil') {
            currentObject = { id, type: 'pencil', points: [{ x: startX, y: startY }], color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value), opacity };
        } else if (currentTool === 'blur') {
            currentObject = { id, type: 'blur', x: startX, y: startY, width: 0, height: 0 };
        }
    } else {
        selectedObjectId = null;
        currentTool = null;
        setActiveBtn(null);
        render();
    }
    hasMoved = false; // Reset on every drag start
});

document.addEventListener('mouseup', () => {
    if (isEditing) return;
    // Nothing was in progress (a plain click elsewhere on the page) - do not
    // run the drag-finalize logic below for every unrelated mouseup.
    if (!isDrawing && !isMoving && !isResizing && !isMovingCrop && !isResizingCrop) return;
    if (isDrawing && currentObject) {
        // Validate that the shape was actually dragged (not just clicked)
        let meaningful = false;
        if (currentObject.type === 'rect' || currentObject.type === 'blur') meaningful = Math.abs(currentObject.width) > 5 || Math.abs(currentObject.height) > 5;
        else if (currentObject.type === 'circle') meaningful = currentObject.radius > 5;
        else if (currentObject.type === 'line' || currentObject.type === 'arrow') meaningful = dist(currentObject.x, currentObject.y, currentObject.endX, currentObject.endY) > 5;
        else if (currentObject.type === 'pencil') meaningful = currentObject.points.length > 3;

        if (meaningful) {
            objects.push(currentObject);
            saveHistory();
        } else {
            // A drag under the threshold vanishes with zero feedback otherwise -
            // reads exactly like the tool silently didn't work.
            showToast('Too small to keep - try dragging a bit further');
        }
    } else if ((isMoving || isResizing || isMovingCrop || isResizingCrop) && hasMoved) {
        saveHistory();
    }
    isDrawing = false;
    isMoving = false;
    isResizing = false;
    isMovingCrop = false;
    isResizingCrop = false;
    cropHandle = null;
    currentObject = null;
    currentHandle = null;
    render();
});

canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    const clicked = objects.slice().reverse().find(o => o.type === 'text' && isPointInObject(mx, my, o, 5));
    if (clicked) {
        isMoving = false;
        isDrawing = false;
        isResizing = false;
        currentObject = null;
        startTextEdit(clicked);
    }
});

function handleDrag(mx, my) {
    if (isResizingCrop && cropArea) {
        const x1 = Math.min(cropArea.x, cropArea.x + cropArea.w);
        const y1 = Math.min(cropArea.y, cropArea.y + cropArea.h);
        const x2 = Math.max(cropArea.x, cropArea.x + cropArea.w);
        const y2 = Math.max(cropArea.y, cropArea.y + cropArea.h);

        if (cropHandle === 'se') {
            cropArea.x = x1; cropArea.y = y1;
            cropArea.w = mx - x1; cropArea.h = my - y1;
        } else if (cropHandle === 'sw') {
            cropArea.x = x2; cropArea.y = y1;
            cropArea.w = mx - x2; cropArea.h = my - y1;
        } else if (cropHandle === 'ne') {
            cropArea.x = x1; cropArea.y = y2;
            cropArea.w = mx - x1; cropArea.h = my - y2;
        } else if (cropHandle === 'nw') {
            cropArea.x = x2; cropArea.y = y2;
            cropArea.w = mx - x2; cropArea.h = my - y2;
        }
        hasMoved = true;
        render();
        return;
    }

    if (isMovingCrop && cropArea) {
        const dx = mx - startX;
        const dy = my - startY;
        cropArea.x += dx;
        cropArea.y += dy;
        startX = mx; startY = my;
        hasMoved = true;
        render();
        return;
    }

    if (!currentObject) return;

    if (isResizing) {
        if (currentObject.type === 'rect' || currentObject.type === 'image' || currentObject.type === 'blur') {
            if (currentHandle === 'se') {
                currentObject.width = mx - currentObject.x;
                currentObject.height = my - currentObject.y;
            } else if (currentHandle === 'sw') {
                currentObject.width = currentObject.x + currentObject.width - mx;
                currentObject.height = my - currentObject.y;
                currentObject.x = mx;
            } else if (currentHandle === 'ne') {
                currentObject.width = mx - currentObject.x;
                currentObject.height = currentObject.y + currentObject.height - my;
                currentObject.y = my;
            } else if (currentHandle === 'nw') {
                currentObject.width = currentObject.x + currentObject.width - mx;
                currentObject.height = currentObject.y + currentObject.height - my;
                currentObject.x = mx;
                currentObject.y = my;
            }
        } else if (currentObject.type === 'circle') {
            if (currentHandle === 'r') {
                currentObject.radius = Math.abs(mx - currentObject.x);
            }
        } else if (currentObject.type === 'arrow' || currentObject.type === 'line') {
            if (currentHandle === 'start') {
                currentObject.x = mx;
                currentObject.y = my;
            } else if (currentHandle === 'end') {
                currentObject.endX = mx;
                currentObject.endY = my;
            }
        }
        hasMoved = true;
    } else if (isMoving) {
        const dx = mx - startX;
        const dy = my - startY;
        if (currentObject.type === 'pencil') {
            currentObject.points.forEach(p => { p.x += dx; p.y += dy; });
        } else if (currentObject.type === 'arrow' || currentObject.type === 'line') {
            currentObject.x += dx;
            currentObject.y += dy;
            currentObject.endX += dx;
            currentObject.endY += dy;
        } else {
            currentObject.x += dx;
            currentObject.y += dy;
        }
        startX = mx; startY = my;
        hasMoved = true;
    } else if (isDrawing) {
        if (currentTool === 'rect' || currentTool === 'blur') {
            currentObject.width = mx - startX;
            currentObject.height = my - startY;
        } else if (currentTool === 'circle') {
            currentObject.radius = Math.sqrt((mx - startX) ** 2 + (my - startY) ** 2);
        } else if (currentTool === 'line') {
            currentObject.endX = mx;
            currentObject.endY = my;
        } else if (currentTool === 'arrow') {
            currentObject.endX = mx;
            currentObject.endY = my;
        } else if (currentTool === 'pencil') {
            currentObject.points.push({ x: mx, y: my });
        }
    }
    render();
}

function handleCropDrag(mx, my) {
    cropArea = {
        x: startX,
        y: startY,
        w: mx - startX,
        h: my - startY
    };
    render();
}

function isPointInObject(x, y, obj, p = 0) {
    if (obj.type === 'rect' || obj.type === 'image' || obj.type === 'blur') {
        const x1 = Math.min(obj.x, obj.x + obj.width) - p;
        const x2 = Math.max(obj.x, obj.x + obj.width) + p;
        const y1 = Math.min(obj.y, obj.y + obj.height) - p;
        const y2 = Math.max(obj.y, obj.y + obj.height) + p;
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    } else if (obj.type === 'circle' || obj.type === 'step') {
        return Math.sqrt((x - obj.x) ** 2 + (y - obj.y) ** 2) <= (obj.radius + p);
    } else if (obj.type === 'text') {
        ctx.font = `${obj.fontSize}px 'Outfit', sans-serif`;
        const lines = obj.text.split('\n');
        const lineHeight = obj.fontSize * 1.2;
        let maxW = 0;
        lines.forEach(line => {
            const w = ctx.measureText(line).width;
            if (w > maxW) maxW = w;
        });
        const totalH = lines.length * lineHeight;
        return x >= obj.x - p && x <= obj.x + maxW + p && y >= obj.y - p && y <= obj.y + totalH + p;
    } else if (obj.type === 'arrow' || obj.type === 'line') {
        const d = distToSegment({ x, y }, { x: obj.x, y: obj.y }, { x: obj.endX, y: obj.endY });
        return d <= (obj.lineWidth / 2 + p + 5);
    } else if (obj.type === 'pencil') {
        for (let i = 0; i < obj.points.length - 1; i++) {
            const d = distToSegment({ x, y }, obj.points[i], obj.points[i + 1]);
            if (d <= (obj.lineWidth / 2 + p + 5)) return true;
        }
    }
    return false;
}

function startTextInput(x, y) {
    createOverlay(x, y, "", (text) => {
        if (text) {
            objects.push({
                id: Date.now(), type: 'text', x, y, text,
                color: colorPicker.value, fontSize: parseInt(lineWidthInput.value) * 5, lineWidth: parseInt(lineWidthInput.value)
            });
            saveHistory();
        }
        render();
    });
}

function startTextEdit(obj) {
    isEditing = true;
    selectedObjectId = obj.id;
    const oldText = obj.text;
    obj.text = "";
    render();
    setActiveBtn(textBtn);
    createOverlay(obj.x, obj.y, oldText, (newText) => {
        isEditing = false;
        if (newText) {
            obj.text = newText;
            saveHistory();
        } else {
            objects = objects.filter(o => o.id !== obj.id);
            selectedObjectId = null;
            saveHistory();
        }
        setActiveBtn(null);
        render();
    });
}

function createOverlay(x, y, initialText, callback) {
    overlayContainer.innerHTML = "";

    // Convert canvas coordinates to display coordinates
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const displayX = x / scaleX;
    const displayY = y / scaleY;

    const input = document.createElement('div');
    input.className = 'text-input-overlay';
    input.contentEditable = true;
    input.innerText = initialText;
    input.style.left = displayX + 'px';
    input.style.top = displayY + 'px';
    input.style.color = colorPicker.value;
    input.style.fontSize = (parseInt(lineWidthInput.value) * 5 / scaleY) + 'px';
    overlayContainer.appendChild(input);

    const finish = () => {
        if (!input.parentElement) return;
        const text = input.innerText.trim();
        overlayContainer.innerHTML = "";
        callback(text);
    };

    setTimeout(() => {
        input.focus();
        if (initialText) {
            const range = document.createRange();
            range.selectNodeContents(input);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }, 10);

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                // Allow shift+enter for new line
                return;
            }
            e.preventDefault();
            finish();
        }
        if (e.key === 'Escape') {
            input.innerText = initialText;
            finish();
        }
    });
}

// A capture only enters the gallery once it is shared to Drive - see the cloud
// button below. Downloading or copying a file to the clipboard is a local,
// throwaway action and must not, on its own, make the capture persist anywhere.
saveBtn.addEventListener('click', () => {
    selectedObjectId = null; render();
    const link = document.createElement('a');

    // Improved sanitation for download filename: allow Arabic/Global characters
    let safeTitle = pageTitle.replace(/[/\\?%*:|"<>]/g, '').trim();
    safeTitle = safeTitle.replace(/\s+/g, '_');
    if (!safeTitle) safeTitle = 'capture';

    // Check if it's a video session
    const videoPlayer = document.getElementById('videoPlayer');
    if (videoPlayer && videoPlayer.style.display !== 'none' && window.pendingVideo) {
        // Download video
        const url = URL.createObjectURL(window.pendingVideo);
        link.download = `${safeTitle}.webm`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
    } else {
        // Download image
        link.download = `${safeTitle}.png`;
        link.href = canvas.toDataURL();
        link.click();
    }
});

copyBtn.addEventListener('click', async () => {
    selectedObjectId = null; render();
    try {
        const dataUrl = canvas.toDataURL('image/png');
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Image copied to clipboard!');
    } catch (err) {
        showToast('Failed to copy image.');
    }
});

function deleteSelected() {
    if (selectedObjectId) {
        objects = objects.filter(o => o.id !== selectedObjectId);
        selectedObjectId = null;
        saveHistory();
        render();
    }
}

deleteBtn.addEventListener('click', deleteSelected);

// Holding an arrow repeats the keydown; each repeat used to cost a history slot,
// and thirty of them buried the original capture. One nudge is recorded on keyup.
let arrowMovePending = false;

window.addEventListener('keydown', (e) => {
    if (isEditing) return; // Don't handle keys while typing text

    if (e.key === 'Escape') {
        if (currentTool === 'crop') {
            cropArea = null;
            currentTool = null;
            setActiveBtn(null);
            render();
        } else {
            selectedObjectId = null;
            render();
        }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only delete if not focused on an input or textarea
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            deleteSelected();
        }
    } else if (selectedObjectId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        // Move selected object with arrow keys
        e.preventDefault(); // Prevent page scrolling
        const obj = objects.find(o => o.id === selectedObjectId);
        if (!obj) return;

        const moveDistance = e.shiftKey ? 10 : 1; // Hold Shift for faster movement

        if (e.key === 'ArrowUp') {
            if (obj.type === 'pencil') {
                obj.points.forEach(p => p.y -= moveDistance);
            } else if (obj.type === 'arrow' || obj.type === 'line') {
                obj.y -= moveDistance;
                obj.endY -= moveDistance;
            } else {
                obj.y -= moveDistance;
            }
        } else if (e.key === 'ArrowDown') {
            if (obj.type === 'pencil') {
                obj.points.forEach(p => p.y += moveDistance);
            } else if (obj.type === 'arrow' || obj.type === 'line') {
                obj.y += moveDistance;
                obj.endY += moveDistance;
            } else {
                obj.y += moveDistance;
            }
        } else if (e.key === 'ArrowLeft') {
            if (obj.type === 'pencil') {
                obj.points.forEach(p => p.x -= moveDistance);
            } else if (obj.type === 'arrow' || obj.type === 'line') {
                obj.x -= moveDistance;
                obj.endX -= moveDistance;
            } else {
                obj.x -= moveDistance;
            }
        } else if (e.key === 'ArrowRight') {
            if (obj.type === 'pencil') {
                obj.points.forEach(p => p.x += moveDistance);
            } else if (obj.type === 'arrow' || obj.type === 'line') {
                obj.x += moveDistance;
                obj.endX += moveDistance;
            } else {
                obj.x += moveDistance;
            }
        }

        render();
        arrowMovePending = true;   // recorded on keyup, once
    }
});

window.addEventListener('keyup', (e) => {
    if (arrowMovePending && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        arrowMovePending = false;
        saveHistory();
    }
});

// ============================================
// Bug Report Modal - Azure DevOps Integration
// ============================================

const closeBugModal = document.getElementById('closeBugModal');
// const bugTitle = document.getElementById('bugTitle'); (already defined at top)

// Rich Text Editor Command
const updateToolbarStates = function () {
    const commands = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'];
    commands.forEach(cmd => {
        const btnId = 'rt' + (cmd.charAt(0).toUpperCase() + cmd.slice(1))
            .replace('InsertUnorderedList', 'Bullet')
            .replace('InsertOrderedList', 'OrderedList');
        const btn = document.getElementById(btnId);
        if (btn) {
            if (document.queryCommandState(cmd)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });
};

const execRTCommand = function (command, value = null) {
    const editor = document.getElementById('bugDescription');
    editor.focus();
    if (command === 'hiliteColor') {
        try { document.execCommand('hiliteColor', false, value); }
        catch (e) { document.execCommand('backColor', false, value); }
    } else {
        document.execCommand(command, false, value);
    }
    // Manually trigger input event to save
    editor.dispatchEvent(new Event('input'));
    updateToolbarStates();
};

// An image only survives the trip to Azure or Jira if it reaches us as a
// data: URL — that is what the upload step looks for. Chrome's own paste
// sometimes hands back a blob: URL instead, so read the clipboard directly.
const rtEsc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rtAttr = (v) => rtEsc(v).replace(/"/g, '&quot;');

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
});

async function insertImages(files) {
    const images = [...files].filter(f => f.type.startsWith('image/'));
    if (!images.length) return false;

    bugDescription.focus();
    for (const file of images) {
        try {
            const dataUrl = await readAsDataUrl(file);
            document.execCommand('insertHTML', false,
                `<img src="${dataUrl}" alt="${rtAttr(file.name || 'image')}">`);
        } catch (err) {
            console.error('Could not read image:', file.name, err);
            showToast(`Could not read ${file.name || 'that image'}`);
        }
    }
    bugDescription.dispatchEvent(new Event('input'));
    return true;
}

if (bugDescription) {
    ['keyup', 'mouseup', 'input', 'focus'].forEach(evt => {
        bugDescription.addEventListener(evt, updateToolbarStates);
    });

    bugDescription.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        if (!dt) return;

        // An image on the clipboard wins over any HTML that came with it:
        // copying from a page often carries both, and the picture is the point.
        const files = [...(dt.files || [])].filter(f => f.type.startsWith('image/'));
        if (files.length) {
            e.preventDefault();
            insertImages(files).then(saveLastFormValues);
            return;
        }

        // Otherwise paste the text and let our own toolbar do the formatting,
        // rather than importing a foreign page's fonts, colours and classes.
        const text = dt.getData('text/plain');
        if (text) {
            e.preventDefault();
            document.execCommand('insertText', false, text);
            saveLastFormValues();
        }
    });

    // Dropping a screenshot straight onto the box is the fastest path there is.
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    bugDescription.addEventListener('dragover', (e) => {
        stop(e);
        bugDescription.classList.add('drop-target');
    });
    bugDescription.addEventListener('dragleave', (e) => {
        stop(e);
        bugDescription.classList.remove('drop-target');
    });
    bugDescription.addEventListener('drop', (e) => {
        stop(e);
        bugDescription.classList.remove('drop-target');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) insertImages(files).then(saveLastFormValues);
    });
}

document.getElementById('rtImage')?.addEventListener('click', () =>
    document.getElementById('rtImageInput')?.click());

document.getElementById('rtImageInput')?.addEventListener('change', async (e) => {
    await insertImages(e.target.files);
    e.target.value = '';          // the same file may be picked twice in a row
    saveLastFormValues();
});

document.getElementById('rtLink')?.addEventListener('click', () => {
    // prompt() blurs the editor and collapses the selection, so hold on to the
    // range first and put it back before running the command.
    const sel = window.getSelection();
    const range = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
    const selected = sel ? String(sel).trim() : '';

    const url = prompt('Link URL', 'https://');
    if (!url || url === 'https://') return;

    bugDescription.focus();
    if (range) {
        const s2 = window.getSelection();
        s2.removeAllRanges();
        s2.addRange(range);
    }
    if (selected) execRTCommand('createLink', url);
    else execRTCommand('insertHTML', `<a href="${rtAttr(url)}">${rtEsc(url)}</a>`);
});

document.getElementById('rtCode')?.addEventListener('click', () => {
    const sel = window.getSelection();
    const text = sel ? String(sel) : '';
    if (!text) { showToast('Select the text to mark as code'); return; }
    execRTCommand('insertHTML', `<code>${rtEsc(text)}</code>`);
});

document.getElementById('rtQuote')?.addEventListener('click', () => execRTCommand('formatBlock', 'blockquote'));

// Map RT Buttons
document.getElementById('rtBold')?.addEventListener('click', () => execRTCommand('bold'));
document.getElementById('rtItalic')?.addEventListener('click', () => execRTCommand('italic'));
document.getElementById('rtUnderline')?.addEventListener('click', () => execRTCommand('underline'));
document.getElementById('rtBullet')?.addEventListener('click', () => execRTCommand('insertUnorderedList'));
document.getElementById('rtOrderedList')?.addEventListener('click', () => execRTCommand('insertOrderedList'));
document.getElementById('rtOutdent')?.addEventListener('click', () => execRTCommand('outdent'));
document.getElementById('rtIndent')?.addEventListener('click', () => execRTCommand('indent'));
document.getElementById('rtClear')?.addEventListener('click', () => execRTCommand('removeFormat'));
document.getElementById('rtFontColor')?.addEventListener('input', (e) => {
    const color = e.target.value;
    execRTCommand('foreColor', color);
    const icon = e.target.previousElementSibling;
    if (icon) icon.style.color = color;
});

document.getElementById('rtBackColor')?.addEventListener('input', (e) => {
    const color = e.target.value;
    execRTCommand('hiliteColor', color);
    const icon = e.target.previousElementSibling;
    if (icon) icon.style.color = color;
});

// Prevent focus loss on RT buttons
document.querySelectorAll('.rich-toolbar-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
});

// Initial Sync for colors
function syncRichTextColors() {
    const fontColorInput = document.getElementById('rtFontColor');
    const backColorInput = document.getElementById('rtBackColor');

    if (fontColorInput) {
        const icon = fontColorInput.previousElementSibling;
        if (icon) icon.style.color = fontColorInput.value;
    }
    if (backColorInput) {
        const icon = backColorInput.previousElementSibling;
        if (icon) icon.style.color = backColorInput.value;
    }
}
syncRichTextColors();

let allMembers = [];
let allWorkItems = [];
let allProjectTags = [];
// let isInitializing = false; (already defined at top)
let stageFieldReferenceName = 'Microsoft.VSTS.Build.FoundIn';


// Load projects when organization changes
bugOrg.addEventListener('change', async () => {
    // bugProject is shared with Jira. Restoring the last form values dispatches
    // a change on bugOrg even when Jira is selected, which used to repopulate
    // the list with Azure projects behind Jira's back.
    const targetSel = document.getElementById('bugTarget');
    if (targetSel && targetSel.value !== 'azure') return;

    const org = bugOrg.value;
    bugProject.innerHTML = '<option value="">Loading...</option>';
    bugProject.disabled = true;

    if (!org) {
        bugProject.innerHTML = '<option value="">-- Select Org First --</option>';
        return;
    }

    try {
        const settings = await new Promise(resolve => chrome.storage.sync.get(['azurePat'], resolve));
        if (!settings.azurePat) {
            bugProject.innerHTML = '<option value="">Configure PAT first</option>';
            return;
        }

        const rawPat = settings.azurePat || '';
        const pat = rawPat.trim();
        if (!pat) {
            bugProject.innerHTML = '<option value="">PAT is empty</option>';
            return;
        }

        const authHeader = 'Basic ' + btoa(':' + pat);
        const trimmedOrg = org.trim();
        const encodedOrg = encodeURIComponent(trimmedOrg);
        const targetUrl = `https://dev.azure.com/${encodedOrg}/_apis/projects?api-version=7.0`;

        const response = await fetch(targetUrl, {
            headers: {
                'Authorization': authHeader,
                'Accept': 'application/json'
            },
            cache: 'no-store',
            redirect: 'follow'
        }).catch(err => {
            console.error('Network Error fetching projects:', err);
            throw new Error(`Connection failed: ${err.message}`);
        });

        if (!response.ok) {
            const errorMsg = await response.text();
            console.error('API Error Response:', response.status, errorMsg);
            throw new Error(`API ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        let data;
        try {
            data = await response.json();
        } catch (jsonErr) {
            console.error('JSON Parse Error:', jsonErr, 'ContentType:', contentType, 'URL:', response.url);
            if (contentType.includes('text/html') || response.url.includes('signin') || response.url.includes('login')) {
                throw new Error('Authentication required (Redirected)');
            }
            throw new Error('Invalid JSON response');
        }

        const projects = data.value || [];

        bugProject.innerHTML = '<option value="">-- Select Project --</option>';
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            bugProject.appendChild(opt);
        });
        bugProject.disabled = false;

        // Reset fields when org changes
        allMembers = [];
        selectedMembers.clear();
        selectedManagers.clear();
        selectedTags.clear();

        renderMemberPills();
        renderManagerPills();
        renderTagPills();

        allWorkItems = [];
        allProjectTags = [];

        saveLastFormValues();
    } catch (err) {
        console.error('Final Project Load Error:', err);
        bugProject.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
});

// ========= Persistence Logic (Extension) =========
// Sticky fields: the ones that describe *where* a bug is filed. They rarely
// change between reports, so retyping them every time is pure friction.
// Deliberately excluded: bugTitle, bugDescription and bugSeverity — those
// belong to one bug only, and carrying them over means the next report opens
// pre-filled with the previous bug's text.
const persistFields = ["bugOrg", "bugProject", "bugFoundIn", "bugParentSearch",
    "bugParent", "bugTags", "bugAssignedTo", "bugDirectManager", "bugArea", "bugIteration"];

function saveLastFormValues() {
    if (isInitializing) return;
    const values = {};
    persistFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) values[id] = el.value;
    });
    // Store pill data for restoration
    values.selectedMembers = Array.from(selectedMembers);
    values.selectedManagers = Array.from(selectedManagers);
    values.selectedTags = Array.from(selectedTags);

    // Save dynamic fields (Azure)
    values.dynamicFields = collectDynamicFields().map(df => {
        const fieldMeta = allAdoFields.find(f => f.referenceName === df.refName);
        return { refName: df.refName, value: df.value, fieldMeta };
    });

    // Save dynamic fields (Jira) - defined inside the bugTarget closure,
    // reached the same way window.bugTargetReady is.
    if (window.collectJiraDynamicFields) values.jiraDynamicFields = window.collectJiraDynamicFields();

    chrome.storage.local.set({ "bug_form_last_values": values });
}

async function loadLastFormValues() {
    isInitializing = true;
    chrome.storage.local.get(["bug_form_last_values"], async (result) => {
        const values = result["bug_form_last_values"];
        if (!values) {
            isInitializing = false;
            return;
        }

        const tSel = document.getElementById('bugTarget');
        const isAzure = !tSel || tSel.value === 'azure';

        if (isAzure && values.bugOrg) {
            bugOrg.value = values.bugOrg;
            bugOrg.dispatchEvent(new Event('change'));

            let attempts = 0;
            const checkProject = setInterval(() => {
                attempts++;
                if ((!bugProject.disabled && bugProject.options.length > 1) || attempts > 50) {
                    clearInterval(checkProject);
                    if (values.bugProject && (bugProject.options.namedItem(values.bugProject) || Array.from(bugProject.options).some(o => o.value === values.bugProject))) {
                        bugProject.value = values.bugProject;
                        bugProject.dispatchEvent(new Event('change'));

                        setTimeout(() => {
                            if (values.bugFoundIn) bugFoundIn.value = values.bugFoundIn;
                            if (values.bugSeverity) bugSeverity.value = values.bugSeverity;
                            if (values.bugParentSearch) bugParentSearch.value = values.bugParentSearch;
                            if (values.bugParent) bugParent.value = values.bugParent;

                            setTimeout(() => {
                                if (values.bugArea) bugArea.value = values.bugArea;
                                if (values.bugIteration) bugIteration.value = values.bugIteration;
                            }, 500);

                            if (values.selectedTags) {
                                selectedTags = new Set(values.selectedTags);
                                renderTagPills();
                            } else if (values.bugTags) {
                                selectedTags = new Set(values.bugTags.split(',').map(t => t.trim()).filter(Boolean));
                                renderTagPills();
                            }
                            if (values.selectedMembers) {
                                selectedMembers = new Set(values.selectedMembers);
                                renderMemberPills();
                            }
                            if (values.selectedManagers) {
                                selectedManagers = new Set(values.selectedManagers);
                                renderManagerPills();
                            }

                            // Restore dynamic fields
                            if (values.dynamicFields && values.dynamicFields.length > 0) {
                                dynamicFieldsContainer.innerHTML = '';
                                activeDynamicFields.clear();
                                values.dynamicFields.forEach(df => {
                                    if (df.fieldMeta) {
                                        addDynamicField(df.fieldMeta, df.value, !!df.fieldMeta.alwaysRequired);
                                    }
                                });
                            }
                            // The saved draft may predate a field Azure now
                            // always requires - fill that in. An OPTIONAL
                            // field missing from the draft was removed on
                            // purpose (that's what removing it means), so
                            // only required fields get backfilled here.
                            autoRenderAdoFields(true);

                            isInitializing = false;
                        }, 2000); // Wait 2s for all ADO lists
                    } else {
                        isInitializing = false;
                    }
                }
            }, 100);
        } else if (!isAzure) {
            // Jira's project (and its fields) load on their own via
            // bugTargetReady/fillJiraProjects - there is no org/project
            // dance to drive here, just a wait for that render to land
            // before applying the same draft restore Azure's fields get.
            let attempts = 0;
            const checkFields = setInterval(() => {
                attempts++;
                const ready = window.jiraFieldsReady && window.jiraFieldsReady();
                if (ready || attempts > 50) {
                    clearInterval(checkFields);
                    if (ready && values.jiraDynamicFields && window.restoreJiraDynamicFields) {
                        window.restoreJiraDynamicFields(values.jiraDynamicFields);
                    }
                    isInitializing = false;
                }
            }, 100);
        } else {
            isInitializing = false;
        }
    });
}

// Attach change listeners to persist fields
persistFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveLastFormValues);
});
bugParentSearch.addEventListener('input', saveLastFormValues);
bugTagsSearch.addEventListener('input', saveLastFormValues);

// ========= Sharing a capture =========
const NEW_WORKSPACE = '__new__';

async function getWorkspaces() {
    if (workspacesCache) return workspacesCache;
    const res = await chrome.runtime.sendMessage({ action: 'listWorkspaces' }).catch(() => null);
    if (res && res.success) { workspacesCache = res; return res; }
    return { workspaces: [], defaultName: '' };
}

// A dedicated dialog, not showCustomModal: this one needs a second field - which
// Drive folder (workspace) the capture is filed into, with room to create a new
// one on the spot. Resolves to { title, workspace } or false if cancelled.
function showShareModal(defaultTitle) {
    const modal = document.getElementById('shareModal');
    const titleInput = document.getElementById('shareTitleInput');
    const select = document.getElementById('shareWorkspaceSelect');
    const newInput = document.getElementById('shareWorkspaceNew');
    const confirmBtn = document.getElementById('shareModalConfirmBtn');
    const cancelBtn = document.getElementById('shareModalCancelBtn');
    const closeBtn = document.getElementById('shareModalCloseBtn');

    if (!modal) return Promise.resolve({ title: defaultTitle, workspace: '' });

    titleInput.value = defaultTitle;
    select.innerHTML = '';
    select.appendChild(new Option('Loading workspaces…', ''));
    select.disabled = true;
    newInput.style.display = 'none';
    newInput.value = '';

    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => titleInput.focus(), 100);

    getWorkspaces().then(({ workspaces, defaultName }) => {
        select.innerHTML = '';
        for (const w of workspaces) {
            select.appendChild(new Option(w.name === defaultName ? `${w.name} (default)` : w.name, w.name, false, w.name === defaultName));
        }
        select.appendChild(new Option('+ New workspace…', NEW_WORKSPACE));
        select.disabled = false;
    });

    select.onchange = () => {
        const isNew = select.value === NEW_WORKSPACE;
        newInput.style.display = isNew ? '' : 'none';
        if (isNew) newInput.focus();
    };

    return new Promise((resolve) => {
        const cleanup = (value) => {
            modal.style.display = 'none';
            modal.classList.remove('show');
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
            closeBtn.onclick = null;
            resolve(value);
        };
        confirmBtn.onclick = () => {
            const title = titleInput.value.trim() || defaultTitle;
            let workspace = select.value;
            if (workspace === NEW_WORKSPACE) {
                workspace = newInput.value.trim();
                if (!workspace) { newInput.focus(); return; }
            }
            cleanup({ title, workspace });
        };
        cancelBtn.onclick = () => cleanup(false);
        closeBtn.onclick = () => cleanup(false);
    });
}

// One folder in the user's own Drive, one link, readable by anyone who has it.
if (cloudUploadBtn) {
    cloudUploadBtn.addEventListener('click', async () => {
        const id = captureId || 'currentScreenshot';

        // Shared, and Drive already shows this. Hand back the link.
        if (shareUrl && sharedImage === imageFingerprint()) {
            await navigator.clipboard.writeText(shareUrl).catch(() => { });
            showToast('Link copied');
            return;
        }

        const updating = !!shareUrl;
        let title = pageTitle;
        let workspace = '';
        if (!updating) {
            const picked = await showShareModal(pageTitle);
            if (picked === false) return;
            title = picked.title;
            workspace = picked.workspace;
        }

        try {
            toggleLoader(true, updating ? 'Updating the shared image…' : 'Uploading to Drive…');
            selectedObjectId = null; render();   // no selection handles in the shared image

            // This is the moment the capture is kept at all: nothing was written
            // to the gallery when it was taken, only to this editor session. Write
            // what is on the canvas (or, for a recording, the video itself) into
            // the library now, so the link shows this and the gallery entry exists.
            const dataUrl = isVideoSession
                ? (window.pendingVideo ? await readAsDataUrl(window.pendingVideo) : null)
                : canvas.toDataURL('image/png');
            if (dataUrl) {
                const ctxRes = captureId ? await chrome.storage.local.get([`ctx_${captureId}`]) : {};
                const ctx = captureId ? ctxRes[`ctx_${captureId}`] : null;
                // The gallery only ever shows a play-icon placeholder for video
                // otherwise - a real frame is worth grabbing while the <video>
                // is already loaded here (the service worker has no DOM to do
                // this with itself).
                let thumbDataUrl = null;
                if (isVideoSession && videoPlayer && videoPlayer.videoWidth) {
                    try {
                        const maxW = 480;
                        const scale = Math.min(1, maxW / videoPlayer.videoWidth);
                        const tw = Math.max(1, Math.round(videoPlayer.videoWidth * scale));
                        const th = Math.max(1, Math.round(videoPlayer.videoHeight * scale));
                        const tc = document.createElement('canvas');
                        tc.width = tw; tc.height = th;
                        tc.getContext('2d').drawImage(videoPlayer, 0, 0, tw, th);
                        thumbDataUrl = tc.toDataURL('image/webp', 0.7);
                    } catch (e) {
                        console.error('video thumbnail failed:', e);
                    }
                }
                await chrome.runtime.sendMessage({
                    action: 'capLibrarySave', id, dataUrl, title,
                    type: isVideoSession ? 'video' : 'image', skipCloud: true, ctx, thumbDataUrl
                });
            }

            // `replace` keeps the same Drive file, so the link a colleague already
            // has keeps working and starts showing the new version. The same bytes
            // ride along here too, so the upload is exactly what was just saved.
            const res = await chrome.runtime.sendMessage({ action: 'shareCapture', id, title, replace: updating, dataUrl, workspace });
            if (!res || !res.success) throw new Error((res && res.error) || 'no response from the extension');

            shareUrl = res.url;
            sharedImage = imageFingerprint();
            // Persist it, or the button forgets after a reload and offers to update
            // a file it has already been told is identical.
            await chrome.storage.local.set({ [`cloudUrl_${id}`]: res.url, [`cloudHash_${id}`]: sharedImage });
            updateShareButton();

            // A workspace typed for the first time here should be pickable
            // right away if another capture is shared in this same session.
            if (res.workspace && workspacesCache && !workspacesCache.workspaces.some(w => w.name === res.workspace)) {
                workspacesCache.workspaces.push({ name: res.workspace });
            }

            await navigator.clipboard.writeText(res.url).catch(() => { });
            showToast(res.recreated
                ? 'The old Drive file was deleted - uploaded a new copy. New link copied.'
                : (updating ? 'Updated - same link' : 'Link copied to clipboard'));
        } catch (err) {
            console.error('Share failed:', err);
            showToast('Could not share: ' + (err.message || err));
        } finally {
            toggleLoader(false);
        }
    });
}

if (viewHistoryBtn) {
    viewHistoryBtn.addEventListener('click', () => {
        window.open('history.html', '_blank');
    });
}


// Load all project data when project changes
bugProject.addEventListener('change', async () => {
    const org = bugOrg.value.trim();
    const project = bugProject.value.trim();

    if (!project) {
        allMembers = [];
        bugAssignedToList.innerHTML = '';
        bugDirectManagerList.innerHTML = '';
        bugParentList.innerHTML = '';
        bugArea.value = '';
        bugIteration.value = '';
        // The field list belongs to a project. Without one there is nothing to add.
        addFieldBtn.disabled = true;
        const lbl = document.getElementById('addFieldLabel');
        if (lbl) lbl.textContent = 'Select a project first';
        return;
    }

    // Custom fields belong to one project's process, not the next one - a field
    // left over from the previous project would otherwise sit in the form next
    // to fields for a process it has nothing to do with.
    dynamicFieldsContainer.innerHTML = '';
    activeDynamicFields.clear();

    try {
        const settings = await new Promise(resolve => chrome.storage.sync.get(['azurePat'], resolve));
        const pat = (settings.azurePat || '').trim();
        if (!pat) return;

        const authHeader = 'Basic ' + btoa(':' + pat);

        // Load all data in parallel
        await Promise.all([
            loadTeamMembers(org, project, authHeader),
            loadWorkItems(org, project, authHeader),
            loadProjectTags(org, project, authHeader),
            loadBugFieldOptions(org, project, authHeader)
        ]);

    } catch (err) {
        console.error('Error loading project data:', err);
    }
});

// An empty dropdown with no explanation is the shape every bug in this file
// took. These loaders feed optional lists, so a console warning is proportionate
// for two of them - but the status has to reach someone.
function azWarn(res, what) {
    const why = (res.status === 401 || res.status === 403) ? 'Azure refused the PAT' : `HTTP ${res.status}`;
    console.warn(`[QA Toolkit] ${what}: ${why}`);
    return why;
}

async function loadBugFieldOptions(org, project, authHeader) {
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);

    try {
        const resp = await fetch(
            `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/workitemtypes/Bug/fields?$expand=allowedValues&api-version=7.0`,
            { headers: { 'Authorization': authHeader } }
        );
        // This one decides which fields exist and what they may contain. Losing
        // it silently is how you end up filing a bug against nothing.
        if (!resp.ok) {
            showToast(`Could not read this project's fields: ${azWarn(resp, 'Bug field options')}`);
            return;
        }

        const data = await resp.json();
        const fields = data.value || [];
        allAdoFields = fields;

        // A greyed-out button that says "Add New Field" invites the question this
        // one answers on its own.
        addFieldBtn.disabled = false;
        const addFieldLabel = document.getElementById('addFieldLabel');
        if (addFieldLabel) addFieldLabel.textContent = 'Add New Field';

        // Find Severity field
        const severityField = fields.find(f =>
            f.referenceName === 'Microsoft.VSTS.Common.Severity' ||
            f.name.toLowerCase() === 'severity'
        );

        // Find Stage/Found In field - Specifically "Found In Stage" as requested
        const stageField = fields.find(f => (f.name || '').toLowerCase() === 'found in stage');
        if (stageField) {
            stageFieldReferenceName = stageField.referenceName;
        } else {
            stageFieldReferenceName = 'Microsoft.VSTS.Build.FoundIn'; // Fallback
        }

        console.log('ADO Stage Match (Found In Stage):', {
            found: !!stageField,
            name: stageField ? stageField.name : null,
            refName: stageFieldReferenceName,
            optionsCount: (stageField && stageField.allowedValues) ? stageField.allowedValues.length : 0
        });

        // Find Direct Manager field
        const directManagerField = fields.find(f =>
            f.referenceName === 'Custom.DirectManager' ||
            f.name.toLowerCase() === 'direct manager'
        );

        // Severity
        if (severityField && severityField.allowedValues && severityField.allowedValues.length > 0) {
            const currentVal = bugSeverity.value;
            const adodefault = severityField.defaultValue;

            bugSeverity.innerHTML = '';
            severityField.allowedValues.forEach(val => {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = val;
                bugSeverity.appendChild(opt);
            });

            // Priority: 1. Current user selection (if valid), 2. ADO Default, 3. Medium fallback
            if (currentVal && Array.from(bugSeverity.options).some(o => o.value === currentVal)) {
                bugSeverity.value = currentVal;
            } else if (adodefault && Array.from(bugSeverity.options).some(o => o.value === adodefault)) {
                bugSeverity.value = adodefault;
            } else {
                const mediumOpt = Array.from(bugSeverity.options).find(o => o.value.includes('3') || o.value.toLowerCase().includes('medium'));
                if (mediumOpt) bugSeverity.value = mediumOpt.value;
                else if (bugSeverity.options.length > 0) bugSeverity.selectedIndex = 0;
            }
        }

        // Stage (Found In)
        const stageGroup = bugFoundIn.closest('.form-group');
        if (stageField && stageField.allowedValues) {
            bugFoundIn.disabled = false;
            if (stageGroup) stageGroup.style.display = 'block';

            const currentVal = bugFoundIn.value;
            const adodefault = stageField.defaultValue;

            bugFoundIn.innerHTML = '<option value="">Select Stage</option>';
            stageField.allowedValues.forEach(val => {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = val;
                bugFoundIn.appendChild(opt);
            });

            // Priority: 1. Current user selection (if valid), 2. ADO Default
            if (currentVal && Array.from(bugFoundIn.options).some(o => o.value === currentVal)) {
                bugFoundIn.value = currentVal;
            } else if (adodefault && Array.from(bugFoundIn.options).some(o => o.value === adodefault)) {
                bugFoundIn.value = adodefault;
            }
        } else {
            bugFoundIn.disabled = true;
            bugFoundIn.value = '';
            bugFoundIn.innerHTML = '<option value="">Select Stage</option>';
            if (stageGroup) stageGroup.style.display = 'none';
        }

        // Direct Manager
        const dmSearch = document.getElementById('bugDirectManagerSearch');
        const dmGroup = dmSearch.closest('.form-group');
        const dmLabel = dmGroup ? dmGroup.querySelector('label') : null;

        if (directManagerField) {
            dmSearch.disabled = false;
            if (dmGroup) dmGroup.style.display = 'block';
            if (dmLabel) dmLabel.classList.add('required');
        } else {
            dmSearch.disabled = true;
            dmSearch.value = '';
            bugDirectManager.value = '';
            selectedManagers.clear();
            renderManagerPills();
            if (dmGroup) dmGroup.style.display = 'none';
            if (dmLabel) dmLabel.classList.remove('required');
        }

        // Everything Azure's own "New Bug" form would show renders on its own
        // from here - not just what the user manually adds via "Add New Field".
        autoRenderAdoFields();

    } catch (e) {
        console.error("Failed to load bug field options", e);
    }
}

async function loadTeamMembers(org, project, authHeader) {
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);
    const membersSet = new Set();

    try {
        // 1. Get Project Metadata to get ID
        const projectResp = await fetch(
            `https://dev.azure.com/${encodedOrg}/_apis/projects/${encodedProject}?api-version=7.0`,
            { headers: { 'Authorization': authHeader } }
        );
        if (projectResp.ok) {
            const projectData = await projectResp.json();
            const projectId = projectData.id;

            // 2. Try Graph API for full Project Scope
            // First get project descriptor
            const descResp = await fetch(
                `https://dev.azure.com/${encodedOrg}/_apis/graph/descriptors/${projectId}?api-version=7.1-preview.1`,
                { headers: { 'Authorization': authHeader } }
            );
            if (descResp.ok) {
                const descData = await descResp.json();
                const scopeDescriptor = descData.value;

                // Get all users in project scope
                const graphResp = await fetch(
                    `https://dev.azure.com/${encodedOrg}/_apis/graph/users?scopeDescriptor=${scopeDescriptor}&api-version=7.1-preview.1`,
                    { headers: { 'Authorization': authHeader } }
                );
                if (graphResp.ok) {
                    const graphData = await graphResp.json();
                    (graphData.value || []).forEach(u => {
                        if (u.displayName) {
                            membersSet.add(JSON.stringify({
                                name: u.displayName,
                                email: u.mailAddress || u.principalName || u.displayName
                            }));
                        }
                    });
                    console.log(`Graph API found ${membersSet.size} members for project scope.`);
                }
            }

            // 3. Try IdentityPicker (Refined)
            if (membersSet.size < 5) { // If Graph didn't return much, try IdentityPicker
                const identityResp = await fetch(
                    `https://dev.azure.com/${encodedOrg}/_apis/IdentityPicker/Identities?api-version=7.1-preview.1`,
                    {
                        method: 'POST',
                        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            "query": "",
                            "identityTypes": ["user"],
                            "operationScopes": ["ims", "source"],
                            "properties": ["DisplayName", "UniqueName"],
                            "filterByAncestorEntityIds": [projectId],
                            "selectionLimit": 500
                        })
                    }
                );
                if (identityResp.ok) {
                    const identityData = await identityResp.json();
                    const identities = identityData.results?.[0]?.identities || [];
                    let ipCount = 0;
                    identities.forEach(id => {
                        if (id.displayName) {
                            const member = JSON.stringify({
                                name: id.displayName,
                                email: id.uniqueName || id.signInAddress || id.displayName
                            });
                            if (!membersSet.has(member)) {
                                membersSet.add(member);
                                ipCount++;
                            }
                        }
                    });
                    console.log(`IdentityPicker added ${ipCount} additional members.`);
                }
            }
        }
    } catch (err) {
        console.error("Advanced member fetch failed, falling back to basic teams", err);
    }

    // 4. Fallback: Basic Teams Loop
    if (membersSet.size < 5) {
        try {
            const teamsResp = await fetch(
                `https://dev.azure.com/${encodedOrg}/_apis/projects/${encodedProject}/teams?api-version=7.0`,
                { headers: { 'Authorization': authHeader } }
            );
            if (teamsResp.ok) {
                const teamsData = await teamsResp.json();
                let teamCount = 0;
                for (const team of (teamsData.value || [])) {
                    const membersResp = await fetch(
                        `https://dev.azure.com/${encodedOrg}/_apis/projects/${encodedProject}/teams/${team.id}/members?$top=1000&api-version=7.0`,
                        { headers: { 'Authorization': authHeader } }
                    );
                    if (membersResp.ok) {
                        const membersData = await membersResp.json();
                        (membersData.value || []).forEach(m => {
                            if (m.identity && m.identity.displayName) {
                                const member = JSON.stringify({
                                    name: m.identity.displayName,
                                    email: m.identity.uniqueName || m.identity.displayName
                                });
                                if (!membersSet.has(member)) {
                                    membersSet.add(member);
                                    teamCount++;
                                }
                            }
                        });
                    }
                }
                console.log(`Team fetch added ${teamCount} additional members.`);
            }
        } catch (e) {
            console.error("Team fallback fetch failed", e);
        }
    }

    allMembers = Array.from(membersSet).map(s => JSON.parse(s)).sort((a, b) => a.name.localeCompare(b.name));
    console.log(`Synchronization Complete: ${allMembers.length} total members loaded for project.`);
}

let projectIdCache = {};

async function loadWorkItems(org, project, authHeader) {
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);
    const resp = await fetch(
        `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/wiql?api-version=7.0`,
        {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' AND [System.WorkItemType] = 'User Story' ORDER BY [System.ChangedDate] DESC`
            })
        }
    );
    if (!resp.ok) { azWarn(resp, 'Work item list'); return; }

    const wiqlData = await resp.json();
    const ids = (wiqlData.workItems || []).slice(0, 100).map(w => w.id);
    if (ids.length === 0) return;

    const batchResp = await fetch(
        `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/workitemsbatch?api-version=7.0`,
        {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids, fields: ['System.Id', 'System.Title', 'System.WorkItemType'] })
        }
    );
    if (!batchResp.ok) return;

    const batchData = await batchResp.json();
    allWorkItems = (batchData.value || []).map(w => ({
        id: w.id,
        title: w.fields['System.Title'],
        type: w.fields['System.WorkItemType']
    }));
}

async function loadProjectTags(org, project, authHeader) {
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);
    try {
        const resp = await fetch(
            `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/tags?api-version=7.0`,
            { headers: { 'Authorization': authHeader } }
        );
        if (!resp.ok) { azWarn(resp, 'Project tags'); return; }
        const data = await resp.json();
        allProjectTags = (data.value || []).map(t => t.name).sort();
    } catch (e) {
        console.error("Failed to load project tags", e);
    }
}

// Searchable Fields (Assigned To & Direct Manager)
let selectedMembers = new Set();
let selectedManagers = new Set();

function renderMemberPills() {
    bugAssignedToPills.innerHTML = '';
    selectedMembers.forEach(m => {
        const displayName = typeof m === 'object' ? m.name : m;
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.innerHTML = `<span>${displayName}</span><span class="remove-tag">&times;</span>`;
        pill.querySelector('.remove-tag').onclick = () => {
            selectedMembers.delete(m);
            renderMemberPills();
            saveLastFormValues();
        };
        bugAssignedToPills.appendChild(pill);
    });
    // Sync format with Bugs.html: Name <Email>
    bugAssignedTo.value = Array.from(selectedMembers).map(m => {
        if (typeof m === 'object' && m.email) return `${m.name} <${m.email}>`;
        if (typeof m === 'object') return m.name;
        return m;
    }).join('; ');
}

function renderManagerPills() {
    bugDirectManagerPills.innerHTML = '';
    selectedManagers.forEach(m => {
        const displayName = typeof m === 'object' ? m.name : m;
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.innerHTML = `<span>${displayName}</span><span class="remove-tag">&times;</span>`;
        pill.querySelector('.remove-tag').onclick = () => {
            selectedManagers.delete(m);
            renderManagerPills();
            saveLastFormValues();
        };
        bugDirectManagerPills.appendChild(pill);
    });
    // Sync format with Bugs.html: Name <Email>
    bugDirectManager.value = Array.from(selectedManagers).map(m => {
        if (typeof m === 'object' && m.email) return `${m.name} <${m.email}>`;
        if (typeof m === 'object') return m.name;
        return m;
    }).join('; ');
}

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

async function searchMembersOnServer(query, resultContainer, selectionSet, searchInput, renderPills) {
    const org = bugOrg.value.trim();
    const project = bugProject.value.trim();
    if (!org || !project || !query || query.length < 1) return;

    // Visual feedback: Show searching state
    resultContainer.innerHTML = '<div class="multi-select-item" style="color: var(--accent-blue);">Searching everything...</div>';
    resultContainer.classList.add('show');

    try {
        const settings = await new Promise(resolve => chrome.storage.sync.get(['azurePat'], resolve));
        const pat = (settings.azurePat || '').trim();
        if (!pat) return;
        const authHeader = 'Basic ' + btoa(':' + pat);

        // ATTEMPT 1: Broad Search (AAD + Org Wide)
        let identities = await performIdentitySearch(org, query, true, authHeader);

        // ATTEMPT 2: Fallback if Attempt 1 returned nothing or errored (e.g. 403)
        if (identities === null || (Array.isArray(identities) && identities.length === 0)) {
            console.log("Broad search returned nothing or failed. Trying project-local fallback...");
            identities = await performIdentitySearch(org, query, false, authHeader);
        }

        // Processing results
        resultContainer.innerHTML = '';
        const finalResults = [];
        const seenEmails = new Set();

        // 1. Add Server Results
        if (Array.isArray(identities)) {
            identities.forEach(id => {
                const email = (id.uniqueName || id.signInAddress || id.displayName).toLowerCase();
                if (!seenEmails.has(email)) {
                    finalResults.push({ name: id.displayName, email: email, source: 'server' });
                    seenEmails.add(email);
                }
            });
        }

        // 2. Add/Merge Local Cache Results (allMembers)
        const q = query.toLowerCase();
        allMembers.forEach(m => {
            const email = m.email.toLowerCase();
            if (!seenEmails.has(email) && (m.name.toLowerCase().includes(q) || email.includes(q))) {
                finalResults.push({ name: m.name, email: email, source: 'local' });
                seenEmails.add(email);
            }
        });

        if (finalResults.length === 0) {
            resultContainer.innerHTML = `<div class="multi-select-item">No matches found for "${query}"</div>`;
            return;
        }

        finalResults.slice(0, 30).forEach(m => {
            const item = document.createElement('div');
            item.className = 'multi-select-item';
            item.innerHTML = `<strong>${m.name}</strong> <br/><small>${m.email}</small>`;
            item.onclick = () => {
                selectionSet.clear();
                selectionSet.add({ name: m.name, email: m.email });
                searchInput.value = '';
                resultContainer.classList.remove('show');
                renderPills();
                saveLastFormValues();
            };
            resultContainer.appendChild(item);
        });

    } catch (err) {
        console.error("Critical search failure:", err);
        triggerLocalFallback(query, resultContainer, selectionSet, searchInput, renderPills);
    }
}

async function performIdentitySearch(org, query, useAAD, authHeader) {
    try {
        const body = {
            "query": query,
            "identityTypes": ["user"],
            "operationScopes": useAAD ? ["ims", "source", "aad"] : ["ims", "source"],
            "properties": ["DisplayName", "UniqueName"],
            "selectionLimit": 30
        };

        const resp = await fetch(
            `https://dev.azure.com/${encodeURIComponent(org)}/_apis/IdentityPicker/Identities?api-version=7.1-preview.1`,
            {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );

        if (!resp.ok) {
            console.warn(`Search attempt (AAD:${useAAD}) failed with status ${resp.status}`);
            return null;
        }

        const data = await resp.json();
        return data.results?.[0]?.identities || [];
    } catch (e) {
        console.error("API Fetch Error:", e);
        return null;
    }
}

function triggerLocalFallback(query, resultContainer, selectionSet, searchInput, renderPills) {
    console.log("Triggering local search fallback for:", query);
    showLocalMemberSuggestions(query, resultContainer, selectionSet, searchInput, renderPills);
}

const debouncedMemberSearch = debounce((query) => {
    searchMembersOnServer(query, bugAssignedToResults, selectedMembers, bugAssignedToSearch, renderMemberPills);
}, 300);

const debouncedManagerSearch = debounce((query) => {
    searchMembersOnServer(query, bugDirectManagerResults, selectedManagers, bugDirectManagerSearch, renderManagerPills);
}, 300);

bugAssignedToSearch.addEventListener('focus', () => {
    if (bugAssignedToSearch.value.trim().length >= 1) {
        debouncedMemberSearch(bugAssignedToSearch.value.trim());
    } else {
        showLocalMemberSuggestions(bugAssignedToSearch.value.trim(), bugAssignedToResults, selectedMembers, bugAssignedToSearch, renderMemberPills);
    }
});
bugAssignedToSearch.addEventListener('input', () => {
    const q = bugAssignedToSearch.value.trim();
    if (q.length >= 1) {
        debouncedMemberSearch(q);
    } else {
        showLocalMemberSuggestions(q, bugAssignedToResults, selectedMembers, bugAssignedToSearch, renderMemberPills);
    }
});

function showLocalMemberSuggestions(query, resultContainer, selectionSet, searchInput, renderPills) {
    const q = query.toLowerCase();
    const filtered = allMembers.filter(m =>
        (m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) &&
        !Array.from(selectionSet).some(sm => sm.email === m.email)
    );
    resultContainer.innerHTML = '';
    filtered.slice(0, 15).forEach(m => {
        const item = document.createElement('div');
        item.className = 'multi-select-item';
        item.innerHTML = `<strong>${m.name}</strong> <br/><small>${m.email}</small>`;
        item.onclick = () => {
            selectionSet.clear();
            selectionSet.add(m);
            searchInput.value = '';
            resultContainer.classList.remove('show');
            renderPills();
            saveLastFormValues();
        };
        resultContainer.appendChild(item);
    });
    if (filtered.length > 0) resultContainer.classList.add('show');
    else resultContainer.classList.remove('show');
}

bugDirectManagerSearch.addEventListener('focus', () => {
    if (bugDirectManagerSearch.value.trim().length >= 1) {
        debouncedManagerSearch(bugDirectManagerSearch.value.trim());
    } else {
        showLocalMemberSuggestions(bugDirectManagerSearch.value.trim(), bugDirectManagerResults, selectedManagers, bugDirectManagerSearch, renderManagerPills);
    }
});
bugDirectManagerSearch.addEventListener('input', () => {
    const q = bugDirectManagerSearch.value.trim();
    if (q.length >= 1) {
        debouncedManagerSearch(q);
    } else {
        showLocalMemberSuggestions(q, bugDirectManagerResults, selectedManagers, bugDirectManagerSearch, renderManagerPills);
    }
});

// Copying an id out of a tracker's UI often brings invisible passengers:
// non-breaking spaces, zero-width joiners, bidi marks. trim() leaves them,
// and the search then matches nothing. Built from char codes because the
// escapes themselves get mangled in transit.
const INVISIBLE_CODES = [0x00A0, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0xFEFF];
const INVISIBLE = new Set(INVISIBLE_CODES);
const cleanQuery = (v) => String(v || '')
    .split('')
    .filter(ch => !INVISIBLE.has(ch.charCodeAt(0)))
    .join('')
    .trim();

// Dynamic Parent Search (WIQL fallback)
let parentSearchTimeout = null;
bugParentSearch.addEventListener('input', () => {
    clearTimeout(parentSearchTimeout);
    const query = cleanQuery(bugParentSearch.value);
    if (!query) {
        bugParentResults.classList.remove('show');
        bugParent.value = "";
        return;
    }
    parentSearchTimeout = setTimeout(() => searchParentsDynamically(query), 500);
});

// A paste is a complete query, not a keystroke: search it at once rather than
// after the 500 ms typing pause.
bugParentSearch.addEventListener('paste', () => {
    setTimeout(() => {
        clearTimeout(parentSearchTimeout);
        const q = cleanQuery(bugParentSearch.value);
        if (q) searchParentsDynamically(q);
    }, 0);
});

async function searchParentsDynamically(query) {
    const org = bugOrg.value.trim();
    const project = bugProject.value.trim();
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);

    // Pasting a work item id right after the modal opens lands here while the
    // project dropdown is still loading. Say so instead of doing nothing.
    if (!org || !project) {
        bugParentResults.innerHTML =
            '<div class="multi-select-item" style="opacity:.6;cursor:default;">Pick an organization and project first</div>';
        bugParentResults.classList.add('show');
        return;
    }

    try {
        const settings = await new Promise(resolve => chrome.storage.sync.get(['azurePat'], resolve));
        const pat = (settings.azurePat || '').trim();
        if (!pat) return;
        const authHeader = 'Basic ' + btoa(':' + pat);

        let wiql;
        if (/^\d+$/.test(query)) {
            wiql = `SELECT [System.Id], [System.Title], [System.WorkItemType] FROM WorkItems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' AND [System.Id] = ${query}`;
        } else {
            wiql = `SELECT [System.Id], [System.Title], [System.WorkItemType] FROM WorkItems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' AND [System.Title] CONTAINS '${query.replace(/'/g, "''")}' AND [System.WorkItemType] = 'User Story'`;
        }

        const resp = await fetch(
            `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/wiql?api-version=7.0`,
            {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: wiql })
            }
        );

        if (!resp.ok) {
            // "No results" and "Azure said no" must not look the same.
            const why = resp.status === 401 || resp.status === 403
                ? 'Azure refused the PAT'
                : `Azure returned HTTP ${resp.status}`;
            bugParentResults.innerHTML =
                `<div class="multi-select-item" style="opacity:.6;cursor:default;">${why}</div>`;
            bugParentResults.classList.add('show');
            return;
        }
        const wiqlData = await resp.json();
        const ids = (wiqlData.workItems || []).slice(0, 10).map(w => w.id);

        if (ids.length === 0) {
            bugParentResults.innerHTML = '<div class="multi-select-item">No results found</div>';
            bugParentResults.classList.add('show');
            return;
        }

        const batchResp = await fetch(
            `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/workitemsbatch?api-version=7.0`,
            {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids, fields: ['System.Id', 'System.Title', 'System.WorkItemType', 'System.AreaPath', 'System.IterationPath'] })
            }
        );

        const batchData = await batchResp.json();
        bugParentResults.innerHTML = '';
        batchData.value.forEach(wi => {
            const item = document.createElement('div');
            item.className = 'multi-select-item';
            item.innerHTML = `<strong>#${wi.id}</strong> - ${wi.fields['System.Title']} (${wi.fields['System.WorkItemType']})`;
            item.onclick = () => {
                bugParentSearch.value = `#${wi.id} - ${wi.fields['System.Title']}`;
                bugParent.value = wi.id;
                bugParentResults.classList.remove('show');

                // Auto-populate Area and Iteration
                if (wi.fields['System.AreaPath']) {
                    bugArea.value = wi.fields['System.AreaPath'];
                }
                if (wi.fields['System.IterationPath']) {
                    bugIteration.value = wi.fields['System.IterationPath'];
                }

                saveLastFormValues();
            };
            bugParentResults.appendChild(item);
        });
        bugParentResults.classList.add('show');
    } catch (e) {
        console.error("Dynamic search failed", e);
    }
}

// ========= Improved Tags Multi-Select Logic =========
let selectedTags = new Set();

function renderTagPills() {
    bugTagsPills.innerHTML = '';
    selectedTags.forEach(tag => {
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.innerHTML = `
            <span>${tag}</span>
            <span class="remove-tag" data-tag="${tag}">&times;</span>
        `;
        pill.querySelector('.remove-tag').onclick = () => {
            selectedTags.delete(tag);
            renderTagPills();
            saveLastFormValues();
        };
        bugTagsPills.appendChild(pill);
    });
    bugTags.value = Array.from(selectedTags).join(', ');
}

bugTagsSearch.addEventListener('focus', () => {
    showTagSuggestions(bugTagsSearch.value.toLowerCase().trim());
});

bugTagsSearch.addEventListener('input', () => {
    showTagSuggestions(bugTagsSearch.value.toLowerCase().trim());
});

function showTagSuggestions(query) {
    const q = query.toLowerCase();
    const filtered = allProjectTags.filter(t =>
        (!q || t.toLowerCase().includes(q)) && !selectedTags.has(t)
    );
    bugTagsResults.innerHTML = '';

    filtered.slice(0, 20).forEach(tag => {
        const item = document.createElement('div');
        item.className = 'multi-select-item';
        item.textContent = tag;
        // mousedown, not click: it fires before the input's blur closes the list
        item.onmousedown = (e) => {
            e.preventDefault();
            selectedTags.add(tag);
            bugTagsSearch.value = '';
            renderTagPills();
            saveLastFormValues();
            // Picking one tag is almost always followed by picking another:
            // keep the caret and the list where they were.
            bugTagsSearch.focus();
            showTagSuggestions('');
        };
        bugTagsResults.appendChild(item);
    });

    if (filtered.length > 0) {
        bugTagsResults.classList.add('show');
    } else {
        bugTagsResults.classList.remove('show');
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-container')) {
        bugParentResults.classList.remove('show');
        bugTagsResults.classList.remove('show');
        bugAssignedToResults.classList.remove('show');
        bugDirectManagerResults.classList.remove('show');
    }
});

// Attachment handling
if (window.pendingVideo) {
    selectedFiles.push(window.pendingVideo);
    setTimeout(renderAttachmentList, 100); // Small delay to ensure UI is ready
}
// A screenshot on the clipboard has no filename: every one arrives as
// "image.png", indistinguishable once it is in the list.
function namedClipboardFile(file, i) {
    if (file.name && file.name !== 'image.png') return file;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return new File([file], `pasted-${stamp}${i ? `-${i + 1}` : ''}.${ext}`, { type: file.type });
}

document.addEventListener('paste', (e) => {
    const modal = document.getElementById('bugModal');
    if (!modal || !modal.classList.contains('show')) return;

    // The description handles its own paste, images included.
    const t = e.target;
    if (t && t.closest && t.closest('#bugDescription')) return;

    const files = [...((e.clipboardData && e.clipboardData.files) || [])]
        .filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!files.length) return;      // a plain text paste is none of our business

    e.preventDefault();
    selectedFiles = [...selectedFiles, ...files.map(namedClipboardFile)];
    renderAttachmentList();
    showToast(files.length === 1 ? 'Attached from clipboard' : `Attached ${files.length} files`);
});

bugAttachments?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    selectedFiles = [...selectedFiles, ...files];
    renderAttachmentList();
});

// The capture's filename, named for the tab it was taken from - so the row in
// the attachments field and the file that actually lands on the ticket always
// say the same thing. Same sanitising the download button uses.
function captureFileName() {
    const safe = pageTitle.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '_') || 'capture';
    return `${safe.slice(0, 80)}.png`;
}

// The capture as a real file, so the attachments field is the single source of
// everything that reaches the ticket - nothing is uploaded straight off the
// canvas. A recording is already the file in selectedFiles; an image session
// materialises the canvas here, at submit time, so annotations made right up to
// the click are included. In a video session the canvas was never drawn on
// (setMode only hides it), so reading it would have produced a blank 300x150
// PNG - which is exactly what used to get uploaded with every video bug.
async function buildCaptureFile() {
    if (isVideoSession) return window.pendingVideo || null;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return blob ? new File([blob], captureFileName(), { type: 'image/png' }) : null;
}

// The attachments field is the whole payload: the capture plus whatever the
// user added by hand. The capture leads the list.
async function collectAttachments() {
    const files = [...selectedFiles];
    const capture = await buildCaptureFile();
    if (capture && !files.includes(capture)) files.unshift(capture);   // a video is already in there
    return files;
}

function renderAttachmentList() {
    if (!bugAttachmentList) return;
    bugAttachmentList.innerHTML = '';

    // The capture always goes onto the bug. A recording is already a file in
    // selectedFiles, so it lists itself; a screenshot only becomes a file at
    // submit time (collectAttachments), so it gets a row of its own here. Both
    // are shown without a remove control - they are the evidence, not one of the
    // user's picked files.
    if (!isVideoSession) {
        const name = captureFileName();
        const item = document.createElement('div');
        item.className = 'file-item file-auto';
        item.innerHTML = `
            <i class="fas fa-file-image"></i>
            <span class="file-name-view" title="Click to preview - ${name}">${name}</span>
            <i class="fas fa-eye view-file" title="Preview this file"></i>
        `;
        const preview = () => canvas.toBlob((b) => { if (b) window.open(URL.createObjectURL(b), '_blank'); }, 'image/png');
        item.querySelector('.file-name-view').onclick = preview;
        item.querySelector('.view-file').onclick = preview;
        bugAttachmentList.appendChild(item);
    }

    selectedFiles.forEach((file, index) => {
        // The recording is the capture this bug is being filed from - the same
        // evidence the screenshot is for an image session. It rides in
        // selectedFiles because that is how it reaches the tracker, but it is
        // not one of the user's picked files: no remove control, so a stray
        // click cannot file a bug with its evidence stripped out.
        const isCapture = window.pendingVideo && file === window.pendingVideo;
        const item = document.createElement('div');
        item.className = isCapture ? 'file-item file-auto' : 'file-item';
        item.innerHTML = `
            <i class="fas ${file.type.startsWith('image/') ? 'fa-file-image' : 'fa-file-video'}"></i>
            <span class="file-name-view" title="Click to preview - ${file.name}">${file.name}</span>
            <i class="fas fa-eye view-file" title="Preview this file"></i>
            ${isCapture ? '' : `<span class="remove-file" data-index="${index}">&times;</span>`}
        `;
        const preview = () => window.open(URL.createObjectURL(file), '_blank');
        item.querySelector('.file-name-view').onclick = preview;
        item.querySelector('.view-file').onclick = preview;
        const rm = item.querySelector('.remove-file');
        if (rm) rm.onclick = () => {
            selectedFiles.splice(index, 1);
            renderAttachmentList();
        };
        bugAttachmentList.appendChild(item);
    });

}

// Open modal. The form serves two trackers; it may not demand the credentials of
// the one you are not using. Ask for whichever the form is actually pointed at.
reportBugBtn.addEventListener('click', async () => {
    const cfg = await getBugConfig();
    const target = (document.getElementById('bugTarget') || {}).value || cfg.provider || 'azure';

    const missing = target === 'jira'
        ? (!cfg.jira.baseUrl || !cfg.jira.email || !cfg.jira.token) && 'Connect Jira in Settings first'
        : !(cfg.azure.pat || '').trim() && 'Connect Azure DevOps in Settings first';

    if (missing) {
        showToast(missing);
        chrome.runtime.openOptionsPage();
        return;
    }

    // Ensure video is added to attachments if it exists
    if (window.pendingVideo && !selectedFiles.includes(window.pendingVideo)) {
        selectedFiles.push(window.pendingVideo);
    }
    // Draw the list every time the modal opens, not only when a video pushed a
    // file into it - a screenshot capture has no file to push, and its read-only
    // "auto" row would otherwise never be rendered.
    renderAttachmentList();
    bugModal.classList.add('show');
    delete bugSeverity.dataset.userSet;      // a new bug, a fresh judgement
    bugOrg.focus();
    Promise.resolve(window.bugTargetReady).then(() => loadLastFormValues());
    renderTagPills();
});

// ========= Dynamic Fields Implementation =========

addFieldBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addFieldMenu.classList.toggle('show');
    if (addFieldMenu.classList.contains('show')) {
        fieldSearch.value = '';
        renderAddFieldMenu();
        fieldSearch.focus();
    }
});

fieldSearch.addEventListener('input', () => {
    renderAddFieldMenu(fieldSearch.value.toLowerCase().trim());
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-field-section')) {
        addFieldMenu.classList.remove('show');
    }
});

// Fields we already have static UI for - never candidates for the dynamic
// list, auto-rendered or manually added.
function adoStaticFields() {
    return [
        'System.Title', 'System.Description', 'System.AssignedTo', 'System.Tags',
        'Microsoft.VSTS.Common.Severity', 'System.AreaPath', 'System.IterationPath',
        'Microsoft.VSTS.TCM.ReproSteps', 'Custom.DirectManager', stageFieldReferenceName,
        'System.Id', 'System.WorkItemType', 'System.State', 'System.CreatedDate',
        'System.ChangedDate', 'System.CreatedBy', 'System.ChangedBy', 'System.AuthorizedDate',
        'System.AuthorizedAs', 'System.Rev', 'System.Watermark', 'System.IsDeleted',
        'System.Reason', 'System.BoardColumn', 'System.BoardColumnDone', 'System.BoardLane',
        'System.CommentCount', 'System.TeamProject',
        // Azure marks these alwaysRequired at the data-integrity level, but no
        // real Azure Boards form ever shows them for editing - they're the
        // numeric/GUID mirror of AreaPath/IterationPath (already handled above
        // and auto-filled from the Parent Work Item), computed server-side.
        // Showing them as blank required text boxes duplicated a field the
        // form already fills in on its own.
        'System.AreaId', 'System.IterationId',
        // Locked by Azure's workflow rules until the bug actually reaches the
        // Resolved state - every bug this app files starts at New, so the
        // real Azure form always shows it disabled/empty here, never open
        // for input the way an ordinary field is.
        'Microsoft.VSTS.Common.ResolvedReason'
    ];
}

// Azure's fields endpoint lists every field on the work item type (created
// date, watermark, board column...), with no flag saying "this is on the
// New Bug form". Custom fields, a known set of standard fields Azure shows
// by default, and a name-pattern heuristic approximate that - and anything
// Azure itself marks alwaysRequired must be on the form by definition, so
// it counts regardless of the heuristic.
function isLikelyAdoUiField(f) {
    if (f.readOnly) return false;
    if (adoStaticFields().includes(f.referenceName)) return false;
    if (f.alwaysRequired) return true;

    const refName = f.referenceName;
    const name = (f.name || '').toLowerCase();
    const isCustomField = refName.startsWith('Custom.');

    const standardUIFields = [
        'Microsoft.VSTS.Common.Priority',
        'Microsoft.VSTS.Common.Activity',
        'Microsoft.VSTS.Scheduling.StoryPoints',
        'Microsoft.VSTS.Common.ValueArea',
        'Microsoft.VSTS.Common.Risk',
        'Microsoft.VSTS.Scheduling.RemainingWork',
        'Microsoft.VSTS.Scheduling.CompletedWork',
        'Microsoft.VSTS.Scheduling.OriginalEstimate'
    ];
    if (standardUIFields.includes(refName)) return true;

    // Heuristic for other VSTS fields: If it contains "Stage", "Cause", "Manager", "Source" in name
    const isLikelyUIField = refName.startsWith('Microsoft.VSTS.') &&
        (name.includes('stage') || name.includes('cause') || name.includes('manager') || name.includes('source'));

    return isCustomField || isLikelyUIField;
}

// Renders every field Azure's own create-screen would plausibly show, the
// same way fillJiraMeta now renders every Jira createmeta field - not just
// the ones the user manually adds. Safe to call repeatedly: addDynamicField
// already no-ops for fields that are already active.
// requiredOnly is for backfilling onto a restored draft: a field the user
// removed on purpose has no remove button to tell "removed" from "never
// added" apart, so a missing OPTIONAL field must stay missing. A missing
// REQUIRED field is unambiguous - the user could never have removed it (no
// remove button exists for those) - so it means Azure started requiring
// something new since the draft was saved, and belongs back on the form.
function autoRenderAdoFields(requiredOnly = false) {
    allAdoFields
        .filter(f => !activeDynamicFields.has(f.referenceName) && isLikelyAdoUiField(f) && (!requiredOnly || f.alwaysRequired))
        // Required fields first - a field you must fill in before scrolling
        // past it beats finding it at the bottom after the optional ones.
        .sort((a, b) => (b.alwaysRequired ? 1 : 0) - (a.alwaysRequired ? 1 : 0))
        .forEach(f => addDynamicField(f, f.defaultValue != null ? String(f.defaultValue) : '', !!f.alwaysRequired));
}

function renderAddFieldMenu(query = '') {
    fieldList.innerHTML = '';

    const availableFields = allAdoFields.filter(f => {
        if (activeDynamicFields.has(f.referenceName)) return false;
        if (!isLikelyAdoUiField(f)) return false;

        // Filter by query
        const name = (f.name || '').toLowerCase();
        if (query && !name.includes(query) && !f.referenceName.toLowerCase().includes(query)) return false;

        return true;
    }).sort((a, b) => a.name.localeCompare(b.name));

    if (availableFields.length === 0) {
        fieldList.innerHTML = '<div style="padding: 15px; color: var(--text-secondary); text-align: center;">No fields found</div>';
        return;
    }

    availableFields.forEach(f => {
        const btn = document.createElement('button');
        btn.className = 'field-item-btn';
        btn.innerHTML = `<strong>${f.name}</strong><small>${f.referenceName}</small>`;
        btn.onclick = () => {
            addDynamicField(f, '', !!f.alwaysRequired);
            addFieldMenu.classList.remove('show');
        };
        fieldList.appendChild(btn);
    });
}

function addDynamicField(field, savedValue = '', required = false) {
    if (activeDynamicFields.has(field.referenceName)) return;
    activeDynamicFields.add(field.referenceName);

    const wrapper = document.createElement('div');
    wrapper.className = 'dynamic-field-wrapper';
    wrapper.dataset.refName = field.referenceName;
    wrapper.dataset.fieldType = field.type;

    let inputHtml = '';
    const inputId = `dynamic_${field.referenceName.replace(/\./g, '_')}`;

    if (field.allowedValues && field.allowedValues.length > 0) {
        inputHtml = `<select id="${inputId}" class="dynamic-input">
            <option value="">Select ${field.name}</option>
            ${field.allowedValues.map(v => `<option value="${v}" ${v === savedValue ? 'selected' : ''}>${v}</option>`).join('')}
        </select>`;
    } else if (field.type === 'dateTime') {
        inputHtml = `<input type="datetime-local" id="${inputId}" class="dynamic-input" value="${savedValue}">`;
    } else if (field.type === 'integer' || field.type === 'double') {
        inputHtml = `<input type="number" id="${inputId}" class="dynamic-input" value="${savedValue}" placeholder="Enter number">`;
    } else if (field.type === 'boolean') {
        inputHtml = `<select id="${inputId}" class="dynamic-input">
            <option value="true" ${savedValue === 'true' ? 'selected' : ''}>True</option>
            <option value="false" ${savedValue === 'false' ? 'selected' : ''}>False</option>
        </select>`;
    } else {
        inputHtml = `<input type="text" id="${inputId}" class="dynamic-input" value="${savedValue}" placeholder="Enter ${field.name}">`;
    }

    wrapper.innerHTML = `
        <div class="dynamic-field-header">
            <label>${field.name}${required ? ' <span style="color:var(--accent-red);">*</span>' : ''}</label>
            ${required ? '' : `<button type="button" class="remove-field-btn" title="Remove Field">
                <i class="fas fa-trash"></i>
            </button>`}
        </div>
        <div class="form-group" style="margin-bottom: 0;">
            ${inputHtml}
        </div>
    `;

    const removeBtn = wrapper.querySelector('.remove-field-btn');
    if (removeBtn) {
        removeBtn.onclick = () => {
            activeDynamicFields.delete(field.referenceName);
            wrapper.remove();
            saveLastFormValues();
        };
    }

    // Add listener to save values on change
    const input = wrapper.querySelector('.dynamic-input');
    input.addEventListener('change', saveLastFormValues);
    if (input.tagName === 'INPUT') {
        input.addEventListener('input', saveLastFormValues);
    }

    dynamicFieldsContainer.appendChild(wrapper);
    saveLastFormValues();
}

// Close modal
closeBugModal.addEventListener('click', () => {
    bugModal.classList.remove('show');
});

cancelBugBtn.addEventListener('click', () => {
    bugModal.classList.remove('show');
});

// Close on background click
bugModal.addEventListener('click', (e) => {
    if (e.target === bugModal) {
        bugModal.classList.remove('show');
    }
});

// Submit bug
submitBugBtn.addEventListener('click', async () => {
    const org = bugOrg.value.trim();
    const project = bugProject.value.trim();
    const title = bugTitle.value.trim();

    if (!org) { showToast('Please select an Organization'); bugOrg.focus(); return; }
    if (!project) { showToast('Please select a Project'); bugProject.focus(); return; }
    if (!title) { showToast('Please enter a title'); bugTitle.focus(); return; }

    const description = document.getElementById('bugDescription').innerHTML.trim();
    const assignedTo = bugAssignedTo.value;
    const directManager = bugDirectManager.value;
    const severity = bugSeverity.value;
    const foundIn = bugFoundIn.value;
    const parent = bugParent.value;

    if (!assignedTo) { showToast('Please select Assigned To'); bugAssignedToSearch.focus(); return; }
    if (!bugDirectManagerSearch.disabled && !directManager) { showToast('Please select Direct Manager'); bugDirectManagerSearch.focus(); return; }
    if (!severity) { showToast('Please select Severity'); bugSeverity.focus(); return; }
    if (!bugArea.value) { showToast('Area Path is required (Auto-populated from Parent)'); bugParentSearch.focus(); return; }
    if (!bugIteration.value) { showToast('Iteration Path is required (Auto-populated from Parent)'); bugParentSearch.focus(); return; }
    // foundIn is now optional
    if (!parent) { showToast('Please select Parent Work Item'); bugParentSearch.focus(); return; }
    const tags = Array.from(selectedTags).join(', ');
    const attachments = await collectAttachments();

    // Show loading
    submitBugBtn.disabled = true;
    toggleLoader(true, "Creating Bug Report...");

    try {
        // The URL, the browser, the console and the failed requests: Jira has
        // carried these since the start, Azure never did.
        const ctxRes = captureId ? await chrome.storage.local.get([`ctx_${captureId}`]) : {};
        const ctx = captureId ? ctxRes[`ctx_${captureId}`] : null;

        const result = await createAzureDevOpsBug({
            org, project, title, description, assignedTo, directManager,
            areaPath: bugArea.value, iterationPath: bugIteration.value,
            severity, foundIn, parent, tags, attachments, ctx,
            // Names the capture inside `attachments`, so Repro Steps can embed
            // that same uploaded file inline instead of uploading it a 2nd time.
            captureName: isVideoSession ? null : captureFileName(),
            dynamicFields: collectDynamicFields()
        });

        const lost = result._failedUploads || [];
        if (lost.length) showToast(`Bug ${result.id} created, but ${lost.length} attachment(s) failed: ${lost.join('; ')}`);
        else showToast('Bug created successfully! ID: ' + result.id);

        // Open the bug in a new tab if URL is available
        if (result._links && result._links.html && result._links.html.href) {
            window.open(result._links.html.href, '_blank');
        }

        bugModal.classList.remove('show');

        // Reset transient fields
        bugTitle.value = '';
        bugDescription.innerHTML = '';
        selectedFiles = [];
        renderAttachmentList();

        // Reset dynamic fields, then bring back whatever Azure's form always
        // shows so the next bug starts the same way this one did.
        dynamicFieldsContainer.innerHTML = '';
        activeDynamicFields.clear();
        autoRenderAdoFields();

        // Save state
        saveLastFormValues();

    } catch (error) {
        console.error('Error creating bug:', error);
        showToast('Error: ' + error.message);
    } finally {
        submitBugBtn.disabled = false;
        toggleLoader(false);
    }
});

// Azure DevOps API Functions
async function createAzureDevOpsBug(data) {
    const settings = await new Promise(resolve => chrome.storage.sync.get(['azurePat'], resolve));
    if (!settings.azurePat) throw new Error('PAT not configured');

    const encodedOrg = encodeURIComponent(data.org.trim());
    const encodedProject = encodeURIComponent(data.project.trim());
    const orgUrl = `https://dev.azure.com/${encodedOrg}`;
    const authHeader = 'Basic ' + btoa(':' + settings.azurePat.trim());


    // Upload other attachments
    // A bug filed without the screenshot the tester attached is a bug nobody can
    // reproduce. Carry on filing it, but never let the loss pass unmentioned.
    const otherAttachmentUrls = [];
    const failedUploads = [];
    // The capture is one of these files now. Remember the URL it uploaded to, so
    // Repro Steps can show that very file inline - no second upload of the same
    // bytes, and nothing pulled off the canvas behind the attachments field.
    let captureImageUrl = null;
    if (data.attachments && data.attachments.length > 0) {
        for (const file of data.attachments) {
            try {
                const url = await uploadFileAttachment(encodedOrg, encodedProject, authHeader, file);
                const isCapture = !captureImageUrl && data.captureName
                    && file.name === data.captureName && (file.type || '').startsWith('image/');
                if (isCapture) {
                    // Embedded inline in Repro Steps below. Azure already lists an
                    // inline image under Attachments, so adding an AttachedFile
                    // relation for it as well would list the same file twice -
                    // which is exactly how it behaved before this all moved to the
                    // attachments field. A recording has no inline form, so it
                    // stays a normal relation like any other file.
                    captureImageUrl = url;
                } else {
                    otherAttachmentUrls.push({ url, name: file.name });
                }
            } catch (e) {
                console.error('Failed to upload attachment:', file.name, e);
                failedUploads.push(e.message || file.name);
            }
        }
    }

    // Process inline images in description
    let processedDescription = data.description || 'See details below.';
    if (processedDescription.includes('src="data:')) {
        processedDescription = await processInlineImages(processedDescription, encodedOrg, encodedProject, authHeader);
    }

    let reproSteps = `<div>${processedDescription}</div>`;

    // The evidence reads before the picture: what broke, then what it looked like.
    reproSteps += contextHtml(data.ctx);

    // Show the capture inside Repro Steps - the same file already uploaded from
    // the attachments field above. A recording has no image to embed, so nothing
    // is added (this is where a blank canvas PNG used to land on every video bug).
    if (captureImageUrl) {
        reproSteps += `
        <br/>
        <img src="${captureImageUrl}" alt="Bug Screenshot" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px;" />
    `;
    }

    const workItemData = [
        { op: 'add', path: '/fields/System.Title', value: data.title },
        { op: 'add', path: '/fields/System.State', value: 'New' },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: reproSteps },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: data.severity },
        { op: 'add', path: '/fields/System.AreaPath', value: data.areaPath },
        { op: 'add', path: '/fields/System.IterationPath', value: data.iterationPath }
    ];

    // Add optional fields
    if (data.assignedTo) workItemData.push({ op: 'add', path: '/fields/System.AssignedTo', value: data.assignedTo });
    if (data.directManager) workItemData.push({ op: 'add', path: '/fields/Custom.DirectManager', value: data.directManager });
    if (data.foundIn) workItemData.push({ op: 'add', path: `/fields/${stageFieldReferenceName}`, value: data.foundIn });
    if (data.tags) workItemData.push({ op: 'add', path: '/fields/System.Tags', value: data.tags });

    // Add dynamic fields
    if (data.dynamicFields && data.dynamicFields.length > 0) {
        data.dynamicFields.forEach(df => {
            if (df.value !== undefined && df.value !== '') {
                workItemData.push({ op: 'add', path: `/fields/${df.refName}`, value: df.value });
            }
        });
    }

    const response = await fetch(
        `${orgUrl}/${encodedProject}/_apis/wit/workitems/$Bug?api-version=7.0`,
        {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json-patch+json' },
            body: JSON.stringify(workItemData)
        }
    );

    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);

    const bugResult = await response.json();

    // Add relations (parent and attachments)
    const relations = [];
    if (data.parent) {
        relations.push({
            op: 'add',
            path: '/relations/-',
            value: {
                rel: 'System.LinkTypes.Hierarchy-Reverse',
                url: `${orgUrl}/${encodedProject}/_apis/wit/workItems/${data.parent}`
            }
        });
    }

    if (otherAttachmentUrls.length > 0) {
        otherAttachmentUrls.forEach(attr => {
            relations.push({
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'AttachedFile',
                    url: attr.url,
                    attributes: { comment: 'File attached via Screenshot Editor' }
                }
            });
        });
    }

    if (relations.length > 0) {
        await fetch(
            `${orgUrl}/${encodedProject}/_apis/wit/workitems/${bugResult.id}?api-version=7.0`,
            {
                method: 'PATCH',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json-patch+json' },
                body: JSON.stringify(relations)
            }
        );
    }

    // The bug exists either way; the tester still has to know what did not.
    bugResult._failedUploads = failedUploads;
    return bugResult;
}


async function processInlineImages(html, encodedOrg, encodedProject, authHeader) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const images = doc.querySelectorAll('img[src^="data:"]');

    if (images.length === 0) return html;

    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const dataUrl = img.src;
        try {
            // Upload as attachment
            const fileName = `inline_image_${Date.now()}_${i}.png`;
            const attachmentUrl = await uploadAttachment(encodedOrg, encodedProject, authHeader, dataUrl, fileName);
            // Replace src with the uploaded URL
            img.src = attachmentUrl;
        } catch (e) {
            console.error('Failed to upload inline image:', e);
            // The image is gone from the description; leave a mark where it was
            // rather than a broken data: URL Azure will strip anyway.
            img.replaceWith(doc.createTextNode(`[image could not be uploaded: ${e.message || 'unknown error'}]`));
        }
    }
    return doc.body.innerHTML;
}

async function uploadAttachment(encodedOrg, encodedProject, authHeader, dataUrl, fileName) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    const uploadResponse = await fetch(
        `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.0`,
        {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/octet-stream'
            },
            body: blob
        }
    );

    if (!uploadResponse.ok) {
        throw new Error(await azureUploadError(uploadResponse, fileName));
    }

    const result = await uploadResponse.json();
    return result.url;
}

// "Failed to upload" reads the same for a wrong PAT, a file over the size cap,
// and a dropped connection. Say which.
async function azureUploadError(res, name) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401 || res.status === 403) return `${name}: Azure refused the PAT (HTTP ${res.status})`;
    if (res.status === 413) return `${name}: too large for Azure`;
    return `${name}: upload failed (HTTP ${res.status})${detail ? ' - ' + detail : ''}`;
}

async function uploadFileAttachment(encodedOrg, encodedProject, authHeader, file) {
    const uploadResponse = await fetch(
        `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/attachments?fileName=${encodeURIComponent(file.name)}&api-version=7.0`,
        {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/octet-stream'
            },
            body: file
        }
    );

    if (!uploadResponse.ok) {
        throw new Error(await azureUploadError(uploadResponse, file.name));
    }

    const result = await uploadResponse.json();
    return result.url;
}

function collectDynamicFields() {
    const fields = [];
    if (!dynamicFieldsContainer) return fields;
    const wrappers = dynamicFieldsContainer.querySelectorAll('.dynamic-field-wrapper');
    wrappers.forEach(w => {
        const refName = w.dataset.refName;
        const input = w.querySelector('.dynamic-input');
        if (input) {
            let value = input.value;
            fields.push({ refName, value });
        }
    });
    return fields;
}

// ── Page context drawer ─────────────────────────────────────────────────────
// The console, network and environment recorded at the moment of capture,
// readable while you annotate. Stored by the background as ctx_<captureId>.

(function contextDrawer() {
    const btn = document.getElementById('ctxBtn');
    const drawer = document.getElementById('ctxDrawer');
    if (!btn || !drawer || !captureId) { if (btn) btn.style.display = 'none'; return; }

    let ctx = null;

    // Old captures kept only the errors; new ones keep the whole console.
    const logsOf = (c) => (c && c.console && c.console.length) ? c.console
        : (c && c.consoleAll && c.consoleAll.length) ? c.consoleAll
            : (c && c.consoleErrors) || [];
    const reqsOf = (c) => (c && c.requests && c.requests.length) ? c.requests
        : (c && c.failedRequests) || [];
    const failed = (r) => r.status === 0 || r.status >= 400;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function render() {
        const body = document.getElementById('ctxBody');
        if (!ctx) {
            body.innerHTML = '<div class="ctx-none">No page context was recorded for this capture.</div>';
            return;
        }
        const logs = logsOf(ctx);
        const errs = logs.filter(l => l.level === 'error');
        const reqs = reqsOf(ctx);
        const bad = reqs.filter(failed);

        body.innerHTML = `
            <div class="ctx-sec"><i class="fas fa-circle-info"></i> Environment</div>
            <dl class="ctx-kv">
                <dt>Page</dt><dd>${esc(ctx.url) || '&mdash;'}</dd>
                <dt>Browser</dt><dd>${esc(ctx.browser) || '&mdash;'}</dd>
                <dt>Platform</dt><dd>${esc(ctx.platform) || '&mdash;'}</dd>
                <dt>Viewport</dt><dd>${esc(ctx.viewport) || '&mdash;'}</dd>
                <dt>Captured</dt><dd>${ctx.capturedAt ? new Date(ctx.capturedAt).toLocaleString() : '&mdash;'}</dd>
            </dl>

            <div class="ctx-sec"><i class="fas fa-terminal"></i> Console
                <span class="cnt">${logs.length}${errs.length ? ` &middot; ${errs.length} error${errs.length > 1 ? 's' : ''}` : ''}</span>
            </div>
            <div class="ctx-list">
            ${logs.length ? logs.map(l => `
                <div class="ctx-log lvl-${esc(l.level || 'log')}">
                    <span class="lv">${esc(l.level || 'log')}</span>
                    <span class="msg">${esc(l.message)}${l.count > 1 ? ` <b>&times;${l.count}</b>` : ''}</span>
                </div>`).join('') : '<div class="ctx-none">The page logged nothing.</div>'}
            </div>

            <div class="ctx-sec"><i class="fas fa-wifi"></i> Network
                <span class="cnt">${reqs.length}${bad.length ? ` &middot; ${bad.length} failed` : ''}</span>
            </div>
            <div class="ctx-list">
            ${bad.length ? bad.map(r => `
                <div class="ctx-log req">
                    <span class="st">${esc(r.status || 'ERR')}</span>
                    <span class="u">${esc(r.method || 'GET')} ${esc(r.url)}</span>
                </div>`).join('')
                : reqs.length ? '<div class="ctx-none">Every request succeeded.</div>'
                    : '<div class="ctx-none">No requests were recorded.</div>'}
            </div>`;
    }

    function markdown() {
        const logs = logsOf(ctx || {});
        const errs = logs.filter(l => l.level === 'error');
        const bad = reqsOf(ctx || {}).filter(failed);
        const c = ctx || {};
        const out = [
            `## ${pageTitle}`, '',
            '### Environment', '', '| | |', '|---|---|',
            `| URL | ${c.url || '—'} |`,
            `| Browser | ${c.browser || '—'} |`,
            `| Platform | ${c.platform || '—'} |`,
            `| Viewport | ${c.viewport || '—'} |`,
            `| Captured | ${c.capturedAt ? new Date(c.capturedAt).toLocaleString() : '—'} |`,
            '', '### Console errors', '',
            errs.length ? '```\n' + errs.map(e => e.message).join('\n') + '\n```' : '_None_',
            '', '### Failed requests', ''
        ];
        if (bad.length) {
            out.push('| Status | Method | URL |', '|---|---|---|');
            for (const r of bad) out.push(`| ${r.status || 'failed'} | ${r.method || 'GET'} | ${r.url} |`);
        } else {
            out.push('_None_');
        }
        return out.join('\n');
    }

    chrome.storage.local.get([`ctx_${captureId}`], (r) => {
        ctx = r[`ctx_${captureId}`] || null;
        // a capture with nothing worth reporting should not advertise a button
        const logs = logsOf(ctx || {});
        const bad = reqsOf(ctx || {}).filter(failed);
        const n = logs.filter(l => l.level === 'error').length + bad.length;
        if (n) btn.classList.add('has-issues');
        render();
    });

    btn.addEventListener('click', () => drawer.classList.toggle('open'));
    document.getElementById('ctxClose').addEventListener('click', () => drawer.classList.remove('open'));
    document.getElementById('ctxCopy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(markdown());
        showToast('Bug report copied');
    });
})();

// ── AI bug report writer ────────────────────────────────────────────────────
// The tester types one line. Claude reads that, the annotated screenshot, and
// the console/network recorded with the capture, then writes the report and
// fills the form.

(function aiBugWriter() {
    const noteEl = document.getElementById('aiNote');
    const btn = document.getElementById('aiWriteBtn');
    const hint = document.getElementById('aiHint');
    if (!noteEl || !btn) return;

    const setHint = (msg, kind) => {
        hint.textContent = msg;
        hint.className = 'ai-hint' + (kind ? ' ' + kind : '');
    };

    // Only the four sections a reader actually needs. Module, environment and
    // impact are already carried by the ticket's fields and the attached
    // context; severity lives in its dropdown, not in the prose.
    //
    // Real HTML structure, not fake indentation: headings are <b>, steps are an
    // <ol>, results are <ul>. Both trackers understand this - Azure stores it
    // verbatim, and the Jira path converts it to the same structure in ADF.
    function renderTemplate(r) {
        const li = (t) => `<li>${escapeHtmlLite(t)}</li>`;

        const steps = (r.stepsToReproduce || []).length
            ? `<ol>${r.stepsToReproduce.map(li).join('')}</ol>`
            : '<ol><li></li><li></li></ol>';

        // one bullet per sentence, so a two-part expectation reads as two points
        const bullets = (text) => {
            const parts = String(text || '').split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(x => x.trim()).filter(Boolean);
            return parts.length ? `<ul>${parts.map(li).join('')}</ul>` : '<ul><li></li></ul>';
        };

        return `
<div><b>Description</b></div>
<div>${escapeHtmlLite(r.description || '')}</div>
<br/>
<div><b>Steps to Reproduce</b></div>
${steps}
<br/>
<div><b>Expected Result</b></div>
${bullets(r.expectedResult)}
<br/>
<div><b>Actual Result</b></div>
${bullets(r.actualResult)}`.trim();
    }

    function escapeHtmlLite(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // The form's severity list is worded differently from the AI's three levels.
    // Azure labels its severities "1 - Critical, 2 - High, 3 - Medium, 4 - Low".
    // Matching on the leading digit made the AI's "High" land on Critical, so
    // match the name. And once the tester has picked a level themselves, a
    // regenerated report must not quietly take it back.
    function matchSeverity(level) {
        const sel = document.getElementById('bugSeverity');
        if (!sel || sel.dataset.userSet === '1') return;

        const want = { High: /high/i, Medium: /medium/i, Low: /low/i }[level];
        if (!want) return;
        for (const opt of sel.options) {
            if (want.test(opt.value)) { sel.value = opt.value; return; }
        }
    }

    async function loadCtx() {
        if (!captureId) return null;
        const r = await chrome.storage.local.get([`ctx_${captureId}`]);
        return r[`ctx_${captureId}`] || null;
    }

    btn.addEventListener('click', async () => {
        const note = noteEl.value.trim();
        selectedObjectId = null;
        render();   // drop the selection handles before photographing the canvas

        btn.disabled = true;
        const label = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Writing…';
        setHint('Claude is reading the screenshot…');

        try {
            const ctx = await loadCtx();
            // Annotations are part of the evidence, so send the edited canvas.
            const imageData = canvas.toDataURL('image/png').split(',')[1];

            const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { action: 'aiWriteBugReport', note, ctx, imageData, mediaType: 'image/png' },
                    (r) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)
                );
            });

            if (!res || res.error) {
                setHint(res && res.error === 'no_api_key'
                    ? 'The AI key is not configured.'
                    : `Failed: ${(res && res.error) || 'unknown error'}`, 'err');
                return;
            }

            const r = res.report;
            const titleEl = document.getElementById('bugTitle');
            if (titleEl) titleEl.value = r.title || '';
            const desc = document.getElementById('bugDescription');
            if (desc) desc.innerHTML = renderTemplate(r);
            matchSeverity(r.severity);
            // Jira has no Severity field: remember the level so submit can map
            // it onto the standard Priority.
            window.aiSeverityLevel = r.severity || '';

            setHint(`Report written from ${note ? 'your note and ' : ''}the screenshot. Review before sending.`, 'ok');
        } catch (e) {
            setHint(`Failed: ${e.message || e}`, 'err');
        } finally {
            btn.disabled = false;
            btn.innerHTML = label;
        }
    });

    noteEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
})();

// ── Bug target: Azure DevOps or Jira ────────────────────────────────────────
// The Azure flow is untouched. Jira is a parallel path that intercepts the
// submit button before the Azure handler ever runs, so neither can break the
// other. Organizations come from Settings instead of being hard-coded here.

(function bugTarget() {
    const target = document.getElementById('bugTarget');
    const orgSel = document.getElementById('bugOrg');
    const projSel = document.getElementById('bugProject');
    const submit = document.getElementById('submitBugBtn');
    if (!target || !orgSel || !projSel || !submit) return;

    // Fields that exist only in Azure's work-item model. Severity and Tags were
    // missing here, which is why they kept showing up under Jira.
    const AZURE_ONLY = ['bugOrgGroup', 'bugAssignedTo', 'bugDirectManager', 'bugParent',
        'bugArea', 'bugIteration', 'bugFoundIn', 'bugSeverity', 'bugTags'];

    let cfg = null;

    const groupOf = (id) => {
        const el = document.getElementById(id);
        return el ? el.closest('.form-group') : null;
    };

    function showAzureFields(show) {
        for (const id of AZURE_ONLY) {
            // Tags and the people pickers wrap their input in a container, so
            // walk up to the .form-group rather than hiding the input alone.
            const g = groupOf(id) || (document.getElementById(id + 'Pills') || {}).closest?.('.form-group');
            if (g) g.style.display = show ? '' : 'none';
        }
        // "Add New Field" walks Azure's reference names; Jira has no such model
        document.querySelectorAll('.azure-only').forEach(el => { el.style.display = show ? '' : 'none'; });
        document.querySelectorAll('.jira-only').forEach(r => { r.style.display = show ? 'none' : ''; });

        // an empty .form-row would still hold its margin
        document.querySelectorAll('.form-row:not(.jira-only)').forEach(row => {
            const anyVisible = [...row.querySelectorAll('.form-group')]
                .some(g => g.style.display !== 'none');
            row.style.display = anyVisible ? '' : 'none';
        });
    }


    // ── search-and-pill picker ──────────────────────────────────────────────
    // One component behind every list-valued Jira field: type to filter, click
    // to add, x to remove. Same markup and CSS as Azure's pickers.
    const escHtml = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (v) => escHtml(v).replace(/"/g, '&quot;');

    function makePicker(root, { options = [], multi = true, allowNew = false, lookup = null, eager = false, onChange = null }) {
        const pills = root.querySelector('.tags-pills-container');
        const search = root.querySelector('input[type=text]');
        const results = root.querySelector('.multi-select-content');
        const chosen = [];
        let remote = [];        // options fetched for the current query
        let visible = [];       // exactly what the list is showing right now
        let seq = 0;            // only the newest lookup may paint

        const sync = () => {
            pills.innerHTML = chosen.map(c =>
                `<span class="tag-pill" data-id="${escAttr(c.id)}">${escHtml(c.name)}<i class="fas fa-times remove-tag"></i></span>`).join('');
            search.style.display = (!multi && chosen.length) ? 'none' : '';
        };

        // Delegated: the list is re-rendered whenever a lookup resolves, so a
        // listener bound to an <div> would be gone by the time mouseup lands.
        pills.addEventListener('click', (e) => {
            const x = e.target.closest('.remove-tag');
            if (!x) return;
            const id = x.parentElement.dataset.id;
            const i = chosen.findIndex(c => String(c.id) === id);
            if (i >= 0) chosen.splice(i, 1);
            sync();
            if (onChange) onChange();
        });

        const pick = (opt) => {
            if (!multi) chosen.length = 0;
            if (!chosen.some(c => String(c.id) === String(opt.id))) chosen.push(opt);
            search.value = '';
            sync();
            if (multi) { search.focus(); paint(); }
            else { results.classList.remove('show'); }
            if (onChange) onChange();
        };

        // mousedown, not click: it fires before the input's blur hides the list
        results.addEventListener('mousedown', (e) => {
            const item = e.target.closest('.multi-select-item');
            if (!item) return;
            e.preventDefault();

            if (item.dataset.new === '1') {
                const v = cleanQuery(search.value);
                if (v) pick({ id: v, name: v });
                return;
            }
            const opt = visible.find(o => String(o.id) === item.dataset.id);
            if (opt) pick(opt);
        });

        const nameOf = (o) => String((o && o.name != null) ? o.name : '');

        const paint = () => {
            const q = cleanQuery(search.value).toLowerCase();
            const taken = new Set(chosen.map(c => String(c.id)));
            const pool = (lookup ? remote : options).filter(o => o && o.id != null);
            visible = pool.filter(o => !taken.has(String(o.id)) && nameOf(o).toLowerCase().includes(q)).slice(0, 40);

            let html = visible.map(o =>
                `<div class="multi-select-item" data-id="${escAttr(o.id)}">${escHtml(nameOf(o))}</div>`).join('');
            if (allowNew && q && !visible.some(o => nameOf(o).toLowerCase() === q)) {
                html = `<div class="multi-select-item" data-new="1">Create &ldquo;${escHtml(cleanQuery(search.value))}&rdquo;</div>` + html;
            }
            results.innerHTML = html ||
                '<div class="multi-select-empty" style="opacity:.5;padding:10px 15px;font-size:13px;">No matches</div>';
            results.classList.add('show');
        };

        // Fields that hand back an autoCompleteUrl expect a query per keystroke;
        // fields that inlined their allowedValues just filter what they have.
        let timer = null;
        const refresh = (immediate) => {
            if (!lookup) { paint(); return; }
            clearTimeout(timer);
            paint();                       // show what we already have

            // A focus and a paste can be in flight together. Without this, the
            // slower (older, emptier) response overwrites the newer one.
            const mine = ++seq;
            const run = async () => {
                const q = cleanQuery(search.value);
                const res = await lookup(q);
                if (mine !== seq) return;
                remote = res;
                paint();
            };
            if (immediate) run(); else timer = setTimeout(run, 220);
        };

        void eager;

        search.addEventListener('focus', () => refresh(true));
        search.addEventListener('input', () => refresh(false));
        // paste fires input too, but the value is only set afterwards; a
        // microtask later it is there, and the user expects an instant result
        search.addEventListener('paste', () => setTimeout(() => refresh(true), 0));
        // long enough for mousedown on the list to land first
        search.addEventListener('blur', () => setTimeout(() => results.classList.remove('show'), 180));
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = results.querySelector('.multi-select-item');
                if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            }
            if (e.key === 'Backspace' && !search.value && chosen.length) {
                chosen.pop();
                sync();
                if (onChange) onChange();
            }
        });

        sync();
        return {
            values: () => chosen.map(c => c.id),
            // Full {id,name} pairs, not just ids - restoring a pill after a
            // reload needs the display name too, and the id alone can't
            // reconstruct it without re-asking Jira.
            chosenFull: () => chosen.map(c => ({ id: c.id, name: c.name })),
            // Restoring a saved draft is not a user pick: it must not re-fire
            // onChange (which would just save straight back what was loaded).
            setInitial: (items) => {
                chosen.length = 0;
                if (items) chosen.push(...items);
                sync();
            }
        };
    }

    // ── dynamic Jira fields ─────────────────────────────────────────────────
    // The create screen decides what exists. Required fields render themselves;
    // the rest arrive through "Add New Field" and can be removed again.
    let jiraFields = [];
    let jiraLinkTypeList = [];
    const jiraInputs = {};      // fieldId -> read()
    const jiraPickers = {};     // fieldId -> { chosenFull(), setInitial() }, for list-valued fields only

    const LIST_KINDS = new Set(['option', 'user', 'version', 'component',
        'priority', 'resolution', 'issuetype', 'securitylevel', 'group', 'project']);

    // A bug nobody owns and nothing links to is a bug nobody acts on.
    const JIRA_ALWAYS_REQUIRED = new Set(['issuelinks', 'assignee']);

    const hasList = (f) => f.id !== 'issuelinks' &&
        (LIST_KINDS.has(f.kind) || f.id === 'labels' || f.options.length > 0 || !!f.autoCompleteUrl);

    // Azure's exact wrapper. Anything else and the inputs fall back to the
    // browser's default chrome: white borders, wrong background, no spacing.
    function fieldShell(f, innerHtml) {
        return `
            <div class="dynamic-field-header">
                <label>${escHtml(f.name)}${f.required ? ' <span style="color:var(--accent-red);">*</span>' : ''}</label>
                ${f.required ? '' : '<button type="button" class="remove-field-btn" title="Remove Field"><i class="fas fa-trash"></i></button>'}
            </div>
            <div class="form-group" style="margin-bottom: 0;">${innerHtml}</div>`;
    }

    const pickerHtml = (placeholder) => `
        <div class="multi-select-container">
            <div class="tags-pills-container"></div>
            <input type="text" placeholder="${escAttr(placeholder)}">
            <div class="multi-select-content"></div>
        </div>`;

    async function renderJiraField(f) {
        // Linked Issues renders under the title; everything else after the
        // description, where the optional-field section lives.
        const box = document.getElementById(f.id === 'issuelinks' ? 'jiraTopFields' : 'jiraFieldsContainer');
        if (!box || jiraInputs[f.id]) return;

        const wrap = document.createElement('div');
        wrap.className = 'dynamic-field-wrapper';
        wrap.dataset.fieldId = f.id;
        box.appendChild(wrap);

        if (f.id === 'issuelinks') {
            // both controls must live inside .form-group: that is what carries
            // the background, border and radius. Outside it the browser paints
            // its own white chrome.
            wrap.innerHTML = fieldShell(f,
                '<select class="link-type" style="margin-bottom:12px;"></select>' +
                pickerHtml('Type an issue key or summary...'));

            const typeSel = wrap.querySelector('.link-type');
            typeSel.innerHTML = jiraLinkTypeList.length
                ? jiraLinkTypeList.map(t => `<option value="${escAttr(t.id)}">${escHtml(t.name)}</option>`).join('')
                : '<option value="">No link types</option>';

            const picker = makePicker(wrap, { options: [], multi: true, lookup: (q) => jiraIssuePicker(cfg.jira, q), onChange: saveLastFormValues });
            jiraInputs.issuelinks = () => picker.values();
            jiraInputs.__linkType = () => typeSel.value;
            jiraPickers.issuelinks = picker;
            typeSel.addEventListener('change', saveLastFormValues);

        } else if (hasList(f)) {
            wrap.innerHTML = fieldShell(f, pickerHtml(`Search ${f.name.toLowerCase()}...`));
            const allowNew = f.id === 'labels';
            // an empty allowedValues means Jira expects you to ask for them
            const picker = makePicker(wrap, {
                options: f.options,
                multi: f.array || allowNew,
                allowNew,
                lookup: (!f.options.length && (f.autoCompleteUrl || f.kind === 'user' || f.id === 'labels'))
                    ? (q) => jiraFieldOptions(cfg.jira, f, q, projSel.value)
                    : null,
                // a list with no query and no remote source should still open
                eager: f.options.length > 0,
                onChange: saveLastFormValues
            });
            jiraInputs[f.id] = () => (f.array || allowNew) ? picker.values() : (picker.values()[0] || '');
            jiraPickers[f.id] = picker;

        } else if (f.kind === 'date' || f.kind === 'datetime') {
            const dv = typeof f.defaultValue === 'string' ? f.defaultValue : '';
            wrap.innerHTML = fieldShell(f, `<input type="date" class="dynamic-input" value="${escAttr(dv)}">`);
            jiraInputs[f.id] = () => wrap.querySelector('input[type=date]').value;
            wrap.querySelector('input[type=date]').addEventListener('change', saveLastFormValues);

        } else if (f.kind === 'number') {
            const dv = (typeof f.defaultValue === 'number') ? f.defaultValue : '';
            wrap.innerHTML = fieldShell(f, `<input type="number" class="dynamic-input" value="${escAttr(dv)}">`);
            jiraInputs[f.id] = () => wrap.querySelector('input[type=number]').value;
            wrap.querySelector('input[type=number]').addEventListener('input', saveLastFormValues);

        } else {
            const dv = typeof f.defaultValue === 'string' ? f.defaultValue : '';
            wrap.innerHTML = fieldShell(f, `<input type="text" class="dynamic-input" placeholder="${escAttr(f.name)}" value="${escAttr(dv)}">`);
            jiraInputs[f.id] = () => wrap.querySelector('input[type=text]').value;
            wrap.querySelector('input[type=text]').addEventListener('input', saveLastFormValues);
        }

        const rm = wrap.querySelector('.remove-field-btn');
        if (rm) rm.addEventListener('click', () => {
            delete jiraInputs[f.id];
            delete jiraPickers[f.id];
            if (f.id === 'issuelinks') delete jiraInputs.__linkType;
            wrap.remove();
            paintFieldMenu();
            saveLastFormValues();
        });
        paintFieldMenu();
    }

    // Azure's menu is a list of .field-item-btn buttons; a div gets none of the
    // padding, hover or text layout that class carries.
    function paintFieldMenu() {
        const list = document.getElementById('jiraFieldList');
        if (!list) return;
        const q = (document.getElementById('jiraFieldSearch').value || '').toLowerCase();
        const left = jiraFields.filter(f => !jiraInputs[f.id] && f.name.toLowerCase().includes(q));
        list.innerHTML = '';

        if (!left.length) {
            const empty = document.createElement('div');
            empty.className = 'field-item-btn';
            empty.style.opacity = '.5';
            empty.textContent = 'No fields left';
            list.appendChild(empty);
            return;
        }

        for (const f of left) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'field-item-btn';
            btn.innerHTML = `<strong>${escHtml(f.name)}</strong><small>${escHtml(f.id)}</small>`;
            btn.onclick = () => {
                renderJiraField(f);
                document.getElementById('jiraAddFieldMenu').classList.remove('show');
                saveLastFormValues();
            };
            list.appendChild(btn);
        }
    }

    // ── persistence, matching Azure's dynamic fields exactly ────────────────
    // Everything currently rendered, in a shape draft-restore can act on:
    // list-valued fields keep {id,name} pairs (a pill needs the name to
    // redraw, and the id alone can't get it back without asking Jira again),
    // everything else keeps its raw input value.
    function collectJiraDynamicFields() {
        return jiraFields.filter(f => jiraInputs[f.id]).map(f => {
            if (jiraPickers[f.id]) {
                const entry = { id: f.id, list: jiraPickers[f.id].chosenFull() };
                if (f.id === 'issuelinks' && jiraInputs.__linkType) entry.linkType = jiraInputs.__linkType();
                return entry;
            }
            return { id: f.id, value: jiraInputs[f.id]() };
        });
    }

    // requiredOnly mirrors autoRenderAdoFields(true): a field missing from an
    // OPTIONAL draft entry was removed on purpose (no remove button exists
    // for a required one, so its absence can only mean Jira added it since).
    function restoreJiraDynamicFields(saved) {
        if (!saved || !saved.length) return;
        const savedMap = new Map(saved.map(s => [s.id, s]));

        for (const f of jiraFields) {
            if (!f.required && jiraInputs[f.id] && !savedMap.has(f.id)) {
                const wrap = document.querySelector(`.dynamic-field-wrapper[data-field-id="${CSS.escape(f.id)}"]`);
                if (wrap) wrap.remove();
                delete jiraInputs[f.id];
                delete jiraPickers[f.id];
                if (f.id === 'issuelinks') delete jiraInputs.__linkType;
            }
        }
        paintFieldMenu();

        for (const [id, s] of savedMap) {
            if (!jiraInputs[id]) continue;   // removed above, or never on this project's create screen
            if (jiraPickers[id]) {
                jiraPickers[id].setInitial(s.list || []);
                if (id === 'issuelinks' && s.linkType) {
                    const typeSel = document.querySelector('#jiraTopFields .link-type');
                    if (typeSel) typeSel.value = s.linkType;
                }
            } else {
                const wrap = document.querySelector(`.dynamic-field-wrapper[data-field-id="${CSS.escape(id)}"]`);
                const input = wrap && wrap.querySelector('.dynamic-input');
                if (input) input.value = s.value != null ? s.value : '';
            }
        }
    }

    // loadLastFormValues() lives outside this closure and has no other way to
    // reach jiraInputs/jiraFields - same reason window.bugTargetReady exists.
    window.collectJiraDynamicFields = collectJiraDynamicFields;
    window.restoreJiraDynamicFields = restoreJiraDynamicFields;
    window.jiraFieldsReady = () => Object.keys(jiraInputs).length > 0;

    // The fields every Jira bug has, for when createmeta cannot tell us which
    // fields this project has. Their values are still fetched, never listed here.
    function standardJiraFields(meta) {
        const f = (id, name, kind, extra) => Object.assign({
            id, name, kind, required: false, array: false, autoCompleteUrl: '', options: []
        }, extra || {});

        return [
            f('issuelinks', 'Linked Issues', 'any', { required: true, array: true }),
            f('assignee', 'Assignee', 'user', { required: true }),
            f('priority', 'Priority', 'priority', { options: meta.priorities || [], postCreate: true }),
            f('labels', 'Labels', 'string', { array: true })
        ];
    }

    // Every Jira dropdown and every optional field comes from that project's
    // own configuration - never from a list written here.
    async function fillJiraMeta(projectKey) {
        if (!projectKey) return;
        const meta = await jiraCreateMeta(cfg.jira, projectKey).catch(() => null);
        if (!meta) { showToast('Could not read this project from Jira'); return; }

        if (!meta.bugTypeId) {
            const why = (meta.errors || []).join(' | ');
            showToast(why ? `Jira refused: ${why}` : 'This project exposes no issue type you can create');
            return;
        }

        const typeEl = document.getElementById('jiraIssueType');
        if (typeEl) typeEl.value = meta.bugTypeId;
        window.jiraBugTypeName = meta.bugTypeName || '';

        // fields belong to a project + issue type pair, so start clean
        for (const id of ['jiraFieldsContainer', 'jiraTopFields']) {
            const box = document.getElementById(id);
            if (box) box.innerHTML = '';
        }
        for (const k of Object.keys(jiraInputs)) delete jiraInputs[k];

        // Link types only decorate the issuelinks picker; losing them costs a
        // dropdown, not the form. createmeta losing is a different matter.
        jiraLinkTypeList = await jiraLinkTypes(cfg.jira).catch(() => []);

        try {
            jiraFields = await jiraCreateFields(cfg.jira, projectKey, meta.bugTypeId);
        } catch (err) {
            if (!err.gone) { showToast(err.message); return; }
            // The endpoint is gone, not this project. Every value below still
            // comes from Jira - only the list of which fields exist is ours.
            showToast('Jira no longer exposes this project\'s create screen. Showing the standard fields.');
            jiraFields = standardJiraFields(meta);
        }

        // Jira exposes field types we have no way to serialise (`any`, `team`,
        // `issuerestriction`...). Offering them means offering an HTTP 400.
        const unusable = jiraFields.filter(f => !jiraFieldSupported(f));
        jiraFields = jiraFields.filter(jiraFieldSupported);

        const blocking = unusable.filter(f => f.required);
        if (blocking.length) {
            showToast(`This project requires ${blocking.map(f => f.name).join(', ')}, which this form cannot fill. Create the bug in Jira.`);
        }

        // Fields this team always fills, whether or not Jira insists on them.
        // Marking them required renders them up front and blocks an empty submit.
        for (const f of jiraFields) {
            if (JIRA_ALWAYS_REQUIRED.has(f.id)) f.required = true;
        }

        // Priority is missing from many projects' create screens, yet every Jira
        // site has it and every bug wants one. Synthesise the field from the
        // global /priority list when createmeta leaves it out.
        if (!jiraFields.some(f => f.id === 'priority') && meta.priorities.length) {
            jiraFields.push({
                id: 'priority',
                name: 'Priority',
                required: false,
                array: false,
                kind: 'priority',
                autoCompleteUrl: '',
                options: meta.priorities,
                // createmeta left it off the create screen, so Jira will refuse
                // it there. It is set right after the issue exists.
                postCreate: true
            });
        }

        // Linked Issues sits directly under the title; everything else follows
        // the description. Every field Jira's own create screen shows renders
        // automatically - not just the required ones - so this form starts
        // matching what a user would see creating the bug directly in Jira.
        // Optional fields keep their remove button; required ones don't.
        const links = jiraFields.find(f => f.id === 'issuelinks');
        if (links) await renderJiraField(links);

        // Required fields first - a field you must fill in before scrolling
        // past it beats finding it at the bottom after the optional ones.
        const rest = jiraFields.filter(f => f.id !== 'issuelinks')
            .sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
        for (const f of rest) await renderJiraField(f);
        paintFieldMenu();
    }

    // Azure's severity list belongs to the process template, not to us.
    async function fillAzureSeverity(org, project) {
        const sel = document.getElementById('bugSeverity');
        if (!sel || !org || !project) return;
        const values = await azureFieldOptions(cfg.azure, org, project, 'Microsoft.VSTS.Common.Severity');
        if (!values.length) { sel.innerHTML = '<option value="">Unavailable</option>'; return; }
        sel.innerHTML = values.map(v => `<option value="${v}">${v}</option>`).join('');
        // A new project brings a new list: whatever was picked before is gone,
        // so the flag guarding it has to go too.
        delete sel.dataset.userSet;
        const mid = values.find(v => /medium/i.test(v));
        if (mid) sel.value = mid;
    }

    // The organizations belong to the token, not to a cached copy of it: ask
    // Azure every time the form opens, so a PAT that gained or lost access is
    // reflected immediately.
    async function fillAzureOrgs() {
        if (!cfg.azure || !cfg.azure.pat) {
            orgSel.innerHTML = '<option value="">Add your PAT in Settings</option>';
            return;
        }
        // the legacy project/member lookups still read the PAT from storage.sync
        chrome.storage.sync.set({ azurePat: cfg.azure.pat });

        orgSel.innerHTML = '<option value="">Loading…</option>';
        orgSel.disabled = true;
        try {
            const { orgs } = await azureOrgs(cfg.azure);
            orgSel.innerHTML = '<option value="">Select Organization</option>' +
                orgs.map(o => `<option value="${o}">${o}</option>`).join('');
            orgSel.disabled = false;
        } catch (e) {
            orgSel.innerHTML = `<option value="">${escHtml(e.message || 'Could not list organizations')}</option>`;
        }
    }

    async function fillJiraProjects() {
        projSel.disabled = true;
        projSel.innerHTML = '<option value="">Loading…</option>';
        try {
            const list = await jiraProjects(cfg.jira);
            projSel.innerHTML = '<option value="">Select Project</option>' +
                list.map(p => `<option value="${p.key}">${p.name}</option>`).join('');
            // the last project used is the one you almost always want next
            if (cfg.jira.project) projSel.value = cfg.jira.project;
            projSel.disabled = false;
            if (projSel.value) fillJiraMeta(projSel.value);
        } catch (e) {
            projSel.innerHTML = `<option value="">${e.message || 'Could not load projects'}</option>`;
        }
    }

    // Where a bug goes barely changes between reports; remember both the
    // provider and the last project so nothing has to be picked twice.
    projSel.addEventListener('change', () => {
        if (!projSel.value) return;
        if (target.value === 'jira') {
            saveBugConfig({ jira: { project: projSel.value } }).catch(() => { });
            fillJiraMeta(projSel.value);          // priorities and components are per project
        } else {
            fillAzureSeverity(orgSel.value, projSel.value);
        }
    });

    async function applyTarget() {
        const t = target.value;
        showAzureFields(t === 'azure');
        if (t === 'jira') await fillJiraProjects();
        else {
            projSel.innerHTML = '<option value="">Select Org First</option>';
            projSel.disabled = true;
        }
    }

    // The modal must not restore anything until the target is settled: the
    // restore path dispatches change events that assume a provider.
    window.bugTargetReady = (async () => {
        cfg = await getBugConfig();
        target.value = cfg.provider || 'azure';
        await fillAzureOrgs();
        await applyTarget();
    })();

    target.addEventListener('change', () => {
        saveBugConfig({ provider: target.value }).catch(() => { });
        applyTarget();
    });

    const addBtn = document.getElementById('jiraAddFieldBtn');
    const addMenu = document.getElementById('jiraAddFieldMenu');
    if (addBtn && addMenu) {
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addMenu.classList.toggle('show');
            if (addMenu.classList.contains('show')) { paintFieldMenu(); document.getElementById('jiraFieldSearch').focus(); }
        });
        document.getElementById('jiraFieldSearch').addEventListener('input', paintFieldMenu);
        document.addEventListener('click', (e) => { if (!addMenu.contains(e.target)) addMenu.classList.remove('show'); });
    }

    // Capture phase: runs before the Azure submit handler and stops it.
    submit.addEventListener('click', async (e) => {
        if (target.value !== 'jira') return;
        e.stopImmediatePropagation();
        e.preventDefault();

        const project = projSel.value.trim();
        const title = document.getElementById('bugTitle').value.trim();
        if (!project) { showToast('Please select a Project'); return; }
        if (!title) { showToast('Please enter a title'); return; }
        const emptyRequired = jiraFields.find(f => {
            if (!f.required || !jiraInputs[f.id]) return false;
            const v = jiraInputs[f.id]();
            return Array.isArray(v) ? !v.length : !String(v || '').trim();
        });
        if (emptyRequired) {
            showToast(`${emptyRequired.name} is required`);
            return;
        }
        if (!(document.getElementById('jiraIssueType') || {}).value) {
            showToast('Loading this project’s issue types…');
            await fillJiraMeta(project);
            if (!(document.getElementById('jiraIssueType') || {}).value) return;   // fillJiraMeta already explained why
        }

        submit.disabled = true;
        const label = submit.innerHTML;
        submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
        // Creating an issue means several round trips: fields, links, uploads.
        // Azure blocks the form while it happens; Jira should too.
        toggleLoader(true, 'Creating Bug Report...');

        try {
            const ctxRes = captureId ? await chrome.storage.local.get([`ctx_${captureId}`]) : {};
            selectedObjectId = null; render();

            const val = (id) => (document.getElementById(id) || {}).value || '';

            // whatever the user actually filled, keyed by Jira's own field ids
            const extra = {};
            for (const [id, read] of Object.entries(jiraInputs)) extra[id] = read();
            // __linkType is consumed by the link call, not sent as a field

            const issue = await jiraCreateBug(cfg.jira, {
                project,
                title,
                issueTypeId: val('jiraIssueType'),
                issueType: window.jiraBugTypeName || '',
                description: document.getElementById('bugDescription').innerHTML.trim(),
                ctx: captureId ? ctxRes[`ctx_${captureId}`] : null,
                // The attachments field is the only source: the capture is a real
                // file in here, so nothing is uploaded straight off the canvas.
                severity: window.aiSeverityLevel || '',
                attachments: await collectAttachments(),
                extra,
                extraMeta: jiraFields
            });

            const warn = (issue.warnings || []);
            showToast(warn.length ? `Created ${issue.key} — ${warn.join('; ')}` : `Created ${issue.key}`);
            window.open(issue.url, '_blank');
            document.getElementById('bugModal').classList.remove('show');
        } catch (err) {
            showToast(`Failed: ${err.message || err}`);
        } finally {
            toggleLoader(false);
            submit.disabled = false;
            submit.innerHTML = label;
        }
    }, true);
})();
