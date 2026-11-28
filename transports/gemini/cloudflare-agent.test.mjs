import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCloudflareQuickSupervisor, parseQuickOrigin } from './cloudflare-agent.mjs';

function fakeAgent(){
  const child=new EventEmitter();
  child.pid=67001;child.exitCode=null;
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{if(child.exitCode!==null)return true;
    child.exitCode=0;child.emit('exit',0);return true;};
  return child;
}
test('C5-U quick domain discovery rejects wrong hosts and preserves exact origin',()=>{
  assert.equal(parseQuickOrigin('https://mild-penguin.trycloudflare.com |'),'https://mild-penguin.trycloudflare.com');
  assert.equal(parseQuickOrigin('https://mild-penguin.trycloudflare.com.evil.example'),null);
  assert.equal(parseQuickOrigin('https://example.com'),null);
  assert.equal(parseQuickOrigin('http://mild-penguin.trycloudflare.com'),null);
});
test('C5-U quick agent actual stdout discovery, metadata verify, owned loss and clean stop',async()=>{
  const child=fakeAgent(),events=[];
  let lost=0,calls=0;
  const supervisor=createCloudflareQuickSupervisor({
    port:42315,spawnAgent:()=>child,onLost:()=>lost++,
    verify:async origin=>{calls++;return origin==='https://brisk-otter.trycloudflare.com';},
    onEvent:e=>events.push(e.event),startupTimeout:2000
  });
  const started=supervisor.start();
  child.stderr.write('2026-11-28 INFO tunnel available: https://brisk-');
  child.stderr.write('otter.trycloudflare.com \n');
  const stat=await started;
  assert.equal(stat.origin,'https://brisk-otter.trycloudflare.com');
  assert.equal(stat.verified,false);
  assert.equal(await supervisor.recheck(),true);
  assert.equal(supervisor.status().state,'ready');
  child.exitCode=1;child.emit('exit',1);
  assert.equal(supervisor.status().state,'blocked');
  assert.equal(supervisor.status().verified,false);
  assert.equal(lost,1);
  await supervisor.stop();
  assert.equal(supervisor.status().state,'stopped');
  assert.equal(calls,1);
  assert(events.includes('tunnel-origin-discovered'));
  assert(events.includes('tunnel-origin-lost'));
});
test('C5-U quick agent invalid startup returns blocked and cannot leave child running',async()=>{
  const child=fakeAgent();
  const supervisor=createCloudflareQuickSupervisor({port:45672,spawnAgent:()=>child,startupTimeout:80});
  await assert.rejects(supervisor.start(),/QUICK_TUNNEL_START_TIMEOUT/);
  assert.equal(child.exitCode,0);
  assert.equal(supervisor.status().state,'blocked');
  assert.equal(supervisor.status().origin,null);
  await supervisor.stop();
});
test('C5-U quick agent stop only kills owned agent',async()=>{
  const child=fakeAgent();
  const supervisor=createCloudflareQuickSupervisor({port:42316,spawnAgent:()=>child,startupTimeout:2000});
  const start=supervisor.start();
  child.stdout.write('URL: https://wise-mole.trycloudflare.com\n');
  await start;
  await supervisor.stop();
  assert.equal(child.exitCode,0);
  assert.equal(supervisor.status().state,'stopped');
});
