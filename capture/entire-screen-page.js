const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode'); // 'record' or null (screenshot)
const targetTabId = parseInt(urlParams.get('tabId'));

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let timerInterval = null;
let recordingStartTimeRef = null;
let pauseStartedAt = null;
let isDiscarding = false;

async function startCapture() {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab'], (streamId) => {
        if (!streamId) {
            console.log('User cancelled screen selection');
            window.close();
            return;
        }

        if (mode === 'record') {
            startVideoRecording(streamId);
        } else {
            // For screenshots, minimize then capture
            chrome.windows.getCurrent((win) => {
                chrome.windows.update(win.id, { state: 'minimized' }, () => {
                    setTimeout(() => {
                        captureScreenshot(streamId);
                    }, 500); // Increased from 150ms for better reliability
                });
            });
        }
    });
}

async function startVideoRecording(streamId) {
    try {
        // Immediate minimization after selection as requested
        chrome.windows.getCurrent((win) => {
            chrome.windows.update(win.id, { state: 'minimized' });
        });

        recordingStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: streamId,
                    maxWidth: 1920,
                    maxHeight: 1080
                }
            }
        });

        const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

        // Set in Settings > Screenshot & Record. This is the recorder that
        // actually runs for every real recording (the "record" action always
        // opens this popup) - offscreen.js has its own copy of this same
        // setup but nothing currently triggers it to record.
        const BITRATE_BY_QUALITY = { low: 1500000, medium: 3000000, high: 5000000, ultra: 8000000 };
        const { videoQuality } = await chrome.storage.local.get(['videoQuality']);
        const videoBitsPerSecond = BITRATE_BY_QUALITY[videoQuality] || BITRATE_BY_QUALITY.high;

        mediaRecorder = new MediaRecorder(recordingStream, {
            mimeType,
            videoBitsPerSecond
        });

        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = handleRecordingStopped;

        // Notify background to show countdown in the target tab
        chrome.runtime.sendMessage({
            action: 'triggerCountdownInTab',
            targetTabId: targetTabId
        });

        // Visual feedback in the popup (still runs while minimized)
        let count = 3;
        const statusText = document.getElementById('status-text');
        statusText.textContent = `Starting in ${count}...`;
        const countInterval = setInterval(() => {
            count--;
            if (count > 0) {
                statusText.textContent = `Starting in ${count}...`;
            } else {
                clearInterval(countInterval);
            }
        }, 1000);

        // Wait for countdown (3s)
        setTimeout(() => {
            // Notify background to show UI in the tab slightly earlier (at 2.7s)
            chrome.runtime.sendMessage({
                action: 'notifyRecordingStartedInTab',
                targetTabId: targetTabId
            });
        }, 2700);

        setTimeout(() => {
            const startTime = Date.now();
            recordingStartTimeRef = startTime;
            chrome.storage.local.set({ recordingStartTime: startTime });

            // Give the tab's countdown UI extra time to disappear
            // before actually starting the capture
            setTimeout(() => {
                mediaRecorder.start(1000);
            }, 300);

            // Show Recording UI in this window (ready when un-minimized)
            document.getElementById('init-ui').style.display = 'none';
            document.getElementById('recording-ui').style.display = 'block';
            startTimer();
        }, 3000);

    } catch (err) {
        console.error('Recording start error:', err);
        window.close();
    }
}

function startTimer() {
    const timerDisplay = document.getElementById('timer');
    timerInterval = setInterval(() => {
        const now = Date.now();
        const seconds = Math.floor((now - recordingStartTimeRef) / 1000);
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        timerDisplay.textContent = `${mins}:${secs}`;
    }, 1000);
}

// Pausing freezes the displayed time by simply not ticking; resuming shifts
// recordingStartTimeRef forward by however long the pause lasted, so the
// same "now - start" formula keeps working without tracking elapsed time
// as a separate running total.
function pauseRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        pauseStartedAt = Date.now();
        clearInterval(timerInterval);
    }
}

function resumeRecording() {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        if (pauseStartedAt) {
            recordingStartTimeRef += (Date.now() - pauseStartedAt);
            pauseStartedAt = null;
        }
        startTimer();
    }
}

function discardRecording() {
    isDiscarding = true;
    if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
        mediaRecorder.stop();
    } else {
        window.close();
    }
}

document.getElementById('stopBtn').addEventListener('click', () => {
    if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
        mediaRecorder.stop();
        document.getElementById('stopBtn').disabled = true;
        document.getElementById('stopBtn').textContent = 'Processing...';
    }
});

// Listen for control requests relayed from the floating tab UI
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'stopRecordingFromTab') {
        if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) {
            mediaRecorder.stop();
        }
    } else if (request.action === 'pauseRecordingFromTab') {
        pauseRecording();
    } else if (request.action === 'resumeRecordingFromTab') {
        resumeRecording();
    } else if (request.action === 'discardRecordingFromTab') {
        discardRecording();
    }
});

async function handleRecordingStopped() {
    clearInterval(timerInterval);

    // Thrown away on purpose - close without ever building/sending the blob,
    // so nothing gets saved and the editor never opens for it.
    if (isDiscarding) {
        window.close();
        return;
    }

    const loader = document.getElementById('globalLoader');
    if (loader) {
        loader.style.display = 'flex';
        loader.classList.add('show');
    }

    if (recordedChunks.length > 0) {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
        const reader = new FileReader();
        reader.onload = () => {
            chrome.runtime.sendMessage({
                type: 'recording-stopped',
                target: 'background',
                videoDataUrl: reader.result
            });
            window.close();
        };
        reader.readAsDataURL(blob);
    } else {
        window.close();
    }

    if (recordingStream) {
        recordingStream.getTracks().forEach(t => t.stop());
    }
}

async function captureScreenshot(streamId) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: streamId
                }
            }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true; // Helps with autoplay policies

        video.onloadedmetadata = async () => {
            video.play();

            // Increased wait for a valid frame to ensure capture reliability
            await new Promise(r => setTimeout(r, 500)); // Increased from 150ms

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imageDataUrl = canvas.toDataURL('image/png');

            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());

            // Send to background
            chrome.runtime.sendMessage({
                type: 'screenshot-captured',
                target: 'background',
                imageDataUrl: imageDataUrl
            });

            // Close this window
            window.close();
        };
    } catch (err) {
        console.error('Capture error:', err);
        window.close();
    }
}

// Start immediately when the page loads
startCapture();
