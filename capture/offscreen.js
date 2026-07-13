// The recorder. This document has no window and no taskbar entry, which is the
// whole point of it: the screen picker is raised by the service worker straight
// over the user's own tab, so there is no extension window between them and it -
// no frame around the picker, and nothing extra in the taskbar. (The old path
// opened a real 710x540 popup window just to host the picker, and then had to
// minimise itself so it wouldn't appear in its own screenshot.)
let recorder = null;
let data = [];
let stream = null;
let micStream = null;
let discarding = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    // createDocument() resolves before this script has necessarily run, so the
    // worker pings until this answers. Without it the very first start-recording
    // was landing on a document with no listener yet and simply vanishing.
    if (message.type === 'ping') { sendResponse({ ready: true }); return true; }

    if (message.type === 'start-recording') {
        startRecording(message);
        sendResponse({ success: true });
        return true;
    }
    if (message.type === 'stop-recording') { stopRecording(false); sendResponse({ success: true }); return true; }
    if (message.type === 'discard-recording') { stopRecording(true); sendResponse({ success: true }); return true; }
    if (message.type === 'pause-recording') { pauseRecording(); sendResponse({ success: true }); return true; }
    if (message.type === 'resume-recording') { resumeRecording(); sendResponse({ success: true }); return true; }
    if (message.type === 'toggle-mic') { toggleMic(); sendResponse({ success: true }); return true; }

    if (message.type === 'capture-screen') {
        captureScreenshot();
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

// An offscreen document does NOT get chrome.storage - reaching for it here threw
// "Cannot read properties of undefined (reading 'local')" and killed the start
// before it had begun. Everything this document knows is passed in with the
// message, and everything it needs recorded is reported back to the worker.
function reportState(state) {
    chrome.runtime.sendMessage(Object.assign({ type: 'recorder-state', target: 'background' }, state))
        .catch(() => { });
}

// How loudly the user is actually speaking, so the mic button in the control bar
// can react instead of just sitting there. The stream only exists here, so the
// level is measured here and sent on - ten times a second, which is enough for the
// eye and cheap enough not to matter next to encoding video.
let micMeter = null;

function startMicMeter() {
    stopMicMeter();
    if (!micStream) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    const timer = setInterval(() => {
        const track = micStream && micStream.getAudioTracks()[0];
        // Muted, or paused: nothing is being recorded, so show nothing. A meter
        // twitching away while the take is paused would be a lie.
        if (!track || !track.enabled || !recorder || recorder.state !== 'recording') {
            sendMicLevel(0);
            return;
        }
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;      // -1..1 around silence
            sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        sendMicLevel(Math.min(1, rms * 5));      // speech sits low in RMS; lift it to something visible
    }, 100);

    micMeter = { ctx, timer };
}

function stopMicMeter() {
    if (!micMeter) return;
    clearInterval(micMeter.timer);
    micMeter.ctx.close().catch(() => { });
    micMeter = null;
    sendMicLevel(0);
}

function sendMicLevel(level) {
    chrome.runtime.sendMessage({
        type: 'mic-level', target: 'background', level: Math.round(level * 100) / 100
    }).catch(() => { });
}

async function startRecording({ micEnabled, countdownMs = 0, countdownTabId = null, videoBitsPerSecond = 5000000 }) {
    try {
        discarding = false;

        // THIS document asks Chrome for the screen. Not the service worker: from a
        // worker, chooseDesktopMedia demands a target tab, and the stream it then
        // returns is bound to that tab's renderer - handing it here got a flat
        // "AbortError: Error starting tab capture" every time, whatever the source.
        //
        // Asking with getDisplayMedia from the document that will actually consume
        // the stream is what every other recorder does, and it is what gives us all
        // three of the things we were missing: Chrome's own picker with nothing of
        // ours framing it, no window and so no taskbar entry, and the "Also share
        // system audio" toggle - which only appears because audio is asked for here.
        stream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,                        // -> Chrome offers to share the audio too
            systemAudio: 'include',             // ...and offers the SYSTEM's audio, not just a tab's
            // Opens the picker already on "Entire Screen" rather than "Chrome Tab".
            // It is a preference, not a lock: the user can still pick a tab or a
            // window. Note this is a getDisplayMedia hint - a width/height/frameRate
            // set here would be a precondition, and the request would just be refused.
            video: { displaySurface: 'monitor' }
        });

        // The cap goes on afterwards, on the track itself, where it is a request and
        // not a precondition. Uncapped, the display hands over frames as fast as it
        // makes them - up to 60/s - and every one has to be encoded; 30 is plenty
        // for showing a bug and roughly halves the encoder's work, which is most of
        // what made recording feel heavy.
        try {
            await stream.getVideoTracks()[0].applyConstraints({
                frameRate: { max: 30 }, width: { max: 1920 }, height: { max: 1080 }
            });
        } catch (e) {
            console.warn('Offscreen: could not cap the frame rate, recording as-is:', e);
        }

        const systemAudio = stream.getAudioTracks().length > 0;   // only if they ticked it

        // The user's voice, if they armed the mic. An offscreen document cannot
        // raise a permission prompt (it has no UI), so the popup asks for it when
        // the switch is turned on; here we only use a permission already given.
        micStream = null;
        if (micEnabled) {
            try {
                micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                micStream.getAudioTracks().forEach(t => stream.addTrack(t));
            } catch (e) {
                console.warn('Offscreen: microphone unavailable, recording without it:', e);
            }
        }
        reportState({ micActive: !!micStream, micMuted: false, systemAudioOn: !!systemAudio });

        // VP8 first, NOT VP9: VP9's encoder is software-only and far slower, and it
        // was being picked every time - that is what ate the CPU while recording.
        const types = ['video/webm;codecs=vp8', 'video/webm', 'video/webm;codecs=vp9'];
        const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
        data = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) data.push(e.data); };
        recorder.onstop = onRecorderStopped;

        // Stopping the capture from Chrome's own "Stop sharing" bar has to end the
        // recording too, or it would run on against a dead track and save nothing.
        stream.getVideoTracks()[0].addEventListener('ended', () => stopRecording(false));

        // Count the user in only now: until the picker was answered it was still on
        // screen, and a countdown behind it would have been counting down nothing.
        if (countdownMs > 0) {
            chrome.runtime.sendMessage({
                type: 'show-countdown', target: 'background',
                tabId: countdownTabId, seconds: Math.round(countdownMs / 1000)
            }).catch(() => { });
            await new Promise(r => setTimeout(r, countdownMs));
        }
        if (!recorder) return;                 // stopped while we were counting

        recorder.start(1000);   // flush a chunk a second instead of one huge buffer
        startMicMeter();        // the mic button now reacts to the voice going in

        chrome.runtime.sendMessage({ type: 'recording-started', target: 'background' }).catch(() => { });
    } catch (err) {
        releaseTracks();
        // Always say what happened, even when we then choose to stay quiet about it:
        // treating every NotAllowedError as "the user cancelled" is what hid a
        // rejected constraint set and made the recording look like it just never ran.
        console.error('Offscreen: could not start recording:', err);
        // Dismissing the picker is a choice, not a fault - leave no half-started
        // recording behind and do not nag about it.
        if (err && err.name === 'NotAllowedError') {
            chrome.runtime.sendMessage({ type: 'recording-cancelled', target: 'background' }).catch(() => { });
            return;
        }
        chrome.runtime.sendMessage({
            type: 'recording-error', target: 'background',
            error: err.name + ': ' + err.message
        }).catch(() => { });
    }
}

