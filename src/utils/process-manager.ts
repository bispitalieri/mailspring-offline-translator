/**
 * Process manager for the native Apple helper and Mailspring model storage.
 */

import { SupportedPlatform } from '../types';

export interface ChildProcessLike {
  stdin?: any;
  stdout?: any;
  stderr?: any;
  on?: (event: string, listener: (...args: any[]) => void) => any;
  kill?: (signal?: string) => boolean;
  killed?: boolean;
}

function getNativeNodeModule<T>(moduleName: string): T | null {
  try {
    const fn = typeof globalThis !== 'undefined' && (globalThis as any).require
      ? (globalThis as any).require
      : typeof require !== 'undefined'
      ? require
      : null;
    if (typeof fn === 'function') {
      return fn(moduleName) as T;
    }
  } catch {
    // Non-node runtime
  }
  return null;
}

export interface ExecutableResolution {
  path: string;
  isBundled: boolean;
  platform: SupportedPlatform;
  arch: string;
  exists: boolean;
  canExecute: boolean;
  isNodeScript?: boolean;
  error?: string;
}

export class ProcessManager {
  private static activeProcesses: Set<ChildProcessLike> = new Set();
  private static pluginRootDir: string = (() => {
    const p = getNativeNodeModule<any>('path');
    if (typeof __dirname !== 'undefined' && p) {
      return p.resolve(__dirname, '../..');
    }
    return '/plugin';
  })();

  /**
   * Sets or overrides the root plugin directory.
   */
  public static setPluginRootDir(dir: string): void {
    this.pluginRootDir = dir;
  }

  public static getPluginRootDir(): string {
    return this.pluginRootDir;
  }

  /**
   * Returns the offline model directory inside the plugin installation.
   */
  public static getModelsDirectory(): string {
    const p = getNativeNodeModule<any>('path');
    const f = getNativeNodeModule<any>('fs');
    const modelsDir = p
      ? p.join(this.pluginRootDir, 'data', 'models')
      : `${this.pluginRootDir}/data/models`;

    if (f) {
      f.mkdirSync(modelsDir, { recursive: true });
    }

    return modelsDir;
  }

  /**
   * Resolves the Windows Edge Translator API Node.js helper.
   */
  public static resolveWindowsExecutable(customBaseDir?: string): ExecutableResolution {
    const base = customBaseDir || this.pluginRootDir;
    const platform = (typeof process !== 'undefined' && (process.platform as SupportedPlatform)) || 'win32';
    const arch = typeof process !== 'undefined' ? process.arch : 'x64';

    const helperName = 'edge-translator.js';

    const p = getNativeNodeModule<any>('path');
    const f = getNativeNodeModule<any>('fs');

    const helperPath = p ? p.join(base, 'helpers', 'windows', helperName) : `${base}/helpers/windows/${helperName}`;

    let resolved = helperPath;
    let exists = false;
    let canExecute = false;

    if (f) {
      exists = f.existsSync(helperPath);
      canExecute = exists;
    } else {
      exists = platform === 'win32';
      canExecute = platform === 'win32';
    }

    return {
      path: resolved,
      isBundled: exists,
      platform,
      arch,
      exists,
      canExecute,
      isNodeScript: true,
      error: platform !== 'win32'
        ? 'Edge Translator API is only available on Windows 10/11 with Microsoft Edge (Chromium)'
        : !exists
        ? `Edge translator helper not found at ${resolved}`
        : undefined,
    };
  }

