import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {GeminiRunner} from './runner.mjs';

const runtime=fileURLToPath(new URL('../../test-runtime/gemini-c5-tunnel/',import.meta.url));
const freeIssuer='https://assigned-c5-test.ngrok-free.dev';
const id=()=>randomUUID().replaceAll('-','').slice(0,12);

test('C5 runner starts OAuth, supervises only owned tunnel and stops both without token leakage',
  {timeout:60000},async()=>{
    let started=0,stopped=0,rechecked=0,seen;
    const runner=new GeminiRunner(runtime,{id:'public-'+id(),timeout:30000,
      tunnelFactory:options=>{
        seen=options;
        let running=false;
        return {
          start:async()=>{started++;running=true;},
          stop:async()=>{stopped++;running=false;},
          recheck:async()=>{rechecked++;return running;},
          status:()=>({state:running?'ready':'stopped',verified:running,
            domain:options.issuer,pid:65000})
        };
      }
    });
    runner.setEndpoint(freeIssuer);
    let opened;
    try{
      opened=await runner.start({oauth:true,tunnel:true});
      assert.equal(runner.status.connection.publicTunnel.state,'ready');
      assert.equal(runner.status.connection.publicTunnel.verified,true);
      assert.equal(runner.status.connection.mode,'oauth');
      assert.equal(opened.token,undefined);
      assert.equal(seen.issuer,freeIssuer);
      assert.equal(seen.port,runner.status.port);
      const metadata=await fetch('http://127.0.0.1:'+opened.port+'/.well-known/oauth-authorization-server');
      assert.equal(metadata.status,200);
      const result=await runner.tunnel.recheck();
      assert.equal(result,true);
    }finally{await runner.stop();}
    assert.equal(runner.status.connection.publicTunnel.state,'stopped');
    assert.equal(runner.status.enginePid,null);
    assert.equal(started,1);assert.equal(stopped,1);assert.equal(rechecked,1);
    const restarted=await runner.restart().catch(error=>error);
    // restart when stopped preserves the last explicit tunnel mode but the mock
    // is allowed to re-create its own process; no test must touch other tunnels.
    assert.equal(restarted.state,'running');
    await runner.stop();
    assert.equal(started,2);assert.equal(stopped,2);
});

test('C5 missing ngrok binary fails closed without leaving OAuth or stdio running',
  {timeout:60000},async()=>{
    const runner=new GeminiRunner(runtime,{id:'noagent-'+id(),timeout:30000,
      ngrokBinary:'D:\\nonexistent\\ngrok.exe'});
    runner.setEndpoint(freeIssuer);
    await assert.rejects(()=>runner.start({oauth:true,tunnel:true}),/NGROK_BINARY_MISSING/);
    assert.equal(runner.status.state,'stopped');
    assert.equal(runner.status.enginePid,null);
    assert.equal(runner.status.connection.publicTunnel.verified,false);
    const local=await runner.start({oauth:true,tunnel:false});
    assert.equal(local.connection.mode,'oauth');
    await runner.stop();
});