function onRecorderStopped() {
    const chunks = data;
    data = [];
    releaseTracks();
    reportState({ micActive: false, micMuted: false });

    if (discarding) {                       // thrown away on purpose: save nothing
        discarding = false;
        return;
    }
    if (!chunks.length) {
        chrome.runtime.sendMessage({
            type: 'recording-error', target: 'background', error: 'No data recorded'
        }).catch(() => { });
        return;
    }

    // Container type only, NOT recorder.mimeType: with an audio track that reads
    // video/webm;codecs="vp8,opus", and a comma there is fatal to anything that
    // parses it as a data: URL.
    const blob = new Blob(chunks, { type: 'video/webm' });

    // The Blob goes to the editor through IndexedDB, and only its id travels in a
    // message. It used to be re-encoded into a base64 string a third larger again,
    // pushed through a message, written into chrome.storage.local and parsed back
    // out - tens of megabytes copied four times over before a single frame could be
    // shown. That was the whole of the wait after pressing Stop.
    const captureId = Date.now().toString();
    CapStore.putPending(captureId, blob)
        .then(() => chrome.runtime.sendMessage({
            type: 'recording-stopped', target: 'background', captureId
        }).catch(() => { }))
        .catch((err) => chrome.runtime.sendMessage({
            type: 'recording-error', target: 'background',
            error: 'Could not store the recording: ' + ((err && err.message) || err)
        }).catch(() => { }));
}

function releaseTracks() {
    stopMicMeter();
    // Release the mic too, or Chrome keeps showing the "in use" indicator long
    // after the recording is over.
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    stream = null;
    micStream = null;
    recorder = null;
}

function stopRecording(discard) {
    discarding = !!discard;
    if (recorder && (recorder.state === 'recording' || recorder.state === 'paused')) {
        recorder.stop();                      // onstop does the rest
    } else {
        releaseTracks();
    }
}

function pauseRecording() {
    if (recorder && recorder.state === 'recording') recorder.pause();
}

function resumeRecording() {
    if (recorder && recorder.state === 'paused') recorder.resume();
}

// Muting is switching the live track off. The track stays in the recording, so
// the webm keeps one continuous audio stream that simply goes silent - nothing is
// re-encoded and the timeline never shifts.
function toggleMic() {
    if (!micStream) return;
    const track = micStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    reportState({ micMuted: !track.enabled });
}

// One frame of the screen. Same reasoning as the recorder: this document asks for
// the screen itself, so there is no window of ours to appear in the very shot it
// is taking (the old path opened a 710x540 window and then had to minimise it).
async function captureScreenshot() {
    try {
        const captureStream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: { displaySurface: 'monitor' }   // opens on "Entire Screen"
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
            mode: 'screen',              // a shot of the SCREEN - the real browser
            imageDataUrl: imageDataUrl   // chrome is already in the picture
        }).catch(() => { });

    } catch (err) {
        // Dismissing the picker is a choice, not a fault.
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
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
            mode: 'fullpage',            // stitched page - NOT a shot of the screen
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


