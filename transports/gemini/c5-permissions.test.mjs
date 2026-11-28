import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GeminiRunner} from './runner.mjs';
import {authorizeInTest} from './oauth-fixtures.mjs';
const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c5-modes/',import.meta.url));
const issuer='https://ldc-gemini-c5-mode.example.invalid';
const id=()=>randomUUID().replaceAll('-','').slice(0,12);
async function connect(gateway,token) {
  const client=new Client({name:'c5-modes',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+gateway.port+'/mcp'),
    {requestInit:{headers:{Authorization:'Bearer '+token}}}));
  return client;
}
test('C5 mode change revokes existing OAuth tokens, refresh grants and requires new local authorization',
  {timeout:150000},async()=>{
  const runner=new GeminiRunner(runtime,{id:'upgrade-'+id(),timeout:30000});
  runner.setEndpoint(issuer);
  runner.setTarget({tools:'all'});
  const outside=join(runner.instance,'outside.txt');
  const inside=join(runner.config.root,'inside.txt');
  await writeFile(inside,'C5-INSIDE');
  await writeFile(outside,'C5-OUTSIDE');
  let client;
  try{
    await runner.start({oauth:true});
    assert.equal(runner.status.connection.mode,'oauth');
    const first=await authorizeInTest(runner.gateway);
    client=await connect(runner.gateway,first.credentials.access_token);
    assert.equal((await client.listTools()).tools.length,14);
    assert.equal((await client.callTool({name:'read_file',arguments:{path:outside}})).isError,true);
    await client.close();client=null;
    await runner.stop();
    runner.setTarget({toolMode:'terminal',tools:'all',elevatedAcknowledged:true});
    await runner.start({oauth:true});
    const denied=await fetch('http://127.0.0.1:'+runner.gateway.port+'/mcp',{
      method:'POST',headers:{
        Authorization:'Bearer '+first.credentials.access_token,
        'Content-Type':'application/json'
      },body:'{}'
    });
    assert.equal(denied.status,401);
    const manual=runner.gateway.credentials();
    const refresh=await fetch('http://127.0.0.1:'+runner.gateway.port+'/token',{
      method:'POST',headers:{Authorization:'Basic '+Buffer.from(manual.client_id+':'+manual.client_secret).toString('base64')},
      body:new URLSearchParams({grant_type:'refresh_token',refresh_token:first.credentials.refresh_token,
        resource:runner.gateway.publicResource})
    });
    assert.equal(refresh.status,400);
    const second=await authorizeInTest(runner.gateway,{manualClient:manual});
    client=await connect(runner.gateway,second.credentials.access_token);
    assert.equal((await client.listTools()).tools.length,21);
    const cmd=await client.callTool({name:'start_process',arguments:{
      command:'Write-Output C5-PERMISSION-REAUTHORIZED',timeout_ms:7000
    }});
    assert.notEqual(cmd.isError,true,JSON.stringify(cmd.content));
    assert(JSON.stringify(cmd.content).includes('C5-PERMISSION-REAUTHORIZED'));
    await client.close();client=null;
    await runner.stop();
    assert.throws(()=>runner.setEndpoint('https://different-issuer.example.invalid'),
      /ISSUER_CHANGE_REQUIRES_REAUTHORIZE/);
    runner.setEndpoint('https://different-issuer.example.invalid',
      {clearExistingAuthorization:true});
    await runner.start({oauth:true});
    assert.equal(runner.gateway.credentials(),null);
    assert.equal(runner.status.connection.oauth.activeRefreshGrants,0);
  }finally{await client?.close().catch(()=>{});await runner.stop().catch(()=>{});}
});
test('C5 official OAuth gateway four tool/access mode combinations', {timeout:240000},async()=>{
  for(const accessMode of ['restricted','full']){
    for(const toolMode of ['files','terminal']){
      const runner=new GeminiRunner(runtime,{id:'matrix-'+id(),timeout:30000});
      runner.setEndpoint(issuer);
      runner.setTarget({accessMode,toolMode,tools:'all',
        elevatedAcknowledged:accessMode==='full'||toolMode==='terminal'});
      const outside=join(runner.instance,'outside.txt');
      const inside=join(runner.config.root,'inside.txt');
      await writeFile(outside,'OUTSIDE-MATRIX');
      await writeFile(inside,'INSIDE-MATRIX');
      let client;
      try{
        await runner.start({oauth:true});
        const grant=await authorizeInTest(runner.gateway);
        client=await connect(runner.gateway,grant.credentials.access_token);
        assert.equal((await client.listTools()).tools.length,toolMode==='terminal'?21:14);
        const read=path=>client.callTool({name:'read_file',arguments:{path}});
        assert.notEqual((await read(inside)).isError,true);
        assert.equal((await read(outside)).isError===true,accessMode==='restricted');
        const testTerminal=await client.callTool({name:'start_process',arguments:{
          command:'Write-Output C5-TERMINAL',timeout_ms:7000
        }});
        assert.equal(testTerminal.isError===true,toolMode==='files');
        if(toolMode==='terminal')assert(JSON.stringify(testTerminal.content).includes('C5-TERMINAL'));
        console.log(JSON.stringify({accessMode,toolMode,tools:toolMode==='terminal'?21:14,oauth:'PASS'}));
      }finally{await client?.close().catch(()=>{});await runner.stop().catch(()=>{});}
    }
  }
});
