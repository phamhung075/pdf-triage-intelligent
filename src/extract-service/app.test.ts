import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { createExtractServiceApp, SERVICE_NAME } from './app.js';

// The extraction service app is exercised in-process through supertest (no listening socket), so
// these tests run fine in CI / on machines without Docker. Content is chosen to never trigger the
// OCR tier: a .txt upload and a pdf-lib PDF with a real digital text layer parse through the
// cheap pdf-parse path, keeping the suite fast and deterministic.

async function buildTextPdf(text: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([320, 160]);
  const font = await pdfDoc.embedFont('Helvetica');
  page.drawText(text, { x: 20, y: 90, size: 16, font });
  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

describe('pdf-extract microservice (POST /extract)', () => {
  const app = createExtractServiceApp();

  it('GET /health reports ok with the service name', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe(SERVICE_NAME);
  });

  it('extracts a .txt upload and returns the ExtractedPDF contract', async () => {
    const content = 'Microservice triage extraction test — facture EDF 2026 montant 123,45 €';
    const res = await request(app)
      .post('/extract')
      .set('X-File-Name', encodeURIComponent('facture-test.txt'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(content, 'utf-8'));

    expect(res.status).toBe(200);
    expect(typeof res.body.checksum).toBe('string');
    expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.raw_text).toContain('Microservice triage extraction test');
    expect(res.body.numpages).toBe(1);
    expect(res.body.ocr_degraded).toBeFalsy();
  });

  it('extracts a PDF with a digital text layer, preserving numpages', async () => {
    const pdf = await buildTextPdf('Contrat de travail microservice PDF 2026 durée indéterminée');
    const res = await request(app)
      .post('/extract')
      .set('X-File-Name', encodeURIComponent('contrat-microservice.pdf'))
      .set('Content-Type', 'application/octet-stream')
      .send(pdf);

    expect(res.status).toBe(200);
    expect(res.body.raw_text).toContain('Contrat de travail');
    expect(res.body.numpages).toBe(1);
    expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honors the original filename extension for routing (docx-style text through .txt)', async () => {
    // A .txt-extensioned file must take the .txt branch, not the PDF branch — the extension is
    // taken from X-File-Name, not sniffed from bytes.
    const res = await request(app)
      .post('/extract')
      .set('X-File-Name', encodeURIComponent('note-rapide.txt'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('Simple note texte pour vérifier le routage par extension', 'utf-8'));

    expect(res.status).toBe(200);
    expect(res.body.raw_text).toContain('routage par extension');
  });

  it('rejects an empty body with 400', async () => {
    const res = await request(app)
      .post('/extract')
      .set('X-File-Name', encodeURIComponent('vide.pdf'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
