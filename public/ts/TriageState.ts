/**
 * Triage State & Utility Helpers Class Module (TypeScript)
 */
class TriageState {
  categories: any[] = [];
  activeCategory: string = '';
  activeSubcategory: string = '';
  activeManageCatId: string = '';
  allLoadedDocs: any[] = [];
  systemLanguage: string = 'FR';

  currentLogsTab: string = 'sessions';
  logsSseConnected: boolean = false;

  activeRelocalizeDoc: any = null;
  currentGrandViewerDoc: any = null;
  currentGrandViewerTab: string = 'markdown';

  getLocalizedName(item: any): string {
    if (!item) return '';
    if (this.systemLanguage === 'EN') {
      return item.name_en || item.name_fr || item.name || '';
    }
    return item.name_fr || item.name || '';
  }

  getVal(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    return el ? el.value : '';
  }

  setVal(id: string, val: string): void {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (el) el.value = val;
  }

  setElemText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  debounce(func: Function, wait: number): (...args: any[]) => void {
    let timeout: any;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  escapeHtml(str: any): string {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m as keyof typeof htmlMap] || m);
  }

  formatSubName(str: string): string {
    if (!str) return '';
    return str
      .split(/[\/\\]+/)
      .map(part => part.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
      .join(' ➔ ');
  }

  renderExpiryBadge(expiryDateStr?: string): string {
    if (!expiryDateStr) return '';
    const now = new Date();
    const exp = new Date(expiryDateStr);
    if (isNaN(exp.getTime())) return '';

    const diffDays = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
      return `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);" title="Document expired on ${expiryDateStr}">🔴 Expired (${expiryDateStr})</span>`;
    } else if (diffDays <= 60) {
      return `<span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);" title="Document expires in ${diffDays} days">⚠️ Expires Soon (${expiryDateStr})</span>`;
    }
    return `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);" title="Valid until ${expiryDateStr}">📅 Expires ${expiryDateStr}</span>`;
  }

  isForbiddenSubcategory(subcategory?: string): boolean {
    if (!subcategory) return true;
    const rawLower = String(subcategory).toLowerCase().trim();
    const normalized = rawLower.replace(/[^a-z0-9]+/g, '');
    if (normalized.length === 0) return true;
    const FORBIDDEN = new Set([
      'general', 'other', 'divers', 'unknown', 'none',
      'anyscanner', 'camscanner', 'geniusscan', 'adobescan', 'tinyscanner', 'simplescan', 'docscanner',
      'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'pdf', 'txt', 'docx', 'xlsx'
    ]);
    if (FORBIDDEN.has(rawLower) || FORBIDDEN.has(normalized) || /^\d{4}$/.test(rawLower)) return true;
    if (/^\d+$/.test(normalized)) return true;
    if (/.*[._-](pdf|jpg|jpeg|png|webp|tiff|bmp|txt|docx|xlsx)$/i.test(rawLower)) return true;
    if (/^(\d+|img\d*|scan\d*|photo\d*|doc\d*|file\d*)[_.]?(pdf|jpg|jpeg|png|webp|tiff|bmp|txt|docx|xlsx)$/i.test(rawLower)) return true;
    if (/^(anyscanner|camscanner|geniusscan|adobescan|tinyscanner|simplescan|docscanner)/i.test(normalized)) return true;
    return false;
  }

  autoFixMarkdownTables(text?: string): string {
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    const result: string[] = [];
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isPipeLine = /^\s*\|.*\|\s*$/.test(line);

      if (isPipeLine) {
        if (!inTable) {
          inTable = true;
          result.push(line);

          const nextLine = lines[i + 1] || '';
          const isSepRow = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(nextLine);
          if (!isSepRow) {
            const colCount = line.split('|').length - 2;
            if (colCount > 0) {
              const sepRow = '|' + Array(colCount).fill(' --- ').join('|') + '|';
              result.push(sepRow);
            }
          }
        } else {
          result.push(line);
        }
      } else {
        inTable = false;
        result.push(line);
      }
    }

    return result.join('\n');
  }

  renderMarkdown(str?: string): string {
    if (!str) return '';
    const fixed = this.autoFixMarkdownTables(str);
    if ((window as any).marked && typeof (window as any).marked.parse === 'function') {
      try {
        return (window as any).marked.parse(fixed);
      } catch (e) {}
    }

    const lines = this.escapeHtml(fixed).split('\n');
    let inTable = false;
    let tableHtml = '';
    let resultLines: string[] = [];

    lines.forEach(line => {
      const isTableRow = /^\s*\|.*\|\s*$/.test(line);
      if (isTableRow) {
        const cells = line.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        const isHeaderSep = cells.every(c => /^:?-+:?$/.test(c));
        if (isHeaderSep) return;

        if (!inTable) {
          inTable = true;
          tableHtml = '<table><thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        } else {
          tableHtml += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
        }
      } else {
        if (inTable) {
          inTable = false;
          tableHtml += '</tbody></table>';
          resultLines.push(tableHtml);
          tableHtml = '';
        }
        resultLines.push(line);
      }
    });
    if (inTable) {
      tableHtml += '</tbody></table>';
      resultLines.push(tableHtml);
    }

    let html = resultLines.join('\n')
      .replace(/^### (.*$)/gim, '<h5 style="color: #38bdf8; margin: 0.4rem 0 0.2rem; font-size: 0.85rem;">$1</h5>')
      .replace(/^## (.*$)/gim, '<h4 style="color: #38bdf8; margin: 0.5rem 0 0.2rem; font-size: 0.9rem;">$1</h4>')
      .replace(/^# (.*$)/gim, '<h3 style="color: #38bdf8; margin: 0.6rem 0 0.3rem; font-size: 0.95rem;">$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong style="color: #f8fafc;">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 0.1rem 0.3rem; border-radius: 3px; font-family: monospace; font-size: 0.8em;">$1</code>')
      .replace(/^\s*[\-\*]\s+(.*$)/gim, '<li style="margin-left: 1.1rem; list-style-type: disc;">$1</li>')
      .replace(/\n/g, '<br>');
    return html;
  }
}

const htmlMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

(window as any).TriageState = TriageState;
