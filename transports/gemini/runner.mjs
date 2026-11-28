import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBridge } from './bridge.mjs';
import { createGateway } from './gateway.mjs';
import { createOAuthGateway } from './oauth-gateway.mjs';
import { createSecretStore } from './secret-store.mjs';
import { createTunnelManager } from './tunnel-manager.mjs';
import { createTunnelRelay } from './tunnel-relay.mjs';
import { capabilities, validateTunnelConfig, loadTunnelConfig, saveTunnelConfig, tunnelStatus, tunnelRevision, validatePublicOrigin } from './tunnel-contract.mjs';
import { configStatus, createInstance, writeAtomicJson } from './config.mjs';
import { createAuditLog } from './audit.mjs';

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export class GeminiRunner {
  constructor(runtime, { id = 'gemini-c4', onEvent = () => {}, timeout = 20000,
    tunnelFactory, ngrokBinary, cloudflaredBinary } = {}) {
    this.runtime = resolve(runtime);
    this.id = id;
    this.onEvent = onEvent;
    this.timeout = timeout;
    this.tunnelFactory = tunnelFactory;
    this.ngrokBinary = ngrokBinary ?? join(this.runtime,'bin','ngrok.exe');
    this.cloudflaredBinary = cloudflaredBinary ?? join(this.runtime,'bin','cloudflared.exe');
    this.relay = null;
    this.ngrokTokenConfigured = false;
    this.tunnel = null;
    this.lastStartTunnel = false;
    this.instance = join(this.runtime, this.id);
    this.config = createInstance(this.runtime, id);
    this.ngrokTokenConfigured = existsSync(join(this.instance,'credentials','tunnel-secret.dpapi'));
    this.audit = createAuditLog(this.instance);
    this.auditHealthy = true;
    this.bridge = null;
    this.gateway = null;
    this.starting = false;
    this.latestToken = null;
    this.owner = null;
    this.stateFile = join(this.instance, 'state.json');
    this.targetFile = join(this.instance, 'target.json');
    this.connectionFile = join(this.instance, 'connection.json');
    this.connection = null;
    this.lastStartOAuth = false;
    if (existsSync(this.connectionFile)) {
      this.connection = JSON.parse(readFileSync(this.connectionFile, 'utf8'));
      if (this.connection?.schema !== 1 || typeof this.connection.issuer !== 'string' ||
          new URL(this.connection.issuer).origin !== this.connection.issuer ||
          !this.connection.issuer.startsWith('https://'))
        throw Error('INVALID_CONNECTION_CONFIGURATION');
    }
    this.tunnelConfig = loadTunnelConfig(this.instance,this.connection);
    this.lockFile = join(this.instance, 'owner.lock');
    if (existsSync(this.targetFile)) {
      this.config = createInstance(this.runtime, id, JSON.parse(readFileSync(this.targetFile, 'utf8')));
    }
    let previous;
    try { previous = JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch {}
    this.recoveredFromInterrupted = previous?.state === 'running' || previous?.state === 'starting';
  }
  get status() {
    const live = this.gateway?.status();
    const effective = this.bridge?.config ?? null;
    return {
      instance: this.id, transport: 'gemini',
      state: live?.state ?? (this.starting ? 'starting' : 'stopped'),
      pid: live?.pid ?? null, enginePid: this.bridge?.pid ?? null,
      port: live?.port ?? null,
      fileAccess: configStatus(effective, this.config),
      toolCount: this.bridge?.toolList().length ?? null,
      connection: { targetIssuer: this.connection?.issuer ?? null,
        mode: this.gateway?.publicIssuer ? 'oauth' : 'local',
        oauth: live?.oauth ?? null, privateReady: live?.privateReady ?? null,
        publicTunnel: tunnelStatus(this.tunnel,this.tunnelConfig),
        tunnelProvider:this.tunnelConfig.provider, tunnelCapabilities:capabilities[this.tunnelConfig.provider],
        tunnelConfigRevision:tunnelRevision(this.tunnelConfig),
        ngrokTokenConfigured:this.ngrokTokenConfigured,
        tunnelCredentialsConfigured:{ngrok:this.ngrokTokenConfigured,
          'cloudflare-named':existsSync(join(this.instance,'credentials','tunnel-cloudflare-named.dpapi'))} },
      recoveredFromInterrupted: this.recoveredFromInterrupted,
      auditHealthy: this.auditHealthy
    };
  }
  assertStoppedForMutation(){
    if(this.gateway||this.starting)throw Error('STOP_BEFORE_CHANGE');
    if(!existsSync(this.lockFile))return;
    let lock;
    try{lock=JSON.parse(readFileSync(this.lockFile,'utf8'));}
    catch{throw Error('INSTANCE_LOCK_UNREADABLE');}
    if(lock?.pid===process.pid&&lock.nonce===this.owner)return;
    if(processAlive(lock?.pid))throw Error('INSTANCE_BUSY');
  }
  setTarget(target) {
    this.assertStoppedForMutation();
    const next = createInstance(this.runtime, this.id, target);
    writeAtomicJson(this.targetFile, next);
    this.config = next;
    this.record();
    return this.status;
  }
  setEndpoint(issuer,{clearExistingAuthorization=false}={}) {
    this.assertStoppedForMutation();
    if(!['ngrok','external-https'].includes(this.tunnelConfig.provider))
      throw Error('USE_TUNNEL_PROVIDER_SET');
    const url = new URL(validatePublicOrigin(issuer));
    const previous = createSecretStore(this.instance).read();
    if (previous.issuer && previous.issuer !== url.origin && !clearExistingAuthorization)
      throw Error('ISSUER_CHANGE_REQUIRES_REAUTHORIZE');
    if (previous.issuer && previous.issuer !== url.origin && clearExistingAuthorization)
      createSecretStore(this.instance).clear();
    this.connection = { schema:1, issuer:url.origin };
    writeAtomicJson(this.connectionFile,this.connection);
    if(this.tunnelConfig.provider==='ngrok'||this.tunnelConfig.provider==='external-https') {
      const provider=/^[a-z0-9-]+\.ngrok-free\.(?:dev|app)$/i.test(url.hostname)?'ngrok':'external-https';
      this.tunnelConfig=saveTunnelConfig(this.instance,{schema:1,provider,issuer:url.origin});
    }
    this.record();
    return this.status;
  }
  setTunnelProvider(candidate,{clearExistingAuthorization=false}={}){
    this.assertStoppedForMutation();
    const next=validateTunnelConfig(candidate);
    const current=this.connection?.issuer??null;
    const stored=createSecretStore(this.instance).read();
    const oldIssuer=stored.issuer??current;
    if(oldIssuer && oldIssuer!==next.issuer && !clearExistingAuthorization)
      throw Error('ISSUER_CHANGE_REQUIRES_REAUTHORIZE');
    if(oldIssuer && oldIssuer!==next.issuer && clearExistingAuthorization)
      createSecretStore(this.instance).clear();
    this.tunnelConfig=saveTunnelConfig(this.instance,next);
    if(next.issuer){
      this.connection={schema:1,issuer:next.issuer};
      writeAtomicJson(this.connectionFile,this.connection);
    }else {
      this.connection=null;
      try{unlinkSync(this.connectionFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    this.record();
    return this.status;
  }
  setNgrokToken(authtoken){
    this.assertStoppedForMutation();
    if(typeof authtoken!=='string'||!/^[-A-Za-z0-9_]{20,512}$/.test(authtoken))
      throw Error('INVALID_NGROK_TOKEN');
    createSecretStore(this.instance,'tunnel-secret.dpapi').save({authtoken});
    this.ngrokTokenConfigured=true;
    this.record();
    return {configured:true};
  }
  clearNgrokToken(){
    this.assertStoppedForMutation();
    createSecretStore(this.instance,'tunnel-secret.dpapi').clear();
    this.ngrokTokenConfigured=false;
    this.record();
    return {configured:false};
  }
  setTunnelCredential(provider,secret){
    this.assertStoppedForMutation();
    if(provider==='ngrok')return this.setNgrokToken(secret);
    if(provider!=='cloudflare-named')throw Error('PROVIDER_DOES_NOT_USE_CREDENTIALS');
    if(typeof secret!=='string'||secret.length<32||secret.length>8192||
       !/^[A-Za-z0-9._~+\/=\-]+$/.test(secret))throw Error('INVALID_TUNNEL_CREDENTIAL');
    createSecretStore(this.instance,'tunnel-cloudflare-named.dpapi').save({token:secret});
    this.record();
    return {configured:true,provider};
  }
  clearTunnelCredential(provider){
    this.assertStoppedForMutation();
    if(provider==='ngrok')return this.clearNgrokToken();
    if(provider!=='cloudflare-named')throw Error('PROVIDER_DOES_NOT_USE_CREDENTIALS');
    createSecretStore(this.instance,'tunnel-cloudflare-named.dpapi').clear();
    this.record();
    return {configured:false,provider};
  }
  record() { writeAtomicJson(this.stateFile, this.status); }
  acquireOwner() {
    if (this.owner) throw Error('ALREADY_RUNNING');
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd;
      try {
        fd = openSync(this.lockFile, 'wx');
        writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
        closeSync(fd);
        this.owner = nonce;
        return;
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(readFileSync(this.lockFile, 'utf8')); }
        catch { throw Error('INSTANCE_LOCK_UNREADABLE'); }
        if (typeof previous.nonce !== 'string' || previous.nonce.length < 20) throw Error('INSTANCE_LOCK_INVALID');
        if (processAlive(previous.pid)) throw Error('INSTANCE_BUSY');
        // Abandoned after the owning process exited. Never kill that PID or any process.
        unlinkSync(this.lockFile);
        this.recoveredFromInterrupted = true;
      }
    }
    throw Error('INSTANCE_BUSY');
  }
  releaseOwner() {
    if (!this.owner) return;
    const nonce = this.owner;
    this.owner = null;
    try {
      const locked = JSON.parse(readFileSync(this.lockFile, 'utf8'));
      if (locked.pid === process.pid && locked.nonce === nonce) unlinkSync(this.lockFile);
    } catch {}
  }
  async start({oauth=false,tunnel=false}={}) {
    if (this.gateway || this.starting) throw Error('ALREADY_RUNNING');
    const dynamic=tunnel && !capabilities[this.tunnelConfig.provider].fixedOrigin;
    if (oauth && !dynamic && !this.connection?.issuer) throw Error('OAUTH_ISSUER_NOT_CONFIGURED');
    if(oauth&&!dynamic&&this.tunnelConfig.issuer &&
       this.tunnelConfig.issuer!==this.connection?.issuer)
      throw Error('TUNNEL_CONNECTION_ISSUER_MISMATCH');
    if (tunnel && !oauth) throw Error('TUNNEL_REQUIRES_OAUTH');
    this.starting = true;
    try {
      this.acquireOwner();
      const log = event => {
        try { this.audit(event); } catch { this.auditHealthy = false; }
        try { this.onEvent({ instance: this.id, ...event }); } catch {}
      };
      this.bridge = await createBridge(this.config, this.instance, {
        onEvent: log, timeout: this.timeout
      });
      if(dynamic){
        // Keep the public entry inaccessible while the random hostname is unknown.
        this.relay=await createTunnelRelay();
        const options={provider:this.tunnelConfig.provider,issuer:null,
          port:this.relay.port,binary:this.cloudflaredBinary,
          runDir:join(this.instance,'tunnel'),onEvent:log,
          onLost:()=>this.relay?.disable()};
        this.tunnel=this.tunnelFactory?.(options) ?? createTunnelManager(this.tunnelConfig,options);
        const discovered=await this.tunnel.start();
        const issuer=validatePublicOrigin(discovered?.origin??this.tunnel.status()?.origin);
        if(this.tunnelConfig.provider==='cloudflare-quick' &&
            !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(new URL(issuer).hostname))
          throw Error('INVALID_QUICK_TUNNEL_ORIGIN');
        const store=createSecretStore(this.instance);
        if(store.read().issuer && store.read().issuer!==issuer){
          store.clear();log({event:'oauth-issuer-reissued'});
        }
        this.connection={schema:1,issuer};
        writeAtomicJson(this.connectionFile,this.connection);
        this.gateway=await createOAuthGateway(this.bridge,this.instance,{
          issuer:new URL(issuer),configRevision:configStatus(this.config,this.config).revision,
          timeout:this.timeout,onEvent:log
        });
        this.relay.attach(this.gateway.port);
      }else {
        this.gateway=oauth?await createOAuthGateway(this.bridge,this.instance,{
          issuer:new URL(this.connection.issuer),
          configRevision:configStatus(this.config,this.config).revision,
          timeout:this.timeout,onEvent:log
        }):await createGateway(this.bridge,{timeout:this.timeout,onEvent:log});
        if(tunnel){
          const authtoken=this.tunnelConfig.provider==='ngrok'
            ?createSecretStore(this.instance,'tunnel-secret.dpapi').read().authtoken:undefined;
          const options={provider:this.tunnelConfig.provider,issuer:this.connection.issuer,
            port:this.gateway.port,binary:this.ngrokBinary,authtoken,
            runDir:join(this.instance,'tunnel'),onEvent:log};
          this.tunnel=this.tunnelFactory?.(options) ?? createTunnelManager(this.tunnelConfig,options);
          await this.tunnel.start();
        }
      }
      this.lastStartOAuth=oauth;
      this.lastStartTunnel=tunnel;
      this.latestToken = this.gateway.token ?? null;
      this.record();
      return {...this.status,...(this.latestToken?{token:this.latestToken}:{})};
    } catch (error) {
      this.relay?.disable();
      await this.tunnel?.stop().catch(()=>{});
      this.tunnel=null;
      await this.gateway?.close().catch(() => {});
      await this.relay?.close().catch(() => {});
      await this.bridge?.close().catch(() => {});
      this.relay=null;
      this.gateway = null;
      this.bridge = null;
      this.latestToken = null;
      this.releaseOwner();
      throw error;
    } finally { this.starting = false; }
  }
  async stop() {
    if (!this.gateway && !this.bridge && !this.relay) {
      this.releaseOwner();
      return this.status;
    }
    this.relay?.disable();
    try { await this.tunnel?.stop(); }
    finally {
      this.tunnel=null;
      try { await this.gateway?.close(); }
      finally {
        try { await this.relay?.close(); }
        finally {
          this.relay=null;
          try { await this.bridge?.close(); }
          finally {
            this.gateway=null;
            this.bridge=null;
            this.latestToken=null;
            this.record();
            this.releaseOwner();
          }
        }
      }
    }
    return this.status;
  }
  async restart() {
    const oauth=this.lastStartOAuth,tunnel=this.lastStartTunnel;
    await this.stop();
    return this.start({oauth,tunnel});
  }
}
