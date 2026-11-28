import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBridge } from './bridge.mjs';
import { createGateway } from './gateway.mjs';
import { createOAuthGateway } from './oauth-gateway.mjs';
import { createSecretStore } from './secret-store.mjs';
import { createNgrokSupervisor } from './ngrok-agent.mjs';
import { configStatus, createInstance, writeAtomicJson } from './config.mjs';
import { createAuditLog } from './audit.mjs';

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export class GeminiRunner {
  constructor(runtime, { id = 'gemini-c4', onEvent = () => {}, timeout = 20000,
    tunnelFactory, ngrokBinary } = {}) {
    this.runtime = resolve(runtime);
    this.id = id;
    this.onEvent = onEvent;
    this.timeout = timeout;
    this.tunnelFactory = tunnelFactory;
    this.ngrokBinary = ngrokBinary ?? join(this.runtime,'bin','ngrok.exe');
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
        publicTunnel: this.tunnel?.status() ?? {state:'stopped',verified:false},
        ngrokTokenConfigured:this.ngrokTokenConfigured },
      recoveredFromInterrupted: this.recoveredFromInterrupted,
      auditHealthy: this.auditHealthy
    };
  }
  setTarget(target) {
    if (this.gateway || this.starting) throw Error('STOP_BEFORE_CHANGE');
    const next = createInstance(this.runtime, this.id, target);
    writeAtomicJson(this.targetFile, next);
    this.config = next;
    this.record();
    return this.status;
  }
  setEndpoint(issuer,{clearExistingAuthorization=false}={}) {
    if (this.gateway || this.starting) throw Error('STOP_BEFORE_CHANGE');
    let url;
    try { url = new URL(issuer); } catch { throw Error('INVALID_HTTPS_ISSUER'); }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.'))
      throw Error('INVALID_HTTPS_ISSUER');
    const previous = createSecretStore(this.instance).read();
    if (previous.issuer && previous.issuer !== url.origin && !clearExistingAuthorization)
      throw Error('ISSUER_CHANGE_REQUIRES_REAUTHORIZE');
    if (previous.issuer && previous.issuer !== url.origin && clearExistingAuthorization)
      createSecretStore(this.instance).clear();
    this.connection = { schema:1, issuer:url.origin };
    writeAtomicJson(this.connectionFile,this.connection);
    this.record();
    return this.status;
  }
  setNgrokToken(authtoken){
    if(this.gateway||this.starting)throw Error('STOP_BEFORE_CHANGE');
    if(typeof authtoken!=='string'||!/^[-A-Za-z0-9_]{20,512}$/.test(authtoken))
      throw Error('INVALID_NGROK_TOKEN');
    createSecretStore(this.instance,'tunnel-secret.dpapi').save({authtoken});
    this.ngrokTokenConfigured=true;
    this.record();
    return {configured:true};
  }
  clearNgrokToken(){
    if(this.gateway||this.starting)throw Error('STOP_BEFORE_CHANGE');
    createSecretStore(this.instance,'tunnel-secret.dpapi').clear();
    this.ngrokTokenConfigured=false;
    this.record();
    return {configured:false};
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
    if (oauth && !this.connection?.issuer) throw Error('OAUTH_ISSUER_NOT_CONFIGURED');
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
      this.gateway = oauth ? await createOAuthGateway(this.bridge,this.instance,{
        issuer:new URL(this.connection.issuer),
        configRevision:configStatus(this.config,this.config).revision,
        timeout:this.timeout,onEvent:log
      }) : await createGateway(this.bridge,{
        timeout:this.timeout,onEvent:log
      });
      this.lastStartOAuth = oauth;
      this.lastStartTunnel = tunnel;
      if(tunnel){
        const authtoken=createSecretStore(this.instance,'tunnel-secret.dpapi').read().authtoken;
        const options={issuer:this.connection.issuer,port:this.gateway.port,
          binary:this.ngrokBinary,authtoken,runDir:join(this.instance,'tunnel'),onEvent:log};
        this.tunnel=this.tunnelFactory?.(options) ?? createNgrokSupervisor(options);
        await this.tunnel.start();
      }
      this.latestToken = this.gateway.token ?? null;
      this.record();
      return {...this.status,...(this.latestToken?{token:this.latestToken}:{})};
    } catch (error) {
      await this.tunnel?.stop().catch(()=>{});
      this.tunnel=null;
      await this.gateway?.close().catch(() => {});
      await this.bridge?.close().catch(() => {});
      this.gateway = null;
      this.bridge = null;
      this.latestToken = null;
      this.releaseOwner();
      throw error;
    } finally { this.starting = false; }
  }
  async stop() {
    if (!this.gateway && !this.bridge) {
      this.releaseOwner();
      return this.status;
    }
    try { await this.tunnel?.stop(); }
    finally {
      this.tunnel=null;
      try { await this.gateway?.close(); }
      finally {
        try { await this.bridge?.close(); }
        finally {
          this.gateway = null;
          this.bridge = null;
          this.latestToken = null;
          this.record();
          this.releaseOwner();
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
