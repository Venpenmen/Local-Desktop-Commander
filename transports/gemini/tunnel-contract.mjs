import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from './config.mjs';

export const providerIds = Object.freeze(['ngrok','cloudflare-quick','cloudflare-named','external-https']);
export const capabilities = Object.freeze({
  ngrok:{fixedOrigin:true,managed:true,requiresAccount:true,requiresDomain:false,requiresSecret:true,streaming:'unknown',implementation:'local'},
  'cloudflare-quick':{fixedOrigin:false,managed:true,requiresAccount:false,requiresDomain:false,requiresSecret:false,streaming:'no-sse',implementation:'local'},
  'cloudflare-named':{fixedOrigin:true,managed:true,requiresAccount:true,requiresDomain:true,requiresSecret:true,streaming:'verify-required',implementation:'reserved'},
  'external-https':{fixedOrigin:true,managed:false,requiresAccount:false,requiresDomain:false,requiresSecret:false,streaming:'verify-required',implementation:'local'}
});
export function validatePublicOrigin(input){
  let url;
  try{url=new URL(input);}catch{throw Error('INVALID_HTTPS_ISSUER');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
     !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname)||
     isIP(url.hostname.replace(/^\[|\]$/g,''))||
     url.hostname==='localhost'||url.hostname.endsWith('.localhost')||
     url.hostname.endsWith('.local')||url.hostname.endsWith('.internal'))
    throw Error('INVALID_HTTPS_ISSUER');
  return url.origin;
}
export function validateTunnelConfig(value){
  if(!value||Array.isArray(value)||value.schema!==1||!providerIds.includes(value.provider))
    throw Error('INVALID_TUNNEL_CONFIGURATION');
  const provider=value.provider;
  const issuer=value.issuer==null?null:validatePublicOrigin(value.issuer);
  if(capabilities[provider].fixedOrigin&&!issuer)throw Error('TUNNEL_ISSUER_REQUIRED');
  if(!capabilities[provider].fixedOrigin&&issuer)throw Error('DYNAMIC_TUNNEL_ISSUER_MUST_BE_DISCOVERED');
  if(provider==='ngrok'&&!/^[a-z0-9-]+\.ngrok-free\.(?:dev|app)$/i.test(new URL(issuer).hostname))
    throw Error('INVALID_NGROK_ISSUER');
  if(provider==='cloudflare-named'&&value.tunnelId!==undefined&&
     (typeof value.tunnelId!=='string'||!/^[a-zA-Z0-9-]{4,128}$/.test(value.tunnelId)))
    throw Error('INVALID_NAMED_TUNNEL_ID');
  if(provider==='external-https'&&value.tunnelId!==undefined)throw Error('INVALID_TUNNEL_CONFIGURATION');
  return Object.freeze({schema:1,provider,issuer,...(provider==='cloudflare-named'?{tunnelId:value.tunnelId}:{})});
}
export function initialTunnelConfig(connection){
  const issuer=connection?.issuer??null;
  const provider=issuer && !/^[a-z0-9-]+\.ngrok-free\.(?:dev|app)$/i.test(new URL(issuer).hostname)
    ? 'external-https':'ngrok';
  return issuer?validateTunnelConfig({schema:1,provider,issuer}):
    Object.freeze({schema:1,provider:'ngrok',issuer:null});
}
export function loadTunnelConfig(instance,connection){
  const file=join(instance,'tunnel-config.json');
  if(existsSync(file))return validateTunnelConfig(JSON.parse(readFileSync(file,'utf8')));
  if(connection?.issuer)return initialTunnelConfig(connection);
  return Object.freeze({schema:1,provider:'ngrok',issuer:null});
}
export function saveTunnelConfig(instance,config){
  const validated=validateTunnelConfig(config);
  mkdirSync(instance,{recursive:true});
  writeAtomicJson(join(instance,'tunnel-config.json'),validated);
  return validated;
}
export function tunnelRevision(config){
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
export function tunnelStatus(supervisor,config){
  if(!supervisor)return {state:'stopped',verified:false,provider:config.provider,
    origin:config.issuer,managed:capabilities[config.provider].managed};
  const status=supervisor.status();
  return {provider:config.provider,managed:capabilities[config.provider].managed,
    origin:status.origin??status.domain??config.issuer,
    ...status};
}
