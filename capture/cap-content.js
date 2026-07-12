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
            .rec-indicator.paused { animation: none; opacity: 0.6; background: #ffa502; }
            .rec-text { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9; }
            .timer { font-size: 26px; font-weight: 800; font-family: 'Consolas', 'Monaco', monospace; min-width: 78px; text-align: center; color: #fff; }
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
            .stop-btn:hover { background: #ff6b81; }
            .stop-btn:active { transform: scale(0.95); }
            .pause-btn {
                background: rgba(255, 255, 255, 0.08);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.15);
                padding: 8px 14px;
                border-radius: 10px;
                cursor: pointer;
                font-weight: 700;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: transform 0.2s, background 0.2s;
            }
            .pause-btn:hover { background: rgba(255, 255, 255, 0.18); }
            .pause-btn:active { transform: scale(0.95); }
            .discard-btn {
                background: transparent;
                color: rgba(255, 255, 255, 0.55);
                border: none;
                width: 32px;
                height: 32px;
                border-radius: 10px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s, color 0.2s;
            }
            .discard-btn:hover { background: rgba(255, 71, 87, 0.18); color: #ff6b81; }
            /* Only present when the recording actually has a mic track. Muting
               flips the live track off - the recording keeps running and the
               timeline never shifts, it just goes silent. */
            .mic-btn {
                background: transparent;
                color: #6ee7b7;
                border: none;
                width: 32px;
                height: 32px;
                border-radius: 10px;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                position: relative;
                transition: background 0.2s, color 0.2s;
            }
            .mic-btn.show { display: flex; }
            .mic-btn:hover { background: rgba(255, 255, 255, 0.18); }
            .mic-btn.muted { color: rgba(255, 255, 255, 0.45); }
            /* The slash that says "off" without needing a second icon. */
            .mic-btn.muted::after {
                content: '';
                position: absolute;
                left: 6px; right: 6px; top: 50%;
                height: 2px; background: #ff6b81;
                transform: rotate(-45deg);
                border-radius: 2px;
            }
            .point-wrap { position: relative; }
            .point-btn {
                background: rgba(255, 255, 255, 0.08);
                color: white;
                border: 1px solid rgba(255, 255, 255, 0.15);
                width: 34px;
                height: 34px;
                border-radius: 10px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s, background 0.2s, border-color 0.2s;
            }
            .point-btn:hover { background: rgba(255, 255, 255, 0.18); }
            .point-btn.active { background: rgba(139, 92, 246, 0.35); border-color: #8b5cf6; color: #d8c8ff; }
            .point-menu {
                position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
                background: #16162e; border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px; padding: 6px; display: none; flex-direction: column;
                gap: 2px; min-width: 150px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            }
            .point-menu.open { display: flex; }
            .point-menu button {
                background: transparent; color: white; border: none; text-align: left;
                padding: 9px 10px; border-radius: 8px; cursor: pointer; font-size: 13px;
                font-weight: 600; display: flex; align-items: center; gap: 8px;
            }
            .point-menu button:hover { background: rgba(255, 255, 255, 0.1); }
            .point-menu button.active { color: #d8c8ff; }
            .point-menu button.active::after { content: '✓'; margin-left: auto; }
            svg { fill: currentColor; }
        `;

        const styleTag = document.createElement('style');
        styleTag.textContent = styles;
        shadow.appendChild(styleTag);

        const content = document.createElement('div');
        content.className = 'control-bar';
        content.innerHTML = `
            <div class="rec-group">
                <div class="rec-indicator" id="rec-indicator"></div>
                <span class="rec-text" id="rec-text">Recording</span>
            </div>
            <div class="timer" id="rec-timer-display">${initialTime}</div>
            <button class="pause-btn" id="pause-rec-handle">
                <svg id="pause-icon" width="12" height="12" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                <span id="pause-btn-text">Pause</span>
            </button>
            <button class="mic-btn" id="mic-rec-handle" title="Mute the microphone">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>
            </button>
            <button class="discard-btn" id="discard-rec-handle" title="Discard recording">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
            </button>
            <div class="point-wrap">
                <button class="point-btn" id="point-rec-handle" title="Point out something to the viewer">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
                </button>
                <div class="point-menu" id="point-menu">
                    <button data-mode="click" id="point-mode-click">Click Effect</button>
                    <button data-mode="spotlight" id="point-mode-spotlight">Spotlight</button>
                    <button data-mode="off" id="point-mode-off">Off</button>
                </div>
            </div>
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

        const isControlClick = (e) => e.composedPath().some(el =>
            el.id === 'stop-rec-handle' || el.id === 'pause-rec-handle' || el.id === 'discard-rec-handle' ||
            el.id === 'mic-rec-handle' ||   // or muting would drag the bar instead
            (el.classList && el.classList.contains('point-wrap')));

        container.addEventListener('mousedown', (e) => {
            if (isControlClick(e)) return;
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
        // Paused time is subtracted out, same trick as the popup's own timer -
        // simpler than tracking elapsed as a separately-ticking running total.
        let pausedAccumMs = 0;
        let pauseStartedAt = null;

        function tick() {
            const now = Date.now();
            const elapsed = Math.floor((now - startTime + 200 - pausedAccumMs) / 1000);
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            timerDisplay.textContent = `${mins}:${secs}`;
        }
        function startTicking() {
            clearInterval(recordingInterval);
            recordingInterval = setInterval(tick, 200);
        }
        startTicking();

        // Pause / Resume Handler
        const pauseBtn = shadow.getElementById('pause-rec-handle');
        const pauseBtnText = shadow.getElementById('pause-btn-text');
        const pauseIcon = shadow.getElementById('pause-icon');
        const recIndicator = shadow.getElementById('rec-indicator');
        const recText = shadow.getElementById('rec-text');
        const PAUSE_ICON_SVG = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
        const PLAY_ICON_SVG = '<polygon points="6,4 20,12 6,20"/>';
        let isPaused = false;

        // Paint from the shared flag, not from a private variable. Pause can be hit
        // here OR in the popup, and this bar is what the user is actually looking
        // at - if it kept counting and still said "Recording" after a pause from
        // the popup, the pause looked broken even though the recorder had stopped.
        const applyPaused = (paused) => {
            if (paused === isPaused) return;
            isPaused = paused;
            if (paused) {
                pauseStartedAt = Date.now();
                clearInterval(recordingInterval);
                pauseBtnText.textContent = 'Resume';
                pauseIcon.innerHTML = PLAY_ICON_SVG;
                recIndicator.classList.add('paused');
                recText.textContent = 'Paused';
            } else {
                if (pauseStartedAt) { pausedAccumMs += (Date.now() - pauseStartedAt); pauseStartedAt = null; }
                pauseBtnText.textContent = 'Pause';
                pauseIcon.innerHTML = PAUSE_ICON_SVG;
                recIndicator.classList.remove('paused');
                recText.textContent = 'Recording';
                startTicking();
            }
        };

        chrome.storage.local.get(['recordingPaused'], (r) => applyPaused(!!r.recordingPaused));
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area === 'local' && ch.recordingPaused) applyPaused(!!ch.recordingPaused.newValue);
        });

        // The click only asks; the flag coming back is what actually repaints the
        // bar, so this button and the popup's can never disagree.
        pauseBtn.onclick = () => {
            chrome.runtime.sendMessage({
                action: isPaused ? 'requestResumeRecording' : 'requestPauseRecording'
            });
        };

        // Mic Handler - mute/unmute the narration mid-recording. The button only
        // exists if the recorder actually got a mic track (micActive), so it never
        // offers to mute something that was never being recorded.
        const micBtn = shadow.getElementById('mic-rec-handle');
        const paintMic = (active, muted) => {
            micBtn.classList.toggle('show', !!active);
            micBtn.classList.toggle('muted', !!muted);
            micBtn.title = muted ? 'Unmute the microphone' : 'Mute the microphone';
        };
        chrome.storage.local.get(['micActive', 'micMuted'], (r) => paintMic(r.micActive, r.micMuted));
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area !== 'local') return;
            if (ch.micActive || ch.micMuted) {
                chrome.storage.local.get(['micActive', 'micMuted'], (r) => paintMic(r.micActive, r.micMuted));
            }
        });
        micBtn.onclick = (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'requestToggleMic' });
        };

        // Discard Handler - separate from Stop, throws the recording away
        const discardBtn = shadow.getElementById('discard-rec-handle');
        discardBtn.onclick = async () => {
            const yes = await qaConfirm('Discard this recording?', 'This cannot be undone.');
            if (!yes) return;
            chrome.runtime.sendMessage({ action: 'requestDiscardRecording' });
            hideRecordingControl();
        };

        // Point-out-something Handler - Click Effect / Spotlight / Off
        const pointBtn = shadow.getElementById('point-rec-handle');
        const pointMenu = shadow.getElementById('point-menu');
        const pointModeButtons = {
            click: shadow.getElementById('point-mode-click'),
            spotlight: shadow.getElementById('point-mode-spotlight'),
            off: shadow.getElementById('point-mode-off'),
        };
        const setActivePointMode = (mode) => {
            Object.entries(pointModeButtons).forEach(([m, btn]) => btn.classList.toggle('active', m === mode));
            pointBtn.classList.toggle('active', mode !== 'off');
        };
        setActivePointMode('off');

        pointBtn.onclick = () => pointMenu.classList.toggle('open');
        pointModeButtons.click.onclick = () => { enableClickEffect(); setActivePointMode('click'); pointMenu.classList.remove('open'); };
        pointModeButtons.spotlight.onclick = () => { enableSpotlight(); setActivePointMode('spotlight'); pointMenu.classList.remove('open'); };
        pointModeButtons.off.onclick = () => { disablePointerEffect(); setActivePointMode('off'); pointMenu.classList.remove('open'); };

        // Close the menu on any click elsewhere, same convention as the
        // editor's shapes dropdown.
        document.addEventListener('click', (e) => {
            if (!e.composedPath().includes(pointBtn) && !e.composedPath().includes(pointMenu)) {
                pointMenu.classList.remove('open');
            }
        });
    });
}

