import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';

const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c3-isolation/',import.meta.url));
test('C3 two separate native engines cannot read each other fixtures', {timeout:80000},async()=>{
  const suffix=randomUUID().replaceAll('-','').slice(0,9);
  const a=new GeminiRunner(runtime,{id:'geminia-'+suffix,timeout:30000});
  const b=new GeminiRunner(runtime,{id:'geminib-'+suffix,timeout:30000});
  let x,y;
  const clientA=new Client({name:'iso-a',version:'1'});
  const clientB=new Client({name:'iso-b',version:'1'});
  try{
    x=await a.start();y=await b.start();
    assert.notEqual(a.status.enginePid,b.status.enginePid);
    assert.notEqual(x.port,y.port);
    assert.notEqual(x.token,y.token);
    const own=join(a.config.root,'private-a.txt');
    const foreign=join(b.config.root,'private-b.txt');
    await writeFile(own,'INSTANCE-A');
    await writeFile(foreign,'INSTANCE-B');
    const connect=(client,port,token)=>client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    await Promise.all([connect(clientA,x.port,x.token),connect(clientB,y.port,y.token)]);
    const call=(c,path)=>c.callTool({name:'read_file',arguments:{path}});
    assert.notEqual((await call(clientA,own)).isError,true);
    assert.notEqual((await call(clientB,foreign)).isError,true);
    assert.equal((await call(clientA,foreign)).isError,true);
    assert.equal((await call(clientB,own)).isError,true);
    const wrong=await fetch('http://127.0.0.1:'+x.port+'/mcp',{
      method:'POST',headers:{Authorization:'Bearer '+y.token,'Content-Type':'application/json'},body:'{}'});
    assert.equal(wrong.status,401);
    await a.stop();
    assert.equal(b.status.state,'running');
    assert.notEqual((await call(clientB,foreign)).isError,true);
  }finally{
    await clientA.close().catch(()=>{});await clientB.close().catch(()=>{});
    await a.stop().catch(()=>{});await b.stop().catch(()=>{});
  }
});
