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
        const hiddenElements = [];

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

        const numXTiles = isWindow ? Math.max(1, Math.ceil(totalWidth / viewportWidth)) : 1;

        // One column at a time: scroll down, capturing every row, at whatever
        // X offset the caller has already scrolled to. Identical to the
        // original single-column loop, just reusable per horizontal tile.
        async function captureColumn(scrollXPx) {
            let currentY = 0;
            for (; ;) {
                const percent = Math.min(100, Math.round(((scrollXPx / Math.max(1, totalWidth)) + (currentY / totalHeight) / numXTiles) * 100));
                chrome.runtime.sendMessage({ action: 'fullPageProgress', percent, status: 'Capturing...' });

                if (isWindow) window.scrollTo(scrollXPx, currentY);
                else scroller.scrollTop = currentY;

                // Wait for render/lazy-load
                await new Promise(r => setTimeout(r, 600));

                try {
                    let dataUrl = await requestViewportCapture();

                    // A modal doesn't move on screen while its own content scrolls -
                    // crop every slice down to its box before it ever reaches the
                    // stitching step, which otherwise has no way to tell "this PNG
                    // is the whole tab" from "this PNG is just the scrolled element".
                    if (!isWindow) {
                        dataUrl = await cropDataUrl(dataUrl, elementRect);
                    }

                    // Hide fixed/sticky elements once, on the very first capture of
                    // the whole grid - they don't move for any row OR column, so
                    // every later slice (in every column) needs them gone too.
                    if (captureCount === 0) {
                        try {
                            const elementsToHide = document.querySelectorAll('*');
                            for (const el of elementsToHide) {
                                // Never hide the scroller itself or anything containing
                                // it - a modal (and its wrapper chain) is almost always
                                // position:fixed, and hiding it would blank out every
                                // capture from here on.
                                if (!isWindow && el.contains(scroller)) continue;
                                const style = window.getComputedStyle(el);
                                if (style.position === 'fixed' || style.position === 'sticky') {
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

                    screenshots.push({ dataUrl, scrollX: Math.round(scrollXPx * dpr), scrollY: Math.round(currentY * dpr) });
                    captureCount++;
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
