/**
 * Modals Manager Class Module (TypeScript)
 */
class ModalsManager {
    app;
    debounceLoadSessionLogs;
    constructor(app) {
        this.app = app;
        this.debounceLoadSessionLogs = this.app.state.debounce(() => {
            if (this.app.state.currentLogsTab === 'sessions') {
                this.loadLogsView();
            }
        }, 800);
        this.setupEventListeners();
    }
    setupEventListeners() {
        document.getElementById('relocalizeCatErrorReason')?.addEventListener('change', () => this.combineRelocalizeReasons());
        document.getElementById('relocalizeSubErrorReason')?.addEventListener('change', () => this.combineRelocalizeReasons());
        document.getElementById('relocalizeCategorySelect')?.addEventListener('change', (e) => this.updateSubcategoriesDropdown(e.target.value));
        document.getElementById('relocalizeSubcategorySelect')?.addEventListener('change', (e) => {
            const customInput = document.getElementById('relocalizeCustomSubcategory');
            if (customInput) {
                if (e.target.value === '__NEW__' || e.target.value === '__EDIT__') {
                    customInput.style.display = 'block';
                    if (e.target.value === '__EDIT__') {
                        customInput.value = this.app.state.activeRelocalizeDoc ? this.app.state.activeRelocalizeDoc.subcategory || '' : '';
                        customInput.placeholder = 'Enter updated subcategory slug name...';
                    }
                    else {
                        customInput.value = '';
                        customInput.placeholder = 'Enter new subcategory slug (e.g. credit_mutuel, acme_corp)...';
                    }
                    customInput.focus();
                }
                else {
                    customInput.style.display = 'none';
                }
            }
        });
        document.getElementById('btnCloseRelocalizeModal')?.addEventListener('click', () => {
            const relModal = document.getElementById('relocalizeModal');
            if (relModal)
                relModal.classList.remove('open', 'active');
        });
        document.getElementById('btnConfirmRelocalize')?.addEventListener('click', () => this.handleConfirmRelocalize());
        document.getElementById('btnAiReanalyze')?.addEventListener('click', () => this.handleAiReanalyze());
        document.getElementById('btnCloseGrandViewer')?.addEventListener('click', () => this.closeGrandViewerModal());
        document.getElementById('btnDownloadMarkdown')?.addEventListener('click', () => {
            const doc = this.app.state.currentGrandViewerDoc;
            if (doc && doc.id)
                window.location.href = `/api/documents/${doc.id}/markdown`;
        });
        const grandModal = document.getElementById('grandViewerModal');
        if (grandModal) {
            grandModal.addEventListener('click', e => {
                if (e.target === grandModal)
                    this.closeGrandViewerModal();
            });
        }
        document.getElementById('btnRefreshOllamaModels')?.addEventListener('click', () => {
            this.loadOllamaModels();
        });
        document.getElementById('cfgOllamaModelSelect')?.addEventListener('change', (e) => {
            const inputElem = document.getElementById('cfgOllamaModel');
            if (!inputElem)
                return;
            if (e.target.value === '__custom__') {
                inputElem.style.display = 'block';
                inputElem.focus();
            }
            else {
                inputElem.style.display = 'none';
                inputElem.value = e.target.value;
            }
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                this.closeGrandViewerModal();
            }
        });
    }
    /* --- LOGS MODAL --- */
    openLogsModal() {
        const modal = document.getElementById('logsModal');
        if (modal)
            modal.classList.add('open');
        this.loadLogsView();
    }
    closeLogsModal() {
        const modal = document.getElementById('logsModal');
        if (modal)
            modal.classList.remove('open');
    }
    switchLogsTab(tab) {
        this.app.state.currentLogsTab = tab;
        const streamView = document.getElementById('logsStreamView');
        const sessionsView = document.getElementById('logsSessionsView');
        const btnStream = document.getElementById('btnLogsTabStream');
        const btnSessions = document.getElementById('btnLogsTabSessions');
        if (tab === 'stream') {
            if (streamView)
                streamView.style.display = 'flex';
            if (sessionsView)
                sessionsView.style.display = 'none';
            if (btnStream)
                btnStream.style.borderBottom = '2px solid #38bdf8';
            if (btnSessions)
                btnSessions.style.borderBottom = 'none';
        }
        else {
            if (streamView)
                streamView.style.display = 'none';
            if (sessionsView)
                sessionsView.style.display = 'flex';
            if (btnStream)
                btnStream.style.borderBottom = 'none';
            if (btnSessions)
                btnSessions.style.borderBottom = '2px solid #38bdf8';
        }
        this.loadLogsView();
    }
    async loadLogsView() {
        const state = this.app.state;
        if (state.currentLogsTab === 'stream') {
            try {
                const res = await fetch('/api/logs/recent?limit=300');
                const data = await res.json();
                const container = document.getElementById('terminalLogContainer');
                if (container && Array.isArray(data.logs)) {
                    container.innerHTML = data.logs.map((entry) => this.formatLogLine(entry)).join('');
                    container.scrollTop = container.scrollHeight;
                }
            }
            catch (err) { }
        }
        else {
            try {
                const res = await fetch('/api/logs/sessions');
                const data = await res.json();
                const container = document.getElementById('groupedSessionsContainer');
                if (container && Array.isArray(data.sessions)) {
                    if (data.sessions.length === 0) {
                        container.innerHTML = '<div style="color: #64748b; font-style: italic; padding: 1rem;">No document processing sessions recorded yet. Run a scan or repair to populate session traces.</div>';
                        return;
                    }
                    container.innerHTML = data.sessions.map((sess, idx) => {
                        const statusBadge = sess.status === 'COMPLETED'
                            ? '<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);">✅ COMPLETED</span>'
                            : (sess.status === 'FAILED'
                                ? '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);">❌ FAILED</span>'
                                : '<span class="badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4);">⏳ IN PROGRESS</span>');
                        const catInfo = sess.category ? `<span class="badge badge-sub" style="font-size: 0.75rem;">${sess.category.toUpperCase()}/${(sess.subcategory || 'general').toUpperCase()}</span>` : '<span style="color: #64748b; font-size: 0.78rem;">Pending...</span>';
                        const reasonInfo = sess.decisionReason ? `<div style="font-size: 0.8rem; color: #38bdf8; background: rgba(56, 189, 248, 0.1); border-left: 3px solid #38bdf8; padding: 0.4rem 0.6rem; border-radius: 4px; margin-bottom: 0.6rem;">💡 <strong>Decision Logic:</strong> ${state.escapeHtml(sess.decisionReason)}</div>` : '';
                        const logLines = (sess.logs || []).map((entry) => this.formatLogLine(entry)).join('');
                        return `
              <div class="log-session-row-wrapper">
                <div class="log-session-row-header" onclick="app.modals.toggleSessionDetails(${idx})">
                  <div style="flex: 2; font-weight: 700; font-size: 0.88rem; color: #f8fafc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 0.4rem;">
                    📄 ${state.escapeHtml(sess.filename)}
                  </div>
                  <div style="flex: 1.2; white-space: nowrap;">${catInfo}</div>
                  <div style="font-size: 0.78rem; color: #94a3b8; font-family: monospace; white-space: nowrap;">
                    ${sess.logsCount} event${sess.logsCount === 1 ? '' : 's'} • ${new Date(sess.updatedAt).toLocaleTimeString()}
                  </div>
                  <div style="white-space: nowrap;">${statusBadge}</div>
                  <button class="btn-secondary log-session-toggle-btn" id="btnToggleSess_${idx}">
                    <span id="btnIconSess_${idx}">🔽</span>
                  </button>
                </div>
                <div id="sessDetails_${idx}" class="log-session-dropdown" style="display: none;">
                  ${reasonInfo}
                  <div class="log-session-lines">${logLines}</div>
                </div>
              </div>
            `;
                    }).join('');
                }
            }
            catch (err) { }
        }
    }
    toggleSessionDetails(idx) {
        const el = document.getElementById(`sessDetails_${idx}`);
        const btnIcon = document.getElementById(`btnIconSess_${idx}`);
        if (el) {
            if (el.style.display === 'none') {
                el.style.display = 'block';
                if (btnIcon)
                    btnIcon.style.transform = 'rotate(180deg)';
            }
            else {
                el.style.display = 'none';
                if (btnIcon)
                    btnIcon.style.transform = 'rotate(0deg)';
            }
        }
    }
    formatLogLine(entry) {
        const state = this.app.state;
        let levelColor = '#94a3b8';
        if (entry.level === 'INFO')
            levelColor = '#34d399';
        if (entry.level === 'WARN')
            levelColor = '#fbbf24';
        if (entry.level === 'ERROR')
            levelColor = '#f87171';
        if (entry.level === 'DEBUG')
            levelColor = '#38bdf8';
        const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
        const metaStr = entry.meta ? ` <span style="color: #64748b;">| ${state.escapeHtml(JSON.stringify(entry.meta))}</span>` : '';
        return `<div><span style="color: #475569;">[${timeStr}]</span> <span style="color: ${levelColor}; font-weight: bold;">[${entry.level}]</span> <span style="color: #c084fc;">[${state.escapeHtml(entry.moduleName)}]</span> ${state.escapeHtml(entry.message)}${metaStr}</div>`;
    }
    setupLogsSSE() {
        const state = this.app.state;
        if (!window.EventSource || state.logsSseConnected)
            return;
        state.logsSseConnected = true;
        const logSource = new EventSource('/api/logs/stream');
        logSource.onmessage = e => {
            try {
                const data = JSON.parse(e.data);
                const container = document.getElementById('terminalLogContainer');
                if (data.type === 'INIT' && Array.isArray(data.logs)) {
                    if (container) {
                        container.innerHTML = data.logs.map((entry) => this.formatLogLine(entry)).join('');
                        container.scrollTop = container.scrollHeight;
                    }
                }
                else if (data.type === 'LOG' && data.entry) {
                    if (container) {
                        const lineHtml = this.formatLogLine(data.entry);
                        container.insertAdjacentHTML('beforeend', lineHtml);
                        while (container.children.length > 300) {
                            container.removeChild(container.firstChild);
                        }
                        container.scrollTop = container.scrollHeight;
                    }
                    if (state.currentLogsTab === 'sessions') {
                        this.debounceLoadSessionLogs();
                    }
                }
            }
            catch (err) { }
        };
    }
    /* --- PDF TOOL MODAL --- */
    openPdfUtilModal() {
        const modal = document.getElementById('pdfUtilModal');
        if (modal)
            modal.classList.add('open');
    }
    closePdfUtilModal() {
        const modal = document.getElementById('pdfUtilModal');
        if (modal)
            modal.classList.remove('open');
    }
    switchPdfUtilTab(tab) {
        const splitTab = document.getElementById('pdfSplitTab');
        const mergeTab = document.getElementById('pdfMergeTab');
        const btnSplit = document.getElementById('tabBtnSplit');
        const btnMerge = document.getElementById('tabBtnMerge');
        if (tab === 'split') {
            if (splitTab)
                splitTab.style.display = 'block';
            if (mergeTab)
                mergeTab.style.display = 'none';
            if (btnSplit)
                btnSplit.style.borderBottom = '2px solid var(--accent-blue)';
            if (btnMerge)
                btnMerge.style.borderBottom = 'none';
        }
        else {
            if (splitTab)
                splitTab.style.display = 'none';
            if (mergeTab)
                mergeTab.style.display = 'block';
            if (btnSplit)
                btnSplit.style.borderBottom = 'none';
            if (btnMerge)
                btnMerge.style.borderBottom = '2px solid var(--accent-blue)';
        }
    }
    async handlePdfSplit(e) {
        e.preventDefault();
        const state = this.app.state;
        const filepath = state.getVal('pdfSplitPath').trim();
        if (!filepath)
            return;
        try {
            const res = await fetch('/api/pdf/split', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filepath })
            });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(data.message || 'PDF split successfully!');
                this.closePdfUtilModal();
                this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('Split error: ' + (data.error || 'Failed to split PDF'));
            }
        }
        catch (err) {
            this.app.toast.error('Network error during PDF split: ' + err.message);
        }
    }
    async handlePdfMerge(e) {
        e.preventDefault();
        const state = this.app.state;
        const rawPaths = state.getVal('pdfMergePaths').trim();
        const outputFilename = state.getVal('pdfMergeOutputName').trim();
        const filepaths = rawPaths.split('\n').map((p) => p.trim()).filter(Boolean);
        if (filepaths.length < 2) {
            this.app.toast.warning('Please enter at least 2 absolute PDF filepaths to merge.');
            return;
        }
        try {
            const res = await fetch('/api/pdf/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filepaths, outputFilename })
            });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(data.message || 'PDFs merged successfully!');
                this.closePdfUtilModal();
                this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('Merge error: ' + (data.error || 'Failed to merge PDFs'));
            }
        }
        catch (err) {
            this.app.toast.error('Network error during PDF merge: ' + err.message);
        }
    }
    /* --- BLOCKED FILES MODAL --- */
    async updateBlockedFilesBadge() {
        try {
            const res = await fetch('/api/blocked-files');
            if (!res.ok)
                return;
            const data = await res.json();
            const badge = document.getElementById('blockedFilesBadge');
            if (!badge)
                return;
            if (data.total > 0) {
                badge.textContent = data.total;
                badge.style.display = 'inline-block';
            }
            else {
                badge.style.display = 'none';
            }
        }
        catch (err) { }
    }
    async openBlockedFilesModal() {
        const state = this.app.state;
        const modal = document.getElementById('blockedFilesModal');
        if (!modal)
            return;
        modal.classList.add('open', 'active');
        const listEl = document.getElementById('blockedFilesList');
        const countEl = document.getElementById('blockedFilesModalCount');
        if (listEl)
            listEl.innerHTML = '<div style="color: #6b7280; font-style: italic;">Loading...</div>';
        try {
            const res = await fetch('/api/blocked-files');
            if (!res.ok) {
                this.app.toast.error('Could not load blocked files');
                return;
            }
            const data = await res.json();
            if (countEl)
                countEl.textContent = `(${data.total})`;
            if (!listEl)
                return;
            if (data.total === 0) {
                listEl.innerHTML = '<div style="color: #64748b; padding: 2rem; text-align: center;">✅ No blocked files right now.</div>';
                return;
            }
            listEl.innerHTML = data.files.map((f) => `
        <div style="background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.6rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
            <strong style="color: #f8fafc; word-break: break-all;">${state.escapeHtml(f.filename)}</strong>
            <span style="color: #f87171; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); border-radius: 6px; padding: 0.1rem 0.5rem; font-size: 0.75rem; white-space: nowrap;">${state.escapeHtml(f.reason)}</span>
          </div>
          <div style="color: #94a3b8; font-size: 0.85rem; margin-top: 0.3rem;">${state.escapeHtml(f.message)}</div>
          <div style="color: #64748b; font-size: 0.75rem; margin-top: 0.3rem;">Blocked ${state.escapeHtml(f.blocked_at || '')}</div>
        </div>
      `).join('');
        }
        catch (err) {
            this.app.toast.error('Failed to load blocked files: ' + err.message);
        }
    }
    closeBlockedFilesModal() {
        const modal = document.getElementById('blockedFilesModal');
        if (modal) {
            modal.classList.remove('open');
            modal.classList.remove('active');
        }
    }
    setupBlockedFilesModal() {
        const btn = document.getElementById('btnBlockedFiles');
        const modal = document.getElementById('blockedFilesModal');
        const btnClose = document.getElementById('btnCloseBlockedFilesModal');
        if (!btn || !modal)
            return;
        btn.addEventListener('click', () => this.openBlockedFilesModal());
        if (btnClose) {
            btnClose.addEventListener('click', () => this.closeBlockedFilesModal());
        }
        modal.addEventListener('click', e => {
            if (e.target === modal)
                this.closeBlockedFilesModal();
        });
    }
    /* --- GRAND VIEWER MODAL --- */
    switchGrandViewerTab(tab) {
        const state = this.app.state;
        state.currentGrandViewerTab = tab;
        const btnMd = document.getElementById('btnGrandTabMarkdown');
        const btnRaw = document.getElementById('btnGrandTabRaw');
        if (tab === 'markdown') {
            if (btnMd)
                btnMd.style.borderBottom = '2px solid var(--accent-blue)';
            if (btnRaw)
                btnRaw.style.borderBottom = 'none';
        }
        else {
            if (btnMd)
                btnMd.style.borderBottom = 'none';
            if (btnRaw)
                btnRaw.style.borderBottom = '2px solid var(--accent-blue)';
        }
        if (state.currentGrandViewerDoc) {
            this.updateGrandViewerTextDisplay();
        }
    }
    updateGrandViewerTextDisplay() {
        const state = this.app.state;
        if (!state.currentGrandViewerDoc)
            return;
        const doc = state.currentGrandViewerDoc;
        const isMdTab = state.currentGrandViewerTab === 'markdown';
        let contentText = isMdTab ? (doc.markdown_content || doc.raw_text || '') : (doc.raw_text || doc.markdown_content || '');
        contentText = contentText.trim();
        const textEl = document.getElementById('grandViewerTextContent');
        if (textEl) {
            if (isMdTab) {
                textEl.innerHTML = state.renderMarkdown(contentText) || '(No markdown content available)';
            }
            else {
                textEl.innerHTML = `<pre style="white-space: pre-wrap; font-family: monospace; font-size: 0.85rem; color: #e0f2fe; line-height: 1.5; margin: 0;">${state.escapeHtml(contentText)}</pre>`;
            }
        }
        const charCountEl = document.getElementById('grandViewerCharCount');
        if (charCountEl) {
            charCountEl.textContent = `${contentText.length.toLocaleString()} characters`;
        }
    }
    async openGrandViewerModal(docId, event) {
        const state = this.app.state;
        if (event) {
            try {
                event.stopPropagation();
            }
            catch (e) { }
        }
        const modal = document.getElementById('grandViewerModal');
        if (!modal)
            return;
        modal.style.zIndex = '2500';
        modal.classList.add('open', 'active');
        const titleEl = document.getElementById('grandViewerTitle');
        if (titleEl)
            titleEl.textContent = '⏳ Loading Document...';
        const textEl = document.getElementById('grandViewerTextContent');
        if (textEl)
            textEl.textContent = 'Fetching full document text from server...';
        try {
            const res = await fetch(`/api/documents/${docId}`);
            if (!res.ok) {
                this.app.toast.error('Could not load document for Grand Viewer');
                this.closeGrandViewerModal();
                return;
            }
            const doc = await res.json();
            state.currentGrandViewerDoc = doc;
            if (titleEl)
                titleEl.textContent = `📖 ${doc.title || 'Untitled Document'}`;
            const catBadge = document.getElementById('grandViewerCategoryBadge');
            if (catBadge)
                catBadge.textContent = (doc.category || 'OTHER').toUpperCase();
            const subBadge = document.getElementById('grandViewerSubcategoryBadge');
            if (subBadge) {
                if (doc.subcategory && doc.subcategory !== 'general') {
                    subBadge.textContent = doc.subcategory.toUpperCase().replace(/[\/\\]+/g, ' / ');
                    subBadge.style.display = 'inline-block';
                }
                else {
                    subBadge.style.display = 'none';
                }
            }
            const dateEl = document.getElementById('grandViewerMetaDate');
            if (dateEl)
                dateEl.textContent = `📅 Date: ${doc.date || 'N/A'}`;
            const regEl = document.getElementById('grandViewerMetaRegistre');
            if (regEl)
                regEl.textContent = `🏷️ Ref: ${doc.registre || 'No Ref'}`;
            const sumEl = document.getElementById('grandViewerSummary');
            if (sumEl)
                sumEl.innerHTML = state.renderMarkdown(doc.summary || 'No summary available.');
            const contactNameVal = (doc.contact_name || '').trim();
            const contactNameEl = document.getElementById('grandViewerContactName');
            if (contactNameEl)
                contactNameEl.textContent = contactNameVal || '-';
            const contactEmailEl = document.getElementById('grandViewerContactEmail');
            if (contactEmailEl)
                contactEmailEl.textContent = doc.contact_email || '-';
            const contactPhoneEl = document.getElementById('grandViewerContactPhone');
            if (contactPhoneEl)
                contactPhoneEl.textContent = doc.contact_phone || '-';
            const contactAddrEl = document.getElementById('grandViewerContactAddress');
            if (contactAddrEl)
                contactAddrEl.textContent = doc.contact_address || '-';
            const contactWebEl = document.getElementById('grandViewerContactWebsite');
            if (contactWebEl)
                contactWebEl.textContent = doc.contact_website || '-';
            const btnSearchContact = document.getElementById('btnGrandSearchContactDocs');
            if (btnSearchContact) {
                const contactVal = contactNameVal || doc.contact_email;
                if (contactVal) {
                    btnSearchContact.style.display = 'block';
                    btnSearchContact.onclick = () => {
                        this.closeGrandViewerModal();
                        this.app.categoryPills.filterByContact(contactVal);
                    };
                }
                else {
                    btnSearchContact.style.display = 'none';
                }
            }
            const origEl = document.getElementById('grandViewerOrigName');
            if (origEl)
                origEl.textContent = doc.original_filename || '-';
            const statusEl = document.getElementById('grandViewerStatus');
            if (statusEl)
                statusEl.textContent = (doc.status || 'MOVED').toUpperCase();
            const pathEl = document.getElementById('grandViewerPath');
            const targetPath = doc.new_path || doc.original_path || '-';
            if (pathEl)
                pathEl.textContent = targetPath;
            const tagsEl = document.getElementById('grandViewerTags');
            if (tagsEl) {
                const tags = (doc.tags || []);
                tagsEl.innerHTML = '';
                if (tags.length === 0) {
                    tagsEl.innerHTML = '<span style="color: #64748b;">No tags</span>';
                }
                else {
                    tags.forEach((t) => {
                        const span = document.createElement('span');
                        span.className = 'tag tag-clickable';
                        span.textContent = `#${t}`;
                        span.addEventListener('click', () => {
                            this.closeGrandViewerModal();
                            this.app.categoryPills.filterBySearchOrSubcategory(t, doc.category, doc.subcategory);
                        });
                        tagsEl.appendChild(span);
                    });
                }
            }
            state.currentGrandViewerTab = doc.markdown_content ? 'markdown' : 'raw';
            this.switchGrandViewerTab(state.currentGrandViewerTab);
            this.updateGrandViewerTextDisplay();
            const btnChrome = document.getElementById('btnGrandOpenChrome');
            if (btnChrome)
                btnChrome.onclick = () => this.app.events.openInChrome(doc.id);
            const btnLoc = document.getElementById('btnGrandOpenLocation');
            if (btnLoc)
                btnLoc.onclick = () => this.app.events.openFileLocation(targetPath);
            const btnReanalyze = document.getElementById('btnGrandReanalyze');
            if (btnReanalyze) {
                btnReanalyze.onclick = async () => {
                    btnReanalyze.disabled = true;
                    const originalText = btnReanalyze.innerHTML;
                    btnReanalyze.innerHTML = '⏳ Rescanning...';
                    try {
                        const reRes = await fetch(`/api/documents/${doc.id}/relocalize`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({})
                        });
                        const reData = await reRes.json();
                        if (reRes.ok && reData.success) {
                            this.app.toast.success('🔄 Document re-analyzed & updated successfully!');
                            await this.openGrandViewerModal(doc.id);
                            this.app.documentGrid.loadDocuments();
                        }
                        else {
                            this.app.toast.error('Re-analysis failed: ' + (reData.error || 'Unknown error'));
                        }
                    }
                    catch (err) {
                        this.app.toast.error('Re-analysis error: ' + err.message);
                    }
                    finally {
                        btnReanalyze.disabled = false;
                        btnReanalyze.innerHTML = originalText;
                    }
                };
            }
            const btnRel = document.getElementById('btnGrandRelocalize');
            if (btnRel) {
                btnRel.onclick = () => {
                    this.closeGrandViewerModal();
                    this.openRelocalizeModal(doc.id);
                };
            }
            const btnEdt = document.getElementById('btnGrandEdit');
            if (btnEdt) {
                btnEdt.onclick = () => {
                    this.closeGrandViewerModal();
                    this.openEditModal(doc.id);
                };
            }
            const btnCpy = document.getElementById('btnGrandCopyText');
            if (btnCpy) {
                btnCpy.onclick = () => {
                    const textToCopy = (state.currentGrandViewerTab === 'markdown') ? (doc.markdown_content || doc.raw_text || '') : (doc.raw_text || doc.markdown_content || '');
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        this.app.toast.success('📋 Full document text copied to clipboard!');
                    }).catch(() => {
                        this.app.toast.error('Failed to copy text');
                    });
                };
            }
            const btnDel = document.getElementById('btnGrandDelete');
            if (btnDel) {
                btnDel.onclick = async () => {
                    if (!confirm(`Are you sure you want to delete '${doc.title || doc.original_filename}'?\n\nThis will unregister the document from the database and move the file to the trash folder.`))
                        return;
                    btnDel.disabled = true;
                    const originalText = btnDel.innerHTML;
                    btnDel.innerHTML = '⏳ Deleting...';
                    try {
                        const delRes = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
                        const delData = await delRes.json();
                        if (delRes.ok && delData.success) {
                            this.app.toast.success(delData.message || '🗑️ Document deleted and moved to the trash folder');
                            this.closeGrandViewerModal();
                            this.app.documentGrid.loadDocuments();
                        }
                        else {
                            this.app.toast.error('Delete failed: ' + (delData.error || 'Unknown error'));
                        }
                    }
                    catch (err) {
                        this.app.toast.error('Delete error: ' + err.message);
                    }
                    finally {
                        btnDel.disabled = false;
                        btnDel.innerHTML = originalText;
                    }
                };
            }
        }
        catch (err) {
            this.app.toast.error('Failed to open Grand Viewer: ' + err.message);
            if (textEl)
                textEl.textContent = '⚠️ Failed to load document text: ' + err.message;
        }
    }
    closeGrandViewerModal() {
        const modal = document.getElementById('grandViewerModal');
        if (modal) {
            modal.classList.remove('open');
            modal.classList.remove('active');
        }
    }
    /* --- RELOCALIZE MODAL --- */
    async openRelocalizeModal(docId) {
        const state = this.app.state;
        try {
            const res = await fetch(`/api/documents/${docId}`);
            const doc = await res.json();
            if (!res.ok) {
                this.app.toast.error('Error opening relocalize modal: ' + (doc.error || 'Document not found'));
                return;
            }
            state.activeRelocalizeDoc = doc;
            document.getElementById('relocalizeDocId').value = doc.id.toString();
            document.getElementById('relocalizeDocTitle').textContent = doc.title;
            document.getElementById('relocalizeCurrentPath').textContent = `Current Path: ${doc.new_path || doc.original_path}`;
            document.getElementById('relocalizeReason').value = '';
            document.getElementById('relocalizeCustomSubcategory').value = '';
            document.getElementById('relocalizeCustomSubcategory').style.display = 'none';
            const catList = (window.categories && window.categories.length > 0) ? window.categories : (state.categories || []);
            const catSelect = document.getElementById('relocalizeCategorySelect');
            catSelect.innerHTML = catList.map((c) => `<option value="${c.id}" ${c.id === doc.category ? 'selected' : ''}>${state.getLocalizedName(c)} (${c.id})</option>`).join('');
            this.updateSubcategoriesDropdown(doc.category, doc.subcategory);
            const relModal = document.getElementById('relocalizeModal');
            if (relModal)
                relModal.classList.add('open', 'active');
        }
        catch (err) {
            this.app.toast.error('Error opening relocalize modal: ' + err.message);
        }
    }
    updateSubcategoriesDropdown(selectedCatId, selectedSubId) {
        const state = this.app.state;
        const catList = (window.categories && window.categories.length > 0) ? window.categories : (state.categories || []);
        const catObj = catList.find((c) => c.id === selectedCatId);
        const subSelect = document.getElementById('relocalizeSubcategorySelect');
        const allSubs = (catObj && catObj.subcategories) ? catObj.subcategories : [];
        const subs = allSubs
            .filter((s) => !state.isForbiddenSubcategory(s.id))
            .sort((a, b) => state.getLocalizedName(a).localeCompare(state.getLocalizedName(b), undefined, { sensitivity: 'base' }));
        let optionsHtml = subs.map((s) => `<option value="${s.id}" ${s.id === selectedSubId ? 'selected' : ''}>${state.getLocalizedName(s)} (${s.id})</option>`).join('');
        optionsHtml += `<option value="__EDIT__">✏️ Rename / Edit Current Subcategory...</option>`;
        optionsHtml += `<option value="__NEW__">➕ Add New Subcategory...</option>`;
        subSelect.innerHTML = optionsHtml;
        const customInput = document.getElementById('relocalizeCustomSubcategory');
        if (subSelect.value === '__NEW__' || subSelect.value === '__EDIT__') {
            customInput.style.display = 'block';
            if (subSelect.value === '__EDIT__') {
                customInput.value = selectedSubId || '';
                customInput.placeholder = 'Enter updated subcategory slug name...';
            }
            else {
                customInput.value = '';
                customInput.placeholder = 'Enter new subcategory slug (e.g. credit_mutuel, acme_corp)...';
            }
        }
        else {
            customInput.style.display = 'none';
        }
    }
    combineRelocalizeReasons() {
        const catReason = document.getElementById('relocalizeCatErrorReason')?.value || '';
        const subReason = document.getElementById('relocalizeSubErrorReason')?.value || '';
        const parts = [];
        if (catReason && catReason !== '__CUSTOM__')
            parts.push(`Category Error: ${catReason}`);
        if (subReason && subReason !== '__CUSTOM__')
            parts.push(`Subcategory Error: ${subReason}`);
        const textarea = document.getElementById('relocalizeReason');
        if (textarea)
            textarea.value = parts.join(' | ');
    }
    async handleConfirmRelocalize() {
        const state = this.app.state;
        const docId = document.getElementById('relocalizeDocId').value;
        const category = document.getElementById('relocalizeCategorySelect').value;
        let subcategory = document.getElementById('relocalizeSubcategorySelect').value;
        const customSub = document.getElementById('relocalizeCustomSubcategory').value.trim();
        const reason = document.getElementById('relocalizeReason').value.trim();
        if (subcategory === '__NEW__' || subcategory === '__EDIT__') {
            if (!customSub) {
                this.app.toast.error('Please enter a valid custom subcategory slug.');
                return;
            }
            subcategory = customSub.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
        }
        if (state.isForbiddenSubcategory(subcategory)) {
            this.app.toast.error(`'${subcategory}' is not a valid subcategory (general/other/divers/year strings aren't allowed). Please choose a specific entity or document-type name.`);
            return;
        }
        try {
            const res = await fetch(`/api/documents/${docId}/relocalize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, subcategory, reason })
            });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(`📍 Relocalized to: ${category.toUpperCase()} / ${subcategory.toUpperCase()}\n${data.document?.new_path || ''}`, 5000);
                const relModal = document.getElementById('relocalizeModal');
                if (relModal)
                    relModal.classList.remove('open', 'active');
                if (data.document?.category) {
                    state.activeCategory = data.document.category;
                    state.activeSubcategory = data.document.subcategory || '';
                }
                else {
                    state.activeCategory = category;
                    state.activeSubcategory = subcategory;
                }
                await this.app.categoryPills.loadCategories();
                await this.app.documentGrid.loadDocuments();
            }
            else if (res.status === 404 || data.staleCleaned) {
                this.app.toast.info('ℹ️ That document was missing on disk — its stale record has been cleaned up.');
                const relModal = document.getElementById('relocalizeModal');
                if (relModal)
                    relModal.classList.remove('open', 'active');
                await this.app.categoryPills.loadCategories();
                await this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('Relocalize failed: ' + (data.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to relocalize: ' + err.message);
        }
    }
    async handleAiReanalyze() {
        const docId = document.getElementById('relocalizeDocId').value;
        const reason = document.getElementById('relocalizeReason').value.trim();
        const state = this.app.state;
        try {
            this.app.toast.info('🤖 Re-analyzing document with Qwen 3.5 AI & user feedback...', 4000);
            const res = await fetch(`/api/documents/${docId}/relocalize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            });
            const data = await res.json();
            if (res.ok) {
                this.app.toast.success(`🤖 AI Re-Analysis Complete!\nMoved to: ${data.document?.category.toUpperCase()} / ${data.document?.subcategory.toUpperCase()}`, 5000);
                const relModal = document.getElementById('relocalizeModal');
                if (relModal)
                    relModal.classList.remove('open', 'active');
                if (data.document?.category) {
                    state.activeCategory = data.document.category;
                    state.activeSubcategory = data.document.subcategory || '';
                }
                await this.app.categoryPills.loadCategories();
                await this.app.documentGrid.loadDocuments();
            }
            else if (res.status === 404 || data.staleCleaned) {
                this.app.toast.info('ℹ️ That document was missing on disk — its stale record has been cleaned up.');
                const relModal = document.getElementById('relocalizeModal');
                if (relModal)
                    relModal.classList.remove('open', 'active');
                await this.app.categoryPills.loadCategories();
                await this.app.documentGrid.loadDocuments();
            }
            else {
                this.app.toast.error('AI Re-Analysis failed: ' + (data.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('AI Re-Analysis error: ' + err.message);
        }
    }
    /* --- EDIT METADATA MODAL --- */
    async openEditModal(docId) {
        const state = this.app.state;
        try {
            const res = await fetch(`/api/documents/${docId}`);
            const doc = await res.json();
            if (!res.ok) {
                this.app.toast.error('Failed to load document details: ' + (doc.error || 'Document not found'));
                return;
            }
            state.setVal('editDocId', doc.id);
            state.setVal('editTitle', doc.title);
            state.setVal('editRegistre', doc.registre || '');
            state.setVal('editDate', doc.date || '');
            state.setVal('editCategory', doc.category || 'other');
            state.setVal('editSubcategory', doc.subcategory || 'general');
            state.setVal('editSummary', (doc.summary || '').trim());
            state.setVal('editTags', (doc.tags || []).join(', '));
            // Populate info strip
            const subtitle = document.getElementById('editModalSubtitle');
            if (subtitle)
                subtitle.textContent = `ID #${doc.id} · Created ${doc.created_at ? doc.created_at.substring(0, 10) : '?'}`;
            const infoFilename = document.getElementById('editInfoFilename');
            if (infoFilename)
                infoFilename.textContent = `📄 ${doc.original_filename || doc.title}`;
            const infoStatus = document.getElementById('editInfoStatus');
            if (infoStatus) {
                const statusColor = { MOVED: '#4ade80', PENDING: '#facc15', FAILED: '#f87171', SKIPPED: '#94a3b8' };
                infoStatus.textContent = `🏷️ ${(doc.status || 'UNKNOWN').toUpperCase()}`;
                infoStatus.style.color = statusColor[doc.status] || '#94a3b8';
            }
            const infoPath = document.getElementById('editInfoPath');
            if (infoPath) {
                const p = doc.new_path || doc.original_path || '';
                infoPath.textContent = `📂 ${p.length > 70 ? '…' + p.slice(-67) : p}`;
                infoPath.title = p;
            }
            // Populate raw text panel
            const rawTextEl = document.getElementById('editRawText');
            if (rawTextEl) {
                rawTextEl.value = doc.markdown_content || doc.raw_text || '[No text content extracted]';
            }
            // Set char count for summary
            const sumEl = document.getElementById('editSummary');
            const countEl = document.getElementById('editSummaryCount');
            if (sumEl && countEl)
                countEl.textContent = sumEl.value.length + ' chars';
            // Ensure raw text section starts collapsed
            const rawSection = rawTextEl?.closest('.edit-section');
            if (rawSection)
                rawSection.classList.add('edit-section-collapsed');
            const modal = document.getElementById('editModal');
            if (modal)
                modal.classList.add('open');
        }
        catch (err) {
            this.app.toast.error('Failed to load document details: ' + err.message);
        }
    }
    closeModal() {
        const modal = document.getElementById('editModal');
        if (modal)
            modal.classList.remove('open');
    }
    async handleSaveEdit(e) {
        e.preventDefault();
        const state = this.app.state;
        const id = state.getVal('editDocId');
        const updates = {
            title: state.getVal('editTitle'),
            registre: state.getVal('editRegistre'),
            date: state.getVal('editDate'),
            category: state.getVal('editCategory'),
            subcategory: state.getVal('editSubcategory'),
            summary: state.getVal('editSummary'),
            tags: state.getVal('editTags').split(',').map((t) => t.trim()).filter(Boolean)
        };
        if (state.isForbiddenSubcategory(updates.subcategory)) {
            this.app.toast.error(`'${updates.subcategory}' is not a valid subcategory (general/other/divers/year strings aren't allowed). Please choose a specific entity or document-type name.`);
            return;
        }
        try {
            const res = await fetch(`/api/documents/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (res.ok) {
                this.closeModal();
                this.app.toast.success('Document updated & synced successfully!');
                this.app.categoryPills.loadCategories();
                this.app.documentGrid.loadDocuments();
            }
            else {
                const error = await res.json();
                this.app.toast.error('Error updating document: ' + (error.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to save edit: ' + err.message);
        }
    }
    /* --- SETTINGS MODAL --- */
    async openSettingsModal() {
        const state = this.app.state;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            state.setVal('cfgLanguage', cfg.language || 'FR');
            state.systemLanguage = cfg.language || 'FR';
            state.setVal('cfgInputDir', cfg.input_dir || '');
            state.setVal('cfgOutputDir', cfg.output_root_dir || '');
            state.setVal('cfgOllamaHost', cfg.ollama_host || 'http://127.0.0.1:11434');
            await this.loadOllamaModels(cfg.ollama_model);
            try {
                const statsRes = await fetch('/api/system/stats');
                if (statsRes.ok) {
                    const stats = await statsRes.json();
                    state.setElemText('statRawsSize', stats.raws?.sizeFormatted || '0 B');
                    state.setElemText('statRawsCount', `${stats.raws?.count || 0} files`);
                    state.setElemText('statArchiveSize', stats.archive?.sizeFormatted || '0 B');
                    state.setElemText('statArchiveCount', `${stats.archive?.count || 0} files`);
                    state.setElemText('statDbSize', stats.database?.sizeFormatted || '0 B');
                    state.setElemText('statTotalSize', stats.total?.sizeFormatted || '0 B');
                    state.setElemText('statTotalCount', `${stats.total?.count || 0} total files`);
                    if (stats.formatBreakdown) {
                        state.setElemText('fmtPdfStats', `${stats.formatBreakdown.pdf?.count || 0} files (${stats.formatBreakdown.pdf?.sizeFormatted || '0 B'})`);
                        state.setElemText('fmtImgStats', `${stats.formatBreakdown.image?.count || 0} files (${stats.formatBreakdown.image?.sizeFormatted || '0 B'})`);
                        state.setElemText('fmtTxtStats', `${stats.formatBreakdown.text?.count || 0} files (${stats.formatBreakdown.text?.sizeFormatted || '0 B'})`);
                        state.setElemText('fmtWordStats', `${stats.formatBreakdown.word?.count || 0} files (${stats.formatBreakdown.word?.sizeFormatted || '0 B'})`);
                        state.setElemText('fmtExcelStats', `${stats.formatBreakdown.excel?.count || 0} files (${stats.formatBreakdown.excel?.sizeFormatted || '0 B'})`);
                    }
                }
            }
            catch (err) { }
            this.renderCategoriesManager();
            const modal = document.getElementById('settingsModal');
            if (modal)
                modal.classList.add('open');
        }
        catch (err) {
            this.app.toast.error('Error loading configuration: ' + err.message);
        }
    }
    async loadOllamaModels(activeModel) {
        const selectElem = document.getElementById('cfgOllamaModelSelect');
        const inputElem = document.getElementById('cfgOllamaModel');
        if (!selectElem || !inputElem)
            return;
        const currentModel = activeModel || inputElem.value || 'qwen3.5:9b';
        try {
            const res = await fetch('/api/ollama/models');
            const data = await res.json();
            const modelsList = Array.isArray(data.models) ? data.models : [];
            if (currentModel && !modelsList.includes(currentModel) && currentModel !== '__custom__') {
                modelsList.unshift(currentModel);
            }
            selectElem.innerHTML = modelsList.map(m => `<option value="${m}" ${m === currentModel ? 'selected' : ''}>⚡ ${m}</option>`).join('') + `<option value="__custom__" ${currentModel === '__custom__' ? 'selected' : ''}>✏️ Enter custom model name...</option>`;
            if (currentModel === '__custom__') {
                inputElem.style.display = 'block';
            }
            else {
                inputElem.style.display = 'none';
                inputElem.value = currentModel;
            }
        }
        catch (err) {
            console.warn('Failed to load Ollama models list', err);
        }
    }
    closeSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (modal)
            modal.classList.remove('open');
    }
    switchSettingsTab(tabName) {
        const systemForm = document.getElementById('settingsForm');
        const catEditor = document.getElementById('categoriesEditor');
        const btnSys = document.getElementById('tabBtnSystem');
        const btnCat = document.getElementById('tabBtnCategories');
        if (tabName === 'system') {
            if (systemForm)
                systemForm.style.display = 'block';
            if (catEditor)
                catEditor.style.display = 'none';
            if (btnSys)
                btnSys.style.borderBottom = '2px solid var(--accent-blue)';
            if (btnCat)
                btnCat.style.borderBottom = 'none';
        }
        else {
            if (systemForm)
                systemForm.style.display = 'none';
            if (catEditor)
                catEditor.style.display = 'flex';
            if (btnSys)
                btnSys.style.borderBottom = 'none';
            if (btnCat)
                btnCat.style.borderBottom = '2px solid var(--accent-blue)';
        }
    }
    async handleSaveSettings(e) {
        e.preventDefault();
        const state = this.app.state;
        const payload = {
            language: state.getVal('cfgLanguage') || 'FR',
            input_dir: state.getVal('cfgInputDir').trim(),
            output_root_dir: state.getVal('cfgOutputDir').trim(),
            ollama_model: state.getVal('cfgOllamaModel').trim(),
            ollama_host: state.getVal('cfgOllamaHost').trim()
        };
        try {
            const res = await fetch('/api/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                state.systemLanguage = payload.language;
                this.app.toast.success('System configuration updated successfully!');
                this.closeSettingsModal();
                this.app.events.checkOllamaStatus();
                this.app.categoryPills.loadCategories();
                this.app.documentGrid.loadDocuments();
            }
            else {
                const err = await res.json();
                this.app.toast.error('Error updating config: ' + (err.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to save settings: ' + err.message);
        }
    }
    renderCategoriesManager() {
        const state = this.app.state;
        const container = document.getElementById('categoriesList');
        const tagsBar = document.getElementById('manageCategoryTagsBar');
        if (!container)
            return;
        container.innerHTML = '';
        // Render Category Selection Tag Pills Bar
        if (tagsBar) {
            tagsBar.innerHTML = '';
            const label = document.createElement('span');
            label.style.cssText = 'font-size: 0.8rem; font-weight: 700; color: #94a3b8; margin-right: 0.3rem;';
            label.textContent = '🏷️ Edit Category:';
            tagsBar.appendChild(label);
            // All Categories Tag Pill
            const allBtn = document.createElement('button');
            allBtn.type = 'button';
            const isAllActive = !state.activeManageCatId;
            allBtn.className = `pill ${isAllActive ? 'active' : ''}`;
            allBtn.style.cssText = 'font-size: 0.8rem; padding: 0.3rem 0.7rem; cursor: pointer; border-radius: 20px;';
            allBtn.textContent = `All Categories (${state.categories.length})`;
            allBtn.addEventListener('click', () => {
                state.activeManageCatId = '';
                this.renderCategoriesManager();
            });
            tagsBar.appendChild(allBtn);
            // Individual Category Tag Pills
            state.categories.forEach((cat) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                const isActive = state.activeManageCatId === cat.id;
                btn.className = `pill ${isActive ? 'active' : ''}`;
                btn.style.cssText = 'font-size: 0.8rem; padding: 0.3rem 0.7rem; cursor: pointer; border-radius: 20px;';
                const displayName = state.getLocalizedName(cat);
                const subCount = (cat.subcategories || []).length;
                btn.textContent = `${displayName} (${subCount})`;
                btn.title = `ID: ${cat.id} (${subCount} subcategories)`;
                btn.addEventListener('click', () => {
                    state.activeManageCatId = cat.id;
                    this.renderCategoriesManager();
                });
                tagsBar.appendChild(btn);
            });
        }
        // Filter categories to display based on selected Category Tag
        const visibleCategories = state.categories.filter((cat) => {
            if (!state.activeManageCatId)
                return true;
            return cat.id === state.activeManageCatId;
        });
        visibleCategories.forEach((cat) => {
            // Find original index in state.categories for accurate saves/deletes
            const catIdx = state.categories.findIndex((c) => c.id === cat.id);
            if (catIdx === -1)
                return;
            const card = document.createElement('div');
            card.className = 'category-manage-card';
            card.style.cssText = 'background: rgba(15,23,42,0.7); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.8rem;';
            const topRow = document.createElement('div');
            topRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.8rem; align-items: flex-end;';
            topRow.innerHTML = `
        <div><label style="font-size: 0.78rem; color: #94a3b8; font-weight: 600; display: block; margin-bottom: 0.3rem;">Category Slug ID</label><span class="badge" style="font-size: 0.85rem; padding: 0.55rem 0.8rem; border-radius: 6px; display: block; text-align: center;">${state.escapeHtml(cat.id)}</span></div>
        <div><label style="font-size: 0.78rem; color: #94a3b8; font-weight: 600; display: block; margin-bottom: 0.3rem;">Category Name</label><input type="text" value="${state.escapeHtml(cat.name)}" id="catName_${catIdx}" style="width: 100%; padding: 0.55rem 0.8rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.9rem;"></div>
        <div><label style="font-size: 0.78rem; color: #94a3b8; font-weight: 600; display: block; margin-bottom: 0.3rem;">Category Aliases</label><input type="text" value="${state.escapeHtml((cat.aliases || []).join(', '))}" id="catAliases_${catIdx}" style="width: 100%; padding: 0.55rem 0.8rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.9rem;"></div>
        <div style="display: flex; gap: 0.4rem; align-self: flex-end;"><button class="btn-secondary" style="padding: 0.55rem 0.9rem; font-weight: 600;" onclick="app.modals.saveSingleCategory(${catIdx})">Save Cat</button><button class="btn-secondary" style="padding: 0.55rem 0.8rem; color: #f87171;" onclick="app.modals.deleteCategory(${catIdx})">🗑️</button></div>
      `;
            card.appendChild(topRow);
            const subContainer = document.createElement('div');
            subContainer.style.cssText = 'background: rgba(30, 41, 59, 0.5); border: 1px dashed rgba(192, 132, 252, 0.3); border-radius: 8px; padding: 0.9rem; margin-top: 0.4rem;';
            let subsHtml = `<div style="font-size: 0.8rem; font-weight: 700; color: var(--accent-purple); margin-bottom: 0.6rem; text-transform: uppercase;">📂 Subcategories for ${state.escapeHtml(cat.name)} (${(cat.subcategories || []).length}):</div>`;
            const subList = cat.subcategories || [];
            if (subList.length === 0) {
                subsHtml += '<div style="font-size: 0.8rem; color: #64748b; margin-bottom: 0.6rem;">No subcategories configured. Add one below!</div>';
            }
            else {
                subsHtml += '<div style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.8rem;">';
                subList.forEach((sub, subIdx) => {
                    subsHtml += `
            <div style="display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.6rem; align-items: center; background: rgba(15, 23, 42, 0.6); padding: 0.5rem 0.7rem; border-radius: 6px; border: 1px solid var(--border-color);">
              <span style="font-size: 0.8rem; color: #e9d5ff; font-weight: 600; font-family: monospace;">${state.escapeHtml(sub.id)}</span>
              <input type="text" value="${state.escapeHtml(sub.name || '')}" id="subName_${catIdx}_${subIdx}" placeholder="Subcategory Name" style="width: 100%; padding: 0.45rem 0.7rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.85rem;">
              <input type="text" value="${state.escapeHtml((sub.aliases || []).join(', '))}" id="subAliases_${catIdx}_${subIdx}" placeholder="Aliases (comma separated)" style="width: 100%; padding: 0.45rem 0.7rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.85rem;">
              <div style="display: flex; gap: 0.3rem;">
                <button class="btn-secondary" style="padding: 0.45rem 0.75rem; font-size: 0.8rem; font-weight: 600;" onclick="app.modals.saveSingleSubcategory(${catIdx}, ${subIdx})">Save</button>
                <button class="btn-secondary" style="padding: 0.45rem 0.65rem; font-size: 0.8rem; color: #f87171;" onclick="app.modals.deleteSubcategory(${catIdx}, ${subIdx})">🗑️</button>
              </div>
            </div>
          `;
                });
                subsHtml += '</div>';
            }
            subsHtml += `
        <div style="display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.6rem; align-items: center; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 0.7rem; margin-top: 0.4rem;">
          <input type="text" id="newSubId_${catIdx}" placeholder="new_slug (e.g. navigo)" style="width: 100%; padding: 0.45rem 0.7rem; border-radius: 6px; background: #0f172a; color: #38bdf8; border: 1px solid var(--border-color); font-size: 0.85rem; font-family: monospace;">
          <input type="text" id="newSubName_${catIdx}" placeholder="Display Name (e.g. Navigo)" style="width: 100%; padding: 0.45rem 0.7rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.85rem;">
          <input type="text" id="newSubAliases_${catIdx}" placeholder="Aliases (e.g. navigo, ratp)" style="width: 100%; padding: 0.45rem 0.7rem; border-radius: 6px; background: #0f172a; color: #fff; border: 1px solid var(--border-color); font-size: 0.85rem;">
          <button class="btn-primary" style="padding: 0.45rem 0.85rem; font-size: 0.82rem; font-weight: 600;" onclick="app.modals.addNewSubcategory(${catIdx})">+ Add Sub</button>
        </div>
      `;
            subContainer.innerHTML = subsHtml;
            card.appendChild(subContainer);
            container.appendChild(card);
        });
    }
    saveSingleCategory(catIdx) {
        const state = this.app.state;
        const cat = state.categories[catIdx];
        if (!cat)
            return;
        const nameVal = state.getVal(`catName_${catIdx}`).trim();
        const aliasesVal = state.getVal(`catAliases_${catIdx}`).split(',').map((a) => a.trim()).filter(Boolean);
        if (!nameVal) {
            this.app.toast.warning('Category name cannot be empty');
            return;
        }
        cat.name = nameVal;
        cat.aliases = aliasesVal;
        this.syncCategoriesToServer();
    }
    deleteCategory(catIdx) {
        const state = this.app.state;
        const cat = state.categories[catIdx];
        if (!cat)
            return;
        if (confirm(`Are you sure you want to delete category '${cat.name}'?`)) {
            state.categories.splice(catIdx, 1);
            this.syncCategoriesToServer();
        }
    }
    saveSingleSubcategory(catIdx, subIdx) {
        const state = this.app.state;
        const cat = state.categories[catIdx];
        if (!cat || !cat.subcategories || !cat.subcategories[subIdx])
            return;
        const sub = cat.subcategories[subIdx];
        const nameVal = state.getVal(`subName_${catIdx}_${subIdx}`).trim();
        const aliasesVal = state.getVal(`subAliases_${catIdx}_${subIdx}`).split(',').map((a) => a.trim()).filter(Boolean);
        if (!nameVal) {
            this.app.toast.warning('Subcategory name cannot be empty');
            return;
        }
        sub.name = nameVal;
        sub.aliases = aliasesVal;
        this.syncCategoriesToServer();
    }
    deleteSubcategory(catIdx, subIdx) {
        const state = this.app.state;
        const cat = state.categories[catIdx];
        if (!cat || !cat.subcategories || !cat.subcategories[subIdx])
            return;
        const sub = cat.subcategories[subIdx];
        if (confirm(`Are you sure you want to delete subcategory '${sub.name || sub.id}'?`)) {
            cat.subcategories.splice(subIdx, 1);
            this.syncCategoriesToServer();
        }
    }
    addNewSubcategory(catIdx) {
        const state = this.app.state;
        const cat = state.categories[catIdx];
        if (!cat)
            return;
        const idVal = state.getVal(`newSubId_${catIdx}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const nameVal = state.getVal(`newSubName_${catIdx}`).trim();
        const aliasesVal = state.getVal(`newSubAliases_${catIdx}`).split(',').map((a) => a.trim()).filter(Boolean);
        if (!idVal || !nameVal) {
            this.app.toast.warning('Please provide both ID and Display Name for the subcategory.');
            return;
        }
        if (!cat.subcategories)
            cat.subcategories = [];
        if (cat.subcategories.some((s) => s.id === idVal)) {
            this.app.toast.warning(`Subcategory ID '${idVal}' already exists in category '${cat.name}'.`);
            return;
        }
        cat.subcategories.push({
            id: idVal,
            name: nameVal,
            aliases: aliasesVal.length > 0 ? aliasesVal : [idVal]
        });
        this.syncCategoriesToServer();
    }
    async handleAddCategory() {
        const state = this.app.state;
        const id = state.getVal('newCatId').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const name = state.getVal('newCatName').trim();
        const aliases = state.getVal('newCatAliases').split(',').map((a) => a.trim()).filter(Boolean);
        if (!id || !name) {
            this.app.toast.warning('Please provide both ID and Name for the new category.');
            return;
        }
        if (state.categories.some((c) => c.id === id)) {
            this.app.toast.warning(`Category ID '${id}' already exists.`);
            return;
        }
        state.categories.push({ id, name, description: name, aliases, subcategories: [] });
        state.setVal('newCatId', '');
        state.setVal('newCatName', '');
        state.setVal('newCatAliases', '');
        await this.syncCategoriesToServer();
    }
    async syncCategoriesToServer() {
        const state = this.app.state;
        try {
            const res = await fetch('/api/categories', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categories: state.categories })
            });
            if (res.ok) {
                this.app.toast.success('Categories updated successfully!');
                this.renderCategoriesManager();
                this.app.categoryPills.loadCategories();
            }
            else {
                const err = await res.json();
                this.app.toast.error('Error updating categories: ' + (err.error || 'Unknown error'));
            }
        }
        catch (err) {
            this.app.toast.error('Failed to sync categories: ' + err.message);
        }
    }
}
window.ModalsManager = ModalsManager;
