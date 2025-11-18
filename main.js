const { Plugin, ItemView, TFolder, TFile, setIcon, Notice, Modal, Menu, debounce, MarkdownView, PluginSettingTab, Setting } = require('obsidian');

class CustomSortableFileExplorerView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.collapsedFolders = this.plugin.settings.collapsedFolders || {};
        this.currentDropIndicator = null;
        this.currentParentIndicator = null;
        this.currentDropIndicatorPosition = null;
        this.activeFilePath = null;
    this.handleActiveLeafChange = this.handleActiveLeafChange.bind(this);
    this.handleFileOpen = this.handleFileOpen.bind(this);
        this.debouncedRefresh = debounce(this.onOpen.bind(this), 300, false);
        // Centralized refresh gate to optionally coalesce or skip a refresh
        this._suppressNextRefresh = false;
        this.requestRefresh = (source = 'unknown') => {
            try {
                if (this._suppressNextRefresh) { this._suppressNextRefresh = false; return; }
                this.debouncedRefresh();
            } catch (_) { this.debouncedRefresh(); }
        };
        // Debounced settings saver to avoid excessive disk writes during rapid UI interactions
        this.saveSettingsDebounced = debounce(() => {
            try { this.plugin.saveData(this.plugin.settings); } catch (_) {}
        }, 250, true);
        // Performance/state flags
        this.eventsBound = false; // avoid duplicate global listeners across onOpen()
        this._dragFrame = null;   // rAF id for throttling dragover
        this._dragQueue = null;   // queued dragover job
        this._dragData = null;    // cached drag data for faster access during drag
    this._dragging = false;   // true while a drag originated from this view is active
        // Multi-select state
        this.selectedPaths = new Set();
        this.lastAnchorPath = null; // anchor for shift-range selection
        // One-time DOM/key bindings flags
        this._focusMousedownBound = false;
        this._deleteKeysBound = false;
        this._navKeysBound = false;
    }

    // Pragmatic fallback: try to mirror selection into core file explorer DOM and run native move
    openNativeMoveDialogForSelection() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        const fileExplorerLeaf = leaves && leaves.length ? leaves[0] : null;
        if (!fileExplorerLeaf) {
            new Notice('File Explorer is not available');
            return;
        }

        // Attempt to apply CSS selection to matching items in core explorer DOM so menu reflects count
        try {
            const container = fileExplorerLeaf.view?.containerEl;
            if (container) {
                // Clear existing core selection
                container.querySelectorAll('.nav-file-title.is-selected, .nav-folder-title.is-selected')
                    .forEach(el => el.classList.remove('is-selected'));
                // Apply selection to each corresponding DOM node
                for (const p of this.selectedPaths) {
                    const sel = container.querySelector(`.nav-file-title[data-path="${CSS.escape(p)}"], .nav-folder-title[data-path="${CSS.escape(p)}"]`);
                    if (sel) sel.classList.add('is-selected');
                }
            }
        } catch (_) {}

        // Focus file explorer and invoke its move command which opens the default dialog
        this.app.workspace.activeLeaf = fileExplorerLeaf;
        const cmdId = 'file-explorer:move-file';
        if (this.app.commands?.commands?.[cmdId]) {
            this.app.commands.executeCommandById(cmdId);
        } else {
            new Notice('Move command not available');
        }
    }

    // Utility: return array of visible item elements in current order
    getVisibleItemElements() {
        if (!this.contentEl) return [];
        return Array.from(this.contentEl.querySelectorAll('.nav-folder-title, .nav-file-title'));
    }

    // Utility: sync selected CSS
    updateSelectionStyles() {
        if (!this.contentEl) return;
        this.contentEl.querySelectorAll('.nav-folder-title.is-selected, .nav-file-title.is-selected')
            .forEach(el => el.classList.remove('is-selected'));
        for (const path of this.selectedPaths) {
            const el = this.contentEl.querySelector(`[data-path="${CSS.escape(path)}"]`);
            if (el) el.classList.add('is-selected');
        }
    }

    // Throttle expensive dragover logic to once per animation frame
    scheduleDragOver(handler) {
        return (e) => {
            try { e.preventDefault(); } catch (_) {}
            try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (_) {}

            const self = this;
            const clonedEvent = {
                clientX: e.clientX,
                clientY: e.clientY,
                target: e.target,
                dataTransfer: {
                    dropEffect: 'move',
                    getData: () => JSON.stringify(self._dragData || {}),
                },
                preventDefault: () => {},
            };

            const job = { handler, event: clonedEvent };
            if (this._dragFrame) {
                this._dragQueue = job; // keep latest
                return;
            }
            this._dragFrame = requestAnimationFrame(() => {
                this._dragFrame = null;
                // If a drag just ended, skip any queued dragover work
                if (!this._dragging) { this._dragQueue = null; return; }
                const run = this._dragQueue || job;
                this._dragQueue = null;
                try { run.handler(run.event); } catch (err) { console.error('dragover handler error', err); }
            });
        };
    }

    // Cancel any pending rAF work related to throttled dragover
    cancelDragOverThrottle() {
        try {
            if (this._dragFrame) cancelAnimationFrame(this._dragFrame);
        } catch (_) {}
        this._dragFrame = null;
        this._dragQueue = null;
    }

    handleActiveLeafChange(leaf) {
        // Do not clear highlight when switching to this view; always use the actual active file
        const active = this.app.workspace.getActiveFile();
        this.activeFilePath = active ? active.path : null;
        this.updateActiveFileHighlight();
    }

    handleFileOpen(file) {
        // Triggered when a file is opened (e.g., from global search results)
        this.activeFilePath = file ? file.path : null;
        this.updateActiveFileHighlight();
    }

    updateActiveFileHighlight() {
        if (!this.contentEl) return;
        const prev = this.contentEl.querySelectorAll('.nav-file-title.is-active');
        prev.forEach(el => el.classList.remove('is-active'));
        if (!this.activeFilePath) return;
        const activeEl = this.contentEl.querySelector(`.nav-file-title[data-path="${CSS.escape(this.activeFilePath)}"]`);
        if (activeEl) activeEl.classList.add('is-active');
    }

    getViewType() {
        return 'my-file-explorer-view';
    }

    getDisplayText() {
        return 'Sortable File Explorer';
    }

    getIcon() {
        return 'folder';
    }

    async onOpen() {
        // Preserve scroll position before we rebuild the explorer
        const prevScrollTop = this.explorerEl?.scrollTop ?? this._pendingScrollTop ?? 0;
        this._pendingScrollTop = prevScrollTop;

        // Avoid clearing the entire container to reduce blink; keep toolbar and swap explorer offscreen
        this.contentEl.addClass('file-explorer-container');
        this.contentEl.style.position = 'relative';
        // Respect icon visibility preference
        if (this.plugin?.settings?.showIcons === false) this.contentEl.addClass('hide-icons');
        else this.contentEl.removeClass('hide-icons');
    // Toggle base badge visibility class (CSS also requires icons to be hidden)
    if (this.plugin?.settings?.showBaseBadge) this.contentEl.addClass('show-base-badge');
    else this.contentEl.removeClass('show-base-badge');
        // Outline target mode class
        const mode = this.plugin?.settings?.outlineMode || 'focused';
        this.contentEl.toggleClass('outline-mode-viewed', mode === 'viewed');
        this.contentEl.toggleClass('outline-mode-focused', mode !== 'viewed');
        // Apply outline color CSS variables
        const setVar = (k, v) => { try { this.contentEl.style.setProperty(k, v); } catch (_) {} };
        const useCustom = !!(this.plugin?.settings?.useCustomOutlineColor);
        const outlineColor = useCustom ? (this.plugin?.settings?.outlineColor || '') : '';
        if (outlineColor) {
            setVar('--sfe-outline-color', outlineColor);
            // derive secondary 60% alpha if hex #RRGGBB
            const m = /^#([0-9a-fA-F]{6})$/.exec(outlineColor);
            if (m) {
                const hex = m[1];
                const r = parseInt(hex.slice(0,2), 16);
                const g = parseInt(hex.slice(2,4), 16);
                const b = parseInt(hex.slice(4,6), 16);
                setVar('--sfe-outline-color-secondary', `rgba(${r}, ${g}, ${b}, 0.6)`);
                // soft fill used for viewed-mode selection shading
                setVar('--sfe-accent-fill', `rgba(${r}, ${g}, ${b}, 0.15)`);
            }
        } else {
            // Use Obsidian's vanilla file explorer style (neutral grey border)
            // We intentionally set the CSS var to a theme variable so it adapts to light/dark themes.
            setVar('--sfe-outline-color', 'var(--background-modifier-border)');
            // Secondary/accent fill: keep soft hover-like shading when needed
            setVar('--sfe-outline-color-secondary', 'var(--background-modifier-border)');
            setVar('--sfe-accent-fill', 'var(--nav-item-background-hover)');
        }
        // Make container focusable so we can capture key events when user interacts here
        try { this.contentEl.setAttr('tabindex', '0'); } catch (_) { this.contentEl.tabIndex = 0; }
        // Focus the view when user clicks inside so Delete keys work as expected
        if (!this._focusMousedownBound) {
            this.registerDomEvent(this.contentEl, 'mousedown', () => { try { this.contentEl.focus(); } catch (_) {} });
            this._focusMousedownBound = true;
        }

        // Build toolbar (reuse if exists) and prepare a hidden new explorer to swap in
        this.renderToolbar();
        const newExplorer = this.contentEl.createDiv({ cls: 'file-explorer-scroll' });
        try { newExplorer.style.visibility = 'hidden'; } catch (_) {}

        await this.cleanupDeletedPaths();
        this.collapsedFolders = this.plugin.settings.collapsedFolders || {};

        let activeFile = this.app.workspace.getActiveFile();
        this.activeFilePath = activeFile ? activeFile.path : null;

        // Build offscreen to avoid visual blink, then swap in
        this.buildFileExplorer(newExplorer);
        const oldExplorer = this.explorerEl && this.explorerEl.isConnected ? this.explorerEl : null;
        try { newExplorer.style.visibility = ''; } catch (_) {}
        if (oldExplorer && oldExplorer !== newExplorer) {
            try { oldExplorer.remove(); } catch (_) {}
        }
        this.explorerEl = newExplorer;
        this.updateActiveFileHighlight();

        // Restore previous scroll position after the DOM is laid out
        const restoreScroll = () => {
            try {
                if (this.explorerEl && typeof this._pendingScrollTop === 'number') {
                    this.explorerEl.scrollTop = this._pendingScrollTop;
                }
            } finally {
                this._pendingScrollTop = undefined;
            }
        };
        // Use two RAFs to ensure layout/height is computed before restoring
        requestAnimationFrame(() => requestAnimationFrame(restoreScroll));

        // Bind global events only once to avoid duplicates when onOpen() is called again
        if (!this.eventsBound) {
            this.registerEvent(
                this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange)
            );
            this.registerEvent(
                this.app.workspace.on('file-open', this.handleFileOpen)
            );
            this.registerEvent(this.app.vault.on('create', () => this.requestRefresh('create')));
            this.registerEvent(this.app.vault.on('delete', () => this.requestRefresh('delete')));
            this.registerEvent(this.app.vault.on('rename', () => this.requestRefresh('rename')));
            this.eventsBound = true;
        }

        // Bind keyboard delete shortcuts when this view is focused
        if (!this._deleteKeysBound) {
            this.bindDeleteShortcuts();
            this._deleteKeysBound = true;
        }

        // Bind navigation and action shortcuts (arrows, Enter, F2, etc.) when view is focused
        if (!this._navKeysBound) {
            this.bindNavigationShortcuts();
            this._navKeysBound = true;
        }
    }

    renderToolbar() {
        if (!this.toolbarEl) {
            this.toolbarEl = this.contentEl.createDiv({ cls: 'file-explorer-toolbar' });
        } else {
            this.toolbarEl.empty();
        }

        const makeBtn = (icon, title, onClick) => {
            const btn = this.toolbarEl.createDiv({ cls: 'file-explorer-btn', attr: { 'aria-label': title, 'title': title } });
            setIcon(btn, icon);
            btn.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
            return btn;
        };

        // New note (respects core default new note location)
        makeBtn('edit', 'New note', () => this.createAndOpenNewNote());
        // New folder at root
        makeBtn('folder-plus', 'New folder', () => this.startNewFolderCreation(this.app.vault.getRoot()));
        // Collapse all
        makeBtn('chevrons-down-up', 'Collapse all', () => this.expandOrCollapseAll(true));
        // Expand all
        makeBtn('chevrons-up-down', 'Expand all', () => this.expandOrCollapseAll(false));

    }

    // Create a new note in the given folder, open it, and select the title (first) line
    async createAndOpenNewNote(folder) {
        try {
            // If no folder is provided, honor the user's default new note location
            const targetFolder = folder ?? this.getDefaultNewFileFolder();
            const newFile = await this.app.fileManager.createNewFile(targetFolder);
            if (!(newFile instanceof TFile)) return;
            // Open in the current tab (vanilla Obsidian behavior). Prefer unpinned leaf.
            let leaf = this.getPreferredCurrentLeaf();
            await leaf.openFile(newFile, { active: true });
            this.app.workspace.revealLeaf(leaf);

            // Robustly select the title line, even if other plugins (e.g., Templates) inject content after open
            await this.ensureTitleLineSelected(leaf, newFile);
        } catch (err) {
            console.error('Failed to create/open new note', err);
            new Notice('Failed to create new note');
        }
    }

    // Choose the best leaf to open in the current tab, respecting pinning when possible
    getPreferredCurrentLeaf() {
        const ws = this.app.workspace;
        try {
            if (typeof ws.getUnpinnedLeaf === 'function') {
                // Use existing unpinned leaf if available; avoid forcing a split/tab creation
                const l = ws.getUnpinnedLeaf('tab');
                if (l) return l;
            }
        } catch (_) {}
        try {
            if (typeof ws.getMostRecentLeaf === 'function') {
                const l = ws.getMostRecentLeaf();
                if (l) return l;
            }
        } catch (_) {}
        // Fallbacks in case APIs vary by version
        return ws.getLeaf ? ws.getLeaf() : ws.getLeaf(false);
    }

    // Resolve the folder for new notes based on core settings
    getDefaultNewFileFolder() {
        const vault = this.app.vault;
        const getCfg = typeof vault.getConfig === 'function' ? (k) => vault.getConfig(k) : (k) => vault?.config?.[k];
        const location = getCfg ? getCfg('newFileLocation') : undefined; // 'vault' | 'current' | 'folder'

        // Helper to resolve paths to TFolder
        const resolveFolder = (path) => {
            const af = path ? this.app.vault.getAbstractFileByPath(path) : null;
            return (af instanceof TFolder) ? af : this.app.vault.getRoot();
        };

        if (location === 'current') {
            const active = this.app.workspace.getActiveFile();
            return active?.parent instanceof TFolder ? active.parent : this.app.vault.getRoot();
        }
        if (location === 'folder') {
            const folderPath = getCfg ? (getCfg('newFileFolderPath') || '') : '';
            return resolveFolder(folderPath);
        }
        // Default: vault root
        return this.app.vault.getRoot();
    }

    // Poll briefly for the Markdown editor to be available on the given leaf
    async waitForEditorOnLeaf(leaf, maxTries = 20, delayMs = 50) {
        for (let i = 0; i < maxTries; i++) {
            const view = leaf?.view;
            if (view instanceof MarkdownView && view.editor) return view.editor;
            await new Promise((r) => setTimeout(r, delayMs));
        }
        return null;
    }

    // Determine the title line to highlight: first heading after YAML frontmatter,
    // else the first non-empty line; fallback to the first line.
    findTitleLineIndex(editor) {
        try {
            const lineCount = editor.lineCount ? editor.lineCount() : editor.lastLine() + 1;
            if (!lineCount) return 0;
            let idx = 0;
            // Skip YAML frontmatter if present
            if ((editor.getLine(0) || '').trim() === '---') {
                idx = 1;
                while (idx < lineCount) {
                    if ((editor.getLine(idx) || '').trim() === '---') { idx++; break; }
                    idx++;
                }
            }
            // Scan for first heading line
            for (let i = idx; i < lineCount; i++) {
                const t = (editor.getLine(i) || '').trim();
                if (t.startsWith('#')) return i;
            }
            // Otherwise first non-empty line
            for (let i = idx; i < lineCount; i++) {
                const t = (editor.getLine(i) || '').trim();
                if (t.length > 0) return i;
            }
            return 0;
        } catch (_) { return 0; }
    }

    // Try multiple times to select the inline title (preferred) or the first content line
    async ensureTitleLineSelected(leaf, file, tries = 5, delayMs = 80) {
        const editor = await this.waitForEditorOnLeaf(leaf);
        if (!editor) return;
        const view = leaf?.view;
        // Stop any reselection as soon as the user starts typing
        let userInteracted = false;
        const keydownHandler = () => { userInteracted = true; };
        try { view?.containerEl?.addEventListener('keydown', keydownHandler, { once: true, capture: true }); } catch (_) {}
        // Track last known text snapshot to detect changes during initial file creation
        let lastLineCount = editor.lineCount ? editor.lineCount() : (editor.lastLine ? editor.lastLine() + 1 : 0);
        const selectInlineTitle = () => this.trySelectInlineTitle(view);
        const selectEditorTitleLine = () => {
            const titleLine = this.findTitleLineIndex(editor);
            const titleText = editor.getLine(titleLine) ?? '';
            try { editor.setSelection({ line: titleLine, ch: 0 }, { line: titleLine, ch: titleText.length }); } catch (_) {}
            try { editor.focus(); } catch (_) {}
        };
        const selectNow = () => {
            if (userInteracted) return;
            // Prefer selecting the inline title if visible/enabled; fallback to editor selection
            if (!selectInlineTitle()) selectEditorTitleLine();
        };
        selectNow();
        
        // Re-apply briefly only when content changes and user hasn't typed
        for (let i = 0; i < tries; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            if (userInteracted) break;
            const lc = editor.lineCount ? editor.lineCount() : (editor.lastLine ? editor.lastLine() + 1 : 0);
            if (lc !== lastLineCount) {
                lastLineCount = lc;
                selectNow();
            }
        }

        // Also listen briefly for file modify events (e.g., Templates plugin saving content)
        try {
            let modifiesHandled = 0;
            let active = true;
            const ref = this.app.vault.on('modify', (f) => {
                try {
                    if (!active) return;
                    if (userInteracted) return;
                    if (f && file && f.path === file.path) {
                        modifiesHandled++;
                        if (modifiesHandled <= 2) selectNow();
                    }
                } catch (_) {}
            });
            // Auto-clean after a short window
            setTimeout(() => {
                active = false;
                try { if (typeof this.app.vault.offref === 'function') this.app.vault.offref(ref); } catch (_) {}
            }, 2000);
            // Ensure lifecycle cleanup as a fallback
            try { this.registerEvent(ref); } catch (_) {}
        } catch (_) {}
        // Clean once done
        try { view?.containerEl?.removeEventListener('keydown', keydownHandler, { capture: true }); } catch (_) {}
    }

    // Attempt to select the inline title (if enabled). Returns true if selection applied.
    trySelectInlineTitle(view) {
        try {
            const container = view?.containerEl || view?.contentEl || document;
            if (!container) return false;
            const titleEl = container.querySelector('.inline-title');
            if (!titleEl || titleEl.offsetParent === null) return false; // hidden
            // Some themes/plugins wrap inline title; prefer inner contenteditable if present
            const target = titleEl.querySelector('[contenteditable="true"], .inline-title') || titleEl;
            // Select all contents
            const range = document.createRange();
            range.selectNodeContents(target);
            const sel = window.getSelection();
            if (!sel) return false;
            sel.removeAllRanges();
            sel.addRange(range);
            // Focus last to avoid selection cleared by focus change
            target.focus({ preventScroll: false });
            // Make sure it's visible
            try { titleEl.scrollIntoView({ block: 'nearest' }); } catch (_) {}
            return true;
        } catch (_) { return false; }
    }

    async expandOrCollapseAll(collapse) {
        const root = this.app.vault.getRoot();
        const walk = (folder) => {
            if (!folder || !(folder instanceof TFolder)) return;
            if (collapse) this.collapsedFolders[folder.path] = true;
            else delete this.collapsedFolders[folder.path];
            (folder.children || []).forEach(child => { if (child instanceof TFolder) walk(child); });
        };
        walk(root);
        this.plugin.settings.collapsedFolders = this.collapsedFolders;
        await this.plugin.saveData(this.plugin.settings);
        await this.onOpen();
    }

    ensureFolderExpanded(folderPath, domRefs = {}) {
        if (!folderPath) return;
        const { titleEl = null, childrenEl = null, collapseEl = null } = domRefs;
        let changed = false;
        if (this.collapsedFolders && this.collapsedFolders[folderPath]) {
            delete this.collapsedFolders[folderPath];
            changed = true;
        }
        this.plugin.settings.collapsedFolders = this.collapsedFolders;
        if (changed) this.saveSettingsDebounced();

        const resolvedTitle = titleEl ?? this.contentEl?.querySelector(`.nav-folder-title[data-path="${CSS.escape(folderPath)}"]`);
        const resolvedChildren = childrenEl ?? resolvedTitle?.nextElementSibling;
        const resolvedCollapse = collapseEl ?? resolvedTitle?.querySelector('.nav-folder-collapse-indicator');

        if (resolvedChildren) {
            if (typeof resolvedChildren.removeClass === 'function') resolvedChildren.removeClass('is-collapsed');
            else resolvedChildren.classList?.remove('is-collapsed');
        }
        if (resolvedCollapse) {
            if (typeof resolvedCollapse.removeClass === 'function') resolvedCollapse.removeClass('is-collapsed');
            else resolvedCollapse.classList?.remove('is-collapsed');
        }
    }

    async buildFileExplorer(container) {
        container.empty();
        // Reset render index for consistent ordering each rebuild
        this._renderIndex = 0;
        const rootFolder = this.app.vault.getRoot();
        this.setupContainerDropZone(container);
        this.setupContainerContextMenu(container);
    const children = (rootFolder.children || []).filter(c => !this.shouldIgnore(c));
    const sortedChildren = this.sortItems(children);

        sortedChildren.forEach(child => {
            if (child instanceof TFolder) {
                this.renderFolder(container, child, 0);
            } else {
                this.renderFile(container, child, 0);
            }
        });
        // Re-apply selection styling after rendering
        this.updateSelectionStyles();
    }

    setupContainerDropZone(container) {
        // Use non-throttled handler here to preserve precise hit-testing over container whitespace vs items
        container.addEventListener('dragover', (event) => {
            // Allow drop feedback during drag
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

            // Detect external drags (from Finder/Explorer)
            const dt = event.dataTransfer;
            const hasFilesList = !!(dt && dt.files && dt.files.length > 0);
            const hasFilesType = !!(dt && Array.from(dt.types || []).includes('Files'));
            const isExternal = hasFilesList || hasFilesType;

            // Refresh cached drag data if available (covers drags not started in our view)
            try {
                if (!isExternal && event.dataTransfer?.types?.includes('text/plain')) {
                    const raw = event.dataTransfer.getData('text/plain');
                    if (raw) {
                        const data = JSON.parse(raw);
                        if (data && (this._dragData?.path !== data.path || this._dragData?.type !== data.type)) {
                            this._dragData = data;
                        }
                    }
                }
            } catch (_) {}

            const containerRect = container.getBoundingClientRect();
            const relativeX = event.clientX - containerRect.left;
            const relativeY = event.clientY - containerRect.top;

            const el = document.elementFromPoint(event.clientX, event.clientY);
            const overFolderTitle = el?.closest('.nav-folder-title');
            const overFileTitle = el?.closest('.nav-file-title');
            const overItem = overFolderTitle || overFileTitle;
            const isWhitespace = !overItem;

            if (isExternal) {
                // For external drags, highlight the exact folder that will receive the files.
                //  - If over a folder row: highlight that folder
                //  - If over a file row: highlight its parent folder
                //  - If over whitespace/left gutter: highlight root
                // Clear previous highlights first
                this.contentEl?.querySelectorAll('.is-drag-over-folder').forEach(el => el.removeClass('is-drag-over-folder'));
                this.clearParentFolderHighlight();

                if (overFolderTitle && overFolderTitle.hasAttribute('data-path')) {
                    overFolderTitle.addClass('is-drag-over-folder');
                    return;
                }

                if (overFileTitle && overFileTitle.hasAttribute('data-path')) {
                    const filePath = overFileTitle.getAttribute('data-path') || '';
                    const parentPath = filePath.lastIndexOf('/') > -1 ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
                    if (parentPath) {
                        const parentFolderEl = this.contentEl.querySelector(`.nav-folder-title[data-path="${CSS.escape(parentPath)}"]`);
                        if (parentFolderEl) {
                            parentFolderEl.addClass('is-drag-over-folder');
                            return;
                        }
                    }
                    // No parent folder row (root) -> highlight root
                    this.showParentFolderDropZone(null);
                    return;
                }

                // Whitespace or left gutter => root highlight
                if (relativeX < 30 || isWhitespace) {
                    this.showParentFolderDropZone(null);
                    return;
                }
            }

            // Internal drag handling below
            // If cursor is directly over an existing drop indicator, treat it as a valid reordering zone
            let overIndicator = false;
            if (this.currentDropIndicator) {
                const indRect = this.currentDropIndicator.getBoundingClientRect();
                // Allow a small vertical tolerance so it's easy to hit the line
                if (event.clientY >= indRect.top - 3 && event.clientY <= indRect.bottom + 3) {
                    overIndicator = true;
                }
            }

            if (overIndicator) {
                // Prevent container root highlight while over the indicator line
                this.clearParentFolderHighlight();
                return; // Let the indicator stand; reordering logic handled on drop
            }

            if (relativeX < 30 || isWhitespace) {
                // Outline the vault (root drop zone)
                this.showParentFolderDropZone(null);
                return;
            }
        });

        container.addEventListener('dragenter', (event) => {
            if (!event.target.closest('.nav-folder-title, .nav-file-title')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }
        });

        container.addEventListener('dragleave', (event) => {
            const rect = container.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
                this.clearParentFolderHighlight();
                // Also clear any per-folder hover highlights when leaving the explorer entirely
                this.contentEl?.querySelectorAll('.is-drag-over-folder').forEach(el => el.removeClass('is-drag-over-folder'));
            }
        });

    container.addEventListener('drop', async (event) => {
        // A drop has occurred anywhere in this container; finalize drag state and ensure cleanup
        this._dragging = false;
        this.cancelDragOverThrottle();
            const containerRect = container.getBoundingClientRect();
            const relativeX = event.clientX - containerRect.left;
            const relativeY = event.clientY - containerRect.top;

            // Check if we're in whitespace (matching dragover condition)
            const el = document.elementFromPoint(event.clientX, event.clientY);
            const overItem = el?.closest('.nav-folder-title, .nav-file-title');
            const isWhitespace = !overItem;

            // Finder/native file drop support
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                event.preventDefault();
                this.clearDropIndicators();
                this.clearParentFolderHighlight();

                // Find the folder under the mouse, or vault root if in whitespace
                let targetFolderPath = null;
                const folderTitle = el?.closest('.nav-folder-title');
                const isBottomWhitespace = !overItem && (relativeY > container.scrollHeight - 40 || relativeY > containerRect.height - 40);
                if (folderTitle && folderTitle.hasAttribute('data-path')) {
                    targetFolderPath = folderTitle.getAttribute('data-path');
                } else if (relativeX < 30 || isBottomWhitespace) {
                    // If on left edge or bottom whitespace, drop to vault root
                    targetFolderPath = this.app.vault.getRoot().path || '';
                } else {
                    // If not over a folder, default to vault root
                    targetFolderPath = this.app.vault.getRoot().path || '';
                }

                // Get the TFolder object
                let targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath);
                if (!(targetFolder instanceof TFolder)) {
                    targetFolder = this.app.vault.getRoot();
                }

                // For each file dropped, read and create in vault
                for (const file of event.dataTransfer.files) {
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        const filePath = targetFolder.path ? `${targetFolder.path}/${file.name}` : file.name;
                        await this.app.vault.createBinary(filePath, arrayBuffer);
                    } catch (err) {
                        new Notice(`Failed to import file: ${file.name}`);
                    }
                }
                return;
            }

            // For Obsidian-internal drag and drop
            // Root drop takes precedence: match dragover condition exactly (left edge OR any whitespace)
            const isRootDrop = (relativeX < 30) || isWhitespace;
            if (isRootDrop) {
                event.preventDefault();
                this.clearDropIndicators();
                this.clearParentFolderHighlight();
                try {
                    const dataTxt = event.dataTransfer.getData('text/plain');
                    const dragData = dataTxt ? JSON.parse(dataTxt) : {};
                    const paths = dragData.paths || (dragData.path ? [dragData.path] : []);

                    // Move all items to root first, tracking their new paths
                    const movedPaths = [];
                    for (const p of paths) {
                        const file = this.app.vault.getAbstractFileByPath(p);
                        if (!file) continue;
                        const newPath = file.name;
                        await this.moveToParentFolder(p, '');
                        movedPaths.push(newPath);
                    }

                    // Top vs bottom intention: near top 40px OR left edge + near top => top; otherwise bottom
                    const isTopArea = (relativeY < 40);
                    const root = this.app.vault.getRoot();
                    const rootChildren = this.sortItems((root.children || []).filter(c => !this.shouldIgnore(c)));
                    const first = rootChildren[0]?.path;
                    const last = rootChildren[rootChildren.length - 1]?.path;
                    if (rootChildren.length > 0 && (first || last)) {
                        if (isTopArea && first) {
                            for (const p of movedPaths) {
                                await this.reorderItems(p, first, true);
                            }
                        } else if (last) {
                            let anchor = last;
                            for (const p of movedPaths) {
                                await this.reorderItems(p, anchor, false);
                                anchor = p;
                            }
                        }
                    }
                } catch (error) {
                    new Notice('Error during drag and drop operation');
                }
                return;
            }

            // If dropping directly over an indicator line, perform reorder instead of root move
            if (this.currentDropIndicator) {
                const indRect = this.currentDropIndicator.getBoundingClientRect();
                if (event.clientY >= indRect.top - 3 && event.clientY <= indRect.bottom + 3) {
                    event.preventDefault();
                    this.clearParentFolderHighlight();
                    try {
                        const dragData = JSON.parse(event.dataTransfer.getData('text/plain'));
                        const targetPath = this.currentDropIndicator.dataset.targetPath;
                        if (targetPath) {
                            const insertBefore = this.currentDropIndicator.dataset.insertBefore === 'true';
                            const getParentPath = (p) => p.lastIndexOf('/') > -1 ? p.substring(0, p.lastIndexOf('/')) : '';
                            const paths = dragData.paths || (dragData.path ? [dragData.path] : []);
                            const targetParent = getParentPath(targetPath);
                            const movedPaths = [];
                            for (const p of paths) {
                                const isFolder = this.app.vault.getAbstractFileByPath(p) instanceof TFolder;
                                if (isFolder && targetParent && (targetParent === p || targetParent.startsWith(p + '/'))) {
                                    new Notice('Cannot move folder into itself or its children');
                                    continue;
                                }
                                const sp = getParentPath(p);
                                if (sp !== targetParent) {
                                    if (isFolder) await this.moveFolderToFolder(p, targetParent);
                                    else await this.moveFileToFolder(p, targetParent);
                                    const name = p.substring(p.lastIndexOf('/') + 1);
                                    movedPaths.push(targetParent ? `${targetParent}/${name}` : name);
                                } else {
                                    movedPaths.push(p);
                                }
                            }
                            let anchorPath = targetPath;
                            for (const p of movedPaths) {
                                await this.reorderItems(p, anchorPath, insertBefore);
                                if (!insertBefore) anchorPath = p;
                            }
                        }
                    } catch (error) {
                        new Notice('Error during drag and drop operation');
                    }
                    this.clearDropIndicators();
                    return;
                }
            }

            // Drop to root if on left edge, bottom whitespace, or any whitespace (not over an item)
            if (relativeX < 30 || isBottomWhitespace || !overItem) {
                event.preventDefault();
                this.clearDropIndicators();
                this.clearParentFolderHighlight();
                try {
                    const dataTxt = event.dataTransfer.getData('text/plain');
                    const dragData = dataTxt ? JSON.parse(dataTxt) : {};
                    const paths = dragData.paths || (dragData.path ? [dragData.path] : []);

                    // Move all items to root first, tracking their new paths
                    const movedPaths = [];
                    for (const p of paths) {
                        const file = this.app.vault.getAbstractFileByPath(p);
                        if (!file) continue;
                        const newPath = file.name; // root path is just the name
                        await this.moveToParentFolder(p, '');
                        movedPaths.push(newPath);
                    }

                    // Determine top vs bottom intent
                    const isTopWhitespace = !overItem && (relativeY < 40);

                    // Identify current first/last item in root (post-move)
                    const root = this.app.vault.getRoot();
                    const rootChildren = this.sortItems((root.children || []).filter(c => !this.shouldIgnore(c)));
                    const first = rootChildren[0]?.path;
                    const last = rootChildren[rootChildren.length - 1]?.path;

                    if (rootChildren.length > 0 && (first || last)) {
                        if (isTopWhitespace && first) {
                            // Insert each moved path before the first item to preserve order [X,Y,...,first,...]
                            for (const p of movedPaths) {
                                await this.reorderItems(p, first, true);
                            }
                        } else if (last) {
                            // Append to bottom, stacking after the last/previous inserted
                            let anchor = last;
                            for (const p of movedPaths) {
                                await this.reorderItems(p, anchor, false);
                                anchor = p;
                            }
                        }
                    }
                } catch (error) {
                    new Notice('Error during drag and drop operation');
                }
                return;
            }
        });
    }

    // Respect the user's trash preference when deleting files/folders
    async trashItem(item) {
        try {
            const vault = this.app.vault;
            const getCfg = typeof vault.getConfig === 'function' ? (k) => vault.getConfig(k) : (k) => vault?.config?.[k];
            const trashOption = getCfg ? getCfg('trashOption') : undefined;
            if (trashOption === 'system') {
                await vault.trash(item, true);
            } else if (trashOption === 'none') {
                // Permanent delete
                await vault.delete(item);
            } else {
                // Default/local Obsidian trash (.trash folder)
                await vault.trash(item, false);
            }
        } catch (err) {
            console.error('Failed to delete/trash item', err);
            new Notice('Failed to delete item');
        }
    }

    // Try to use the native File Explorer delete flow so the exact Obsidian dialog appears
    openNativeDeleteDialogForSelection(paths) {
        try {
            const leaves = this.app.workspace.getLeavesOfType('file-explorer');
            const fileExplorerLeaf = leaves && leaves.length ? leaves[0] : null;
            if (!fileExplorerLeaf) return false;

            const container = fileExplorerLeaf.view?.containerEl;
            if (!container) return false;

            // Clear existing core selection in explorer DOM
            container
                .querySelectorAll('.nav-file-title.is-selected, .nav-folder-title.is-selected')
                .forEach(el => {
                    el.classList.remove('is-selected');
                    try { el.setAttr('aria-selected', 'false'); } catch (_) {}
                });

            // Apply selection for each target path
            for (const p of paths || []) {
                const sel = container.querySelector(
                    `.nav-file-title[data-path="${CSS.escape(p)}"], .nav-folder-title[data-path="${CSS.escape(p)}"]`
                );
                if (sel) {
                    sel.classList.add('is-selected');
                    try { sel.setAttr('aria-selected', 'true'); } catch (_) {}
                }
            }

            // Bring explorer to focus
            this.app.workspace.activeLeaf = fileExplorerLeaf;

            // Dynamically discover the correct delete command id
            const commands = this.app.commands?.commands || {};
            const candidates = Object.keys(commands).filter(id => id.startsWith('file-explorer:') && /delete/i.test(id));
            const cmdId = candidates[0] || 'file-explorer:delete' || 'file-explorer:delete-file';
            if (commands[cmdId]) {
                this.app.commands.executeCommandById(cmdId);
                return true;
            }
        } catch (_) {}
        return false;
    }

    // Check the core setting for delete confirmation. Default to true if absent.
    shouldConfirmDeletion() {
        try {
            const vault = this.app.vault;
            const getCfg = typeof vault.getConfig === 'function' ? (k) => vault.getConfig(k) : (k) => vault?.config?.[k];
            const keys = ['promptDelete', 'confirmDelete', 'promptForFileDeletion', 'confirmFileDeletion'];
            for (const k of keys) {
                const v = getCfg ? getCfg(k) : undefined;
                if (typeof v === 'boolean') return v;
            }
        } catch (_) {}
        return true;
    }

    // Lightweight confirm modal returning a boolean
    confirmAction({ title = 'Confirm', message, confirmLabel = 'OK' } = {}) {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            try { modal.titleEl.setText(title); } catch (_) {}
            const content = modal.contentEl.createDiv();
            content.createEl('p', { text: message || '' });
            const buttons = content.createDiv({ cls: 'modal-button-container' });
            const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
            const okBtn = buttons.createEl('button', { text: confirmLabel });
            okBtn.addClass('mod-warning');
            cancelBtn.addEventListener('click', () => { modal.close(); resolve(false); });
            okBtn.addEventListener('click', () => { modal.close(); resolve(true); });
            modal.onClose = () => resolve(false);
            modal.open();
        });
    }

    // Delete/trash multiple items with optional confirmation based on settings
    async trashItems(items) {
        const valid = (items || []).filter(Boolean);
        if (valid.length === 0) return;
        // If core fileManager prompt is available, prefer it to show the native dialog
        const fm = this.app.fileManager;
        if (fm && typeof fm.promptForDeletion === 'function') {
            if (valid.length === 1) {
                try { await fm.promptForDeletion(valid[0]); } catch (_) {}
                this.selectedPaths.clear();
                this.updateSelectionStyles();
                return;
            } else {
                // Attempt native multi-delete via explorer; otherwise prompt per item
                const paths = valid.map(v => v.path);
                if (this.openNativeDeleteDialogForSelection(paths)) return;
                for (const it of valid) {
                    try { await fm.promptForDeletion(it); } catch (_) {}
                }
                this.selectedPaths.clear();
                this.updateSelectionStyles();
                return;
            }
        }
        const vault = this.app.vault;
        const getCfg = typeof vault.getConfig === 'function' ? (k) => vault.getConfig(k) : (k) => vault?.config?.[k];
        const trashOption = getCfg ? getCfg('trashOption') : undefined;
        const permanent = trashOption === 'none';

        if (this.shouldConfirmDeletion()) {
            const fileCount = valid.filter(x => x instanceof TFile).length;
            const folderCount = valid.filter(x => x instanceof TFolder).length;
            const parts = [];
            if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
            if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
            const what = parts.length ? parts.join(' and ') : `${valid.length} item${valid.length === 1 ? '' : 's'}`;
            const actionText = permanent ? 'permanently delete' : 'move to trash';
            const title = permanent ? 'Permanently delete?' : 'Move to trash?';
            const confirmLabel = permanent ? 'Delete' : 'Move to Trash';
            const message = `Are you sure you want to ${actionText} ${what}?`;
            const ok = await this.confirmAction({ title, message, confirmLabel });
            if (!ok) return;
        }

        for (const it of valid) {
            await this.trashItem(it);
        }
        // Clear selection after deletion to avoid stale highlights
        this.selectedPaths.clear();
        this.updateSelectionStyles();
    }

    // Central deletion entry-point to call from UI actions
    async deleteUsingCoreOrFallback(paths) {
        const items = (paths || []).map(p => this.app.vault.getAbstractFileByPath(p)).filter(Boolean);
        if (items.length === 0) return;
        const fm = this.app.fileManager;
        if (fm && typeof fm.promptForDeletion === 'function') {
            if (items.length === 1) {
                await fm.promptForDeletion(items[0]);
                this.selectedPaths.clear();
                this.updateSelectionStyles();
                return;
            }
            if (this.openNativeDeleteDialogForSelection(paths)) return;
            for (const it of items) { await fm.promptForDeletion(it); }
            this.selectedPaths.clear();
            this.updateSelectionStyles();
            return;
        }
        await this.trashItems(items);
    }

    setupContainerContextMenu(container) {
        container.addEventListener('contextmenu', (event) => {
            // Only show menu if clicking on empty space, not on a file or folder
            if (event.target === container ||
                (!event.target.closest('.nav-folder-title') && !event.target.closest('.nav-file-title'))) {
                event.preventDefault();
                event.stopPropagation();

                const menu = new Menu(this.app);
                const rootFolder = this.app.vault.getRoot();
                const fileExplorerLeaf = this.app.workspace.getLeavesOfType("file-explorer")?.[0] ?? null;

                // If the user has a multi-selection (files/folders/mixed), show the restricted multi menu here too
                if (this.selectedPaths && this.selectedPaths.size > 1) {
                    const handled = this.buildMultiSelectionMenu(menu);
                    if (handled) {
                        if (menu.items.length > 0) menu.showAtMouseEvent(event);
                        return;
                    }
                }

                this.app.workspace.trigger("folder-menu", menu, rootFolder, "file-explorer", fileExplorerLeaf);
                this.app.workspace.trigger("file-menu", menu, rootFolder, "file-explorer", fileExplorerLeaf);

                const hasItem = (title) => menu.items.some(i => i.title && i.title.toLowerCase().includes(title.toLowerCase()));

                if (!hasItem('New note')) {
                    menu.addItem((i) => {
                        i.setTitle("New note")
                            .setIcon("edit")
                            .setSection("new")
                            .onClick(() => {
                                // Respect the Default location for new notes setting
                                this.createAndOpenNewNote();
                            });
                    });
                }

                if (!hasItem('New folder')) {
                    menu.addItem((i) => {
                        i.setTitle("New folder")
                            .setIcon("folder-plus")
                            .setSection("new")
                            .onClick(() => {
                                this.startNewFolderCreation(rootFolder);
                            });
                    });
                }

                if (!hasItem('New canvas')) {
                    menu.addItem((i) => {
                        i.setTitle("New canvas")
                            .setIcon("layout-dashboard")
                            .setSection("new")
                            .onClick(async () => {
                                const canvasPath = 'Untitled.canvas';
                                const existingFile = this.app.vault.getAbstractFileByPath(canvasPath);
                                if (!existingFile) {
                                    const newFile = await this.app.vault.create(canvasPath, '');
                                    if (newFile instanceof TFile) {
                                        await this.app.workspace.getLeaf().openFile(newFile);
                                    }
                                } else {
                                    new Notice("Canvas file already exists");
                                }
                            });
                    });
                }

                // Remove duplicate 'New note' entry that referenced an undefined variable in this scope

                const sectionOrder = ['new', 'open', 'action', 'export', 'copy', 'system', 'info', 'danger'];
                menu.items.sort((a, b) => {
                    const sectionA = a.section || 'action';
                    const sectionB = b.section || 'action';
                    const indexA = sectionOrder.indexOf(sectionA);
                    const indexB = sectionOrder.indexOf(sectionB);

                    if (indexA === -1 && indexB === -1) return 0;
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;

                    return indexA - indexB;
                });

                if (menu.items.length > 0) {
                    menu.showAtMouseEvent(event);
                }
            }
        });
    }

    renderFolder(parentEl, folder, depth = 0) {
        const folderEl = parentEl.createDiv('nav-folder');
        const folderTitle = folderEl.createDiv('nav-folder-title');
        folderTitle.setAttribute('data-path', folder.path);
        // Assign a monotonically increasing render index to preserve visual order
        folderTitle.dataset.order = (this._renderIndex = (this._renderIndex || 0) + 1).toString();
        folderTitle.style.paddingLeft = `${8 + (depth * 16)}px`;
        const collapseEl = folderTitle.createDiv('nav-folder-collapse-indicator');
        setIcon(collapseEl, 'right-triangle');
        const iconEl = folderTitle.createDiv('nav-folder-icon');
        setIcon(iconEl, 'folder');
        folderTitle.createDiv('nav-folder-title-content').setText(folder.name);
        folderTitle.setAttribute('draggable', 'true');
        this.setupDragAndDrop(folderTitle, folder);
        this.setupContextMenu(folderTitle, folder);
    const children = (folder.children || []).filter(c => !this.shouldIgnore(c));
    const sortedChildren = this.sortItems(children);
        const folderContent = folderEl.createDiv('nav-folder-children');
        sortedChildren.forEach(child => {
            if (child instanceof TFolder) {
                this.renderFolder(folderContent, child, depth + 1);
            } else {
                this.renderFile(folderContent, child, depth + 1);
            }
        });
        if (this.collapsedFolders[folder.path]) {
            folderContent.addClass('is-collapsed');
            collapseEl.addClass('is-collapsed');
        }
        folderTitle.addEventListener('click', async (event) => {
            // Do nothing while inline rename is active on this item
            if (folderTitle.getAttribute('data-renaming') === 'true') return;
            const isShift = event.shiftKey;
            const isMod = event.metaKey || event.ctrlKey;
            const modAction = (this.plugin?.settings?.modifierAction) || 'openNewTab';
            const path = folder.path;

            if (isShift || (isMod && modAction === 'selectMultiple')) {
                event.preventDefault();
                if (isShift && this.lastAnchorPath) {
                    const items = this.getVisibleItemElements();
                    const indexOf = (p) => items.findIndex(el => el.getAttribute('data-path') === p);
                    const a = indexOf(this.lastAnchorPath);
                    const b = indexOf(path);
                    if (a !== -1 && b !== -1) {
                        const [start, end] = a < b ? [a, b] : [b, a];
                        for (let i = start; i <= end; i++) {
                            const p = items[i].getAttribute('data-path');
                            this.selectedPaths.add(p);
                        }
                    }
                } else if (isMod && modAction === 'selectMultiple') {
                    if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
                    else this.selectedPaths.add(path);
                    this.lastAnchorPath = path;
                }
                if (this.selectedPaths.size === 0) this.selectedPaths.add(path);
                this.lastAnchorPath = this.lastAnchorPath || path;
                this.updateSelectionStyles();
                return;
            }
            if (event.target.closest('.nav-folder-collapse-indicator, .nav-folder-title-content, .nav-folder-icon') || event.target === folderTitle) {
                // Single-select on folder click without modifiers
                this.selectedPaths.clear();
                this.lastAnchorPath = path;
                this.selectedPaths.add(path);
                this.updateSelectionStyles();
                const collapsed = !folderContent.hasClass('is-collapsed');
                folderContent.toggleClass('is-collapsed', collapsed);
                collapseEl.toggleClass('is-collapsed', collapsed);
                if (collapsed) this.collapsedFolders[folder.path] = true;
                else delete this.collapsedFolders[folder.path];
                this.plugin.settings.collapsedFolders = this.collapsedFolders;
                // Use debounced save to avoid frequent writes when toggling multiple folders quickly
                this.saveSettingsDebounced();
            }
        });
    }

    renderFile(parentEl, file, depth = 0) {
        const fileEl = parentEl.createDiv('nav-file');
        const fileTitle = fileEl.createDiv('nav-file-title');
        fileTitle.setAttribute('data-path', file.path);
        fileTitle.dataset.order = (this._renderIndex = (this._renderIndex || 0) + 1).toString();
        fileTitle.style.paddingLeft = `${20 + (depth * 16)}px`;
        const iconEl = fileTitle.createDiv('nav-file-icon');
        this.setFileIcon(iconEl, file);
        fileTitle.createDiv('nav-file-title-content').setText(this.getFileDisplayName(file));
        // Show a small "BASE" badge like core explorer when icons are hidden
        try {
            const ext = (file instanceof TFile) ? (file.extension || '') : '';
            if (ext === 'base') {
                const badge = fileTitle.createDiv({ cls: 'file-badge file-badge-base', text: 'BASE' });
                fileTitle.addClass('has-ext-badge');
            }
        } catch (_) {}
        if (this.activeFilePath && file.path === this.activeFilePath) {
            fileTitle.classList.add('is-active');
        }
        fileTitle.setAttribute('draggable', 'true');
        this.setupDragAndDrop(fileTitle, file);
        this.setupContextMenu(fileTitle, file);
        fileTitle.addEventListener('click', async (event) => {
            // Ignore clicks while renaming to allow caret moves inside the input
            if (fileTitle.getAttribute('data-renaming') === 'true') return;
            const isShift = event.shiftKey;
            const isMod = event.metaKey || event.ctrlKey;
            const modAction = (this.plugin?.settings?.modifierAction) || 'openNewTab';
            const path = file.path;
            const isActive = (this.activeFilePath === path);

            if (isShift || (isMod && modAction === 'selectMultiple')) {
                event.preventDefault();
                if (isShift && this.lastAnchorPath) {
                    const items = this.getVisibleItemElements();
                    const indexOf = (p) => items.findIndex(el => el.getAttribute('data-path') === p);
                    const a = indexOf(this.lastAnchorPath);
                    const b = indexOf(path);
                    if (a !== -1 && b !== -1) {
                        const [start, end] = a < b ? [a, b] : [b, a];
                        for (let i = start; i <= end; i++) {
                            const p = items[i].getAttribute('data-path');
                            this.selectedPaths.add(p);
                        }
                    }
                } else if (isMod && modAction === 'selectMultiple') {
                    if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
                    else this.selectedPaths.add(path);
                    this.lastAnchorPath = path;
                }
                if (this.selectedPaths.size === 0) this.selectedPaths.add(path);
                this.lastAnchorPath = this.lastAnchorPath || path;
                this.updateSelectionStyles();
                return;
            }

            // If user preference is to open in new tab on Cmd/Ctrl-click
            if (isMod && modAction === 'openNewTab') {
                event.preventDefault();
                // Update selection to the clicked file
                this.selectedPaths.clear();
                this.lastAnchorPath = path;
                this.selectedPaths.add(path);
                this.updateSelectionStyles();
                await this.app.workspace.getLeaf('tab').openFile(file);
                return;
            }

            // No modifiers
            event.preventDefault();

            if (isActive) {
                // Second click focuses and selects the active file (outline appears if configured)
                this.selectedPaths.clear();
                this.lastAnchorPath = path;
                this.selectedPaths.add(path);
                this.updateSelectionStyles();
                try { this.contentEl.focus(); } catch (_) {}
                return;
            }

            // First click on a different file: open it without selecting (background only)
            this.selectedPaths.clear();
            this.updateSelectionStyles();
            await this.app.workspace.getLeaf().openFile(file);
        });
    }

    // Determine how to display file names based on settings
    getFileDisplayName(file) {
        try {
            const hide = !!this.plugin?.settings?.hideFileExtensions;
            if (hide && file instanceof TFile) return file.basename;
        } catch (_) {}
        return file.name;
    }

    // *** MODIFIED: Added icons for .base and .canvas files ***
    setFileIcon(iconEl, file) {
        const extension = file.extension;
        let iconName = 'document'; // Default icon
        if (extension === 'md') iconName = 'document';
        else if (extension === 'canvas') iconName = 'layout-dashboard';
        else if (extension === 'base') iconName = 'layout-list';
        else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(extension)) iconName = 'image';
        else if (['mp4', 'webm', 'mov'].includes(extension)) iconName = 'film';
        else if (['mp3', 'wav', 'ogg'].includes(extension)) iconName = 'audio-file';
        else if (extension === 'pdf') iconName = 'file-text';
        else if (['zip', 'rar', '7z'].includes(extension)) iconName = 'archive';
        setIcon(iconEl, iconName);
    }

    startInlineRename(item) {
        const isFolder = item instanceof TFolder;
        const itemEl = this.contentEl.querySelector(`[data-path="${CSS.escape(item.path)}"]`);
        if (!itemEl) return;

        const titleContentEl = itemEl.querySelector('.nav-file-title-content, .nav-folder-title-content');
        if (!titleContentEl) return;

    titleContentEl.style.display = 'none';

    // Mark item as being renamed and disable dragging during rename
    const prevDraggable = itemEl.getAttribute('draggable') ?? '';
    itemEl.dataset.prevDraggable = prevDraggable;
    itemEl.setAttribute('draggable', 'false');
    itemEl.setAttribute('data-renaming', 'true');

    const input = createEl('input', { type: 'text', cls: 'nav-item-rename' });
        input.value = item.name;

        const iconEl = itemEl.querySelector('.nav-file-icon, .nav-folder-icon');
        iconEl.insertAdjacentElement('afterend', input);

    // Prevent input interactions from bubbling to parent (which could open files or toggle folders)
    const stop = (e) => { e.stopPropagation(); };
    input.addEventListener('mousedown', stop);
    input.addEventListener('pointerdown', stop);
    input.addEventListener('click', stop);
    input.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });

    input.focus();
        if (!isFolder) {
            const extensionIndex = item.name.lastIndexOf('.');
            const selectionEnd = (extensionIndex > 0 && extensionIndex > item.name.length - 5) ? extensionIndex : item.name.length;
            input.setSelectionRange(0, selectionEnd);
        } else {
            input.select();
        }

        let committed = false;
        const finishEdit = async (commit) => {
            if (committed) return;
            committed = true;

            const newName = input.value.trim();
            input.remove();
            titleContentEl.style.display = '';

            // Restore drag/rename flags
            if (itemEl.dataset.prevDraggable !== '') itemEl.setAttribute('draggable', itemEl.dataset.prevDraggable);
            else itemEl.removeAttribute('draggable');
            delete itemEl.dataset.prevDraggable;

            if (commit && newName && newName !== item.name) {
                const parentPath = item.parent.path === '/' ? '' : item.parent.path;
                await this.app.fileManager.renameFile(item, `${parentPath}/${newName}`);
            }
            
            // Remove renaming flag AFTER rename completes to prevent click events from toggling collapse state
            itemEl.removeAttribute('data-renaming');
        };

    input.addEventListener('blur', () => finishEdit(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
            }
        });
    }

    startNewFolderCreation(parentFolder) {
        let childrenContainer;

        if (parentFolder.isRoot()) {
            childrenContainer = this.contentEl;
        } else {
            const parentEl = this.contentEl.querySelector(`.nav-folder-title[data-path="${CSS.escape(parentFolder.path)}"]`);
            childrenContainer = parentEl?.nextElementSibling;

            if (!childrenContainer) return;

            const collapseIcon = parentEl?.querySelector('.nav-folder-collapse-indicator') || null;
            this.ensureFolderExpanded(parentFolder.path, {
                titleEl: parentEl,
                childrenEl: childrenContainer,
                collapseEl: collapseIcon,
            });
        }

        const tempFolderEl = childrenContainer.createDiv({ cls: 'nav-folder' });
        const tempTitleEl = tempFolderEl.createDiv({ cls: 'nav-folder-title' });

        const depth = parentFolder.isRoot() ? 0 : (parentFolder.path.match(/\//g) || []).length + 1;
        tempTitleEl.style.paddingLeft = `${8 + (depth * 16)}px`;

        setIcon(tempTitleEl.createDiv({ cls: 'nav-folder-icon' }), 'folder');
        const input = tempTitleEl.createEl('input', { type: 'text', cls: 'nav-item-rename' });

        input.focus();

        let committed = false;
        const finishEdit = async (commit) => {
            if (committed) return;
            committed = true;

            const newName = input.value.trim();
            tempFolderEl.remove();

            if (commit && newName) {
                const newFolderPath = parentFolder.isRoot() ? newName : `${parentFolder.path}/${newName}`;
                await this.app.vault.createFolder(newFolderPath);
                if (!parentFolder.isRoot()) this.ensureFolderExpanded(parentFolder.path);
            }
        };

        input.addEventListener('blur', () => finishEdit(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
            }
        });
    }

    // *** ADDED: New method to create .base files ***
    async createNewBaseFile(folder) {
        const defaultContent = 'views:\n  - type: table\n    name: Table\n';
        let baseName = 'Untitled';
        let filePath = folder.isRoot() ? `${baseName}.base` : `${folder.path}/${baseName}.base`;
        let counter = 0;

        // Find a unique file name to avoid overwriting existing files
        while (this.app.vault.getAbstractFileByPath(filePath)) {
            counter++;
            baseName = `Untitled ${counter}`;
            filePath = folder.isRoot() ? `${baseName}.base` : `${folder.path}/${baseName}.base`;
        }

        try {
            const newFile = await this.app.vault.create(filePath, defaultContent);
            // Open the new base file in a new leaf for immediate use
            await this.app.workspace.getLeaf(true).openFile(newFile);
        } catch (error) {
            new Notice('Failed to create new base file.');
            console.error("Error creating new base file:", error);
        }
    }

    setupContextMenu(element, item) {
        element.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();

            const menu = new Menu(this.app);
            const fileExplorerLeaf = this.app.workspace.getLeavesOfType("file-explorer")?.[0] ?? null;

            // Selection behavior: if multiple selected and right-click on one of them, keep selection.
            // If right-click on an unselected item, reset selection to that item only.
            const path = item.path;
            if (!this.selectedPaths.has(path)) {
                this.selectedPaths.clear();
                this.selectedPaths.add(path);
                this.lastAnchorPath = path;
                this.updateSelectionStyles();
            }

            // If multi-selection (files/folders/mixed), show the restricted 4-option menu
            if (this.selectedPaths && this.selectedPaths.size > 1) {
                const handled = this.buildMultiSelectionMenu(menu);
                if (handled) { menu.showAtMouseEvent(event); return; }
            }

            if (item instanceof TFile) {
                this.app.workspace.trigger("file-menu", menu, item, "file-explorer", fileExplorerLeaf);
            } else if (item instanceof TFolder) {
                this.app.workspace.trigger("folder-menu", menu, item, "file-explorer", fileExplorerLeaf);
                this.app.workspace.trigger("file-menu", menu, item, "file-explorer", fileExplorerLeaf);
            }

            const hasItem = (title) => menu.items.some(i => i.title && i.title.toLowerCase().includes(title.toLowerCase()));

            if (item instanceof TFile) {
                if (!hasItem('Open in new tab')) {
                    menu.addItem((i) => {
                        i.setTitle("Open in new tab")
                            .setIcon("file-plus")
                            .setSection("open")
                            .onClick(() => this.app.workspace.getLeaf('tab').openFile(item));
                    });
                }

                if (!hasItem('Open to the right')) {
                    menu.addItem((i) => {
                        i.setTitle("Open to the right")
                            .setIcon("separator-vertical")
                            .setSection("open")
                            .onClick(() => this.app.workspace.getLeaf('split').openFile(item));
                    });
                }

                if (!hasItem('Duplicate')) {
                    menu.addItem((i) => {
                        i.setTitle("Duplicate")
                            .setIcon("copy")
                            .setSection("action")
                            .onClick(() => {
                                const dir = item.parent.path;
                                const baseName = item.basename;
                                const extension = item.extension;
                                let copyName = `${baseName} copy.${extension}`;
                                let counter = 1;

                                while (this.app.vault.getAbstractFileByPath(`${dir}/${copyName}`)) {
                                    counter++;
                                    copyName = `${baseName} copy ${counter}.${extension}`;
                                }

                                const newPath = dir ? `${dir}/${copyName}` : copyName;
                                this.app.vault.adapter.read(item.path).then(content => {
                                    this.app.vault.create(newPath, content);
                                });
                            });
                    });
                }


                if (!hasItem('Rename')) {
                    menu.addItem((i) => {
                        i.setTitle("Rename...")
                            .setIcon("pencil")
                            .setSection("danger")
                            .onClick(() => this.startInlineRename(item));
                    });
                }

                if (!hasItem('Delete')) {
                    menu.addItem((i) => {
                        i.setTitle("Delete")
                            .setIcon("trash-2")
                            .setSection("danger")
                            .setWarning()
                            .onClick(() => {
                                const paths = this.selectedPaths.size > 1 ? Array.from(this.selectedPaths) : [item.path];
                                this.deleteUsingCoreOrFallback(paths);
                            });
                    });
                }

            } else if (item instanceof TFolder) {
                if (!hasItem('New note')) {
                    menu.addItem((i) => {
                        i.setTitle("New note")
                            .setIcon("edit")
                            .setSection("new")
                            .onClick(() => this.createAndOpenNewNote(item));
                    });
                }

                if (!hasItem('New folder')) {
                    menu.addItem((i) => {
                        i.setTitle("New folder")
                            .setIcon("folder-plus")
                            .setSection("new")
                            .onClick(() => this.startNewFolderCreation(item));
                    });
                }

                if (!hasItem('New canvas')) {
                    menu.addItem((i) => {
                        i.setTitle("New canvas")
                            .setIcon("layout-dashboard")
                            .setSection("new")
                            .onClick(async () => {
                                const canvasPath = item.isRoot() ?
                                    'Untitled.canvas' :
                                    `${item.path}/Untitled.canvas`;
                                const existingFile = this.app.vault.getAbstractFileByPath(canvasPath);
                                if (!existingFile) {
                                    await this.app.vault.create(canvasPath, '');
                                } else {
                                    new Notice("Canvas file already exists");
                                }
                            });
                    });
                }

                // *** MODIFIED: Use native base file creation ***
                if (!hasItem('New base')) {
                    menu.addItem((i) => {
                        i.setTitle("New base")
                            .setIcon("layout-list")
                            .setSection("new")
                            .onClick(() => {
                                this.createNewBaseFile(item); // 'item' is the folder in this context
                            });
                    });
                }

                if (!hasItem('Duplicate')) {
                    menu.addItem((i) => {
                        i.setTitle("Duplicate")
                            .setIcon("copy")
                            .setSection("action")
                            .onClick(async () => {
                                const parentPath = item.parent.path;
                                const baseName = item.name;
                                let copyName = `${baseName} copy`;
                                let counter = 1;

                                while (this.app.vault.getAbstractFileByPath(
                                        parentPath ? `${parentPath}/${copyName}` : copyName
                                    )) {
                                    counter++;
                                    copyName = `${baseName} copy ${counter}`;
                                }

                                const newPath = parentPath ? `${parentPath}/${copyName}` : copyName;
                                await this.app.vault.createFolder(newPath);

                                const copyFolderContents = async (source, dest) => {
                                    const sourceFolder = this.app.vault.getAbstractFileByPath(source);
                                    if (sourceFolder instanceof TFolder) {
                                        for (const child of sourceFolder.children) {
                                            if (child instanceof TFile) {
                                                const content = await this.app.vault.read(child);
                                                await this.app.vault.create(`${dest}/${child.name}`, content);
                                            } else if (child instanceof TFolder) {
                                                const newChildPath = `${dest}/${child.name}`;
                                                await this.app.vault.createFolder(newChildPath);
                                                await copyFolderContents(child.path, newChildPath);
                                            }
                                        }
                                    }
                                };

                                await copyFolderContents(item.path, newPath);
                                new Notice(`Duplicated folder to "${copyName}"`);
                            });
                    });
                }


                if (!hasItem('Search in folder')) {
                    menu.addItem((i) => {
                        i.setTitle("Search in folder")
                            .setIcon("search")
                            .setSection("action")
                            .onClick(() => {
                                this.app.internalPlugins.getPluginById('global-search').instance.openGlobalSearch(`path:"${item.path}"`);
                            });
                    });
                }

                if (!hasItem('Bookmark')) {
                    menu.addItem((i) => {
                        i.setTitle("Bookmark...")
                            .setIcon("bookmark")
                            .setSection("action")
                            .onClick(() => {
                                const bookmarks = this.app.internalPlugins.getPluginById('bookmarks');
                                if (bookmarks && bookmarks.enabled) {
                                    bookmarks.instance.addItem(item.path);
                                }
                            });
                    });
                }

                if (!hasItem('Copy path')) {
                    menu.addItem((i) => {
                        i.setTitle("Copy path")
                            .setIcon("link")
                            .setSection("copy")
                            .onClick(() => {
                                const fullPath = this.app.vault.adapter.getFullPath(item.path);
                                navigator.clipboard.writeText(fullPath);
                                new Notice("Path copied to clipboard");
                            });
                    });
                }

                if (!hasItem('Copy relative path')) {
                    menu.addItem((i) => {
                        i.setTitle("Copy relative path")
                            .setIcon("link")
                            .setSection("copy")
                            .onClick(() => {
                                navigator.clipboard.writeText(item.path);
                                new Notice("Relative path copied to clipboard");
                            });
                    });
                }

                if (!hasItem('Rename')) {
                    menu.addItem((i) => {
                        i.setTitle("Rename...")
                            .setIcon("pencil")
                            .setSection("danger")
                            .onClick(() => this.startInlineRename(item));
                    });
                }

                if (!hasItem('Delete')) {
                    menu.addItem((i) => {
                        i.setTitle("Delete")
                            .setIcon("trash-2")
                            .setSection("danger")
                            .setWarning()
                            .onClick(() => {
                                const paths = this.selectedPaths.size > 1 ? Array.from(this.selectedPaths) : [item.path];
                                this.deleteUsingCoreOrFallback(paths);
                            });
                    });
                }
            }

            // Normalize and position the Move item(s)
            const isMulti = this.selectedPaths.size > 1;
            const lower = (s) => (s || '').toLowerCase();
            const isMoveTitle = (t) => lower(t).startsWith('move ') || lower(t) === 'move to...' || lower(t) === 'move to';

            // Remove existing single Move to... if multi-select is active
            if (isMulti) {
                menu.items = menu.items.filter(it => !isMoveTitle(it.title));
            }

            // Insert our multi-select Move at the expected spot (action section, near Duplicate)
            if (isMulti) {
                const moveLabel = `Move ${this.selectedPaths.size} items to...`;
                // Find best insertion index: after Duplicate if present, otherwise at start of action section
                const sectionOrder = ['new', 'open', 'action', 'export', 'copy', 'system', 'info', 'danger'];
                const actionIdxs = menu.items
                    .map((it, idx) => ({ it, idx }))
                    .filter(x => (x.it.section || 'action') === 'action')
                    .map(x => x.idx);
                const afterDuplicate = menu.items.findIndex(it => lower(it.title) === 'duplicate');
                let insertAt = afterDuplicate !== -1 ? afterDuplicate + 1 : (actionIdxs.length ? actionIdxs[0] : 0);
                insertAt = Math.max(0, Math.min(insertAt, menu.items.length));

                menu.addItem((i) => {
                    i.setTitle(moveLabel)
                        .setIcon('folder-input')
                        .setSection('action')
                        .onClick(() => this.openMoveModalForSelection());
                });
                // Move the last-added item to the chosen index
                const added = menu.items.pop();
                menu.items.splice(insertAt, 0, added);
            }

            // Remove core item: Reveal file in navigation
            menu.items = menu.items.filter(item => !item.title || !lower(item.title).includes('reveal file in navigation'));

            const sectionOrder = ['new', 'open', 'action', 'export', 'copy', 'system', 'info', 'danger'];
            menu.items.sort((a, b) => {
                const sectionA = a.section || 'action';
                const sectionB = b.section || 'action';
                const indexA = sectionOrder.indexOf(sectionA);
                const indexB = sectionOrder.indexOf(sectionB);

                if (indexA === -1 && indexB === -1) return 0;
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;

                return indexA - indexB;
            });

            if (menu.items.length > 0) {
                menu.showAtMouseEvent(event);
            }
        });
    }

    // Build the restricted 4-option menu for any multi-selection (files, folders, or mixed)
    buildMultiSelectionMenu(menu) {
        const selectedPathsArr = Array.from(this.selectedPaths || []);
        if (selectedPathsArr.length <= 1) return false;
        const selectedItems = selectedPathsArr
            .map(p => this.app.vault.getAbstractFileByPath(p))
            .filter(Boolean);
        if (selectedItems.length <= 1) return false;

        const n = selectedItems.length;
        menu.addItem((i) => {
            i.setTitle(`New folder with selection (${n} item${n > 1 ? 's' : ''})`)
                .setIcon('folder-plus')
                .setSection('new')
                .onClick(() => this.createFolderWithSelection(selectedItems));
        });
        menu.addItem((i) => {
            i.setTitle(`Move ${n} items to...`)
                .setIcon('folder-input')
                .setSection('action')
                .onClick(() => this.openMoveModalForSelection());
        });
        menu.addItem((i) => {
            i.setTitle('Bookmark...')
                .setIcon('bookmark')
                .setSection('action')
                .onClick(() => this.bookmarkSelectedItems(selectedItems));
        });
        menu.addItem((i) => {
            i.setTitle('Delete')
                .setIcon('trash-2')
                .setSection('danger')
                .setWarning()
                .onClick(() => this.deleteUsingCoreOrFallback(selectedPathsArr));
        });
        return true;
    }

    // Return true if the user is typing in an input/textarea/contenteditable or inline rename is active
    isUserTypingInInput() {
        const ae = document.activeElement;
        const tag = (ae?.tagName || '').toLowerCase();
        const isEditable = !!(ae && (ae.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select'));
        const renaming = !!this.contentEl?.querySelector('[data-renaming="true"]');
        return isEditable || renaming;
    }

    // Attach key handlers: Cmd+Backspace/Delete (macOS) and Delete (Win/Linux) to delete selected items
    bindDeleteShortcuts() {
        // Avoid double-binding: rely on registerDomEvent which cleans up with the view
        const handler = (ev) => {
            // Only act when this view is focused or an element inside it is active
            if (!this.contentEl) return;
            const containsFocus = this.contentEl.contains(document.activeElement) || document.activeElement === document.body;
            if (!containsFocus) return;
            if (this.isUserTypingInInput()) return;

            const isMac = (typeof process !== 'undefined' && process.platform === 'darwin') || /Mac|iPod|iPhone|iPad/i.test(navigator.platform || '');
            const isMacDelete = isMac && ev.metaKey && (ev.key === 'Backspace' || ev.key === 'Delete');
            const isWinLinuxDelete = !isMac && ev.key === 'Delete' && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
            const isDeleteShortcut = isMacDelete || isWinLinuxDelete;
            if (!isDeleteShortcut) return;

            const paths = Array.from(this.selectedPaths || []);
            if (!paths.length) return;

            ev.preventDefault();
            ev.stopPropagation();
            this.deleteUsingCoreOrFallback(paths);
        };
        // Listen on the view container so focus stays scoped to this view
        this.registerDomEvent(this.contentEl, 'keydown', handler);
    }

    // Navigation and action hotkeys to mirror core File Explorer behavior
    bindNavigationShortcuts() {
        const handler = async (ev) => {
            if (!this.contentEl) return;
            const containsFocus = this.contentEl.contains(document.activeElement) || document.activeElement === document.body;
            if (!containsFocus) return;
            if (this.isUserTypingInInput()) return;

            const items = this.getVisibleItemElements();
            if (!items.length) return;

            const getIndex = (p) => items.findIndex(el => el.getAttribute('data-path') === p);
            const getPathAt = (i) => (i >= 0 && i < items.length) ? items[i].getAttribute('data-path') : null;
            const getItemAt = (i) => (i >= 0 && i < items.length) ? items[i] : null;

            const currentPath = this.lastAnchorPath || this.selectedPaths.values().next().value || items[0].getAttribute('data-path');
            let idx = getIndex(currentPath);
            if (idx < 0) idx = 0;

            const isMod = ev.metaKey || ev.ctrlKey;
            const isShift = ev.shiftKey;

            const ensureSingleSelection = (path) => {
                this.selectedPaths.clear();
                this.selectedPaths.add(path);
                this.lastAnchorPath = path;
                this.updateSelectionStyles();
                this.scrollItemIntoView(path);
            };
            const extendSelectionTo = (path) => {
                const a = getIndex(this.lastAnchorPath || currentPath);
                const b = getIndex(path);
                if (a === -1 || b === -1) return ensureSingleSelection(path);
                this.selectedPaths.clear();
                const [start, end] = a < b ? [a, b] : [b, a];
                for (let i = start; i <= end; i++) this.selectedPaths.add(getPathAt(i));
                this.updateSelectionStyles();
                this.scrollItemIntoView(path);
            };

            const toggleFolder = async (path, expand) => {
                const titleEl = this.contentEl.querySelector(`.nav-folder-title[data-path="${CSS.escape(path)}"]`);
                if (!titleEl) return;
                const contentEl = titleEl.nextElementSibling;
                if (!contentEl) return;
                const shouldExpand = (expand === undefined)
                    ? contentEl.classList.contains('is-collapsed')
                    : !!expand;
                contentEl.toggleClass('is-collapsed', !shouldExpand);
                const indicator = titleEl.querySelector('.nav-folder-collapse-indicator');
                if (indicator) indicator.toggleClass('is-collapsed', !shouldExpand);
                if (!shouldExpand) this.collapsedFolders[path] = true; else delete this.collapsedFolders[path];
                this.plugin.settings.collapsedFolders = this.collapsedFolders;
                this.saveSettingsDebounced();
            };

            const openPath = async (path, newTab = false) => {
                const af = this.app.vault.getAbstractFileByPath(path);
                if (!af) return;
                if (af instanceof TFolder) {
                    // Enter toggles folder expand/collapse
                    await toggleFolder(path);
                    return;
                }
                if (newTab) await this.app.workspace.getLeaf('tab').openFile(af);
                else await this.app.workspace.getLeaf().openFile(af);
            };

            const focusParent = (path) => {
                const parentPath = this.getParentPath(path);
                if (parentPath == null) return;
                const parentEl = this.contentEl.querySelector(`.nav-folder-title[data-path="${CSS.escape(parentPath)}"]`);
                if (parentEl) {
                    ensureSingleSelection(parentPath);
                }
            };

            // Handle keys
            switch (ev.key) {
                case 'ArrowDown': {
                    ev.preventDefault();
                    const nextIdx = Math.min(items.length - 1, idx + 1);
                    const nextPath = getPathAt(nextIdx);
                    if (!nextPath) return;
                    if (isShift) extendSelectionTo(nextPath); else ensureSingleSelection(nextPath);
                    return;
                }
                case 'ArrowUp': {
                    ev.preventDefault();
                    const prevIdx = Math.max(0, idx - 1);
                    const prevPath = getPathAt(prevIdx);
                    if (!prevPath) return;
                    if (isShift) extendSelectionTo(prevPath); else ensureSingleSelection(prevPath);
                    return;
                }
                case 'ArrowRight': {
                    ev.preventDefault();
                    const el = getItemAt(idx);
                    const path = getPathAt(idx);
                    if (!el || !path) return;
                    const isFolder = el.classList.contains('nav-folder-title');
                    if (isFolder) {
                        const contentEl = el.nextElementSibling;
                        const collapsed = contentEl?.classList.contains('is-collapsed');
                        if (collapsed) {
                            await toggleFolder(path, true);
                        } else {
                            // Move into first child if expanded
                            const next = getItemAt(idx + 1);
                            const nextPath = getPathAt(idx + 1);
                            if (next && nextPath) ensureSingleSelection(nextPath);
                        }
                    }
                    return;
                }
                case 'ArrowLeft': {
                    ev.preventDefault();
                    const el = getItemAt(idx);
                    const path = getPathAt(idx);
                    if (!el || !path) return;
                    const isFolder = el.classList.contains('nav-folder-title');
                    if (isFolder) {
                        const contentEl = el.nextElementSibling;
                        const collapsed = contentEl?.classList.contains('is-collapsed');
                        if (!collapsed) {
                            await toggleFolder(path, false);
                        } else {
                            focusParent(path);
                        }
                    } else {
                        // File: go to parent
                        focusParent(path);
                    }
                    return;
                }
                case 'Home': {
                    ev.preventDefault();
                    const firstPath = getPathAt(0);
                    if (firstPath) ensureSingleSelection(firstPath);
                    return;
                }
                case 'End': {
                    ev.preventDefault();
                    const lastPath = getPathAt(items.length - 1);
                    if (lastPath) ensureSingleSelection(lastPath);
                    return;
                }
                case 'Enter': {
                    ev.preventDefault();
                    // Open selected (first) item or toggle folder
                    const path = this.lastAnchorPath || currentPath;
                    await openPath(path, false);
                    return;
                }
                default:
                    break;
            }

            // Modifier+Enter => open in new tab (parity with core explorer)
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                const path = this.lastAnchorPath || currentPath;
                await openPath(path, true);
                return;
            }

            // F2 => rename focused/selected single item
            if (ev.key === 'F2') {
                ev.preventDefault();
                const path = this.lastAnchorPath || currentPath;
                const af = this.app.vault.getAbstractFileByPath(path);
                if (af) this.startInlineRename(af);
                return;
            }

            // Escape => clear selection
            if (ev.key === 'Escape') {
                this.selectedPaths.clear();
                this.lastAnchorPath = null;
                this.updateSelectionStyles();
                return;
            }

            // Cmd/Ctrl+A => select all
            if ((ev.key === 'a' || ev.key === 'A') && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                this.selectedPaths.clear();
                for (const el of items) this.selectedPaths.add(el.getAttribute('data-path'));
                // Keep anchor at the first selected
                this.lastAnchorPath = getPathAt(0);
                this.updateSelectionStyles();
                return;
            }
        };
        this.registerDomEvent(this.contentEl, 'keydown', handler);
    }

    scrollItemIntoView(path) {
        try {
            const el = this.contentEl.querySelector(`[data-path="${CSS.escape(path)}"]`);
            if (!el) return;
            const container = this.explorerEl || this.contentEl;
            const rect = el.getBoundingClientRect();
            const crect = container.getBoundingClientRect();
            if (rect.top < crect.top) el.scrollIntoView({ block: 'nearest' });
            else if (rect.bottom > crect.bottom) el.scrollIntoView({ block: 'nearest' });
        } catch (_) {}
    }

    // Create a new folder and move currently-selected items (files/folders) into it
    async createFolderWithSelection(items) {
        try {
            const { FuzzySuggestModal } = require('obsidian');

            const validItems = (items || []).filter(Boolean);
            if (validItems.length === 0) return;

            // Determine target parent folder: if all items share the same parent, use it; otherwise ask
            const parents = Array.from(new Set(validItems.map(it => it.parent?.path || '')));
            let parentFolderPath = null;
            if (parents.length === 1) {
                parentFolderPath = parents[0];
            } else {
                // Ask user to pick a folder
                const pick = await new Promise((resolve) => {
                    class FolderPick extends FuzzySuggestModal {
                        constructor(app) { super(app); }
                        getItems() {
                            const out = [];
                            const add = (folder) => { out.push(folder); (folder.children||[]).forEach(ch => { if (ch instanceof TFolder) add(ch); }); };
                            add(this.app.vault.getRoot());
                            return out;
                        }
                        getItemText(f) { return f.path || '/'; }
                        onChooseItem(f) { resolve(f.path); }
                        onClose() { resolve(null); }
                    }
                    new FolderPick(this.app).open();
                });
                if (!pick && pick !== '') return; // cancelled
                parentFolderPath = pick;
            }

            const parentFolder = this.app.vault.getAbstractFileByPath(parentFolderPath) || this.app.vault.getRoot();
            if (!(parentFolder instanceof TFolder)) return;

            // Ask for folder name
            const baseName = await this.promptForText({
                title: 'New folder name',
                placeholder: 'New Folder',
                initialValue: 'New Folder'
            });
            if (!baseName) return; // cancelled

            // Ensure unique name
            let newName = baseName.trim() || 'New Folder';
            let destPath = parentFolder.path ? `${parentFolder.path}/${newName}` : newName;
            let counter = 1;
            while (this.app.vault.getAbstractFileByPath(destPath)) {
                counter++;
                const suffix = ` ${counter}`;
                const base = baseName.trim() || 'New Folder';
                newName = base.endsWith(String(counter - 1)) ? base.replace(/\s\d+$/, suffix) : `${base}${suffix}`;
                destPath = parentFolder.path ? `${parentFolder.path}/${newName}` : newName;
            }

            await this.app.vault.createFolder(destPath);

            // Move items into the new folder
            for (const it of validItems) {
                try {
                    const targetPath = `${destPath}/${it.name}`;
                    if (this.app.vault.getAbstractFileByPath(targetPath)) {
                        new Notice(`"${it.name}" already exists in "${newName}"`);
                        continue;
                    }
                    if (it instanceof TFolder) {
                        // Prevent moving folder into itself or its children (if parent chosen equals the folder itself)
                        if (destPath.startsWith(it.path + '/')) {
                            new Notice(`Cannot move folder "${it.name}" into itself`);
                            continue;
                        }
                    }
                    await this.app.fileManager.renameFile(it, targetPath);
                } catch (e) {
                    console.error('Move into new folder failed', e);
                    new Notice(`Failed to move "${it.name}"`);
                }
            }

            // Update selection to the new folder (optional UX)
            this.selectedPaths.clear();
            this.selectedPaths.add(destPath);
            this.updateSelectionStyles();
            new Notice(`Created "${newName}" and moved ${validItems.length} item${validItems.length>1?'s':''}.`);
        } catch (err) {
            console.error('createFolderWithSelectedFiles error', err);
            new Notice('Failed to create folder with selection');
        }
    }

    // Bookmark all selected items using the core Bookmarks plugin if enabled
    bookmarkSelectedItems(items) {
        try {
            const bookmarks = this.app.internalPlugins.getPluginById('bookmarks');
            if (!bookmarks || !bookmarks.enabled) {
                new Notice('Bookmarks plugin is not enabled');
                return;
            }
            let count = 0;
            for (const it of (items || [])) {
                if (!it) continue;
                try { bookmarks.instance.addItem(it.path); count++; } catch (_) {}
            }
            if (count) new Notice(`Bookmarked ${count} item${count>1?'s':''}`);
        } catch (err) {
            console.error('bookmarkSelectedFiles error', err);
        }
    }

    // Simple text input modal that returns a string or null
    promptForText({ title = 'Input', placeholder = '', initialValue = '' } = {}) {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            try { modal.titleEl.setText(title); } catch (_) {}
            const content = modal.contentEl.createDiv();
            const input = content.createEl('input', { type: 'text' });
            input.placeholder = placeholder;
            input.value = initialValue;
            const buttons = content.createDiv({ cls: 'modal-button-container' });
            const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
            const okBtn = buttons.createEl('button', { text: 'OK' });
            okBtn.addClass('mod-cta');
            const done = (val) => { modal.close(); resolve(val); };
            cancelBtn.addEventListener('click', () => done(null));
            okBtn.addEventListener('click', () => done(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
                else if (e.key === 'Escape') { e.preventDefault(); done(null); }
            });
            modal.onOpen = () => { setTimeout(() => { input.focus(); input.select(); }, 0); };
            modal.onClose = () => resolve(null);
            modal.open();
        });
    }

    setupDragAndDrop(element, item) {
        element.addEventListener('dragstart', (event) => {
            event.dataTransfer.effectAllowed = 'move';
            // Prepare selected items to drag. If clicked item not selected, drag only it.
            const selected = this.selectedPaths.has(item.path) ? Array.from(this.selectedPaths) : [item.path];
            // Maintain relative order based on current visual order
            const elements = this.getVisibleItemElements();
            const orderMap = new Map(elements.map(el => [el.getAttribute('data-path'), Number(el.dataset.order) || 0]));
            selected.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
            const dragData = { paths: selected, primary: item.path, type: item instanceof TFolder ? 'folder' : 'file' };
            event.dataTransfer.setData('text/plain', JSON.stringify(dragData));
            // Cache for faster dragover access
            this._dragData = dragData;
            this._dragging = true;
            element.addClass('is-being-dragged');
        });

        element.addEventListener('dragend', () => {
            element.removeClass('is-being-dragged');
            this._dragging = false;
            this.cancelDragOverThrottle();
            this.clearDropIndicators();
            this.clearParentFolderHighlight();
            this._dragData = null;
        });

        element.addEventListener('dragover', this.scheduleDragOver((event) => {
            try {
                // Ignore if no internal drag is currently active (prevents stale rAF after drop)
                if (!this._dragging) return;
                const dragData = this._dragData || {};
                const paths = dragData.paths || (dragData.path ? [dragData.path] : []);
                if (paths.length === 1 && paths[0] === item.path) return;
                const rect = element.getBoundingClientRect();
                const containerRect = this.contentEl.getBoundingClientRect();
                const relativeX = event.clientX - containerRect.left;
                const currentDepth = Math.floor((rect.left - containerRect.left - 8) / 16);
                const targetDepth = Math.floor((relativeX - 8) / 16);
                if (targetDepth < currentDepth - 1 && relativeX < rect.left - containerRect.left - 20) {
                    const parentPath = this.getParentFolderAtDepth(item.path, targetDepth);
                    this.showParentFolderDropZone(parentPath);
                    return;
                } else {
                    this.clearParentFolderHighlight();
                }
                const relativeY = event.clientY - rect.top;
                if (item instanceof TFolder) {
                    const centerThreshold = rect.height * 0.3;
                    if (relativeY > centerThreshold && relativeY < (rect.height - centerThreshold)) {
                        this.clearDropIndicators();
                        element.addClass('is-drag-over-folder');
                        return;
                    } else {
                        element.removeClass('is-drag-over-folder');
                    }
                }
                const isUpperHalf = relativeY < rect.height / 2;
                let targetElement, targetItemPath;
                if (isUpperHalf) {
                    targetElement = element;
                    targetItemPath = item.path;
                } else {
                    const nextElement = this.getNextSiblingElement(element);
                    if (nextElement) {
                        targetElement = nextElement;
                        targetItemPath = nextElement.getAttribute('data-path');
                    } else {
                        targetElement = element;
                        targetItemPath = item.path;
                        const positionKey = `${targetItemPath}-bottom`;
                        if (this.currentDropIndicatorPosition !== positionKey) {
                            this.currentDropIndicatorPosition = positionKey;
                            this.showDropIndicator(targetElement, false);
                        }
                        return;
                    }
                }
                const positionKey = `${targetItemPath}-top`;
                if (this.currentDropIndicatorPosition !== positionKey) {
                    this.currentDropIndicatorPosition = positionKey;
                    this.showDropIndicator(targetElement, true);
                }
            } catch (error) { console.error('Dragover error:', error); }
        }));

        element.addEventListener('dragleave', (event) => {
            const rect = element.getBoundingClientRect();
            if (!(event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
                element.removeClass('is-drag-over-folder');
            }
        });

        element.addEventListener('drop', async (event) => {
            // Check if this is a root drop (left edge or whitespace) - if so, let container handle it
            const containerRect = this.contentEl.getBoundingClientRect();
            const relativeX = event.clientX - containerRect.left;
            const el = document.elementFromPoint(event.clientX, event.clientY);
            const overItem = el?.closest('.nav-folder-title, .nav-file-title');
            const isWhitespace = !overItem;
            const isRootDrop = (relativeX < 30) || isWhitespace;
            
            if (isRootDrop) {
                // Don't stop propagation - let the container handler deal with root drops
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            element.removeClass('is-drag-over-folder');
            this._dragging = false;
            this.cancelDragOverThrottle();
            this.clearDropIndicators();
            this.clearParentFolderHighlight();

            // Finder/native file drop support
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                // If dropped on a folder, use that folder; if on a file, use its parent folder
                let targetFolder = null;
                if (item instanceof TFolder) {
                    targetFolder = item;
                } else if (item instanceof TFile) {
                    const parentPath = item.parent?.path || '';
                    targetFolder = this.app.vault.getAbstractFileByPath(parentPath);
                }
                if (!(targetFolder instanceof TFolder)) {
                    targetFolder = this.app.vault.getRoot();
                }
                for (const file of event.dataTransfer.files) {
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        const filePath = targetFolder.path ? `${targetFolder.path}/${file.name}` : file.name;
                        await this.app.vault.createBinary(filePath, arrayBuffer);
                    } catch (err) {
                        new Notice(`Failed to import file: ${file.name}`);
                    }
                }
                return;
            }

            try {
                const dragData = JSON.parse(event.dataTransfer.getData('text/plain'));
                const paths = dragData.paths || (dragData.path ? [dragData.path] : []);
                const targetPath = item.path;
                if (paths.length === 1 && paths[0] === targetPath) return;

                const rect = element.getBoundingClientRect();
                const containerRect = this.contentEl.getBoundingClientRect();
                const relativeX = event.clientX - containerRect.left;
                const currentDepth = Math.floor((rect.left - containerRect.left - 8) / 16);
                const targetDepth = Math.floor((relativeX - 8) / 16);

                // Use the primary dragged path when single-item logic is needed
                const sourcePath = paths[0];

                if (targetDepth < currentDepth - 1 && relativeX < rect.left - containerRect.left - 20) {
                    // pass the computed numeric targetDepth rather than the target path
                    const parentPath = this.getParentFolderAtDepth(sourcePath, targetDepth);
                    await this.moveToParentFolder(sourcePath, parentPath);
                    return;
                }

                const relativeY = event.clientY - rect.top;
                if (item instanceof TFolder) {
                    const centerThreshold = rect.height * 0.3;
                    if (relativeY > centerThreshold && relativeY < (rect.height - centerThreshold)) {
                        // Drop onto the folder's center: move all dragged items into this folder
                        for (const p of paths) {
                            const isFolder = this.app.vault.getAbstractFileByPath(p) instanceof TFolder;
                            if (isFolder && (targetPath === p || targetPath.startsWith(p + '/'))) {
                                new Notice('Cannot move folder into itself or its children');
                                continue;
                            }
                            try {
                                if (isFolder) await this.moveFolderToFolder(p, targetPath);
                                else await this.moveFileToFolder(p, targetPath);
                            } catch (err) {
                                console.error('Error moving item into folder:', err);
                                new Notice('Failed to move item into folder');
                            }
                        }
                        return;
                    }
                }

                const getParentPath = (path) => path.lastIndexOf('/') > -1 ? path.substring(0, path.lastIndexOf('/')) : '';
                const sourceParent = (p) => getParentPath(p);
                const targetParent = getParentPath(targetPath);

                const insertBefore = relativeY < rect.height / 2;
                // Move each item to the target parent (if needed), in current visual order
                const movedPaths = [];
                for (const p of paths) {
                    const isFolder = this.app.vault.getAbstractFileByPath(p) instanceof TFolder;
                    if (isFolder && targetParent && (targetParent === p || targetParent.startsWith(p + '/'))) {
                        new Notice('Cannot move folder into itself or its children');
                        continue;
                    }
                    if (sourceParent(p) !== targetParent) {
                        if (isFolder) await this.moveFolderToFolder(p, targetParent);
                        else await this.moveFileToFolder(p, targetParent);
                        const name = p.substring(p.lastIndexOf('/') + 1);
                        movedPaths.push(targetParent ? `${targetParent}/${name}` : name);
                    } else {
                        movedPaths.push(p);
                    }
                }
                // Now reorder each moved path relative to the drop target, preserving group relative order
                let anchorPath = targetPath;
                for (const p of movedPaths) {
                    await this.reorderItems(p, anchorPath, insertBefore);
                    // After inserting before, keep anchor as previous target; after inserting after, move anchor to the newly inserted so next item stacks after it
                    if (!insertBefore) anchorPath = p;
                }

            } catch (error) {
                new Notice('Error during drag and drop operation');
            }
        });
    }

    getNextSiblingElement(element) {
        const parentContainer = element.closest('.nav-folder-children') || this.contentEl;
        if (!parentContainer) return null;
        const allItems = Array.from(parentContainer.querySelectorAll(':scope > .nav-folder > .nav-folder-title, :scope > .nav-file > .nav-file-title'));
        const currentIndex = allItems.indexOf(element);
        return currentIndex > -1 && currentIndex < allItems.length - 1 ? allItems[currentIndex + 1] : null;
    }

    showDropIndicator(targetElement, isUpperHalf) {
        const container = this.contentEl;
        if (!container) return;
        // Reuse a single indicator element to reduce DOM churn
        let indicator = this.currentDropIndicator;
        if (!indicator || !indicator.isConnected) {
            indicator = document.createElement('div');
            indicator.className = 'file-explorer-drop-indicator';
            container.appendChild(indicator);
            this.currentDropIndicator = indicator;
        }
        const rect = targetElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const top = Math.round(rect.top - containerRect.top + container.scrollTop + (isUpperHalf ? 0 : rect.height));
        indicator.style.cssText = `position: absolute; top: ${top}px; left: 10px; width: ${Math.round(containerRect.width - 20)}px; height: 2px; background-color: var(--interactive-accent); pointer-events: none; z-index: 9999;`;
        // Persist metadata so we can interpret indicator drop even if pointer is between items
        indicator.dataset.targetPath = targetElement.getAttribute('data-path');
        indicator.dataset.insertBefore = isUpperHalf ? 'true' : 'false';
    }

    clearDropIndicators() {
        this.currentDropIndicatorPosition = null;
        // Also cancel any pending dragover work that might recreate the indicator
        this.cancelDragOverThrottle();
    this.contentEl?.querySelectorAll('.file-explorer-drop-indicator').forEach(el => el.remove());
        if (this.currentDropIndicator) {
            this.currentDropIndicator.remove();
            this.currentDropIndicator = null;
        }
        this.contentEl?.querySelectorAll('.is-drag-over-folder').forEach(el => el.removeClass('is-drag-over-folder'));
    }

    getParentFolderAtDepth(path, targetDepth) {
        const parts = path.split('/');
        if (targetDepth < 0) return '';
        if (targetDepth >= parts.length - 1) return this.getParentPath(path);
        return parts.slice(0, targetDepth + 1).join('/');
    }

    getParentPath(path) {
        const lastSlash = path.lastIndexOf('/');
        return lastSlash === -1 ? '' : path.substring(0, lastSlash);
    }

    showParentFolderDropZone(parentPath) {
        this.clearDropIndicators();
        this.clearParentFolderHighlight();
        if (parentPath === null || parentPath === '') {
            this.contentEl.addClass('parent-folder-drop-zone');
        } else {
            const folderEl = this.contentEl.querySelector(`.nav-folder-title[data-path="${CSS.escape(parentPath)}"]`);
            if (folderEl) folderEl.addClass('parent-folder-drop-target');
        }
    }

    clearParentFolderHighlight() {
        this.contentEl.removeClass('parent-folder-drop-zone');
        this.contentEl.querySelectorAll('.parent-folder-drop-target').forEach(el => el.removeClass('parent-folder-drop-target'));
    }

    // Open a folder suggester modal and move all selected files
    async openMoveModalForSelection() {
        const { FuzzySuggestModal } = require('obsidian');
        
        const selected = Array.from(this.selectedPaths).filter(p => !!this.app.vault.getAbstractFileByPath(p));
        if (selected.length === 0) {
            new Notice('No files selected');
            return;
        }

        const files = selected
            .map(p => this.app.vault.getAbstractFileByPath(p))
            .filter(Boolean);

        class FolderSuggest extends FuzzySuggestModal {
            constructor(app, files) {
                super(app);
                this.files = files;
                this.setPlaceholder(`Move ${files.length} item${files.length > 1 ? 's' : ''} to...`);
            }

            getItems() {
                const folders = [];
                const addFolder = (folder) => {
                    folders.push(folder);
                    if (folder.children) {
                        folder.children.forEach(child => {
                            if (child instanceof TFolder) addFolder(child);
                        });
                    }
                };
                addFolder(this.app.vault.getRoot());
                return folders;
            }

            getItemText(folder) {
                return folder.path || '/';
            }

            async onChooseItem(folder) {
                const targetPath = folder.path;
                
                for (const file of this.files) {
                    try {
                        // Check if moving a folder into itself
                        if (file instanceof TFolder && targetPath && 
                            (targetPath === file.path || targetPath.startsWith(file.path + '/'))) {
                            new Notice(`Cannot move "${file.name}" into itself`);
                            continue;
                        }

                        // Check if file already exists at destination
                        const newPath = targetPath ? `${targetPath}/${file.name}` : file.name;
                        const existing = this.app.vault.getAbstractFileByPath(newPath);
                        if (existing && existing.path !== file.path) {
                            new Notice(`"${file.name}" already exists at destination`);
                            continue;
                        }

                        // Perform the move
                        if (file.path !== newPath) {
                            await this.app.fileManager.renameFile(file, newPath);
                        }
                    } catch (err) {
                        new Notice(`Failed to move "${file.name}"`);
                        console.error('Move error:', err);
                    }
                }

                new Notice(`Moved ${this.files.length} item${this.files.length > 1 ? 's' : ''}`);
            }
        }

        new FolderSuggest(this.app, files).open();
    }



    async moveToParentFolder(sourcePath, targetParentPath) {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!sourceFile) return;
        const fileName = sourceFile.name;
        const newPath = targetParentPath === '' ? fileName : `${targetParentPath}/${fileName}`;
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(`"${fileName}" already exists in target location`);
            return;
        }
        await this.app.fileManager.renameFile(sourceFile, newPath);
        new Notice(`Moved "${fileName}" to "${targetParentPath || 'root'}"`);
        if (sourceFile instanceof TFolder) {
            await this.updateFolderPathsInSettings(sourcePath, newPath);
        } else {
            await this.updatePathInSettings(sourcePath, newPath);
        }
    }

    async moveFileToFolder(filePath, targetFolderPath) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        const fileName = file.name;
        const newPath = targetFolderPath === '' ? fileName : `${targetFolderPath}/${fileName}`;
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(`File "${fileName}" already exists in target folder`);
            return;
        }
        await this.app.fileManager.renameFile(file, newPath);
        await this.updatePathInSettings(filePath, newPath);
    }

    async moveFolderToFolder(sourceFolderPath, targetFolderPath) {
        const sourceFolder = this.app.vault.getAbstractFileByPath(sourceFolderPath);
        if (!(sourceFolder instanceof TFolder)) return;
        const folderName = sourceFolder.name;
        const newPath = targetFolderPath === '' ? folderName : `${targetFolderPath}/${folderName}`;
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            new Notice(`Folder "${folderName}" already exists in target location`);
            return;
        }
        await this.app.fileManager.renameFile(sourceFolder, newPath);
        await this.updateFolderPathsInSettings(sourceFolderPath, newPath);
    }

    async updatePathInSettings(oldPath, newPath) {
        const { sortOrder = {}, collapsedFolders = {} } = this.plugin.settings;
        if (sortOrder[oldPath] !== undefined) {
            sortOrder[newPath] = sortOrder[oldPath];
            delete sortOrder[oldPath];
        }
        if (collapsedFolders[oldPath] !== undefined) {
            collapsedFolders[newPath] = collapsedFolders[oldPath];
            delete collapsedFolders[oldPath];
        }
        await this.plugin.saveData({ ...this.plugin.settings, sortOrder, collapsedFolders });
    }

    async updateFolderPathsInSettings(oldFolderPath, newFolderPath) {
        const { sortOrder = {}, collapsedFolders = {} } = this.plugin.settings;
        const updatedOrder = {};
        const updatedCollapsed = {};
        const updatePaths = (collection, updatedCollection) => {
            for (const [path, value] of Object.entries(collection)) {
                if (path.startsWith(oldFolderPath)) {
                    const newPath = path.replace(oldFolderPath, newFolderPath);
                    updatedCollection[newPath] = value;
                } else {
                    updatedCollection[path] = value;
                }
            }
        };
        updatePaths(sortOrder, updatedOrder);
        updatePaths(collapsedFolders, updatedCollapsed);
        await this.plugin.saveData({ ...this.plugin.settings, sortOrder: updatedOrder, collapsedFolders: updatedCollapsed });
    }

    async cleanupDeletedPaths() {
        const { sortOrder = {}, collapsedFolders = {} } = this.plugin.settings;
        let hasChanges = false;
        const cleanCollection = (collection) => {
            const cleaned = {};
            for (const path in collection) {
                if (this.app.vault.getAbstractFileByPath(path)) {
                    cleaned[path] = collection[path];
                } else {
                    hasChanges = true;
                }
            }
            return cleaned;
        };
        const cleanedOrder = cleanCollection(sortOrder);
        const cleanedCollapsed = cleanCollection(collapsedFolders);
        if (hasChanges) {
            await this.plugin.saveData({ ...this.plugin.settings, sortOrder: cleanedOrder, collapsedFolders: cleanedCollapsed });
        }
    }

    async reorderItems(sourcePath, targetPath, insertBefore = false) {
        const getParentPath = (path) => path.lastIndexOf('/') > -1 ? path.substring(0, path.lastIndexOf('/')) : '';
        if (getParentPath(sourcePath) !== getParentPath(targetPath)) return;

        const parentFolder = this.app.vault.getAbstractFileByPath(getParentPath(sourcePath)) || this.app.vault.getRoot();
        const siblings = this.sortItems(parentFolder.children || []);

        const sourceItem = siblings.find(item => item.path === sourcePath);
        if (!sourceItem) return;

        const reorderedSiblings = siblings.filter(item => item.path !== sourcePath);
        const targetIndex = reorderedSiblings.findIndex(item => item.path === targetPath);

        if (targetIndex === -1) return;
        reorderedSiblings.splice(insertBefore ? targetIndex : targetIndex + 1, 0, sourceItem);

        const newOrder = {};
        reorderedSiblings.forEach((item, index) => { newOrder[item.path] = index; });

        this.plugin.settings.sortOrder = { ...this.plugin.settings.sortOrder, ...newOrder };
        await this.plugin.saveData(this.plugin.settings);
        await this.onOpen();
    }

    sortItems(items) {
        const order = this.plugin.settings.sortOrder || {};
        return items.slice().sort((a, b) => {
            const orderA = order[a.path] ?? Infinity;
            const orderB = order[b.path] ?? Infinity;
            if (orderA !== orderB) return orderA - orderB;
            if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
            if (b instanceof TFolder && !(a instanceof TFolder)) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    // Ignore MS Word temporary lock files
    shouldIgnore(item) {
        return item instanceof TFile && item.name.startsWith('~$');
    }
}

class CustomSortableFileExplorerPlugin extends Plugin {
    async onload() {
        this.settings = await this.loadData() || { sortOrder: {}, collapsedFolders: {} };
        if (!this.settings.collapsedFolders) this.settings.collapsedFolders = {};
        if (typeof this.settings.hideFileExtensions !== 'boolean') this.settings.hideFileExtensions = false;
        if (typeof this.settings.showIcons !== 'boolean') this.settings.showIcons = true;
        if (typeof this.settings.showBaseBadge !== 'boolean') this.settings.showBaseBadge = false;
        if (!this.settings.outlineMode) this.settings.outlineMode = 'focused'; // 'focused' | 'viewed'
        if (typeof this.settings.outlineColor !== 'string') this.settings.outlineColor = '';
    if (typeof this.settings.useCustomOutlineColor !== 'boolean') this.settings.useCustomOutlineColor = true;
        if (!this.settings.modifierAction) this.settings.modifierAction = 'openNewTab'; // 'openNewTab' | 'selectMultiple'

    this.registerView('my-file-explorer-view', (leaf) => new CustomSortableFileExplorerView(leaf, this));
        if (!this._ribbonEl) {
            this._ribbonEl = this.addRibbonIcon('folder', 'Sortable File Explorer', () => this.activateView());
        }
        this.app.workspace.onLayoutReady(() => this.activateView());

        this.registerEvent(this.app.vault.on('delete', (file) => this.removePathFromSettings(file.path)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.updatePathInAllSettings(oldPath, file.path)));

        // Settings tab
    try { this.addSettingTab(new CustomSortableFileExplorerSettingTab(this.app, this)); } catch (_) {}
    }

    onunload() {
        try { this._ribbonEl?.remove(); } catch (_) {}
        this._ribbonEl = null;
        try { this.app.workspace.detachLeavesOfType('my-file-explorer-view'); } catch (_) {}
        // Backward-compat: also detach the old view type if present
        try { this.app.workspace.detachLeavesOfType('my-file-explorer-view'); } catch (_) {}
    }

    async removePathFromSettings(path) {
        let hasChanges = false;
        const processCollection = (collection) => {
            for (const key in collection) {
                if (key === path || key.startsWith(path + '/')) {
                    delete collection[key];
                    hasChanges = true;
                }
            }
        };
        processCollection(this.settings.sortOrder);
        processCollection(this.settings.collapsedFolders);
        if (hasChanges) await this.saveData(this.settings);
    }

    async updatePathInAllSettings(oldPath, newPath) {
        let hasChanges = false;
        const processCollection = (collection) => {
            const newCollection = {};
            for (const [path, value] of Object.entries(collection)) {
                if (path === oldPath || path.startsWith(oldPath + '/')) {
                    const updatedPath = path.replace(oldPath, newPath);
                    newCollection[updatedPath] = value;
                    hasChanges = true;
                } else {
                    newCollection[path] = value;
                }
            }
            return newCollection;
        };
        this.settings.sortOrder = processCollection(this.settings.sortOrder);
        this.settings.collapsedFolders = processCollection(this.settings.collapsedFolders);
        if (hasChanges) await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType('my-file-explorer-view')[0];
        if (!leaf) {
            leaf = workspace.getLeftLeaf(false);
            await leaf.setViewState({ type: 'my-file-explorer-view', active: true });
        }
        workspace.revealLeaf(leaf);
    }
}

module.exports = CustomSortableFileExplorerPlugin;

// Settings UI
class CustomSortableFileExplorerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Sortable File Explorer Settings' });

        new Setting(containerEl)
            .setName('Hide file extensions')
            .setDesc('Display file names without extensions in the explorer.')
            .addToggle((toggle) => {
                toggle
                    .setValue(!!this.plugin.settings.hideFileExtensions)
                    .onChange(async (value) => {
                        this.plugin.settings.hideFileExtensions = !!value;
                        await this.plugin.saveData(this.plugin.settings);
                        // Refresh all open views to reflect the change
                        try {
                            const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                            for (const l of leaves) {
                                if (l?.view?.onOpen) await l.view.onOpen();
                            }
                        } catch (_) {}
                    });
            });

        new Setting(containerEl)
            .setName('Show file and folder icons')
            .setDesc('Toggle icons in the explorer list.')
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.showIcons !== false)
                    .onChange(async (value) => {
                        this.plugin.settings.showIcons = !!value;
                        await this.plugin.saveData(this.plugin.settings);
                        // Refresh views so CSS class is applied
                        try {
                            const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                            for (const l of leaves) {
                                if (l?.view?.onOpen) await l.view.onOpen();
                            }
                        } catch (_) {}
                    });
            });

        new Setting(containerEl)
            .setName("Show 'BASE' to the right of base files")
            .setDesc('Displays a small BASE label next to .base files when icons are hidden.')
            .addToggle((toggle) => {
                toggle
                    .setValue(!!this.plugin.settings.showBaseBadge)
                    .onChange(async (value) => {
                        this.plugin.settings.showBaseBadge = !!value;
                        await this.plugin.saveData(this.plugin.settings);
                        // Refresh views so CSS class is applied
                        try {
                            const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                            for (const l of leaves) {
                                if (l?.view?.onOpen) await l.view.onOpen();
                            }
                        } catch (_) {}
                    });
            });

        new Setting(containerEl)
            .setName('Outline target')
            .setDesc('Choose whether to show the outline for currently viewed file or double-clicked files in the explorer.')
            .addDropdown((dd) => {
                dd.addOption('focused', 'Double-clicked file');
                dd.addOption('viewed', 'Currently viewed file');
                dd.setValue(this.plugin.settings.outlineMode || 'focused');
                dd.onChange(async (value) => {
                    this.plugin.settings.outlineMode = value;
                    await this.plugin.saveData(this.plugin.settings);
                    // Refresh all views to apply container class
                    try {
                        const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                        for (const l of leaves) {
                            if (l?.view?.onOpen) await l.view.onOpen();
                        }
                    } catch (_) {}
                });
            });

        // Toggle: use custom outline color (falls back to theme accent when off)
        new Setting(containerEl)
            .setName('Use custom outline/highlight color')
            .setDesc('When enabled, the color below overrides your theme accent. Turn off to use the default accent color.')
            .addToggle((toggle) => {
                toggle
                    .setValue(!!this.plugin.settings.useCustomOutlineColor)
                    .onChange(async (value) => {
                        this.plugin.settings.useCustomOutlineColor = !!value;
                        await this.plugin.saveData(this.plugin.settings);
                        try {
                            // Disable/enable the color picker UI accordingly
                            if (this._outlineColorPicker?.setDisabled) this._outlineColorPicker.setDisabled(!value);
                            else if (this._outlineColorInput) this._outlineColorInput.disabled = !value;
                        } catch (_) {}
                        // Refresh views so CSS variables update immediately
                        try {
                            const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                            for (const l of leaves) { if (l?.view?.onOpen) await l.view.onOpen(); }
                        } catch (_) {}
                    });
            });

        const addColorPicker = (container) => {
            if (typeof Setting.prototype.addColorPicker === 'function') {
                new Setting(containerEl)
                    .setName('Use custom outline color')
                    .setDesc("When enabled, the color below overrides the vanilla explorer color. Turn off to use Obsidian's default neutral grey.")
                    .addColorPicker((picker) => {
                        this._outlineColorPicker = picker;
                        picker
                            .setValue(this.plugin.settings.outlineColor || '#000000')
                            .onChange(async (value) => {
                                this.plugin.settings.outlineColor = value;
                                await this.plugin.saveData(this.plugin.settings);
                                try {
                                    const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                                    for (const l of leaves) { if (l?.view?.onOpen) await l.view.onOpen(); }
                                } catch (_) {}
                            });
                        // Reflect toggle state
                        try { if (picker?.setDisabled) picker.setDisabled(!this.plugin.settings.useCustomOutlineColor); } catch (_) {}
                    });
            } else {
                // Fallback manual color input
                const row = container.createDiv({ cls: 'setting-item' });
                const info = row.createDiv({ cls: 'setting-item-info' });
                info.createDiv({ cls: 'setting-item-name', text: 'Outline color' });
                info.createDiv({ cls: 'setting-item-description', text: 'Double-click outline color. Leave empty to use your theme accent.' });
                const control = row.createDiv({ cls: 'setting-item-control' });
                const input = control.createEl('input', { type: 'color' });
                this._outlineColorInput = input;
                input.value = this.plugin.settings.outlineColor || '#000000';
                input.disabled = !this.plugin.settings.useCustomOutlineColor;
                input.addEventListener('input', async () => {
                    this.plugin.settings.outlineColor = input.value;
                    await this.plugin.saveData(this.plugin.settings);
                    try {
                        const leaves = this.app.workspace.getLeavesOfType('my-file-explorer-view') || [];
                        for (const l of leaves) { if (l?.view?.onOpen) await l.view.onOpen(); }
                    } catch (_) {}
                });
            }
        };
        addColorPicker(containerEl);

        new Setting(containerEl)
            .setName('Cmd/Ctrl click action')
            .setDesc('Choose what happens when you Cmd (macOS) or Ctrl (Windows/Linux) click a file.')
            .addDropdown((dd) => {
                dd.addOption('openNewTab', 'Open file in a new tab');
                dd.addOption('selectMultiple', 'Select multiple');
                dd.setValue(this.plugin.settings.modifierAction || 'openNewTab');
                dd.onChange(async (value) => {
                    this.plugin.settings.modifierAction = value;
                    await this.plugin.saveData(this.plugin.settings);
                });
            });
    }
}
