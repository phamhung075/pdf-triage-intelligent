/**
 * Document Grid Manager Class Module (TypeScript)
 */
class DocumentGridManager {
  app: any;

  constructor(app: any) {
    this.app = app;
  }

  async loadDocuments(): Promise<void> {
    const state = this.app.state;
    const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
    const query = searchEl ? searchEl.value.trim() : '';
    const url = `/api/documents?q=${encodeURIComponent(query)}&category=${encodeURIComponent(state.activeCategory)}`;

    try {
      const res = await fetch(url);
      const data = await res.json();
      state.allLoadedDocs = data.documents || [];

      const displayDocs = state.activeSubcategory
        ? state.allLoadedDocs.filter((d: any) => (d.subcategory || '').toLowerCase() === state.activeSubcategory.toLowerCase())
        : state.allLoadedDocs;

      this.renderDocsGrid(displayDocs);
      this.app.categoryPills.renderSubcategories();
    } catch (err) {
      console.error('Failed to load documents', err);
    }
  }

  renderDocsGrid(docs: any[]): void {
    const state = this.app.state;
    const grid = document.getElementById('docsGrid') || document.getElementById('documentsGrid');
    if (!grid) return;
    
    grid.innerHTML = '';

    if (docs.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 1rem; color: #94a3b8;">
          <h3>No documents found in registry</h3>
          <p>Drop files into <code>__raws</code> folder and click 'Scan & Triage Files'.</p>
        </div>
      `;
      return;
    }

    docs.forEach(doc => {
      const card = document.createElement('div');
      const fType = (doc.file_type || 'PDF').toUpperCase();
      const fTypeKey = fType.toLowerCase();
      let typeIcon = '📕';
      if (fType === 'IMAGE') typeIcon = '🖼️';
      else if (fType === 'TEXT') typeIcon = '📝';
      else if (fType === 'WORD') typeIcon = '📘';
      else if (fType === 'EXCEL') typeIcon = '📊';

      card.className = 'doc-card';
      card.setAttribute('data-file-type', fTypeKey);

      const tagsHtml = (doc.tags || []).map((t: string) => `<span class="tag tag-clickable" title="Filter by tag #${state.escapeHtml(t)}">#${state.escapeHtml(t)}</span>`).join(' ');
      const catText = (doc.category || 'OTHER').toUpperCase();
      const subText = doc.subcategory && doc.subcategory !== 'general' 
        ? doc.subcategory.toUpperCase().replace(/[\/\\]+/g, ' / ')
        : '';
      const contactValue = (doc.contact_name || doc.contact_email || '').trim();
      const targetPath = doc.new_path || doc.original_path;

      card.innerHTML = `
        <div class="card-main-body" style="cursor: pointer;" onclick="app.modals.openGrandViewerModal(${doc.id})">
          <div class="card-header">
            <div class="card-title-row">
              <h3 class="card-title" title="Click to view Grand Format">${state.escapeHtml(doc.title)}</h3>
            </div>
            <div class="badge-row">
              <span class="badge badge-file-type">${typeIcon} ${fType}</span>
              <span class="badge badge-cat-clickable" title="Click to filter by Category: ${state.escapeHtml(catText)}">${state.escapeHtml(catText)}</span>
              ${subText ? `<span class="badge badge-sub badge-sub-clickable" title="Click to filter by Subcategory: ${state.escapeHtml(subText)}">📂 ${state.escapeHtml(subText)}</span>` : ''}
              ${contactValue ? `<span class="badge badge-contact badge-contact-clickable" style="background: rgba(192, 132, 252, 0.15); color: #c084fc; border: 1px solid rgba(192, 132, 252, 0.35); cursor: pointer;" title="Click to view all documents from contact '${state.escapeHtml(contactValue)}'">👤 ${state.escapeHtml(contactValue)}</span>` : ''}
            </div>
          </div>
          <div class="meta-row">
            <span>📅 ${state.escapeHtml(doc.date || 'N/A')}</span>
            <span>🏷️ ${state.escapeHtml(doc.registre || 'No Ref')}</span>
          </div>
          <div class="summary-box" title="Summary">
            <div class="summary-box-header">💡 Summary:</div>
            <div class="summary-content markdown-content">${state.renderMarkdown(doc.summary || 'No summary available.')}</div>
          </div>
          <div class="tags-row" style="margin-top: 0.4rem;">${tagsHtml}</div>
        </div>
        <div class="card-actions">
          <button class="btn-secondary btn-view-doc" style="color: #38bdf8;" title="Open full document details modal window">📖 Full Details</button>
          <button class="btn-secondary btn-chrome-doc" style="color: #facc15;" title="Open PDF in Google Chrome">🌐 Open</button>
          <button class="btn-secondary btn-folder-doc" title="Open containing folder">📂 Folder</button>
          <button class="btn-secondary btn-move-doc" style="color: #a7f3d0;" title="Relocalize & Correct Category/Subcategory">📍 Move</button>
          <button class="btn-secondary btn-edit-doc" title="Edit Metadata">✏️ Edit</button>
        </div>
      `;

      const btnView = card.querySelector('.btn-view-doc');
      if (btnView) {
        btnView.addEventListener('click', e => {
          e.stopPropagation();
          this.app.modals.openGrandViewerModal(doc.id);
        });
      }

      const btnChrome = card.querySelector('.btn-chrome-doc');
      if (btnChrome) {
        btnChrome.addEventListener('click', e => {
          e.stopPropagation();
          this.app.events.openInChrome(doc.id);
        });
      }

      const btnFolder = card.querySelector('.btn-folder-doc');
      if (btnFolder) {
        btnFolder.addEventListener('click', e => {
          e.stopPropagation();
          this.app.events.openFileLocation(targetPath);
        });
      }

      const btnMove = card.querySelector('.btn-move-doc');
      if (btnMove) {
        btnMove.addEventListener('click', e => {
          e.stopPropagation();
          this.app.modals.openRelocalizeModal(doc.id);
        });
      }

      const btnEdit = card.querySelector('.btn-edit-doc');
      if (btnEdit) {
        btnEdit.addEventListener('click', e => {
          e.stopPropagation();
          this.app.modals.openEditModal(doc.id);
        });
      }

      const badgeCat = card.querySelector('.badge-cat-clickable');
      if (badgeCat) {
        badgeCat.addEventListener('click', e => {
          e.stopPropagation();
          this.app.categoryPills.filterByCategory(doc.category);
        });
      }

      const badgeSub = card.querySelector('.badge-sub-clickable');
      if (badgeSub) {
        badgeSub.addEventListener('click', e => {
          e.stopPropagation();
          this.app.categoryPills.filterByCategoryAndSubcategory(doc.category, doc.subcategory);
        });
      }

      const badgeContact = card.querySelector('.badge-contact-clickable');
      if (badgeContact) {
        badgeContact.addEventListener('click', e => {
          e.stopPropagation();
          this.app.categoryPills.filterByContact(contactValue);
        });
      }

      card.querySelectorAll('.tag-clickable').forEach(tagEl => {
        tagEl.addEventListener('click', e => {
          e.stopPropagation();
          const tagVal = tagEl.textContent ? tagEl.textContent.replace(/^#/, '').trim() : '';
          this.app.categoryPills.filterBySearchOrSubcategory(tagVal, doc.category, doc.subcategory);
        });
      });

      grid.appendChild(card);
    });
  }
}

(window as any).DocumentGridManager = DocumentGridManager;
