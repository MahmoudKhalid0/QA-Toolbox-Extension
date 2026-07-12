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
                // Container type only - a codecs= list can contain a comma, which
                // is what separates type from payload in a data: URL and would
                // silently truncate the file. See entire-screen-page.js.
                const blob = new Blob(data, { type: 'video/webm' });
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
    const { screenshots, totalHeight, pageWidth, viewportHeight, viewportWidth, contextDataUrl, elementX, elementY } = data;
    console.log('Offscreen: Stitching', screenshots.length, 'screenshots');

    try {
        const canvas = document.createElement('canvas');
        canvas.width = pageWidth;
        canvas.height = totalHeight;
        const ctx = canvas.getContext('2d');
        // totalHeight is an estimate (document.scrollHeight at the start) and
        // can end up a little taller than what the slices actually cover -
        // an unpainted canvas region is transparent, which renders as a flat
        // black bar once exported to PNG. Filling white first means any such
        // gap just blends into the page instead of showing as a black stripe.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // A page wider than one viewport was captured as several horizontal
        // tiles (full-page.js), each carrying its own scrollX. Group by that
        // first - a normal page (the common case) is just one column at
        // scrollX 0, and behaves exactly as the single-column stitch always did.
        const columns = new Map();
        for (const s of screenshots) {
            const key = s.scrollX || 0;
            if (!columns.has(key)) columns.set(key, []);
            columns.get(key).push(s);
        }
        const colWidth = viewportWidth || pageWidth;
        const sortedX = [...columns.keys()].sort((a, b) => a - b);

        let maxXReached = 0;
        for (let ci = 0; ci < sortedX.length; ci++) {
            const scrollX = sortedX[ci];
            const colShots = columns.get(scrollX);

            // Stitch this column's own rows in isolation first - identical
            // top-to-bottom dedup logic the single-column case always used.
            const colCanvas = document.createElement('canvas');
            colCanvas.width = colWidth;
            colCanvas.height = totalHeight;
            const colCtx = colCanvas.getContext('2d');
            colCtx.fillStyle = '#ffffff';
            colCtx.fillRect(0, 0, colCanvas.width, colCanvas.height);

            let maxYReached = 0;
            for (let i = 0; i < colShots.length; i++) {
                const img = await loadImage(colShots[i].dataUrl);
                const scrollY = colShots[i].scrollY;

                if (i === 0) {
                    // First slice: Draw everything
                    colCtx.drawImage(img, 0, 0);
                    maxYReached = viewportHeight;
                } else if (scrollY + viewportHeight > maxYReached) {
                    // Subsequent slices: Only draw the "new" pixels to avoid overwriting
                    // fixed elements (like sidebar/header) that were hidden in this slice.
                    const newPixelsHeight = (scrollY + viewportHeight) - maxYReached;
                    const sourceY = viewportHeight - newPixelsHeight;
                    colCtx.drawImage(
                        img,
                        0, sourceY, colWidth, newPixelsHeight,
                        0, maxYReached, colWidth, newPixelsHeight
                    );
                    maxYReached = scrollY + viewportHeight;
                }
            }

            // Composite this finished column onto the full page canvas - the
            // last column is clamped to the page's right edge and can overlap
            // the one before it, same reasoning as the row overlap above, so
            // only pixels further right than what's already been drawn count.
            if (ci === 0) {
                ctx.drawImage(colCanvas, scrollX, 0);
                maxXReached = scrollX + colWidth;
            } else if (scrollX + colWidth > maxXReached) {
                const newPixelsWidth = (scrollX + colWidth) - maxXReached;
                const sourceX = colWidth - newPixelsWidth;
                ctx.drawImage(
                    colCanvas,
                    sourceX, 0, newPixelsWidth, totalHeight,
                    maxXReached, 0, newPixelsWidth, totalHeight
                );
                maxXReached = scrollX + colWidth;
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
            fctx.fillStyle = '#ffffff';
            fctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
            fctx.drawImage(contextImg, 0, 0);

            // The context screenshot is only ever one viewport tall - if the
            // modal's full content runs past that, there is no real page
            // content for the rest. Stretching the context image's own last
            // row down to fill the gap keeps the sidebar/dimmed-backdrop look
            // going the whole way, instead of cutting to flat white beside
            // the modal (which is what happened before this).
            if (finalCanvas.height > contextImg.naturalHeight) {
                const extendHeight = finalCanvas.height - contextImg.naturalHeight;
                fctx.drawImage(
                    contextImg,
                    0, contextImg.naturalHeight - 1, contextImg.naturalWidth, 1,
                    0, contextImg.naturalHeight, contextImg.naturalWidth, extendHeight
                );
            }

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


