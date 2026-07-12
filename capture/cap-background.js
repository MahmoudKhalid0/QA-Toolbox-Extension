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

function capSafeCaptureVisible(tab, cb) {
    const restricted = tab.url && CAP_RESTRICTED.test(tab.url);

    const done = (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
            const msg = (chrome.runtime.lastError || {}).message || 'no image returned';
            console.error('capture failed:', msg);
            // Only the activeTab grant unlocks Chrome's own pages, and a click
            // inside the side panel never grants it. Point at what does.
            capNotify('!', '#ef4444');
            // tell whoever is listening (the side panel) why, in plain words
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
        chrome.tabs.create({
            url: chrome.runtime.getURL(`capture/editor.html?id=${captureId}&title=${encodeURIComponent(tab.title || 'screenshot')}` + ((extra && extra.cropArea) ? '&crop=true' : ''))
        });
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
    if (act === 'capture') captureScreenshot();
    else if (act === 'delayed') handleDelayedCapture();
    else if (act === 'area') chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/area-selection.js'] });
    else if (act === 'full') chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/full-page.js'] });
    else if (act === 'screen') {
      chrome.windows.create({
        url: chrome.runtime.getURL(`capture/entire-screen.html?tabId=${tab.id}`),
        type: 'popup', width: 710, height: 540, focused: true
      });
    }
    else if (act === 'record') {
      chrome.storage.local.get(['isRecordingInProgress'], (r) => {
        // Call the stop directly. This IS the service worker: a runtime.sendMessage
        // it sends is delivered to every OTHER context but never back to its own
        // listeners, so relaying 'requestStopRecording' to itself here reached
        // nobody - which is why Stop from the floating menu did nothing at all.
        if (r.isRecordingInProgress) { capStopRecording(); return; }
        chrome.windows.create({
          url: chrome.runtime.getURL(`capture/entire-screen.html?mode=record&tabId=${tab.id}`),
          type: 'popup', width: 710, height: 540, focused: true
        });
      });
    }
    // Live controls from the floating menu. Same direct-call rule as Stop above:
    // these run IN the worker, so they must not be routed through a message to it.
    else if (act === 'pause') {
      chrome.storage.local.get(['recordingPaused'], (r) => capSetPaused(!r.recordingPaused));
    }
    else if (act === 'discard') capDiscardRecording();
    return false;
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
    chrome.runtime.sendMessage({ action: 'toggleMicFromTab' });
    return true;
  }

  // Handle video data from capture page
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
    const openEditor = (ctx) => {
      chrome.storage.local.set({ [`ctx_${captureId}`]: ctx || null }, () => {
        chrome.tabs.create({
          url: chrome.runtime.getURL(`capture/editor.html?id=${captureId}&title=${encodeURIComponent(tabTitle)}&type=video`)
        });
        chrome.action.setBadgeText({ text: '' });
        chrome.storage.local.remove(['tempTabTitle', 'tempTabId', 'recordingStartTime']);
      });
    };

    if (tabId) chrome.tabs.get(tabId, (t) => openEditor(t ? capCollectContext(t) : null));
    else openEditor(null);
  });
}

// Stop-and-save. Kept as a function rather than a message because the service
// worker itself has to trigger it (the floating menu's Stop routes through here),
// and a runtime.sendMessage from the worker never reaches the worker's own
// listeners. Message handlers call this too, so both paths do the same thing.
function capStopRecording() {
  isRecordingInProgress = false;
  // Clear the paused flag too, or the next recording's controls open showing
  // "Resume" for a recording that is actually running.
  chrome.storage.local.set({ isRecordingInProgress: false, recordingPaused: false });
  stopBadgeTimer();
  broadcastHideControl();                                    // hide the in-page bar at once
  chrome.runtime.sendMessage({ action: 'stopRecordingFromTab' });  // -> the capture window
}

// Pause/resume. The flag is written HERE, where the in-page bar, the popup and
// the floating menu can all see it - each used to keep its own private idea of
// whether it was paused, so pausing in one left the others still counting up and
// still saying "Recording", which read as "pause did nothing".
function capSetPaused(paused) {
  chrome.storage.local.set({ recordingPaused: !!paused });
  chrome.runtime.sendMessage({ action: paused ? 'pauseRecordingFromTab' : 'resumeRecordingFromTab' });
}

// Same shutdown as Stop, but the capture window is told to throw the recording
// away instead of saving it - no editor tab opens for a discarded recording.
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
  chrome.runtime.sendMessage({ action: 'discardRecordingFromTab' });
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
    reasons: ['USER_MEDIA'],
    justification: 'Capture screen recording'
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
