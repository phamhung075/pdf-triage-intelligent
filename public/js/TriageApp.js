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
        this.setupGlobalProxies();
    }
    init() {
        this.toast.info('🚀 PDF Triage & Agentic Registry Ready\nListening to 10s auto-watcher in __raws', 5000);
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
}
window.TriageApp = TriageApp;
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TriageApp();
    window.app.init();
});
