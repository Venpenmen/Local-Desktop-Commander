import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createCloudflareNamedSupervisor, verifyNamedPublic,
  restrictNamedTokenFile, verifyCloudflaredBinary, verifiedCloudflaredSha256
} from './cloudflare-named-agent.mjs';
import { createTunnelManager } from './tunnel-manager.mjs';
import { validateTunnelConfig } from './tunnel-contract.mjs';
import { GeminiRunner } from './runner.mjs';
import { createSecretStore } from './secret-store.mjs';

const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c5-named/',import.meta.url));
const uid=()=>randomUUID().slice(0,12);
const token='C5N_Synthetic_Not_Real_'+randomUUID().replaceAll('-','')+'_TEST';
function fakeAgent(){
  const child=new EventEmitter();
  child.pid=210000;child.exitCode=null;
  child.kill=()=>{if(child.exitCode!==null)return false;
    child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));return true;};
  child.crash=()=>{child.exitCode=12;child.emit('exit',12);};
  return child;
}
function supervisor(opts={}){
  const id=opts.id??uid();
  const issuer=opts.issuer??'https://gemini-'+id+'.example.com';
  const runDir=opts.runDir??join(runtime,'unit-'+id,'tunnel');
  return createCloudflareNamedSupervisor({
    issuer,port:18767,runDir,token,spawnAgent:()=>fakeAgent(),
    verify:async()=>true,monitorInterval:60000,backoffs:[25,30],
    ...opts
  });
}
test('C5-N exact OAuth metadata + 401 challenge required; redirects/HTML are rejected',async()=>{
  const issuer='https://gemini.example.com';
  const okay=async(url)=>{
    if(url.endsWith('/.well-known/oauth-authorization-server'))
      return new Response(JSON.stringify({issuer:issuer+'/'}),{status:200,headers:{'Content-Type':'application/json'}});
    if(url.endsWith('/.well-known/oauth-protected-resource/mcp'))
      return new Response(JSON.stringify({resource:issuer+'/mcp',authorization_servers:[issuer+'/']}),{
        status:200,headers:{'Content-Type':'application/json'}});
    return new Response('',{status:401,headers:{'WWW-Authenticate':'Bearer realm="mcp"'}});
  };
  assert.equal(await verifyNamedPublic(issuer,{fetcher:okay}),true);
  assert.equal(await verifyNamedPublic(issuer,{fetcher:async url=>{
    if(url.endsWith('/mcp'))return new Response('',{status:200});
    return okay(url);
  }}),false);
  assert.equal(await verifyNamedPublic(issuer,{fetcher:async()=>new Response('<html>challenge</html>',{
    status:200,headers:{'Content-Type':'text/html'}
  })}),false);
  assert.equal(await verifyNamedPublic(issuer,{fetcher:async()=>new Response('',{status:302})}),false);
});
test('C5-N startup, token-file-only handoff, no echo, and cleanup after stop',async()=>{
  let created,source;
  const id=uid(),runDir=join(runtime,'unit-'+id,'tunnel');
  const manager=createTunnelManager({schema:1,provider:'cloudflare-named',
    issuer:'https://named-'+id+'.example.com'},{port:18767,runDir,token,
      spawnAgent:({port,origin,tokenFile})=>{
        assert.equal(port,18767);
        assert.equal(origin,'https://named-'+id+'.example.com');
        assert.equal(readFileSync(tokenFile,'utf8'),token);
        source=fakeAgent();created=tokenFile;return source;
      },
      verify:async()=>true
    });
  try{
    assert.equal(manager.checkPrerequisites().ready,false,'without signed binary prerequisite is unsatisfied');
    const started=await manager.start();
    assert.equal(started.state,'ready');assert.equal(started.verified,true);
    assert.equal(existsSync(created),true);
    assert.equal(await manager.recheck(),true);
    assert.equal(JSON.stringify(manager.status()).includes(token),false);
    await assert.rejects(manager.start(),/TUNNEL_ALREADY_STARTED/);
  }finally{await manager.stop();}
  assert.equal(existsSync(created),false);
  assert.equal(source.exitCode,0);
  assert.equal(manager.status().state,'stopped');
});
test('C5-N same-domain duplicate process denied across instances within one runtime',async()=>{
  const id=uid(),issuer='https://shared-'+id+'.example.com';
  const one=supervisor({issuer,runDir:join(runtime,'one-'+id,'tunnel')});
  const two=supervisor({issuer,runDir:join(runtime,'two-'+id,'tunnel')});
  try{
    await one.start();
    await assert.rejects(two.start(),/NAMED_TUNNEL_ALREADY_OWNED/);
    assert.equal(two.status().state,'stopped');
  }finally{await one.stop();await two.stop();}
  await two.start();await two.stop();
});
test('C5-N unexpected child exit clears token and finite restart preserves origin',async()=>{
  const id=uid(),children=[];
  const runDir=join(runtime,'restart-'+id,'tunnel');
  const s=supervisor({runDir,spawnAgent:()=>{
    const child=fakeAgent();children.push(child);return child;},backoffs:[25,25],verify:async()=>true});
  const first=await s.start();const issuer=first.origin;
  assert.equal(first.verified,true);assert.equal(children.length,1);
  children[0].crash();
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),false);
  assert.equal(s.status().state,'retrying');
  await sleep(180);
  assert.equal(children.length,2);assert.equal(s.status().origin,issuer);
  assert.equal(s.status().verified,true);
  await s.stop();
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),false);
});
test('C5-N rejected startup cleans isolated lock and plaintext file',async()=>{
  const id=uid(),runDir=join(runtime,'fail-'+id,'tunnel');
  const fail=supervisor({runDir,spawnAgent:()=>{throw Error('SIMULATED_AGENT_FAILURE');}});
  await assert.rejects(fail.start(),/SIMULATED_AGENT_FAILURE/);
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),false);
  const recovered=supervisor({issuer:fail.status().origin,runDir});
  await recovered.start();await recovered.stop();
});
test('C5-N real Windows ACL and signed bundled binary: no real token or network',()=>{
  if(process.platform!=='win32')return;
  const binary=fileURLToPath(new URL('../../test-runtime/gemini-personal/bin/cloudflared.exe',import.meta.url));
  if(existsSync(binary))assert.equal(verifyCloudflaredBinary(binary,verifiedCloudflaredSha256),binary);
  const dir=join(runtime,'acl-'+uid());mkdirSync(dir,{recursive:true});
  const file=join(dir,'empty-token.txt');
  const handle=openSync(file,'wx');
  try{
    // Match production ordering: ACL is applied while file handle is open and still empty.
    restrictNamedTokenFile(file);
    writeFileSync(handle,'SYNTHETIC-ONLY');
  }finally{closeSync(handle);}
  try{
    const escaped=file.replaceAll("'","''");
    const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$a=Get-Acl -LiteralPath '"+escaped+"';[pscustomobject]@{Protected=$a.AreAccessRulesProtected;Count=@($a.Access).Count}|ConvertTo-Json -Compress"],
      {encoding:'utf8',windowsHide:true});
    const acl=JSON.parse(result);assert.equal(acl.Protected,true);
    assert.equal(acl.Count,2);
  }finally{unlinkSync(file);}
});
test('C5-N runner integrates local OAuth Gateway and preserves fixed issuer after restart',
  {timeout:90000},async()=>{
    const id='named-'+uid(),issuer='https://gemini-'+uid()+'.example.com';
    const localPort=await new Promise((resolve,reject)=>{
      const server=createServer();server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
    });
    const runner=new GeminiRunner(runtime,{id,timeout:20000,
      tunnelFactory:opts=>createTunnelManager({schema:1,provider:'cloudflare-named',issuer},{
        ...opts,spawnAgent:()=>fakeAgent(),verify:async()=>true
      })
    });
    runner.setTunnelProvider({schema:1,provider:'cloudflare-named',issuer,localPort});
    runner.setTunnelCredential('cloudflare-named',token);
    let started=false;
    try{
      const first=await runner.start({oauth:true,tunnel:true});started=true;
      assert.equal(first.connection.targetIssuer,issuer);
      assert.equal(first.port,localPort);
      assert.equal(first.connection.publicTunnel.verified,true);
      const base='http://127.0.0.1:'+first.port;
      const meta=await fetch(base+'/.well-known/oauth-authorization-server');
      assert.equal(meta.status,200);
      assert.equal((await meta.json()).issuer,issuer+'/');
      const unauthorized=await fetch(base+'/mcp',{method:'POST',
        headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(unauthorized.status,401);
      assert.match(unauthorized.headers.get('www-authenticate'),/Bearer/i);
      runner.gateway.registerManual('https://oauth-redirect.googleusercontent.com/r/ldc-named-test');
      assert.equal(runner.status.connection.oauth.clientRegistered,true);
      await runner.restart();
      assert.equal(runner.status.connection.targetIssuer,issuer);
      assert.equal(runner.status.port,localPort);
      assert.equal(runner.status.connection.oauth.clientRegistered,true);
      assert.equal(createSecretStore(runner.instance).read().issuer,issuer);
      assert.equal(runner.status.connection.publicTunnel.verified,true);
    }finally{
      if(started)await runner.stop();
      runner.clearTunnelCredential('cloudflare-named');
    }
    assert.equal(runner.status.state,'stopped');
});

test('C5-N stale owner clears abandoned token, never adopts an unproven live child',async()=>{
  const id=uid(),issuer='https://orphan-'+id+'.example.com';
  const runDir=join(runtime,'orphan-'+id,'tunnel');
  const ownerRoot=join(dirname(dirname(runDir)),'.named-owners');
  mkdirSync(runDir,{recursive:true});mkdirSync(ownerRoot,{recursive:true});
  const lock=join(ownerRoot,createHash('sha256').update(issuer).digest('hex')+'.json');
  const privateOwner=join(runDir,'cloudflare-named-owner.json');
  const credential=join(runDir,'cloudflare-named-token.tmp');
  const writeStale=childPid=>{
    writeFileSync(lock,JSON.stringify({issuer,nonce:'stale',controllerPid:99999999}));
    writeFileSync(privateOwner,JSON.stringify({issuer,nonce:'stale',childPid}));
    writeFileSync(credential,'SYNTHETIC_ABANDONED_ONLY');
  };
  writeStale(process.pid);
  const refused=supervisor({issuer,runDir});
  try{
    await assert.rejects(refused.start(),/NAMED_ORPHAN_PROCESS_REQUIRES_MANUAL_RECOVERY/);
    assert.equal(existsSync(credential),true);
  }finally{
    unlinkSync(lock);unlinkSync(privateOwner);unlinkSync(credential);
  }
  writeStale(99999998);
  const recovered=supervisor({issuer,runDir});
  try{
    const result=await recovered.start();
    assert.equal(result.state,'ready');
    assert.equal(readFileSync(credential,'utf8'),token);
  }finally{await recovered.stop();}
  assert.equal(existsSync(lock),false);
  assert.equal(existsSync(credential),false);
});
test('C5-N refuses to release ownership when its child cannot be terminated',async()=>{
  const id=uid(),runDir=join(runtime,'blocked-'+id,'tunnel');
  let child;
  const s=supervisor({runDir,spawnAgent:()=>{
    child=fakeAgent();child.kill=()=>false;return child;
  }});
  await s.start();
  await assert.rejects(s.stop(),/NAMED_PROCESS_STILL_RUNNING/);
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),true);
  child.crash();
  await s.stop();
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),false);
});
test('C5-N finite restart exhausts instead of infinitely respawning',async()=>{
  const id=uid();let launches=0;
  const s=supervisor({id,backoffs:[25],verify:async()=>false,
    spawnAgent:()=>{
      launches++;
      const child=fakeAgent();queueMicrotask(()=>child.crash());return child;
    }});
  try{
    await s.start();
    await sleep(300);
    assert.equal(launches,2);
    assert.equal(s.status().state,'blocked');
    assert.equal(s.status().verified,false);
  }finally{await s.stop();}
});

