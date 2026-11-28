import {
  copyFileSync, existsSync, mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expectedTools, projectRoot, validateConfig } from './config.mjs';

const install = join(projectRoot, 'engine');
export async function createBridge(config, instance, { onEvent = () => {}, timeout = 20000, transportFactory } = {}) {
  const target = validateConfig(config, instance);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000)
    throw Error('INVALID_TIMEOUT');
  // The native engine protects its install directory against MCP file writes.
  // Place its installation under instance/install, beside the authorized workspace.
  const engineDirectory = join(instance, 'install', 'engine');
  mkdirSync(engineDirectory, { recursive: true });
  const launcher = join(engineDirectory, 'stdio.mjs');
  const pinnedLauncher = readFileSync(join(install, 'stdio.mjs'), 'utf8');
  if (!existsSync(launcher)) copyFileSync(join(install, 'stdio.mjs'), launcher);
  if (readFileSync(launcher, 'utf8') !== pinnedLauncher) throw Error('ENGINE_VERSION_MISMATCH');
  for (const component of ['upstream', 'ripgrep']) {
    const dest = join(engineDirectory, component);
    if (!existsSync(dest)) symlinkSync(join(install, component), dest, 'junction');
    if (realpathSync.native(dest).toLowerCase() !== realpathSync.native(join(install, component)).toLowerCase())
      throw Error('ENGINE_SOURCE_MISMATCH');
  }
  for (const [file, value] of [
    [join(engineDirectory, 'allowed-root.txt'), target.root],
    [join(engineDirectory, 'access-mode.txt'), target.accessMode]
  ]) writeFileSync(file, value);
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC']
      .filter(name => process.env[name]).map(name => [name, process.env[name]])
  );
  // Full mode is unavailable on the legacy local-dev tunnel, not on an explicitly
  // acknowledged isolated native stdio child. It is never network-exposed here.
  env.LOCAL_DC_TRANSPORT = target.accessMode === 'full' ? 'gemini-stdio' : 'local-dev';
  const transport = transportFactory?.() ?? new StdioClientTransport({
    command: process.execPath,
    args: [launcher, '--test-run', ...(target.terminal ? ['--terminal'] : [])],
    cwd: target.root, env, stderr: 'pipe'
  });
  const client = new Client({ name: 'ldc-gemini-adapter', version: '0.2.0' });
  try {
    await client.connect(transport, { timeout: Math.max(timeout, 12000) });
    const discovered = (await client.listTools({}, { timeout })).tools;
    const expected = expectedTools(target.toolMode);
    if (discovered.length !== expected.length ||
        new Set(discovered.map(item => item.name)).size !== expected.length ||
        expected.some(name => !discovered.some(item => item.name === name)))
      throw Error('UNEXPECTED_NATIVE_TOOL_INVENTORY');
    const allowed = discovered.filter(item => target.tools.includes(item.name));
    if (allowed.length !== target.tools.length) throw Error('ALLOWLIST_TOOL_MISSING');
    let closed = false;
    let queue = Promise.resolve();
    const call = async (name, args = {}, { deadlineMs = timeout } = {}) => {
      if (closed) throw Error('BRIDGE_CLOSED');
      if (!target.tools.includes(name)) throw Error('TOOL_NOT_ALLOWED');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('INVALID_ARGUMENTS');
      if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > timeout)
        throw Error('INVALID_CALL_DEADLINE');
      const job = queue.then(() => client.callTool({ name, arguments: args }, undefined,
        { timeout: deadlineMs }));
      queue = job.then(() => {}, () => {});
      return job;
    };
    onEvent({
      event: 'engine-ready', pid: transport.pid, toolCount: discovered.length,
      exposed: allowed.map(item => item.name), accessMode: target.accessMode, toolMode: target.toolMode
    });
    return {
      instance, config: target, pid: transport.pid,
      toolList: () => allowed.map(item => structuredClone(item)), call,
      async close() {
        if (closed) return;
        closed = true;
        await client.close();
        onEvent({ event: 'engine-closed' });
      }
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
