import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';

vi.mock('fs');

const { runVisionPipelineMock } = vi.hoisted(() => ({ runVisionPipelineMock: vi.fn() }));
vi.mock('./application/image-to-pdf.js', () => ({ runVisionPipeline: runVisionPipelineMock }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('POST /api/vision/diagnose-image', () => {
  it('returns 400 when imageBase64 is missing', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(runVisionPipelineMock).not.toHaveBeenCalled();
  });

  it('returns 400 when imageBase64 is not a string', async () => {
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 123 });
    expect(res.status).toBe(400);
  });

  it('runs the pipeline and returns its steps on success', async () => {
    const fakeSteps = [{ step: 0, label: 'original', imageBase64: 'abc' }];
    runVisionPipelineMock.mockResolvedValue(fakeSteps);
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ steps: fakeSteps });
    expect(runVisionPipelineMock).toHaveBeenCalledWith(Buffer.from('ZmFrZQ==', 'base64'));
  });

  it('returns 500 with the error message when the pipeline throws', async () => {
    runVisionPipelineMock.mockRejectedValue(new Error('ollama unreachable'));
    const { createVisionLabApp } = await import('./vision-lab-server.js');
    const app = createVisionLabApp();
    const res = await request(app).post('/api/vision/diagnose-image').send({ imageBase64: 'ZmFrZQ==' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('ollama unreachable');
  });
});
