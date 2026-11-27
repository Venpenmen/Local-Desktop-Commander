import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const keys=new Set(['initialize','notifications/initialized','tools/list','tools/call','ping']);
const check=(secret,got)=>{
  if(typeof got!=='string'||!/^Bearer [a-f0-9]{64}$/i.test(got))return false;
  const candidate=got.slice(7);
  const a=Buffer.from(candidate,'hex');const b=Buffer.from(secret,'hex');
  return a.length===b.length && timingSafeEqual(a,b);
};
export async function createGateway(bridge,{host='127.0.0.1',port=0,token=randomBytes(32).toString('hex'),
  timeout=10000,onEvent=()=>{}}={}){
  if(host!=='127.0.0.1' || !Number.isInteger(port) || port<0 || port>65535)throw Error('LOOPBACK_ONLY');
  let active=0,credits=40,last=Date.now();
  const respond=(res,status,body={})=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body));
  const server=createServer(async(req,res)=>{
    if(req.url!=='/mcp')return respond(res,404);
    if(req.headers.origin)return respond(res,403);
    if(!check(token,req.headers.authorization))return respond(res,401);
    if(req.method!=='POST')return respond(res,405);
    if(!/^application\/json(?:;|$)/.test(req.headers['content-type']??''))return respond(res,415);
    if(Number(req.headers['content-length'])>8192)return respond(res,413);
    const now=Date.now();credits=Math.min(40,credits+(now-last)/750);last=now;
    if(active>=8 || credits<1)return respond(res,429);
    credits--;active++;
    let mcp;
    try {
      let size=0;const chunks=[];
      for await(const part of req){
        size+=part.length;
        if(size>8192)return respond(res,413);
        chunks.push(part);
      }
      let body;
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      catch{return respond(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
      if(!body||Array.isArray(body)||typeof body!=='object')return respond(res,400);
      const method=keys.has(body.method)?body.method:'unknown';
      onEvent({event:'request',method});
      mcp=new McpServer({name:'Local DC Gemini Adapter',version:'0.1.0'});
      for(const tool of bridge.toolList()){
        if(tool.name==='read_file'){
          mcp.registerTool('read_file',{
            description:tool.description || 'Read a file within the configured authorized root',
            inputSchema:{path:z.string().min(1).max(512),offset:z.number().int().min(0).max(1000).optional(),
              length:z.number().int().min(1).max(100).optional()},
            annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
          },async(args)=>{
            try{const result=await bridge.call('read_file',args);
              onEvent({event:'call',name:'read_file',isError:result.isError===true});
              return {content:result.content??[],isError:result.isError===true};}
            catch(error){onEvent({event:'call',name:'read_file',isError:true,code:'ENGINE_UNAVAILABLE',reason:error?.code===-32001?'MCP_TIMEOUT':'ENGINE_ERROR'});
              return {content:[{type:'text',text:'Local DC engine call failed'}],isError:true};}
          });
        }
      }
      const transport=new StreamableHTTPServerTransport({enableJsonResponse:true});
      await mcp.connect(transport);
      await transport.handleRequest(req,res,body);
    }catch(error){
      onEvent({event:'gateway-error'});
      if(!res.headersSent)respond(res,500);
      else if(!res.writableEnded)res.end();
    }finally{await mcp?.close().catch(()=>{});active--;}
  });
  server.requestTimeout=timeout+3000;
  server.headersTimeout=5000;
  server.setTimeout(timeout+3000,socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  let closed=false;
  return {port:server.address().port,host,token,
    status:()=>({state:closed?'stopped':'running',pid:process.pid,port:server.address()?.port??null}),
    async close(){if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  };
}
