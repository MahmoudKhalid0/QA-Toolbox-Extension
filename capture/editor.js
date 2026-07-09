import { uploadFileToSupabase, saveToHistory } from './supabase-service.js';

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
}

// Helper to convert DataURL to File
function dataURLtoFile(dataurl, filename) {
    var arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) { u8arr[n] = bstr.charCodeAt(n); }
    return new File([u8arr], filename, { type: mime });
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
const mainShapeBtn = document.getElementById('mainShapeBtn');
const shapesGroup = document.getElementById('shapesGroup');

// Dynamic Fields Elements
const dynamicFieldsContainer = document.getElementById('dynamicFieldsContainer');
const addFieldBtn = document.getElementById('addFieldBtn');
const addFieldMenu = document.getElementById('addFieldMenu');
const fieldSearch = document.getElementById('fieldSearch');
const fieldList = document.getElementById('fieldList');
const cloudUploadBtn = document.getElementById('cloudUploadBtn');
const viewHistoryBtn = document.getElementById('viewHistoryBtn');
const reportBugBtn = document.getElementById('reportBugBtn');
const bugModal = document.getElementById('bugModal');
const submitBugBtn = document.getElementById('submitBugBtn');
const cancelBugBtn = document.getElementById('cancelBugBtn');
const bugTitle = document.getElementById('bugTitle');
const bugDescription = document.getElementById('bugDescription');
const bugOrg = document.getElementById('bugOrg');
const bugProject = document.getElementById('bugProject');
const bugFoundIn = document.getElementById('bugFoundIn');
const bugSeverity = document.getElementById('bugSeverity');
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
let selectedObjectId = null;
let baseImage = null;
let cropArea = null; // {x, y, w, h}
let isMovingCrop = false;
let isResizingCrop = false;
let cropHandle = null;
let selectedFiles = [];
window.pendingVideo = null;
let isUploaded = false;

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

    // 1. Check uploaded state ASAP
    if (captureId) {
        chrome.storage.local.get([`uploaded_${captureId}`], (res) => {
            if (res[`uploaded_${captureId}`]) {
                isUploaded = true;
                applyUploadedUI();
            }
        });
    }

    // 2. Load the actual data
    if (isVideoSession && captureId) {
        setMode('video');
        chrome.storage.local.get([captureId], (result) => {
            const data = result[captureId] || sessionStorage.getItem('currentScreenshot');
            if (!data) {
                console.error('Video data not found');
                toggleLoader(false);
                return;
            }

            try {
                let sanitizedTitle = pageTitle.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '_') || 'recording';
                const videoFile = dataURLtoFile(data, `${sanitizedTitle}.webm`);
                window.pendingVideo = videoFile;

                videoPlayer.src = URL.createObjectURL(videoFile);
                videoPlayer.onerror = (e) => {
                    console.error("Video player error:", e);
                    toggleLoader(false);
                    showToast("Error loading video playback.");
                };
                videoPlayer.onloadeddata = () => toggleLoader(false);
                // Fallback if onloadeddata doesn't fire
                setTimeout(() => toggleLoader(false), 3000);
            } catch (err) {
                console.error("Video processing error:", err);
                toggleLoader(false);
            }
        });
    } else if (captureId || sessionStorage.getItem('currentScreenshot')) {
        setMode('image');
        const idToGet = captureId || 'currentScreenshot';
        chrome.storage.local.get([idToGet, 'cropArea', `uploaded_${idToGet}`], (result) => {
            // Also update uploaded state if found here (some race condition safety)
            if (result[`uploaded_${idToGet}`]) {
                isUploaded = true;
                applyUploadedUI();
            }

            const data = result[idToGet] || sessionStorage.getItem('currentScreenshot');
            if (!data) {
                console.error('Image data not found');
                toggleLoader(false);
                return;
            }

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
                    toggleLoader(false);
                }
                // Sync session storage for fallback
                if (data) sessionStorage.setItem('currentScreenshot', data);
            };
            img.onerror = () => {
                console.error("Image load error");
                toggleLoader(false);
                showToast("Failed to load image.");
            };
            img.src = data;
        });
    } else {
        toggleLoader(false);
    }
}

