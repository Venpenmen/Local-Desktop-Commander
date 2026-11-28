import { randomBytes } from 'node:crypto';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidRequestError,
  InvalidScopeError, InvalidTargetError, InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createSecretStore } from './secret-store.mjs';

const googleCallback = /^https:\/\/oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com\/[ra]\/[A-Za-z0-9._~-]+$/;
const random = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const scope = 'ldc:invoke';

/** Official-web OAuth adapted from verified C2 manual-client/PKCE flow.
 * Grants are bound to an exact instance, HTTPS issuer and config revision.
 * Persisted state is encrypted per Windows user with DPAPI, never plaintext. */
export function createGeminiOAuth({
  issuer, instance, configRevision, serveMcp, log = () => {},
  tokenSeconds = 600, refreshSeconds = 30 * 24 * 3600
}) {
  if (!(issuer instanceof URL) ||
      !(issuer.protocol === 'https:' || issuer.hostname === '127.0.0.1') ||
      !/^[a-f0-9]{64}$/i.test(configRevision)) throw Error('INVALID_OAUTH_IDENTITY');
  if (!Number.isInteger(tokenSeconds) || tokenSeconds < 1 || tokenSeconds > 3600 ||
      !Number.isInteger(refreshSeconds) || refreshSeconds < 2 || refreshSeconds > 30*24*3600)
    throw Error('INVALID_OAUTH_LIFETIME');
  const resource = new URL('/mcp', issuer);
  const storage = createSecretStore(instance);
  const stored = storage.read();
  if (stored.issuer && stored.issuer !== issuer.origin) throw Error('OAUTH_ISSUER_CHANGED_REAUTHORIZE');
  if (stored.schema && stored.schema !== 1) throw Error('OAUTH_STORAGE_VERSION_UNSUPPORTED');
  let manual = stored.manual ?? null;
  let preapproval = stored.preapproval ?? null;
  const restored = (values, max) => {
    const map = new Map();
    for (const item of Array.isArray(values) ? values.slice(-max) : [])
      if (item && typeof item.key === 'string' && item.value?.expiresAt > now()) map.set(item.key,item.value);
    return map;
  };
  let registered = restored(stored.registered, 20);
  let codes = new Map();
  let tokens = restored(stored.tokens, 80);
  let refresh = restored(stored.refresh, 40);
  if (stored.revision !== configRevision) {
    preapproval = null; registered.clear(); tokens.clear(); refresh.clear();
    log({event:'oauth-scope-invalidation'});
  }
  const entries = map => [...map.entries()].map(([key,value]) => ({key,value}));
  const save = () => storage.save({
    schema: 1, issuer: issuer.origin, revision: configRevision,
    manual, preapproval, registered: entries(registered),
    tokens: entries(tokens), refresh: entries(refresh)
  });
  const lookup = (map, key) => {
    const value = map.get(key);
    if (value?.expiresAt > now()) return value;
    if (value) { map.delete(key); save(); }
    return undefined;
  };
  const insert = (map,key,value,max) => {
    for(const existing of [...map.keys()]) lookup(map,existing);
    if(map.size >= max) throw new InvalidRequestError('Authorization capacity reached');
    map.set(key,value); save();
  };
  const checkResource = requested => {
    if (requested && requested.href !== resource.href) throw new InvalidTargetError('Unrecognized MCP resource');
  };
  const findCode = (client,code) => {
    const grant = lookup(codes, code);
    if(grant?.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return grant;
  };
  const issueAccess = (refreshToken, grant) => {
    const expiresIn = Math.min(tokenSeconds,grant.expiresAt-now());
    if(expiresIn <= 0) throw new InvalidGrantError('Expired refresh authorization');
    const token = random();
    insert(tokens,token,{clientId:grant.clientId,refreshToken,
      configRevision,expiresAt:now()+expiresIn,scopes:[scope],resource:resource.href},80);
    log({event:'oauth-access-issued'});
    return {access_token:token,token_type:'Bearer',expires_in:expiresIn,scope,refresh_token:refreshToken};
  };
  function status(){
    return {clientRegistered:Boolean(manual),callbackRegistered:Boolean(manual?.redirect_uris?.length),
      preapprovalArmed:Boolean(preapproval?.expiresAt>now()),
      activeRefreshGrants:[...refresh.values()].filter(g=>g.expiresAt>now()).length,
      issuer:issuer.origin,resource:resource.href,configRevision};
  }
  function registerManual(callback){
    if(typeof callback!=='string' || !googleCallback.test(callback)) throw Error('INVALID_GOOGLE_CALLBACK');
    if(manual?.redirect_uris?.includes(callback)) return {updated:false, client:structuredClone(manual)};
    manual={client_id:random(),client_secret:random(),redirect_uris:[callback],
      token_endpoint_auth_method:'client_secret_basic',grant_types:['authorization_code','refresh_token'],
      response_types:['code'],client_name:'Local DC Gemini'};
    preapproval=null;registered.clear();codes.clear();tokens.clear();refresh.clear();save();
    log({event:'oauth-manual-client-registered'});
    return {updated:true,client:structuredClone(manual)};
  }
  function armApproval(){
    if(!manual) throw Error('CLIENT_NOT_CONFIGURED');
    preapproval={clientId:manual.client_id,callback:manual.redirect_uris[0],
      revision:configRevision,expiresAt:now()+300};
    save();log({event:'oauth-preapproval-armed'});
    return {armed:true,expiresAt:preapproval.expiresAt};
  }
  function consumeApproval(id,callback){
    const valid=preapproval?.clientId===id && preapproval?.callback===callback &&
      preapproval?.revision===configRevision && preapproval?.expiresAt>now();
    if(valid){preapproval=null;save();}
    return Boolean(valid);
  }
  function revokeAll(){
    codes.clear();tokens.clear();refresh.clear();preapproval=null;
    save();log({event:'oauth-all-revoked'});return {revoked:true};
  }
  const provider = {
    clientsStore:{
      getClient:id=>{
        if(manual?.client_id===id) return manual;
        return lookup(registered,id)?.client;
      },
      async registerClient(client){
        if(client.redirect_uris?.length!==1 || !googleCallback.test(client.redirect_uris[0]) ||
            ![undefined,'none','client_secret_basic','client_secret_post'].includes(client.token_endpoint_auth_method))
          throw new InvalidClientMetadataError('Expected one supported Google HTTPS callback');
        client.token_endpoint_auth_method??='client_secret_basic';
        insert(registered,client.client_id,{client,expiresAt:now()+7200},20);
        log({event:'oauth-client-registered'});
        return client;
      }
    },
    async authorize(client,params,res){
      checkResource(params.resource);
      if(params.scopes.some(item=>item!==scope)) throw new InvalidScopeError('Unsupported scope');
      if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
        throw new InvalidRequestError('Expected S256 PKCE challenge');
      if(!manual?.client_secret || client.client_id!==manual.client_id ||
          !manual.redirect_uris.includes(params.redirectUri))
        throw new InvalidRequestError('Use the locally registered client');
      if(!consumeApproval(client.client_id,params.redirectUri)){
        log({event:'oauth-preapproval-required'});
        return res.status(403).type('text').send('Local preapproval is not available. Arm authorization on the Windows device.');
      }
      const code=random();
      insert(codes,code,{...params,clientId:client.client_id,revision:configRevision,
        expiresAt:now()+60},48);
      const redirect=new URL(params.redirectUri);
      redirect.searchParams.set('code',code);
      if(params.state!==undefined) redirect.searchParams.set('state',params.state);
      log({event:'oauth-preapproval-consumed'});
      res.redirect(303,redirect.href);
    },
    async challengeForAuthorizationCode(client,code){
      return findCode(client,code).codeChallenge;
    },
    async exchangeAuthorizationCode(client,code,_verifier,redirectUri,requestedResource){
      const grant=findCode(client,code);
      checkResource(requestedResource);
      if(redirectUri!==grant.redirectUri || grant.revision!==configRevision)
        throw new InvalidGrantError('Invalid redirect or revision');
      codes.delete(code);
      const refreshToken=random();
      const entry={clientId:client.client_id,revision:configRevision,
        expiresAt:now()+refreshSeconds};
      insert(refresh,refreshToken,entry,40);
      return issueAccess(refreshToken,entry);
    },
    async exchangeRefreshToken(client,refreshToken,scopes,requestedResource){
      const entry=lookup(refresh,refreshToken);
      if(!entry || entry.clientId!==client.client_id || entry.revision!==configRevision)
        throw new InvalidGrantError('Invalid refresh authorization');
      checkResource(requestedResource);
      if(scopes?.some(item=>item!==scope)) throw new InvalidScopeError('Unsupported scope');
      return issueAccess(refreshToken,entry);
    },
    async verifyAccessToken(token){
      const auth=lookup(tokens,token);
      if(!auth || auth.configRevision!==configRevision || !lookup(refresh,auth.refreshToken) ||
          manual?.client_id!==auth.clientId)
        throw new InvalidTokenError('Unknown, expired or revoked credential');
      return {...auth,token,resource:new URL(auth.resource)};
    },
    async revokeToken(client,request){
      const refreshToken=lookup(tokens,request.token)?.refreshToken??request.token;
      if(lookup(refresh,refreshToken)?.clientId===client.client_id){
        refresh.delete(refreshToken);
        for(const [token,data] of tokens) if(data.refreshToken===refreshToken) tokens.delete(token);
        save();log({event:'oauth-access-revoked'});
      }
    }
  };
  const app=express();
  app.disable('x-powered-by');
  // Only the loopback Cloudflare relay may supply forwarded client IP information.
  app.set('trust proxy','loopback');
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    if(req.url.length>4096 || (req.path!=='/mcp' && Number(req.headers['content-length'])>4096))
      return res.sendStatus(413);
    next();
  });
  const authRouter=mcpAuthRouter({
    provider,issuerUrl:issuer,resourceServerUrl:resource,
    scopesSupported:[scope],resourceName:'Local DC Gemini',
    clientRegistrationOptions:{clientSecretExpirySeconds:7200}
  });
  app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({
    issuer:issuer.href,authorization_endpoint:new URL('/authorize',issuer),
    token_endpoint:new URL('/token',issuer),registration_endpoint:new URL('/register',issuer),
    revocation_endpoint:new URL('/revoke',issuer),
    response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],
    token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post','none'],
    scopes_supported:[scope]
  }));
  app.get('/.well-known/oauth-protected-resource',(_req,res)=>res.json({
    resource:resource.href,authorization_servers:[issuer.href],scopes_supported:[scope],
    resource_name:'Local DC Gemini'
  }));
  app.post('/register',express.json({limit:'4kb'}));
  app.post(['/token','/revoke'],express.urlencoded({extended:false,limit:'4kb'}),(req,res,next)=>{
    const authorization=req.headers.authorization;
    if(!authorization)return next();
    const match=/^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    const invalid=()=>res.status(401).set('WWW-Authenticate','Basic realm="LDC Gemini"').json({error:'invalid_client'});
    if(!match || !req.body || req.body.client_id!==undefined || req.body.client_secret!==undefined)
      return invalid();
    const pair=Buffer.from(match[1],'base64').toString('utf8');
    const position=pair.indexOf(':');
    if(position<1)return invalid();
    try{
      const decode=value=>decodeURIComponent(value.replace(/\+/g,' '));
      req.body.client_id=decode(pair.slice(0,position));
      req.body.client_secret=decode(pair.slice(position+1));
    }catch{return invalid();}
    next();
  });
  app.use(authRouter);
  app.all('/mcp',requireBearerAuth({
    verifier:provider,requiredScopes:[scope],expectedResource:resource,
    resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(resource)
  }),serveMcp);
  app.use((_req,res)=>res.sendStatus(404));
  app.use((_error,_req,res,_next)=>res.sendStatus(400));
  save();
  return {app,status,registerManual,armApproval,revokeAll,credentials:()=>manual?structuredClone(manual):null,
    issuer:issuer.origin,resource:resource.href};
}
