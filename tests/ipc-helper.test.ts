import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonLinesIpcClient } from '../lib/ipc-helper';
import { EventEmitter } from 'node:events';

test('JsonLinesIpcClient handles chunked stdin/stdout lines correctly', async () => {
  const fakeProc: any = new EventEmitter();
  fakeProc.stdin = {
    write: (data: string) => {},
    destroyed: false,
    end: () => {},
  };
  fakeProc.stdout = new EventEmitter();
  fakeProc.stderr = new EventEmitter();
  fakeProc.killed = false;
  fakeProc.kill = () => {};

  const client = new JsonLinesIpcClient(() => fakeProc, 5000, 'TestWorker');
  client.ensureProcess();

  // Send a request
  const promise = client.sendRequest<any>('ping');

  // Simulate chunked stdout response
  // Chunk 1: partial line
  fakeProc.stdout.emit('data', '{"id":"req_');
  // Chunk 2: rest of id and action
  const pendingId = (client as any).pendingRequests.keys().next().value;
  const idSuffix = pendingId.replace('req_', '');

  fakeProc.stdout.emit('data', `${idSuffix}","action":"ping","payload":{"status":"pong"},"error":null}\n`);

  const response = await promise;
  assert.equal(response.status, 'pong');

  client.dispose();
});

test('JsonLinesIpcClient reports progress without resolving the request', async () => {
  const fakeProc: any = new EventEmitter();
  fakeProc.stdin = { write: () => {}, destroyed: false, end: () => {} };
  fakeProc.stdout = new EventEmitter();
  fakeProc.stderr = new EventEmitter();
  fakeProc.killed = false;
  fakeProc.kill = () => {};

  const client = new JsonLinesIpcClient(() => fakeProc, 5000, 'TestWorker');
  client.ensureProcess();

  const progressEvents: Array<{ percent: number; message: string }> = [];
  const promise = client.sendRequest<any>(
    'install_model',
    {},
    5000,
    (percent, message) => progressEvents.push({ percent, message })
  );
  const pendingId = (client as any).pendingRequests.keys().next().value;

  fakeProc.stdout.emit(
    'data',
    `${JSON.stringify({
      id: pendingId,
      action: 'progress',
      payload: { percent: 45, message: 'Downloading model' },
    })}\n`
  );

  assert.equal((client as any).pendingRequests.size, 1);
  assert.deepEqual(progressEvents, [{ percent: 45, message: 'Downloading model' }]);

  fakeProc.stdout.emit(
    'data',
    `${JSON.stringify({
      id: pendingId,
      action: 'install_model',
      payload: { success: true },
      error: null,
    })}\n`
  );

  assert.deepEqual(await promise, { success: true });
  client.dispose();
});
