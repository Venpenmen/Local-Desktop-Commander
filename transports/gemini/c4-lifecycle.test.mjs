import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GeminiRunner } from './runner.mjs';

const base = fileURLToPath(new URL('../../test-runtime/gemini-c4-lifecycle/', import.meta.url));
const name = prefix => prefix + randomUUID().replaceAll('-', '').slice(0, 12);
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
test('C4 shutdown closes active owned terminal session', {timeout:90000},async()=>{
  const runner = new GeminiRunner(base,{id:name('terminal-'),timeout:30000});
  runner.setTarget({toolMode:'terminal',tools:'all',elevatedAcknowledged:true});
  const started = await runner.start();
  const client = new Client({name:'c4-active-session',version:'1'});
  let pid;
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+started.port+'/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+started.token}}}));
    const result = await client.callTool({name:'start_process',arguments:{
      command:'node -i',timeout_ms:1500
    }});
    const display=(result.content??[]).map(c=>c.text??'').join('\n');
    pid=Number(display.match(/PID\s*[:=]?\s*(\d+)/i)?.[1]);
    assert(Number.isInteger(pid)&&alive(pid),'Owned terminal not started: '+display.slice(0,500));
    await runner.stop();
    for(let attempt=0;attempt<30&&alive(pid);attempt++) await delay(200);
    assert.equal(alive(pid),false,'Native engine left an orphan terminal process');
  }finally{
    await client.close().catch(()=>{});
    await runner.stop().catch(()=>{});
    if(pid&&alive(pid)) process.kill(pid);
  }
});
test('C4 interrupted CLI parent cleanup and next owner recovery', {timeout:90000},async()=>{
  const id=name('parent-');
  const script=fileURLToPath(new URL('./cli.mjs',import.meta.url));
  const cli=spawn(process.execPath,[script,base,id],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='';
  let resolveLine;
  const messages=[];
  cli.stdout.on('data',part=>{
    buffer+=part.toString();
    for(let pos=buffer.indexOf('\n');pos>=0;pos=buffer.indexOf('\n')){
      const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);
      try{const parsed=JSON.parse(line);messages.push(parsed);resolveLine?.(parsed);}catch{}
    }
  });
  const reply=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('CLI start reply timeout')),18000);
    resolveLine=result=>{clearTimeout(timer);resolve(result);resolveLine=null;};
  });
  let enginePid;
  try{
    cli.stdin.write(JSON.stringify({protocol:1,id:'launch',operation:'start',arguments:{confirmed:true}})+'\n');
    const started=await reply;
    assert(started.ok,JSON.stringify(started));
    enginePid=started.result.enginePid;
    assert(Number.isInteger(enginePid)&&alive(enginePid));
    cli.kill();
    await new Promise(resolve=>{if(cli.exitCode!==null||cli.signalCode!==null)return resolve();cli.once('exit',resolve);});
    for(let attempt=0;attempt<30&&alive(enginePid);attempt++)await delay(200);
    assert.equal(alive(enginePid),false,'Native stdio child outlived forcibly terminated owner');
    const next=new GeminiRunner(base,{id,timeout:30000});
    const recovered=await next.start();
    try{
      assert(next.recoveredFromInterrupted,true);
      assert.equal(recovered.state,'running');
    }finally{await next.stop();}
  }finally{
    if(cli.exitCode===null&&cli.signalCode===null)cli.kill();
    if(enginePid&&alive(enginePid))process.kill(enginePid);
  }
});
