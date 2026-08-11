/**
 * Category & Subcategory Pills Manager Class Module (TypeScript)
 */
class CategoryPillsManager {
  app: any;

  constructor(app: any) {
    this.app = app;
  }

  async loadCategories(): Promise<void> {
    const state = this.app.state;
    try {
      try {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          if (cfg.language) state.systemLanguage = cfg.language;
        }
      } catch (err) {}

      const res = await fetch('/api/categories');
      const data = await res.json();
      
      state.categories = Array.isArray(data) ? data : (data.categories || []);
      (window as any).categories = state.categories;
      const totalDocsCount = data.totalDocuments !== undefined ? data.totalDocuments : 0;

      const statDocs = document.getElementById('statTotalDocs');
      const statCats = document.getElementById('statCategoriesCount');
      const statSubs = document.getElementById('statSubcategoriesCount');

      if (statDocs) statDocs.textContent = totalDocsCount;
      if (statCats) {
        const activeCats = state.categories.filter((c: any) => (c.count || 0) > 0).length;
        statCats.textContent = activeCats;
      }
      if (statSubs) {
        let subCount = 0;
        state.categories.forEach((c: any) => {
          if (c.subcategories) {
            subCount += c.subcategories.filter((s: any) => (s.count || 0) > 0).length;
          }
        });
        statSubs.textContent = subCount.toString();
      }

      const filterCatSelect = document.getElementById('filterCategory') as HTMLSelectElement | null;
      if (filterCatSelect) {
        const currVal = filterCatSelect.value;
        const allCatLabel = state.systemLanguage === 'EN' ? 'All Categories' : 'Toutes les catégories';
        const validCats = state.categories.filter((c: any) => (c.count || 0) > 0 || c.id === currVal);
        filterCatSelect.innerHTML = `<option value="">${allCatLabel}</option>` + validCats.map((c: any) => 
          `<option value="${c.id}" ${c.id === currVal ? 'selected' : ''}>${state.getLocalizedName(c)} (${c.count || 0})</option>`
        ).join('');
      }

      this.updateFilterSubcategoriesDropdown();

      const pillsContainer = document.getElementById('categoryPills');
      const selectContainer = document.getElementById('editCategory') as HTMLSelectElement | null;

      if (pillsContainer) {
        pillsContainer.innerHTML = '';
        const allBtn = document.createElement('button');
        allBtn.className = `pill ${!state.activeCategory ? 'active' : ''} ${totalDocsCount === 0 ? 'disabled' : ''}`;
        allBtn.dataset.cat = '';
        const allDocsLabel = state.systemLanguage === 'EN' ? 'All Documents' : 'Tous les documents';
        allBtn.textContent = `${allDocsLabel} (${totalDocsCount})`;
        if (totalDocsCount === 0) {
          allBtn.disabled = true;
        } else {
          allBtn.addEventListener('click', () => {
            document.querySelectorAll('.category-pills .pill').forEach(p => p.classList.remove('active'));
            allBtn.classList.add('active');
            state.activeCategory = '';
            state.activeSubcategory = '';
            this.app.documentGrid.loadDocuments();
          });
        }
        pillsContainer.appendChild(allBtn);
      }

      if (selectContainer) {
        selectContainer.innerHTML = '';
      }

      state.categories.forEach((cat: any) => {
        const catCount = cat.count !== undefined ? cat.count : 0;
        const displayName = state.getLocalizedName(cat);
        const isActive = state.activeCategory === cat.id;

        // Hide categories with 0 items completely (unless currently selected as active filter)
        if (pillsContainer && (catCount > 0 || isActive)) {
          const btn = document.createElement('button');
          btn.className = `pill ${isActive ? 'active' : ''}`;
          btn.dataset.cat = cat.id;
          btn.textContent = `${displayName} (${catCount})`;
          
          btn.addEventListener('click', () => {
            document.querySelectorAll('.category-pills .pill').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            state.activeCategory = cat.id;
            state.activeSubcategory = '';
            this.app.documentGrid.loadDocuments();
          });
          pillsContainer.appendChild(btn);
        }

        if (selectContainer) {
          const opt = document.createElement('option');
          opt.value = cat.id;
          opt.textContent = `${displayName} (${catCount})`;
          selectContainer.appendChild(opt);
        }
      });

      this.renderSubcategories();
    } catch (err) {
      console.error('Failed to load categories', err);
    }
  }

  updateFilterSubcategoriesDropdown(): void {
    const state = this.app.state;
    const filterSubSelect = document.getElementById('filterSubcategory') as HTMLSelectElement | null;
    if (!filterSubSelect) return;

    const catList = ((window as any).categories && (window as any).categories.length > 0) ? (window as any).categories : (state.categories || []);
    const catObj = catList.find((c: any) => c.id === state.activeCategory);
    const subs = (catObj && catObj.subcategories) ? catObj.subcategories : [];

    filterSubSelect.innerHTML = '<option value="">All Subcategories</option>' + subs.map((s: any) => 
      `<option value="${s.id}" ${s.id === state.activeSubcategory ? 'selected' : ''}>${s.name || s.id} (${s.count || 0})</option>`
    ).join('');
  }

  renderSubcategories(): void {
    const state = this.app.state;
    const container = document.getElementById('subcategoryPills');
    if (!container) return;

    const subcatsMap = new Map<string, { name: string; count: number }>();

    if (state.activeCategory) {
      const catObj = state.categories.find((c: any) => c.id.toLowerCase() === state.activeCategory.toLowerCase());
      if (catObj && catObj.subcategories) {
        catObj.subcategories.forEach((sub: any) => {
          if (sub.id && sub.id !== 'general') {
            subcatsMap.set(sub.id.toLowerCase(), {
              name: sub.name || state.formatSubName(sub.id),
              count: sub.count !== undefined ? sub.count : 0
            });
          }
        });
      }

      state.allLoadedDocs.forEach((doc: any) => {
        if (doc.category.toLowerCase() === state.activeCategory.toLowerCase()) {
          const subId = (doc.subcategory || '').toLowerCase();
          if (subId && subId !== 'general' && !subcatsMap.has(subId)) {
            const matchingDocs = state.allLoadedDocs.filter((d: any) => 
              d.category.toLowerCase() === state.activeCategory.toLowerCase() && (d.subcategory || '').toLowerCase() === subId
            );
            subcatsMap.set(subId, {
              name: state.formatSubName(subId),
              count: matchingDocs.length
            });
          }
        }
      });
    } else {
      state.categories.forEach((cat: any) => {
        (cat.subcategories || []).forEach((sub: any) => {
          if (sub.id && sub.id !== 'general') {
            const current = subcatsMap.get(sub.id.toLowerCase());
            subcatsMap.set(sub.id.toLowerCase(), {
              name: sub.name || state.formatSubName(sub.id),
              count: (current ? current.count : 0) + (sub.count || 0)
            });
          }
        });
      });

      state.allLoadedDocs.forEach((doc: any) => {
        const subId = (doc.subcategory || '').toLowerCase();
        if (subId && subId !== 'general' && !subcatsMap.has(subId)) {
          const matchingDocs = state.allLoadedDocs.filter((d: any) => (d.subcategory || '').toLowerCase() === subId);
          subcatsMap.set(subId, {
            name: state.formatSubName(subId),
            count: matchingDocs.length
          });
        }
      });
    }

    if (subcatsMap.size === 0) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    container.style.display = 'flex';
    
    let totalSubItems = 0;
    subcatsMap.forEach(val => { totalSubItems += val.count; });

    container.innerHTML = `
      <span class="sub-pill-label">📂 Subcategories:</span>
      <button class="sub-pill ${!state.activeSubcategory ? 'active' : ''} ${totalSubItems === 0 ? 'disabled' : ''}" data-sub="">All Subcategories (${totalSubItems})</button>
    `;

    const allSubBtn = container.querySelector('button[data-sub=""]') as HTMLButtonElement | null;
    if (allSubBtn) {
      if (totalSubItems === 0) {
        allSubBtn.disabled = true;
      } else {
        allSubBtn.addEventListener('click', () => {
          state.activeSubcategory = '';
          const filterSubSelect = document.getElementById('filterSubcategory') as HTMLSelectElement | null;
          if (filterSubSelect) filterSubSelect.value = '';
          this.app.documentGrid.loadDocuments();
        });
      }
    }

    subcatsMap.forEach((info, subId) => {
      const isActive = state.activeSubcategory === subId;
      // Hide subcategories with 0 items completely (unless currently selected as active filter)
      if ((info.count === 0 && !isActive) || state.isForbiddenSubcategory(subId)) {
        return;
      }

      const btn = document.createElement('button');
      btn.className = `sub-pill ${isActive ? 'active' : ''}`;
      btn.dataset.sub = subId;
      btn.textContent = `${info.name} (${info.count})`;
      
      btn.addEventListener('click', () => {
        state.activeSubcategory = subId;
        const filterSubSelect = document.getElementById('filterSubcategory') as HTMLSelectElement | null;
        if (filterSubSelect) filterSubSelect.value = subId;
        this.app.documentGrid.loadDocuments();
      });
      container.appendChild(btn);
    });
  }

  filterByCategory(catId: string): void {
    if (!catId) return;
    const state = this.app.state;
    state.activeCategory = catId.toLowerCase();
    state.activeSubcategory = '';

    document.querySelectorAll('.category-pills .pill').forEach(p => {
      p.classList.toggle('active', (p as HTMLElement).dataset.cat === state.activeCategory);
    });

    const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
    if (searchEl) {
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input'));
    }

    this.app.toast.info(`Filtering grid by Category: ${catId.toUpperCase()}`);
    this.app.documentGrid.loadDocuments();
  }

  filterByCategoryAndSubcategory(catId: string, subId?: string): void {
    if (!catId) return;
    const state = this.app.state;
    state.activeCategory = catId.toLowerCase();
    state.activeSubcategory = (subId && subId !== 'general') ? subId.toLowerCase() : '';

    document.querySelectorAll('.category-pills .pill').forEach(p => {
      p.classList.toggle('active', (p as HTMLElement).dataset.cat === state.activeCategory);
    });

    const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
    if (searchEl) {
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input'));
    }

    this.app.toast.info(`Filtering grid by Subcategory: ${state.activeSubcategory ? state.activeSubcategory.toUpperCase() : catId.toUpperCase()}`);
    this.app.documentGrid.loadDocuments();
  }

  filterBySearchOrSubcategory(tagValue: string, catId: string, subId?: string): void {
    const normTag = (tagValue || '').toLowerCase();
    if (subId && subId.toLowerCase() === normTag) {
      this.filterByCategoryAndSubcategory(catId, subId);
      return;
    }
    const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
    if (searchEl) {
      searchEl.value = tagValue;
      searchEl.dispatchEvent(new Event('input'));
      this.app.toast.info(`Filtering grid by Tag: #${tagValue}`);
      this.app.documentGrid.loadDocuments();
    }
  }

  filterByContact(contactVal: string): void {
    if (!contactVal) return;
    const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
    if (searchEl) {
      searchEl.value = contactVal;
      searchEl.dispatchEvent(new Event('input'));
      this.app.toast.info(`Filtering grid by Contact: ${contactVal}`);
      this.app.documentGrid.loadDocuments();
    }
  }
}

(window as any).CategoryPillsManager = CategoryPillsManager;
