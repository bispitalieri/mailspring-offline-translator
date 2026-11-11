/**
 * Electron-based Confirmation Window for Model Downloads
 * 
 * Creates a separate modal BrowserWindow using @electron/remote to prompt
 * for explicit user consent before downloading Argos translation models.
 */

const { BrowserWindow, screen } = window.require("@electron/remote");
import type { BrowserWindow as BrowserWindowClass } from '@electron/remote';
import { ModelPackage } from './types';

interface ConfirmationWindowOptions {
  model: ModelPackage;
  onConfirm: (model: ModelPackage) => void;
  onCancel: () => void;
}

class ModelDownloadConfirmationWindow {
  private window: InstanceType<typeof BrowserWindowClass> | null = null;
  private isOpen = false;

  /**
   * Show the confirmation window. Returns a promise that resolves when the user
   * confirms or cancels. Only one confirmation window can be open at a time.
   */
  show(options: ConfirmationWindowOptions): Promise<void> {
    return new Promise((resolve) => {
      if (this.isOpen) {
        // Prevent multiple confirmation windows
        this.focus();
        resolve();
        return;
      }

      this.createWindow(options, resolve);
    });
  }

  private createWindow(options: ConfirmationWindowOptions, resolve: () => void): void {
    const { model, onConfirm, onCancel } = options;

    // Get the current Mailspring window as parent
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

    // Calculate centered position
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    const windowWidth = 450;
    const windowHeight = 620;
    const x = Math.round(screenWidth / 2 - windowWidth / 2);
    const y = Math.round(screenHeight / 2 - windowHeight / 2);

    this.window = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x,
      y,
      parent: parentWindow || undefined,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: 'Confirm Model Download',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
      backgroundColor: '#1a1a2e',
    });
    if (!this.window){
      console.log('window is null');
      return;
    }

    this.window.setMenuBarVisibility(false);

    // Load the HTML content
    this.window.loadURL(`data:text/html,${encodeURIComponent(this.getHTML(model))}`);

    // Handle window events
    this.window.once('ready-to-show', () => {
      this.isOpen = true;
      this.window?.show();
      this.window?.focus();
    });

    this.window.on('closed', () => {
      this.isOpen = false;
      this.window = null;
      // Only resolve if not already resolved by button click
      resolve();
    });

    // Handle Escape key
    this.window.webContents.on('before-input-event', (_event: Electron.Event, input: Electron.Input) => {
      if (input.key === 'Escape') {
        this.close();
        onCancel();
        resolve();
      }
    });

    // Expose IPC handlers for button clicks
    this.window.webContents.ipc.on('confirm-download', () => {
      this.close();
      onConfirm(model);
      resolve();
    });

    this.window.webContents.ipc.on('cancel-download', () => {
      this.close();
      onCancel();
      resolve();
    });
  }

  private getHTML(model: ModelPackage): string {
    const sizeDisplay = model.sizeMB > 0 ? `~${model.sizeMB} MB` : 'Not provided by Argos';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      background: #1a1a2e;
      padding: 24px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: rgba(0, 188, 212, 0.15);
      color: #00bcd4;
      font-size: 20px;
      margin-bottom: 16px;
    }
    h3 {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .subtitle {
      font-size: 11px;
      color: #888;
      margin-bottom: 20px;
    }
    .language-pair {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: #151525;
      border-radius: 6px;
      border: 1px solid #2a2a4a;
      font-weight: 500;
      color: #00bcd4;
      margin-bottom: 16px;
    }
    .arrow {
      color: #666;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #2a2a4a;
      font-size: 12px;
    }
    .info-row:last-child {
      border-bottom: none;
    }
    .info-label {
      color: #888;
    }
    .info-value {
      font-weight: 500;
      color: #e0e0e0;
    }
    .description {
      margin-top: 16px;
      padding: 12px;
      background: #151525;
      border-radius: 6px;
      border: 1px solid #2a2a4a;
      font-size: 11px;
      color: #888;
    }
    .buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 24px;
    }
    button {
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .btn-cancel {
      background: transparent;
      color: #ccc;
      border-color: #3a3a5a;
    }
    .btn-cancel:hover {
      background: #2a2a4a;
      color: #fff;
    }
    .btn-confirm {
      background: #00bcd4;
      color: #000;
    }
    .btn-confirm:hover {
      background: #00acc1;
    }
    .btn-confirm:active {
      background: #0097a7;
    }
    button:focus-visible {
      outline: 2px solid #00bcd4;
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <div class="icon">📥</div>
  <h3>Confirm Model Download</h3>
  <p class="subtitle">Explicit user consent required</p>

  <div class="language-pair">
    <span>${model.fromName} (${model.fromCode})</span>
    <span class="arrow">→</span>
    <span>${model.toName} (${model.toCode})</span>
  </div>

  <div class="info-row">
    <span class="info-label">Download size:</span>
    <span class="info-value">${sizeDisplay}</span>
  </div>

  <div class="info-row">
    <span class="info-label">Engine:</span>
    <span class="info-value">Argos Translate (CTranslate2)</span>
  </div>

  <div class="info-row">
    <span class="info-label">Storage location:</span>
    <span class="info-value">Mailspring data/models folder</span>
  </div>

  <div class="description">
    Once downloaded, this model will be stored locally and will perform translations
    completely offline without network access. The model runs using the native CTranslate2 runtime.
  </div>

  <div class="buttons">
    <button class="btn-cancel" id="btnCancel">Cancel</button>
    <button class="btn-confirm" id="btnConfirm">Approve & Download</button>
  </div>

  <script>
    const { ipcRenderer } = require('electron');

    document.getElementById('btnCancel').addEventListener('click', () => {
      ipcRenderer.send('cancel-download');
    });

    document.getElementById('btnConfirm').addEventListener('click', () => {
      ipcRenderer.send('confirm-download');
    });

    // Focus confirm button by default
    document.getElementById('btnConfirm').focus();
  </script>
</body>
</html>
    `;
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.isOpen = false;
  }

  focus(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
    }
  }

  destroy(): void {
    this.close();
  }
}

// Export singleton instance
export const confirmationWindow = new ModelDownloadConfirmationWindow();