function applyUploadedUI() {
    if (cloudUploadBtn) {
        cloudUploadBtn.disabled = true;
        cloudUploadBtn.style.opacity = '0.5';
        cloudUploadBtn.innerHTML = '<i class="fas fa-check"></i>';
        cloudUploadBtn.title = "Already uploaded to cloud";
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

        if (obj.type === 'rect') {
            ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
        } else if (obj.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(obj.x, obj.y);
            ctx.lineTo(obj.endX, obj.endY);
            ctx.stroke();
        } else if (obj.type === 'circle') {
            ctx.beginPath();
            ctx.arc(obj.x, obj.y, obj.radius, 0, 2 * Math.PI);
            ctx.stroke();
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
    if (obj.type === 'rect' || obj.type === 'image') {
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
    // Disable undo/redo during crop selection
    if (currentTool === 'crop') {
        undoBtn.disabled = true;
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

function saveHistory(isManualAction = true) {
    if (isManualAction) {
        isUploaded = false;
        if (cloudUploadBtn) {
            cloudUploadBtn.disabled = false;
            cloudUploadBtn.style.opacity = '1';
            cloudUploadBtn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i>';
            cloudUploadBtn.title = "Save to Cloud";
            if (captureId) {
                chrome.storage.local.remove([`uploaded_${captureId}`]);
            }
        }
    }
    // Filter out overlay images - they are not part of undo/redo history
    const shapesOnly = objects.filter(obj => obj.type !== 'image');

    const newState = JSON.stringify({
        objects: shapesOnly,  // Only save shapes, not overlay images
        baseImage: baseImage ? baseImage.src : null
    });

    // Don't save if it's the same as the last state
    if (history.length > 0 && history[history.length - 1] === newState) {
        return;
    }

    history.push(newState);
    redoStack = [];  // Clear redo stack on new actions
    if (history.length > 30) history.shift();
    updateUndoRedoButtons();
}

undoBtn.addEventListener('click', () => {
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

        // Restore shapes only (overlay images are managed separately)
        const shapesOnly = state.objects || [];

        // Keep overlay images from current state
        const overlayImages = objects.filter(obj => obj.type === 'image');
        objects = [...shapesOnly, ...overlayImages];

        cropArea = state.cropArea || null;

        // Ensure tools are deactivated when moving back in history
        currentTool = null;
        setActiveBtn(null);

        restoreBaseImage(state.baseImage, () => {
            if (currentReqId !== restoreRequestId) return;
            restoreImages();
            selectedObjectId = null;
            render();
            updateUndoRedoButtons();
        });
    }
});

redoBtn.addEventListener('click', () => {
    if (redoStack.length > 0) {
        const currentReqId = ++restoreRequestId;
        const next = redoStack.pop();
        history.push(next);
        const state = JSON.parse(next);

        // Restore shapes only (overlay images are managed separately)
        const shapesOnly = state.objects || [];

        // Keep overlay images from current state
        const overlayImages = objects.filter(obj => obj.type === 'image');
        objects = [...shapesOnly, ...overlayImages];

        cropArea = state.cropArea || null;

        // Deactivate any active tool and UI state
        currentTool = null;
        setActiveBtn(null);

        restoreBaseImage(state.baseImage, () => {
            if (currentReqId !== restoreRequestId) return;
            restoreImages();
            selectedObjectId = null;
            render();
            updateUndoRedoButtons();
        });
    }
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
    const shapeTools = [rectBtn, circleBtn, arrowBtn, pencilBtn, lineBtn];
    [rectBtn, circleBtn, textBtn, arrowBtn, pencilBtn, lineBtn, cropBtn, uploadBtn].forEach(b => b && b.classList.remove('active'));

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
    lineWidthInput.value = 3; // Default for shapes
});
circleBtn.addEventListener('click', () => {
    currentTool = 'circle';
    setActiveBtn(circleBtn);
    lineWidthInput.value = 3; // Default for shapes
});
textBtn.addEventListener('click', () => {
    currentTool = 'text';
    setActiveBtn(textBtn);
    lineWidthInput.value = 10; // Default width for text
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
            saveHistory();  // Shapes will be saved, overlay images excluded automatically
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
    lineWidthInput.value = 3;
});

arrowBtn.addEventListener('click', () => {
    currentTool = 'arrow';
    setActiveBtn(arrowBtn);
    lineWidthInput.value = 3;
});

pencilBtn.addEventListener('click', () => {
    currentTool = 'pencil';
    setActiveBtn(pencilBtn);
    lineWidthInput.value = 3;
});

// Update selected object styles
colorPicker.addEventListener('input', () => {
    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj) {
            obj.color = colorPicker.value;
            render();
            saveHistory();
        }
    }
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

    if (selectedObjectId) {
        const obj = objects.find(o => o.id === selectedObjectId);
        if (obj) {
            obj.lineWidth = parseInt(lineWidthInput.value);
            if (obj.type === 'text') {
                obj.fontSize = obj.lineWidth * 5;
            }
            render();
            saveHistory();
        }
    }
});

// Global Mouse Events
canvas.addEventListener('mousemove', (e) => {
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
    return 'default';
}

function getHandleAt(mx, my, obj) {
    if (!obj) return null;
    const s = HANDLE_SIZE + 4;
    if (obj.type === 'rect' || obj.type === 'image') {
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

        // Activate the corresponding tool button based on object type
        if (clicked.type === 'rect') { currentTool = 'rect'; setActiveBtn(rectBtn); }
        else if (clicked.type === 'circle') { currentTool = 'circle'; setActiveBtn(circleBtn); }
        else if (clicked.type === 'text') { currentTool = 'text'; setActiveBtn(textBtn); }
        else if (clicked.type === 'line') { currentTool = 'line'; setActiveBtn(lineBtn); }
        else if (clicked.type === 'arrow') { currentTool = 'arrow'; setActiveBtn(arrowBtn); }
        else if (clicked.type === 'pencil') { currentTool = 'pencil'; setActiveBtn(pencilBtn); }
        else if (clicked.type === 'image') { currentTool = null; setActiveBtn(uploadBtn); }

        render();
        return;
    }

    // Priority Tools (Crop, Text)
    if (currentTool === 'crop' || currentTool === 'text') {
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
    }

    if (currentTool) {
        isDrawing = true;
        selectedObjectId = null;
        currentObject = null;
        const id = Date.now();
        if (currentTool === 'rect') {
            currentObject = { id, type: 'rect', x: startX, y: startY, width: 0, height: 0, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value) };
        } else if (currentTool === 'circle') {
            currentObject = { id, type: 'circle', x: startX, y: startY, radius: 0, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value) };
        } else if (currentTool === 'line') {
            currentObject = { id, type: 'line', x: startX, y: startY, endX: startX, endY: startY, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value) };
        } else if (currentTool === 'arrow') {
            currentObject = { id, type: 'arrow', x: startX, y: startY, endX: startX, endY: startY, color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value) };
        } else if (currentTool === 'pencil') {
            currentObject = { id, type: 'pencil', points: [{ x: startX, y: startY }], color: colorPicker.value, lineWidth: parseInt(lineWidthInput.value) };
        }
    } else {
        selectedObjectId = null;
        currentTool = null;
        setActiveBtn(null);
        render();
    }
    hasMoved = false; // Reset on every drag start
});

