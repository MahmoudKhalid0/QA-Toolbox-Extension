const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode'); // 'record' or null (screenshot)
const targetTabId = parseInt(urlParams.get('tabId'));

let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let timerInterval = null;

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

        mediaRecorder = new MediaRecorder(recordingStream, {
            mimeType,
            videoBitsPerSecond: 5000000
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
            chrome.storage.local.set({ recordingStartTime: startTime });

            // Give the tab's countdown UI extra time to disappear 
            // before actually starting the capture
            setTimeout(() => {
                mediaRecorder.start(1000);
            }, 300);

            // Show Recording UI in this window (ready when un-minimized)
            document.getElementById('init-ui').style.display = 'none';
            document.getElementById('recording-ui').style.display = 'block';
            startTimer(startTime);
        }, 3000);

    } catch (err) {
        console.error('Recording start error:', err);
        window.close();
    }
}

function startTimer(startTime) {
    const timerDisplay = document.getElementById('timer');
    timerInterval = setInterval(() => {
        const now = Date.now();
        const seconds = Math.floor((now - startTime) / 1000);
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        timerDisplay.textContent = `${mins}:${secs}`;
    }, 1000);
}

document.getElementById('stopBtn').addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        document.getElementById('stopBtn').disabled = true;
        document.getElementById('stopBtn').textContent = 'Processing...';
    }
});

// Listen for stop request from the tab UI
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'stopRecordingFromTab') {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    }
});

async function handleRecordingStopped() {
    clearInterval(timerInterval);

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
