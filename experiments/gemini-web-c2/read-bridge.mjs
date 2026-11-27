import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const experiment = dirname(fileURLToPath(import.meta.url));
const project = resolve(experiment, '..', '..');
const original = join(project, 'engine');
const instanceName = 'gemini-read-instance';

export async function startReadBridge(runtime, log = () => {}) {
  const instance = join(runtime, instanceName);
  const root = join(instance, 'workspace');
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(instance, 'stdio.mjs'))) copyFileSync(join(original, 'stdio.mjs'), join(instance, 'stdio.mjs'));
  if (!existsSync(join(instance, 'upstream'))) symlinkSync(join(original, 'upstream'), join(instance, 'upstream'), 'junction');
  if (!existsSync(join(instance, 'ripgrep'))) symlinkSync(join(original, 'ripgrep'), join(instance, 'ripgrep'), 'junction');
  const configured = join(instance, 'allowed-root.txt');
  const mode = join(instance, 'access-mode.txt');
  if (existsSync(configured) && readFileSync(configured, 'utf8').trim().toLowerCase() !== root.toLowerCase()) {
    throw new Error('The existing Gemini test instance has a different allowed root');
  }
  if (existsSync(mode) && readFileSync(mode, 'utf8').trim() !== 'restricted') {
    throw new Error('The Gemini test instance must remain restricted');
  }
  writeFileSync(configured, root);
  writeFileSync(mode, 'restricted');
  const childEnvironment = Object.fromEntries(
    ['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC'].filter(k => process.env[k])
      .map(k => [k, process.env[k]]));
  childEnvironment.LOCAL_DC_TRANSPORT = 'local-dev';
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(instance, 'stdio.mjs'), '--test-run'],
    cwd: root, env: childEnvironment, stderr: 'pipe'
  });
  const client = new Client({ name: 'ldc-gemini-read-bridge', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: 20000 });
    const tools = (await client.listTools({}, { timeout: 10000 })).tools;
    if (!tools.some(tool => tool.name === 'read_file') || tools.length !== 14) {
      throw new Error('Unexpected LDC file-only tool inventory');
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  let closed = false;
  log({kind: 'engine', event: 'ready', pid: transport.pid, allowedRoot: 'private-isolated-fixture', tools: 14, exposed: ['read_file']});
  return {
    root,
    instance,
    enginePid: transport.pid,
    async read(path, offset, length) {
      if (closed) throw new Error('Engine is closed');
      if (typeof path !== 'string' || path.length > 512 || /^\w+:\/\//i.test(path)) throw new Error('Invalid file path');
      const args = { path, isUrl: false };
      if (offset !== undefined) args.offset = offset;
      if (length !== undefined) args.length = length;
      return await client.callTool({ name: 'read_file', arguments: args }, undefined, { timeout: 10000 });
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    }
  };
}
