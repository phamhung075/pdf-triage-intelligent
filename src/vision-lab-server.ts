import express from 'express';
import path from 'path';
import fs from 'fs';
import { CONFIG, BASE_DIR } from './infrastructure/settings.js';
import { runOrientStep, runCropStep, runEnhanceStep, runExtractStep } from './application/image-to-pdf.js';
import { logger } from './infrastructure/logger.js';

const STEP_FUNCTIONS = {
  1: runOrientStep,
  2: runCropStep,
  3: runEnhanceStep,
  4: runExtractStep,
} as const;

export function createVisionLabApp(): express.Express {
  const app = express();

  // Phone photos as base64 run several MB — well past Express's 100kb JSON default.
  app.use(express.json({ limit: '25mb' }));

  const publicDir = path.join(BASE_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      // This serves the ENTIRE public/ directory (shared with the main triage app). Without
      // index: false, Express's default index:'index.html' behavior would render the main
      // app's dashboard at this server's root — an unrelated page whose API calls all 404
      // here. The diagnostic page stays reachable at its explicit path, /test-image-to-pdf.html.
      index: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }));
  }

  // One stateless endpoint per pipeline step, parameterized by `step` — the client tracks
  // which buffer to send as inputImageBase64 on each call (the original upload for step 1,
  // the previous step's chosen output for steps 2-4). No server-side session state.
  app.post('/api/vision/diagnose-step', async (req, res) => {
    const { step, inputImageBase64 } = req.body || {};
    if (![1, 2, 3, 4].includes(step)) {
      logger.warn('VISION_LAB', 'Rejected diagnose-step request: step must be 1, 2, 3, or 4', { step });
      res.status(400).json({ error: 'step must be 1, 2, 3, or 4' });
      return;
    }
    if (!inputImageBase64 || typeof inputImageBase64 !== 'string') {
      logger.warn('VISION_LAB', 'Rejected diagnose-step request: inputImageBase64 missing or not a string');
      res.status(400).json({ error: 'inputImageBase64 (string) is required' });
      return;
    }
    try {
      const buffer = Buffer.from(inputImageBase64, 'base64');
      const stepFn = STEP_FUNCTIONS[step as 1 | 2 | 3 | 4];
      const result = await stepFn(buffer);
      res.json({ result });
    } catch (err: any) {
      logger.error('VISION_LAB', 'diagnose-step request failed', { step, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

export function startVisionLabServer(port: number = CONFIG.VISION_LAB_PORT): void {
  const app = createVisionLabApp();
  const server = app.listen(port, CONFIG.HOST, () => {
    console.log(`Vision Lab server running at http://${CONFIG.HOST}:${port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — another process may already be bound to it.`);
    } else {
      console.error('Vision Lab server failed to start:', err.message);
    }
    process.exit(1);
  });
}
