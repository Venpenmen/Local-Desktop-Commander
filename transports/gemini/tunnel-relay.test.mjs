import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createTunnelRelay } from './tunnel-relay.mjs';

test('C5-U loopback relay is closed before issuer binding, forwards only after attach, and disables on loss',async()=>{
  const upstream=createServer((req,res)=>res.writeHead(200,{'Content-Type':'application/json'})
    .end(JSON.stringify({path:req.url,host:req.headers.host})));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const relay=await createTunnelRelay();
  const endpoint='http://127.0.0.1:'+relay.port+'/mcp?source=local';
  try {
    const before=await fetch(endpoint);
    assert.equal(before.status,503);
    assert.equal(before.headers.get('cache-control'),'no-store');
    relay.attach(upstream.address().port);
    const after=await fetch(endpoint);
    assert.equal(after.status,200);
    assert.equal((await after.json()).path,'/mcp?source=local');
    assert.equal(relay.status().state,'ready');
    relay.disable();
    assert.equal((await fetch(endpoint)).status,503);
    assert.equal(relay.status().state,'holding');
  } finally{
    await relay.close();
    await new Promise(resolve=>upstream.close(resolve));
  }
  assert.equal(relay.status().state,'stopped');
  assert.throws(()=>relay.attach(8001),/INVALID_RELAY_TARGET/);
});
