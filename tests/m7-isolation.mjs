import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const roots = process.argv.slice(2);
const gui = path.resolve(roots[0] ?? path.join(source, '..', 'LocalDC-M7-GUI'));
const gemini = path.resolve(roots[1] ?? path.join(source, '..', 'LocalDC-M7-Gemini'));
assert.notEqual(gui.toLowerCase(), gemini.toLowerCase());
const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const stamp = Date.now();
const cases = [];
const launched = new Set();

async function rpc(root, operation, args, instance) {
  const options = { cwd: root, windowsHide: true, timeout: 45000 };
  const run = exec(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'management/LDC-CLI.ps1')], options);
  run.child.stdin.end(JSON.stringify({ protocol: 1, id: 'isolation', operation, arguments: args, instance }) + '\n');
  const { stdout } = await run.catch(error => {
    if (error.code !== 1) throw error;
    return error;
  });
  return JSON.parse(stdout);
}
async function result(root, operation, args, instance) {
  const reply = await rpc(root, operation, args, instance);
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result;
}
async function ready(root, key) {
  for (let i = 0; i < 15; i++) {
    const state = await result(root, 'state', null, key);
    if (state.readiness.local && state.transports[0].health.Complete) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail('Local MCP discovery timed out');
}
async function changeRoot(root, expected, current) {
  const target = path.join(root, 'engine/workspace', 'isolation-' + stamp);
  await fs.mkdir(target);
  await result(root, 'root.set', {
    version: current.configuration.target.version, path: target, revision: current.configuration.revision, confirmed: true,
  }, expected);
  return target;
}
const require = createRequire(path.join(gui, 'engine/upstream/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
async function connect(root) {
  const data = JSON.parse(await fs.readFile(path.join(root, 'engine/runtime/proxy-url.json'), 'utf8'));
  const url = new URL(data.mcp_url);
  assert.equal(url.hostname, '127.0.0.1');
  const client = new Client({ name: 'm7-isolation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  const health = new URL((await fs.readFile(path.join(root, 'engine/runtime/health.url'), 'utf8')).trim());
  return { client, port: url.port, healthPort: health.port };
}

let guiState;
let geminiState;
const changed = new Map();
try {
  [guiState, geminiState] = await Promise.all([result(gui, 'state'), result(gemini, 'state')]);
  const first = guiState.instance.key;
  const second = geminiState.instance.key;
  assert.equal(guiState.instance.id, 'gui');
  assert.equal(geminiState.instance.id, 'gemini');
  assert.equal(guiState.instance.transport, 'local-dev');
  assert.equal(geminiState.instance.transport, 'local-dev');
  assert.equal(guiState.actual.state, 'stopped');
  assert.equal(geminiState.actual.state, 'stopped');
  assert.notEqual(first, second);
  assert.equal((await rpc(gui, 'stop', { confirmed: true }, second)).error.code, 'INSTANCE_MISMATCH');
  assert.equal((await rpc(gemini, 'diagnose', null, second)).error.code, 'UNSUPPORTED_ON_INSTANCE');

  const targetA = await changeRoot(gui, first, guiState);
  changed.set(gui, guiState);
  assert.equal((await result(gemini, 'config.get')).revision, geminiState.configuration.revision);
  const targetB = await changeRoot(gemini, second, geminiState);
  changed.set(gemini, geminiState);
  const attempt = await rpc(gui, 'root.set', { version: 'p6', path: targetB, confirmed: true,
    revision: (await result(gui, 'config.get')).revision }, first);
  assert.equal(attempt.ok, false);
  assert.equal((await result(gui, 'config.get')).roots.p6, targetA);
  cases.push('independent configuration and cross-instance request/root rejection');

  async function start(root, key) {
    launched.add(root);
    await result(root, 'start', { confirmed: true }, key);
    return ready(root, key);
  }
  async function stop(root, key) {
    await result(root, 'stop', { confirmed: true }, key);
    assert.equal((await result(root, 'state', null, key)).actual.state, 'stopped');
    launched.delete(root);
  }
  const [a, b] = await Promise.all([start(gui, first), start(gemini, second)]);
  assert.notEqual(a.actual.pid, b.actual.pid);
  const [left, right] = await Promise.all([connect(gui), connect(gemini)]);
  try {
    assert.notEqual(left.port, right.port);
    assert.notEqual(left.healthPort, right.healthPort);
    const args = target => ({ name: 'list_directory', arguments: { path: target, depth: 1 } });
    assert.equal((await left.client.callTool(args(targetA))).isError, undefined);
    assert.equal((await right.client.callTool(args(targetB))).isError, undefined);
    const cross = await left.client.callTool(args(targetB));
    assert(cross.isError || /denied|allowed|not permitted|outside/i.test(JSON.stringify(cross.content)));
  } finally {
    await Promise.all([left.client.close(), right.client.close()]);
  }
  cases.push('concurrent real MCP instances, separate PIDs, ports, and file scope');

  await stop(gui, first);
  assert.equal((await ready(gemini, second)).actual.pid, b.actual.pid);
  const restarted = await start(gui, first);
  await stop(gemini, second);
  assert.equal((await ready(gui, first)).actual.pid, restarted.actual.pid);
  await stop(gui, first);
  cases.push('stopping either instance leaves the other ready');
} finally {
  for (const root of launched) {
    await result(root, 'stop', { confirmed: true }, root === gui ? guiState.instance.key : geminiState.instance.key);
  }
  for (const [root, initial] of changed) {
    const config = await result(root, 'config.get');
    const version = initial.configuration.target.version;
    await result(root, 'root.set', { version, path: initial.configuration.roots[version],
      revision: config.revision, confirmed: true }, initial.instance.key);
  }
  const report = { utc: new Date().toISOString(), cases };
  const output = path.join(source, 'test-runtime');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'm7-isolation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
