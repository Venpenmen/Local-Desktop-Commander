import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';
import { createInstance,validateConfig,configStatus } from './config.mjs';

const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c3/',import.meta.url));
const id='c3-'+randomUUID().replaceAll('-','').slice(0,12);
const runner=new GeminiRunner(runtime,{id,timeout:30000});
const client=new Client({name:'c3-test',version:'1'});
const events=[];
runner.onEvent=e=>events.push(e);
test('C3 configuration validation, root isolation and status',()=>{
  const config=createInstance(runtime,id);
  assert.equal(config.accessMode,'restricted');
  assert.equal(config.toolMode,'files');
  assert.deepEqual(config.tools,['read_file']);
  assert.equal(runner.status.fileAccess.actual,null);
  assert.equal(configStatus(config,config).restartRequired,false);
  assert.equal(configStatus({...config,tools:[]},config).restartRequired,true);
  for(const bad of [{accessMode:'full'},{toolMode:'terminal'},{allowPublic:true},{terminal:true},
    {tools:['write_file']},{tools:['read_file','read_file']},{root:'C:\\Windows'}]){
    assert.throws(()=>validateConfig({...config,...bad},join(runtime,id)));
  }
});
test('C3 HTTP -> actual pinned stdio bridge, allowlist and Restricted root', {timeout:90000},async()=>{
  const initial=await runner.start();
  const root=runner.config.root;
  const marker='REAL-C3-'+randomUUID();
  const inside=join(root,'inside.txt');
  const outside=join(runner.instance,'outside.txt');
  await writeFile(inside,marker);
  await writeFile(outside,'DENY-OUTSIDE');
  const url=new URL('http://127.0.0.1:'+initial.port+'/mcp');
  try{
    const authHeaders={Authorization:'Bearer '+initial.token};
    let reply=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(reply.status,401);
    reply=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer invalid'},body:'{}'});
    assert.equal(reply.status,401);
    reply=await fetch(url,{method:'POST',headers:{...authHeaders,'Content-Type':'application/json',Origin:'https://example.com'},body:'{}'});
    assert.equal(reply.status,403);
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:authHeaders}}));
    assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['read_file']);
    const good=await client.callTool({name:'read_file',arguments:{path:inside}});
    assert.notEqual(good.isError,true,JSON.stringify({content:good.content,events}));
    assert(JSON.stringify(good.content).includes(marker));
    const bad=await client.callTool({name:'read_file',arguments:{path:outside}});
    assert.equal(bad.isError,true);
    const escape=await client.callTool({name:'read_file',arguments:{path:join(root,'..','outside.txt')}});
    assert.equal(escape.isError,true);
    const reject=await client.callTool({name:'write_file',arguments:{path:inside,content:'FAIL'}});
    assert.equal(reject.isError,true);
    assert.equal((await readFile(inside,'utf8')),marker);
    assert.equal(runner.status.fileAccess.restartRequired,false);
    assert.throws(()=>runner.setTarget({tools:['write_file']}),/STOP_BEFORE_CHANGE/);
    assert(events.some(e=>e.event==='engine-ready'&&e.toolCount===14));
  } finally {
    await client.close().catch(()=>{});
    await runner.stop();
  }
  assert.equal(runner.status.state,'stopped');
  assert.equal(runner.status.enginePid,null);
});
