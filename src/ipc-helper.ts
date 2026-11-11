/**
 * JSON Lines IPC Helper for Native and Standalone Worker Processes
 */

import { IPCMessage } from './types';

export interface PendingRequest {
  id: string;
  action: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | any;
  timeoutMs: number;
  onProgress?: (percent: number, message: string) => void;
}

export class JsonLinesIpcClient {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private stdoutBuffer = '';
  private sequence = 0;
  private processRef: any = null;
  private isDisposed = false;

  constructor(
    private spawnCommand: () => any,
    private defaultTimeoutMs = 15000,
    private processName = 'Worker'
  ) {}

  public ensureProcess(): any {
    if (this.isDisposed) {
      throw new Error(`${this.processName} IPC client is disposed`);
    }

    if (this.processRef && !this.processRef.killed) {
      return this.processRef;
    }

    this.processRef = this.spawnCommand();

    if (!this.processRef || !this.processRef.stdout || !this.processRef.stdin) {
      throw new Error(`Failed to spawn ${this.processName} process`);
    }

    this.processRef.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdoutData(chunk.toString('utf8'));
    });

    this.processRef.stderr.on('data', (chunk: Buffer | string) => {
      // Diagnostic logging only - never log email contents
      const msg = chunk.toString('utf8').trim();
      if (msg) {
        console.warn(`[${this.processName} stderr]:`, msg.substring(0, 200));
      }
    });

    this.processRef.on('exit', (code: number, signal: string) => {
      console.info(`[${this.processName}] exited with code ${code}, signal ${signal}`);
      this.rejectAllPending(new Error(`${this.processName} exited unexpectedly (code ${code})`));
      this.processRef = null;
    });

    return this.processRef;
  }

  public async sendRequest<TResponse = any, TPayload = any>(
    action: IPCMessage['action'],
    payload?: TPayload,
    timeoutMs?: number,
    onProgress?: (percent: number, message: string) => void
  ): Promise<TResponse> {
    const proc = this.ensureProcess();
    const id = `req_${Date.now()}_${++this.sequence}`;
    const timeout = timeoutMs || this.defaultTimeoutMs;

    return new Promise<TResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${action} (${id}) timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, {
        id,
        action,
        resolve,
        reject,
        timer,
        timeoutMs: timeout,
        onProgress,
      });

      const message: IPCMessage<TPayload> = {
        id,
        action,
        payload,
      };

      try {
        const line = JSON.stringify(message) + '\n';
        proc.stdin.write(line, 'utf8');
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to write to ${this.processName} stdin: ${err.message}`));
      }
    });
  }

  public handleStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');

    this.stdoutBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const parsed: IPCMessage = JSON.parse(line);
        if (parsed && parsed.id) {
          const pending = this.pendingRequests.get(parsed.id);
          if (pending) {
            if (parsed.action === 'progress') {
              const progress = parsed.payload as { percent?: unknown; message?: unknown } | undefined;
              if (typeof progress?.percent === 'number') {
                pending.onProgress?.(
                  Math.max(0, Math.min(100, progress.percent)),
                  typeof progress.message === 'string' ? progress.message : ''
                );
              }
              clearTimeout(pending.timer);
              pending.timer = setTimeout(() => {
                this.pendingRequests.delete(pending.id);
                pending.reject(
                  new Error(
                    `Request ${pending.action} (${pending.id}) timed out after ${pending.timeoutMs}ms without progress`
                  )
                );
              }, pending.timeoutMs);
              continue;
            }

            clearTimeout(pending.timer);
            this.pendingRequests.delete(parsed.id);

            if (parsed.error) {
              pending.reject(new Error(`[${parsed.error.code}] ${parsed.error.message}`));
            } else {
              pending.resolve(parsed.payload);
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.processName}] failed to parse JSON line:`, err);
      }
    }
  }

  public cancel(id: string): void {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject(new Error(`Request ${id} was cancelled by user`));
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  public dispose(): void {
    this.isDisposed = true;
    this.rejectAllPending(new Error(`${this.processName} was disposed`));

    if (this.processRef) {
      try {
        if (this.processRef.stdin && !this.processRef.stdin.destroyed) {
          this.processRef.stdin.end();
        }
        this.processRef.kill('SIGTERM');
      } catch {
        // Ignore kill errors
      }
      this.processRef = null;
    }
  }
}
