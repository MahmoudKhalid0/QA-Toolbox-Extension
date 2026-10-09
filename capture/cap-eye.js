// Floating capture eye — a blinking eye pinned near the top-right of every page.
// Click it to open the capture menu without leaving the page or hunting for
// the side panel. Lives in a shadow root so no page CSS can reach it.
(function capEye() {
    const HOST_ID = 'qa-cap-eye';
    if (document.getElementById(HOST_ID)) return;
    if (window.top !== window) return;              // top frame only

    const host = document.createElement('div');
    host.id = HOST_ID;
    // top:90px - below a typical site header (OutSystems' is 64px) instead of on it
    host.style.cssText = 'position:fixed;top:90px;right:14px;z-index:2147483646;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .eye {
    width: 38px; height: 38px; border-radius: 50%; cursor: pointer;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 16px rgba(0,0,0,.45);
    transition: transform .18s, box-shadow .18s;
  }
  .eye:hover { transform: scale(1.08); box-shadow: 0 6px 22px rgba(239,68,68,.5); }
  .eye svg { width: 21px; height: 21px; overflow: visible; }

  /* A real blink: the eye shape squashes to a line while the pupil shrinks
     with it. Both share the eye's centre as their origin, and the timing is
     ease-in on the way down, ease-out on the way up - eyelids accelerate. */
  .eye-shape, .pupil {
    transform-box: fill-box;
    transform-origin: center;
    animation: blink 3s infinite;
  }
  .pupil { animation-name: blink-pupil; }

  @keyframes blink {
    0%, 92%, 100%   { transform: scaleY(1); animation-timing-function: ease-in; }
    95.5%           { transform: scaleY(0.06); animation-timing-function: ease-out; }
    99%             { transform: scaleY(1); }
  }
  @keyframes blink-pupil {
    0%, 92%, 100%   { transform: scaleY(1); opacity: 1; animation-timing-function: ease-in; }
    95.5%           { transform: scaleY(0.06); opacity: 0; animation-timing-function: ease-out; }
    99%             { transform: scaleY(1); opacity: 1; }
  }
  /* the closed lid reads as a crease, so the shape never vanishes entirely */
  .crease { opacity: 0; animation: crease 3s infinite; }
  @keyframes crease {
    0%, 93%, 98%, 100% { opacity: 0; }
    95.5%              { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .eye-shape, .pupil, .crease { animation: none; }
    .crease { opacity: 0; }
  }
  .menu {
    position: absolute; top: 46px; right: 0; width: 194px; padding: 6px;
    background: #17151f; border: 1px solid #2a2738; border-radius: 12px;
    box-shadow: 0 14px 40px rgba(0,0,0,.6); display: none;
    font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; color: #e5e7eb;
    /* An RTL host page (e.g. an Arabic site) inherits its direction into
       this shadow tree and flips every row to icon-on-the-right,
       right-aligned. Pin LTR so the items always read icon-then-label,
       aligned from the left, whatever the page's direction is. */
    direction: ltr; text-align: left;
  }
  .menu.open { display: block; }
  .mi {
    display: flex; align-items: center; justify-content: flex-start;
    gap: 10px; padding: 9px 10px;
    border-radius: 8px; cursor: pointer; white-space: nowrap;
  }
  .mi:hover { background: rgba(245,158,11,.16); color: #fff; }
  .mi.rec { color: #fca5a5; }
  .mi svg { width: 14px; height: 14px; flex: 0 0 auto; opacity: .85; }
  .sep { height: 1px; background: #2a2738; margin: 5px 4px; }
  /* Narration for the next recording. A switch, not an action: it changes what
     the recorder will do, it does not start anything - so it must not look like
     the items above it, and clicking it must not close the menu. */
  .mi.mic { cursor: pointer; }
  .mi.mic .mic-label { flex: 1; }
  .mi.mic .mic-sw {
    width: 30px; height: 17px; border-radius: 20px; flex: 0 0 auto;
    background: #3a3550; position: relative; transition: background .18s;
  }
  .mi.mic .mic-knob {
    position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
    border-radius: 50%; background: #fff; transition: transform .18s;
  }
  .mi.mic.on .mic-sw { background: #10b981; }
  .mi.mic.on .mic-knob { transform: translateX(13px); }
  .mi.mic.on { color: #6ee7b7; }
  .mi.mic.on svg { opacity: 1; }
  /* Mid-recording, taking a shot or arming the mic would wreck the take, so those
     go - and the divider that sat above them goes with them, or it draws a stray
     line across the top of the menu with nothing left to divide. The capture acts
     are listed explicitly because .sep:first-of-type does NOT mean "the first
     .sep": first-of-type counts by tag, and every row here is a div, so it
     matched nothing at all. What appears instead is the live controls. */
  .mi.live { display: none; }
  .menu.recording .mi[data-act="capture"],
  .menu.recording .mi[data-act="area"],
  .menu.recording .mi[data-act="full"],
  .menu.recording .mi[data-act="screen"],
  .menu.recording .mi[data-act="delayed"],
  .menu.recording .mi[data-act="mic"],
  .menu.recording .sep-cap { display: none; }
  .menu.recording .mi.live { display: flex; }
  .menu.recording .mi.rec { color: #fca5a5; }
  .mi.discard { color: #fca5a5; }
  .mi.discard:hover { background: rgba(239,68,68,.2); }
</style>
<div class="eye" title="Capture (screenshot / video)">
  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path class="eye-shape" d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>
    <circle class="pupil" cx="12" cy="12" r="3" fill="#fff" stroke="none"/>
    <path class="crease" d="M2 12h20"/>
  </svg>
</div>
<div class="menu">
  <div class="mi" data-act="capture"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/></svg> Visible area</div>
  <div class="mi" data-act="area"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg> Select an area</div>
  <div class="mi" data-act="full"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5"/></svg> Full page</div>
  <div class="mi" data-act="screen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> Entire screen</div>
  <div class="mi" data-act="delayed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Delayed</div>
  <div class="sep sep-cap"></div>
  <div class="mi rec" data-act="record"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg> <span class="rec-label">Record video</span></div>
  <div class="mi live pause" data-act="pause"><svg class="pause-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> <span class="pause-label">Pause</span></div>
  <div class="mi live discard" data-act="discard"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg> Discard recording</div>
  <div class="mi mic" data-act="mic" title="Applies to video recording only - screenshots have no audio"><svg class="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg> <span class="mic-label">Microphone</span><span class="mic-sw"><span class="mic-knob"></span></span></div>
  <div class="sep"></div>
  <div class="mi" data-act="hide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Hide this icon</div>
</div>`;

    (document.body || document.documentElement).appendChild(host);

    const eye = shadow.querySelector('.eye');
    const menu = shadow.querySelector('.menu');
    const recLabel = shadow.querySelector('.rec-label');

    const micItem = shadow.querySelector('.mi.mic');

    const pauseLabel = shadow.querySelector('.pause-label');
    const pauseIcon = shadow.querySelector('.pause-icon');
    const PAUSE_SVG = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    const PLAY_SVG = '<polygon points="6,4 20,12 6,20"/>';

    const paintRec = () => {
        chrome.storage.local.get(['isRecordingInProgress', 'recordingPaused'], (r) => {
            const on = !!r.isRecordingInProgress;
            recLabel.textContent = on ? 'Stop recording' : 'Record video';
            // Swaps the capture options for the live controls (see .recording).
            menu.classList.toggle('recording', on);
            // Paused is shared state, so this reads the same as the in-page bar
            // and the popup - pause anywhere, and all three agree.
            const paused = !!r.recordingPaused;
            pauseLabel.textContent = paused ? 'Resume' : 'Pause';
            pauseIcon.innerHTML = paused ? PLAY_SVG : PAUSE_SVG;
        });
    };
    const paintMic = () => {
        chrome.storage.local.get(['micEnabled'], (r) => {
            micItem.classList.toggle('on', !!r.micEnabled);
        });
    };
    paintRec();
    paintMic();
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.isRecordingInProgress || ch.recordingPaused) paintRec();
        if (ch.micEnabled) paintMic();   // kept in step with the popup's switch
    });

    eye.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('open');
        if (menu.classList.contains('open')) paintRec();
    });
    document.addEventListener('click', () => menu.classList.remove('open'));

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.mi');
        if (!item) return;

        // The mic is a setting, not a capture: flip it and stay open, so you can
        // arm the mic and hit Record in the same visit to this menu.
        if (item.dataset.act === 'mic') {
            e.stopPropagation();
            chrome.storage.local.get(['micEnabled'], (r) => {
                chrome.storage.local.set({ micEnabled: !r.micEnabled }, paintMic);
            });
            return;
        }

        // Pause toggles in place and leaves the menu open - you resume from the
        // same row you paused with, so closing it would just make you reopen it.
        if (item.dataset.act === 'pause') {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'capEyeAction', act: 'pause' });
            return;   // the shared flag comes back and repaints the row
        }

        menu.classList.remove('open');
        // The page must not be in the shot; give the menu a frame to disappear.
        setTimeout(() => chrome.runtime.sendMessage({ action: 'capEyeAction', act: item.dataset.act }), 60);
        if (item.dataset.act === 'hide') host.remove();
    });
})();
