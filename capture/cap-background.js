// Capture & report module - ported from the standalone screenshot extension.
// Loaded into the main service worker via importScripts; registers its own
// onMessage listener, so the main dispatcher stays untouched.

let isRecordingInProgress = false;
let currentRecordingTabId = null;
let isCountdownInProgress = false;

// Sync state on startup/restart
chrome.storage.local.get(['isRecordingInProgress', 'isCountdownInProgress'], (result) => {
  isRecordingInProgress = !!result.isRecordingInProgress;
  isCountdownInProgress = !!result.isCountdownInProgress;
  if (isRecordingInProgress) {
    startBadgeTimer();
  }
});


// captureVisibleTab paints black when the side panel holds focus: the browser
// hasn't repainted the tab yet. Focusing the tab's window and yielding a frame
// fixes it. (The original extension never hit this - its popup closed first.)
// <all_urls> does NOT cover chrome:// pages. There Chrome falls back to
// activeTab, which the side panel never activates - hence
// "activeTab permission is not in effect". Nothing can photograph those pages.
const CAP_RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|moz-extension):|^https:\/\/chrome\.google\.com\/webstore/i;

function capNotify(text, color) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

// A side panel takes its width out of the page. Photograph the tab while it is
// still open and you get a page squeezed into what is left - a shot cut off down
// one side, and a full-page capture that measured the wrong width entirely. So
// every capture closes the panel FIRST, then waits for the page to reflow to its
// real width before taking anything.
//
// The wait has to happen here, in the worker: the panel's own script dies the
// instant it closes, so it cannot time anything after that.
const CAP_PANEL_SETTLE_MS = 500;

// Only the captures that photograph the TAB come through here. Screen and Record
// take the screen instead, so the panel's width was never part of their picture.
function capPerform(tab, act) {
    if (act === 'capture') captureScreenshot();
    else if (act === 'delayed') handleDelayedCapture();
    else if (act === 'area') chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/area-selection.js'] });
    else if (act === 'full') chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/full-page.js'] });
}

function capStartAfterPanelCloses(tab, act) {
    chrome.runtime.sendMessage({ action: 'capClosePanel' }).catch(() => { });
    setTimeout(() => capPerform(tab, act), CAP_PANEL_SETTLE_MS);
}

function capSafeCaptureVisible(tab, cb) {
    const restricted = tab.url && CAP_RESTRICTED.test(tab.url);

    const done = (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
            const msg = (chrome.runtime.lastError || {}).message || 'no image returned';
            console.error('capture failed:', msg);
            // Chrome only lets an extension photograph its OWN pages (a new tab, the
            // settings) under the activeTab grant, and activeTab is only granted when
            // the extension is "invoked" - a toolbar click that opens a popup, a
            // keyboard shortcut, a context-menu item. A click inside a side panel is
            // none of those, which is the whole of why this fails here.
            capNotify('!', '#ef4444');
            chrome.runtime.sendMessage({
                action: 'capCaptureFailed',
                restricted,
                message: restricted
                    ? 'Chrome blocks this page from the panel. Press Alt+Shift+S, or right-click the page → QA Toolkit.'
                    : 'Capture failed: ' + msg
            }).catch(() => { });
            cb(null);
            return;
        }
        cb(dataUrl);
    };

    // The side panel holds focus, so the tab may not have repainted yet and the
    // shot comes back black. One frame of slack is enough; do NOT re-focus the
    // window - that races with the capture and drops the permission context.
    setTimeout(() => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, done), 180);
}

