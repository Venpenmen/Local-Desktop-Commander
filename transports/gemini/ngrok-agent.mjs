import {spawn,execFileSync} from 'node:child_process';
import {existsSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

/** Only a static ngrok free dev domain is accepted in the zero-cost adapter. */
export function validateNgrokIssuer(issuer) {
  let url;
  try{url=new URL(issuer);}catch{throw Error('INVALID_NGROK_ISSUER');}
  if(url.protocol!=='https:' || url.pathname!=='/' || url.search || url.hash ||
      url.username || url.password ||
      !/^[a-z0-9-]+\.ngrok-free\.(?:dev|app)$/i.test(url.hostname))
    throw Error('INVALID_NGROK_ISSUER');
  return url.origin;
}
export async function verifyPublicMcp(issuer,{fetcher=fetch}={}) {
  try{
    const response=await fetcher(issuer+'/.well-known/oauth-protected-resource/mcp',{
      redirect:'manual',headers:{Accept:'application/json'},
      signal:AbortSignal.timeout(6000)
    });
    if(response.status!==200 || !String(response.headers.get('content-type')).includes('json'))return false;
    const data=await response.json();
    return data.resource===issuer+'/mcp' &&
      Array.isArray(data.authorization_servers)&&data.authorization_servers.includes(issuer+'/');
  }catch{return false;}
}
export function createNgrokSupervisor({
  issuer,port,binary,authtoken,runDir,spawnAgent,verify=verifyPublicMcp,
  onEvent=()=>{},backoffs=[20000,60000,180000,600000],monitorInterval=600000
}={}){
  const domain=validateNgrokIssuer(issuer);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_NGROK_LOCAL_PORT');
  if(!spawnAgent && (!binary||!existsSync(binary)))throw Error('NGROK_BINARY_MISSING');
  if(!spawnAgent && (typeof authtoken!=='string'||authtoken.length<20))
    throw Error('NGROK_TOKEN_MISSING');
  if(!Number.isInteger(monitorInterval)||monitorInterval<60000)throw Error('INVALID_MONITOR_INTERVAL');
  let agentConfig;
  if(!spawnAgent){
    if(typeof runDir!=='string'||!runDir)throw Error('NGROK_RUN_DIRECTORY_REQUIRED');
    const escaped=realpathSync.native(binary).replaceAll("'","''");
    const script=`$s=Get-AuthenticodeSignature -LiteralPath '${escaped}';if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?i)ngrok'){exit 1}`;
    try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','ignore','ignore']});}
    catch{throw Error('NGROK_BINARY_SIGNATURE_INVALID');}
    mkdirSync(runDir,{recursive:true});
    agentConfig=join(runDir,'ngrok-c5.yml');
    // No authtoken or OAuth credentials in this YAML. Disable local request capture
    // and remote agent management; the private ngrok credential comes from DPAPI.
    writeFileSync(agentConfig,
      'version: 3\nagent:\n  web_addr: false\n  inspect_db_size: -1\n  remote_management: false\n  update_check: false\n  log: stdout\n  log_format: json\n');
  }
  let child=null;
  let stopped=true;
  let attempt=0;
  let timer=null;
  let monitor=null;
  let state='stopped';
  let verified=false;
  let lastError=null;
  let lastVerifiedUtc=null;
  let retryAtUtc=null;
  const status=()=>({
    state,pid:child?.exitCode===null?child.pid:null,domain,
    verified,lastVerifiedUtc,lastError,retryAtUtc,attempt
  });
  function clearClocks(){
    if(timer)clearTimeout(timer);timer=null;
    if(monitor)clearInterval(monitor);monitor=null;
  }
  async function check(){
    if(stopped||!child||child.exitCode!==null)return false;
    const yes=await verify(domain);
    if(stopped||!child||child.exitCode!==null)return false;
    verified=Boolean(yes);
    lastVerifiedUtc=new Date().toISOString();
    state=verified?'ready':'connecting';
    onEvent({event:verified?'tunnel-public-verified':'tunnel-public-unverified'});
    return verified;
  }
  function scheduleRetry(){
    if(stopped)return;
    if(attempt>backoffs.length){
      state='blocked';retryAtUtc=null;onEvent({event:'tunnel-retry-exhausted'});return;
    }
    const wait=backoffs[Math.min(attempt-1,backoffs.length-1)];
    state='retrying';
    retryAtUtc=new Date(Date.now()+wait).toISOString();
    onEvent({event:'tunnel-retry-scheduled'});
    timer=setTimeout(()=>{timer=null;void launch();},wait);
    timer.unref?.();
  }
  async function launch(){
    if(stopped)return;
    attempt++;
    state='connecting';verified=false;retryAtUtc=null;
    const launched=spawnAgent?spawnAgent({port,domain}):spawn(binary,[
      'http',String(port),'--url',domain,'--config',agentConfig
    ],{windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,NGROK_AUTHTOKEN:authtoken}});
    child=launched;
    let tail='';
    for(const stream of [launched.stdout,launched.stderr]){
      stream?.on('data',chunk=>{
        const value=String(chunk);
        tail=(tail+value).slice(-2048);
        const code=tail.match(/ERR_NGROK_\d+/);
        if(code)lastError=code[0];
      });
      stream?.resume();
    }
    launched.once('error',()=>{
      lastError='NGROK_SPAWN_FAILED';
      clearClocks();child=null;scheduleRetry();
    });
    launched.once('exit',code=>{
      clearClocks();
      child=null;verified=false;
      if(stopped)return;
      if(!lastError)lastError='NGROK_EXIT_'+String(code);
      scheduleRetry();
    });
    onEvent({event:'tunnel-agent-started'});
    await check();
    monitor=setInterval(()=>{void check();},monitorInterval);
    monitor.unref?.();
  }
  return {
    status,
    async start(){
      if(!stopped)throw Error('TUNNEL_ALREADY_STARTED');
      stopped=false;attempt=0;lastError=null;
      await launch();
      return status();
    },
    async recheck(){return check();},
    async stop(){
      if(stopped)return;
      stopped=true;clearClocks();
      const owned=child;child=null;verified=false;retryAtUtc=null;state='stopped';
      if(owned && owned.exitCode===null) {
        owned.kill();
        await Promise.race([
          new Promise(resolve=>owned.once('exit',resolve)),
          sleep(3500)
        ]);
      }
      onEvent({event:'tunnel-agent-stopped'});
    }
  };
}
