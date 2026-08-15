import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';

vi.mock('fs');

const { runOrientStepMock, runCropStepMock, runEnhanceStepMock, runExtractStepMock } = vi.hoisted(() => ({
  runOrientStepMock: vi.fn(),
  runCropStepMock: vi.fn(),
  runEnhanceStepMock: vi.fn(),
  runExtractStepMock: vi.fn(),
}));
vi.mock('./application/image-to-pdf.js', () => ({
  runOrientStep: runOrientStepMock,
  runCropStep: runCropStepMock,
  runEnhanceStep: runEnhanceStepMock,
  runExtractStep: runExtractStepMock,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('POST /api/vision/diagnose-step', () => {
  it('returns 400 when step is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ inputImageBase64: 'ZmFrZQ==' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when step is not 1, 2, 3, or 4', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 5, inputImageBase64: 'ZmFrZQ==' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when inputImageBase64 is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1 });
    expect(res.status).toBe(400);
    expect(runOrientStepMock).not.toHaveBeenCalled();
  });

  it('routes step 1 to runOrientStep and returns its result', async () => {
    const fakeResult = { step: 1, label: 'oriented', imageBase64: 'abc', durationMs: 5 };
    runOrientStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: fakeResult });
    expect(runOrientStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('routes step 2 to runCropStep', async () => {
    const fakeResult = { step: 2, label: 'cropped', imageBase64: 'abc', durationMs: 5 };
    runCropStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 2, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(runCropStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
    expect(runOrientStepMock).not.toHaveBeenCalled();
  });

  it('routes step 3 to runEnhanceStep', async () => {
    const fakeResult = { step: 3, label: 'enhanced', imageBase64: 'abc', durationMs: 5 };
    runEnhanceStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 3, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(runEnhanceStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('routes step 4 to runExtractStep', async () => {
    const fakeResult = { step: 4, label: 'extracted', imageBase64: '', durationMs: 5, markdown: '# Hi' };
    runExtractStepMock.mockResolvedValue(fakeResult);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 4, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: fakeResult });
    expect(runExtractStepMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('returns 500 with the error message when a step function throws', async () => {
    runOrientStepMock.mockRejectedValue(new Error('unexpected crash'));
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-step').send({ step: 1, inputImageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unexpected crash');
  });
});
