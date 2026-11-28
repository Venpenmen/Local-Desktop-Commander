import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';
import { expectedTools } from './config.mjs';

const base = fileURLToPath(new URL('../../test-runtime/gemini-c4-matrix/', import.meta.url));
const modes = [
  { accessMode: 'restricted', toolMode: 'files', count: 14 },
  { accessMode: 'restricted', toolMode: 'terminal', count: 21 },
  { accessMode: 'full', toolMode: 'files', count: 14 },
  { accessMode: 'full', toolMode: 'terminal', count: 21 }
];
for (const mode of modes) {
  test('C4 authentic native matrix ' + mode.accessMode + ' / ' + mode.toolMode,
    { timeout: 150000 }, async () => {
      const id = 'mode-' + randomUUID().replaceAll('-', '').slice(0, 12);
      const runner = new GeminiRunner(base, { id, timeout: 30000 });
      const acknowledged = mode.accessMode === 'full' || mode.toolMode === 'terminal';
      const next = runner.setTarget({
        accessMode: mode.accessMode,
        toolMode: mode.toolMode,
        tools: 'all',
        elevatedAcknowledged: acknowledged
      });
      assert.equal(next.fileAccess.target.tools.length, mode.count);
      const outside = join(runner.instance, 'outside.txt');
      const inside = join(runner.config.root, 'inside.txt');
      const value = 'C4_' + randomUUID();
      await writeFile(outside, value);
      await writeFile(inside, value);
      const client = new Client({ name: 'c4-matrix', version: '1' });
      try {
        const started = await runner.start();
        assert.equal(started.toolCount, mode.count);
        assert.equal(runner.status.fileAccess.actual.accessMode, mode.accessMode);
        assert.equal(runner.status.fileAccess.actual.toolMode, mode.toolMode);
        const endpoint = new URL('http://127.0.0.1:' + started.port + '/mcp');
        await client.connect(new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: 'Bearer ' + started.token } }
        }));
        const tools = (await client.listTools()).tools;
        assert.equal(tools.length, mode.count);
        assert.deepEqual(tools.map(item => item.name), expectedTools(mode.toolMode));
        assert('path' in tools[0].inputSchema.properties);
        assert('isUrl' in tools[0].inputSchema.properties);
        const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
        const good = await call('read_file', { path: inside });
        assert.notEqual(good.isError, true, JSON.stringify(good.content));
        assert(JSON.stringify(good.content).includes(value));
        const external = await call('read_file', { path: outside });
        assert.equal(external.isError === true, mode.accessMode === 'restricted');
        const dirname = join(runner.config.root, 'nested');
        const mkdirResult = await call('create_directory', { path: dirname });
        assert.notEqual(mkdirResult.isError, true, JSON.stringify(mkdirResult.content));
        const file = join(dirname, 'tool-written.txt');
        assert.notEqual((await call('write_file', { path: file, content: value, mode: 'rewrite' })).isError, true);
        assert.equal(await readFile(file, 'utf8'), value);
        assert.notEqual((await call('list_directory', { path: dirname, depth: 1 })).isError, true);
        const nativeModeFile = join(runner.instance, 'install', 'engine', 'access-mode.txt');
        assert.equal((await call('write_file', {
          path: nativeModeFile, content: 'full', mode: 'rewrite'
        })).isError, true);
        assert.equal((await readFile(nativeModeFile, 'utf8')).trim(), mode.accessMode);
        const linked = join(runner.config.root, 'outside-junction');
        await symlink(runner.instance, linked, 'junction');
        const indirect = await call('read_file', { path: join(linked, 'outside.txt') });
        assert.equal(indirect.isError === true, mode.accessMode === 'restricted');
        assert.equal((await call('read_file', { path: inside + ':alternate' })).isError, true);
        const denied = await call('not_a_real_tool', {});
        assert.equal(denied.isError, true);
        if (mode.toolMode === 'files') {
          const termDenied = await call('start_process', { command: 'Write-Output SHOULD_NOT_RUN', timeout_ms: 5000 });
          assert.equal(termDenied.isError, true);
        } else {
          const result = await call('start_process', { command: 'Write-Output C4-TERMINAL-OK', timeout_ms: 7000 });
          assert.notEqual(result.isError, true, JSON.stringify(result.content));
          assert(JSON.stringify(result.content).includes('C4-TERMINAL-OK'));
          if (mode.accessMode === 'restricted') {
            // Terminal mode runs under the Windows user, not the file-tool root.
            const quotedOutside = outside.replaceAll("'", "''");
            const terminalView = await call('start_process', {
              command: "Get-Content -LiteralPath '" + quotedOutside + "'",
              timeout_ms: 7000
            });
            assert.notEqual(terminalView.isError, true);
            assert(JSON.stringify(terminalView.content).includes(value));
          }
          const processes = await call('list_processes');
          assert.notEqual(processes.isError, true, JSON.stringify(processes.content));
          const sessions = await call('list_sessions');
          assert.notEqual(sessions.isError, true, JSON.stringify(sessions.content));
        }
      } finally {
        await client.close().catch(() => {});
        await runner.stop();
      }
      assert.equal(runner.status.state, 'stopped');
      assert.equal(runner.status.enginePid, null);
    });
}
