import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {createNgrokSupervisor,validateNgrokIssuer,verifyPublicMcp} from './ngrok-agent.mjs';

test('C5 static free domain requirements and public MCP resource identity',async()=>{
  for(const invalid of ['https://random.trycloudflare.com','http://test.ngrok-free.dev',
    'https://evil.ngrok-free.dev.attacker.example','https://a.ngrok-free.dev/secret',
    'https://user:pass@name.ngrok-free.dev']){
    assert.throws(()=>validateNgrokIssuer(invalid),/INVALID_NGROK_ISSUER/);
  }
  const url='https://assigned-domain.ngrok-free.dev';
  assert.equal(validateNgrokIssuer(url),url);
  assert.equal(await verifyPublicMcp(url,{fetcher:async()=>({
    status:200,headers:new Headers({'Content-Type':'application/json'}),
    json:async()=>({resource:url+'/mcp',authorization_servers:[url+'/']})
  })}),true);
  assert.equal(await verifyPublicMcp(url,{fetcher:async()=>({
    status:200,headers:new Headers({'Content-Type':'text/html'}),json:async()=>({})
  })}),false);
});
test('C5 owned ngrok agent supervisory lifecycle, verification and bounded reconnect',async()=>{
  const url='https://assigned-domain.ngrok-free.dev';
  const children=[];
  const events=[];
  let verifies=0;
  function mockSpawn(){
    const child=new EventEmitter();
    child.pid=28000+children.length;
    child.exitCode=null;
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.kill=()=>{child.exitCode=0;child.emit('exit',0);return true;};
    children.push(child);
    return child;
  }
  const supervisor=createNgrokSupervisor({
    issuer:url,port:49157,spawnAgent:mockSpawn,
    verify:async()=>{verifies++;return true;},
    backoffs:[30,60],onEvent:e=>events.push(e.event)
  });
  await supervisor.start();
  assert.equal(supervisor.status().state,'ready');
  assert.equal(supervisor.status().verified,true);
  assert.equal(supervisor.status().pid,28000);
  children[0].exitCode=1;
  children[0].emit('exit',1);
  assert.equal(supervisor.status().state,'retrying');
  await sleep(100);
  assert.equal(children.length,2);
  assert.equal(supervisor.status().state,'ready');
  await supervisor.stop();
  assert.equal(supervisor.status().state,'stopped');
  assert.equal(children[1].exitCode,0);
  await sleep(100);
  assert.equal(children.length,2);
  assert(verifies>=2);
  assert(events.includes('tunnel-public-verified'));
  assert(events.includes('tunnel-retry-scheduled'));
  assert(events.includes('tunnel-agent-stopped'));
});
