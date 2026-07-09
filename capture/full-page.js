(async function () {
    console.log('=== FULL PAGE CAPTURE STARTED (PROGRESS VIA POPUP) ===');

    // Notify popup that preparation is starting
    chrome.runtime.sendMessage({ action: 'fullPageProgress', percent: 0, status: 'Preparing...' });

    // 1. Detect Scroll Container
    function getScrollContainer() {
        try {
            const html = document.documentElement;
            const body = document.body;

            // 1. Check if window is actually scrollable
            const isWindowScrollable = (html.scrollHeight > html.clientHeight) || (body.scrollHeight > body.clientHeight);
            const windowScrollStyle = window.getComputedStyle(html).overflowY;

            if (isWindowScrollable && windowScrollStyle !== 'hidden') {
                return { element: window, type: 'window' };
            }

            // 2. Search for the best candidate element
            const elements = document.querySelectorAll('*');
            let bestCandidate = null;
            let maxScore = 0;

            for (const el of elements) {
                // Remove progressDiv check as it was removed
                const style = window.getComputedStyle(el);
                const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && (el.scrollHeight > el.clientHeight);

                if (isScrollable) {
                    const rect = el.getBoundingClientRect();
                    const score = (rect.width * rect.height) + (el.scrollHeight);
                    if (score > maxScore) {
                        maxScore = score;
                        bestCandidate = el;
                    }
                }
            }

            return bestCandidate ? { element: bestCandidate, type: 'element' } : { element: window, type: 'window' };
        } catch (e) {
            console.error('Error in getScrollContainer:', e);
            return { element: window, type: 'window' };
        }
    }

    try {
        const container = getScrollContainer();
        const scroller = container.element;
        const isWindow = container.type === 'window';

        console.log('Detected scroll container:', container.type, scroller);

        // 3. Determine Dimensions
        let totalHeight, viewportHeight, totalWidth;
        let originalScrollY, originalScrollX;

        if (isWindow) {
            totalHeight = Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
            );
            viewportHeight = window.innerHeight;
            totalWidth = window.innerWidth;
            originalScrollY = window.scrollY;
            originalScrollX = window.scrollX;
        } else {
            totalHeight = scroller.scrollHeight;
            viewportHeight = scroller.clientHeight;
            totalWidth = scroller.clientWidth;
            originalScrollY = scroller.scrollTop;
            originalScrollX = scroller.scrollLeft;
        }

        const screenshots = [];
        let currentY = 0;
        let captureCount = 0;
        const dpr = window.devicePixelRatio || 1;
        const hiddenElements = [];

        // 3. Capture Loop
        while (currentY < totalHeight) {
            const percent = Math.min(100, Math.round((currentY / totalHeight) * 100));
            // Send progress to popup
            chrome.runtime.sendMessage({ action: 'fullPageProgress', percent, status: 'Capturing...' });

            // Scroll
            if (isWindow) {
                window.scrollTo(0, currentY);
            } else {
                scroller.scrollTop = currentY;
            }

            // Wait for render/lazy-load
            await new Promise(r => setTimeout(r, 600));

            // Capture
            try {
                // No need to hide anything on page now as the progress UI is in the popup

                const dataUrl = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: 'captureViewport' }, (response) => {
                        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                        else if (response && response.dataUrl) resolve(response.dataUrl);
                        else reject('No data');
                    });
                });

                // LOGIC: If this was the FIRST capture, hide fixed/sticky elements so they don't repeat
                if (captureCount === 0) {
                    try {
                        const elementsToHide = document.querySelectorAll('*');
                        for (const el of elementsToHide) {
                            const style = window.getComputedStyle(el);
                            // Hide fixed/sticky elements to prevent duplication in subsequent slices
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

                screenshots.push({ dataUrl, scrollY: Math.round(currentY * dpr) });
                captureCount++;
            } catch (err) {
                console.error('Capture chunk error:', err);
                throw err; // Stop if we can't capture
            }

            // Increment scroll
            const nextY = currentY + viewportHeight;
            if (nextY >= totalHeight) break; // Finished

            // If we are about to overscroll, adjust to capture the exact bottom
            currentY = Math.min(nextY, totalHeight - viewportHeight);
            if (currentY < 0) currentY = 0;

            // Special exit: if we didn't actually move (e.g. at bottom), break
            if (captureCount > 0 && currentY === Math.round(screenshots[screenshots.length - 1].scrollY / dpr)) break;

            // Safety Break
            if (captureCount > 50) break;
        }

        // Send final progress
        chrome.runtime.sendMessage({ action: 'fullPageProgress', percent: 100, status: 'Stitching...' });

        // 4. Finalize
        // Restore Fixed Elements
        for (const item of hiddenElements) {
            item.element.style.opacity = item.originalOpacity;
            item.element.style.visibility = item.originalVisibility;
        }

        // Restore Scroll
        if (isWindow) window.scrollTo(originalScrollX, originalScrollY);
        else scroller.scrollTop = originalScrollY;

        chrome.runtime.sendMessage({
            action: 'fullPageComplete',
            screenshots: screenshots,
            totalHeight: totalHeight * dpr,
            viewportHeight: viewportHeight * dpr,
            pageWidth: totalWidth * dpr
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
