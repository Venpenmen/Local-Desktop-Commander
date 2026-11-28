import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GeminiRunner } from './runner.mjs';
import { createSecretStore } from './secret-store.mjs';
import { capabilities, validateTunnelConfig, validatePublicOrigin } from './tunnel-contract.mjs';
import { createTunnelManager } from './tunnel-manager.mjs';

const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c5-unified/',import.meta.url));
const ident=()=>('u-'+randomUUID().replaceAll('-','').slice(0,12));
const a='https://one-moss.trycloudflare.com';
const b='https://two-moss.trycloudflare.com';

test('C5-U provider schema, capabilities, fixed/dynamic origins and unsafe URL rejection',()=>{
  for(const invalid of ['http://a.example.com','https://localhost',
    'https://127.0.0.1','https://192.168.1.1','https://x.localhost',
    'https://bad..example.com','https://.example.com','https://foo.example.com.',
    'https://user:pass@example.com','https://ok.example.com/mcp',
    'https://ok.example.com/?token=abc','https://ok.example.com/#anchor'])
    assert.throws(()=>validatePublicOrigin(invalid),/INVALID_HTTPS_ISSUER/);
  assert.equal(validatePublicOrigin('https://safe.example.com'),'https://safe.example.com');
  assert.deepEqual(validateTunnelConfig({schema:1,provider:'cloudflare-quick',issuer:null}),
    {schema:1,provider:'cloudflare-quick',issuer:null});
  assert.equal(validateTunnelConfig({schema:1,provider:'cloudflare-named',
    issuer:'https://gemini.example.com'}).provider,'cloudflare-named');
  assert.equal(capabilities['cloudflare-quick'].fixedOrigin,false);
  assert.equal(capabilities['cloudflare-named'].fixedOrigin,true);
  assert.equal(capabilities['external-https'].managed,false);
  assert.throws(()=>validateTunnelConfig({schema:1,provider:'cloudflare-quick',issuer:a}),
    /DYNAMIC_TUNNEL_ISSUER_MUST_BE_DISCOVERED/);
  assert.throws(()=>validateTunnelConfig({schema:1,provider:'ngrok',issuer:a}),
    /INVALID_NGROK_ISSUER/);
  assert.throws(()=>validateTunnelConfig({schema:1,provider:'cloudflare-named',issuer:null}),
    /TUNNEL_ISSUER_REQUIRED/);
  assert.throws(()=>validateTunnelConfig({schema:1,provider:'mystery',issuer:a}),
    /INVALID_TUNNEL_CONFIGURATION/);
});

test('C5-U generic tunnel manager: owned lifecycle, external read-only and Named requires credentials',async()=>{
  let launches=0,stops=0;
  const manager=createTunnelManager({schema:1,provider:'ngrok',issuer:'https://chosen.ngrok-free.dev'},{
    factory:()=>({
      start:async()=>{launches++;return {state:'ready',origin:'https://chosen.ngrok-free.dev'};},
      status:()=>({state:'ready',verified:true,origin:'https://chosen.ngrok-free.dev'}),
      stop:async()=>{stops++;},
      recheck:async()=>true
    })
  });
  await manager.start();
  assert.equal(manager.status().verified,true);
  assert.equal(await manager.recheck(),true);
  assert.equal(manager.capabilities.fixedOrigin,true);
  await manager.restart();
  await manager.stop();
  assert.equal(launches,2);assert.equal(stops,2);
  await assert.rejects(manager.recheck(),/TUNNEL_NOT_RUNNING/);
  const external=createTunnelManager({schema:1,provider:'external-https',
    issuer:'https://external.example.com'},{verify:async origin=>origin==='https://external.example.com'});
  assert.equal((await external.start()).verified,true);
  assert.equal(external.status().pid,null);
  await external.stop();
  assert.equal(external.status().state,'stopped');
  const named=createTunnelManager({schema:1,provider:'cloudflare-named',
    issuer:'https://gemini.example.com'},{port:18766});
  await assert.rejects(named.start(),/NAMED_TOKEN_MISSING/);
  assert.equal(named.status().state,'stopped');
});

