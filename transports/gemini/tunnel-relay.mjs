import { createServer, request } from 'node:http';

/** Fail-closed loopback relay needed before a dynamic public issuer exists. */
export async function createTunnelRelay(){
  let targetPort=null,closed=false,active=0;
  const server=createServer((incoming,outgoing)=>{
    if(closed||!targetPort){incoming.resume();outgoing.writeHead(503,{'Cache-Control':'no-store'}).end();return;}
    active++;
    const upstream=request({hostname:'127.0.0.1',port:targetPort,method:incoming.method,
      path:incoming.url,agent:false,
      headers:{...incoming.headers,host:'127.0.0.1:'+targetPort}},
      response=>{
        if(outgoing.headersSent)return;
        outgoing.writeHead(response.statusCode??502,{
          ...response.headers,'cache-control':'no-store'
        });
        response.pipe(outgoing);
      });
    upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502).end();
      else if(!outgoing.writableEnded)outgoing.end();});
    upstream.on('close',()=>{active--;});
    incoming.pipe(upstream);
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  return {
    port:server.address().port,
    attach(port){
      if(closed||!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_RELAY_TARGET');
      targetPort=port;
    },
    disable(){targetPort=null;},
    status(){return {state:closed?'stopped':targetPort?'ready':'holding',
      port:server.address()?.port??null,active};},
    async close(){
      if(closed)return;
      closed=true;targetPort=null;
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
  };
}
