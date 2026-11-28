import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createBridge} from './bridge.mjs';
import {createInstance,configStatus} from './config.mjs';
import {createOAuthGateway} from './oauth-gateway.mjs';

const base=fileURLToPath(new URL('../../test-runtime/gemini-c5-auth/',import.meta.url));
const callback='https://oauth-redirect.googleusercontent.com/r/ldc-c5-local-verification';
test('C5 OAuth official callback, DPAPI persistence and native MCP after refresh', {timeout:120000},async()=>{
  const id='oauth-'+randomUUID().replaceAll('-','').slice(0,12);
  const config=createInstance(base,id);
  const instance=join(base,id);
  const marker='C5-REAL-'+randomUUID();
  const file=join(config.root,'oauth-read.txt');
  await writeFile(file,marker);
  const bridge=await createBridge(config,instance,{timeout:30000});
  const revision=configStatus(config,config).revision;
  let gateway;
  let client;
  const issuer=new URL('https://ldc-c5-test.example.invalid/');
  const request=(port,path,options={})=>fetch('http://127.0.0.1:'+port+path,{
    redirect:'manual',...options
  });
  try{
    gateway=await createOAuthGateway(bridge,instance,{issuer,configRevision:revision,tokenSeconds:4,refreshSeconds:3600});
    const port=gateway.port;
    const resource=new URL('/mcp',issuer).href;
    const metadata=await(await request(port,'/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer,issuer.href);
    const protectedMeta=await(await request(port,'/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(protectedMeta.resource,resource);
    assert.equal((await request(port,'/mcp',{method:'POST'})).status,401);
    assert.throws(()=>gateway.registerManual('https://evil.example/r/test'),/INVALID_GOOGLE_CALLBACK/);
    const manual=gateway.registerManual(callback).client;
    assert(manual.client_id&&manual.client_secret);
    assert(!await readFile(join(instance,'credentials','oauth-state.dpapi'),'utf8').then(s=>s.includes(manual.client_secret)));
    const key=Buffer.from(manual.client_id+':'+manual.client_secret).toString('base64');
    const basic={Authorization:'Basic '+key};
    const verifier=randomBytes(32).toString('base64url');
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    const authorize=(clientId=manual.client_id)=>request(port,'/authorize?'+new URLSearchParams({
      client_id:clientId,redirect_uri:callback,response_type:'code',code_challenge:challenge,
      code_challenge_method:'S256',resource,scope:'ldc:invoke',state:'state-C5'
    }));
    assert.equal((await authorize()).status,403);
    gateway.armApproval();
    const authorized=await authorize();
    assert.equal(authorized.status,303);
    assert.equal((await authorize()).status,403);
    const redirect=new URL(authorized.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'),'state-C5');
    const code=redirect.searchParams.get('code');
    const tokenForm=(port,values)=>request(port,'/token',{method:'POST',headers:basic,
      body:new URLSearchParams(values)});
    const grant={grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:callback,resource};
    assert.equal((await tokenForm(port,{...grant,code_verifier:'wrong'})).status,400);
    const issued=await tokenForm(port,grant);
    assert.equal(issued.status,200);
    const credentials=await issued.json();
    assert(credentials.access_token&&credentials.refresh_token);
    assert.equal((await tokenForm(port,grant)).status,400);
    client=new Client({name:'c5-oauth-test',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:'+port+'/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+credentials.access_token}}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['read_file']);
    const native=await client.callTool({name:'read_file',arguments:{path:file}});
    assert.notEqual(native.isError,true,JSON.stringify(native.content));
    assert(JSON.stringify(native.content).includes(marker));
    await client.close();
    client=null;
    await gateway.close();
    gateway=await createOAuthGateway(bridge,instance,{issuer,configRevision:revision,tokenSeconds:4,refreshSeconds:3600});
    assert.equal(gateway.credentials().client_id,manual.client_id);
    const restarted=await tokenForm(gateway.port,{
      grant_type:'refresh_token',refresh_token:credentials.refresh_token,
      resource
    });
    assert.equal(restarted.status,200);
    const fresh=await restarted.json();
    assert.notEqual(fresh.access_token,credentials.access_token);
    const revoked=await request(gateway.port,'/revoke',{
      method:'POST',headers:basic,body:new URLSearchParams({token:credentials.refresh_token})
    });
    assert.equal(revoked.status,200);
    assert.equal((await tokenForm(gateway.port,{
      grant_type:'refresh_token',refresh_token:credentials.refresh_token,
      resource
    })).status,400);
    assert.equal((await request(gateway.port,'/mcp',{method:'POST',headers:{
      Authorization:'Bearer '+fresh.access_token
    }})).status,401);
    console.log(JSON.stringify({checks:['OAuth RFC metadata','exact Google callback','one-time local preapproval',
      'PKCE S256','single-use auth code','actual authorized native MCP read_file',
      'DPAPI encrypted credentials','restart refresh','revoke and stale bearer denial']}));
  }finally{
    await client?.close().catch(()=>{});
    await gateway?.close().catch(()=>{});
    await bridge.close().catch(()=>{});
  }
});
