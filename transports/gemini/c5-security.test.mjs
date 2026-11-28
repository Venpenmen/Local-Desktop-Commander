import assert from 'node:assert/strict';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {GeminiRunner} from './runner.mjs';
import {createSecretStore} from './secret-store.mjs';

const root=fileURLToPath(new URL('../../test-runtime/gemini-c5-security/',import.meta.url));
const issuer='https://c5-security.ngrok-free.dev';
const callback='https://oauth-redirect.googleusercontent.com/r/ldc-c5-security';
const id=()=>randomUUID().replaceAll('-','').slice(0,12);
async function setup(){
  const runner=new GeminiRunner(root,{id:'sec-'+id(),timeout:30000});
  runner.setEndpoint(issuer);
  await runner.start({oauth:true});
  const gateway=runner.gateway;
  const client=gateway.registerManual(callback).client;
  const basic='Basic '+Buffer.from(client.client_id+':'+client.client_secret).toString('base64');
  const port=gateway.port;
  const resource=gateway.publicResource;
  const req=(path,init={})=>fetch('http://127.0.0.1:'+port+path,{redirect:'manual',...init});
  const tokenForm=values=>req('/token',{method:'POST',headers:{Authorization:basic},
    body:new URLSearchParams(values)});
  return{runner,gateway,client,basic,port,resource,req,tokenForm};
}
function requestChunked(port,body,headers){
  return new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',
      headers:{...headers,'Transfer-Encoding':'chunked','Content-Type':'application/json',
        Accept:'application/json, text/event-stream'}},res=>{
      let bytes='';
      res.on('data',x=>bytes+=x.toString());
      res.on('end',()=>resolve({status:res.statusCode,body:bytes}));
    });
    req.once('error',reject);
    req.write(body.slice(0,22));req.end(body.slice(22));
  });
}
test('C5 HTTP origin, anonymous, malformed, wrong content and real chunked authenticated MCP', {timeout:60000},async()=>{
  const env=await setup();
  const {runner,gateway,port,req}=env;
  try{
    const naked=await req('/mcp',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});
    assert.equal(naked.status,401);
    const rejected=await req('/mcp',{method:'POST',body:'{}',headers:{
      'Content-Type':'application/json',Authorization:'Bearer invalid'}});
    assert.equal(rejected.status,401);
    const c=gateway.registerManual(callback).client;
    gateway.armApproval();
    const verifier=randomBytes(32).toString('base64url');
    const hash=createHash('sha256').update(verifier).digest('base64url');
    const challenge=new URLSearchParams({client_id:c.client_id,redirect_uri:callback,
      response_type:'code',scope:'ldc:invoke',code_challenge:hash,code_challenge_method:'S256',
      resource:gateway.publicResource});
    const authorized=await req('/authorize?'+challenge);
    assert.equal(authorized.status,303);
    const code=new URL(authorized.headers.get('location')).searchParams.get('code');
    const creds=await env.tokenForm({grant_type:'authorization_code',code,code_verifier:verifier,
      redirect_uri:callback,resource:gateway.publicResource});
    assert.equal(creds.status,200);
    const token=(await creds.json()).access_token;
    const body=JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list',params:{}});
    const chunked=await requestChunked(port,body,{Authorization:'Bearer '+token});
    assert.equal(chunked.status,200,chunked.body.slice(0,200));
    assert.equal(JSON.parse(chunked.body).result.tools.length,1);
    const origin=await req('/mcp',{method:'POST',body,headers:{
      Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:'https://attacker.example'}});
    assert.equal(origin.status,403);
    const invalid=await req('/mcp',{method:'POST',body:'{invalid',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
    assert.equal(invalid.status,400);
    const oversized=await req('/mcp',{method:'POST',body:'x'.repeat(4097),
      headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'}});
    assert.equal(oversized.status,415);
    console.log(JSON.stringify({checks:['unauthenticated 401','invalid 401','real chunked MCP tools/list',
      'cross-origin 403','malformed JSON 400','content-type 415']}));
  }finally{await runner.stop();}
});
test('C5 DPAPI encrypted store rejects corruption, path spoofing and never leaks plaintext', {timeout:50000},async()=>{
  const runner=new GeminiRunner(root,{id:'dpapi-'+id()});
  const store=createSecretStore(runner.instance);
  const sample='DPAPI-C5-SECRET-'+randomUUID();
  store.save({secret:sample,expiresAt:123});
  assert.equal(store.read().secret,sample);
  const sealed=await readFile(store.file,'utf8');
  assert(!sealed.includes(sample)&&!sealed.includes('{"secret"'));
  await writeFile(store.file,'invalid-envelope');
  assert.throws(()=>store.read(),/DPAPI_UNPROTECT_FAILED/);
  store.clear();
  assert.deepEqual(store.read(),{});
  assert.throws(()=>createSecretStore(runner.instance,'../wrong.dpapi'),/INVALID_SECRET_FILE/);
});
