import { createServer, request as httpRequest } from 'node:http';
import { createGateway } from './gateway.mjs';
import { createGeminiOAuth } from './oauth.mjs';

/** OAuth-facing listener. Only OAuth-verified MCP calls are proxied to
 * the existing isolated loopback C4 gateway with its private in-memory token.
 * There is no unauthenticated route to the C4 gateway on the public endpoint. */
export async function createOAuthGateway(bridge,instance,{
  issuer:publishedIssuer,configRevision,port=0,timeout=30000,onEvent=()=>{},
  tokenSeconds=600,refreshSeconds=30*86400
}={}){
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_OAUTH_PORT');
  if(publishedIssuer!==undefined &&
      (!(publishedIssuer instanceof URL)||publishedIssuer.protocol!=='https:' ||
       publishedIssuer.username||publishedIssuer.password||publishedIssuer.pathname!=='/' ||
       publishedIssuer.search||publishedIssuer.hash))
    throw Error('EXPECTED_FIXED_HTTPS_ISSUER');
  const local=await createGateway(bridge,{timeout,onEvent});
  let app;
  const server=createServer((req,res)=>{
    if(!app)return res.writeHead(503).end();
    app(req,res);
  });
  const proxy=(req,res)=>{
    if(req.method!=='POST'||req.headers.origin){
      return res.status(req.method==='POST'?403:405).end();
    }
    const hasLength=req.headers['content-length']!==undefined;
    const length=hasLength?Number(req.headers['content-length']):null;
    if(hasLength&&(!Number.isSafeInteger(length)||length<0||length>4*1024*1024))
      return res.status(413).end();
    const outbound=httpRequest({
      hostname:'127.0.0.1',port:local.port,method:'POST',path:'/mcp',agent:false,
      headers:{
        'Content-Type':req.headers['content-type']??'application/json',
        'Accept':req.headers.accept??'application/json, text/event-stream',
        ...(hasLength?{'Content-Length':length}:{}),
        Authorization:'Bearer '+local.token,
        ...(typeof req.headers['mcp-protocol-version']==='string'
          ?{'Mcp-Protocol-Version':req.headers['mcp-protocol-version']}:{})
      }
    },response=>{
      if(!res.headersSent){
        res.status(response.statusCode||502);
        for(const key of ['content-type','mcp-session-id','mcp-protocol-version']){
          if(response.headers[key])res.setHeader(key,response.headers[key]);
        }
        res.setHeader('Cache-Control','no-store');
      }
      response.pipe(res);
    });
    outbound.setTimeout(timeout+2000,()=>outbound.destroy(Error('UPSTREAM_TIMEOUT')));
    outbound.on('error',()=>{
      onEvent({event:'oauth-proxy-error'});
      if(!res.headersSent)res.status(502).end();
      else if(!res.writableEnded)res.end();
    });
    req.pipe(outbound);
  };
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',resolve);
    });
    const origin=publishedIssuer??new URL('http://127.0.0.1:'+server.address().port);
    const oauth=createGeminiOAuth({
      issuer:origin,instance,configRevision,serveMcp:proxy,onEvent,
      log:event=>onEvent({event:event.event??'oauth-event'}),
      tokenSeconds,refreshSeconds
    });
    app=oauth.app;
    let closed=false;
    return {
      host:'127.0.0.1',port:server.address().port,
      publicIssuer:origin.origin,publicResource:oauth.resource,
      status:()=>({state:closed?'stopped':'running',
        host:'127.0.0.1',port:server.address()?.port??null,
        oauth:oauth.status(),privateReady:local.status().state==='running'}),
      registerManual:oauth.registerManual,
      armApproval:oauth.armApproval,
      revokeAll:oauth.revokeAll,
      credentials:oauth.credentials,
      async close(){
        if(closed)return;
        closed=true;
        server.closeAllConnections();
        try{await new Promise(resolve=>server.close(resolve));}
        finally{await local.close();}
      }
    };
  }catch(error){
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve)).catch(()=>{});
    await local.close();
    throw error;
  }
}
