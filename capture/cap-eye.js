// Floating capture eye — a blinking eye pinned top-right of every page.
// Click it to open the capture menu without leaving the page or hunting for
// the side panel. Lives in a shadow root so no page CSS can reach it.
(function capEye() {
    const HOST_ID = 'qa-cap-eye';
    if (document.getElementById(HOST_ID)) return;
    if (window.top !== window) return;              // top frame only

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483646;';

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
  <div class="sep"></div>
  <div class="mi rec" data-act="record"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg> <span class="rec-label">Record video</span></div>
  <div class="sep"></div>
  <div class="mi" data-act="hide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Hide this icon</div>
</div>`;

    (document.body || document.documentElement).appendChild(host);

    const eye = shadow.querySelector('.eye');
    const menu = shadow.querySelector('.menu');
    const recLabel = shadow.querySelector('.rec-label');

    const paintRec = () => {
        chrome.storage.local.get(['isRecordingInProgress'], (r) => {
            recLabel.textContent = r.isRecordingInProgress ? 'Stop recording' : 'Record video';
        });
    };
    paintRec();
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.isRecordingInProgress) paintRec();
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
        menu.classList.remove('open');
        // The page must not be in the shot; give the menu a frame to disappear.
        setTimeout(() => chrome.runtime.sendMessage({ action: 'capEyeAction', act: item.dataset.act }), 60);
        if (item.dataset.act === 'hide') host.remove();
    });
})();
