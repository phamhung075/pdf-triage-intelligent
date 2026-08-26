const { app, Tray, Menu, shell, nativeImage, BrowserWindow } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

let tray = null;
let mainWindow = null;
let serverProcess = null;
let ollamaProcess = null;

const PORT = 3971;
// 127.0.0.1, not "localhost": the server binds IPv4 only (CONFIG.HOST), while on Windows
// "localhost" resolves to ::1 first. Browsers usually fall back to IPv4, but there is no reason to
// depend on that when the address we bind is known.
const SERVER_URL = `http://127.0.0.1:${PORT}`;
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

  // Point the server's writable state outside the application folder BEFORE importing it —
  // settings.ts reads this at module load, and the import below is what loads it.
  //
  // Packaged, appRoot is .../resources/app, which an upgrade replaces wholesale and which
  // `npm run dist:exe` deletes outright at the start of every build. Keeping the database,
  // registry, settings and private overlays there meant losing them on every rebuild. userData
  // (%APPDATA%\Smart PDF Triage) is the conventional home for exactly this and survives both.
  //
  // Unpackaged (electron desktop/main.cjs against a checkout) this is left alone, so DATA_DIR
  // falls back to the repo root and development behaves as before.
  if (app.isPackaged && !process.env.PDF_TRIAGE_DATA_DIR) {
    process.env.PDF_TRIAGE_DATA_DIR = app.getPath('userData');
    console.log(`📁 App data directory: ${process.env.PDF_TRIAGE_DATA_DIR}`);
  }
  
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

function createOrFocusWindow(fragment = '') {
  const hash = fragment ? (fragment.startsWith('#') ? fragment : '#' + fragment) : '';
  const targetUrl = `${SERVER_URL}/${hash}`;
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (hash) {
      mainWindow.loadURL(targetUrl);
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Smart PDF Triage - AI Document Sorting System',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    show: false,
    autoHideMenuBar: true
  });

  mainWindow.loadURL(targetUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Handle links opening in external browser or inside app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SERVER_URL) || url.includes('/viewer.html')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Opens the desktop application window once the Express server answers.
 */
function openDashboardInBrowser(fragment = '') {
  const deadline = Date.now() + 20000;

  const attempt = () => {
    const req = http.get(SERVER_URL, (res) => {
      res.resume();
      console.log(`🌐 Express server online. Showing desktop window...`);
      createOrFocusWindow(fragment);
    });
    req.on('error', () => {
      if (Date.now() < deadline) {
        setTimeout(attempt, 250);
      } else {
        console.warn(`Server did not answer within 20s — opening desktop window anyway.`);
        createOrFocusWindow(fragment);
      }
    });
  };

  attempt();
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
      label: `🌐 Open Dashboard (${SERVER_URL})`,
      click: () => openDashboardInBrowser()
    },
    {
      label: '⚡ Scan & Triage PDFs Now',
      click: () => triggerManualScan()
    },
    {
      // Settings is a modal inside the single-page dashboard, so this needs the #settings
      // fragment that TriageApp.applyDeepLink() understands. Without it this item opened the
      // dashboard root — indistinguishable from "Open Dashboard", so it looked broken.
      label: '⚙️ System Configuration',
      click: () => openDashboardInBrowser('#settings')
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

    // 4. Open the dashboard as soon as the server answers (openDashboardInBrowser polls).
    openDashboardInBrowser();
  });

  app.on('window-all-closed', (e) => {
    // Keep app running in System Tray even when windows are closed
    e.preventDefault();
  });

  app.on('before-quit', () => {
    cleanupAndExit();
  });
}
