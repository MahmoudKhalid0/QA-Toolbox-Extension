(async function () {
    console.log('=== FULL PAGE CAPTURE STARTED (PROGRESS VIA POPUP) ===');

    // Notify popup that preparation is starting
    chrome.runtime.sendMessage({ action: 'fullPageProgress', percent: 0, status: 'Preparing...' });

    // 1. Detect Scroll Container
    //
    // A modal/dialog almost never disables the background page's own scroll,
    // so "is the window scrollable" is true whether or not a modal is open -
    // checking that FIRST meant a full-page capture with any modal open just
    // scrolled and stitched the page behind it, ignoring the modal entirely.
    // position:fixed + an explicit z-index is the reliable signature of an
    // overlay (modal, popup, drawer); a scrollable element living inside one
    // of those takes priority over plain window scroll regardless.
    function isInsideOverlay(el) {
        let node = el;
        while (node && node !== document.body && node !== document.documentElement) {
            const style = window.getComputedStyle(node);
            if ((style.position === 'fixed' || style.position === 'sticky') && parseInt(style.zIndex, 10) > 0) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    function findScrollableCandidate() {
        const elements = document.querySelectorAll('*');
        let bestOverlay = null, bestOverlayScore = 0;
        let bestPlain = null, bestPlainScore = 0;

        for (const el of elements) {
            const style = window.getComputedStyle(el);
            const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && (el.scrollHeight > el.clientHeight);
            if (!isScrollable) continue;

            const rect = el.getBoundingClientRect();
            const score = (rect.width * rect.height) + el.scrollHeight;
            if (isInsideOverlay(el)) {
                if (score > bestOverlayScore) { bestOverlayScore = score; bestOverlay = el; }
            } else if (score > bestPlainScore) {
                bestPlainScore = score; bestPlain = el;
            }
        }
        // An open modal's own scroll area wins even over a bigger plain one -
        // it's what's actually visible and what the user means to capture.
        return bestOverlay || bestPlain;
    }

    function getScrollContainer() {
        try {
            const html = document.documentElement;
            const body = document.body;

            const overlayCandidate = findScrollableCandidate();
            if (overlayCandidate && isInsideOverlay(overlayCandidate)) {
                return { element: overlayCandidate, type: 'element', isOverlay: true };
            }

            // Check if window is actually scrollable
            const isWindowScrollable = (html.scrollHeight > html.clientHeight) || (body.scrollHeight > body.clientHeight);
            const windowScrollStyle = window.getComputedStyle(html).overflowY;

            if (isWindowScrollable && windowScrollStyle !== 'hidden') {
                return { element: window, type: 'window', isOverlay: false };
            }

            return overlayCandidate
                ? { element: overlayCandidate, type: 'element', isOverlay: false }
                : { element: window, type: 'window', isOverlay: false };
        } catch (e) {
            console.error('Error in getScrollContainer:', e);
            return { element: window, type: 'window', isOverlay: false };
        }
    }

    try {
        const container = getScrollContainer();
        const scroller = container.element;
        const isWindow = container.type === 'window';

        console.log('Detected scroll container:', container.type, scroller, 'isOverlay:', container.isOverlay);

        function requestViewportCapture() {
            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'captureViewport' }, (response) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else if (response && response.dataUrl) resolve(response.dataUrl);
                    else reject('No data');
                });
            });
        }
        function imageSize(dataUrl) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = reject;
                img.src = dataUrl;
            });
        }

        // window.devicePixelRatio is not reliable here - on at least one real
        // Windows setup (OS-level display scaling) it read 1 while
        // captureVisibleTab actually returned a 1.5x-scaled image, so every
        // crop/canvas-size computation that trusted it was silently cropping
        // and stitching the wrong regions. Take one real screenshot up front
        // and measure the TRUE scale directly from its pixel dimensions
        // against the known CSS viewport size instead of trusting the API.
        const probeDataUrl = await requestViewportCapture();
        const probeSize = await imageSize(probeDataUrl);
        const dpr = probeSize.width / window.innerWidth;
        console.log('Measured capture scale:', dpr, '(devicePixelRatio reported', window.devicePixelRatio, ')');

        // ── Pin scroll-triggered sticky headers BEFORE measuring anything ──────────
        // Many sites (e.g. government portals) keep their header in normal flow at the
        // very top and only switch it to position:fixed via a scroll handler (a class
        // like `is-fixed`). That switch takes the header OUT of document flow, so the
        // page loses ~header-height once you scroll - and the capture, which starts at
        // the top with the header in flow, then finds every later slice shifted up by
        // that amount. The result was a white band (the gap the header used to fill)
        // and a mis-stitched tail. Fix: detect exactly those headers (fixed/sticky
        // AFTER a small scroll but NOT at the top) and pin them to `position:static`
        // for the whole capture, so the layout never changes - the header stays in
        // flow, is captured once at the top, and scrolls away naturally. Genuinely
        // always-fixed widgets (chat bubbles, accessibility buttons) are left alone;
        // they're hidden per-slice in the loop below instead.
        const hiddenElements = [];
        const pinnedStatic = [];
        if (isWindow) {
            try {
                // Elements ALREADY fixed/sticky at the top are persistent widgets - a chat
                // bubble, an accessibility button, our own FAB. They're UI chrome, not page
                // content, and repeat down every slice. Hide them for the WHOLE capture
                // (once, up front) - no per-slice hiding, so no repaint race.
                const fixedAtTop = new Set();
                for (const el of document.querySelectorAll('*')) {
                    const p = getComputedStyle(el).position;
                    if (p === 'fixed' || p === 'sticky') fixedAtTop.add(el);
                }
                // Now scroll a little to trigger scroll handlers, and see what NEWLY became
                // fixed/sticky - those are scroll-triggered headers. Pin them to static so
                // they stay in flow (captured once at the top, no layout shift, no gap).
                window.scrollTo(0, 300);
                await new Promise(r => setTimeout(r, 400));
                for (const el of document.querySelectorAll('*')) {
                    const p = getComputedStyle(el).position;
                    if ((p === 'fixed' || p === 'sticky') && !fixedAtTop.has(el)) {
                        pinnedStatic.push({
                            el,
                            prev: el.style.getPropertyValue('position'),
                            prio: el.style.getPropertyPriority('position')
                        });
                        el.style.setProperty('position', 'static', 'important');
                    }
                }
                window.scrollTo(0, 0);
                await new Promise(r => setTimeout(r, 300));
                // hide the persistent widgets for the whole capture
                for (const el of fixedAtTop) {
                    el.__qaCapHidden = true;
                    hiddenElements.push({ element: el, originalOpacity: el.style.opacity, originalVisibility: el.style.visibility });
                    el.style.opacity = '0';
                    el.style.visibility = 'hidden';
                }
            } catch (e) { console.error('header-pin pre-pass failed:', e); }
        }

        // For a real modal/dialog, the user wants what every other full-page
        // tool produces: the surrounding page (sidebar, nav, dimmed backdrop)
        // still visible, with the modal's own full content shown in place -
        // not a tight, context-free crop of just the modal.
        //
        // Forcing the modal to expand in the DOM and capturing it as a normal
        // window-scroll was tried first and doesn't work in general:
        // position:fixed (how virtually every modal is built) takes an
        // element out of document flow entirely, so even with its own height
        // cap removed, the expanded content stays invisibly clipped to the
        // viewport and never grows document.scrollHeight - converting fixed
        // ancestors to absolute to fix that is fragile against real-world
        // modal CSS (flex-centering, custom containing blocks, etc).
        //
        // Instead: reuse the probe shot above as a context screenshot of the
        // page exactly as it looks right now, separately scroll+crop+stitch
        // the modal's own full content (unaffected by any of the above), and
        // composite the finished modal image onto the context screenshot at
        // the modal's on-screen position during the offscreen stitching step.
        let contextDataUrl = null;
        let elementRect = null;
        if (!isWindow && container.isOverlay) {
            elementRect = scroller.getBoundingClientRect();
            contextDataUrl = probeDataUrl;
        }

        // 3. Determine Dimensions
        let totalHeight, viewportHeight, totalWidth;
        let originalScrollY, originalScrollX;
        // captureVisibleTab always photographs the WHOLE browser tab, never
        // just this element - a fixed-position modal doesn't move on screen
        // while its own content scrolls internally, so its box stays valid
        // for every slice and is used to crop each one down before stitching.

        let viewportWidth;
        if (isWindow) {
            totalHeight = Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
            );
            viewportHeight = window.innerHeight;
            viewportWidth = window.innerWidth;
            // A page wider than the viewport (a table, a fixed-width layout)
            // used to just get cropped to viewportWidth - competing tools
            // capture the page's real full width, scrolling sideways the
            // same way this already scrolls down.
            totalWidth = Math.max(
                document.documentElement.scrollWidth,
                document.body.scrollWidth,
                viewportWidth
            );
            originalScrollY = window.scrollY;
            originalScrollX = window.scrollX;
        } else {
            elementRect = scroller.getBoundingClientRect();
            totalHeight = scroller.scrollHeight;
            viewportHeight = elementRect.height;
            totalWidth = elementRect.width;
            viewportWidth = elementRect.width;
            originalScrollY = scroller.scrollTop;
            originalScrollX = scroller.scrollLeft;
        }

        // Crops a full-tab screenshot down to a CSS-pixel rect (scaled to the
        // device pixel ratio, since that's what the actual PNG is measured in).
        function cropDataUrl(dataUrl, rect) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = Math.round(rect.width * dpr);
                    c.height = Math.round(rect.height * dpr);
                    const cctx = c.getContext('2d');
                    cctx.drawImage(
                        img,
                        Math.round(rect.left * dpr), Math.round(rect.top * dpr), c.width, c.height,
                        0, 0, c.width, c.height
                    );
                    resolve(c.toDataURL('image/png'));
                };
                img.onerror = reject;
                img.src = dataUrl;
            });
        }

        const screenshots = [];
        let captureCount = 0;

        // A scrollbar (native or custom) is just more pixels on screen as far
        // as captureVisibleTab is concerned, so it gets baked into whichever
        // slice happens to be showing it - and once slices land at different
        // X/Y offsets in the final stitch, that bar shows up as a stray line
        // wherever it was captured, not just at the true edge of the page.
        // Hiding scrollbar RENDERING (not disabling scroll - horizontal
        // tiling below still needs to actually scroll sideways) via injected
        // CSS keeps every slice clean without touching layout or scroll range.
        const scrollbarHideStyle = document.createElement('style');
        scrollbarHideStyle.textContent = `
            *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
        `;
        document.documentElement.appendChild(scrollbarHideStyle);

        // Horizontal tiling is only safe on a genuinely-wide LTR page. Two
        // things force it back to a single viewport-wide column:
        //   1. RTL pages (Arabic, Hebrew...). Their horizontal scroll origin
        //      is on the RIGHT, so scrollTo(positiveX) doesn't move the way
        //      the tiling assumes - it re-captures almost the whole page a few
        //      px over and stitches it as a ghost strip down the side (the
        //      reported bug, which appeared only after switching the site to
        //      Arabic). The visible page is still captured correctly top to
        //      bottom; only the rare truly-wider-than-viewport RTL overflow is
        //      skipped, and that would have been captured wrong anyway.
        //   2. A few px of overflow on ANY page (sub-pixel rounding, a
        //      scrollbar) - not a real second screen of content.
        const pageRtl = (document.documentElement.getAttribute('dir') || '').toLowerCase() === 'rtl'
            || (document.body && (document.body.getAttribute('dir') || '').toLowerCase() === 'rtl')
            || getComputedStyle(document.documentElement).direction === 'rtl'
            || (document.body && getComputedStyle(document.body).direction === 'rtl');
        const H_TILE_SLACK = 32;
        if (isWindow && (pageRtl || totalWidth - viewportWidth <= H_TILE_SLACK)) totalWidth = viewportWidth;

        const numXTiles = isWindow ? Math.max(1, Math.ceil(totalWidth / viewportWidth)) : 1;

        // One column at a time: scroll down, capturing every row, at whatever
        // X offset the caller has already scrolled to. Identical to the
        // original single-column loop, just reusable per horizontal tile.
        async function captureColumn(scrollXPx) {
            let currentY = 0;
            let lastActualY = -1;
            for (; ;) {
                const percent = Math.min(100, Math.round(((scrollXPx / Math.max(1, totalWidth)) + (currentY / totalHeight) / numXTiles) * 100));
                chrome.runtime.sendMessage({ action: 'fullPageProgress', percent, status: 'Capturing...' });

                if (isWindow) window.scrollTo(scrollXPx, currentY);
                else scroller.scrollTop = currentY;

                // Wait for render/lazy-load (and for the page's own scroll handlers to run)
                await new Promise(r => setTimeout(r, 600));

                // The ACTUAL scroll position after the browser clamps it. This matters when
                // the page gets SHORTER mid-capture - a header that switches to
                // position:fixed on scroll leaves the document flow and the page loses its
                // height, so a later scrollTo(y) lands short of y. Recording the requested y
                // instead made the last slice's pixels land too low and the footer was
                // stitched twice. If we can no longer advance, we've reached the bottom -
                // stop before capturing a duplicate tail.
                const actualY = isWindow ? Math.round(window.scrollY) : Math.round(scroller.scrollTop);
                if (captureCount > 0 && actualY <= lastActualY) break;

                // Window captures handle fixed elements up front (pre-pass above): headers
                // are pinned in-flow and persistent widgets are hidden for the whole run, so
                // nothing per-slice is needed. This per-slice hide is only for the MODAL case
                // (a scrollable overlay), where the scroller must stay visible - so we hide
                // whatever else is fixed, from the second slice on, re-detecting each time.
                if (!isWindow && captureCount > 0) {
                    try {
                        for (const el of document.querySelectorAll('*')) {
                            // Never hide the scroller itself or anything containing it - a
                            // modal (and its wrapper chain) is almost always position:fixed.
                            if (!isWindow && el.contains(scroller)) continue;
                            if (el.__qaCapHidden) continue;                 // already hidden
                            const style = window.getComputedStyle(el);
                            if (style.position === 'fixed' || style.position === 'sticky') {
                                el.__qaCapHidden = true;
                                hiddenElements.push({
                                    element: el,
                                    originalOpacity: el.style.opacity,
                                    originalVisibility: el.style.visibility
                                });
                                el.style.opacity = '0';
                                el.style.visibility = 'hidden';
                            }
                        }
                    } catch (e) {
                        console.error('Error hiding elements:', e);
                    }
                }

                try {
                    let dataUrl = await requestViewportCapture();

                    // A modal doesn't move on screen while its own content scrolls -
                    // crop every slice down to its box before it ever reaches the
                    // stitching step, which otherwise has no way to tell "this PNG
                    // is the whole tab" from "this PNG is just the scrolled element".
                    if (!isWindow) {
                        dataUrl = await cropDataUrl(dataUrl, elementRect);
                    }

                    // Record the ACTUAL scroll position (not the requested currentY) so the
                    // stitcher places each slice where it really landed - see the note above.
                    screenshots.push({ dataUrl, scrollX: Math.round(scrollXPx * dpr), scrollY: Math.round(actualY * dpr) });
                    captureCount++;
                    lastActualY = actualY;
                } catch (err) {
                    console.error('Capture chunk error:', err);
                    throw err;
                }

                const nextY = currentY + viewportHeight;
                if (nextY >= totalHeight) break;

                const prevY = currentY;
                currentY = Math.min(nextY, totalHeight - viewportHeight);
                if (currentY < 0) currentY = 0;
                if (currentY === prevY) break; // didn't actually move (e.g. already at bottom)

                if (captureCount > 80) break; // safety break across the whole grid
            }
        }

        // 3. Capture Loop - one pass per horizontal tile, each a full vertical scan.
        for (let xi = 0; xi < numXTiles; xi++) {
            const currentX = numXTiles === 1 ? 0 : Math.min(xi * viewportWidth, totalWidth - viewportWidth);
            await captureColumn(currentX);
            if (captureCount > 80) break;
        }

        // Send final progress
        chrome.runtime.sendMessage({ action: 'fullPageProgress', percent: 100, status: 'Stitching...' });

        // 4. Finalize
        // Restore Fixed Elements
        for (const item of hiddenElements) {
            item.element.style.opacity = item.originalOpacity;
            item.element.style.visibility = item.originalVisibility;
            try { delete item.element.__qaCapHidden; } catch (e) { }
        }
        // Un-pin the headers we forced to position:static.
        for (const p of pinnedStatic) {
            if (p.prev) p.el.style.setProperty('position', p.prev, p.prio);
            else p.el.style.removeProperty('position');
        }

        // Restore scrollbar rendering
        scrollbarHideStyle.remove();

        // Restore Scroll
        if (isWindow) window.scrollTo(originalScrollX, originalScrollY);
        else scroller.scrollTop = originalScrollY;

        // Rounded the same way cropDataUrl() rounds each slice's own canvas
        // size - even a fractional-pixel mismatch here would make the
        // stitching step's width/height math not quite line up with what
        // was actually cropped.
        chrome.runtime.sendMessage({
            action: 'fullPageComplete',
            screenshots: screenshots,
            totalHeight: Math.round(totalHeight * dpr),
            viewportHeight: Math.round(viewportHeight * dpr),
            viewportWidth: Math.round(viewportWidth * dpr),
            pageWidth: Math.round(totalWidth * dpr),
            // Present only for a modal/overlay capture - offscreen.js composites
            // the finished modal image onto this at (elementX, elementY) so the
            // surrounding page stays visible instead of just the modal alone.
            contextDataUrl,
            elementX: elementRect ? Math.round(elementRect.left * dpr) : null,
            elementY: elementRect ? Math.round(elementRect.top * dpr) : null
        });

        console.log('=== FULL PAGE CAPTURE COMPLETE ===');

    } catch (err) {
        console.error('Full page capture failed:', err);
        chrome.runtime.sendMessage({
            action: 'fullPageProgress',
            percent: 0,
            status: 'Error: ' + err.message,
            isError: true
        });
    }
})();
