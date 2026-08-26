import { fullFrameQuad, rotateQuad90, quadIsFullFrame, hitTest, dragQuadMove, dragQuadCorner, dragQuadEdge, quadBounds, } from './crop-quad.js';
/**
 * Manual image editor: crop, rotate and adjust a photograph before it becomes a PDF.
 *
 * Exists because the automatic vision pipeline (orient -> crop -> enhance) sometimes gets a page
 * wrong — a clipped corner, a bad rotation, a washed-out scan — and until now there was no way to
 * intervene. The source photo is retained under .delete_files/img_converted, so a document made
 * from one can be re-edited and re-filed.
 *
 * All geometry is delegated to crop-quad.ts, which is pure and unit-tested. This class owns only
 * the canvas, the pointer events and the upload.
 *
 * The result is POSTed to the same import endpoint the toolbar button uses, so an edited image
 * takes the ordinary conversion/classification/filing path rather than a parallel one.
 */
export class ImageEditorManager {
    app;
    canvas = null;
    ctx = null;
    /** The image as currently oriented — replaced outright on each rotate. */
    image = null;
    quad = null;
    scale = 1;
    brightness = 0;
    contrast = 0;
    dragHandle = 'none';
    dragStartPos = { x: 0, y: 0 };
    dragStartQuad = null;
    /** Filename to send back; also tells the user what they are editing. */
    filename = 'edited.jpg';
    constructor(app) {
        this.app = app;
    }
    init() {
        this.canvas = document.getElementById('editorCanvas');
        this.ctx = this.canvas?.getContext('2d') || null;
        if (!this.canvas)
            return;
        this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
        window.addEventListener('pointerup', () => this.onPointerUp());
        document.getElementById('btnCloseImageEditor')?.addEventListener('click', () => this.close());
        document.getElementById('btnEditorRotate')?.addEventListener('click', () => this.rotate());
        document.getElementById('btnEditorResetCrop')?.addEventListener('click', () => this.resetCrop());
        document.getElementById('btnEditorResetAdjust')?.addEventListener('click', () => this.resetAdjust());
        document.getElementById('btnEditorApply')?.addEventListener('click', () => void this.apply());
        const brightness = document.getElementById('editorBrightness');
        const contrast = document.getElementById('editorContrast');
        brightness?.addEventListener('input', () => {
            this.brightness = Number(brightness.value);
            this.setText('editorBrightnessVal', String(this.brightness));
            this.render();
        });
        contrast?.addEventListener('input', () => {
            this.contrast = Number(contrast.value);
            this.setText('editorContrastVal', String(this.contrast));
            this.render();
        });
    }
    /** Opens the editor on a document's retained source photo. */
    async openForDocument(docId, title) {
        this.filename = `${(title || 'document').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}_edited.jpg`;
        await this.openWithSource(`/api/documents/${docId}/source-image`);
    }
    /** Opens the editor on a local file the user just picked. */
    async openForFile(file) {
        this.filename = file.name;
        await this.openWithSource(URL.createObjectURL(file), true);
    }
    async openWithSource(src, revoke = false) {
        const modal = document.getElementById('imageEditorModal');
        const loading = document.getElementById('editorLoading');
        if (!modal)
            return;
        modal.classList.add('open');
        if (loading)
            loading.hidden = false;
        this.hideError();
        try {
            const img = await this.loadImage(src);
            // Draw once into an offscreen canvas so rotation and pixel reads work off one surface.
            const surface = document.createElement('canvas');
            surface.width = img.naturalWidth || img.width;
            surface.height = img.naturalHeight || img.height;
            surface.getContext('2d').drawImage(img, 0, 0);
            this.image = surface;
            this.quad = fullFrameQuad(surface.width, surface.height);
            this.resetAdjust();
            this.fitCanvas();
            this.render();
        }
        catch (err) {
            this.showError(err?.message === 'HTTP 404'
                ? 'No source image was kept for this document. Only documents converted since source retention was added can be re-edited.'
                : `Could not load the image: ${err?.message || err}`);
        }
        finally {
            if (loading)
                loading.hidden = true;
            if (revoke)
                URL.revokeObjectURL(src);
        }
    }
    loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            // An <img> error gives no status, so probe the URL to tell "no source kept" (404) apart
            // from a genuine decode failure — the two need very different messages.
            img.onerror = async () => {
                try {
                    const res = await fetch(src);
                    reject(new Error(res.ok ? 'the file is not a readable image' : `HTTP ${res.status}`));
                }
                catch {
                    reject(new Error('the image could not be fetched'));
                }
            };
            img.src = src;
        });
    }
    close() {
        document.getElementById('imageEditorModal')?.classList.remove('open');
        this.image = null;
        this.quad = null;
    }
    // ── canvas ────────────────────────────────────────────────────────────────
    /** Sizes the canvas to fit the stage while keeping a 1:1 mapping for the drag maths. */
    fitCanvas() {
        if (!this.canvas || !this.image)
            return;
        const maxW = Math.min(720, (this.canvas.parentElement?.clientWidth || 720) - 24);
        const maxH = 560;
        this.scale = Math.min(maxW / this.image.width, maxH / this.image.height, 1);
        this.canvas.width = Math.round(this.image.width * this.scale);
        this.canvas.height = Math.round(this.image.height * this.scale);
    }
    render() {
        if (!this.ctx || !this.canvas || !this.image || !this.quad)
            return;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);
        // CSS filters do the preview cheaply; the same values are re-applied at export time so what
        // the user sees is what gets written.
        this.ctx.filter = this.cssFilter();
        this.ctx.drawImage(this.image, 0, 0, width, height);
        this.ctx.filter = 'none';
        const pts = this.quad.map(p => ({ x: p.x * this.scale, y: p.y * this.scale }));
        // Shade everything outside the crop, so what will be discarded is obvious.
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, 0, width, height);
        this.ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 3; i >= 1; i--)
            this.ctx.lineTo(pts[i].x, pts[i].y);
        this.ctx.closePath();
        this.ctx.fillStyle = 'rgba(2, 6, 23, 0.62)';
        this.ctx.fill('evenodd');
        this.ctx.restore();
        this.ctx.strokeStyle = '#38bdf8';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++)
            this.ctx.lineTo(pts[i].x, pts[i].y);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.fillStyle = '#38bdf8';
        for (const p of pts) {
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }
    cssFilter() {
        // Sliders are -100..100; map to the multiplicative form canvas filters expect.
        const b = 1 + this.brightness / 100;
        const c = 1 + this.contrast / 100;
        return `brightness(${b}) contrast(${c})`;
    }
    // ── pointer ───────────────────────────────────────────────────────────────
    eventPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        // The canvas may be laid out smaller than its backing store; convert back so the geometry
        // always works in canvas pixels.
        return {
            x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.canvas.height / rect.height),
        };
    }
    onPointerDown(e) {
        if (!this.quad)
            return;
        const pos = this.eventPos(e);
        this.dragHandle = hitTest(pos, this.quad, this.scale);
        if (this.dragHandle === 'none')
            return;
        this.dragStartPos = pos;
        this.dragStartQuad = this.quad;
        this.canvas?.setPointerCapture(e.pointerId);
    }
    onPointerMove(e) {
        if (!this.quad || !this.image)
            return;
        const pos = this.eventPos(e);
        if (this.dragHandle === 'none' || !this.dragStartQuad) {
            const over = hitTest(pos, this.quad, this.scale);
            if (this.canvas) {
                this.canvas.style.cursor = over === 'move' ? 'grab' : over === 'none' ? 'crosshair' : 'pointer';
            }
            return;
        }
        // Deltas are in image space, which is what every crop-quad function expects.
        const dx = (pos.x - this.dragStartPos.x) / this.scale;
        const dy = (pos.y - this.dragStartPos.y) / this.scale;
        const w = this.image.width;
        const h = this.image.height;
        if (this.dragHandle === 'move') {
            this.quad = dragQuadMove(this.dragStartQuad, dx, dy, w, h);
        }
        else if (this.dragHandle.startsWith('c')) {
            this.quad = dragQuadCorner(this.dragStartQuad, Number(this.dragHandle[1]), dx, dy, w, h);
        }
        else if (this.dragHandle.startsWith('e')) {
            this.quad = dragQuadEdge(this.dragStartQuad, Number(this.dragHandle[1]), dx, dy, w, h);
        }
        this.render();
    }
    onPointerUp() {
        this.dragHandle = 'none';
        this.dragStartQuad = null;
    }
    // ── actions ───────────────────────────────────────────────────────────────
    rotate() {
        if (!this.image || !this.quad)
            return;
        const oldW = this.image.width;
        const oldH = this.image.height;
        const rotated = document.createElement('canvas');
        rotated.width = oldH;
        rotated.height = oldW;
        const rctx = rotated.getContext('2d');
        rctx.translate(oldH, 0);
        rctx.rotate(Math.PI / 2);
        rctx.drawImage(this.image, 0, 0);
        this.image = rotated;
        // Re-express the crop in the rotated frame rather than discarding it.
        this.quad = rotateQuad90(this.quad, oldW, oldH);
        this.fitCanvas();
        this.render();
    }
    resetCrop() {
        if (!this.image)
            return;
        this.quad = fullFrameQuad(this.image.width, this.image.height);
        this.render();
    }
    resetAdjust() {
        this.brightness = 0;
        this.contrast = 0;
        const b = document.getElementById('editorBrightness');
        const c = document.getElementById('editorContrast');
        if (b)
            b.value = '0';
        if (c)
            c.value = '0';
        this.setText('editorBrightnessVal', '0');
        this.setText('editorContrastVal', '0');
        this.render();
    }
    /** Renders the crop at full resolution and sends it to the incoming folder. */
    async apply() {
        if (!this.image || !this.quad)
            return;
        const button = document.getElementById('btnEditorApply');
        const box = quadIsFullFrame(this.quad, this.image.width, this.image.height)
            ? { x: 0, y: 0, width: this.image.width, height: this.image.height }
            : quadBounds(this.quad, this.image.width, this.image.height);
        const out = document.createElement('canvas');
        out.width = Math.round(box.width);
        out.height = Math.round(box.height);
        const octx = out.getContext('2d');
        octx.filter = this.cssFilter();
        // Export from the full-resolution surface, never the on-screen canvas — the preview is
        // downscaled to fit and exporting that would throw away most of the page's detail.
        octx.drawImage(this.image, box.x, box.y, box.width, box.height, 0, 0, out.width, out.height);
        const blob = await new Promise(resolve => out.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob) {
            this.showError('Could not render the edited image.');
            return;
        }
        if (button) {
            button.disabled = true;
            button.textContent = 'Converting…';
        }
        try {
            const res = await fetch(`/api/images/import?filename=${encodeURIComponent(this.filename)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: await blob.arrayBuffer(),
            });
            const data = await res.json();
            if (!res.ok)
                throw new Error(data.error || `HTTP ${res.status}`);
            this.close();
            this.app.toast.success('Edited image added to your incoming folder.\nIt will be converted, read and filed on the next scan.');
            this.app.documentGrid.loadDocuments();
        }
        catch (err) {
            this.showError(err.message);
        }
        finally {
            if (button) {
                button.disabled = false;
                button.textContent = 'Convert to PDF';
            }
        }
    }
    // ── small helpers ─────────────────────────────────────────────────────────
    setText(id, text) {
        const el = document.getElementById(id);
        if (el)
            el.textContent = text;
    }
    showError(message) {
        const box = document.getElementById('editorError');
        if (!box)
            return;
        box.textContent = message;
        box.hidden = false;
    }
    hideError() {
        const box = document.getElementById('editorError');
        if (box)
            box.hidden = true;
    }
}
// Published as a global like the other managers. This file is an ES module (it imports the
// crop geometry), so it loads via <script type="module">; those execute before
// DOMContentLoaded, which is when TriageApp is constructed.
window.ImageEditorManager = ImageEditorManager;
