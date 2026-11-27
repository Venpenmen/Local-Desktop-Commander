import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root=fileURLToPath(new URL('../../test-runtime/gemini-c3-cli-tests/',import.meta.url));
test('C3 dedicated CLI protocol, revision, confirmations and lifecycle', {timeout:70000},async()=>{
  const id='cli-'+randomUUID().replaceAll('-','').slice(0,12);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),root,id],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();
  let buffer='';
  let stderr='';
  child.stderr.on('data',x=>{stderr+=x.toString().slice(0,800);});
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();
    for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){
      const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
      try{const obj=JSON.parse(line);const cb=pending.get(obj.id);if(cb){pending.delete(obj.id);cb(obj);}}
      catch{}
    }
  });
  let count=0;
  const query=(operation,arguments_=undefined)=>new Promise((resolve,reject)=>{
    const id='req-'+(++count);
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('TIMEOUT '+operation+' '+stderr));},18000);
    pending.set(id,value=>{clearTimeout(timer);resolve(value);});
    child.stdin.write(JSON.stringify({protocol:1,id,operation,arguments:arguments_})+'\n');
  });
  try{
    const state=await query('state');
    assert(state.ok&&state.result.state==='stopped');
    const capabilities=await query('capabilities');
    assert(capabilities.ok&&capabilities.result.operations.includes('config.get'));
    const config=await query('config.get');
    assert(config.ok&&config.result.revision);
    assert.equal((await query('start')).error.code,'CONFIRMATION_REQUIRED');
    assert.equal((await query('config.set',{confirmed:true,revision:'incorrect'})).error.code,'REVISION_CONFLICT');
    assert.equal((await query('bogus')).error.code,'UNKNOWN_OPERATION');
    const start=await query('start',{confirmed:true});
    assert(start.ok,JSON.stringify(start));
    assert.equal(start.result.state,'running');
    assert.equal(start.result.hasEphemeralToken,true);
    assert.equal((await query('config.set',{confirmed:true,revision:config.result.revision})).error.code,'STOP_BEFORE_CHANGE');
    const restarted=await query('restart',{confirmed:true});
    assert(restarted.ok&&restarted.result.state==='running');
    const stop=await query('stop',{confirmed:true});
    assert(stop.ok&&stop.result.state==='stopped');
    const after=await query('state');
    assert(after.ok&&after.result.enginePid===null);
    console.log(JSON.stringify({checks:['CLI state/capabilities/config/revision/confirmation/unknown operation','engine start/restart/stop and process cleanup']}));
  }finally{
    child.stdin.end();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},5000).unref();});
  }
});