canvas.addEventListener('mouseup', () => {
    if (isEditing) return;
    if (isDrawing && currentObject) {
        // Validate that the shape was actually dragged (not just clicked)
        let meaningful = false;
        if (currentObject.type === 'rect') meaningful = Math.abs(currentObject.width) > 5 || Math.abs(currentObject.height) > 5;
        else if (currentObject.type === 'circle') meaningful = currentObject.radius > 5;
        else if (currentObject.type === 'line' || currentObject.type === 'arrow') meaningful = dist(currentObject.x, currentObject.y, currentObject.endX, currentObject.endY) > 5;
        else if (currentObject.type === 'pencil') meaningful = currentObject.points.length > 3;

        if (meaningful) {
            objects.push(currentObject);
            saveHistory();
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
        if (currentObject.type === 'rect' || currentObject.type === 'image') {
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
        if (currentTool === 'rect') {
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
    if (obj.type === 'rect' || obj.type === 'image') {
        const x1 = Math.min(obj.x, obj.x + obj.width) - p;
        const x2 = Math.max(obj.x, obj.x + obj.width) + p;
        const y1 = Math.min(obj.y, obj.y + obj.height) - p;
        const y2 = Math.max(obj.y, obj.y + obj.height) + p;
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    } else if (obj.type === 'circle') {
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

if (bugDescription) {
    ['keyup', 'mouseup', 'input', 'focus'].forEach(evt => {
        bugDescription.addEventListener(evt, updateToolbarStates);
    });

    // Handle image resize on paste for Description field
    bugDescription.addEventListener('paste', (e) => {
        // Use a small delay to let the content be pasted
        setTimeout(() => {
            const images = bugDescription.querySelectorAll('img');
            images.forEach(img => {
                if (!img.style.maxWidth || img.style.maxWidth === '300px') {
                    img.style.maxWidth = '600px';
                    img.style.height = 'auto';
                    img.style.display = 'block';
                    img.style.margin = '10px 0';
                    img.style.borderRadius = '4px';
                    img.style.border = '1px solid #ddd';
                }
            });
            saveLastFormValues();
        }, 10);
    });
}

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
const persistFields = ["bugOrg", "bugProject", "bugFoundIn", "bugSeverity", "bugParentSearch", "bugParent", "bugTags", "bugAssignedTo", "bugDirectManager", "bugArea", "bugIteration"];

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

    // Save dynamic fields
    values.dynamicFields = collectDynamicFields().map(df => {
        const fieldMeta = allAdoFields.find(f => f.referenceName === df.refName);
        return { refName: df.refName, value: df.value, fieldMeta };
    });

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

        if (values.bugOrg) {
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
                                        addDynamicField(df.fieldMeta, df.value);
                                    }
                                });
                            }

                            isInitializing = false;
                        }, 2000); // Wait 2s for all ADO lists
                    } else {
                        isInitializing = false;
                    }
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
bugTitle.addEventListener('input', saveLastFormValues);
bugDescription.addEventListener('input', saveLastFormValues);
bugParentSearch.addEventListener('input', saveLastFormValues);
bugTagsSearch.addEventListener('input', saveLastFormValues);

// ========= Cloud Upload Logic =========
if (cloudUploadBtn) {
    cloudUploadBtn.addEventListener('click', async () => {
        if (isUploaded) {
            showToast("Already uploaded to cloud!");
            return;
        }

        const userTitle = await showCustomModal({
            title: "Upload to Cloud",
            message: "Enter a title for this capture:",
            showInput: true,
            inputValue: pageTitle,
            primaryText: "Upload"
        });

        if (userTitle === false) return; // Cancelled

        try {
            toggleLoader(true, "Uploading to Cloud...");

            let blob;
            let finalTitle = userTitle;
            let fileName = `capture_${Date.now()}`;

            if (isVideoSession) {
                // If it's a video, pendingVideo is already a Blob (or dataUrl)
                if (window.pendingVideo) {
                    if (window.pendingVideo instanceof Blob) {
                        blob = window.pendingVideo;
                    } else if (typeof window.pendingVideo === 'string') {
                        // Data URL
                        const res = await fetch(window.pendingVideo);
                        blob = await res.blob();
                    }
                    fileName += ".webm";
                } else {
                    throw new Error("No video data found to upload.");
                }
            } else {
                // For images, get from canvas
                blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                fileName += ".png";
            }

            if (!blob) throw new Error("Could not process file for upload.");

            // 1. Upload to Supabase Storage
            const uploadResult = await uploadFileToSupabase(blob, fileName);

            // 2. Save Metadata to Supabase Table
            await saveToHistory({
                title: finalTitle,
                url: uploadResult.url,
                type: isVideoSession ? 'video' : 'image',
                timestamp: new Date().toISOString(),
                size: uploadResult.size
            });

            showToast("Successfully uploaded to cloud!");
            isUploaded = true;
            cloudUploadBtn.disabled = true;
            cloudUploadBtn.style.opacity = '0.5';
            cloudUploadBtn.innerHTML = '<i class="fas fa-check"></i>';
            cloudUploadBtn.title = "Already uploaded to cloud";

            // Save state to survive refresh
            const uploadHistoryKey = `uploaded_${captureId || 'currentScreenshot'}`;
            chrome.storage.local.set({ [uploadHistoryKey]: true });

            // Open history page and close current tab quickly
            window.open('history.html', '_blank');
            setTimeout(() => window.close(), 50);

        } catch (err) {
            console.error("Cloud Upload Error:", err);
            showToast("Failed to upload: " + err.message);
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
        return;
    }

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

async function loadBugFieldOptions(org, project, authHeader) {
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);

    try {
        const resp = await fetch(
            `https://dev.azure.com/${encodedOrg}/${encodedProject}/_apis/wit/workitemtypes/Bug/fields?$expand=allowedValues&api-version=7.0`,
            { headers: { 'Authorization': authHeader } }
        );
        if (!resp.ok) return;

        const data = await resp.json();
        const fields = data.value || [];
        allAdoFields = fields;

        // Enable add field button
        addFieldBtn.disabled = false;

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
    if (!resp.ok) return;

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
        if (!resp.ok) return;
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

// Dynamic Parent Search (WIQL fallback)
let parentSearchTimeout = null;
bugParentSearch.addEventListener('input', () => {
    clearTimeout(parentSearchTimeout);
    const query = bugParentSearch.value.trim();
    if (!query) {
        bugParentResults.classList.remove('show');
        bugParent.value = "";
        return;
    }
    parentSearchTimeout = setTimeout(() => searchParentsDynamically(query), 500);
});

async function searchParentsDynamically(query) {
    const org = bugOrg.value.trim();
    const project = bugProject.value.trim();
    const encodedOrg = encodeURIComponent(org);
    const encodedProject = encodeURIComponent(project);

    if (!org || !project) return;

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

        if (!resp.ok) return;
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
        item.onclick = () => {
            selectedTags.add(tag);
            bugTagsSearch.value = '';
            bugTagsResults.classList.remove('show');
            renderTagPills();
            saveLastFormValues();
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
bugAttachments?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    selectedFiles = [...selectedFiles, ...files];
    renderAttachmentList();
});

function renderAttachmentList() {
    if (!bugAttachmentList) return;
    bugAttachmentList.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <i class="fas ${file.type.startsWith('image/') ? 'fa-file-image' : 'fa-file-video'}"></i>
            <span title="${file.name}">${file.name}</span>
            <span class="remove-file" data-index="${index}">&times;</span>
        `;
        item.querySelector('.remove-file').onclick = () => {
            selectedFiles.splice(index, 1);
            renderAttachmentList();
        };
        bugAttachmentList.appendChild(item);
    });

}

// Open modal
reportBugBtn.addEventListener('click', () => {
    chrome.storage.sync.get(['azurePat'], (settings) => {
        if (!settings.azurePat) {
            showToast('Please configure Azure DevOps PAT in settings first');
            chrome.runtime.openOptionsPage();
            return;
        }
        // Ensure video is added to attachments if it exists
        if (window.pendingVideo && !selectedFiles.includes(window.pendingVideo)) {
            selectedFiles.push(window.pendingVideo);
            renderAttachmentList();
        }
        bugModal.classList.add('show');
        bugOrg.focus();
        loadLastFormValues();
        renderTagPills();
    });
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

function renderAddFieldMenu(query = '') {
    fieldList.innerHTML = '';

    // Fields we already have static or active
    const staticFields = [
        'System.Title', 'System.Description', 'System.AssignedTo', 'System.Tags',
        'Microsoft.VSTS.Common.Severity', 'System.AreaPath', 'System.IterationPath',
        'Microsoft.VSTS.TCM.ReproSteps', 'Custom.DirectManager', stageFieldReferenceName,
        'System.Id', 'System.WorkItemType', 'System.State', 'System.CreatedDate',
        'System.ChangedDate', 'System.CreatedBy', 'System.ChangedBy', 'System.AuthorizedDate',
        'System.AuthorizedAs', 'System.Rev', 'System.Watermark', 'System.IsDeleted',
        'System.Reason', 'System.BoardColumn', 'System.BoardColumnDone', 'System.BoardLane',
        'System.CommentCount', 'System.TeamProject'
    ];

    const availableFields = allAdoFields.filter(f => {
        const refName = f.referenceName;
        const name = (f.name || '').toLowerCase();

        // Skip hidden or already active fields
        if (staticFields.includes(refName)) return false;
        if (activeDynamicFields.has(refName)) return false;
        if (f.readOnly) return false;

        // Highly Restrictive Filtering: Only show what's likely on the form
        const isCustomField = refName.startsWith('Custom.');

        // Common standard fields usually in the UI
        const standardUIFields = [
            'Microsoft.VSTS.Common.Priority',
            'Microsoft.VSTS.Common.Activity',
            'Microsoft.VSTS.Scheduling.StoryPoints',
            'Microsoft.VSTS.Common.ValueArea',
            'Microsoft.VSTS.Common.ResolvedReason',
            'Microsoft.VSTS.Common.Risk',
            'Microsoft.VSTS.Scheduling.RemainingWork',
            'Microsoft.VSTS.Scheduling.CompletedWork',
            'Microsoft.VSTS.Scheduling.OriginalEstimate'
        ];

        // Heuristic for other VSTS fields: If it contains "Stage", "Cause", "Manager", "Source" in name
        const isLikelyUIField = refName.startsWith('Microsoft.VSTS.') &&
            (name.includes('stage') || name.includes('cause') || name.includes('manager') || name.includes('source'));

        if (!isCustomField && !standardUIFields.includes(refName) && !isLikelyUIField) return false;

        // Filter by query
        if (query && !name.includes(query) && !refName.toLowerCase().includes(query)) return false;

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
            addDynamicField(f);
            addFieldMenu.classList.remove('show');
        };
        fieldList.appendChild(btn);
    });
}

function addDynamicField(field, savedValue = '') {
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
            <label>${field.name}</label>
            <button type="button" class="remove-field-btn" title="Remove Field">
                <i class="fas fa-trash"></i>
            </button>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
            ${inputHtml}
        </div>
    `;

    wrapper.querySelector('.remove-field-btn').onclick = () => {
        activeDynamicFields.delete(field.referenceName);
        wrapper.remove();
        saveLastFormValues();
    };

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
    const screenshotDataUrl = canvas.toDataURL('image/png');
    const attachments = [...selectedFiles];

    // Show loading
    submitBugBtn.disabled = true;
    toggleLoader(true, "Creating Bug Report...");

    try {
        const result = await createAzureDevOpsBug({
            org, project, title, description, assignedTo, directManager,
            areaPath: bugArea.value, iterationPath: bugIteration.value,
            severity, foundIn, parent, tags, screenshotDataUrl, attachments,
            dynamicFields: collectDynamicFields()
        });

        showToast('Bug created successfully! ID: ' + result.id);

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

        // Reset dynamic fields
        dynamicFieldsContainer.innerHTML = '';
        activeDynamicFields.clear();

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
    const otherAttachmentUrls = [];
    if (data.attachments && data.attachments.length > 0) {
        for (const file of data.attachments) {
            try {
                const url = await uploadFileAttachment(encodedOrg, encodedProject, authHeader, file);
                otherAttachmentUrls.push({ url, name: file.name });
            } catch (e) {
                console.error("Failed to upload attachment:", file.name, e);
            }
        }
    }

    // Process inline images in description
    let processedDescription = data.description || 'See details below.';
    if (processedDescription.includes('src="data:')) {
        processedDescription = await processInlineImages(processedDescription, encodedOrg, encodedProject, authHeader);
    }

    // Create repro steps with links to other attachments
    let reproSteps = `<div>${processedDescription}</div>`;

    // Always upload and attach the screenshot
    const screenshotUrl = await uploadAttachment(encodedOrg, encodedProject, authHeader, data.screenshotDataUrl, `screenshot.png`);
    reproSteps += `
        <br/>
        <img src="${screenshotUrl}" alt="Bug Screenshot" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px;" />
    `;

    if (otherAttachmentUrls.length > 0) {
        reproSteps += `<br/><br/><div><strong>Attachments:</strong></div><ul>`;
        otherAttachmentUrls.forEach(attr => {
            reproSteps += `<li><a href="${attr.url}">${attr.name}</a></li>`;
        });
        reproSteps += `</ul>`;
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
            console.error("Failed to upload inline image:", e);
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
        throw new Error('Failed to upload attachment');
    }

    const result = await uploadResponse.json();
    return result.url;
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
        throw new Error('Failed to upload file attachment: ' + file.name);
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
