/**
 * Logic for the History Gallery Page
 */
import { getHistoryFromSupabase, deleteFromSupabase } from './supabase-service.js';

const historyGrid = document.getElementById('historyGrid');
const emptyState = document.getElementById('emptyState');
const pagination = document.getElementById('pagination');
const pageInfo = document.getElementById('pageInfo');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const dateFilter = document.getElementById('dateFilter');
const tabBtns = document.querySelectorAll('.tab-btn');

// Preview Modal Elements
const previewModal = document.getElementById('mediaPreviewModal');
const previewContainer = document.getElementById('previewMediaContainer');
const previewActions = document.getElementById('previewActions');
const previewClose = document.getElementById('previewClose');

let allItems = [];
let filteredItems = [];
let currentPage = 1;
const itemsPerPage = 8;
let currentTab = 'all';

// Helper for custom modals (replaces alert/confirm)
function showCustomModal({ title, message, showInput = false, inputValue = '', primaryText = 'Confirm', secondaryText = 'Cancel' }) {
    const modal = document.getElementById('customModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalInputContainer = document.getElementById('modalInputContainer');
    const modalInput = document.getElementById('modalInput');
    const modalPrimaryBtn = document.getElementById('modalPrimaryBtn');
    const modalSecondaryBtn = document.getElementById('modalSecondaryBtn');
    const modalCloseBtn = document.getElementById('modalCloseBtn');

    if (!modal) return Promise.resolve(showInput ? inputValue : true);

    modalTitle.textContent = title;
    modalMessage.textContent = message;
    if (showInput) {
        modalInputContainer.style.display = 'block';
        modalInput.value = inputValue;
        setTimeout(() => modalInput.focus(), 100);
    } else {
        modalInputContainer.style.display = 'none';
    }
    modalPrimaryBtn.textContent = primaryText;
    modalSecondaryBtn.textContent = secondaryText;
    modalSecondaryBtn.style.display = secondaryText ? 'inline-block' : 'none';

    modal.style.display = 'flex';
    modal.classList.add('show');

    return new Promise((resolve) => {
        const cleanup = (value) => {
            modal.style.display = 'none';
            modal.classList.remove('show');
            modalPrimaryBtn.onclick = null;
            modalSecondaryBtn.onclick = null;
            modalCloseBtn.onclick = null;
            resolve(value);
        };

        modalPrimaryBtn.onclick = () => {
            if (showInput) {
                const val = modalInput.value.trim();
                if (!val) {
                    modalInput.classList.add('shake');
                    setTimeout(() => modalInput.classList.remove('shake'), 400);
                    return;
                }
                cleanup(val);
            } else {
                cleanup(true);
            }
        };

        modalInput.onkeydown = (e) => {
            if (e.key === 'Enter') modalPrimaryBtn.click();
        };

        modalSecondaryBtn.onclick = () => cleanup(false);
        modalCloseBtn.onclick = () => cleanup(false);

        modal.onclick = (e) => {
            if (e.target === modal) cleanup(false);
        };
    });
}

function toggleLoader(show, text = "Loading...") {
    const loader = document.getElementById('globalLoader');
    const loaderText = document.getElementById('loaderText');
    if (loader) {
        if (loaderText) loaderText.textContent = text;
        loader.style.display = show ? 'flex' : 'none';
        if (show) loader.classList.add('show');
    }
}

async function loadHistory() {
    try {
        toggleLoader(true);
        allItems = await getHistoryFromSupabase();
        applyFilters();
    } catch (err) {
        console.error("Error loading history:", err);
    } finally {
        toggleLoader(false);
    }
}

function applyFilters() {
    const selectedDate = dateFilter.value;

    filteredItems = allItems.filter(item => {
        const matchesTab = currentTab === 'all' || item.type === currentTab;
        const itemDate = new Date(item.timestamp).toISOString().split('T')[0];
        const matchesDate = !selectedDate || itemDate === selectedDate;
        return matchesTab && matchesDate;
    });

    currentPage = 1;
    updateTabCounts();
    renderGrid();
}

function updateTabCounts() {
    const allCount = allItems.length;
    const imageCount = allItems.filter(i => i.type === 'image').length;
    const videoCount = allItems.filter(i => i.type === 'video').length;

    document.getElementById('count-all').textContent = allCount;
    document.getElementById('count-image').textContent = imageCount;
    document.getElementById('count-video').textContent = videoCount;
}

function renderGrid() {
    historyGrid.innerHTML = '';

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedItems = filteredItems.slice(startIndex, endIndex);

    if (filteredItems.length === 0) {
        emptyState.style.display = 'block';
        historyGrid.style.display = 'none';
        pagination.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        historyGrid.style.display = 'grid';
        pagination.style.display = 'flex';

        paginatedItems.forEach(item => {
            const card = createHistoryCard(item);
            historyGrid.appendChild(card);
        });

        updatePaginationControls();
    }
}

function updatePaginationControls() {
    const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
    pageInfo.textContent = `Page ${currentPage} of ${totalPages || 1}`;
    prevPageBtn.disabled = currentPage === 1;
    nextPageBtn.disabled = currentPage >= totalPages;
}

function createHistoryCard(item) {
    const card = document.createElement('div');
    card.className = 'history-card';

    const date = new Date(item.timestamp).toLocaleDateString();
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
        <div class="card-preview">
            ${item.type === 'video'
            ? `
                <video src="${item.url}" muted loop preload="metadata"></video>
                <div class="video-overlay-icon"><i class="fas fa-play-circle"></i></div>
              `
            : `<img src="${item.url}" alt="${item.title}" loading="lazy">`
        }
        </div>
        <div class="card-info">
            <div class="card-title">${item.title}</div>
            <div class="card-meta">
                <span>${date} ${time}</span>
                <span>${(item.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
        </div>
        <div class="card-actions">
            <button class="primary copy-btn" data-url="${item.url}" title="Copy Link" ${item.type === 'video' ? 'style="display:none;"' : ''}>
                <i class="far fa-copy"></i>
            </button>
            <button class="btn-action edit-btn" title="Edit this capture" ${item.type === 'video' ? 'style="display:none;"' : ''}>
                <i class="fas fa-edit"></i>
            </button>
            <button class="btn-action download-btn" title="Download to device">
                <i class="fas fa-download"></i>
            </button>
            <button class="btn-ghost open-btn" title="Open in new tab">
                <i class="fas fa-external-link-alt"></i>
            </button>
            <button class="btn-danger delete-btn" title="Delete forever">
                <i class="fas fa-trash-alt"></i>
            </button>
        </div>
    `;

    // Preview Logic
    const previewArea = card.querySelector('.card-preview');
    if (item.type === 'video') {
        const video = previewArea.querySelector('video');
        previewArea.onmouseenter = () => video.play().catch(() => { });
        previewArea.onmouseleave = () => {
            video.pause();
            video.currentTime = 0;
        };
    }

    previewArea.onclick = () => openPreviewModal(item);

    card.querySelector('.copy-btn').onclick = async (e) => {
        const btn = e.currentTarget;
        const icon = btn.querySelector('i');
        const originalClass = icon.className;

        try {
            if (item.type === 'image') {
                // Copy the image itself to clipboard
                const response = await fetch(item.url);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ [blob.type]: blob })
                ]);
            } else {
                // Fallback for video or if copying image blob fails
                navigator.clipboard.writeText(item.url);
            }
            icon.className = 'fas fa-check';
            setTimeout(() => icon.className = originalClass, 2000);
        } catch (err) {
            console.error("Copy failed:", err);
            // Fallback to text if blob copy fails
            navigator.clipboard.writeText(item.url);
            icon.className = 'fas fa-check';
            setTimeout(() => icon.className = originalClass, 2000);
        }
    };

    card.querySelector('.open-btn').onclick = () => {
        window.open(item.url, '_blank');
    };

    card.querySelector('.download-btn').onclick = async () => {
        try {
            const response = await fetch(item.url);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const sanitizedTitle = item.title.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '_') || 'capture';
            a.download = `${sanitizedTitle}${item.type === 'video' ? '.webm' : '.png'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (err) {
            console.error("Download failed:", err);
            showCustomModal({
                title: "Error",
                message: "Failed to download file.",
                primaryText: "OK",
                secondaryText: ""
            });
        }
    };

    if (item.type !== 'video') {
        card.querySelector('.edit-btn').onclick = async () => {
            try {
                toggleLoader(true, "Preparing for edit...");
                const response = await fetch(item.url);
                const blob = await response.blob();
                const reader = new FileReader();
                reader.onload = (e) => {
                    const dataUrl = e.target.result;
                    const captureId = `cloud_${item.id}`;
                    chrome.storage.local.set({ [captureId]: dataUrl, isVideo: false }, () => {
                        window.open(`editor.html?id=${captureId}&title=${encodeURIComponent(item.title)}`, '_blank');
                        toggleLoader(false);
                    });
                };
                reader.readAsDataURL(blob);
            } catch (err) {
                console.error("Edit load failed:", err);
                toggleLoader(false);
                showCustomModal({
                    title: "Error",
                    message: "Failed to load image for editing.",
                    primaryText: "OK",
                    secondaryText: ""
                });
            }
        };
    }

    card.querySelector('.delete-btn').onclick = async (e) => {
        const confirmed = await showCustomModal({
            title: "Delete Capture",
            message: "Are you sure you want to delete this capture forever?",
            primaryText: "Delete",
            secondaryText: "Keep it"
        });

        if (!confirmed) return;

        try {
            const fileName = item.url.split('/').pop().split('?')[0]; // Handle tokens if any
            await deleteFromSupabase(fileName, item.id);

            // Immediately remove from state
            allItems = allItems.filter(i => i.id !== item.id);
            filteredItems = filteredItems.filter(i => i.id !== item.id);

            // Adjust current page if we deleted the last item of the last page
            const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
            if (currentPage > totalPages && currentPage > 1) {
                currentPage = totalPages;
            }

            card.style.transform = 'scale(0.8)';
            card.style.opacity = '0';

            setTimeout(() => {
                updateTabCounts(); // Update badges after removal
                renderGrid(); // Re-render to maintain correct item count per page
            }, 300);
        } catch (err) {
            console.error("Delete failed:", err);
            showCustomModal({
                title: "Error",
                message: "Failed to delete item.",
                primaryText: "OK",
                secondaryText: ""
            });
        }
    };

    return card;
}

function openPreviewModal(item) {
    previewContainer.innerHTML = '';
    previewActions.innerHTML = '';

    if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.autoplay = true;
        previewContainer.appendChild(video);
    } else {
        const img = document.createElement('img');
        img.src = item.url;
        previewContainer.appendChild(img);

        // Add "Copy Link" button in preview for images
        const copyLinkBtn = document.createElement('button');
        copyLinkBtn.className = 'preview-action-btn';
        copyLinkBtn.innerHTML = '<i class="far fa-copy"></i> Copy Link';
        copyLinkBtn.onclick = () => {
            navigator.clipboard.writeText(item.url);
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            copyLinkBtn.style.background = 'var(--accent-green)';
            setTimeout(() => {
                copyLinkBtn.innerHTML = '<i class="far fa-copy"></i> Copy Link';
                copyLinkBtn.style.background = '';
            }, 2000);
        };
        previewActions.appendChild(copyLinkBtn);
    }
    previewModal.classList.add('show');
}

// Close preview modal
previewClose.onclick = () => {
    previewModal.classList.remove('show');
    previewContainer.innerHTML = ''; // Stop video playback
};

previewModal.onclick = (e) => {
    if (e.target === previewModal) previewClose.onclick();
};

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewModal.classList.contains('show')) {
        previewClose.onclick();
    }
});

// Event Listeners
tabBtns.forEach(btn => {
    btn.onclick = () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTab = btn.dataset.type;
        applyFilters();
    };
});

dateFilter.onchange = applyFilters;

prevPageBtn.onclick = () => {
    if (currentPage > 1) {
        currentPage--;
        renderGrid();
        window.scrollTo(0, 0);
    }
};

nextPageBtn.onclick = () => {
    const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        renderGrid();
        window.scrollTo(0, 0);
    }
};

// Initial load
loadHistory();
