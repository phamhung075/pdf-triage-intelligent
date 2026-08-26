import { ensureDirectoriesExist, CONFIG } from './infrastructure/settings.js';
import { startWebServer } from './infrastructure/http/web-server.js';
import { startMCPServer } from './infrastructure/mcp/mcp-server.js';
import { runTriageScan } from './application/triage-scan.js';

async function main() {
  ensureDirectoriesExist();

  const command = process.argv[2];

  if (command === 'scan') {
    console.log('Starting standalone PDF triage scan...');
    const result = await runTriageScan();
    console.log('Triage finished:', JSON.stringify(result, null, 2));
    process.exit(0);
  } else if (command === 'mcp') {
    console.error('Starting MCP Server...');
    await startMCPServer();
  } else {
    console.log('Starting Web Dashboard & Triage API Server...');
    await startWebServer(CONFIG.PORT);
  }
}

main().catch(err => {
  console.error('Fatal error in application:', err);
  process.exit(1);
});