test('C5-U DPAPI provider credentials remain isolated and no secret enters status',()=>{
  const runner=new GeminiRunner(runtime,{id:ident()});
  const ngrok='C5U_NGROK_ONLY_'+randomUUID().replaceAll('-','');
  const named='C5U_CLOUDFLARE_NAMED_ONLY_'+randomUUID().replaceAll('-','');
  try{
    runner.setNgrokToken(ngrok);
    runner.setTunnelCredential('cloudflare-named',named);
    assert.equal(createSecretStore(runner.instance,'tunnel-secret.dpapi').read().authtoken,ngrok);
    assert.equal(createSecretStore(runner.instance,'tunnel-cloudflare-named.dpapi').read().token,named);
    assert(!JSON.stringify(runner.status).includes(named));
    assert(!JSON.stringify(runner.status).includes(ngrok));
    assert.equal(runner.status.connection.tunnelCredentialsConfigured['cloudflare-named'],true);
    runner.clearTunnelCredential('cloudflare-named');
    assert.deepEqual(createSecretStore(runner.instance,'tunnel-cloudflare-named.dpapi').read(),{});
    assert.equal(createSecretStore(runner.instance,'tunnel-secret.dpapi').read().authtoken,ngrok);
    assert.throws(()=>runner.setTunnelCredential('cloudflare-quick','abc'),/PROVIDER_DOES_NOT_USE_CREDENTIALS/);
  } finally{
    runner.clearNgrokToken();
    runner.clearTunnelCredential('cloudflare-named');
  }
});

test('C5-U dynamic two-phase actual OAuth metadata, fail-closed prelaunch, issuer change revokes grants',
  {timeout:90000},async()=>{
    let iteration=0,preflight=0,stops=0,loseLink;
    const runner=new GeminiRunner(runtime,{id:ident(),timeout:30000,
      tunnelFactory:opts=>{
        loseLink=opts.onLost;
        const origin=[a,b][iteration++];
        let running=false;
        return {
          start:async()=>{
            const response=await fetch('http://127.0.0.1:'+opts.port+'/.well-known/oauth-authorization-server');
            assert.equal(response.status,503,'public relay must remain closed before issuer discovery');
            preflight++;running=true;
            return {origin,state:'connecting'};
          },
          status:()=>({state:running?'connecting':'stopped',origin,verified:false,pid:85000}),
          stop:async()=>{stops++;running=false;},
          recheck:async()=>running
        };
      }
    });
    runner.setTunnelProvider({schema:1,provider:'cloudflare-quick',issuer:null});
    try{
      const first=await runner.start({oauth:true,tunnel:true});
      assert.equal(first.connection.targetIssuer,a);
      assert.equal(first.connection.tunnelProvider,'cloudflare-quick');
      assert.equal(runner.relay.status().state,'ready');
      const url='http://127.0.0.1:'+runner.relay.port+'/.well-known/oauth-authorization-server';
      const response=await fetch(url);
      assert.equal(response.status,200);
      assert.equal((await response.json()).issuer,a+'/');
      loseLink();
      assert.equal((await fetch(url)).status,503,'lost tunnel must disable relay immediately');
      const callback='https://oauth-redirect.googleusercontent.com/r/ldc-c5u';
      runner.gateway.registerManual(callback);
      assert.equal(runner.status.connection.oauth.clientRegistered,true);
      const stored=createSecretStore(runner.instance).read();
      assert.equal(stored.issuer,a);
      await runner.stop();
      assert.equal(runner.status.enginePid,null);
      const second=await runner.start({oauth:true,tunnel:true});
      assert.equal(second.connection.targetIssuer,b);
      assert.equal(runner.status.connection.oauth.clientRegistered,false);
      assert.equal(createSecretStore(runner.instance).read().issuer,b);
      assert.equal((await fetch('http://127.0.0.1:'+runner.relay.port+
        '/.well-known/oauth-authorization-server')).status,200);
      assert.equal(preflight,2);
    }finally{await runner.stop();}
    assert.equal(stops,2);
    assert.equal(runner.status.connection.publicTunnel.state,'stopped');
    assert.equal(runner.status.enginePid,null);
});