// Pointer effects (Click Effect / Spotlight) - a light-DOM, full-page,
// pointer-events:none overlay so it never blocks real interaction with the
// page underneath, but still gets painted into the actual tab/desktop
// capture like any other on-screen content. Only one mode is active at once.
let pointerMode = null;
let pointerOverlay = null;
let pointerListener = null;

function disablePointerEffect() {
    if (pointerListener) {
        document.removeEventListener('click', pointerListener, true);
        document.removeEventListener('mousemove', pointerListener, true);
        pointerListener = null;
    }
    if (pointerOverlay) { pointerOverlay.remove(); pointerOverlay = null; }
    pointerMode = null;
}

function enableClickEffect() {
    disablePointerEffect();
    pointerMode = 'click';
    pointerListener = (e) => {
        const ring = document.createElement('div');
        ring.style.cssText = `
            position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
            width: 20px; height: 20px; margin: -10px 0 0 -10px;
            border-radius: 50%; border: 3px solid #8b5cf6;
            pointer-events: none; z-index: 2147483646;
            animation: qa-click-ring 0.6s ease-out forwards;
        `;
        document.body.appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove());
    };
    // capture phase: sees every click on the page without touching how the
    // page itself handles it (never calls preventDefault/stopPropagation).
    document.addEventListener('click', pointerListener, true);
}

