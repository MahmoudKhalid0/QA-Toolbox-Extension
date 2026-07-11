// Content script for recording and countdown
//
// Injected dynamically via chrome.scripting.executeScript from several call
// sites in cap-background.js, at least two of which do so unconditionally
// with no "already there" check first. Re-injecting a file re-runs its whole
// top level, which would otherwise register a second onMessage listener (and
// everything below it) on top of the first, still-live one - this guard
// makes a repeat injection a no-op instead of quietly duplicating all of it.
if (!window.__qaCapContentLoaded) {
window.__qaCapContentLoaded = true;

let tabRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingInterval = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        sendResponse({ success: true });
    } else if (request.action === 'showCountdown') {
        showCountdown(request.seconds);
        sendResponse({ success: true });
    } else if (request.action === 'startRecordingInTab') {
        initiateTabRecording(request.streamId);
        sendResponse({ success: true });
    } else if (request.action === 'hideRecordingControl') {
        hideRecordingControl();
        sendResponse({ success: true });
    } else if (request.action === 'recordingError') {
        alert('Recording Error: ' + request.error);
        hideRecordingControl();
        sendResponse({ success: true });
    }
    return true;
});

// Auto-check if recording is in progress on load
chrome.storage.local.get(['isRecordingInProgress'], (result) => {
    if (result.isRecordingInProgress) {
        showRecordingControl();
    }
});

async function initiateTabRecording(streamId) {
    // Recording now happens in offscreen document. 
    // Double check storage to prevent race conditions during page refreshes
    chrome.storage.local.get(['isRecordingInProgress'], (result) => {
        if (result.isRecordingInProgress) {
            showRecordingControl();
        }
    });
}

function showRecordingControl() {
    // If it already exists, don't recreate it to avoid flicker
    if (document.getElementById('recording-floating-control')) return;

    // Create container IMMEDIATELY and synchronously 
    const container = document.createElement('div');
    container.id = 'recording-floating-control';
    container.style.cssText = `
        position: fixed;
        bottom: 30px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        cursor: move;
        user-select: none;
        display: none; /* Hide until storage data is ready */
    `;

    const mount = () => {
        if (!document.body) {
            setTimeout(mount, 50);
            return;
        }
        document.body.appendChild(container);
    };
    mount();

    chrome.storage.local.get(['recordingStartTime'], (result) => {
        let startTime = result.recordingStartTime || Date.now();
        const now = Date.now();
        const elapsed = Math.floor((now - startTime) / 1000);
        const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        const initialTime = `${mins}:${secs}`;

        const shadow = container.attachShadow({ mode: 'open' });

        const styles = `
            :host { all: initial; }
            .control-bar {
                background: #16162e !important;
                padding: 12px 20px;
                border-radius: 16px;
                display: flex;
                flex-direction: row !important;
                direction: ltr !important;
                align-items: center;
                gap: 15px;
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                unicode-bidi: plaintext !important;
            }
            .rec-group { display: flex; align-items: center; gap: 8px; }
            @keyframes recPulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
            .rec-indicator { width: 10px; height: 10px; background: #ff4757; border-radius: 50%; animation: recPulse 1s infinite; }
            .rec-text { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9; }
            .timer { font-size: 18px; font-weight: 700; font-family: 'Consolas', 'Monaco', monospace; min-width: 60px; text-align: center; color: #fff; }
            .stop-btn {
                background: #ff4757;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 10px;
                cursor: pointer;
                font-weight: 700;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: transform 0.2s, background 0.2s;
            }
            .stop-btn:hover { background: #ff6b81; transform: scale(1.05); }
            .stop-btn:active { transform: scale(0.95); }
            svg { fill: currentColor; }
        `;

        const styleTag = document.createElement('style');
        styleTag.textContent = styles;
        shadow.appendChild(styleTag);

        const content = document.createElement('div');
        content.className = 'control-bar';
        content.innerHTML = `
            <div class="rec-group">
                <div class="rec-indicator"></div>
                <span class="rec-text">Recording</span>
            </div>
            <div class="timer" id="rec-timer-display">${initialTime}</div>
            <button class="stop-btn" id="stop-rec-handle">
                <svg width="12" height="12" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                Stop
            </button>
        `;
        shadow.appendChild(content);

        // Show container now that everything is ready
        container.style.display = 'block';

        // DRAG AND DROP LOGIC
        let isDragging = false;
        let dragStartX, dragStartY;
        let initialX, initialY;

        container.addEventListener('mousedown', (e) => {
            if (e.composedPath().some(el => el.id === 'stop-rec-handle')) return;
            isDragging = true;
            const rect = container.getBoundingClientRect();
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            initialX = rect.left;
            initialY = rect.top;
            container.style.bottom = 'auto';
            container.style.left = initialX + 'px';
            container.style.top = initialY + 'px';
            container.style.transform = 'none';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = (initialX + (e.clientX - dragStartX)) + 'px';
            container.style.top = (initialY + (e.clientY - dragStartY)) + 'px';
        });

        window.addEventListener('mouseup', () => isDragging = false);

        // Stop Handler
        const stopBtn = shadow.getElementById('stop-rec-handle');
        stopBtn.onclick = () => {
            chrome.runtime.sendMessage({ action: 'requestStopRecording' });
            setTimeout(() => {
                hideRecordingControl();
            }, 500);
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
        };

        const timerDisplay = shadow.getElementById('rec-timer-display');
        recordingInterval = setInterval(() => {
            const now = Date.now();
            const elapsed = Math.floor((now - startTime + 200) / 1000);
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            timerDisplay.textContent = `${mins}:${secs}`;
        }, 200);
    });
}

function hideRecordingControl() {
    const control = document.getElementById('recording-floating-control');
    if (control) control.remove();
    if (recordingInterval) clearInterval(recordingInterval);
    recordingInterval = null;
}

function showCountdown(seconds) {
    if (document.getElementById('recording-countdown-container')) return;

    const container = document.createElement('div');
    container.id = 'recording-countdown-container';
    container.style.cssText = `
        position: fixed;
        top: 30px;
        left: 30px;
        padding: 0 20px;
        height: 70px;
        background: rgba(45, 45, 45, 0.9);
        backdrop-filter: blur(10px);
        border: 3px solid #8b5cf6;
        border-radius: 12px;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 15px;
        z-index: 99999999;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        font-family: 'Segoe UI', Arial, sans-serif;
        color: white;
        pointer-events: none;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;

    const icon = document.createElement('div');
    icon.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
        </svg>
    `;
    icon.style.display = 'flex';
    icon.style.alignItems = 'center';

    const number = document.createElement('div');
    number.style.cssText = 'font-size: 40px; font-weight: 800; line-height: 1;';

    container.appendChild(icon);
    container.appendChild(number);
    document.body.appendChild(container);

    let remaining = seconds;
    update();

    chrome.runtime.sendMessage({ action: 'updateCountdownState', active: true, seconds: remaining });

    function update() {
        number.textContent = remaining;
        container.style.transform = 'scale(1.1)';
        setTimeout(() => { container.style.transform = 'scale(1)'; }, 100);

        if (remaining > 0) {
            chrome.runtime.sendMessage({ action: 'updateCountdownState', active: true, seconds: remaining });
        }

        if (remaining <= 0) {
            container.remove();
            chrome.runtime.sendMessage({ action: 'updateCountdownState', active: false });
        } else {
            remaining--;
            setTimeout(update, 1000);
        }
    }
}

}   // end of the __qaCapContentLoaded guard
