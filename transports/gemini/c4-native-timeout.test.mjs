import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createInstance } from './config.mjs';
import { createBridge } from './bridge.mjs';

const base=fileURLToPath(new URL('../../test-runtime/gemini-c4-native-timeout/',import.meta.url));
test('C4 native stdio request deadline rejects actual slow terminal invocation', {timeout:50000},async()=>{
  const id='deadline-'+randomUUID().replaceAll('-','').slice(0,12);
  const config=createInstance(base,id,{toolMode:'terminal',tools:['start_process'],
    elevatedAcknowledged:true});
  const bridge=await createBridge(config,join(base,id),{timeout:12000});
  const enginePid=bridge.pid;
  const began=Date.now();
  try{
    await assert.rejects(
      ()=>bridge.call('start_process',{
        command:'Start-Sleep -Seconds 4',timeout_ms:5000
      },{deadlineMs:250}),
      error=>error?.code===-32001 && /timed out/i.test(error.message)
    );
    assert(Date.now()-began<3000);
    await assert.rejects(
      ()=>bridge.call('start_process',{command:'Write-Output invalid'}, {deadlineMs:30}),
      /INVALID_CALL_DEADLINE/
    );
  }finally{await bridge.close();}
  let alive=true;
  try{process.kill(enginePid,0);}catch{alive=false;}
  assert.equal(alive,false,'Native engine did not exit after request timeout and close');
});