test('C5-N fixed Published Route requires stable configurable local port',()=>{
  const base={schema:1,provider:'cloudflare-named',issuer:'https://gemini.example.com'};
  assert.equal(validateTunnelConfig(base).localPort,18767);
  assert.equal(validateTunnelConfig({...base,localPort:19342}).localPort,19342);
  for(const value of [0,1,80,65536,-2,NaN,'18767',null]){
    assert.throws(()=>validateTunnelConfig({...base,localPort:value}),/INVALID_NAMED_LOCAL_PORT/);
  }
  assert.throws(()=>validateTunnelConfig({schema:1,provider:'external-https',
    issuer:'https://other.example.com',localPort:19342}),/INVALID_TUNNEL_CONFIGURATION/);
});

test('C5-N Windows signal-only exit counts as terminated, releases token and owner',async()=>{
  const id=uid(),runDir=join(runtime,'signal-'+id,'tunnel');
  const s=supervisor({runDir,spawnAgent:()=>{
    const child=fakeAgent();
    child.signalCode=null;
    child.kill=()=>{
      if(child.signalCode)return false;
      child.signalCode='SIGTERM';
      queueMicrotask(()=>child.emit('exit',null,'SIGTERM'));
      return true;
    };
    return child;
  }});
  await s.start();
  await s.stop();
  assert.equal(s.status().state,'stopped');
  assert.equal(s.status().pid,null);
  assert.equal(existsSync(join(runDir,'cloudflare-named-token.tmp')),false);
  const restarted=supervisor({issuer:s.status().origin,runDir});
  await restarted.start();await restarted.stop();
});
