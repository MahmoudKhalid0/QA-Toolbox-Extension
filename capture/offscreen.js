let recorder = null;
let data = [];
let stream = null;

// Read streamId from URL immediately
const urlParams = new URLSearchParams(window.location.search);
const streamId = urlParams.get('streamId');

if (streamId) {
    startRecording(streamId);
}

// Still listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    if (message.type === 'start-recording') {
        startRecording(message.streamId);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'stop-recording') {
        stopRecording();
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'capture-screen') {
        captureScreenshot(message.streamId);
        sendResponse({ success: true });
        return true;
    }
    if (message.type === 'stitch-full-page') {
        stitchFullPage(message.data);
        sendResponse({ success: true });
        return true;
    }

    return false;
});

async function startRecording(sId) {
    try {
        console.log('Offscreen: Starting recording for streamId:', sId);
        await new Promise(r => setTimeout(r, 200));

        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sId,
                    maxWidth: 4000,
                    maxHeight: 4000
                }
            }
        });

        const types = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];
        const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

        // Set in Settings > Screenshot & Record. Lower bitrates make the base64
        // handoff to the editor meaningfully faster for long recordings.
        const BITRATE_BY_QUALITY = { low: 1500000, medium: 3000000, high: 5000000, ultra: 8000000 };
        const { videoQuality } = await chrome.storage.local.get(['videoQuality']);
        const videoBitsPerSecond = BITRATE_BY_QUALITY[videoQuality] || BITRATE_BY_QUALITY.high;

        recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond
        });

        data = [];

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                data.push(e.data);
            }
        };

        recorder.onstop = () => {
            console.log('Offscreen: Recorder stopped, data chunks:', data.length);
            if (data.length > 0) {
                const blob = new Blob(data, { type: mimeType });
                const reader = new FileReader();
                reader.onload = () => {
                    chrome.runtime.sendMessage({
                        type: 'recording-stopped',
                        target: 'background',
                        videoDataUrl: reader.result
                    }).catch(e => console.error('Offscreen: Failed to send recording-stopped:', e));
                };
                reader.readAsDataURL(blob);
            } else {
                console.warn('Offscreen: No data recorded');
                chrome.runtime.sendMessage({
                    type: 'recording-error',
                    target: 'background',
                    error: 'No data recorded'
                });
            }

            if (stream) stream.getTracks().forEach(t => t.stop());
            recorder = null;
            stream = null;
        };

        // Collect data more frequently to avoid empty data on short recordings
        recorder.start(500);

        chrome.runtime.sendMessage({
            type: 'recording-started',
            target: 'background'
        }).catch(() => { });

    } catch (err) {
        console.error('Offscreen execution error:', err);
        chrome.runtime.sendMessage({
            type: 'recording-error',
            target: 'background',
            error: err.name + ': ' + err.message
        }).catch(() => { });
    }
}

function stopRecording() {
    if (recorder && recorder.state === 'recording') {
        recorder.stop();
    }
}

// Capture Screenshot from Stream
async function captureScreenshot(streamId) {
    try {
        await new Promise(r => setTimeout(r, 200));

        const captureStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: streamId
                }
            }
        });

        // Create video element to capture frame
        const video = document.createElement('video');
        video.srcObject = captureStream;
        video.autoplay = true;

        // Wait for video to be ready
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });

        // Wait a bit more for the first frame
        await new Promise(r => setTimeout(r, 500));

        // Create canvas and capture frame
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert to data URL
        const imageDataUrl = canvas.toDataURL('image/png');

        // Stop the stream
        captureStream.getTracks().forEach(track => track.stop());

        // Send back to background
        chrome.runtime.sendMessage({
            type: 'screenshot-captured',
            target: 'background',
            imageDataUrl: imageDataUrl
        }).catch(() => { });

    } catch (err) {
        console.error('Screenshot capture error:', err);
        chrome.runtime.sendMessage({
            type: 'screenshot-error',
            target: 'background',
            error: err.name + ': ' + err.message
        }).catch(() => { });
    }
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function stitchFullPage(data) {
    const { screenshots, totalHeight, pageWidth, viewportHeight, contextDataUrl, elementX, elementY } = data;
    console.log('Offscreen: Stitching', screenshots.length, 'screenshots');

    try {
        const canvas = document.createElement('canvas');
        canvas.width = pageWidth;
        canvas.height = totalHeight;
        const ctx = canvas.getContext('2d');

        let maxYReached = 0;

        for (let i = 0; i < screenshots.length; i++) {
            const screenshot = screenshots[i];
            const img = await loadImage(screenshot.dataUrl);
            const scrollY = screenshot.scrollY;

            if (i === 0) {
                // First slice: Draw everything
                ctx.drawImage(img, 0, 0);
                maxYReached = viewportHeight;
            } else {
                // Subsequent slices: Only draw the "new" pixels to avoid overwriting
                // fixed elements (like sidebar/header) that were hidden in this slice.
                if (scrollY + viewportHeight > maxYReached) {
                    const newPixelsHeight = (scrollY + viewportHeight) - maxYReached;
                    const sourceY = viewportHeight - newPixelsHeight;

                    // Draw only the bottom portion that hasn't been covered yet
                    ctx.drawImage(
                        img,
                        0, sourceY, pageWidth, newPixelsHeight, // Source rect
                        0, maxYReached, pageWidth, newPixelsHeight // Dest rect
                    );

                    maxYReached = scrollY + viewportHeight;
                }
            }
        }

        let fullImageDataUrl;

        if (contextDataUrl) {
            // A modal capture: `canvas` above is the modal's OWN full content,
            // stitched in isolation. Paste it onto a plain screenshot of the
            // page exactly as it looked (sidebar, nav, dimmed backdrop) at the
            // spot the modal actually sits, growing the canvas downward if the
            // modal's full content is taller than what fit in that one shot.
            const contextImg = await loadImage(contextDataUrl);
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = Math.max(contextImg.naturalWidth, elementX + pageWidth);
            finalCanvas.height = Math.max(contextImg.naturalHeight, elementY + totalHeight);
            const fctx = finalCanvas.getContext('2d');
            fctx.drawImage(contextImg, 0, 0);
            fctx.drawImage(canvas, elementX, elementY);
            fullImageDataUrl = finalCanvas.toDataURL('image/png');
        } else {
            fullImageDataUrl = canvas.toDataURL('image/png');
        }

        console.log('Offscreen: Stitching complete');

        chrome.runtime.sendMessage({
            type: 'screenshot-captured',
            target: 'background',
            imageDataUrl: fullImageDataUrl
        }).catch(() => { });

    } catch (err) {
        console.error('Offscreen: Stitching error:', err);
        chrome.runtime.sendMessage({
            type: 'screenshot-error',
            target: 'background',
            error: 'Stitching failed: ' + err.message
        }).catch(() => { });
    }
}


