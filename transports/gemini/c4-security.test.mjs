import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GeminiRunner } from './runner.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateRoot } from './config.mjs';

const runtime = fileURLToPath(new URL('../../test-runtime/gemini-c4-security/', import.meta.url));
const ident = prefix => prefix + randomUUID().replaceAll('-', '').slice(0, 12);
test('C4 settings authorization, root safety and persistently validated configuration', {timeout:50000},async()=>{
  const id=ident('config-');
  const runner=new GeminiRunner(runtime,{id});
  const outside=join(runtime,'valid-root-'+id);
  await mkdir(outside,{recursive:true});
  assert.equal(validateRoot(outside).toLowerCase(),outside.toLowerCase());
  for(const invalid of ['D:relative','\\\\localhost\\share','https://example.org','D:\\missing-'+id]){
    assert.throws(()=>validateRoot(invalid),/INVALID_ROOT/);
  }
  const link=join(runner.instance,'junction-root');
  await symlink(outside,link,'junction');
  assert.throws(()=>validateRoot(link),/INVALID_ROOT/);
  assert.throws(()=>runner.setTarget({accessMode:'full',tools:'all'}),/ELEVATED_CONFIRMATION_REQUIRED/);
  assert.throws(()=>runner.setTarget({toolMode:'terminal',tools:'all'}),/ELEVATED_CONFIRMATION_REQUIRED/);
  assert.throws(()=>runner.setTarget({tools:['write_file','write_file']}),/INVALID_TOOLS/);
  const current=runner.setTarget({root:outside,tools:'all'});
  assert.equal(current.fileAccess.target.tools.length,14);
  assert.equal(current.fileAccess.target.root.toLowerCase(),outside.toLowerCase());
  const afterRestart=new GeminiRunner(runtime,{id});
  assert.deepEqual(afterRestart.config.tools,runner.config.tools);
  assert.equal(afterRestart.config.root.toLowerCase(),outside.toLowerCase());
  assert.equal(afterRestart.status.fileAccess.target.accessMode,'restricted');
  const allowed=join(outside,'permitted.txt');
  const denied=join(runner.instance,'workspace','no-longer-allowed.txt');
  await writeFile(allowed,'EXTERNAL_ROOT_ALLOWED');
  await writeFile(denied,'OLD_ROOT_DENIED');
  const live=await afterRestart.start();
  const client=new Client({name:'c4-custom-root',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+live.port+'/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+live.token}}}));
    const call=path=>client.callTool({name:'read_file',arguments:{path}});
    assert.notEqual((await call(allowed)).isError,true);
    assert.equal((await call(denied)).isError,true);
  }finally{await client.close().catch(()=>{});await afterRestart.stop();}
});
test('C4 per-instance ownership lock, crash recovery and token revocation', {timeout:90000},async()=>{
  const id=ident('owner-');
  const first=new GeminiRunner(runtime,{id,timeout:30000});
  const start=await first.start();
  const contender=new GeminiRunner(runtime,{id,timeout:30000});
  try{
    await assert.rejects(()=>contender.start(),/INSTANCE_BUSY/);
    assert.equal(first.status.state,'running');
    assert.throws(()=>first.setTarget({tools:'all'}),/STOP_BEFORE_CHANGE/);
  }finally{await first.stop();}
  const restarted=await contender.start();
  try {
    assert.notEqual(start.token,restarted.token);
    const reply=await fetch('http://127.0.0.1:'+restarted.port+'/mcp',{
      method:'POST',headers:{Authorization:'Bearer '+start.token,'Content-Type':'application/json'},body:'{}'
    });
    assert.equal(reply.status,401);
  }finally{await contender.stop();}
  const deadId=ident('stale-');
  const recovered=new GeminiRunner(runtime,{id:deadId,timeout:30000});
  await writeFile(recovered.lockFile,JSON.stringify({pid:2147480000,nonce:randomUUID()}));
  const afterCrash=await recovered.start();
  try {
    assert.equal(recovered.recoveredFromInterrupted,true);
    assert.equal(afterCrash.state,'running');
  }finally{await recovered.stop();}
});
test('C4 loopback gateway rejects unauthenticated, cross-origin and oversized tool requests', {timeout:50000},async()=>{
  const id=ident('http-');
  const runner=new GeminiRunner(runtime,{id,timeout:30000});
  const opened=await runner.start();
  try{
    const url='http://127.0.0.1:'+opened.port+'/mcp';
    const body='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
    for(const bearer of [undefined,'Bearer INVALID','Bearer '+'0'.repeat(64)]){
      const headers={'Content-Type':'application/json'};
      if(bearer)headers.Authorization=bearer;
      const response=await fetch(url,{method:'POST',headers,body});
      assert.equal(response.status,401);
    }
    assert.equal((await fetch(url,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+opened.token,
      'Origin':'https://untrusted.example'
    },body})).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+opened.token
    },body:' '.repeat(4*1024*1024+1)})).status,413);
    assert.equal((await fetch(url,{method:'GET',headers:{
      'Authorization':'Bearer '+opened.token
    }})).status,405);
    assert.equal((await fetch(url,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+opened.token
    },body:'{invalid'})).status,400);
    await assert.rejects(async()=>{
      const {createGateway}=await import('./gateway.mjs');
      await createGateway(runner.bridge,{host:'0.0.0.0'});
    },/LOOPBACK_ONLY/);
  }finally{await runner.stop();}
});
