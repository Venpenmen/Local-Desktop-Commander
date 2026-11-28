import { spawn, execFileSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyPublicMcp } from './ngrok-agent.mjs';

export function parseQuickOrigin(value) {
  const match=String(value).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s/'"<>]|$)/i);
  if(!match) return null;
  const origin=new URL(match[0]).origin;
  if(!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(new URL(origin).hostname)) return null;
  return origin;
}
export function createCloudflareQuickSupervisor({
  port,binary,runDir,spawnAgent,verify=verifyPublicMcp,onEvent=()=>{},
  onLost=()=>{},startupTimeout=35000,monitorInterval=600000
}={}) {
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_TUNNEL_LOCAL_PORT');
  if(!spawnAgent){
    if(!binary||!existsSync(binary))throw Error('CLOUDFLARED_BINARY_MISSING');
    if(typeof runDir!=='string'||!runDir)throw Error('QUICK_TUNNEL_RUN_DIRECTORY_REQUIRED');
    mkdirSync(runDir,{recursive:true});
    if(realpathSync.native(runDir).toLowerCase()!==resolve(runDir).toLowerCase())
      throw Error('UNSAFE_TUNNEL_RUN_DIRECTORY');
    const escaped=realpathSync.native(binary).replaceAll("'","''");
    const script="$s=Get-AuthenticodeSignature -LiteralPath '"+escaped+"';if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?i)Cloudflare'){exit 1}";
    try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','ignore','ignore']});}
    catch{throw Error('CLOUDFLARED_BINARY_SIGNATURE_INVALID');}
  }
  let child=null,stopped=true,origin=null,state='stopped',verified=false,monitor=null;
  let lastVerifiedUtc=null,lastError=null;
  const status=()=>({state,origin,pid:child?.exitCode===null?child.pid:null,
    verified,lastVerifiedUtc,lastError});
  const clear=()=>{if(monitor){clearInterval(monitor);monitor=null;}};
  async function recheck(){
    if(stopped||!origin||!child||child.exitCode!==null)return false;
    const yes=await verify(origin);
    if(stopped||!child||child.exitCode!==null)return false;
    verified=Boolean(yes);lastVerifiedUtc=new Date().toISOString();
    state=verified?'ready':'connecting';
    onEvent({event:verified?'tunnel-public-verified':'tunnel-public-unverified'});
    return verified;
  }
  return {
    status,
    async start(){
      if(!stopped)throw Error('TUNNEL_ALREADY_STARTED');
      stopped=false;state='starting';lastError=null;origin=null;verified=false;
      try{
        const launched=spawnAgent?spawnAgent({port}):spawn(binary,
          ['tunnel','--no-autoupdate','--url','http://127.0.0.1:'+port],
          {windowsHide:true,stdio:['ignore','pipe','pipe'],
            env:{...process.env,USERPROFILE:runDir,HOME:runDir}});
        child=launched;
        origin=await new Promise((resolve,reject)=>{
          let settled=false,tail='';
          const succeed=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
          const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
          const timer=setTimeout(()=>fail(Error('QUICK_TUNNEL_START_TIMEOUT')),startupTimeout);
          for(const stream of [launched.stdout,launched.stderr]){
            stream?.on('data',chunk=>{
              tail=(tail+String(chunk)).slice(-2048);
              const found=parseQuickOrigin(tail);
              if(found)succeed(found);
            });
            stream?.resume();
          }
          launched.once('error',()=>fail(Error('QUICK_TUNNEL_SPAWN_FAILED')));
          launched.once('exit',code=>fail(Error('QUICK_TUNNEL_EXIT_'+String(code))));
        });
        state='connecting';
        onEvent({event:'tunnel-origin-discovered'});
        launched.once('exit',code=>{
          clear();verified=false;child=null;
          if(stopped)return;
          lastError='QUICK_TUNNEL_EXIT_'+String(code);
          state='blocked';
          onLost();
          onEvent({event:'tunnel-origin-lost'});
        });
        monitor=setInterval(()=>{void recheck().catch(()=>{});},monitorInterval);
        monitor.unref?.();
        return status();
      }catch(error){
        stopped=true;state='blocked';lastError=error.message;clear();
        if(child&&child.exitCode===null)child.kill();
        child=null;origin=null;throw error;
      }
    },
    recheck,
    async stop(){
      if(stopped)return;
      stopped=true;clear();verified=false;state='stopped';
      const owned=child;child=null;
      if(owned&&owned.exitCode===null){
        const exited=new Promise(resolve=>owned.once('exit',resolve));
        owned.kill();
        await Promise.race([exited,sleep(3500)]);
        if(owned.exitCode===null)owned.kill('SIGKILL');
      }
      onEvent({event:'tunnel-agent-stopped'});
    }
  };
}
