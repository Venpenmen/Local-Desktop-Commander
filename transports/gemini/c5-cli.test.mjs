import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root=fileURLToPath(new URL('../../test-runtime/gemini-c5-cli/',import.meta.url));
test('C5 CLI standalone OAuth setup, no inadvertent secrets and clean stop', {timeout:110000},async()=>{
  const id='cli-'+randomUUID().replaceAll('-','').slice(0,12);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),root,id],{
    windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  let buffer='',stderr='';
  let count=0;
  const pending=new Map();
  child.stderr.on('data',x=>{stderr+=x.toString().slice(0,500);});
  child.stdout.on('data',part=>{
    buffer+=part.toString();
    for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){
      const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
      try{
        const parsed=JSON.parse(line);
        const resolve=pending.get(parsed.id);
        if(resolve){pending.delete(parsed.id);resolve(parsed);}
      }catch{}
    }
  });
  const request=(operation,args)=>new Promise((resolve,reject)=>{
    const id='c5-'+(++count);
    const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CLI_TIMEOUT '+operation+' '+stderr));},22000);
    pending.set(id,value=>{clearTimeout(timeout);resolve(value);});
    child.stdin.write(JSON.stringify({protocol:1,id,operation,arguments:args})+'\n');
  });
  const issuer='https://assigned-local-test.ngrok-free.dev';
  const callback='https://oauth-redirect.googleusercontent.com/r/ldc-c5-cli';
  try {
    const state=await request('state');
    assert(state.ok);
    assert.equal(state.result.connection.targetIssuer,null);
    assert.equal((await request('connection.set',{issuer})).error.code,'CONFIRMATION_REQUIRED');
    const configured=await request('connection.set',{issuer,confirmed:true});
    assert(configured.ok);
    assert.equal(configured.result.targetIssuer,issuer);
    const noGateway=await request('oauth.register',{confirmed:true,callbackUrl:callback});
    assert.equal(noGateway.error.code,'OAUTH_GATEWAY_NOT_RUNNING');
    const noToken=await request('ngrok.token.set',{confirmed:true,authtoken:'short'});
    assert.equal(noToken.error.code,'INVALID_NGROK_TOKEN');
    const fakeToken='C5_TEST_LOCAL_ONLY_'+randomUUID().replaceAll('-','');
    const writeToken=await request('ngrok.token.set',{confirmed:true,authtoken:fakeToken});
    assert(writeToken.ok);
    assert.equal(writeToken.result.configured,true);
    const current=await request('state');
    assert.equal(current.result.connection.ngrokTokenConfigured,true);
    assert(!JSON.stringify(current).includes(fakeToken));
    const local=await request('start',{confirmed:true,oauth:true});
    assert(local.ok,JSON.stringify(local));
    assert.equal(local.result.connection.mode,'oauth');
    assert.equal(local.result.hasEphemeralToken,false);
    assert.equal((await request('oauth.credentials',{confirmed:true,showSecret:true})).result,null);
    const registered=await request('oauth.register',{confirmed:true,callbackUrl:callback});
    assert(registered.ok&&registered.result.clientConfigured);
    assert(!JSON.stringify(registered).includes('client_secret'));
    assert.equal((await request('oauth.credentials',{confirmed:true})).error.code,
      'EXPLICIT_SECRET_DISPLAY_REQUIRED');
    const armed=await request('oauth.arm',{confirmed:true});
    assert(armed.ok&&armed.result.armed);
    const summary=await request('oauth.status');
    assert(summary.ok&&summary.result.oauth.preapprovalArmed);
    assert.equal((await request('connection.set',{confirmed:true,issuer:'https://other.ngrok-free.dev'})).error.code,
      'STOP_BEFORE_CHANGE');
    const revoked=await request('oauth.revoke',{confirmed:true});
    assert(revoked.ok&&revoked.result.revoked);
    const stop=await request('stop',{confirmed:true});
    assert(stop.ok&&stop.result.state==='stopped');
    const reset=await request('ngrok.token.clear',{confirmed:true});
    assert(reset.ok);
    assert.equal((await request('state')).result.connection.ngrokTokenConfigured,false);
    console.log(JSON.stringify({checks:[
      'static domain setup','DPAPI ngrok secret only configuration flag returned',
      'local OAuth gateway start','callback register without credential echo',
      'secret display explicitly gated','one-time consent arm','grants revoke',
      'cannot reconfigure while active','owned service clean stop','local tunnel secret clear'
    ]}));
  }finally{
    child.stdin.end();
    await new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve();
      child.once('exit',resolve);
      setTimeout(()=>{child.kill();resolve();},7000).unref();
    });
  }
});
