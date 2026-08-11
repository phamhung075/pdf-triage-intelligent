/**
 * Triage Events & Operations Manager Class Module (TypeScript)
 */
class TriageEventsManager {
    app;
    constructor(app) {
        this.app = app;
    }
    setupLiveReload() {
        if (!!window.EventSource) {
            const source = new EventSource('/api/dev/livereload');
            source.onmessage = e => {
                if (e.data === 'reload') {
                    window.location.reload();
                }
            };
            source.onerror = () => {
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            };
        }
    }
    async checkActiveTaskStatus() {
        try {
            const res = await fetch('/api/triage/status');
            if (res.ok) {
                const state = await res.json();
                this.updateGlobalOperationUI(state);
            }
        }
        catch (err) { }
    }
    updateGlobalOperationUI(taskState) {
        const banner = document.getElementById('globalOperationBanner');
        const typeLabel = document.getElementById('opTypeLabel');
        const counterLabel = document.getElementById('opCounterLabel');
        const progressFill = document.getElementById('opProgressBarFill');
        const currentStage = document.getElementById('opCurrentStage');
        const currentFile = document.getElementById('opCurrentFile');
        const btnScan = document.getElementById('btnScan');
        const btnRepair = document.getElementById('btnRepair');
        const btnClear = document.getElementById('btnClear');
        if (!banner || !taskState)
            return;
        if (taskState.isRunning) {
            banner.classList.remove('hidden');
            let label = 'WORKING...';
            if (taskState.type === 'REPAIR')
                label = '🛠️ REPAIRING REGISTRY & RELOCALIZING...';
            else if (taskState.type === 'SCAN')
                label = '🔍 SCANNING & TRIAGING FILES...';
            else if (taskState.type === 'CLEAR')
                label = '🧹 CLEARING REGISTRY & RETURNING FILES...';
            if (typeLabel)
                typeLabel.textContent = label;
            if (counterLabel)
                counterLabel.textContent = `${taskState.processedFiles || 0} / ${taskState.totalFiles || 0} files (${taskState.percent || 0}%)`;
            if (progressFill)
                progressFill.style.width = `${taskState.percent || 0}%`;
            if (currentStage)
                currentStage.textContent = `Stage: ${taskState.stage || 'Processing'}`;
            if (currentFile)
                currentFile.textContent = taskState.currentFile ? `📄 ${taskState.currentFile}` : (taskState.message || '');
            if (btnScan) {
                if (taskState.type === 'SCAN') {
                    btnScan.disabled = false;
                    btnScan.classList.remove('btn-op-active');
                    btnScan.classList.add('btn-stop-scan');
                    btnScan.innerHTML = '⏹ Stop Scan';
                    btnScan.onclick = () => this.handleStopScan();
                }
                else {
                    btnScan.disabled = true;
                    btnScan.classList.remove('btn-stop-scan', 'btn-op-active');
                    btnScan.textContent = '⚡ Scan & Triage Files';
                    btnScan.onclick = null;
                }
            }
            if (btnRepair) {
                btnRepair.disabled = true;
                if (taskState.type === 'REPAIR') {
                    btnRepair.classList.add('btn-op-active');
                    btnRepair.innerHTML = '⏳ Repairing... <span class="spinner-small"></span>';
                }
                else {
                    btnRepair.classList.remove('btn-op-active');
                    btnRepair.textContent = '🔧 Repair Registry';
                }
            }
            if (btnClear) {
                btnClear.disabled = true;
            }
        }
        else {
            banner.classList.add('hidden');
            if (btnScan) {
                btnScan.disabled = false;
                btnScan.classList.remove('btn-op-active', 'btn-stop-scan');
                btnScan.textContent = '⚡ Scan & Triage Files';
                btnScan.onclick = null;
            }
            if (btnRepair) {
                btnRepair.disabled = false;
                btnRepair.classList.remove('btn-op-active');
                btnRepair.textContent = '🔧 Repair Registry';
            }
            if (btnClear) {
                btnClear.disabled = false;
            }
        }
    }
    setupGlobalTriageSSE() {
        if (!!window.EventSource) {
            const sse = new EventSource('/api/triage/events');
            const refreshDashboard = this.app.state.debounce(() => {
                this.app.categoryPills.loadCategories();
                this.app.documentGrid.loadDocuments();
                this.app.modals.updateBlockedFilesBadge();
            }, 600);
            sse.onmessage = e => {
                try {
                    const evt = JSON.parse(e.data);
                    if (evt.taskState) {
                        this.updateGlobalOperationUI(evt.taskState);
                    }
                    else if (['TASK_STARTED', 'TASK_PROGRESS', 'TASK_FINISHED', 'TASK_FAILED'].includes(evt.type)) {
                        this.checkActiveTaskStatus();
                    }
                    if (evt.type === 'TASK_FINISHED') {
                        this.app.toast.success(`✨ ${evt.taskState ? evt.taskState.message : 'Operation completed successfully!'}`, 5000);
                        refreshDashboard();
                    }
                    else if (evt.type === 'TASK_FAILED') {
                        this.app.toast.error(`❌ ${evt.taskState ? evt.taskState.message : 'Operation failed'}`, 6000);
                        refreshDashboard();
                    }
                    if (['FILE_COMPLETED', 'SCAN_COMPLETED', 'REGISTRY_UPDATED', 'CATEGORIES_UPDATED', 'REPAIR_COMPLETED', 'FILE_FAILED'].includes(evt.type)) {
                        if (evt.type === 'SCAN_COMPLETED' && (evt.processedCount || 0) > 0) {
                            this.app.toast.info(`✨ Triage Scan Completed: Processed ${evt.processedCount} file(s).`, 4000);
                        }
                        refreshDashboard();
                    }
                }
                catch (err) { }
            };
        }
    }
    async checkOllamaStatus() {
        const badge = document.getElementById('ollamaStatusBadge');
        const textEl = document.getElementById('ollamaStatusText');
        const btnStart = document.getElementById('btnStartOllama');
        const btnRestart = document.getElementById('btnRestartServer');
        if (!badge || !textEl)
            return;
        try {
            const res = await fetch('/api/ollama/status');
            const data = await res.json();
            if (data.online) {
                badge.className = 'ollama-status-badge online';
                textEl.textContent = `Ollama AI (${data.model})`;
                badge.title = `Connected to local Ollama AI at ${data.host} (${data.modelsCount} models ready)`;
                if (btnStart)
                    btnStart.style.display = 'none';
                if (btnRestart)
                    btnRestart.style.display = 'none';
                if (data.modelExists) {
                    this.setEngineStatus('Ready', '#10b981');
                }
                else {
                    this.setEngineStatus('Model Missing', '#f59e0b');
                }
            }
            else {
                badge.className = 'ollama-status-badge offline';
                textEl.textContent = 'Ollama Disconnected';
                badge.title = `Cannot connect to Ollama at ${data.host}. Click 'Start Ollama' to launch.`;
                if (btnStart)
                    btnStart.style.display = 'inline-flex';
                if (btnRestart)
                    btnRestart.style.display = 'inline-flex';
                this.setEngineStatus('Disconnected', '#ef4444');
            }
        }
        catch (err) {
            badge.className = 'ollama-status-badge offline';
            textEl.textContent = 'Ollama Offline';
            badge.title = 'Local Ollama server is offline.';
            if (btnStart)
                btnStart.style.display = 'inline-flex';
            if (btnRestart)
                btnRestart.style.display = 'inline-flex';
            this.setEngineStatus('Offline', '#ef4444');
        }
    }
    setEngineStatus(label, color) {
        const el = document.getElementById('statSystemStatus');
        if (!el)
            return;
        el.textContent = label;
        el.style.color = color;
    }
    async handleStartOllama() {
        const btn = document.getElementById('btnStartOllama');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Starting...';
        }
        try {
            await fetch('/api/ollama/start', { method: 'POST' });
            this.app.toast.info('⏳ Launching local Ollama server...');
            setTimeout(() => {
                this.checkOllamaStatus();
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '▶️ Start Ollama';
                }
            }, 2500);
        }
        catch (err) {
            this.app.toast.error('Failed to start Ollama: ' + err.message);
            if (btn) {
                btn.disabled = false;
                btn.textContent = '▶️ Start Ollama';
            }
        }
    }
    async handleRestartServer() {
        if (!confirm('Are you sure you want to restart the backend server?'))
            return;
        try {
            await fetch('/api/server/restart', { method: 'POST' });
        }
        catch (err) { }
    }
    async openFileLocation(targetPath) {
        if (!targetPath)
            return;
        try {
            const res = await fetch('/api/open-location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetPath })
            });
            if (!res.ok) {
                const err = await res.json();
                this.app.toast.error('Error opening location: ' + (err.error || 'Path not found'));
            }
            else {
                this.app.toast.info('📂 Opened Windows Explorer');
            }
        }
        catch (err) {
            this.app.toast.error('Failed to open location: ' + err.message);
        }
    }
    openInChrome(target) {
        if (!target)
            return;
        let fileUrl = '';
        if (typeof target === 'number') {
            fileUrl = `/viewer.html?id=${target}`;
        }
        else {
            fileUrl = `/viewer.html?path=${encodeURIComponent(target)}`;
        }
        window.open(fileUrl, '_blank');
    }
    async handleOpenRaws() {
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.input_dir) {
                this.openFileLocation(cfg.input_dir);
            }
        }
        catch (err) {
            this.app.toast.error('Failed to get input directory: ' + err.message);
        }
    }
    async handleOpenArchive() {
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.output_root_dir) {
                this.openFileLocation(cfg.output_root_dir);
            }
        }
        catch (err) {
            this.app.toast.error('Failed to get output directory: ' + err.message);
        }
    }
    async handleRepairRegistry() {
        const btn = document.getElementById('btnRepair');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Repairing...';
        }
        try {
            const res = await fetch('/api/registry/repair', { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(`Registry Repair Finished:\n- Scanned: ${data.scannedCount}\n- Repaired: ${data.repairedCount}\n- Relocalized: ${data.relocalizedCount || 0}\n- Returned to __raws: ${data.movedToRawsCount || 0}\n- Updated: ${data.updatedCount}`, 6000);
                this.app.categoryPills.loadCategories();
                this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('Failed to repair registry: ' + (data.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to repair registry: ' + err.message);
        }
        finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔧 Repair Registry';
            }
        }
    }
    async handleClearRegistry() {
        if (!confirm('Are you sure you want to clear the registry and move all archived PDFs back to __raws?'))
            return;
        try {
            const res = await fetch('/api/documents', { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(data.message || 'Registry cleared & files returned to __raws!');
                this.app.modals.closeSettingsModal();
                this.app.categoryPills.loadCategories();
                this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('Error clearing registry: ' + (data.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to clear registry: ' + err.message);
        }
    }
    async handleStopScan() {
        const btn = document.getElementById('btnScan');
        const modal = document.getElementById('scanProgressModal');
        const header = document.getElementById('scanProgressHeader');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏹ Stopping...';
        }
        try {
            await fetch('/api/triage/unlock', { method: 'POST' });
            this.app.toast.info('⏹ Scan stopped. Auto-watcher paused for 60s to avoid immediate re-trigger.', 5000);
        }
        catch (err) { }
        if (modal)
            modal.classList.remove('open');
        if (header)
            header.innerHTML = '';
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('btn-stop-scan', 'btn-op-active');
            btn.textContent = '⚡ Scan & Triage Files';
            btn.onclick = null;
        }
        this.checkActiveTaskStatus();
        this.app.categoryPills.loadCategories();
        this.app.documentGrid.loadDocuments();
    }
    async handleScan() {
        const state = this.app.state;
        const btn = document.getElementById('btnScan');
        const modal = document.getElementById('scanProgressModal');
        const header = document.getElementById('scanProgressHeader');
        const list = document.getElementById('scanProgressList');
        const btnClose = document.getElementById('btnCloseScanProgress');
        const btnDone = document.getElementById('btnDoneScanProgress');
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('btn-stop-scan');
            btn.classList.add('btn-op-active');
            btn.innerHTML = '⏹ Stop Scan';
            btn.onclick = () => this.handleStopScan();
        }
        if (modal)
            modal.classList.add('open');
        if (header)
            header.innerHTML = 'Connecting to execution flow stream...';
        if (list)
            list.innerHTML = '';
        if (btnDone)
            btnDone.style.display = 'none';
        const closeProgressModal = () => {
            if (modal)
                modal.classList.remove('open');
            this.app.categoryPills.loadCategories();
            this.app.documentGrid.loadDocuments();
        };
        if (btnClose)
            btnClose.onclick = closeProgressModal;
        if (btnDone)
            btnDone.onclick = closeProgressModal;
        const fileRows = new Map();
        let sse = null;
        if (!!window.EventSource) {
            sse = new EventSource('/api/triage/events');
            sse.onmessage = e => {
                try {
                    const evt = JSON.parse(e.data);
                    if (evt.type === 'SCAN_STARTED') {
                        if (header) {
                            header.innerHTML = `Found <strong>${evt.totalFiles}</strong> incoming PDF(s) in <code>__raws</code> folder. Following live triage flow:`;
                        }
                        (evt.files || []).forEach((fname) => {
                            if (!fileRows.has(fname) && list) {
                                const row = document.createElement('div');
                                row.className = 'scan-progress-row';
                                row.dataset.file = fname;
                                row.innerHTML = `
                  <div style="display: flex; flex-direction: column; gap: 0.2rem;">
                    <span class="scan-progress-filename">📄 ${state.escapeHtml(fname)}</span>
                    <span class="step-msg" style="font-size: 0.78rem; color: #94a3b8;">Queued in __raws...</span>
                  </div>
                  <span class="scan-stage-badge scan-stage-QUEUED">QUEUED</span>
                `;
                                list.appendChild(row);
                                fileRows.set(fname, row);
                            }
                        });
                    }
                    else if (evt.type === 'FILE_PROGRESS') {
                        const row = fileRows.get(evt.filename);
                        if (row) {
                            const msgEl = row.querySelector('.step-msg');
                            const badgeEl = row.querySelector('.scan-stage-badge');
                            if (msgEl)
                                msgEl.textContent = evt.message || evt.stage;
                            if (badgeEl) {
                                badgeEl.className = `scan-stage-badge scan-stage-${evt.stage}`;
                                badgeEl.textContent = this.formatStageName(evt.stage);
                            }
                        }
                    }
                    else if (evt.type === 'FILE_COMPLETED') {
                        const row = fileRows.get(evt.filename);
                        if (row) {
                            const msgEl = row.querySelector('.step-msg');
                            const badgeEl = row.querySelector('.scan-stage-badge');
                            if (msgEl) {
                                msgEl.innerHTML = evt.stage === 'SKIPPED_DUPLICATE'
                                    ? `⏭️ Duplicate (ID: ${evt.docId})`
                                    : `✅ <strong>${state.escapeHtml(evt.title)}</strong> (${evt.category.toUpperCase()}/${(evt.subcategory || 'general').toUpperCase()})`;
                            }
                            if (badgeEl) {
                                badgeEl.className = `scan-stage-badge scan-stage-${evt.stage}`;
                                badgeEl.textContent = evt.stage === 'SKIPPED_DUPLICATE' ? 'SKIPPED DUPLICATE' : 'COMPLETED';
                            }
                        }
                        this.app.categoryPills.loadCategories();
                        this.app.documentGrid.loadDocuments();
                    }
                    else if (evt.type === 'FILE_FAILED') {
                        const row = fileRows.get(evt.filename);
                        if (row) {
                            const msgEl = row.querySelector('.step-msg');
                            const badgeEl = row.querySelector('.scan-stage-badge');
                            if (msgEl)
                                msgEl.textContent = `❌ ${evt.message}`;
                            if (badgeEl) {
                                badgeEl.className = 'scan-stage-badge scan-stage-FAILED';
                                badgeEl.textContent = 'FAILED';
                            }
                        }
                    }
                    else if (evt.type === 'SCAN_COMPLETED') {
                        if (header) {
                            header.innerHTML = `🎉 <strong>Triage Scan Complete!</strong> Scanned: ${evt.scannedCount} | Processed: ${evt.processedCount} | Skipped: ${evt.skippedCount}`;
                        }
                        if (btnDone)
                            btnDone.style.display = 'inline-block';
                        if (sse)
                            sse.close();
                    }
                }
                catch (err) { }
            };
        }
        try {
            const res = await fetch('/api/triage/scan', { method: 'POST' });
            const data = await res.json();
            if (header) {
                header.innerHTML = `🎉 <strong>Triage Scan Complete!</strong> Scanned: ${data.scannedCount} | Processed: ${data.processedCount} | Skipped: ${data.skippedCount}`;
            }
            if (btnDone)
                btnDone.style.display = 'inline-block';
        }
        catch (err) {
            if (!(err && err.name === 'AbortError')) {
                this.app.toast.error('Error running triage scan: ' + err.message);
            }
        }
        finally {
            if (sse)
                sse.close();
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('btn-stop-scan', 'btn-op-active');
                btn.textContent = '⚡ Scan & Triage Files';
                btn.onclick = null;
            }
        }
    }
    formatStageName(stage) {
        switch (stage) {
            case 'EXTRACTING_TEXT': return '📜 Extracting Text';
            case 'AI_CLASSIFYING': return '🤖 AI Classifying';
            case 'RELOCALIZING': return '📂 Relocalizing';
            case 'COMPLETED': return '✅ Completed';
            case 'SKIPPED_DUPLICATE': return '⏭️ Duplicate';
            case 'FAILED': return '❌ Failed';
            default: return stage;
        }
    }
    async handleUnlockOp() {
        if (!confirm('Forcefully clear active operation locks and unlock the system?'))
            return;
        try {
            const res = await fetch('/api/triage/unlock', { method: 'POST' });
            if (res.ok) {
                this.app.toast.success('🔓 Operation lock forcefully cleared!');
                this.checkActiveTaskStatus();
            }
            else {
                this.app.toast.error('Failed to unlock system');
            }
        }
        catch (err) {
            this.app.toast.error('Network error during unlock: ' + err.message);
        }
    }
    exportDocumentsCsv() {
        const state = this.app.state;
        const searchInput = document.getElementById('searchInput');
        const query = searchInput ? searchInput.value.trim() : '';
        let url = '/api/documents/export/csv?';
        if (state.activeCategory)
            url += `category=${encodeURIComponent(state.activeCategory)}&`;
        if (state.activeSubcategory)
            url += `subcategory=${encodeURIComponent(state.activeSubcategory)}&`;
        if (query)
            url += `q=${encodeURIComponent(query)}&`;
        window.location.href = url;
    }
    exportDocumentsMarkdown() {
        window.location.href = '/api/documents/export/markdown';
    }
}
window.TriageEventsManager = TriageEventsManager;
