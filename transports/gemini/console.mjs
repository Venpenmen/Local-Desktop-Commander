import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GeminiRunner} from './runner.mjs';

const root=resolve(process.argv[2]??fileURLToPath(new URL('../../test-runtime/gemini-personal/',import.meta.url)));
const id=process.argv[3]??'gemini-official';
const runner=new GeminiRunner(root,{id,timeout:30000});
if(!existsSync(runner.targetFile))runner.setTarget({tools:'all'});
async function question(prompt){
  const rl=createInterface({input:stdin,output:stdout});
  try{return (await rl.question(prompt)).trim();}
  finally{rl.close();}
}
function hidden(prompt){
  if(!stdin.isTTY || !stdin.setRawMode)throw Error('SENSITIVE_INPUT_REQUIRES_LOCAL_INTERACTIVE_CONSOLE');
  return new Promise((resolve,reject)=>{
    let value='';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    const cleanup=()=>{
      stdin.off('data',input);
      stdin.setRawMode(false);
      stdout.write('\n');
    };
    function input(part){
      for(const byte of part){
        if(byte===3){cleanup();reject(Error('CANCELLED'));return;}
        if(byte===13||byte===10){cleanup();resolve(value);return;}
        if(byte===127||byte===8){
          if(value.length){value=value.slice(0,-1);stdout.write('\b \b');}
          continue;
        }
        if(byte>=33&&byte<=126&&value.length<512){
          value+=String.fromCharCode(byte);
          stdout.write('*');
        }
      }
    }
    stdin.on('data',input);
  });
}
function status(){
  const s=runner.status;
  stdout.write('\n--- Local DC Gemini C5 ---\n');
  stdout.write('Instance: '+s.instance+'\n');
  stdout.write('Engine: '+s.state+' / Tools: '+(s.toolCount??'not running')+'\n');
  stdout.write('Files: '+s.fileAccess.target.accessMode+' / Tool mode: '+s.fileAccess.target.toolMode+'\n');
  stdout.write('Root: '+s.fileAccess.target.root+'\n');
  stdout.write('HTTPS target: '+(s.connection.targetIssuer??'not set')+'\n');
  stdout.write('OAuth: '+(s.connection.oauth?.clientRegistered?'registered':'not registered')+'\n');
  stdout.write('Tunnel provider: '+s.connection.tunnelProvider+'\n');
  stdout.write('ngrok token: '+(s.connection.ngrokTokenConfigured?'stored with DPAPI':'not configured')+'\n');
  stdout.write('Named token: '+(s.connection.tunnelCredentialsConfigured?.['cloudflare-named']?'stored with DPAPI':'not configured')+'\n');
  stdout.write('Tunnel: '+s.connection.publicTunnel.state+' / verified: '+Boolean(s.connection.publicTunnel.verified)+'\n');
  stdout.write('Local MCP ready: '+Boolean(s.connection.privateReady)+'\n');
  stdout.write('Restart required: '+s.fileAccess.restartRequired+'\n');
  if(s.connection.publicTunnel.lastError)stdout.write('Tunnel error code: '+s.connection.publicTunnel.lastError+'\n');
}
async function confirmRisk(){
  const confirmation=await question('Full and/or terminal grants Windows user permissions. Type ENABLE to continue: ');
  if(confirmation!=='ENABLE')throw Error('ELEVATED_CONFIRMATION_REQUIRED');
}
stdout.write('Local DC Gemini · standalone C5 test console\n');
stdout.write('Never paste ngrok tokens or OAuth client secrets into ChatGPT.\n');
try{
  let running=true;
  while(running){
    stdout.write('\n[0] Status  [1] Set free HTTPS domain  [2] Save ngrok token (hidden)\n');
    stdout.write('[3] Start OAuth + tunnel  [4] Register Google callback  [5] Arm one-time OAuth\n');
    stdout.write('[6] Show local OAuth client credentials  [7] Change file/tool modes\n');
    stdout.write('[8] Restart  [9] Stop  [10] Revoke OAuth  [11] Recheck public HTTPS\n');
    stdout.write('[12] Clear ngrok token  [13] Choose tunnel provider  [14] Save Named token\n');
    stdout.write('[15] Clear Named token  [Q] Quit (stop owned services)\n');
    const choice=(await question('Select: ')).toLowerCase();
    try{
      switch(choice){
        case '0':status();break;
        case '1':{
          const url=await question('ngrok Free assigned static https://...ngrok-free.dev domain: ');
          const current=runner.status.connection.targetIssuer;
          let reset=false;
          if(current&&current!==new URL(url).origin){
            reset=(await question('Changing issuer revokes the old OAuth authorization. Type RESET: '))==='RESET';
            if(!reset)break;
          }
          runner.setEndpoint(url,{clearExistingAuthorization:reset});
          stdout.write('HTTPS domain stored.\n');break;
        }
        case '2':{
          const token=await hidden('ngrok account authtoken (hidden): ');
          runner.setNgrokToken(token);
          stdout.write('Token encrypted using current Windows user DPAPI.\n');break;
        }
        case '3':{
          if(runner.config.accessMode==='full'||runner.config.terminal)await confirmRisk();
          const s=await runner.start({oauth:true,tunnel:true});
          stdout.write('OAuth localhost port: '+s.port+'\n');
          stdout.write('Public domain: '+s.connection.targetIssuer+' (online verification pending)\n');
          break;
        }
        case '4':{
          const callback=await question('Exact callback shown by Gemini (https://oauth-redirect...): ');
          const result=runner.gateway?.registerManual(callback);
          if(!result)throw Error('START_OAUTH_FIRST');
          stdout.write('OAuth client registered locally. Use [6] to view credentials.\n');break;
        }
        case '5':{
          const result=runner.gateway?.armApproval();
          if(!result)throw Error('START_OAUTH_FIRST');
          stdout.write('One-time local authorization armed; expires '+new Date(result.expiresAt*1000).toLocaleString()+'\n');
          break;
        }
        case '6':{
          if((await question('Show sensitive OAuth client secret on this local screen? Type SHOW: '))!=='SHOW')break;
          const data=runner.gateway?.credentials();
          if(!data)throw Error('NO_OAUTH_CLIENT_CONFIGURED');
          stdout.write('Client ID: '+data.client_id+'\nClient secret: '+data.client_secret+'\n');
          stdout.write('Copy only into Gemini custom MCP settings. Do not send in chat.\n');
          break;
        }
        case '7':{
          if(runner.status.state!=='stopped')throw Error('STOP_BEFORE_CHANGE');
          const mode=await question('Mode: 1 Restricted+14 / 2 Restricted+21 / 3 Full+14 / 4 Full+21: ');
          const map={'1':['restricted','files'],'2':['restricted','terminal'],
            '3':['full','files'],'4':['full','terminal']};
          if(!map[mode])throw Error('INVALID_MODE');
          const [accessMode,toolMode]=map[mode];
          const elevated=accessMode==='full'||toolMode==='terminal';
          if(elevated)await confirmRisk();
          runner.setTarget({accessMode,toolMode,tools:'all',elevatedAcknowledged:elevated});
          stdout.write('Target saved. Old OAuth grants will be invalid on the next start.\n');
          break;
        }
        case '8':{
          if(runner.config.accessMode==='full'||runner.config.terminal)await confirmRisk();
          await runner.restart();stdout.write('Owned services restarted.\n');break;
        }
        case '9':await runner.stop();stdout.write('Owned services stopped.\n');break;
        case '10':{
          if((await question('Revoke active OAuth access and refresh grants? Type REVOKE: '))!=='REVOKE')break;
          if(!runner.gateway?.revokeAll)throw Error('OAUTH_NOT_RUNNING');
          runner.gateway.revokeAll();stdout.write('OAuth grants revoked.\n');break;
        }
        case '11':{
          if(!runner.tunnel)throw Error('TUNNEL_NOT_RUNNING');
          const okay=await runner.tunnel.recheck();
          stdout.write('Actual public OAuth resource metadata: '+(okay?'verified':'not verified')+'\n');break;
        }
        case '12':{
          if((await question('Delete locally encrypted ngrok token? Type CLEAR: '))!=='CLEAR')break;
          runner.clearNgrokToken();stdout.write('Stored tunnel token cleared.\n');break;
        }
        case '13':{
          if(runner.status.state!=='stopped')throw Error('STOP_BEFORE_CHANGE');
          stdout.write('1 ngrok (fixed Free) / 2 Cloudflare Quick (dynamic) / 3 Cloudflare Named (fixed HTTPS) / 4 External HTTPS\n');
          const providerChoice=await question('Provider number: ');
          const providers={'1':'ngrok','2':'cloudflare-quick','3':'cloudflare-named','4':'external-https'};
          const provider=providers[providerChoice];
          if(!provider)throw Error('UNKNOWN_TUNNEL_PROVIDER');
          let issuer=null;
          if(provider!=='cloudflare-quick')issuer=await question('Exact fixed HTTPS origin: ');
          const config={schema:1,provider,issuer};
          if(provider==='cloudflare-named'){
            const tid=await question('Tunnel ID (optional; press Enter to omit): ');
            if(tid)config.tunnelId=tid;
            const localPort=await question('Fixed localhost OAuth Gateway port [18767]: ');
            config.localPort=localPort?Number(localPort):18767;
          }
          const current=runner.status.connection.targetIssuer;
          const changed=current&&current!==issuer;
          let reset=false;
          if(changed){
            reset=(await question('Issuer change revokes old OAuth grants. Type RESET: '))==='RESET';
            if(!reset)break;
          }
          runner.setTunnelProvider(config,{clearExistingAuthorization:reset});
          stdout.write('Tunnel provider configuration saved.\n');
          if(provider==='cloudflare-named')
            stdout.write('Named provider selected. Configure an isolated Tunnel/hostname and import its token locally.\n');
          if(provider==='cloudflare-quick')
            stdout.write('Quick dynamic domain is assigned on each tunnel start; reauthorize on change.\n');
          break;
        }
        case '14':{
          const token=await hidden('Cloudflare Named tunnel token (hidden): ');
          runner.setTunnelCredential('cloudflare-named',token);
          stdout.write('Named token encrypted using current Windows user DPAPI.\n');
          break;
        }
        case '15':{
          if((await question('Delete locally encrypted Named token? Type CLEAR: '))!=='CLEAR')break;
          runner.clearTunnelCredential('cloudflare-named');
          stdout.write('Named token cleared.\n');
          break;
        }
        case 'q':running=false;break;
        default:stdout.write('Unknown option.\n');
      }
    }catch(error){stdout.write('Operation failed: '+String(error?.message??error)+'\n');}
  }
}finally{await runner.stop().catch(()=>{});}
