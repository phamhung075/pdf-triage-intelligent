/**
 * Local AI Chat Assistant Manager Class Module (TypeScript)
 */
class ChatAssistantManager {
    app;
    chatHistory = [];
    isSending = false;
    constructor(app) {
        this.app = app;
    }
    init() {
        const btnOpen = document.getElementById('btnOpenChatAssistant');
        const btnClose = document.getElementById('btnCloseChatAssistant');
        const form = document.getElementById('chatInputForm');
        if (btnOpen)
            btnOpen.addEventListener('click', () => this.openChatModal());
        if (btnClose)
            btnClose.addEventListener('click', () => this.closeChatModal());
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = document.getElementById('chatInputText');
                if (input && input.value.trim()) {
                    const text = input.value.trim();
                    input.value = '';
                    this.sendUserMessage(text);
                }
            });
        }
        // Attach quick prompt chips
        document.querySelectorAll('.chat-prompt-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const promptText = chip.getAttribute('data-prompt');
                if (promptText) {
                    this.openChatModal();
                    this.sendUserMessage(promptText);
                }
            });
        });
    }
    openChatModal() {
        const modal = document.getElementById('chatAssistantModal');
        if (modal)
            modal.classList.add('open');
        const input = document.getElementById('chatInputText');
        if (input)
            input.focus();
        this.updateMcpStatusBadge();
    }
    async updateMcpStatusBadge() {
        const badge = document.getElementById('mcpStatusBadge');
        if (!badge)
            return;
        try {
            const res = await fetch('/api/mcp/status');
            const data = await res.json();
            if (data && data.connected) {
                badge.style.background = 'rgba(34, 197, 94, 0.15)';
                badge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                badge.style.color = '#4ade80';
                badge.innerHTML = `<span style="width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e;"></span> MCP Active (${data.toolsCount || 8} Tools)`;
            }
            else {
                badge.style.background = 'rgba(239, 68, 68, 0.15)';
                badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                badge.style.color = '#f87171';
                badge.innerHTML = `<span style="width: 7px; height: 7px; border-radius: 50%; background: #ef4444;"></span> MCP Disconnected`;
            }
        }
        catch {
            badge.style.background = 'rgba(245, 158, 11, 0.15)';
            badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
            badge.style.color = '#fbbf24';
            badge.innerHTML = `<span style="width: 7px; height: 7px; border-radius: 50%; background: #f59e0b;"></span> MCP Standby`;
        }
    }
    closeChatModal() {
        const modal = document.getElementById('chatAssistantModal');
        if (modal)
            modal.classList.remove('open');
    }
    clearConversation() {
        this.chatHistory = [];
        const historyContainer = document.getElementById('chatMessageHistory');
        if (historyContainer) {
            historyContainer.innerHTML = `
        <div style="color: #64748b; font-size: 0.9rem; text-align: center; margin-top: 2rem;">
          👋 Hello! I am your local AI document archivist powered by Qwen 3.5.<br>Ask me any question or click a <strong>Quick Dossier chip</strong> above to generate a complete document checklist!
        </div>
      `;
        }
        if (this.app?.toast) {
            this.app.toast.info('Chat conversation history cleared.');
        }
    }
    async sendUserMessage(text) {
        if (this.isSending || !text)
            return;
        this.isSending = true;
        const historyContainer = document.getElementById('chatMessageHistory');
        if (!historyContainer)
            return;
        // Render User Message Bubble
        this.appendMessageBubble('user', text);
        this.chatHistory.push({ role: 'user', content: text });
        // Render Typing Indicator
        const typingId = 'typing_' + Date.now();
        const typingBubble = document.createElement('div');
        typingBubble.id = typingId;
        typingBubble.className = 'chat-message-bubble assistant typing';
        typingBubble.style.cssText = 'background: rgba(30, 41, 59, 0.7); border: 1px solid var(--border-color); border-radius: 12px; padding: 0.8rem 1rem; margin-bottom: 1rem; color: #94a3b8; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem;';
        typingBubble.innerHTML = '<span>🤖 AI archivist searching documents & preparing dossier...</span>';
        historyContainer.appendChild(typingBubble);
        historyContainer.scrollTop = historyContainer.scrollHeight;
        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    history: this.chatHistory.slice(-6)
                })
            });
            const typingEl = document.getElementById(typingId);
            if (typingEl)
                typingEl.remove();
            if (res.ok) {
                const data = await res.json();
                const aiAnswer = data.answer || 'No response generated.';
                this.chatHistory.push({ role: 'assistant', content: aiAnswer });
                this.appendMessageBubble('assistant', aiAnswer, data.matchedDocuments || []);
            }
            else {
                const err = await res.json();
                this.appendMessageBubble('assistant', `⚠️ Error processing query: ${err.error || 'Unknown server error'}`);
            }
        }
        catch (err) {
            const typingEl = document.getElementById(typingId);
            if (typingEl)
                typingEl.remove();
            this.appendMessageBubble('assistant', `⚠️ Network error: ${err.message}`);
        }
        finally {
            this.isSending = false;
            historyContainer.scrollTop = historyContainer.scrollHeight;
        }
    }
    appendMessageBubble(role, text, matchedDocs = []) {
        const historyContainer = document.getElementById('chatMessageHistory');
        if (!historyContainer)
            return;
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom: 1.2rem; display: flex; flex-direction: column; gap: 0.5rem;';
        const bubble = document.createElement('div');
        bubble.className = `chat-message-bubble ${role}`;
        if (role === 'user') {
            bubble.style.cssText = 'align-self: flex-end; max-width: 80%; background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: #fff; padding: 0.8rem 1.1rem; border-radius: 16px 16px 2px 16px; font-size: 0.95rem; line-height: 1.4; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);';
            bubble.textContent = text;
        }
        else {
            bubble.style.cssText = 'align-self: flex-start; max-width: 92%; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(192, 132, 252, 0.3); color: #f1f5f9; padding: 1rem 1.2rem; border-radius: 16px 16px 16px 2px; font-size: 0.95rem; line-height: 1.5; box-shadow: 0 4px 14px rgba(0,0,0,0.3);';
            // Simple markdown formatting
            let formattedText = this.app.state.escapeHtml(text)
                .replace(/\n\n/g, '<br><br>')
                .replace(/\n/g, '<br>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\[Doc #(\d+): (.*?)\]/g, '<span class="badge" style="background: rgba(168, 85, 247, 0.2); border: 1px solid rgba(168, 85, 247, 0.5); color: #e9d5ff; font-weight: 600; padding: 0.15rem 0.4rem; font-size: 0.85rem;">📄 $2</span>');
            bubble.innerHTML = `<div style="font-weight: 700; font-size: 0.8rem; color: var(--accent-purple); margin-bottom: 0.4rem;">🤖 Local AI Archivist</div>${formattedText}`;
        }
        wrapper.appendChild(bubble);
        // If assistant reply has matched documents, render attached Interactive Cards in List Format
        if (role === 'assistant' && matchedDocs && matchedDocs.length > 0) {
            const listContainer = document.createElement('div');
            listContainer.style.cssText = 'margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.68rem; max-width: 96%;';
            const headerLabel = document.createElement('div');
            headerLabel.style.cssText = 'font-size: 0.82rem; font-weight: 700; color: #c084fc; display: flex; align-items: center; gap: 0.4rem; text-transform: uppercase; margin-top: 0.2rem;';
            headerLabel.innerHTML = `<span>📑 Matched Documents (${matchedDocs.length}) — Dossier List Cards:</span>`;
            listContainer.appendChild(headerLabel);
            // Selection & Package Toolbar
            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(168, 85, 247, 0.35); border-radius: 8px; padding: 0.4rem 0.8rem; margin-top: 0.2rem; flex-wrap: wrap; gap: 0.5rem;';
            const selectAllLabel = document.createElement('label');
            selectAllLabel.style.cssText = 'font-size: 0.8rem; color: #e2e8f0; display: flex; align-items: center; gap: 0.4rem; cursor: pointer; font-weight: 600;';
            const cbSelectAll = document.createElement('input');
            cbSelectAll.type = 'checkbox';
            cbSelectAll.style.cssText = 'accent-color: #a855f7; width: 16px; height: 16px; cursor: pointer;';
            selectAllLabel.appendChild(cbSelectAll);
            selectAllLabel.appendChild(document.createTextNode('Select All Documents'));
            toolbar.appendChild(selectAllLabel);
            const toolbarRight = document.createElement('div');
            toolbarRight.style.cssText = 'display: flex; gap: 0.5rem; align-items: center;';
            const btnDownloadZip = document.createElement('button');
            btnDownloadZip.className = 'btn-primary';
            btnDownloadZip.style.cssText = 'font-size: 0.78rem; padding: 0.25rem 0.65rem; background: #9333ea; border-color: #a855f7; display: none;';
            btnDownloadZip.textContent = '📦 Download ZIP Package (0)';
            toolbarRight.appendChild(btnDownloadZip);
            toolbar.appendChild(toolbarRight);
            listContainer.appendChild(toolbar);
            const cardCheckboxes = [];
            const updateSelectionState = () => {
                const selectedIds = [];
                cardCheckboxes.forEach(cb => {
                    if (cb.checked) {
                        const id = parseInt(cb.getAttribute('data-doc-id') || '0', 10);
                        if (id > 0)
                            selectedIds.push(id);
                    }
                });
                if (selectedIds.length > 0) {
                    btnDownloadZip.style.display = 'inline-block';
                    btnDownloadZip.textContent = `📦 Download ZIP Package (${selectedIds.length})`;
                }
                else {
                    btnDownloadZip.style.display = 'none';
                }
                cbSelectAll.checked = cardCheckboxes.length > 0 && cardCheckboxes.every(cb => cb.checked);
            };
            cbSelectAll.addEventListener('change', () => {
                cardCheckboxes.forEach(cb => cb.checked = cbSelectAll.checked);
                updateSelectionState();
            });
            btnDownloadZip.addEventListener('click', async () => {
                const selectedIds = [];
                cardCheckboxes.forEach(cb => {
                    if (cb.checked) {
                        const id = parseInt(cb.getAttribute('data-doc-id') || '0', 10);
                        if (id > 0)
                            selectedIds.push(id);
                    }
                });
                if (selectedIds.length === 0)
                    return;
                btnDownloadZip.disabled = true;
                btnDownloadZip.textContent = '⏳ Zipping...';
                try {
                    const res = await fetch('/api/documents/package-zip', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ docIds: selectedIds, zipName: 'dossier_documents_package.zip' })
                    });
                    if (!res.ok) {
                        const err = await res.json();
                        this.app.toast.error('Failed to generate ZIP: ' + (err.error || 'Unknown error'));
                        return;
                    }
                    const blob = await res.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'dossier_documents_package.zip';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    window.URL.revokeObjectURL(url);
                    this.app.toast.success(`📦 Downloaded ${selectedIds.length} document(s) as ZIP package!`);
                }
                catch (err) {
                    this.app.toast.error('Error downloading ZIP package: ' + err.message);
                }
                finally {
                    btnDownloadZip.disabled = false;
                    updateSelectionState();
                }
            });
            matchedDocs.forEach((doc) => {
                const card = document.createElement('div');
                const fType = (doc.file_type || 'PDF').toUpperCase();
                const fTypeKey = fType.toLowerCase();
                card.className = 'matched-doc-card-list';
                card.setAttribute('data-file-type', fTypeKey);
                card.style.cssText = 'border-radius: 10px; padding: 0.8rem 1rem; display: flex; flex-direction: column; gap: 0.4rem; transition: border-color 0.2s;';
                const subCategoryDisplay = doc.subcategory && doc.subcategory !== 'general' ? `${doc.category} / ${doc.subcategory}` : doc.category;
                const amountDisplay = doc.total_amount ? `• 💰 ${doc.total_amount} €` : '';
                const dateDisplay = doc.date ? `• 📅 ${doc.date}` : '';
                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; gap: 0.8rem;';
                const titleLeft = document.createElement('div');
                titleLeft.style.cssText = 'font-weight: 700; font-size: 0.92rem; color: #fff; display: flex; align-items: center; gap: 0.5rem;';
                const cbDoc = document.createElement('input');
                cbDoc.type = 'checkbox';
                cbDoc.className = 'doc-card-cb';
                cbDoc.setAttribute('data-doc-id', doc.id);
                cbDoc.style.cssText = 'accent-color: #a855f7; width: 16px; height: 16px; cursor: pointer; flex-shrink: 0;';
                cbDoc.addEventListener('change', () => updateSelectionState());
                cardCheckboxes.push(cbDoc);
                const titleSpan = document.createElement('span');
                titleSpan.innerHTML = `📄 ${this.app.state.escapeHtml(doc.title || doc.original_filename)}`;
                titleLeft.appendChild(cbDoc);
                titleLeft.appendChild(titleSpan);
                let icon = '📕';
                if (fType === 'IMAGE')
                    icon = '🖼️';
                if (fType === 'TEXT')
                    icon = '📝';
                if (fType === 'WORD')
                    icon = '📘';
                if (fType === 'EXCEL')
                    icon = '📊';
                const badgesRight = document.createElement('div');
                badgesRight.style.cssText = 'display: flex; gap: 0.4rem; align-items: center;';
                const typeBadge = document.createElement('span');
                typeBadge.className = 'badge badge-file-type';
                typeBadge.textContent = `${icon} ${fType}`;
                const badgeSpan = document.createElement('span');
                badgeSpan.className = 'badge';
                badgeSpan.style.cssText = 'font-size: 0.75rem; background: rgba(147, 51, 234, 0.2); border: 1px solid rgba(147, 51, 234, 0.4); color: #d8b4fe;';
                badgeSpan.textContent = subCategoryDisplay;
                badgesRight.appendChild(typeBadge);
                badgesRight.appendChild(badgeSpan);
                titleRow.appendChild(titleLeft);
                titleRow.appendChild(badgesRight);
                card.appendChild(titleRow);
                const metaRow = document.createElement('div');
                metaRow.style.cssText = 'font-size: 0.78rem; color: #94a3b8; display: flex; gap: 0.6rem; flex-wrap: wrap;';
                metaRow.innerHTML = `
          <span>🆔 Doc #${doc.id}</span>
          <span>${dateDisplay}</span>
          <span>${amountDisplay}</span>
        `;
                card.appendChild(metaRow);
                if (doc.summary) {
                    const summaryBox = document.createElement('div');
                    summaryBox.style.cssText = 'font-size: 0.8rem; color: #cbd5e1; background: rgba(30, 41, 59, 0.6); padding: 0.4rem 0.6rem; border-radius: 6px; border-left: 3px solid var(--accent-blue); line-height: 1.3; margin-top: 0.2rem;';
                    summaryBox.innerHTML = `💡 ${this.app.state.escapeHtml(doc.summary.substring(0, 150))}${doc.summary.length > 150 ? '...' : ''}`;
                    card.appendChild(summaryBox);
                }
                const actionsRow = document.createElement('div');
                actionsRow.style.cssText = 'display: flex; gap: 0.5rem; margin-top: 0.4rem; flex-wrap: wrap;';
                const btnDetails = document.createElement('button');
                btnDetails.className = 'btn-secondary';
                btnDetails.style.cssText = 'padding: 0.25rem 0.6rem; font-size: 0.78rem; color: #38bdf8;';
                btnDetails.textContent = '📖 Details';
                btnDetails.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.app.modals.openGrandViewerModal(doc.id);
                });
                const btnOpenPdf = document.createElement('button');
                btnOpenPdf.className = 'btn-primary';
                btnOpenPdf.style.cssText = 'padding: 0.25rem 0.6rem; font-size: 0.78rem;';
                btnOpenPdf.textContent = '🌐 Open PDF';
                btnOpenPdf.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.app.events.openInChrome(doc.id);
                });
                const btnOpenFolder = document.createElement('button');
                btnOpenFolder.className = 'btn-secondary';
                btnOpenFolder.style.cssText = 'padding: 0.25rem 0.6rem; font-size: 0.78rem;';
                btnOpenFolder.textContent = '📂 Open Folder';
                btnOpenFolder.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const targetPath = doc.new_path || doc.original_path || '';
                    this.app.events.openFileLocation(targetPath);
                });
                const btnCopyPath = document.createElement('button');
                btnCopyPath.className = 'btn-secondary';
                btnCopyPath.style.cssText = 'padding: 0.25rem 0.6rem; font-size: 0.78rem;';
                btnCopyPath.textContent = '📋 Copy Path';
                btnCopyPath.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const targetPath = doc.new_path || doc.original_path || '';
                    if (targetPath) {
                        navigator.clipboard.writeText(targetPath);
                        this.app.toast.success('File path copied to clipboard!');
                    }
                });
                actionsRow.appendChild(btnDetails);
                actionsRow.appendChild(btnOpenPdf);
                actionsRow.appendChild(btnOpenFolder);
                actionsRow.appendChild(btnCopyPath);
                card.appendChild(actionsRow);
                listContainer.appendChild(card);
            });
            wrapper.appendChild(listContainer);
        }
        historyContainer.appendChild(wrapper);
        historyContainer.scrollTop = historyContainer.scrollHeight;
    }
    async openDocFolder(docId) {
        try {
            const res = await fetch(`/api/documents/${docId}/open-folder`, { method: 'POST' });
            if (res.ok) {
                this.app.toast.success('Opened folder in Windows Explorer!');
            }
            else {
                const err = await res.json();
                this.app.toast.error('Could not open folder: ' + (err.error || 'Unknown error'));
            }
        }
        catch (e) {
            this.app.toast.error('Error opening folder: ' + e.message);
        }
    }
}
window.ChatAssistantManager = ChatAssistantManager;
