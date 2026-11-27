import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { GeminiRunner } from './runner.mjs';

const runtime=resolve(process.argv[2]??'./test-runtime/gemini-c3');
const instance=process.argv[3]??'gemini-c3';
const runner=new GeminiRunner(runtime,{id:instance,onEvent:()=>{}});
const io=createInterface({input:process.stdin,crlfDelay:Infinity});
let busy=false;
function reply(id,ok,payload){process.stdout.write(JSON.stringify({protocol:1,id,ok,...(ok?{result:payload}:{error:{code:String(payload)}})})+'\n');}
async function command(req) {
  if(!req||req.protocol!==1||typeof req.id!=='string'||!/^[A-Za-z0-9-]{1,64}$/.test(req.id))return reply('invalid',false,'INVALID_REQUEST');
  if(busy)return reply(req.id,false,'BUSY');
  busy=true;
  try{
    if(req.operation==='state') return reply(req.id,true,runner.status);
    if(req.operation==='capabilities') return reply(req.id,true,{schema:1,operations:['state','capabilities','start','stop','restart','config.get','config.set'],instance:runner.id});
    if(req.operation==='config.get') return reply(req.id,true,runner.status.fileAccess);
    if(req.operation==='config.set') {
      if(req.arguments?.confirmed!==true)return reply(req.id,false,'CONFIRMATION_REQUIRED');
      if(req.arguments?.revision!==runner.status.fileAccess.revision)return reply(req.id,false,'REVISION_CONFLICT');
      const {revision,confirmed,...config}=req.arguments;
      const status=runner.setTarget(config);
      return reply(req.id,true,status.fileAccess);
    }
    if(['start','stop','restart'].includes(req.operation)) {
      if(req.arguments?.confirmed!==true)return reply(req.id,false,'CONFIRMATION_REQUIRED');
      const status=await runner[req.operation]();
      return reply(req.id,true,req.operation==='start'||req.operation==='restart'?
        {...runner.status,hasEphemeralToken:Boolean(status.token)}:runner.status);
    }
    return reply(req.id,false,'UNKNOWN_OPERATION');
  }catch(error){return reply(req.id,false,error?.message??'OPERATION_FAILED');}
  finally{busy=false;}
}
for await(const line of io){
  let request;
  try{request=JSON.parse(line);}catch{reply('invalid',false,'INVALID_REQUEST');continue;}
  await command(request);
}
await runner.stop().catch(()=>{});
