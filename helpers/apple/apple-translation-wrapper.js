/**
 * Apple Translation Framework wrapper script.
 *
 * This script acts as a bridge between the Mailspring renderer process (which runs
 * under macOS seatbelt sandbox) and the native Swift binary. Since Node.js is signed
 * by Apple, the sandbox allows spawning `node`, and this script in turn spawns the
 * Swift binary and proxies stdin/stdout between them.
 *
 * The wrapper reads complete JSON lines from stdin and forwards them to the child,
 * keeping stdin open so the child can process requests continuously.
 *
 * Usage: node apple-translation-wrapper.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// Resolve the native binary path (same directory as this script)
const binPath = path.join(__dirname, 'bin', 'apple-translator-darwin-universal');

// Spawn the native Swift binary
const child = spawn(binPath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

// Read stdin line by line and forward to child
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString('utf8');
  const lines = stdinBuffer.split('\n');
  // Keep the last incomplete line in the buffer
  stdinBuffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && child.stdin.writable) {
      child.stdin.write(trimmed + '\n');
    }
  }
});

// When stdin ends (renderer closes the pipe), close child stdin
process.stdin.on('end', () => {
  // Flush any remaining data
  if (stdinBuffer.trim() && child.stdin.writable) {
    child.stdin.write(stdinBuffer.trim() + '\n');
  }
  child.stdin.end();
});

// Proxy stdout from child process to renderer
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
});

// Forward stderr from child process
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

// Handle child process exit
child.on('exit', (code, signal) => {
  if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGHUP') {
    process.exit(code || 1);
  }
  process.exit(0);
});

// Handle errors
child.on('error', (err) => {
  process.stderr.write(`Wrapper error: ${err.message}\n`);
  process.exit(1);
});

// Forward termination signals
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
process.on('SIGINT', () => {
  child.kill('SIGINT');
});
