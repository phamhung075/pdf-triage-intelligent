/**
 * Toast Notification Factory Class Module (TypeScript)
 */
class ToastFactory {
    container = null;
    init() {
        this.container = document.getElementById('toastContainer');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'toastContainer';
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    }
    show(message, type = 'info', duration = 4000) {
        if (!this.container)
            this.init();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        let icon = 'ℹ️';
        if (type === 'success')
            icon = '✅';
        if (type === 'warning')
            icon = '⚠️';
        if (type === 'error')
            icon = '❌';
        const escapedMsg = message ? message.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        })[m] || m) : '';
        toast.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 0.6rem; flex: 1;">
        <span class="toast-icon" style="font-size: 1.1rem; flex-shrink: 0;">${icon}</span>
        <div class="toast-content" style="flex: 1; word-break: break-word;">${escapedMsg}</div>
      </div>
      <button class="toast-close" title="Dismiss Notification" aria-label="Close">✕</button>
    `;
        const closeBtn = toast.querySelector('.toast-close');
        if (closeBtn) {
            const handleDismiss = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.dismiss(toast);
            };
            closeBtn.addEventListener('click', handleDismiss, true);
            closeBtn.addEventListener('pointerdown', handleDismiss, true);
        }
        if (this.container) {
            this.container.appendChild(toast);
        }
        if (duration > 0) {
            setTimeout(() => this.dismiss(toast), duration);
        }
    }
    dismiss(toast) {
        if (!toast || toast.classList.contains('toast-hiding'))
            return;
        toast.classList.add('toast-hiding');
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.2s ease-out';
        setTimeout(() => {
            try {
                if (toast && toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }
            catch (err) { }
        }, 200);
    }
    success(msg, duration) { this.show(msg, 'success', duration); }
    info(msg, duration) { this.show(msg, 'info', duration); }
    warning(msg, duration) { this.show(msg, 'warning', duration); }
    error(msg, duration) { this.show(msg, 'error', duration); }
}
const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
window.ToastFactory = ToastFactory;