function enableSpotlight() {
    disablePointerEffect();
    pointerMode = 'spotlight';
    pointerOverlay = document.createElement('div');
    pointerOverlay.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;
        background: radial-gradient(circle 130px at 50vw 50vh, transparent 0%, transparent 100px, rgba(0,0,0,0.65) 145px);
    `;
    document.body.appendChild(pointerOverlay);
    pointerListener = (e) => {
        pointerOverlay.style.background =
            `radial-gradient(circle 130px at ${e.clientX}px ${e.clientY}px, transparent 0%, transparent 100px, rgba(0,0,0,0.65) 145px)`;
    };
    document.addEventListener('mousemove', pointerListener, true);
}

// One shared stylesheet for the click-effect keyframes - it lives in the
// light DOM (the ring itself does too), so it can't go inside the control
// bar's shadow root the way the rest of the bar's styling does.
(function ensurePointerStyles() {
    if (document.getElementById('qa-pointer-fx-style')) return;
    const style = document.createElement('style');
    style.id = 'qa-pointer-fx-style';
    style.textContent = `
        @keyframes qa-click-ring {
            0% { transform: scale(0.3); opacity: 1; }
            100% { transform: scale(2.2); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
})();

// A branded confirm dialog, not the native confirm() - that one shows the
// page's own hostname ("webserver-xyz.cloud says..."), which reads like a
// random site popup rather than something the extension is asking.
function qaConfirm(title, message) {
    return new Promise((resolve) => {
        const host = document.createElement('div');
        host.id = 'qa-confirm-host';
        host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647;';
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                .backdrop {
                    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
                    display: flex; align-items: center; justify-content: center;
                    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                }
                .card {
                    background: #16162e; border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px; padding: 22px 24px; width: 340px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); color: white;
                    direction: ltr; text-align: left;
                }
                .card h3 { margin: 0 0 8px; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
                .card h3 svg { color: #ff4757; flex-shrink: 0; }
                .card p { margin: 0 0 18px; font-size: 13px; color: rgba(255, 255, 255, 0.65); line-height: 1.5; }
                .actions { display: flex; justify-content: flex-end; gap: 10px; }
                button { border: none; border-radius: 10px; padding: 9px 16px; font-weight: 700; font-size: 13px; cursor: pointer; transition: transform .15s, background .15s; }
                .cancel-btn { background: rgba(255, 255, 255, 0.08); color: white; }
                .cancel-btn:hover { background: rgba(255, 255, 255, 0.15); }
                .confirm-btn { background: #ff4757; color: white; }
                .confirm-btn:hover { background: #ff6b81; }
                button:active { transform: scale(0.96); }
            </style>
            <div class="backdrop">
                <div class="card">
                    <h3>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        ${title}
                    </h3>
                    <p>${message}</p>
                    <div class="actions">
                        <button class="cancel-btn" id="qa-confirm-cancel">Cancel</button>
                        <button class="confirm-btn" id="qa-confirm-ok">Discard</button>
                    </div>
                </div>
            </div>
        `;
        const done = (val) => { host.remove(); resolve(val); };
        shadow.getElementById('qa-confirm-cancel').onclick = () => done(false);
        shadow.getElementById('qa-confirm-ok').onclick = () => done(true);
        shadow.querySelector('.backdrop').addEventListener('click', (e) => {
            if (e.target.classList.contains('backdrop')) done(false);
        });
    });
}

function hideRecordingControl() {
    const control = document.getElementById('recording-floating-control');
    if (control) control.remove();
    if (recordingInterval) clearInterval(recordingInterval);
    recordingInterval = null;
    disablePointerEffect();
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