// Everything a developer asks for after "it's broken": the errors, the failed
// calls and the environment. Pulled from the stores the Debug tab already fills.
function capCollectContext(tab) {
    const logs = (typeof consoleLogs !== 'undefined' && consoleLogs.get(tab.id)) || [];
    const reqs = (typeof networkReqs !== 'undefined' && networkReqs.get(tab.id)) || [];
    const ua = navigator.userAgent;
    const brand = ((navigator.userAgentData && navigator.userAgentData.brands) || [])
        .filter(b => !/Not.?A.?Brand/i.test(b.brand)).map(b => `${b.brand} ${b.version}`).join(', ');
    return {
        url: tab.url || '',
        title: tab.title || '',
        capturedAt: new Date().toISOString(),
        browser: brand || ua,
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        userAgent: ua,
        viewport: '',                        // filled in by capAttachViewport
        // Everything the page logged, not just errors: a warning right before
        // the bug is often the whole story.
        console: logs.slice(-120),
        consoleErrors: logs.filter(l => l.level === 'error').slice(-40),
        requests: reqs.slice(-80),
        failedRequests: reqs.filter(r => r.status === 0 || r.status >= 400).slice(-40)
    };
}

// A Tab has no width/height. Ask the page - and shrug on chrome:// pages.
function capAttachViewport(tab, ctx) {
    return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`
    }).then(r => {
        if (r && r[0] && r[0].result) ctx.viewport = r[0].result;
        return ctx;
    }).catch(() => ctx);
}

// The editor belongs beside the page it came from. chrome.tabs.create with no
// index drops it at the END of the strip - with a dozen tabs open, the shot you
// just took lands somewhere far to the right and you have to go and find it.
function capEditorTabProps(tab, path) {
    const props = { url: chrome.runtime.getURL(path) };
    if (tab && typeof tab.index === 'number') {
        props.index = tab.index + 1;      // immediately to the right of it
        props.windowId = tab.windowId;    // and in the same window, not wherever is focused
        if (typeof tab.id === 'number') props.openerTabId = tab.id;
    }
    return props;
}

function capOpenEditor(tab, dataUrl, extra) {
    if (!dataUrl) return;
    const captureId = Date.now().toString();
    const ctx = capCollectContext(tab);
    const payload = Object.assign({
        [captureId]: dataUrl,
        isVideo: false,
        [`ctx_${captureId}`]: ctx
    }, extra || {});

    chrome.storage.local.set(payload, () => {
        chrome.tabs.create(capEditorTabProps(tab,
            `capture/editor.html?id=${captureId}&title=${encodeURIComponent(tab.title || 'screenshot')}` + ((extra && extra.cropArea) ? '&crop=true' : '')));
    });

    // The gallery only ever holds what has been shared to Drive - see the
    // editor's cloud button. A capture that is never shared must never appear
    // here, so nothing is written to CapStore at capture time.
    capAttachViewport(tab, ctx).catch(e => console.error('viewport attach failed:', e));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "updateCountdownState") {
    isCountdownInProgress = request.active;
    chrome.storage.local.set({
      isCountdownInProgress: request.active,
      countdownRemaining: request.seconds || 0
    });

    if (request.active && request.seconds > 0) {
      chrome.action.setBadgeText({ text: request.seconds.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
    } else if (!request.active && !isRecordingInProgress) {
      chrome.action.setBadgeText({ text: '' });
    }
    return;
  }

  // The floating eye speaks the same language as the side-panel card
  if (request.action === "capEyeAction") {
    const tab = sender.tab;
    if (!tab) return false;
    const act = request.act;

    // Live controls first - they are not captures and must be instant.
    // Same direct-call rule as Stop: these run IN the worker, so they must not be
    // routed through a message to it (a worker never hears its own messages).
    if (act === 'pause') {
      chrome.storage.local.get(['recordingPaused'], (r) => capSetPaused(!r.recordingPaused));
      return false;
    }
    if (act === 'discard') { capDiscardRecording(); return false; }
    if (act === 'record' && isRecordingInProgress) { capStopRecording(); return false; }

    // Screen and Record photograph the SCREEN, not the tab - the panel's width
    // never entered into what they capture, and Chrome's picker gives it time to
    // close anyway. They start at once; only the tab-based captures wait.
    if (act === 'screen' || act === 'record') {
      chrome.runtime.sendMessage({ action: 'capClosePanel' }).catch(() => { });
      capChooseAndCapture(tab, act === 'record' ? 'record' : 'screenshot');
      return false;
    }

    capStartAfterPanelCloses(tab, act);
    return false;
  }

  // The panel's own capture buttons. It sends this and shuts itself; the worker
  // does the waiting, because the panel's script stops the moment it closes.
  if (request.action === "capPanelAction") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab) capStartAfterPanelCloses(tab, request.act);
    });
    return true;
  }

  if (request.action === "capEyeSetting") {
    chrome.storage.local.set({ capEyeEnabled: !!request.enabled }, () => {
      if (!request.enabled) capRemoveEyeEverywhere();
      else capInjectEyeEverywhere();
      // The eye is also toggled from its own floating menu, not just Settings.
      // Push from here and both routes are covered.
      if (typeof CloudSync !== 'undefined') CloudSync.syncSchedulePush();
    });
    return false;
  }

  // The editor patches its record after the user annotates and saves.
  if (request.action === "capLibrarySave") {
    (async () => {
      try {
        const blob = await CapStore.dataUrlToBlob(request.dataUrl);
        // Images get theirs generated from the blob itself (see capMakeThumb);
        // a video blob can't be decoded that way, so the editor grabs a real
        // frame from the <video> it already has loaded and sends it along.
        const thumb = request.thumbDataUrl ? await CapStore.dataUrlToBlob(request.thumbDataUrl) : undefined;
        const patch = { blob, title: request.title || undefined };
        if (thumb) patch.thumb = thumb;
        const patched = await CapStore.patch(request.id, patch);
        if (!patched) {
          await CapStore.save({ id: request.id, type: request.type || 'image', title: request.title || 'Capture', blob, thumb, ctx: request.ctx || null });
        }

        // The editor reopens from storage.local, not from the library, so every
        // annotation was lost the moment the tab closed. Drive is never touched
        // here: that is the cloud button's job, not the download's.
        await chrome.storage.local.set({ [request.id]: request.dataUrl });

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

  if (request.action === "capture") {
    captureScreenshot(sendResponse);
    return true;
  }

  if (request.action === "delayedCapture") {
    handleDelayedCapture(sendResponse);
    return true;
  }

  if (request.action === "triggerCountdownInTab") {
    const tabId = request.targetTabId;
    if (tabId) {
      chrome.tabs.get(tabId, async (tab) => {
        const tabTitle = tab?.title || "recording";
        chrome.storage.local.set({
          tempTabTitle: tabTitle,
          tempTabId: tabId
        });

        // Ensure content script is ready
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['capture/cap-content.js']
          });
          chrome.tabs.sendMessage(tabId, { action: 'showCountdown', seconds: 3 });
        } catch (e) {
          console.error('Failed to inject/send countdown:', e);
        }
      });
    }
    return true;
  }

  if (request.action === "notifyRecordingStartedInTab") {
    const tabId = request.targetTabId;
    isRecordingInProgress = true;
    currentRecordingTabId = tabId;
    chrome.storage.local.set({ isRecordingInProgress: true });
    if (tabId) {
      startBadgeTimer();
      chrome.tabs.sendMessage(tabId, { action: 'startRecordingInTab' }).catch(() => {
        chrome.scripting.executeScript({ target: { tabId }, files: ['capture/cap-content.js'] }).then(() => {
          chrome.tabs.sendMessage(tabId, { action: 'startRecordingInTab' });
        });
      });
    }
    return true;
  }

  if (request.action === "requestStopRecording") {
    capStopRecording();
    return true;
  }

  // Pause/resume: recording is still in progress, so the floating control stays
  // up - it just switches its own button/timer state. Pause can be hit from the
  // in-page bar OR the popup, and each used to keep its own private idea of
  // whether it was paused: pausing from one left the other still counting up and
  // still saying "Recording", which read as "pause did nothing". The flag is
  // written here, where every UI can see it, so all of them agree.
  if (request.action === "requestPauseRecording") {
    capSetPaused(true);
    return true;
  }

  if (request.action === "requestResumeRecording") {
    capSetPaused(false);
    return true;
  }

  if (request.action === "requestDiscardRecording") {
    capDiscardRecording();
    return true;
  }

  // Mute/unmute the narration while the recording runs. The control bar lives in
  // the page; the recorder lives in the capture window - this is the bridge.
  if (request.action === "requestToggleMic") {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'toggle-mic' });
    return true;
  }

  // The popup's Screen / Record buttons. The picker has to be raised from HERE,
  // with the target tab, so Chrome shows it over the page instead of inside a
  // window of ours (the popup itself closes the moment it loses focus, so it
  // cannot host the picker either).
  if (request.action === "capStartCapture") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) return;
      if (request.mode === 'record') {
        chrome.storage.local.get(['isRecordingInProgress'], (r) => {
          if (r.isRecordingInProgress) { capStopRecording(); return; }
          capChooseAndCapture(tab, 'record');
        });
      } else {
        capChooseAndCapture(tab, 'screenshot');
      }
    });
    return true;
  }

  // The recorder cannot write to chrome.storage (an offscreen document has no
  // access to it), so it reports its state and this writes it - which is where
  // the control bar and the popup read the mic's state from.
  if (request.type === 'recorder-state' && request.target === 'background') {
    const patch = {};
    if ('micActive' in request) patch.micActive = request.micActive;
    if ('micMuted' in request) patch.micMuted = request.micMuted;
    if ('systemAudioOn' in request) patch.systemAudioOn = request.systemAudioOn;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
    return true;
  }

  // How loud the narration is right now. Straight through to the tab holding the
  // control bar - never into storage: this arrives ten times a second, and storage
  // writes at that rate would be both wasteful and heard by every listener there is.
  if (request.type === 'mic-level' && request.target === 'background') {
    if (currentRecordingTabId != null) {
      chrome.tabs.sendMessage(currentRecordingTabId, { action: 'micLevel', level: request.level })
        .catch(() => { /* the tab was closed or navigated away */ });
    }
    return true;
  }

  // The picker has been answered and the stream is open: count the user in.
  if (request.type === 'show-countdown' && request.target === 'background') {
    capShowCountdown(request.tabId, request.seconds);
    return true;
  }

  // The picker was dismissed. Nothing was ever started, so there is nothing to
  // tear down - and nothing to tell the user off about either.
  if (request.type === 'recording-cancelled' && request.target === 'background') {
    chrome.storage.local.remove(['tempTabTitle', 'tempTabId']);
    return true;
  }

  // The offscreen recorder is rolling.
  if (request.type === 'recording-started' && request.target === 'background') {
    capOnRecordingStarted();
    return true;
  }

  // ...and it has finished: the Blob is already in IndexedDB, only the id travels.
  if (request.type === 'recording-stopped' && request.target === 'background') {
    handleRecordingFinished(request.captureId);
    return true;
  }

  if (request.type === 'recording-error' && request.target === 'background') {
    console.error('Background: Recording error:', request.error);
    chrome.storage.local.get(['tempTabId'], (result) => {
      if (result.tempTabId) {
        chrome.tabs.sendMessage(result.tempTabId, {
          action: 'recordingError',
          error: request.error
        }).catch(() => { });
        chrome.storage.local.remove(['tempTabTitle', 'tempTabId']);
      }
    });
    return true;
  }

  // Handle screenshot from offscreen document or capture page
  if (request.type === 'screenshot-captured' && request.target === 'background') {
    handleScreenshotCaptured(request.imageDataUrl);
    return true;
  }

  if (request.action === "areaSelected") {
    handleAreaCapture(request.selection);
    return true;
  }

  if (request.action === "captureViewport") {
    const wid = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(wid, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) { sendResponse({ dataUrl: null, error: chrome.runtime.lastError.message }); return; }
      sendResponse({ dataUrl });
    });
    return true;
  }

  if (request.action === "fullPageComplete") {
    handleFullPageComplete(request);
    sendResponse({ success: true });
    return true;
  }

  return false;
});

function handleFullPageComplete(data) {
  // Use offscreen to stitch
  setupOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'stitch-full-page',
      data: data
    });
  });
}

// Area Capture and Cropping Logic
function handleAreaCapture(selection) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    // the editor does the cropping - a service worker has no canvas
    capSafeCaptureVisible(tabs[0], (dataUrl) => {
      capOpenEditor(tabs[0], dataUrl, { cropArea: selection });
    });
  });
}

// Screenshots
function captureScreenshot(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    capSafeCaptureVisible(tabs[0], (dataUrl) => {
      capOpenEditor(tabs[0], dataUrl);
      if (typeof sendResponse === 'function') sendResponse({ success: !!dataUrl });
    });
  });
}

function handleDelayedCapture(sendResponse) {
  chrome.storage.sync.get(['delaySeconds'], (result) => {
    const delaySeconds = Math.min(10, Math.max(1, parseInt(result.delaySeconds, 10) || 3));
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tab = tabs[0];

      const armTimer = () => {
        isCountdownInProgress = true;
        chrome.storage.local.set({ isCountdownInProgress: true, countdownRemaining: delaySeconds });
        setTimeout(() => {
          isCountdownInProgress = false;
          chrome.storage.local.set({ isCountdownInProgress: false });
          chrome.action.setBadgeText({ text: '' });
          captureScreenshot(sendResponse);
        }, (delaySeconds * 1000) + 500);
      };

      // The on-page countdown is a nicety. It cannot be injected into
      // chrome:// pages, and that must not stop the capture itself - fall back
      // to counting down on the toolbar badge.
      const badgeCountdown = () => {
        let left = delaySeconds;
        const tick = () => {
          chrome.action.setBadgeText({ text: String(left) });
          chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
          if (--left >= 0) setTimeout(tick, 1000);
        };
        tick();
      };

      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/cap-content.js'] })
        .then(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'showCountdown', seconds: delaySeconds }).catch(badgeCountdown);
          armTimer();
        })
        .catch(() => { badgeCountdown(); armTimer(); });
    });
  });
}

// Video Recording Logic
// The recorder has already put the Blob in IndexedDB and sends only its id, so
// nothing large travels through here any more. This used to receive the whole
// recording as a base64 string and write it into chrome.storage.local, which is
// what made Stop feel like it hung: a long take was tens of megabytes being
// re-encoded, serialised and written before the editor could open.
async function handleRecordingFinished(captureId) {
  if (!captureId) return;
  isRecordingInProgress = false;
  chrome.storage.local.set({ isRecordingInProgress: false, recordingPaused: false });

  chrome.storage.local.get(['tempTabTitle', 'tempTabId'], (result) => {
    const tabTitle = result.tempTabTitle || "recording";
    const tabId = result.tempTabId;
    broadcastHideControl();
    stopBadgeTimer();

    // The gallery only ever holds what has been shared to Drive - see the
    // editor's cloud button. A recording that is never shared must never
    // appear here, same rule already applied to screenshots - so nothing is
    // written to the library at capture time. ctx is still stored for the
    // editor to pick up later (context drawer, and the eventual Share/Save).
    // `srcTab` is the tab that was being recorded, so the editor opens right beside
    // it. It can be null (the tab was closed mid-recording) - then Chrome's default
    // placement is all we have.
    const openEditor = (ctx, srcTab) => {
      chrome.storage.local.set({ [`ctx_${captureId}`]: ctx || null }, () => {
        chrome.tabs.create(capEditorTabProps(srcTab,
          `capture/editor.html?id=${captureId}&title=${encodeURIComponent(tabTitle)}&type=video`));
        chrome.action.setBadgeText({ text: '' });
        chrome.storage.local.remove(['tempTabTitle', 'tempTabId', 'recordingStartTime']);
      });
    };

    if (tabId) chrome.tabs.get(tabId, (t) => {
      void chrome.runtime.lastError;                 // the tab may be gone by now
      openEditor(t ? capCollectContext(t) : null, t || null);
    });
    else openEditor(null, null);
  });
}

// Stop-and-save. Kept as a function rather than a message because the service
// worker itself has to trigger it (the floating menu's Stop routes through here),
// and a runtime.sendMessage from the worker never reaches the worker's own
// listeners. Message handlers call this too, so both paths do the same thing.
// ── starting a capture ──────────────────────────────────────────────────────
// Chrome's own picker, raised straight over the user's tab. It used to be hosted
// inside a 710x540 extension window we opened for the purpose, which is why the
// picker appeared framed inside a window of ours AND put an entry in the taskbar -
// and why the screenshot path then had to minimise that window so it would not
// appear in its own screenshot. Passing the tab here means no window exists at all.
//
// 'audio' among the sources is what makes Chrome offer "Also share system audio";
// it hands the audio over only if the user actually ticks it.
// The picker is raised by the offscreen recorder itself (getDisplayMedia), not
// from here. A service worker cannot ask without naming a target tab, and the
// stream that comes back is then locked to that tab's renderer - the recorder is
// refused it. Asking from the document that consumes it is also what gives us
// Chrome's own picker with no window of ours around it, no taskbar entry, and the
// "Also share system audio" toggle.
// chrome.offscreen.createDocument() resolves as soon as the document exists - not
// when its script has run and registered a listener. A start-recording sent into
// that gap is delivered to nobody and silently lost, which is exactly what made
// the recording never begin. Wait until it answers before asking it for anything.
async function capOffscreenReady(tries = 30) {
  for (let i = 0; i < tries; i++) {
    const pong = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' }).catch(() => null);
    if (pong && pong.ready) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

async function capChooseAndCapture(tab, mode) {
  try {
    await setupOffscreenDocument();
    await capOffscreenReady();

    if (mode !== 'record') {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'capture-screen' });
      return;
    }

    // The editor is titled after the page the recording was taken from, and the
    // control bar has to appear in that same tab - remember which one it was.
    if (tab) chrome.storage.local.set({ tempTabTitle: tab.title || 'recording', tempTabId: tab.id });

    // The recorder has no chrome.storage of its own, so everything it needs to
    // know is handed to it here.
    const BITRATE_BY_QUALITY = { low: 1500000, medium: 3000000, high: 5000000, ultra: 8000000 };
    const { micEnabled, videoQuality } = await chrome.storage.local.get(['micEnabled', 'videoQuality']);
    chrome.runtime.sendMessage({
      target: 'offscreen', type: 'start-recording',
      micEnabled: !!micEnabled,
      videoBitsPerSecond: BITRATE_BY_QUALITY[videoQuality] || BITRATE_BY_QUALITY.high,
      countdownMs: 3000,
      countdownTabId: tab ? tab.id : null   // counted in once the picker is answered
    });
  } catch (e) {
    console.error('Could not start the capture:', e);
  }
}

// The recorder has the stream and is about to count the user in - show them the
// countdown in their own tab. It cannot happen any earlier: before this point the
// picker is still up, and counting down behind it would be counting down nothing.
function capShowCountdown(tabId, seconds) {
  if (!tabId) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['capture/cap-content.js'] })
    .then(() => chrome.tabs.sendMessage(tabId, { action: 'showCountdown', seconds }).catch(() => { }))
    .catch(() => { /* a chrome:// tab has no countdown; record anyway */ });
}

// The offscreen recorder is rolling: light everything up. This used to be the
// capture window's job (notifyRecordingStartedInTab), and there is no such window
// any more.
function capOnRecordingStarted() {
  chrome.storage.local.get(['tempTabId'], ({ tempTabId }) => {
    isRecordingInProgress = true;
    currentRecordingTabId = tempTabId || null;
    chrome.storage.local.set({
      isRecordingInProgress: true,
      recordingPaused: false,
      recordingStartTime: Date.now()
    }, () => {
      startBadgeTimer();
      if (!tempTabId) return;
      chrome.tabs.sendMessage(tempTabId, { action: 'startRecordingInTab' }).catch(() => {
        chrome.scripting.executeScript({ target: { tabId: tempTabId }, files: ['capture/cap-content.js'] })
          .then(() => chrome.tabs.sendMessage(tempTabId, { action: 'startRecordingInTab' }))
          .catch(() => { });
      });
    });
  });
}

function capStopRecording() {
  isRecordingInProgress = false;
  // Clear the paused flag too, or the next recording's controls open showing
  // "Resume" for a recording that is actually running.
  chrome.storage.local.set({ isRecordingInProgress: false, recordingPaused: false });
  stopBadgeTimer();
  broadcastHideControl();                                    // hide the in-page bar at once
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-recording' });
}

// Pause/resume. The flag is written HERE, where the in-page bar, the popup and
// the floating menu can all see it - each used to keep its own private idea of
// whether it was paused, so pausing in one left the others still counting up and
// still saying "Recording", which read as "pause did nothing".
function capSetPaused(paused) {
  chrome.storage.local.set({ recordingPaused: !!paused });
  chrome.runtime.sendMessage({ target: 'offscreen', type: paused ? 'pause-recording' : 'resume-recording' });
}

// Same shutdown as Stop, but the recorder is told to throw the recording away
// instead of saving it - no editor tab opens for a discarded recording.
function capDiscardRecording() {
  isRecordingInProgress = false;
  chrome.storage.local.set({ isRecordingInProgress: false, recordingPaused: false });
  // The normal stop-and-save path clears this too. Skipping it here left a stale
  // recordingStartTime behind, and a race in how the floating control reads it
  // (it can run slightly before the NEXT recording writes its own fresh
  // timestamp) meant a new recording after a discard would show the timer
  // picking up from the discarded session's elapsed time.
  chrome.storage.local.remove(['recordingStartTime']);
  stopBadgeTimer();
  broadcastHideControl();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'discard-recording' });
}

function broadcastHideControl() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;

      chrome.tabs.sendMessage(tab.id, { action: 'hideRecordingControl' }).catch(() => {
        // Fallback: force removal if message fails
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const el = document.getElementById('recording-floating-control');
            if (el) el.remove();
          }
        }).catch(() => { });
      });
    });
  });
}

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('capture/offscreen.html')]
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('capture/offscreen.html'),
    // DISPLAY_MEDIA: this document raises Chrome's screen picker itself, with
    // getDisplayMedia. USER_MEDIA: and it opens the microphone for narration.
    reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
    justification: 'Record and screenshot the screen, with optional narration'
  });

  await new Promise(resolve => setTimeout(resolve, 500));
}

async function handleScreenshotCaptured(imageDataUrl) {
  if (!imageDataUrl) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0] || { id: -1, title: 'screenshot' };
    capOpenEditor(tab, imageDataUrl);
    chrome.storage.local.remove(['tempTabTitle']);
  });
}

let badgeInterval = null;

function startBadgeTimer() {
  chrome.storage.local.get(['recordingStartTime'], (result) => {
    let startTime = result.recordingStartTime || Date.now();

    const updateBadge = () => {
      if (!isRecordingInProgress) {
        stopBadgeTimer();
        return;
      }
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = (elapsed % 60).toString().padStart(2, '0');

      const timeStr = mins > 0 ? `${mins}:${secs}` : `0:${secs}`;
      chrome.action.setBadgeText({ text: timeStr });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4757' });
    };

    updateBadge();
    if (badgeInterval) clearInterval(badgeInterval);
    badgeInterval = setInterval(updateBadge, 1000);
  });
}

function stopBadgeTimer() {
  if (badgeInterval) clearInterval(badgeInterval);
  badgeInterval = null;
  chrome.action.setBadgeText({ text: '' });
}

// Track tab/window changes to show/hide recording UI across all tabs
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isRecordingInProgress) {
    injectUIIntoTab(activeInfo.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // If recording is active and we just started loading a new page, 
  // we try to ensure the UI is there. content.js is also auto-injected.
  if (isRecordingInProgress && changeInfo.status === 'loading') {
    injectUIIntoTab(tabId);
  }
});

// Detect window focus change to handle cases where user opens/switches windows
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (isRecordingInProgress && windowId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
      if (tabs[0]) injectUIIntoTab(tabs[0].id);
    });
  }
});

async function injectUIIntoTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;

    // First, check if already injected with a ping
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      // Already there, just ensure UI is shown if STILL recording
      if (isRecordingInProgress) {
        chrome.tabs.sendMessage(tabId, { action: 'startRecordingInTab' });
      }
    } catch (e) {
      // Not there, full injection
      if (!isRecordingInProgress) return; // Don't inject if stopped in the meantime

      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['capture/cap-content.js']
      });

      if (isRecordingInProgress) {
        chrome.tabs.sendMessage(tabId, { action: 'startRecordingInTab' });
      }
    }
  } catch (err) {
    // Ignore restricted pages
  }
}

// ── Floating eye: injection ─────────────────────────────────────────────────
// Off by default. When on, it rides along with every normal page load.

const CAP_EYE_SKIP = /^(chrome|chrome-extension|about|edge|devtools|view-source):/i;

function capEyeInject(tabId, url) {
    if (!url || CAP_EYE_SKIP.test(url)) return;
    chrome.scripting.executeScript({ target: { tabId }, files: ['capture/cap-eye.js'] }).catch(() => { });
}

function capInjectEyeEverywhere() {
    chrome.tabs.query({}, (tabs) => tabs.forEach(t => capEyeInject(t.id, t.url)));
}

function capRemoveEyeEverywhere() {
    chrome.tabs.query({}, (tabs) => tabs.forEach(t => {
        if (!t.url || CAP_EYE_SKIP.test(t.url)) return;
        chrome.scripting.executeScript({
            target: { tabId: t.id },
            func: () => { const el = document.getElementById('qa-cap-eye'); if (el) el.remove(); }
        }).catch(() => { });
    }));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    chrome.storage.local.get(['capEyeEnabled'], (r) => {
        if (r.capEyeEnabled) capEyeInject(tabId, tab.url);
    });
});

// ── activeTab grants ─────────────────────────────────────────────────────────
// <all_urls> covers websites, never chrome:// pages. Those need activeTab, and
// Chrome only grants it when the user *invokes* the extension: an action click
// (we open the side panel instead, so that path is gone), a keyboard command,
// or a context-menu item. Provide the latter two.

chrome.commands && chrome.commands.onCommand.addListener((command) => {
    if (command === 'capture-visible') captureScreenshot();
    else if (command === 'capture-delayed') handleDelayedCapture();
});

const CAP_MENUS = [
    ['qa-cap-visible', 'Capture the visible area'],
    ['qa-cap-area', 'Capture a selected area'],
    ['qa-cap-full', 'Capture the full page'],
    ['qa-cap-delayed', 'Capture after a countdown']
];

function capBuildMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'qa-cap-root', title: 'QA Toolkit — Capture', contexts: ['all'] },
            () => void chrome.runtime.lastError);
        for (const [id, title] of CAP_MENUS) {
            chrome.contextMenus.create({ id, parentId: 'qa-cap-root', title, contexts: ['all'] },
                () => void chrome.runtime.lastError);
        }
    });
}
chrome.runtime.onInstalled.addListener(capBuildMenus);
chrome.runtime.onStartup.addListener(capBuildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab) return;
    switch (info.menuItemId) {
        case 'qa-cap-visible': captureScreenshot(); break;
        case 'qa-cap-delayed': handleDelayedCapture(); break;
        case 'qa-cap-area':
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/area-selection.js'] }).catch(() => { });
            break;
        case 'qa-cap-full':
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/full-page.js'] }).catch(() => { });
            break;
    }
});
