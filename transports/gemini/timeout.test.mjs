import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';

const base=fileURLToPath(new URL('../../test-runtime/gemini-c3-timeout/',import.meta.url));
test('C3 HTTP and stdio timeout: MCP request waits longer than configured timeout', {timeout:45000},async()=>{
  const runner=new GeminiRunner(base,{id:'delay-'+randomUUID().replaceAll('-','').slice(0,12),timeout:200});
  const started=await runner.start();
  const app=new Client({name:'delay-test',version:'1'});
  try{
    await app.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+started.port+'/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+started.token}}}));
    const oldCall=runner.bridge.call;
    runner.bridge.call=async(...args)=>new Promise(resolve=>setTimeout(()=>resolve(oldCall(...args)),700));
    const target=join(runner.config.root,'delayed.txt');
    const fs=await import('node:fs/promises');
    await fs.writeFile(target,'delay');
    const t=Date.now();
    const result=await app.callTool({name:'read_file',arguments:{path:target}},undefined,{timeout:5000});
    assert.equal(result.isError,true,'Delayed request did not fail under gateway limits');
    assert(Date.now()-t<5000);
  }finally{await app.close().catch(()=>{});await runner.stop();}
});
