import { CONFIG } from '../infrastructure/settings.js';
import { logger } from '../infrastructure/logger.js';
import { createExtractServiceApp, SERVICE_NAME } from './app.js';

/**
 * Entrypoint of the PDF text-extraction microservice.
 *
 * Local (no Docker):        npm run extract:dev
 * Docker (recommended):     docker compose up --build   (see Dockerfile.extract-service)
 *
 * The service listens on PDF_EXTRACT_PORT / PDF_EXTRACT_HOST (defaults 3981 / 127.0.0.1). The
 * main pdf-triage server switches to it via PDF_EXTRACT_SERVICE_URL (see docs/knowledge/
 * pdf-extract-service.md).
 */
export function startExtractServiceServer(): void {
  const port = CONFIG.EXTRACT_SERVICE_PORT;
  const host = CONFIG.EXTRACT_SERVICE_HOST;

  const server = createExtractServiceApp().listen(port, host, () => {
    logger.info(
      'EXTRACT_SERVICE',
      `${SERVICE_NAME} listening on http://${host}:${port} — POST /extract (raw bytes + X-File-Name) or GET /health`
    );
  });

  // Docker sends SIGTERM on `docker stop`; close the listener so an in-flight request can settle
  // rather than being cut mid-OCR. The extraction client on the main app side treats a dropped
  // connection as a service failure and falls back to in-process extraction, so a forced exit is
  // safe either way.
  const shutdown = (signal: string) => {
    logger.info('EXTRACT_SERVICE', `Received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startExtractServiceServer();
