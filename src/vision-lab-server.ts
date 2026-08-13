import express from 'express';
import path from 'path';
import fs from 'fs';
import { CONFIG, BASE_DIR } from './infrastructure/settings.js';
import { runVisionPipeline } from './application/image-to-pdf.js';

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

  app.post('/api/vision/diagnose-image', async (req, res) => {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'imageBase64 (string) is required' });
      return;
    }
    try {
      const buffer = Buffer.from(imageBase64, 'base64');
      const steps = await runVisionPipeline(buffer);
      res.json({ steps });
    } catch (err: any) {
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
