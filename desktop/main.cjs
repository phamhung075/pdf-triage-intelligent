const { app, Tray, Menu, shell, nativeImage } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

let tray = null;
let serverProcess = null;
let ollamaProcess = null;

const PORT = 3971;
const SERVER_URL = `http://localhost:${PORT}`;
const OLLAMA_HOST = 'http://127.0.0.1:11434';

// Basic 16x16 PNG Data URL for System Tray Icon (Folder/PDF Sorter Icon)
const TRAY_ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA7SURBVDhPY2AYBaNgFIBAMwPjf3JowxogxYAxHBoYGBgYGJAGoANM0wB2NNoA1UBW1/VqAAbGAHlqAABwAw0Vb2aVrwAAAABJRU5ErkJggg==';

function checkOllamaStatus(callback) {
  const req = http.get(`${OLLAMA_HOST}/api/tags`, (res) => {
    callback(res.statusCode === 200);
  });
  req.on('error', () => callback(false));
  req.setTimeout(1500, () => {
    req.destroy();
    callback(false);
  });
}

function startOllamaIfNeeded() {
  checkOllamaStatus((online) => {
    if (!online) {
      console.log('🤖 Ollama AI is offline — spawning local "ollama serve"...');
      try {
        ollamaProcess = spawn('ollama', ['serve'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        ollamaProcess.on('error', (err) => {
          console.warn('⚠️ Ollama auto-spawn error (Ollama might not be in PATH):', err.message);
        });
        ollamaProcess.unref();
      } catch (err) {
        console.warn('Failed to auto-spawn ollama serve:', err.message);
      }
    } else {
      console.log('✅ Ollama AI is already online and responding at 127.0.0.1:11434.');
    }
  });
}

async function startExpressServer() {
  console.log('⚡ Auto-starting Express Web Server...');
  const appRoot = path.resolve(__dirname, '..');
  const compiledEntry = path.join(appRoot, 'dist', 'index.js');
  
  if (fs.existsSync(compiledEntry)) {
    try {
      const fileUrl = pathToFileURL(compiledEntry).href;
      await import(fileUrl);
      console.log('✅ Express Web Server initialized successfully from dist/index.js.');
      return;
    } catch (err) {
      console.error('Error importing dist/index.js:', err);
    }
  }

  console.log('Falling back to dev tsx spawner...');
  const tsEntry = path.join(appRoot, 'src', 'index.ts');
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  serverProcess = spawn(cmd, ['tsx', tsEntry], {
    cwd: appRoot,
    stdio: 'pipe',
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT) }
  });

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[SERVER] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[SERVER ERR] ${data.toString().trim()}`);
  });
}

function openDashboardInBrowser() {
  console.log(`🌐 Opening browser at ${SERVER_URL}...`);
  shell.openExternal(SERVER_URL);
}

function triggerManualScan() {
  const req = http.request(`${SERVER_URL}/api/triage/scan`, { method: 'POST' }, (res) => {
    console.log('Manual scan triggered via tray context menu');
  });
  req.on('error', () => {});
  req.end();
}

function setupSystemTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let img = fs.existsSync(iconPath) 
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createFromDataURL(TRAY_ICON_BASE64);

  tray = new Tray(img);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📁 Smart PDF Triage Dashboard',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '🌐 Open Dashboard (http://localhost:3971)',
      click: () => openDashboardInBrowser()
    },
    {
      label: '⚡ Scan & Triage PDFs Now',
      click: () => triggerManualScan()
    },
    {
      label: '⚙️ System Configuration',
      click: () => shell.openExternal(`${SERVER_URL}`)
    },
    { type: 'separator' },
    {
      label: '▶️ Start / Restart Ollama',
      click: () => startOllamaIfNeeded()
    },
    { type: 'separator' },
    {
      label: '🚪 Exit Application',
      click: () => {
        app.isQuitting = true;
        cleanupAndExit();
      }
    }
  ]);

  tray.setToolTip('Smart PDF Triage - AI Document Sorting System');
  tray.setContextMenu(contextMenu);

  // Single click on taskbar icon opens browser
  tray.on('click', () => {
    openDashboardInBrowser();
  });
}

function cleanupAndExit() {
  console.log('Cleaning up processes and exiting...');
  if (serverProcess) {
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${serverProcess.pid} /T /F`, { windowsHide: true });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {}
  }
  if (tray) tray.destroy();
  app.quit();
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('Another instance is already running. Opening dashboard and exiting...');
  openDashboardInBrowser();
  app.quit();
} else {
  app.on('second-instance', () => {
    openDashboardInBrowser();
  });

  app.whenReady().then(() => {
    console.log('🚀 Launching Smart PDF Triage Desktop App...');

    // 1. Auto-Check and Start Ollama if needed
    startOllamaIfNeeded();

    // 2. Start Express Web Server
    startExpressServer();

    // 3. Register Taskbar System Tray
    setupSystemTray();

    // 4. Immediately open default browser as requested by user
    setTimeout(() => {
      openDashboardInBrowser();
    }, 2000);
  });

  app.on('window-all-closed', (e) => {
    // Keep app running in System Tray even when windows are closed
    e.preventDefault();
  });

  app.on('before-quit', () => {
    cleanupAndExit();
  });
}
