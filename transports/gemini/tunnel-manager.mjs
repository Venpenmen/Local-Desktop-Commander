import { existsSync } from 'node:fs';
import { createNgrokSupervisor, verifyPublicMcp } from './ngrok-agent.mjs';
import { createCloudflareQuickSupervisor } from './cloudflare-agent.mjs';
import { capabilities, validateTunnelConfig } from './tunnel-contract.mjs';

export function checkTunnelPrerequisites(config,options={}){
  const checked=validateTunnelConfig(config);
  const problems=[];
  if(checked.provider==='ngrok'){
    if(!options.binary||!existsSync(options.binary))problems.push('NGROK_BINARY_MISSING');
    if(!options.authtoken)problems.push('NGROK_TOKEN_MISSING');
  }
  if(checked.provider==='cloudflare-quick'&&
      (!options.binary||!existsSync(options.binary)))problems.push('CLOUDFLARED_BINARY_MISSING');
  if(checked.provider==='cloudflare-named')problems.push('TUNNEL_PROVIDER_NOT_INSTALLED');
  return {provider:checked.provider,ready:problems.length===0,
    problems,capabilities:capabilities[checked.provider]};
}
export function createTunnelProvider(config,options={}){
  const checked=validateTunnelConfig(config);
  const {provider}=checked;
  if(provider==='ngrok')return createNgrokSupervisor({
    ...options,issuer:checked.issuer
  });
  if(provider==='cloudflare-quick')return createCloudflareQuickSupervisor(options);
  if(provider==='external-https'){
    let running=false,verified=false,lastVerifiedUtc=null;
    return {
      status:()=>({state:!running?'stopped':verified?'ready':'connecting',
        verified,origin:checked.issuer,pid:null,lastVerifiedUtc}),
      async start(){
        if(running)throw Error('TUNNEL_ALREADY_STARTED');
        running=true;await this.recheck();return this.status();
      },
      async recheck(){
        if(!running)return false;
        verified=await(options.verify??verifyPublicMcp)(checked.issuer);
        lastVerifiedUtc=new Date().toISOString();return verified;
      },
      async stop(){running=false;verified=false;}
    };
  }
  if(provider==='cloudflare-named')
    throw Error('TUNNEL_PROVIDER_NOT_INSTALLED');
  throw Error('UNKNOWN_TUNNEL_PROVIDER');
}
export function providerCapabilities(provider){
  if(!capabilities[provider])throw Error('UNKNOWN_TUNNEL_PROVIDER');
  return capabilities[provider];
}
export function createTunnelManager(config,{factory=createTunnelProvider,...options}={}){
  const checked=validateTunnelConfig(config);
  let supervisor=null,phase='stopped',pendingStart=null,pendingStop=null;
  return {
    get config(){return checked;},
    get capabilities(){return providerCapabilities(checked.provider);},
    get phase(){return phase;},
    checkPrerequisites(){return checkTunnelPrerequisites(checked,options);},
    status(){
      const current=supervisor?.status()??{state:'stopped',verified:false,
        origin:checked.issuer,pid:null};
      return {...current,provider:checked.provider,
        managed:capabilities[checked.provider].managed,
        ...(['starting','stopping'].includes(phase)?{state:phase,verified:false}:{})};
    },
    async start(){
      if(phase!=='stopped')throw Error('TUNNEL_ALREADY_STARTED');
      phase='starting';
      const job=(async()=>{
        let own=null;
        try{
          own=factory(checked,options);
          supervisor=own;
          const result=await own.start();
          if(phase==='stopping')throw Error('TUNNEL_START_CANCELLED');
          phase='running';
          return result;
        }catch(error){
          try{await own?.stop?.();}catch{}
          if(supervisor===own)supervisor=null;
          phase='stopped';
          throw error;
        }
      })();
      pendingStart=job;
      try{return await job;}
      finally{if(pendingStart===job)pendingStart=null;}
    },
    async recheck(){
      if(phase!=='running'||!supervisor)throw Error('TUNNEL_NOT_RUNNING');
      return supervisor.recheck();
    },
    async probe(){return this.recheck();},
    async stop(){
      if(pendingStop)return pendingStop;
      if(pendingStart){
        phase='stopping';
        await pendingStart.catch(()=>{});
      }
      if(phase==='stopped'&&!supervisor)return;
      phase='stopping';
      const owned=supervisor;
      const task=(async()=>{
        try{await owned?.stop();}
        finally{
          if(supervisor===owned)supervisor=null;
          phase='stopped';
        }
      })();
      pendingStop=task;
      try{await task;}
      finally{if(pendingStop===task)pendingStop=null;}
    },
    async restart(){await this.stop();return this.start();}
  };
}
