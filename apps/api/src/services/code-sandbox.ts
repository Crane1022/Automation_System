import { spawn } from 'node:child_process';

/**
 * Runs user JavaScript for the Code Execution node.
 *
 * Isolation layers:
 *  1. A separate, short-lived Node process per run (crash/loop/memory never hits the worker).
 *  2. Node's permission model: no file system, no child processes, no worker threads, no addons.
 *  3. --disallow-code-generation-from-strings + a vm context with codeGeneration disabled,
 *     which blocks the usual `this.constructor.constructor("return process")` escape.
 *  4. Inside the child, before user code runs, the host realm loses require/process
 *     module loaders and network globals (fetch, WebSocket…).
 *  5. Memory cap (--max-old-space-size), CPU time limit (vm timeout) and a hard kill timer.
 *  6. Input/output are JSON only, output size is capped.
 *
 * Remaining risk (documented): this is defence in depth, not a VM boundary.
 * Only IT Admins / Super Admins may write Code nodes, and production workers
 * should run in a container with restricted outbound network.
 */

const RUNNER = String.raw`
'use strict';
const vm = require('node:vm');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const send = (obj) => process.stdout.write(JSON.stringify(obj));
  let job;
  try { job = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send({ error: 'Bad input' }); }

  // Strip powerful host capabilities before any user code exists.
  for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'require', 'module', 'exports', '__filename', '__dirname']) {
    try { delete globalThis[k]; } catch {}
  }
  for (const k of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'mainModule', 'chdir', 'kill', 'env']) {
    try { Object.defineProperty(process, k, { value: undefined, configurable: false }); } catch {}
  }

  const sandbox = Object.create(null);
  sandbox.items = JSON.parse(JSON.stringify(job.input));
  sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, name: 'code-node' });
  try {
    const script = new vm.Script('(async () => {\n' + job.code + '\n})()', { filename: 'code-node.js' });
    const result = await script.runInContext(context, { timeout: job.timeoutMs, breakOnSigint: true });
    const text = JSON.stringify(result === undefined ? null : result);
    if (text && text.length > job.maxOutput) return send({ error: 'Output is too large (' + text.length + ' bytes)' });
    process.stdout.write('{"ok":true,"result":' + (text ?? 'null') + '}');
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const line = e && e.stack ? (String(e.stack).match(/code-node\.js:(\d+)/) || [])[1] : undefined;
    send({ error: msg, line: line ? Number(line) - 1 : undefined });
  }
});
`;

export interface SandboxOptions {
  memoryMb: number;
  /** Time zone for `new Date()` inside code (e.g. "Asia/Kuala_Lumpur"). */
  timezone?: string;
  maxOutputBytes?: number;
}

export class CodeError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
  }
}

function permissionFlags(): string[] {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return ['--permission'];
  if (flags.has('--experimental-permission')) return ['--experimental-permission'];
  return [];
}

export function createCodeSandbox(opts: SandboxOptions) {
  const maxOutput = opts.maxOutputBytes ?? 5 * 1024 * 1024;
  const perm = permissionFlags();
  if (!perm.length) console.warn('[sandbox] Node permission model unavailable — upgrade to Node 22+ for full Code node isolation');

  return function runCode(code: string, input: unknown, run: { timeoutMs: number; signal: AbortSignal }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (run.signal.aborted) return reject(new CodeError('Cancelled'));
      const child = spawn(
        process.execPath,
        [...perm, `--max-old-space-size=${opts.memoryMb}`, '--disallow-code-generation-from-strings', '--no-warnings', '-e', RUNNER],
        // No secrets reach the child: empty environment (Windows needs SystemRoot to start a process).
        { stdio: ['pipe', 'pipe', 'pipe'], env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(opts.timezone ? { TZ: opts.timezone } : {}) }, windowsHide: true },
      );
      let out = '';
      let err = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(killer);
        run.signal.removeEventListener('abort', onAbort);
        fn();
      };
      // Hard stop: vm timeout covers sync loops; this also covers async never-ending code.
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new CodeError(`Code took longer than ${run.timeoutMs} ms`)));
      }, run.timeoutMs + 1000);
      const onAbort = () => {
        child.kill('SIGKILL');
        finish(() => reject(new CodeError('Cancelled')));
      };
      run.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        if (out.length > maxOutput + 1024) {
          child.kill('SIGKILL');
          finish(() => reject(new CodeError('Output is too large')));
        }
      });
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')).slice(0, 4000));
      child.on('error', (e) => finish(() => reject(new CodeError(`Could not start sandbox: ${e.message}`))));
      child.on('close', (codeNum) => {
        finish(() => {
          if (!out) {
            const oom = /heap out of memory|Allocation failed/i.test(err);
            if (oom) return reject(new CodeError(`Code used more than ${opts.memoryMb} MB of memory`));
            if (codeNum === 0) return reject(new CodeError('Code finished without returning — something it awaited never completed (timers and network are not available)'));
            return reject(new CodeError(`Sandbox exited (${codeNum})${err ? ': ' + err.split('\n')[0] : ''}`));
          }
          let msg: any;
          try {
            msg = JSON.parse(out);
          } catch {
            return reject(new CodeError('Sandbox returned invalid data'));
          }
          if (msg.ok) return resolve(msg.result);
          const timeout = /Script execution timed out/.test(msg.error);
          reject(new CodeError(timeout ? `Code took longer than ${run.timeoutMs} ms` : msg.error, msg.line));
        });
      });
      child.stdin.end(JSON.stringify({ code, input, timeoutMs: run.timeoutMs, maxOutput }));
    });
  };
}