test('C5-U bad dynamic domain is refused and all local resources are closed',
  {timeout:45000},async()=>{
    let stopCalled=0;
    const runner=new GeminiRunner(runtime,{id:ident(),timeout:20000,
      tunnelFactory:()=>({
        start:async()=>({origin:'https://forged.example.com'}),
        status:()=>({state:'connecting',origin:'https://forged.example.com'}),
        stop:async()=>{stopCalled++;},
        recheck:async()=>false
      })
    });
    runner.setTunnelProvider({schema:1,provider:'cloudflare-quick',issuer:null});
    await assert.rejects(runner.start({oauth:true,tunnel:true}),/INVALID_QUICK_TUNNEL_ORIGIN/);
    assert.equal(stopCalled,1);
    assert.equal(runner.status.enginePid,null);
    assert.equal(runner.status.state,'stopped');
    assert.equal(runner.relay,null);
    assert.equal(runner.owner,null);
});

test('C5-U supervisor preflight is side-effect-free and concurrent start/stop cannot leak ownership',async()=>{
  const good=createTunnelManager({schema:1,provider:'cloudflare-quick',issuer:null},{binary:process.execPath});
  assert.equal(good.checkPrerequisites().ready,true);
  assert.equal(good.status().state,'stopped');
  const missing=createTunnelManager({schema:1,provider:'cloudflare-quick',issuer:null});
  assert.equal(missing.checkPrerequisites().ready,false);
  const future=createTunnelManager({schema:1,provider:'cloudflare-named',issuer:'https://gemini.example.com'});
  assert.equal(future.checkPrerequisites().ready,false);
  assert.equal(future.capabilities.implementation,'local');
  let release,starts=0,stops=0;
  const latch=new Promise(resolve=>{release=resolve;});
  const manager=createTunnelManager({schema:1,provider:'ngrok',
    issuer:'https://single.ngrok-free.dev'},{
    factory:()=>({
      status:()=>({state:'connecting',verified:false,origin:'https://single.ngrok-free.dev'}),
      async start(){starts++;await latch;return {state:'connecting'};},
      async stop(){stops++;},
      async recheck(){return false;}
    })
  });
  const first=manager.start();
  await assert.rejects(manager.start(),/TUNNEL_ALREADY_STARTED/);
  const stopping=manager.stop();
  release();
  await assert.rejects(first,/TUNNEL_START_CANCELLED/);
  await stopping;
  assert.equal(manager.phase,'stopped');
  assert.equal(manager.status().state,'stopped');
  assert.equal(starts,1);assert.equal(stops,1);
});

test('C5-U provider config persists across runner creation and cannot be mutated by another live owner',
  {timeout:40000},async()=>{
  const name=ident();
  const main=new GeminiRunner(runtime,{id:name,timeout:20000});
  const staticUrl='https://persistent.example.com';
  main.setTunnelProvider({schema:1,provider:'external-https',issuer:staticUrl});
  const revision=main.status.connection.tunnelConfigRevision;
  const second=new GeminiRunner(runtime,{id:name,timeout:20000});
  assert.equal(second.tunnelConfig.provider,'external-https');
  assert.equal(second.tunnelConfig.issuer,staticUrl);
  assert.equal(second.status.connection.tunnelConfigRevision,revision);
  try{
    await main.start({oauth:true,tunnel:false});
    assert.throws(()=>second.setTunnelProvider({schema:1,provider:'external-https',issuer:staticUrl}),
      /INSTANCE_BUSY/);
    assert.throws(()=>second.setTunnelCredential('cloudflare-named','X'.repeat(64)),
      /INSTANCE_BUSY/);
  }finally{await main.stop();}
  assert.equal(main.status.enginePid,null);
});

test('C5-U conflicting persisted fixed issuer fails closed until explicitly repaired',
  {timeout:20000},async()=>{
  const id=ident();
  const runner=new GeminiRunner(runtime,{id});
  const fixed='https://correct.example.com';
  runner.setTunnelProvider({schema:1,provider:'external-https',issuer:fixed});
  writeFileSync(runner.connectionFile,JSON.stringify({
    schema:1,issuer:'https://stale.example.com'
  }));
  const interrupted=new GeminiRunner(runtime,{id});
  await assert.rejects(interrupted.start({oauth:true,tunnel:false}),
    /TUNNEL_CONNECTION_ISSUER_MISMATCH/);
  assert.equal(interrupted.status.state,'stopped');
  assert.equal(interrupted.status.enginePid,null);
  interrupted.setTunnelProvider({schema:1,provider:'external-https',issuer:fixed},
    {clearExistingAuthorization:true});
  assert.equal(interrupted.status.connection.targetIssuer,fixed);
});
