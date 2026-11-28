import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBridge } from './bridge.mjs';
import { createGateway } from './gateway.mjs';
import { configStatus, createInstance, writeAtomicJson } from './config.mjs';
import { createAuditLog } from './audit.mjs';

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export class GeminiRunner {
  constructor(runtime, { id = 'gemini-c4', onEvent = () => {}, timeout = 20000 } = {}) {
    this.runtime = resolve(runtime);
    this.id = id;
    this.onEvent = onEvent;
    this.timeout = timeout;
    this.instance = join(this.runtime, this.id);
    this.config = createInstance(this.runtime, id);
    this.audit = createAuditLog(this.instance);
    this.auditHealthy = true;
    this.bridge = null;
    this.gateway = null;
    this.starting = false;
    this.latestToken = null;
    this.owner = null;
    this.stateFile = join(this.instance, 'state.json');
    this.targetFile = join(this.instance, 'target.json');
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
  async start() {
    if (this.gateway || this.starting) throw Error('ALREADY_RUNNING');
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
      this.gateway = await createGateway(this.bridge, {
        timeout: this.timeout, onEvent: log
      });
      this.latestToken = this.gateway.token;
      this.record();
      return { ...this.status, token: this.latestToken };
    } catch (error) {
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
    return this.status;
  }
  async restart() {
    await this.stop();
    return this.start();
  }
}
