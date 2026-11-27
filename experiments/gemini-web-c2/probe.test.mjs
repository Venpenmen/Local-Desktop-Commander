import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('probe MCP protocol, isolation and limits', async () => {
  const external = process.env.LDC_C2_TEST_URL;
  const run = external ? process.env.LDC_C2_RUN : randomUUID().replaceAll('-', '');
  assert.match(run, /^[a-f0-9]{32}$/);
  const root = new URL('./runtime/' + run + '/', import.meta.url);
  const path = new URL('status.json', root);
  const child = external ? null : spawn(process.execPath, ['probe.mjs', run, 'local', '60'], { windowsHide: true });
  const exit = child && once(child, 'exit');
  const client = new Client({ name: 'ldc-codex-self-test', version: '1.0.0' });
  const checks = [];
  try {
    let state;
    for (let i = 0; i < 60 && !state?.port; i++) {
      try { state = JSON.parse(await readFile(path, 'utf8')); } catch {}
      if (!state?.port) await delay(150);
    }
    assert(state?.port);
    if (child) assert.equal(state.pid, child.pid);
    const url = new URL(external || 'http://127.0.0.1:' + state.port + '/mcp');
    const headers = { 'x-ldc-probe-test': 'codex', 'Content-Type': 'application/json' };
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ldc_probe']);
    const challenge = 'SELF-' + randomUUID();
    const call = value => client.callTool({ name: 'ldc_probe', arguments: { challenge: value } });
    const first = (await call(challenge)).structuredContent;
    const second = (await call(challenge)).structuredContent;
    assert.equal(first.challenge, challenge);
    assert.match(first.nonce, /^[a-f0-9-]{36}$/);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.callId, second.callId);
    assert(Number.isFinite(Date.parse(first.utc)));
    assert.equal((await call('x'.repeat(97))).isError, true);
    assert.equal((await client.callTool({ name: 'read_file', arguments: {} })).isError, true);
    const logs = (await readFile(new URL('events.ndjson', root), 'utf8')).trim().split('\n').map(JSON.parse);
    assert(logs.some(event => event.method === 'initialize' && event.protocol));
    assert(logs.some(event => event.method === 'notifications/initialized'));
    assert(logs.some(event => event.method === 'tools/list'));
    assert(logs.some(event => event.source === 'self-test' && event.callId === first.callId &&
      event.nonce === first.nonce && event.challengeHash === createHash('sha256').update(challenge).digest('hex')));
    checks.push('SDK initialize, notification, discovery, random nonce, schema and matching log');
    assert.equal((await fetch(new URL('/other', url), { headers })).status, 404);
    assert.equal((await fetch(url, { headers })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(4100) })).status, 413);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{}' })).status, 403);
    checks.push('route, method, size, malformed JSON and Origin rejection');
    if (!external) {
      const statuses = await Promise.all(Array.from({ length: 48 }, () =>
        fetch(url, { method: 'POST', headers, body: '{}' }).then(async res => { await res.text(); return res.status; })));
      assert(statuses.includes(429));
      checks.push('rate budget');
    }
  } finally {
    await client.close();
    if (child && child.exitCode === null) child.kill();
    if (exit) {
      await exit;
      if (checks.length === 3) checks.push('isolated test process stopped');
    }
    await writeFile(new URL('self-test.json', root), JSON.stringify({ utc: new Date().toISOString(), checks }, null, 2));
    console.log(JSON.stringify({ run, checks }));
  }
});
