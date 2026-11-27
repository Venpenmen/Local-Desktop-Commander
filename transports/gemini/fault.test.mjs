import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridge } from './bridge.mjs';
import { createInstance } from './config.mjs';
import { GeminiRunner } from './runner.mjs';

const base=fileURLToPath(new URL('../../test-runtime/gemini-c3-fault/',import.meta.url));
test('C3 engine crash surfaced and restart clean', {timeout:80000},async()=>{
  const id='crash-'+randomUUID().replaceAll('-','').slice(0,12);
  const runner=new GeminiRunner(base,{id,timeout:3000});
  const started=await runner.start();
  const pid=runner.status.enginePid;
  assert(Number.isInteger(pid));
  const file=join(runner.config.root,'crash.txt');
  await writeFile(file,'CRASH-FIXTURE');
  const client=new Client({name:'c3-fault',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+started.port+'/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+started.token}}}));
    process.kill(pid);
    await new Promise(resolve=>setTimeout(resolve,300));
    const outcome=await client.callTool({name:'read_file',arguments:{path:file}});
    assert.equal(outcome.isError,true);
  }finally{await client.close().catch(()=>{});await runner.stop();}
  const restarted=await runner.start();
  assert.notEqual(runner.status.enginePid,pid);
  await runner.stop();
  assert.equal(runner.status.state,'stopped');
});
