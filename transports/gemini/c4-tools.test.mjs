import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';

const runtime = fileURLToPath(new URL('../../test-runtime/gemini-c4-tools/', import.meta.url));
const text = result => (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
test('C4 invoke all 21 native MCP tools with isolated harmless fixtures', { timeout: 240000 }, async () => {
  const id = 'all-' + randomUUID().replaceAll('-', '').slice(0, 12);
  const runner = new GeminiRunner(runtime, { id, timeout: 45000 });
  runner.setTarget({ accessMode: 'restricted', toolMode: 'terminal', tools: 'all',
    elevatedAcknowledged: true });
  const history = [];
  const sessions = new Set();
  const client = new Client({ name: 'gemini-c4-tool-inventory', version: '1' });
  try {
    const start = await runner.start();
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:' + start.port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + start.token } } }
    ));
    const call = async (name, args = {}, requiredSuccess = true) => {
      const answer = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      history.push({ name, isError: answer.isError === true, sample: text(answer).slice(0, 350) });
      if (requiredSuccess) assert.notEqual(answer.isError, true, name + ': ' + text(answer).slice(0, 600));
      return answer;
    };
    const marker = 'C4-TOOLS-' + randomUUID();
    const root = runner.config.root;
    const source = join(root, 'original.txt');
    const other = join(root, 'second.txt');
    const moved = join(root, 'moved.txt');
    const folder = join(root, 'subfolder');
    await writeFile(source, marker + '\nC4-SEARCH-FIXTURE\n');
    await writeFile(other, 'SECOND-' + marker);
    await call('read_file', { path: source });
    await call('read_multiple_files', { paths: [source, other] });
    await call('create_directory', { path: folder });
    const created = join(folder, 'created.txt');
    await call('write_file', { path: created, content: 'ORIGINAL-EDIT-STRING', mode: 'rewrite' });
    const edited = await call('edit_block', {
      file_path: created, old_string: 'ORIGINAL-EDIT-STRING', new_string: 'UPDATED-EDIT-STRING'
    });
    assert.equal((await readFile(created, 'utf8')).includes('UPDATED-EDIT-STRING'), true);
    await call('list_directory', { path: root, depth: 2 });
    await call('get_file_info', { path: source });
    await call('move_file', { source: other, destination: moved });
    assert((await readFile(moved, 'utf8')).includes(marker));
    const require = createRequire(fileURLToPath(new URL('../../engine/upstream/package.json', import.meta.url)));
    const { PDFDocument } = require('pdf-lib');
    const document = await PDFDocument.create();
    document.addPage(); document.addPage();
    const pdf = join(root, 'c4-original.pdf');
    const editedPdf = join(root, 'c4-edited.pdf');
    await writeFile(pdf, await document.save());
    // The fixed Local DC profile intentionally blocks Markdown -> PDF creation.
    const blockedPdf = await call('write_pdf', {
      path: join(root, 'c4-blocked.pdf'), content: '# Disabled by native profile'
    }, false);
    assert.equal(blockedPdf.isError, true);
    await call('write_pdf', { path: pdf,
      content: [{ type: 'delete', pageIndexes: [1] }], outputPath: editedPdf });
    assert.equal((await readFile(editedPdf)).subarray(0, 4).toString(), '%PDF');
    assert.equal((await PDFDocument.load(await readFile(editedPdf))).getPageCount(), 1);
    const search = await call('start_search', { path: root, pattern: 'C4-SEARCH-FIXTURE',
      searchType: 'content', filePattern: '*.txt', maxResults: 20 });
    const idMatch = text(search).match(/session\s*(?:id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i);
    assert(idMatch, 'Search session identifier missing: ' + text(search).slice(0, 600));
    const sessionId = idMatch[1];
    await call('get_more_search_results', { sessionId, offset: 0, length: 10 });
    await call('list_searches');
    await call('stop_search', { sessionId }, false);
    await call('get_usage_stats');

    const process = await call('start_process', {
      command: 'node -i', timeout_ms: 1800
    });
    const processPid = Number(text(process).match(/PID\s*[:=]?\s*(\d+)/i)?.[1]);
    assert(Number.isInteger(processPid) && processPid > 0 &&
      processPid !== process.pid && processPid !== runner.status.enginePid,
      'Owned REPL PID not found: ' + text(process).slice(0, 800));
    sessions.add(processPid);
    await call('list_processes');
    await call('list_sessions');
    const interaction = await call('interact_with_process', {
      pid: processPid, input: 'console.log("C4-INTERACT-OK")\n', timeout_ms: 3000
    });
    assert(text(interaction).includes('C4-INTERACT-OK'));
    await call('read_process_output', { pid: processPid, timeout_ms: 500 });
    await call('force_terminate', { pid: processPid });
    sessions.delete(processPid);

    const secondProcess = await call('start_process', {
      command: 'node -i', timeout_ms: 1500
    });
    const killPid = Number(text(secondProcess).match(/PID\s*[:=]?\s*(\d+)/i)?.[1]);
    assert(Number.isInteger(killPid) && killPid > 0 && killPid !== runner.status.enginePid);
    sessions.add(killPid);
    await call('kill_process', { pid: killPid });
    sessions.delete(killPid);
    assert.equal(new Set(history.map(entry => entry.name)).size, 21);
    console.log(JSON.stringify({ toolCount: 21, names: history.map(entry => entry.name),
      nonfatal: history.filter(entry => entry.isError).map(entry => entry.name) }));
  } catch (error) {
    console.error(JSON.stringify({ completed: history.length, history }, null, 2));
    throw error;
  } finally {
    for (const pid of sessions) {
      try { await client.callTool({ name: 'force_terminate', arguments: { pid } }); } catch {}
    }
    await client.close().catch(() => {});
    await runner.stop();
  }
});
