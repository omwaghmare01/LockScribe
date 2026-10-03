document.addEventListener("DOMContentLoaded", async () => {
    let vaultKey = null;
    let notes = [];
    let currentNoteId = null;
    let currentFilter = 'all';
    let saveTimeout = null;

    // Track reminders in memory to alert on schedule regardless of active filter
    const remindersCache = new Map();
    const triggeredReminders = new Set();
    let audioCtx = null;

    // DOM Elements
    const notesFeed = document.getElementById("notesFeed");
    const editorTitle = document.getElementById("editorTitle");
    const editorBody = document.getElementById("editorBody");
    const syncStatus = document.getElementById("syncStatus");
    const noteTimestamp = document.getElementById("noteTimestamp");
    const charCount = document.getElementById("charCount");
    const searchInput = document.getElementById("searchInput");
    const btnCreateNote = document.getElementById("btnCreateNote");
    const btnToggleFav = document.getElementById("btnToggleFav");
    const btnReminderToggle = document.getElementById("btnReminderToggle");
    const btnDeleteNote = document.getElementById("btnDeleteNote");
    const modal = document.getElementById("passphraseModal");
    const modalPassInput = document.getElementById("modalPasswordInput");
    const modalSubmitBtn = document.getElementById("modalSubmitBtn");

    // Reminder Modal DOM Elements
    const reminderModal = document.getElementById("reminderModal");
    const reminderDateTime = document.getElementById("reminderDateTime");
    const reminderCustomMsg = document.getElementById("reminderCustomMsg");
    const btnSaveReminder = document.getElementById("btnSaveReminder");
    const btnClearReminder = document.getElementById("btnClearReminder");
    const btnCancelReminder = document.getElementById("btnCancelReminder");
    const btnCloseReminder = document.getElementById("btnCloseReminder");
    const whatsappToastContainer = document.getElementById("whatsappToastContainer");

    // Initialize or unlock Web Audio Context upon user interaction
    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    document.addEventListener("click", () => {
        getAudioContext();
    }, { once: false });

    // 1. Vault Key Initialization
    const initVaultKey = async (passphrase) => {
        try {
            vaultKey = await CryptoEngine.deriveVaultKey(passphrase);
            sessionStorage.setItem("vault_passphrase", passphrase);
            modal.style.display = "none";
            await loadNotes(currentFilter);
            await syncAllReminders();
        } catch (e) {
            console.error("Encryption init error:", e);
            alert("Could not initialize encryption key.");
        }
    };

    const savedPass = sessionStorage.getItem("vault_passphrase");
    if (savedPass) {
        await initVaultKey(savedPass);
    } else {
        modal.style.display = "flex";
    }

    modalSubmitBtn.addEventListener("click", () => {
        const val = modalPassInput.value.trim();
        if (val) initVaultKey(val);
    });

    document.getElementById("logoutBtn").addEventListener("click", () => {
        sessionStorage.removeItem("vault_passphrase");
    });

    // 2. Load & Decrypt Notes
    async function loadNotes(filter = 'all') {
        notesFeed.innerHTML = '<div class="empty-state">Decrypting notes from cloud...</div>';
        try {
            const res = await fetch(`/api/notes?filter=${filter}`);
            const data = await res.json();

            // Client-side decryption in memory
            notes = await Promise.all(data.map(async (n) => {
                const title = await CryptoEngine.decrypt(n.encrypted_title, vaultKey);
                const content = await CryptoEngine.decrypt(n.encrypted_content, vaultKey);
                const decryptedNote = {
                    ...n,
                    title: title || "Untitled Note",
                    content: content || "",
                    reminder_msg: n.reminder_msg || ""
                };
                if (decryptedNote.reminder_at && !decryptedNote.is_trashed) {
                    remindersCache.set(decryptedNote.id, decryptedNote);
                }
                return decryptedNote;
            }));

            renderFeed(notes);
            updateBadges();

            if (notes.length > 0 && !currentNoteId) {
                selectNote(notes[0].id);
            } else if (notes.length === 0) {
                clearEditor();
            }

            checkReminders();
        } catch (err) {
            console.error("Failed to load vault:", err);
            notesFeed.innerHTML = '<div class="empty-state">Failed to load vault.</div>';
        }
    }

    // Background sync of all active reminders across the vault
    async function syncAllReminders() {
        if (!vaultKey) return;
        try {
            const res = await fetch('/api/notes?filter=reminders');
            if (res.ok) {
                const data = await res.json();
                await Promise.all(data.map(async (n) => {
                    if (n.reminder_at && !n.is_trashed) {
                        const title = await CryptoEngine.decrypt(n.encrypted_title, vaultKey);
                        const content = await CryptoEngine.decrypt(n.encrypted_content, vaultKey);
                        remindersCache.set(n.id, {
                            ...n,
                            title: title || "Untitled Note",
                            content: content || "",
                            reminder_msg: n.reminder_msg || ""
                        });
                    }
                }));
                checkReminders();
            }
        } catch (e) {
            console.warn("Could not sync background reminders:", e);
        }
    }

    // 3. Render Notes Feed Column
    function renderFeed(items) {
        if (!items || items.length === 0) {
            notesFeed.innerHTML = '<div class="empty-state">No notes found in this folder.</div>';
            return;
        }

        notesFeed.innerHTML = items.map(n => {
            // Strip HTML tags for clean preview snippet
            const temp = document.createElement("div");
            temp.innerHTML = n.content;
            const snippet = temp.textContent || temp.innerText || "Empty note...";

            const reminderTooltip = n.reminder_at
                ? (n.reminder_msg ? `Reminder: ${escapeHtml(n.reminder_msg)}` : "Reminder set")
                : "";

            return `
                <div class="note-card ${n.id === currentNoteId ? 'active' : ''}" data-id="${n.id}">
                    <h4>${escapeHtml(n.title)}</h4>
                    <p>${escapeHtml(snippet)}</p>
                    <div class="meta">
                        <span>${n.updated_at}</span>
                        <div>
                            ${n.reminder_at ? `<span title="${reminderTooltip}" style="margin-right: 4px;">🔔</span>` : ''}
                            ${n.is_favorite ? '<span>⭐</span>' : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        document.querySelectorAll('.note-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = parseInt(card.getAttribute('data-id'));
                selectNote(id);
            });
        });
    }

    // 4. Note Selection & Editor Population
    function selectNote(id) {
        currentNoteId = id;
        document.querySelectorAll('.note-card').forEach(c => {
            c.classList.toggle('active', parseInt(c.getAttribute('data-id')) === id);
        });

        const activeNote = notes.find(n => n.id === id) || remindersCache.get(id);
        if (activeNote) {
            editorTitle.value = activeNote.title === "Untitled Note" ? "" : activeNote.title;
            editorBody.innerHTML = activeNote.content;
            noteTimestamp.textContent = `Modified: ${activeNote.updated_at}`;
            updateCharCount();
            btnToggleFav.classList.toggle('active', Boolean(activeNote.is_favorite));

            updateReminderButtonState(activeNote);
            syncStatus.textContent = "Vault synchronized";
        }
    }

    function updateReminderButtonState(note) {
        if (!note || !note.reminder_at) {
            btnReminderToggle.classList.remove('active');
            btnReminderToggle.title = "Set Reminder";
        } else {
            btnReminderToggle.classList.add('active');
            const dateObj = new Date(note.reminder_at);
            const formattedTime = !isNaN(dateObj.getTime())
                ? dateObj.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : note.reminder_at;
            const msgSnippet = note.reminder_msg ? ` - "${note.reminder_msg}"` : "";
            btnReminderToggle.title = `Reminder: ${formattedTime}${msgSnippet}`;
        }
    }

    function clearEditor() {
        currentNoteId = null;
        editorTitle.value = "";
        editorBody.innerHTML = "";
        noteTimestamp.textContent = "No note selected";
        charCount.textContent = "0 characters";
        syncStatus.textContent = "Vault empty";
        btnToggleFav.classList.remove('active');
        btnReminderToggle.classList.remove('active');
        btnReminderToggle.title = "Set Reminder";
    }

    // Switch view to open a specific note even if current filter doesn't contain it
    async function openAndSelectNote(noteId) {
        const found = notes.find(n => n.id === noteId);
        if (!found) {
            document.querySelectorAll('.menu-item').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-filter') === 'all');
            });
            currentFilter = 'all';
            await loadNotes('all');
        }
        selectNote(noteId);
    }

    // 5. Debounced Autosave Engine (Encrypted Push)
    function triggerAutoSave() {
        syncStatus.textContent = "Encrypting & saving...";
        clearTimeout(saveTimeout);

        saveTimeout = setTimeout(async () => {
            if (!currentNoteId || !vaultKey) return;

            const plainTitle = editorTitle.value.trim() || "Untitled Note";
            const plainContent = editorBody.innerHTML;

            const encTitle = await CryptoEngine.encrypt(plainTitle, vaultKey);
            const encContent = await CryptoEngine.encrypt(plainContent, vaultKey);

            try {
                const res = await fetch(`/api/notes/${currentNoteId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        encrypted_title: encTitle,
                        encrypted_content: encContent
                    })
                });

                if (res.ok) {
                    syncStatus.textContent = "All changes encrypted";
                    const idx = notes.findIndex(n => n.id === currentNoteId);
                    if (idx !== -1) {
                        notes[idx].title = plainTitle;
                        notes[idx].content = plainContent;
                        renderFeed(notes);
                    }
                    if (remindersCache.has(currentNoteId)) {
                        const rNote = remindersCache.get(currentNoteId);
                        rNote.title = plainTitle;
                        rNote.content = plainContent;
                    }
                }
            } catch (e) {
                syncStatus.textContent = "Sync failed. Retry pending.";
            }
        }, 700);
    }

    editorTitle.addEventListener('input', () => { triggerAutoSave(); updateCharCount(); });
    editorBody.addEventListener('input', () => { triggerAutoSave(); updateCharCount(); });

    // 6. Create New Note
    btnCreateNote.addEventListener('click', async () => {
        if (!vaultKey) return;
        syncStatus.textContent = "Creating secure note...";

        const encTitle = await CryptoEngine.encrypt("Untitled Note", vaultKey);
        const encContent = await CryptoEngine.encrypt("", vaultKey);

        const res = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encrypted_title: encTitle, encrypted_content: encContent })
        });

        if (res.ok) {
            const data = await res.json();
            const newNote = { ...data, title: "Untitled Note", content: "", reminder_msg: "" };
            notes.unshift(newNote);
            renderFeed(notes);
            selectNote(newNote.id);
            editorTitle.focus();
            updateBadges();
        }
    });

    // 7. Toggle Favorite
    btnToggleFav.addEventListener('click', async () => {
        if (!currentNoteId) return;
        const note = notes.find(n => n.id === currentNoteId);
        if (!note) return;

        const newFavState = !note.is_favorite;
        const res = await fetch(`/api/notes/${currentNoteId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_favorite: newFavState })
        });

        if (res.ok) {
            note.is_favorite = newFavState;
            btnToggleFav.classList.toggle('active', newFavState);
            renderFeed(notes);
            updateBadges();
        }
    });

    // 8. Reminder Modal & Action Handlers
    function closeReminderModal() {
        reminderModal.style.display = "none";
    }

    btnReminderToggle.addEventListener('click', () => {
        if (!currentNoteId) return;
        const note = notes.find(n => n.id === currentNoteId) || remindersCache.get(currentNoteId);
        if (!note) return;

        // Request browser Notification permission on modal open
        if ("Notification" in window && Notification.permission === "default") {
            Notification.requestPermission();
        }

        // Populate fields with existing data
        reminderDateTime.value = note.reminder_at || "";
        reminderCustomMsg.value = note.reminder_msg || "";

        // Set min datetime to current local time
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        reminderDateTime.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

        // Toggle clear button display
        btnClearReminder.style.display = note.reminder_at ? "inline-flex" : "none";

        reminderModal.style.display = "flex";
        if (note.reminder_at) {
            reminderCustomMsg.focus();
        } else {
            reminderDateTime.focus();
        }
    });

    btnCancelReminder.addEventListener('click', closeReminderModal);
    btnCloseReminder.addEventListener('click', closeReminderModal);

    reminderModal.addEventListener('click', (e) => {
        if (e.target === reminderModal) {
            closeReminderModal();
        }
    });

    // Save Reminder
    btnSaveReminder.addEventListener('click', async () => {
        if (!currentNoteId) return;
        const note = notes.find(n => n.id === currentNoteId) || remindersCache.get(currentNoteId);
        if (!note) return;

        const timeVal = reminderDateTime.value;
        const msgVal = reminderCustomMsg.value.trim();

        if (!timeVal) {
            alert("Please choose a date and time for the reminder.");
            reminderDateTime.focus();
            return;
        }

        // Request permission if not already granted
        if ("Notification" in window && Notification.permission === "default") {
            await Notification.requestPermission();
        }

        try {
            const res = await fetch(`/api/notes/${currentNoteId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reminder_at: timeVal,
                    reminder_msg: msgVal
                })
            });

            if (res.ok) {
                const updated = await res.json();
                note.reminder_at = updated.reminder_at;
                note.reminder_msg = updated.reminder_msg || "";

                remindersCache.set(note.id, note);
                triggeredReminders.delete(note.id);

                updateReminderButtonState(note);
                renderFeed(notes);
                updateBadges();
                closeReminderModal();
            } else {
                alert("Failed to save reminder.");
            }
        } catch (e) {
            console.error("Error saving reminder:", e);
            alert("Network error while saving reminder.");
        }
    });

    // Clear Reminder
    btnClearReminder.addEventListener('click', async () => {
        if (!currentNoteId) return;
        const note = notes.find(n => n.id === currentNoteId) || remindersCache.get(currentNoteId);
        if (!note) return;

        try {
            const res = await fetch(`/api/notes/${currentNoteId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reminder_at: null,
                    reminder_msg: ""
                })
            });

            if (res.ok) {
                note.reminder_at = null;
                note.reminder_msg = "";
                remindersCache.delete(note.id);
                triggeredReminders.delete(note.id);

                updateReminderButtonState(note);

                if (currentFilter === 'reminders') {
                    notes = notes.filter(n => n.id !== currentNoteId);
                    renderFeed(notes);
                    if (notes.length > 0) {
                        selectNote(notes[0].id);
                    } else {
                        clearEditor();
                    }
                } else {
                    renderFeed(notes);
                }

                updateBadges();
                closeReminderModal();
            } else {
                alert("Failed to clear reminder.");
            }
        } catch (e) {
            console.error("Error clearing reminder:", e);
            alert("Network error while clearing reminder.");
        }
    });

    // 9. Sound & Notification Delivery
    function playNotificationSound() {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;

            const now = ctx.currentTime;

            // Tone 1: D5 (587.33 Hz)
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(587.33, now);
            gain1.gain.setValueAtTime(0, now);
            gain1.gain.linearRampToValueAtTime(0.2, now + 0.03);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.start(now);
            osc1.stop(now + 0.28);

            // Tone 2: A5 (880 Hz)
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(880, now + 0.1);
            gain2.gain.setValueAtTime(0, now + 0.1);
            gain2.gain.linearRampToValueAtTime(0.25, now + 0.13);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.start(now + 0.1);
            osc2.stop(now + 0.55);
        } catch (e) {
            console.warn("Audio chime playback failed:", e);
        }
    }

    function showDesktopNotification(note) {
        const title = `⏰ Reminder: ${note.title || 'Untitled Note'}`;
        const body = note.reminder_msg || "You have a reminder for this note!";

        if ("Notification" in window && Notification.permission === "granted") {
            try {
                const notif = new Notification(title, {
                    body: body,
                    icon: "/static/favicon.ico",
                    tag: `reminder-${note.id}-${Date.now()}`
                });
                notif.onclick = () => {
                    window.focus();
                    openAndSelectNote(note.id);
                };
            } catch (err) {
                console.warn("Desktop Notification error:", err);
            }
        }
    }

    function showWhatsAppToast(note) {
        if (!whatsappToastContainer) return;

        const toast = document.createElement("div");
        toast.className = "whatsapp-toast";

        const displayTitle = note.title || "Untitled Note";
        const displayMsg = note.reminder_msg || "You have a reminder for this note!";
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        toast.innerHTML = `
            <div class="wa-header">
                <div class="wa-badge"><i class="fa-solid fa-bell"></i></div>
                <span class="wa-app-title">LockScribe Reminder</span>
                <span class="wa-time">${timeStr}</span>
                <button class="wa-close-btn" title="Dismiss">&times;</button>
            </div>
            <div class="wa-body">
                <div class="wa-note-title">⏰ Reminder: ${escapeHtml(displayTitle)}</div>
                <div class="wa-note-msg">${escapeHtml(displayMsg)}</div>
            </div>
            <div class="wa-footer">
                <button class="wa-action-btn wa-dismiss-btn">Dismiss</button>
                <button class="wa-action-btn wa-primary-action wa-open-btn"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open Note</button>
            </div>
        `;

        const dismiss = () => {
            toast.classList.add("hiding");
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        };

        toast.querySelector(".wa-close-btn").addEventListener("click", dismiss);
        toast.querySelector(".wa-dismiss-btn").addEventListener("click", dismiss);
        toast.querySelector(".wa-open-btn").addEventListener("click", () => {
            dismiss();
            openAndSelectNote(note.id);
        });

        whatsappToastContainer.appendChild(toast);

        // Auto dismiss after 12 seconds
        setTimeout(dismiss, 12000);
    }

    async function triggerReminder(note) {
        if (triggeredReminders.has(note.id)) return;
        triggeredReminders.add(note.id);

        // 1. Play sound
        playNotificationSound();

        // 2. Trigger native OS / Browser Notification
        showDesktopNotification(note);

        // 3. Show WhatsApp-style desktop popup toast
        showWhatsAppToast(note);

        // 4. Mark reminder as triggered/cleared in the note and update server
        try {
            await fetch(`/api/notes/${note.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reminder_at: null,
                    reminder_msg: ""
                })
            });
        } catch (e) {
            console.error("Failed to clear triggered reminder on server:", e);
        }

        // 5. Update local state
        note.reminder_at = null;
        note.reminder_msg = "";
        remindersCache.delete(note.id);

        if (currentNoteId === note.id) {
            updateReminderButtonState(note);
        }

        if (currentFilter === 'reminders') {
            notes = notes.filter(n => n.id !== note.id);
            renderFeed(notes);
            if (currentNoteId === note.id) {
                notes.length > 0 ? selectNote(notes[0].id) : clearEditor();
            }
        } else {
            renderFeed(notes);
        }

        updateBadges();
    }

    // 10. Background Interval Timer (runs every 10-15 seconds)
    function checkReminders() {
        if (!vaultKey) return;
        const now = new Date();

        const candidateMap = new Map();
        remindersCache.forEach((n, id) => candidateMap.set(id, n));
        notes.forEach(n => {
            if (n.reminder_at && !n.is_trashed) {
                candidateMap.set(n.id, n);
            }
        });

        candidateMap.forEach(note => {
            if (!note.reminder_at || note.is_trashed) return;
            const reminderTime = new Date(note.reminder_at);
            if (!isNaN(reminderTime.getTime()) && now >= reminderTime) {
                triggerReminder(note);
            }
        });
    }

    // Check reminders every 12 seconds
    setInterval(checkReminders, 12000);

    // 11. Delete / Trash Note
    btnDeleteNote.addEventListener('click', async () => {
        if (!currentNoteId) return;

        if (currentFilter === 'trash') {
            if (confirm("Permanently erase this note from database?")) {
                await fetch(`/api/notes/${currentNoteId}`, { method: 'DELETE' });
                remindersCache.delete(currentNoteId);
                notes = notes.filter(n => n.id !== currentNoteId);
                renderFeed(notes);
                notes.length > 0 ? selectNote(notes[0].id) : clearEditor();
            }
        } else {
            // Soft delete: move to trash
            await fetch(`/api/notes/${currentNoteId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_trashed: true, reminder_at: null, reminder_msg: "" })
            });
            remindersCache.delete(currentNoteId);
            notes = notes.filter(n => n.id !== currentNoteId);
            renderFeed(notes);
            notes.length > 0 ? selectNote(notes[0].id) : clearEditor();
            updateBadges();
        }
    });

    // 12. Sidebar Navigation Filters
    document.querySelectorAll('.menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.getAttribute('data-filter');
            loadNotes(currentFilter);
        });
    });

    // 13. Local Fast Search Filter
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = notes.filter(n =>
            n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query)
        );
        renderFeed(filtered);
    });

    // 14. Formatting Toolbar Exec Commands
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const command = btn.getAttribute('data-command');
            document.execCommand(command, false, null);
            editorBody.focus();
            triggerAutoSave();
        });
    });

    // Utilities
    function updateCharCount() {
        const text = editorBody.innerText || "";
        charCount.textContent = `${text.trim().length} characters`;
    }

    function updateBadges() {
        const countAll = document.getElementById("countAll");
        const countFav = document.getElementById("countFav");
        const countReminders = document.getElementById("countReminders");
        if (countAll) countAll.textContent = notes.length;
        if (countFav) countFav.textContent = notes.filter(n => n.is_favorite).length;

        let remCount = 0;
        const activeIds = new Set();
        notes.forEach(n => {
            if (n.reminder_at && !n.is_trashed) activeIds.add(n.id);
        });
        remindersCache.forEach((n, id) => {
            if (n.reminder_at && !n.is_trashed) activeIds.add(id);
        });
        if (countReminders) countReminders.textContent = activeIds.size;
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    async function setupWebPush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        try {
            const reg = await navigator.serviceWorker.register('/static/sw.js');
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;

            const res = await fetch('/api/vapid-key');
            const { publicKey } = await res.json();
            if (!publicKey) return;

            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                const padding = '='.repeat((4 - publicKey.length % 4) % 4);
                const base64 = (publicKey + padding).replace(/\-/g, '+').replace(/_/g, '/');
                const rawData = window.atob(base64);
                const keyArray = Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));

                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: keyArray
                });
            }

            await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub)
            });
        } catch (err) {
            console.error("Push registration error:", err);
        }
    }

    window.addEventListener('DOMContentLoaded', setupWebPush);
});