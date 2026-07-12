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

// The user's voice, if they turned the mic on. Grabbed BEFORE the screen picker
// opens, because this window is minimised the moment a screen is chosen - a
// permission prompt raised after that would be asked on a window nobody can see.
// A refusal is never fatal: we record silently and say so.
let micStream = null;
let micDenied = false;

async function acquireMic() {
    const { micEnabled } = await chrome.storage.local.get(['micEnabled']);
    if (!micEnabled) return null;
    try {
        return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        console.warn('Microphone unavailable, recording without it:', e);
        micDenied = true;
        return null;
    }
}

async function startCapture() {
    if (mode === 'record') micStream = await acquireMic();

    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab'], (streamId) => {
        if (!streamId) {
            console.log('User cancelled screen selection');
            if (micStream) micStream.getTracks().forEach(t => t.stop());
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
                    maxHeight: 1080,
                    // Uncapped, the desktop source hands over frames as fast as the
                    // display produces them - up to 60/s - and every one of those
                    // frames has to be encoded. 30 is plenty for showing a bug and
                    // roughly halves the encoder's work, which is most of what made
                    // the page feel heavy while recording.
                    maxFrameRate: 30
                }
            }
        });

        // Fold the voice track into the same stream, so one MediaRecorder muxes
        // picture and narration into a single webm. Muting mid-recording is just
        // `enabled = false` on this track: instant, and it re-encodes nothing.
        if (micStream) {
            micStream.getAudioTracks().forEach(t => recordingStream.addTrack(t));
            chrome.storage.local.set({ micActive: true, micMuted: false });
        } else {
            chrome.storage.local.set({ micActive: false, micMuted: false, micDenied });
        }

        // VP8 first, NOT VP9. VP9 was being picked every time, and its libvpx
        // encoder is software-only and far slower - it was eating the CPU while
        // you recorded, which is what made the page stutter and the browser catch.
        // VP8 encodes much more cheaply, and Chrome can hand it to a hardware
        // encoder when the machine has one. For showing a bug the size difference
        // does not matter; the dropped frames did.
        const types = ['video/webm;codecs=vp8', 'video/webm', 'video/webm;codecs=vp9'];
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
        // The popup's controls read this to know which face to show. Pause can be
        // hit from the in-page bar OR the popup, so the truth has to live where
        // both can see it, not in whichever one happened to press the button.
        chrome.storage.local.set({ recordingPaused: true });
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
        // The popup's timer restarts from recordingStartTime, so it must be moved
        // forward by the paused span too - otherwise the pause counts as elapsed.
        chrome.storage.local.set({ recordingPaused: false, recordingStartTime: recordingStartTimeRef });
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
    } else if (request.action === 'toggleMicFromTab') {
        // Muting is just switching the live track off. The track stays in the
        // recording, so the webm keeps one continuous audio stream - it simply
        // goes silent. Nothing is re-encoded and the timeline never shifts.
        if (micStream) {
            const track = micStream.getAudioTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                chrome.storage.local.set({ micMuted: !track.enabled });
            }
        }
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
        // Plain 'video/webm', NOT mediaRecorder.mimeType: with an audio track the
        // recorder reports video/webm;codecs="vp9,opus", and the comma in that is
        // the very character a data: URL uses to separate type from payload.
        const blob = new Blob(recordedChunks, { type: 'video/webm' });

        // Hand the Blob over through IndexedDB and send only its id. It used to go
        // as a base64 data URL: FileReader re-encoded the whole recording into a
        // string a third larger again, on the main thread, and that string was then
        // serialised through a runtime message, written into chrome.storage.local,
        // read back out and parsed once more - tens of megabytes copied four times
        // before the editor could show a single frame. That was the wait after Stop.
        const captureId = Date.now().toString();
        CapStore.putPending(captureId, blob)
            .then(() => {
                chrome.runtime.sendMessage({
                    type: 'recording-stopped',
                    target: 'background',
                    captureId
                });
                window.close();
            })
            .catch((err) => {
                console.error('Could not store the recording:', err);
                chrome.runtime.sendMessage({
                    type: 'recording-error', target: 'background',
                    error: String((err && err.message) || err)
                });
                window.close();
            });
    } else {
        window.close();
    }

    if (recordingStream) {
        recordingStream.getTracks().forEach(t => t.stop());
    }
    // Release the mic, or Chrome keeps showing the "in use" indicator after the
    // recording is long over. Clear the flags the control bar reads, too.
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    chrome.storage.local.set({ micActive: false, micMuted: false });
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
