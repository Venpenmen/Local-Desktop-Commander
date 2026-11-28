import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root=fileURLToPath(new URL('../../test-runtime/gemini-c5u-cli/',import.meta.url));
test('C5-U CLI provider contract, explicit reset, DPAPI secret isolation and no secret echo',
  {timeout:70000},async()=>{
    const id='cli-'+randomUUID().replaceAll('-','').slice(0,12);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),root,id],
      {windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',count=0,stderr='';
    const waiting=new Map();
    child.stderr.on('data',c=>{stderr+=String(c).slice(0,400);});
    child.stdout.on('data',c=>{
      buffer+=String(c);
      for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try{
          const obj=JSON.parse(line);
          const finish=waiting.get(obj.id);
          if(finish){waiting.delete(obj.id);finish(obj);}
        }catch{}
      }
    });
    const request=(operation,args)=>new Promise((resolve,reject)=>{
      const requestId='u-'+(++count);
      const timer=setTimeout(()=>{waiting.delete(requestId);
        reject(Error('CLI_TIMEOUT '+operation+' '+stderr));},15000);
      waiting.set(requestId,obj=>{clearTimeout(timer);resolve(obj);});
      child.stdin.write(JSON.stringify({protocol:1,id:requestId,operation,arguments:args})+'\n');
    });
    const query=async (operation,args)=>{
      if(operation==='tunnel.provider.set'&&args?.confirmed===true&&args.revision===undefined){
        const current=await request('tunnel.provider.get');
        return request(operation,{...args,revision:current.result.revision});
      }
      return request(operation,args);
    };
    const ngrok='https://owned-c5u.ngrok-free.dev';
    const named='https://gemini.example.com';
    const token='C5U_NAMED_'+randomUUID().replaceAll('-','')+'EXTRA';
    try{
      const cap=await query('capabilities');
      assert(cap.ok&&cap.result.tunnelProviders.includes('cloudflare-named'));
      assert(cap.result.operations.includes('tunnel.provider.set'));
      const table=await query('tunnel.capabilities');
      assert.equal(table.result.providers['cloudflare-quick'].fixedOrigin,false);
      const original=await query('tunnel.provider.get');
      assert(original.ok&&original.result.provider==='ngrok');
      assert.equal((await request('tunnel.provider.set',{confirmed:true,revision:'stale',
        config:{schema:1,provider:'ngrok',issuer:ngrok}})).error.code,'REVISION_CONFLICT');
      assert.equal((await query('tunnel.provider.set',{
        config:{schema:1,provider:'ngrok',issuer:ngrok}})).error.code,'CONFIRMATION_REQUIRED');
      assert((await query('tunnel.provider.set',{confirmed:true,
        config:{schema:1,provider:'ngrok',issuer:ngrok}})).ok);
      assert.equal((await query('tunnel.provider.get')).result.issuer,ngrok);
      assert.equal((await query('tunnel.provider.set',{confirmed:true,
        config:{schema:1,provider:'cloudflare-quick',issuer:null}})).error.code,
        'ISSUER_CHANGE_REQUIRES_REAUTHORIZE');
      assert.equal((await query('tunnel.provider.set',{confirmed:true,resetAuth:true,
        config:{schema:1,provider:'cloudflare-quick',issuer:null}})).error.code,
        'ELEVATED_CONFIRMATION_REQUIRED');
      assert((await query('tunnel.provider.set',{confirmed:true,resetAuth:true,
        riskAcknowledged:true,config:{schema:1,provider:'cloudflare-quick',issuer:null}})).ok);
      assert.equal((await query('tunnel.provider.get')).result.provider,'cloudflare-quick');
      assert.equal((await query('tunnel.provider.set',{confirmed:true,
        config:{schema:1,provider:'cloudflare-named',issuer:named}})).ok,true);
      assert.equal((await query('tunnel.provider.get')).result.issuer,named);
      assert.equal((await query('tunnel.credential.set',{confirmed:true,
        provider:'cloudflare-named',secret:'bad'})).error.code,'INVALID_TUNNEL_CREDENTIAL');
      const saved=await query('tunnel.credential.set',{confirmed:true,
        provider:'cloudflare-named',secret:token});
      assert(saved.ok&&saved.result.configured===true);
      const status=await query('state');
      assert(status.ok&&status.result.connection.tunnelCredentialsConfigured['cloudflare-named']);
      assert(!JSON.stringify(status).includes(token));
      assert(!JSON.stringify(saved).includes(token));
      const cleared=await query('tunnel.credential.clear',{confirmed:true,provider:'cloudflare-named'});
      assert(cleared.ok&&!cleared.result.configured);
      assert.equal((await query('state')).result.connection.tunnelCredentialsConfigured['cloudflare-named'],false);
      const runtimeCheck=await query('start',{confirmed:true,oauth:true,tunnel:true});
      assert.equal(runtimeCheck.error.code,'TUNNEL_PROVIDER_NOT_INSTALLED');
      assert.equal((await query('state')).result.state,'stopped');
    }finally{
      child.stdin.end();
      await new Promise(resolve=>{
        if(child.exitCode!==null)return resolve();
        child.once('exit',resolve);
        setTimeout(()=>{child.kill();resolve();},5000).unref();
      });
    }
});
