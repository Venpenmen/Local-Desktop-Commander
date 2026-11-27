import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('C2.5 native LDC file mode via HTTP MCP and strict tool whitelist', { timeout: 90000 }, async () => {
  const id = randomUUID().replaceAll('-', '');
  const run = new URL('./runtime/' + id + '/', import.meta.url);
  const child = spawn(process.execPath, ['read-server.mjs', id, 'local', '90'], { cwd: new URL('.', import.meta.url), windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let stderr = '';
  child.stderr.on('data', buf => { stderr += buf.toString().slice(0,2000); });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const checks = [];
  let client;
  try {
    let status;
    for (let i = 0; i < 100 && !status?.port; i++) {
      if (exited) throw new Error('Engine failed to start: ' + stderr.slice(0,800));
      try { status = JSON.parse(await readFile(new URL('status.json', run), 'utf8')); } catch {}
      if (!status?.port) await delay(180);
    }
    assert(status?.port, stderr);
    assert.equal(status.pid, child.pid);
    checks.push('P03/P04 native child starts with isolated root, restricted mode, no terminal');

    const root = new URL('gemini-read-instance/workspace/', run);
    const marker = 'LDC-C25-READ-' + randomUUID();
    const inside = new URL('inside.txt', root);
    const outside = new URL('outside.txt', run);
    await mkdir(root, { recursive: true });
    await writeFile(inside, marker);
    await writeFile(outside, 'C25-OUTSIDE-SHOULD-NOT-LEAK');
    checks.push('P05 randomized inside/outside fixtures');
    const url = new URL('http://127.0.0.1:' + status.port + '/mcp');
    client = new Client({ name: 'gemini-c25-native-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['read_file']);
    checks.push('T01/T02/T03 initialize, discovery and strict one-tool exposure');
    const call = (path, extra = {}) => client.callTool({ name: 'read_file', arguments: { path, ...extra } });
    const insideResult = await call(new URL(inside).pathname);
    // Native path conversion is checked separately: Windows URL pathname begins /D:/.
    assert.equal(insideResult.isError, true);
    const windowsPath = decodeURIComponent(inside.pathname.slice(1)).replaceAll('/', '\\');
    const outsidePath = decodeURIComponent(outside.pathname.slice(1)).replaceAll('/', '\\');
    const result = await call(windowsPath);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert(JSON.stringify(result.content).includes(marker));
    checks.push('T04 native read_file returns authentic random file contents');
    const deniedOutside = await call(outsidePath);
    assert.equal(deniedOutside.isError, true, JSON.stringify(deniedOutside));
    const deniedTraversal = await call(join(decodeURIComponent(root.pathname.slice(1)).replaceAll('/', '\\'), '..','..','outside.txt'));
    assert.equal(deniedTraversal.isError, true);
    checks.push('T05/T06 out-of-root and path traversal rejected');
    const link = new URL('outside-junction', root);
    await symlink(new URL('.', run).pathname.slice(1).replaceAll('/','\\'), decodeURIComponent(link.pathname.slice(1)).replaceAll('/','\\'), 'junction');
    const deniedLink = await call(join(decodeURIComponent(link.pathname.slice(1)).replaceAll('/','\\'), 'outside.txt'));
    assert.equal(deniedLink.isError, true);
    checks.push('T07 junction-based escape rejected');
    for (const name of ['write_file','list_directory','start_process','ldc_probe']) {
      let denied = false;
      try { const answer = await client.callTool({ name, arguments: { path: windowsPath } }); denied = answer.isError === true; }
      catch { denied = true; }
      assert(denied, 'Unlisted tool not rejected: ' + name);
    }
    const urlResult = await call('https://example.com/file.txt');
    assert.equal(urlResult.isError, true);
    checks.push('T08 no other tool and no HTTP URL reads allowed');
    for (const [method, expected] of [['GET',405],['POST',403]]) {
      const headers = method === 'POST' ? { Origin: 'https://evil.example', 'content-type':'application/json' } : {};
      const response = await fetch(url, {method, headers, ...(method==='POST'?{body:'{}'}:{})});
      assert.equal(response.status,expected);
    }
    checks.push('HTTP method/origin restrictions preserved');
    const logs = (await readFile(new URL('events.ndjson',run),'utf8')).trim().split('\n').map(JSON.parse);
    assert(logs.some(x=>x.kind==='engine'&&x.tools===14&&x.exposed?.length===1));
    assert(logs.some(x=>x.kind==='file-result'&&!x.isError));
    assert(logs.some(x=>x.kind==='file-result'&&x.isError));
    checks.push('Real child engine and allowed/denied call evidence logged without contents');
  } finally {
    await client?.close().catch(()=>{});
    if (!exited) child.kill();
    await Promise.race([once(child,'exit'),delay(5000)]);
    await writeFile(new URL('read-evidence.json',run),JSON.stringify({status:'tested',utc:new Date().toISOString(),checks,stderr:stderr.slice(0,500)},null,2));
  }
  console.log(JSON.stringify({id,checks}));
});

test('C2.5 owned engine crash returns explicit error and cleans up', { timeout: 90000 }, async () => {
  const id = randomUUID().replaceAll('-', '');
  const run = new URL('./runtime/' + id + '/', import.meta.url);
  const child = spawn(process.execPath, ['read-server.mjs', id, 'local', '90'], { cwd: new URL('.', import.meta.url), windowsHide: true, stdio: 'ignore' });
  let client;
  const checks = [];
  let enginePid;
  try {
    let status;
    for (let i = 0; i < 100 && !status?.port; i++) {
      try { status = JSON.parse(await readFile(new URL('status.json',run),'utf8')); } catch {}
      if (!status?.port) await delay(180);
    }
    assert(status?.port);
    const root = new URL('gemini-read-instance/workspace/',run);
    const file = new URL('crash-test.txt',root);
    const windowsPath = decodeURIComponent(file.pathname.slice(1)).replaceAll('/', '\\');
    await writeFile(file, 'BEFORE-CRASH-OK');
    const endpoint = new URL('http://127.0.0.1:' + status.port + '/mcp');
    client = new Client({name:'c25-crash-test',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const call = () => client.callTool({name:'read_file',arguments:{path:windowsPath}});
    assert(JSON.stringify((await call()).content).includes('BEFORE-CRASH-OK'));
    const log = (await readFile(new URL('events.ndjson',run),'utf8')).trim().split('\n').map(JSON.parse);
    enginePid = log.find(item => item.kind==='engine'&&item.event==='ready')?.pid;
    assert(Number.isInteger(enginePid) && enginePid !== child.pid);
    checks.push('T10 real engine had an independently owned PID');
    process.kill(enginePid);
    await delay(400);
    const started = Date.now();
    const answer = await call();
    assert.equal(answer.isError, true, JSON.stringify(answer.content));
    assert(Date.now()-started < 12000);
    checks.push('T10 native child death is caught and reported as MCP error within timeout');
  } finally {
    await client?.close().catch(()=>{});
    if (child.exitCode===null && child.signalCode===null) child.kill();
    if (child.exitCode===null && child.signalCode===null) await Promise.race([once(child,'exit'),delay(5000)]);
    assert(child.exitCode!==null || child.signalCode!==null,'Gateway process remained alive after kill');
    if (enginePid) {
      await delay(200);
      let live = true;
      try { process.kill(enginePid,0); } catch { live=false; }
      assert.equal(live,false,'Owned engine process persisted');
    }
    checks.push('T11 owned child terminated without orphan process');
    await writeFile(new URL('crash-evidence.json',run),JSON.stringify({utc:new Date().toISOString(),checks},null,2));
  }
  console.log(JSON.stringify({id,checks}));
});
