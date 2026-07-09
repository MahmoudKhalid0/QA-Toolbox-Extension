(function() {
    // Area selection overlay content script
    let state = 'idle'; // idle, selecting, moving, resizing
    let startX, startY;
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    let moveOffset = { x: 0, y: 0 };
    let activeHandle = null;
    
    let overlay, selectionBox, dimensionLabel, controls;
    const handles = {};

    function createOverlay() {
        if (document.getElementById('screenshot-area-overlay')) return;

        overlay = document.createElement('div');
        overlay.id = 'screenshot-area-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 2147483647;
            cursor: crosshair;
            user-select: none;
        `;

        selectionBox = document.createElement('div');
        selectionBox.style.cssText = `
            position: absolute;
            box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6);
            border: 2px solid #8b5cf6;
            display: none;
            z-index: 2147483646;
            cursor: move;
        `;

        // Create 8 handles
        const handleTypes = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
        handleTypes.forEach(type => {
            const h = document.createElement('div');
            h.style.cssText = `
                position: absolute;
                width: 10px; height: 10px;
                background: white;
                border: 2px solid #8b5cf6;
                border-radius: 50%;
                z-index: 2147483649;
            `;
            h.style.cursor = type + '-resize';
            if (type.length === 1) h.style.cursor = (type === 'n' || type === 's' ? 'ns' : 'ew') + '-resize';
            
            selectionBox.appendChild(h);
            handles[type] = h;
            h.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                state = 'resizing';
                activeHandle = type;
                controls.style.display = 'none';
            });
        });

        dimensionLabel = document.createElement('div');
        dimensionLabel.style.cssText = `
            position: absolute;
            background: #8b5cf6; color: white;
            padding: 4px 8px; border-radius: 4px;
            font-family: 'Segoe UI', sans-serif;
            font-size: 12px; font-weight: bold;
            display: none; pointer-events: none;
            z-index: 2147483648;
        `;

        controls = document.createElement('div');
        controls.style.cssText = `
            position: absolute; display: none; gap: 8px;
            z-index: 2147483648; background: white;
            padding: 6px; border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        `;

        const captureBtn = createButton('✔ Capture', '#8b5cf6', 'white', confirmSelection);
        const cancelBtn = createButton('✖ Cancel', '#f1f1f1', '#333', cleanup);
        controls.appendChild(captureBtn);
        controls.appendChild(cancelBtn);

        overlay.appendChild(selectionBox);
        overlay.appendChild(dimensionLabel);
        overlay.appendChild(controls);
        document.body.appendChild(overlay);

        overlay.addEventListener('mousedown', handleMouseDown);
        selectionBox.addEventListener('mousedown', (e) => {
            if (state !== 'idle') return;
            e.stopPropagation();
            state = 'moving';
            moveOffset.x = e.clientX - rect.x;
            moveOffset.y = e.clientY - rect.y;
            controls.style.display = 'none';
        });
        
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('keydown', handleKeyDown);
    }

    function createButton(text, bg, color, onClick) {
        const btn = document.createElement('button');
        btn.innerHTML = text;
        btn.style.cssText = `
            background: ${bg}; color: ${color};
            border: none; padding: 8px 16px; border-radius: 6px;
            cursor: pointer; font-weight: bold; font-size: 13px;
        `;
        btn.onclick = (e) => { e.stopPropagation(); onClick(); };
        return btn;
    }

    function handleMouseDown(e) {
        if (e.target !== overlay) return;
        state = 'selecting';
        startX = e.clientX;
        startY = e.clientY;
        rect = { x: startX, y: startY, w: 0, h: 0 };
        controls.style.display = 'none';
        selectionBox.style.display = 'block';
        dimensionLabel.style.display = 'block';
        overlay.style.background = 'transparent';
        updateUI();
    }

    function handleMouseMove(e) {
        if (state === 'idle') return;

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        if (state === 'selecting') {
            rect.x = Math.max(0, Math.min(startX, e.clientX));
            rect.y = Math.max(0, Math.min(startY, e.clientY));
            rect.w = Math.min(vw - rect.x, Math.abs(e.clientX - startX));
            rect.h = Math.min(vh - rect.y, Math.abs(e.clientY - startY));
            
            // Re-normalize if dragging towards negative space
            const x2 = Math.max(0, Math.min(vw, e.clientX));
            const y2 = Math.max(0, Math.min(vh, e.clientY));
            rect.x = Math.min(startX, x2);
            rect.y = Math.min(startY, y2);
            rect.w = Math.abs(x2 - startX);
            rect.h = Math.abs(y2 - startY);
        } else if (state === 'moving') {
            rect.x = Math.max(0, Math.min(vw - rect.w, e.clientX - moveOffset.x));
            rect.y = Math.max(0, Math.min(vh - rect.h, e.clientY - moveOffset.y));
        } else if (state === 'resizing') {
            const cx = Math.max(0, Math.min(vw, e.clientX));
            const cy = Math.max(0, Math.min(vh, e.clientY));
            let x1 = rect.x;
            let y1 = rect.y;
            let x2 = rect.x + rect.w;
            let y2 = rect.y + rect.h;

            if (activeHandle.includes('w')) x1 = cx;
            if (activeHandle.includes('e')) x2 = cx;
            if (activeHandle.includes('n')) y1 = cy;
            if (activeHandle.includes('s')) y2 = cy;

            rect.x = Math.min(x1, x2);
            rect.y = Math.min(y1, y2);
            rect.w = Math.abs(x2 - x1);
            rect.h = Math.abs(y2 - y1);
        }

        updateUI();
    }

    function handleMouseUp() {
        if (state === 'idle') return;
        
        if (rect.w < 10 || rect.h < 10) {
            if (state === 'selecting') {
                selectionBox.style.display = 'none';
                dimensionLabel.style.display = 'none';
                overlay.style.background = 'rgba(0, 0, 0, 0.6)';
            }
        } else {
            // Show controls
            const vwidth = window.innerWidth;
            const vheight = window.innerHeight;
            const controlsWidth = 150; // Approximated width
            
            let cLeft = rect.x;
            if (cLeft + controlsWidth > vwidth) {
                cLeft = vwidth - controlsWidth - 10;
            }
            if (cLeft < 0) cLeft = 10;

            controls.style.left = cLeft + 'px';
            controls.style.top = (rect.y + rect.h + 10 > vheight - 50) ? (rect.y - 50) + 'px' : (rect.y + rect.h + 10) + 'px';
            controls.style.display = 'flex';
        }
        
        state = 'idle';
    }

    function updateUI() {
        selectionBox.style.left = rect.x + 'px';
        selectionBox.style.top = rect.y + 'px';
        selectionBox.style.width = rect.w + 'px';
        selectionBox.style.height = rect.h + 'px';

        dimensionLabel.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}px`;
        dimensionLabel.style.left = rect.x + 'px';
        dimensionLabel.style.top = (rect.y - 25 < 0) ? (rect.y + 5) + 'px' : (rect.y - 25) + 'px';

        // Update handles
        const hs = 10;
        const half = hs / 2;
        const styles = {
            nw: { left: -half, top: -half },
            n:  { left: rect.w/2 - half, top: -half },
            ne: { left: rect.w - half, top: -half },
            w:  { left: -half, top: rect.h/2 - half },
            e:  { left: rect.w - half, top: rect.h/2 - half },
            sw: { left: -half, top: rect.h - half },
            s:  { left: rect.w/2 - half, top: rect.h - half },
            se: { left: rect.w - half, top: rect.h - half }
        };

        for (const type in styles) {
            handles[type].style.left = styles[type].left + 'px';
            handles[type].style.top = styles[type].top + 'px';
        }
    }

    function confirmSelection() {
        overlay.style.display = 'none';
        const dpr = window.devicePixelRatio || 1;

        chrome.runtime.sendMessage({
            action: 'areaSelected',
            selection: {
                x: rect.x * dpr,
                y: rect.y * dpr,
                width: rect.w * dpr,
                height: rect.h * dpr
            }
        });

        setTimeout(cleanup, 100);
    }

    function handleKeyDown(e) {
        if (e.key === 'Escape') cleanup();
    }

    function cleanup() {
        if (overlay && overlay.parentElement) {
            overlay.remove();
        }
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('keydown', handleKeyDown);
    }

    createOverlay();
})();
