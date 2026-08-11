/**
 * Main Triage Application Class Module (TypeScript)
 */
class TriageApp {
  toast: any;
  state: any;
  categoryPills: any;
  documentGrid: any;
  modals: any;
  events: any;
  chatAssistant: any;

  constructor() {
    this.toast = new (window as any).ToastFactory();
    this.toast.init();
    (window as any).Toast = this.toast;

    this.state = new (window as any).TriageState();
    this.categoryPills = new (window as any).CategoryPillsManager(this);
    this.documentGrid = new (window as any).DocumentGridManager(this);
    this.modals = new (window as any).ModalsManager(this);
    this.events = new (window as any).TriageEventsManager(this);
    this.chatAssistant = new (window as any).ChatAssistantManager(this);

    this.setupGlobalProxies();
  }

  init(): void {
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
    const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
    const btnClearSearch = document.getElementById('btnClearSearch') as HTMLButtonElement | null;
    
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
    this.addEv('editForm', 'submit', (e: any) => this.modals.handleSaveEdit(e));

    // Settings Modal Listeners
    this.addEv('btnSettings', 'click', () => this.modals.openSettingsModal());
    this.addEv('btnCloseSettings', 'click', () => this.modals.closeSettingsModal());
    this.addEv('settingsForm', 'submit', (e: any) => this.modals.handleSaveSettings(e));
    this.addEv('tabBtnSystem', 'click', () => this.modals.switchSettingsTab('system'));
    this.addEv('tabBtnCategories', 'click', () => this.modals.switchSettingsTab('categories'));
    this.addEv('btnAddCategory', 'click', () => this.modals.handleAddCategory());

    // Tools & Utilities
    this.addEv('btnExportCsv', 'click', () => this.events.exportDocumentsCsv());
    this.addEv('btnExportMarkdown', 'click', () => this.events.exportDocumentsMarkdown());
    this.addEv('btnPdfUtil', 'click', () => this.modals.openPdfUtilModal());
    this.addEv('pdfSplitForm', 'submit', (e: any) => this.modals.handlePdfSplit(e));
    this.addEv('pdfMergeForm', 'submit', (e: any) => this.modals.handlePdfMerge(e));

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

  addEv(id: string, event: string, handler: EventListenerOrEventListenerObject): void {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener(event, handler);
    }
  }

  setupGlobalProxies(): void {
    (window as any).loadCategories = () => this.categoryPills.loadCategories();
    (window as any).loadDocuments = () => this.documentGrid.loadDocuments();
    (window as any).switchGrandViewerTab = (tab: string) => this.modals.switchGrandViewerTab(tab);
    (window as any).openGrandViewerModal = (docId: number, event?: any) => this.modals.openGrandViewerModal(docId, event);
    (window as any).closeGrandViewerModal = () => this.modals.closeGrandViewerModal();
    (window as any).openRelocalizeModal = (docId: number) => this.modals.openRelocalizeModal(docId);
    (window as any).openEditModal = (docId: number) => this.modals.openEditModal(docId);
    (window as any).closeModal = () => this.modals.closeModal();
    (window as any).openPdfUtilModal = () => this.modals.openPdfUtilModal();
    (window as any).closePdfUtilModal = () => this.modals.closePdfUtilModal();
    (window as any).switchPdfUtilTab = (tab: string) => this.modals.switchPdfUtilTab(tab);
    (window as any).openLogsModal = () => this.modals.openLogsModal();
    (window as any).closeLogsModal = () => this.modals.closeLogsModal();
    (window as any).switchLogsTab = (tab: string) => this.modals.switchLogsTab(tab);
    (window as any).loadLogsView = () => this.modals.loadLogsView();
    (window as any).openChatAssistantModal = () => this.chatAssistant.openChatModal();
  }
}

(window as any).TriageApp = TriageApp;

document.addEventListener('DOMContentLoaded', () => {
  (window as any).app = new TriageApp();
  (window as any).app.init();
});