  /**
   * Resolves the native Apple Translation Framework Swift helper for macOS 15+.
   */
  public static resolveAppleExecutable(customBaseDir?: string): ExecutableResolution {
    const base = customBaseDir || this.pluginRootDir;
    const platform = (typeof process !== 'undefined' && (process.platform as SupportedPlatform)) || 'darwin';
    const arch = typeof process !== 'undefined' ? process.arch : 'arm64';

    const binaryName = 'apple-translator-darwin-universal';

    const p = getNativeNodeModule<any>('path');
    const f = getNativeNodeModule<any>('fs');

    const binaryPath = p ? p.join(base, 'helpers', 'apple', 'bin', binaryName) : `${base}/helpers/apple/bin/${binaryName}`;
    const legacyPath = p ? p.join(base, 'helpers', 'apple', 'TranslationHelper') : `${base}/helpers/apple/TranslationHelper`;

    let resolved = binaryPath;
    let exists = false;
    let canExecute = false;

    if (f) {
      exists = f.existsSync(binaryPath);
      if (!exists && f.existsSync(legacyPath)) {
        resolved = legacyPath;
        exists = true;
      }

      if (exists && platform === 'darwin') {
        try {
          const stat = f.statSync(resolved);
          if ((stat.mode & 0o111) === 0) {
            f.chmodSync(resolved, stat.mode | 0o755);
          }
          canExecute = true;
        } catch {
          canExecute = false;
        }
      }
    } else {
      exists = platform === 'darwin';
      canExecute = platform === 'darwin';
    }

    return {
      path: resolved,
      isBundled: exists,
      platform,
      arch,
      exists,
      canExecute,
      error: platform !== 'darwin'
        ? 'Apple Translation Framework is only available on macOS'
        : !exists
        ? `Apple translation helper not found at ${resolved}`
        : undefined,
    };
  }

  /**
   * Gets child_process from Electron main process via @electron/remote.
   * This bypasses the macOS seatbelt sandbox that prevents spawning from the renderer.
   */
  public static getChildProcessFromMain(): any {
    try {
      // @electron/remote is available in Mailspring plugins
      const remote = (typeof window !== 'undefined' && (window as any).require)
        ? (window as any).require('@electron/remote')
        : null;
      if (remote) {
        return remote.require('child_process');
      }
    } catch {
      // @electron/remote not available
    }
    return null;
  }

  /**
   * Spawns a child process safely without shell execution.
   * Uses @electron/remote to spawn from the main process when the renderer is sandboxed.
   */
  public static spawnWorker(
    executablePath: string,
    args: string[] = [],
    envOverrides: Record<string, string> = {},
    isNodeScript: boolean = false
  ): ChildProcessLike {
    const env = {
      ...(typeof process !== 'undefined' ? process.env : {}),
      ...envOverrides,
    };

    // For Node.js scripts, spawn with 'node' as the executable
    const cmd = isNodeScript ? 'node' : executablePath;
    const spawnArgs = isNodeScript ? [executablePath, ...args] : args;

    // First, try to get child_process from Electron main process via @electron/remote
    // This bypasses the macOS seatbelt sandbox that prevents spawning from the renderer
    const cpRemote = this.getChildProcessFromMain();
    if (cpRemote && typeof cpRemote.spawn === 'function') {
      console.log('[ProcessManager] Using child_process from Electron main process via @electron/remote');
      const proc = cpRemote.spawn(cmd, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });
      this.activeProcesses.add(proc);
      proc.on('exit', () => {
        this.activeProcesses.delete(proc);
      });
      return proc;
    }

    // Fallback: try local child_process
    const cp = getNativeNodeModule<any>('child_process');
    if (!cp || typeof cp.spawn !== 'function') {
      // Browser environment mock
      return {
        stdin: { write: () => true, end: () => {}, destroyed: false },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => true,
        killed: false,
      };
    }

    const proc = cp.spawn(cmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    this.activeProcesses.add(proc);

    proc.on('exit', () => {
      this.activeProcesses.delete(proc);
    });

    return proc;
  }

  /**
   * Cleanly terminates all child worker processes on plugin deactivation.
   */
  public static terminateAll(): void {
    for (const proc of this.activeProcesses) {
      try {
        if (!proc.killed) {
          if (proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.end();
          }
          if (typeof proc.kill === 'function') {
            proc.kill('SIGTERM');
          }
        }
      } catch {
        // Ignore kill errors
      }
    }
    this.activeProcesses.clear();
  }
}
