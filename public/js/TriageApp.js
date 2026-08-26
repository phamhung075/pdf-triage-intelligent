/**
 * Main Triage Application Class Module (TypeScript)
 */
class TriageApp {
    toast;
    state;
    categoryPills;
    documentGrid;
    modals;
    events;
    chatAssistant;
    imageEditor;
    constructor() {
        this.toast = new window.ToastFactory();
        this.toast.init();
        window.Toast = this.toast;
        this.state = new window.TriageState();
        this.categoryPills = new window.CategoryPillsManager(this);
        this.documentGrid = new window.DocumentGridManager(this);
        this.modals = new window.ModalsManager(this);
        this.events = new window.TriageEventsManager(this);
        this.chatAssistant = new window.ChatAssistantManager(this);
        this.imageEditor = new window.ImageEditorManager(this);
        this.setupGlobalProxies();
    }
    init() {
        this.toast.info('🚀 PDF Triage & Agentic Registry Ready\nWatching your incoming folder every 10s', 5000);
        this.events.setupLiveReload();
        this.events.setupGlobalTriageSSE();
        this.events.checkOllamaStatus();
        setInterval(() => this.events.checkOllamaStatus(), 10000);
        this.events.checkActiveTaskStatus();
        this.categoryPills.loadCategories();
        this.documentGrid.loadDocuments();
        this.modals.setupBlockedFilesModal();
        this.modals.updateBlockedFilesBadge();
        this.modals.setupLogsSSE();
        this.chatAssistant.init();
        this.imageEditor.init();
        this.applyDeepLink();
        void this.checkFirstRun();
        // Global Action Button Event Listeners
        const searchInput = document.getElementById('searchInput');
        const btnClearSearch = document.getElementById('btnClearSearch');
        const updateClearVisibility = () => {
            if (searchInput && btnClearSearch) {
                const hasText = searchInput.value.length > 0;
                btnClearSearch.style.display = hasText ? 'inline-flex' : 'none';
            }
        };
        if (searchInput) {
            searchInput.addEventListener('input', updateClearVisibility);
            searchInput.addEventListener('change', updateClearVisibility);
            searchInput.addEventListener('keyup', updateClearVisibility);
            updateClearVisibility();
        }
        if (btnClearSearch && searchInput) {
            btnClearSearch.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                searchInput.value = '';
                updateClearVisibility();
                searchInput.focus();
                this.documentGrid.loadDocuments();
            });
        }
        this.addEv('searchInput', 'input', this.state.debounce(() => this.documentGrid.loadDocuments(), 300));
        this.addEv('btnScan', 'click', () => this.events.handleScan());
        this.addEv('btnRepair', 'click', () => this.events.handleRepairRegistry());
        this.addEv('btnClear', 'click', () => this.events.handleClearRegistry());
        this.addEv('btnImportImages', 'click', () => {
            document.getElementById('importImagesInput')?.click();
        });
        this.addEv('importImagesInput', 'change', (e) => this.handleImportImages(e));
        this.addEv('btnOpenRaws', 'click', () => this.events.handleOpenRaws());
        this.addEv('btnOpenArchive', 'click', () => this.events.handleOpenArchive());
        this.addEv('btnCloseModal', 'click', () => this.modals.closeModal());
        this.addEv('btnCancelEdit', 'click', () => this.modals.closeModal());
        this.addEv('editForm', 'submit', (e) => this.modals.handleSaveEdit(e));
        // Settings Modal Listeners
        this.addEv('btnSettings', 'click', () => this.modals.openSettingsModal());
        this.addEv('btnCloseSettings', 'click', () => this.modals.closeSettingsModal());
        this.addEv('settingsForm', 'submit', (e) => this.modals.handleSaveSettings(e));
        this.addEv('tabBtnSystem', 'click', () => this.modals.switchSettingsTab('system'));
        this.addEv('tabBtnCategories', 'click', () => this.modals.switchSettingsTab('categories'));
        this.addEv('btnAddCategory', 'click', () => this.modals.handleAddCategory());
        // Tools & Utilities
        this.addEv('btnExportCsv', 'click', () => this.events.exportDocumentsCsv());
        this.addEv('btnExportMarkdown', 'click', () => this.events.exportDocumentsMarkdown());
        this.addEv('btnPdfUtil', 'click', () => this.modals.openPdfUtilModal());
        this.addEv('pdfSplitForm', 'submit', (e) => this.modals.handlePdfSplit(e));
        this.addEv('pdfMergeForm', 'submit', (e) => this.modals.handlePdfMerge(e));
        // Logs & Diagnostics
        this.addEv('btnLogs', 'click', () => this.modals.openLogsModal());
        this.addEv('btnCloseLogsModal', 'click', () => this.modals.closeLogsModal());
        this.addEv('btnUnlockOp', 'click', () => this.events.handleUnlockOp());
        this.addEv('btnStartOllama', 'click', () => this.events.handleStartOllama());
        this.addEv('btnRestartServer', 'click', () => this.events.handleRestartServer());
        // AI Assistant Listeners
        this.addEv('btnOpenChatAssistant', 'click', () => this.chatAssistant.openChatModal());
        this.addEv('btnCloseChatAssistant', 'click', () => this.chatAssistant.closeChatModal());
        this.addEv('btnClearChatHistory', 'click', () => this.chatAssistant.clearConversation());
    }
    addEv(id, event, handler) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(event, handler);
        }
    }
    setupGlobalProxies() {
        window.loadCategories = () => this.categoryPills.loadCategories();
        window.loadDocuments = () => this.documentGrid.loadDocuments();
        window.switchGrandViewerTab = (tab) => this.modals.switchGrandViewerTab(tab);
        window.openGrandViewerModal = (docId, event) => this.modals.openGrandViewerModal(docId, event);
        window.closeGrandViewerModal = () => this.modals.closeGrandViewerModal();
        window.openRelocalizeModal = (docId) => this.modals.openRelocalizeModal(docId);
        window.openEditModal = (docId) => this.modals.openEditModal(docId);
        window.closeModal = () => this.modals.closeModal();
        window.openPdfUtilModal = () => this.modals.openPdfUtilModal();
        window.closePdfUtilModal = () => this.modals.closePdfUtilModal();
        window.switchPdfUtilTab = (tab) => this.modals.switchPdfUtilTab(tab);
        window.openLogsModal = () => this.modals.openLogsModal();
        window.closeLogsModal = () => this.modals.closeLogsModal();
        window.switchLogsTab = (tab) => this.modals.switchLogsTab(tab);
        window.loadLogsView = () => this.modals.loadLogsView();
        window.openChatAssistantModal = () => this.chatAssistant.openChatModal();
    }
    /**
     * Opens a view named in the URL fragment, so something outside the page can link to it.
     *
     * The dashboard is a single page whose panels are modals, with no router — so before this there
     * was no URL that could open Settings, and the desktop tray's "System Configuration" item could
     * only re-open the dashboard root. It looked like the menu item did nothing.
     *
     * Kept deliberately tiny: a fragment switch, not a router. Unknown fragments are ignored so a
     * stale bookmark degrades to the normal dashboard rather than erroring.
     */
    applyDeepLink() {
        const view = (window.location.hash || '').replace(/^#/, '').toLowerCase();
        if (!view)
            return;
        if (view === 'settings') {
            this.modals.openSettingsModal();
        }
    }
    /**
     * Shows the first-run setup screen when this install has never been configured.
     *
     * Without it a fresh install opens on an empty document grid that looks identical to a working
     * one with no documents — which is exactly how a packaged app pointed at its own empty default
     * folders reads as "I lost my documents". The wizard makes the unconfigured state explicit and
     * gives it the two paths the pipeline cannot run without.
     *
     * Failure is deliberately silent: if the endpoint is unreachable the dashboard stays as it is
     * rather than blocking on a setup screen the user may not need.
     */
    async checkFirstRun() {
        const wizard = document.getElementById('setupWizard');
        const grid = document.getElementById('docsGrid');
        if (!wizard)
            return;
        let state;
        try {
            const res = await fetch('/api/config/setup-state');
            if (!res.ok)
                return;
            state = await res.json();
        }
        catch {
            return;
        }
        if (state.configured)
            return;
        wizard.hidden = false;
        if (grid)
            grid.style.display = 'none';
        const inputDir = document.getElementById('setupInputDir');
        const outputDir = document.getElementById('setupOutputDir');
        const language = document.getElementById('setupLanguage');
        const dataDir = document.getElementById('setupDataDir');
        const save = document.getElementById('btnSetupSave');
        const errorBox = document.getElementById('setupError');
        // Prefill with the defaults the server would use, so "Save and start" is a valid one-click
        // answer for someone who does not care where the folders live.
        if (inputDir)
            inputDir.value = state.defaults?.input_dir || '';
        if (outputDir)
            outputDir.value = state.defaults?.output_root_dir || '';
        if (language)
            language.value = state.defaults?.language || 'FR';
        if (dataDir && state.dataDir)
            dataDir.textContent = `Settings and database: ${state.dataDir}`;
        this.reportSetupOllamaStatus();
        save?.addEventListener('click', async () => {
            const payload = {
                input_dir: (inputDir?.value || '').trim(),
                output_root_dir: (outputDir?.value || '').trim(),
                language: language?.value || 'FR',
                ollama_host: state.defaults?.ollama_host || 'http://127.0.0.1:11434',
                ollama_model: state.defaults?.ollama_model || 'qwen3.5:9b',
            };
            if (!payload.input_dir || !payload.output_root_dir) {
                this.showSetupError('Both folders are required.');
                return;
            }
            if (payload.input_dir === payload.output_root_dir) {
                // The scanner walks __raws and files into __archive; pointing them at one another makes
                // every archived file look like a new incoming one on the next tick.
                this.showSetupError('The incoming and archive folders must be different.');
                return;
            }
            save.disabled = true;
            save.textContent = 'Saving…';
            try {
                const res = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await res.json();
                if (!res.ok)
                    throw new Error(data.error || 'Could not save settings');
                if (errorBox)
                    errorBox.hidden = true;
                wizard.hidden = true;
                if (grid)
                    grid.style.display = '';
                this.toast.success('Setup complete — watching your incoming folder.');
                this.categoryPills.loadCategories();
                this.documentGrid.loadDocuments();
            }
            catch (err) {
                this.showSetupError(err.message);
            }
            finally {
                save.disabled = false;
                save.textContent = 'Save and start';
            }
        });
    }
    showSetupError(message) {
        const errorBox = document.getElementById('setupError');
        if (!errorBox)
            return;
        errorBox.textContent = message;
        errorBox.hidden = false;
    }
    /** Reflects Ollama reachability in the wizard, so a missing model is visible before saving. */
    async reportSetupOllamaStatus() {
        const badge = document.getElementById('setupOllamaStatus');
        if (!badge)
            return;
        try {
            const res = await fetch('/api/ollama/status');
            const data = await res.json();
            if (res.ok && data.online) {
                badge.textContent = `Ollama ready${data.model ? ` (${data.model})` : ''}`;
                badge.className = 'setup-badge setup-badge-ok';
            }
            else {
                badge.textContent = 'Ollama offline — start it before scanning';
                badge.className = 'setup-badge setup-badge-warn';
            }
        }
        catch {
            badge.textContent = 'Ollama offline — start it before scanning';
            badge.className = 'setup-badge setup-badge-warn';
        }
    }
    /**
     * Uploads the chosen photographs into the incoming folder, one request each.
     *
     * Each image is sent as a raw body rather than JSON or multipart — see the matching comment on
     * POST /api/images/import. Sequential, not parallel: a phone photo batch is tens of megabytes,
     * and firing them all at once buys nothing on a loopback connection while making a partial
     * failure much harder to report.
     *
     * Conversion is not triggered here. The files land in the watched folder and the normal 10s
     * scan picks them up, so an import behaves exactly like copying photos in by hand.
     */
    async handleImportImages(event) {
        const input = event?.target;
        const files = Array.from(input?.files || []);
        if (files.length === 0)
            return;
        // One image: open the editor, since a single photo is exactly the case where the user wants
        // to check the crop before committing. A batch goes straight through — reviewing twenty
        // photos one at a time would be worse than letting the automatic pipeline try first.
        if (files.length === 1) {
            if (input)
                input.value = '';
            await this.imageEditor.openForFile(files[0]);
            return;
        }
        let imported = 0;
        const failures = [];
        this.toast.info(`Importing ${files.length} image(s)…`);
        for (const file of files) {
            try {
                const res = await fetch(`/api/images/import?filename=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: await file.arrayBuffer(),
                });
                const data = await res.json();
                if (!res.ok)
                    throw new Error(data.error || `HTTP ${res.status}`);
                imported++;
            }
            catch (err) {
                failures.push(`${file.name}: ${err.message}`);
            }
        }
        // Clear the picker so choosing the same file again still fires a change event.
        if (input)
            input.value = '';
        if (imported > 0) {
            this.toast.success(`${imported} image(s) added to your incoming folder.\nThey will be straightened, cropped, read and filed on the next scan.`);
            this.documentGrid.loadDocuments();
        }
        if (failures.length > 0) {
            this.toast.error(`Could not import ${failures.length} file(s):\n${failures.slice(0, 3).join('\n')}`);
        }
    }
}
window.TriageApp = TriageApp;
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TriageApp();
    window.app.init();
});
