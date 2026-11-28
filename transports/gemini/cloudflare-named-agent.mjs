import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { validatePublicOrigin } from './tunnel-contract.mjs';
import { verifyPublicMcp } from './ngrok-agent.mjs';

export const verifiedCloudflaredSha256='555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113';
const scrub = e => String(e?.message??e).replace(/[A-Za-z0-9._~+\/=\-]{40,}/g,'[REDACTED]');
function ps(script, timeout=15000){
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout}).trim();
}
function quote(path){return String(path).replaceAll("'","''");}
function safeDirectory(dir){
  if(typeof dir!=='string'||!dir)throw Error('NAMED_RUN_DIRECTORY_REQUIRED');
  mkdirSync(dir,{recursive:true});
  if(lstatSync(dir).isSymbolicLink()||realpathSync.native(dir).toLowerCase()!==resolve(dir).toLowerCase())
    throw Error('UNSAFE_TUNNEL_RUN_DIRECTORY');
}
function processInfo(pid){
  if(!Number.isInteger(pid)||pid<1)return null;
  try{
    const result=ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue;if($p){$p|Select-Object ProcessId,CreationDate,ExecutablePath|ConvertTo-Json -Compress}`,8000);
    return result?JSON.parse(result):null;
  }catch{return null;}
}
function sameProcess(pid,creationTime,exe){
  const actual=processInfo(pid);
  if(!actual)return false;
  if(!creationTime||actual.CreationDate!==creationTime)return false;
  if(exe&&String(actual.ExecutablePath??'').toLowerCase()!==exe.toLowerCase())return false;
  return true;
}
function definitelyDead(pid){
  if(!Number.isInteger(pid)||pid<1)return true;
  try{process.kill(pid,0);return false;}
  catch(error){return error.code==='ESRCH';}
}
export function verifyCloudflaredBinary(binary,expectedSha256=verifiedCloudflaredSha256){
  if(!binary||!existsSync(binary))throw Error('CLOUDFLARED_BINARY_MISSING');
  const file=realpathSync.native(binary);
  const digest=createHash('sha256').update(readFileSync(file)).digest('hex');
  if(expectedSha256&&digest.toLowerCase()!==expectedSha256.toLowerCase())
    throw Error('CLOUDFLARED_BINARY_HASH_MISMATCH');
  try{
    ps(`$s=Get-AuthenticodeSignature -LiteralPath '${quote(file)}';if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?i)Cloudflare'){exit 1}`);
  }catch{throw Error('CLOUDFLARED_BINARY_SIGNATURE_INVALID');}
  return file;
}
/** Only the current Windows account and SYSTEM may read the transient plaintext file. */
export function restrictNamedTokenFile(file){
  if(!existsSync(file)||lstatSync(file).isSymbolicLink())throw Error('UNSAFE_NAMED_TOKEN_FILE');
  const script=`$ErrorActionPreference='Stop';$file='${quote(file)}';$who=[Security.Principal.WindowsIdentity]::GetCurrent();$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($who.User);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who.User,'FullControl','Allow')));$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'),'FullControl','Allow')));Set-Acl -LiteralPath $file -AclObject $acl;$check=Get-Acl -LiteralPath $file;if(-not $check.AreAccessRulesProtected){exit 1};foreach($rule in $check.Access){if($rule.AccessControlType -ne 'Allow'){exit 1};$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -ne $who.User.Value -and $sid -ne 'S-1-5-18'){exit 1}}`;
  try{ps(script);}catch{throw Error('NAMED_TOKEN_ACL_FAILED');}
}
export async function verifyNamedPublic(issuer,{fetcher=fetch}={}){
  try{
    const metadata=await fetcher(issuer+'/.well-known/oauth-authorization-server',{
      redirect:'manual',signal:AbortSignal.timeout(6000)});
    if(metadata.status!==200||!String(metadata.headers.get('content-type')).includes('json'))return false;
    const auth=await metadata.json();
    if(auth.issuer!==issuer+'/')return false;
    if(!await verifyPublicMcp(issuer,{fetcher}))return false;
    const denied=await fetcher(issuer+'/mcp',{method:'POST',redirect:'manual',
      headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',
        params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ldc-named-preflight',version:'1'}}}),
      signal:AbortSignal.timeout(6000)});
    return denied.status===401&&/\bbearer\b/i.test(String(denied.headers.get('www-authenticate')));
  }catch{return false;}
}
/** Per-user runtime lock is shared by all instances below the same runtime root. */
export function createCloudflareNamedSupervisor({
  issuer,port,binary,runDir,token,spawnAgent,verify=verifyNamedPublic,
  onEvent=()=>{},onLost=()=>{},startupTimeout=30000,monitorInterval=60000,
  backoffs=[20000,60000,180000],expectedSha256=verifiedCloudflaredSha256
}={}){
  const origin=validatePublicOrigin(issuer);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_TUNNEL_LOCAL_PORT');
  if(typeof token!=='string'||token.length<32||token.length>8192||!/^[A-Za-z0-9._~+\/=\-]+$/.test(token))
    throw Error('NAMED_TOKEN_MISSING');
  if(!Number.isInteger(monitorInterval)||monitorInterval<100)throw Error('INVALID_MONITOR_INTERVAL');
  if(!Number.isInteger(startupTimeout)||startupTimeout<100)throw Error('INVALID_STARTUP_TIMEOUT');
  safeDirectory(runDir);
  const executable=spawnAgent?null:verifyCloudflaredBinary(binary,expectedSha256);
  const owners=join(dirname(dirname(resolve(runDir))),'.named-owners');
  safeDirectory(owners);
  const ownerFile=join(owners,createHash('sha256').update(origin).digest('hex')+'.json');
  const tokenFile=join(runDir,'cloudflare-named-token.tmp');
  const privateOwnerFile=join(runDir,'cloudflare-named-owner.json');
  let child=null,stopped=true,phase='stopped',verified=false,lastVerifiedUtc=null;
  let lastError=null,retryAtUtc=null,attempt=0,ownerNonce=null,monitor=null,retry=null,generation=0;
  const status=()=>({state:phase,origin,verified,pid:child?.exitCode===null?child.pid:null,
    lastVerifiedUtc,lastError,retryAtUtc,attempt});
  const event=code=>{try{onEvent({event:code});}catch{}};
  const cleanupFile=file=>{try{if(existsSync(file)&&!lstatSync(file).isSymbolicLink())unlinkSync(file);}catch{}};
  function cleanClocks(){if(monitor)clearInterval(monitor);if(retry)clearTimeout(retry);monitor=null;retry=null;}
  function saveOwner(){
    if(!ownerNonce)return;
    const info=child?.pid?processInfo(child.pid):null;
    if(child?.pid&&!info&&!spawnAgent)throw Error('NAMED_PROCESS_OWNERSHIP_UNVERIFIED');
    const record={issuer:origin,nonce:ownerNonce,controllerPid:process.pid,
      controllerCreationTime:processInfo(process.pid)?.CreationDate??null,
      childPid:child?.pid??null,childCreationTime:info?.CreationDate??null,
      executable:executable??null};
    if(existsSync(privateOwnerFile)&&lstatSync(privateOwnerFile).isSymbolicLink())
      throw Error('NAMED_OWNER_SYMLINK');
    writeFileSync(privateOwnerFile,JSON.stringify(record));
    // The shared lock stays immutable after its atomic creation.
  }
  function acquireOwner(){
    // Never steal a live child's Tunnel. Recovered process is deliberately not killed.
    if(existsSync(ownerFile)){
      let old;
      try{
        if(lstatSync(ownerFile).isSymbolicLink())throw Error('NAMED_OWNER_SYMLINK');
        old=JSON.parse(readFileSync(ownerFile,'utf8'));
      }catch{throw Error('NAMED_OWNER_UNREADABLE');}
      if(old.issuer!==origin)throw Error('NAMED_OWNER_MISMATCH');
      let local=null;
      try{
        if(existsSync(privateOwnerFile)&&lstatSync(privateOwnerFile).isSymbolicLink())
          throw Error('NAMED_OWNER_SYMLINK');
        local=JSON.parse(readFileSync(privateOwnerFile,'utf8'));
      }catch(e){if(e.message==='NAMED_OWNER_SYMLINK')throw e;}
      if(local?.childPid&&!definitelyDead(local.childPid))
        throw Error('NAMED_ORPHAN_PROCESS_REQUIRES_MANUAL_RECOVERY');
      if(!definitelyDead(old.controllerPid))
        throw Error('NAMED_TUNNEL_ALREADY_OWNED');
      cleanupFile(privateOwnerFile);cleanupFile(tokenFile);
      unlinkSync(ownerFile);
    }
    if(existsSync(tokenFile)||existsSync(privateOwnerFile))
      throw Error('NAMED_UNOWNED_TEMPORARY_FILES');
    const nonce=randomUUID(),fd=openSync(ownerFile,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify({issuer:origin,nonce,controllerPid:process.pid}));}
    finally{closeSync(fd);}
    ownerNonce=nonce;
  }
  function releaseOwner(){
    if(!ownerNonce)return;
    try{const stored=JSON.parse(readFileSync(ownerFile,'utf8'));
      if(stored.nonce===ownerNonce)cleanupFile(ownerFile);
    }catch{}
    cleanupFile(privateOwnerFile);ownerNonce=null;
  }
  function writeToken(){
    if(existsSync(tokenFile))throw Error('NAMED_TOKEN_FILE_COLLISION');
    const fd=openSync(tokenFile,'wx',0o600);
    let complete=false;
    try{
      // Restrict the empty file before any plaintext bytes are written.
      if(!spawnAgent)restrictNamedTokenFile(tokenFile);
      writeFileSync(fd,token,'utf8');complete=true;
    }finally{closeSync(fd);if(!complete)cleanupFile(tokenFile);}
  }
  async function probe(){
    const checking=child;
    if(stopped||!checking||checking.exitCode!==null)return false;
    let success=false;
    try{success=Boolean(await verify(origin));}catch{}
    if(stopped||child!==checking||checking.exitCode!==null)return false;
    verified=success;lastVerifiedUtc=new Date().toISOString();
    phase=success?'ready':'degraded';event(success?'tunnel-public-verified':'tunnel-public-unverified');
    return success;
  }
  function backoff(current){
    if(stopped||current!==generation)return;
    cleanClocks();
    if(attempt>backoffs.length){
      phase='blocked';retryAtUtc=null;onLost();event('tunnel-retry-exhausted');return;
    }
    const delay=backoffs[Math.min(attempt-1,backoffs.length-1)];
    phase='retrying';retryAtUtc=new Date(Date.now()+delay).toISOString();
    retry=setTimeout(()=>{retry=null;void launch().catch(()=>{lastError='NAMED_AGENT_RETRY_FAILED';backoff(generation);});},delay);
    retry.unref?.();event('tunnel-retry-scheduled');
  }
  async function launch(){
    if(stopped)return;
    const current=++generation;
    attempt++;verified=false;phase='connecting';retryAtUtc=null;
    writeToken();
    let launched=null,terminated=false;
    try{
      launched=spawnAgent?spawnAgent({port,origin,tokenFile}):spawn(executable,[
        'tunnel','--protocol','auto','--no-autoupdate','run','--token-file',tokenFile
      ],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,USERPROFILE:runDir,HOME:runDir}});
      child=launched;saveOwner();
      for(const stream of [launched.stdout,launched.stderr])stream?.resume();
      const exited=(code)=>{
        if(terminated)return;terminated=true;
        if(child===launched)child=null;
        cleanClocks();verified=false;cleanupFile(tokenFile);
        if(stopped||current!==generation)return;
        lastError='NAMED_AGENT_EXIT_'+String(code);phase='degraded';onLost();backoff(current);
      };
      launched.once('error',()=>exited('SPAWN_ERROR'));
      launched.once('exit',code=>exited(code));
      event('tunnel-agent-started');
      await Promise.race([probe(),sleep(startupTimeout)]);
      if(!stopped&&child===launched){
        monitor=setInterval(()=>{void probe();},monitorInterval);monitor.unref?.();
      }
    }catch(error){
      if(launched&&launched.exitCode===null&&typeof launched.kill==='function'){
        const exited=new Promise(done=>launched.once('exit',done));
        try{launched.kill();}catch{}
        await Promise.race([exited,sleep(3500)]);
        if(launched.exitCode===null){
          try{launched.kill('SIGKILL');}catch{}
          await Promise.race([exited,sleep(1500)]);
        }
        if(launched.exitCode===null)throw Error('NAMED_PROCESS_STILL_RUNNING');
      }
      child=null;cleanupFile(tokenFile);throw error;
    }
  }
  return {
    status,recheck:probe,
    async start(){
      if(!stopped)throw Error('TUNNEL_ALREADY_STARTED');
      acquireOwner();stopped=false;phase='starting';attempt=0;lastError=null;generation++;
      try{await launch();return status();}
      catch(error){
        stopped=true;cleanClocks();
        if(child&&child.exitCode===null)throw Error('NAMED_PROCESS_STILL_RUNNING');
        cleanupFile(tokenFile);releaseOwner();throw error;
      }
    },
    async stop(){
      if(stopped&&!ownerNonce)return;
      stopped=true;generation++;cleanClocks();verified=false;phase='stopped';retryAtUtc=null;
      const owned=child;
      if(owned&&owned.exitCode===null){
        // Only the ChildProcess returned from our own spawn can be stopped.
        if(executable){
          const record=JSON.parse(readFileSync(privateOwnerFile,'utf8'));
          if(!sameProcess(owned.pid,record.childCreationTime,executable))
            throw Error('NAMED_OWNER_MISMATCH_STOP_BLOCKED');
        }
        const exited=new Promise(resolve=>owned.once('exit',resolve));
        owned.kill();
        await Promise.race([exited,sleep(3500)]);
        if(owned.exitCode===null&&typeof owned.kill==='function'){
          const forceExited=new Promise(resolve=>owned.once('exit',resolve));
          owned.kill('SIGKILL');
          await Promise.race([forceExited,sleep(1500)]);
        }
        if(owned.exitCode===null)throw Error('NAMED_PROCESS_STILL_RUNNING');
      }
      child=null;
      cleanupFile(tokenFile);releaseOwner();event('tunnel-agent-stopped');
    }
  };
}
