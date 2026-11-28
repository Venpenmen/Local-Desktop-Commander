import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const expectedMode = process.argv[2] ?? 'files';
assert(['files', 'terminal'].includes(expectedMode), 'Expected files or terminal');
const require = createRequire(path.join(root, 'engine/upstream/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const data = JSON.parse(await fs.readFile(path.join(root, 'engine/runtime/proxy-url.json'), 'utf8'));
const url = new URL(data.mcp_url);
assert.equal(url.hostname, '127.0.0.1');
const client = new Client({ name: 'ldc-gui-b2', version: '1.0.0' });
const checks = [];
try {
 await client.connect(new StreamableHTTPClientTransport(url));
 const response = await client.listTools();
 const count = expectedMode === 'files' ? 14 : 21;
 assert.equal(response.tools.length, count, 'unexpected tool count');
 checks.push('real MCP tool discovery ' + count);
 const names = new Set(response.tools.map(t => t.name));
 assert(names.has('list_directory'));
 if (expectedMode === 'files') assert(!names.has('start_process'));
 else assert(names.has('start_process'));
 const allowed = (await fs.readFile(path.join(root, 'engine/allowed-root.txt'), 'utf8')).trim();
 const result = await client.callTool({ name: 'list_directory', arguments: { path: allowed, depth: 1 } });
 assert.equal(result.isError ?? false, false, 'allowed root is not accessible');
 checks.push('actual allowed-root file call');
 const outside = await client.callTool({ name: 'list_directory', arguments: { path: path.join(root, 'management'), depth: 1 } });
 assert(outside.isError || /denied|allowed|not permitted|outside|拒绝|未授权|允许范围/i.test(JSON.stringify(outside.content)), 'outside-root file access was not rejected');
 checks.push('restricted file scope enforcement');
 if (expectedMode === 'terminal') {
   const command = await client.callTool({ name: 'start_process', arguments: { command: 'Write-Output LDC_GUI_B2_TERMINAL_PASS', timeout_ms: 10000 } });
   assert.equal(command.isError ?? false, false, 'terminal tool failed');
   assert(JSON.stringify(command.content).includes('LDC_GUI_B2_TERMINAL_PASS'), 'terminal output missing');
   checks.push('actual terminal execution');
 }
 console.log(JSON.stringify({ mode: expectedMode, checks, urlScheme: url.protocol }, null, 2));
} finally { await client.close(); }
