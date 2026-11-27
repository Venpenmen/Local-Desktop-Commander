import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startReadBridge } from './read-bridge.mjs';

test('C2.5 native stdio lifecycle closes its owned child normally', {timeout:40000},async()=>{
  const id=randomUUID().replaceAll('-','');
  const runtime=fileURLToPath(new URL('./runtime/'+id+'/',import.meta.url));
  await mkdir(runtime,{recursive:true});
  const bridge=await startReadBridge(runtime);
  const enginePid=bridge.enginePid;
  try {
    assert(Number.isInteger(enginePid));
    assert(enginePid!==process.pid);
    const file=new URL('./runtime/'+id+'/gemini-read-instance/workspace/lifecycle.txt',import.meta.url);
    await writeFile(file,'LDC-LIFECYCLE-'+id);
    const answer=await bridge.read(fileURLToPath(file));
    assert.notEqual(answer.isError,true,JSON.stringify(answer.content));
    assert(JSON.stringify(answer.content).includes('LDC-LIFECYCLE-'+id));
  }finally {
    await bridge.close();
  }
  await delay(300);
  let alive=true;
  try{process.kill(enginePid,0);}catch{alive=false;}
  assert.equal(alive,false,'Owned engine survived normal bridge close');
  await assert.rejects(()=>bridge.read('C:\\any.txt'),/closed/i);
  console.log(JSON.stringify({id,checks:['T11 read bridge close reaps owned native engine','T11 no calls allowed after close']}));
});
