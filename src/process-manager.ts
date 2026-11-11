/**
 * Process manager for the native Apple helper and Mailspring model storage.
 */

import { SupportedPlatform } from './types';

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
  error?: string;
}

export class ProcessManager {
  private static activeProcesses: Set<ChildProcessLike> = new Set();
  private static pluginRootDir: string = (() => {
    const p = getNativeNodeModule<any>('path');
    if (typeof __dirname !== 'undefined' && p) {
      return p.resolve(__dirname, '..');
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
   * Resolves the native Apple Translation Framework Swift helper for macOS 15+.
   */
  public static resolveAppleExecutable(customBaseDir?: string): ExecutableResolution {
    const base = customBaseDir || this.pluginRootDir;
    const platform = (typeof process !== 'undefined' && (process.platform as SupportedPlatform)) || 'darwin';
    const arch = typeof process !== 'undefined' ? process.arch : 'arm64';

    const binaryName = arch === 'arm64'
      ? 'apple-translator-darwin-arm64'
      : 'apple-translator-darwin-universal';

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
   * Spawns a child process safely without shell execution.
   */
  public static spawnWorker(
    executablePath: string,
    args: string[] = [],
    envOverrides: Record<string, string> = {}
  ): ChildProcessLike {
    const env = {
      ...(typeof process !== 'undefined' ? process.env : {}),
      ...envOverrides,
    };

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

    const proc = cp.spawn(executablePath, args, {
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
