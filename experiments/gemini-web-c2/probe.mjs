import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createProbeOAuth } from './oauth.mjs';

const [id, kind = 'local', ttlText = '3600'] = process.argv.slice(2);
const ttl = Number(ttlText);
if (!/^[a-f0-9]{32}$/.test(id) || !['local', 'public', 'oauth'].includes(kind) ||
    !Number.isInteger(ttl) || ttl < 30 || ttl > 7200) throw new Error('Invalid experiment arguments');
const runtime = join(dirname(fileURLToPath(import.meta.url)), 'runtime', id);
mkdirSync(runtime, { recursive: true });
const statusPath = join(runtime, 'status.json');
const state = { id, kind, pid: process.pid, expiresUtc: new Date(Date.now() + ttl * 1000).toISOString() };
const save = () => writeFileSync(statusPath, JSON.stringify(state));
const log = event => appendFileSync(join(runtime, 'events.ndjson'),
  JSON.stringify({ utc: new Date().toISOString(), ...event }) + '\n');

const limit = 4096;
let active = 0;
let credits = 40;
let refill = Date.now();
async function serveMcp(req, res) {
  const reply = (status, body = {}) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  if (req.url !== '/mcp' || req.headers.origin) return reply(req.url === '/mcp' ? 403 : 404);
  if (req.method !== 'POST') return reply(405);
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415);
  if (Number(req.headers['content-length']) > limit) {
    res.setHeader('Connection', 'close');
    return reply(413);
  }
  const now = Date.now();
  credits = Math.min(40, credits + (now - refill) / 750);
  refill = now;
  if (active >= 8 || credits < 1) return reply(429);
  credits--;
  active++;
  let mcp;
  let transport;
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) {
        res.setHeader('Connection', 'close');
        return reply(413);
      }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!body || Array.isArray(body) || typeof body !== 'object') return reply(400);
    const version = req.headers['mcp-protocol-version'] ?? body.params?.protocolVersion;
    const method = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'].includes(body.method) ? body.method : 'other';
    const source = req.headers['x-ldc-probe-test'] === 'codex' ? 'self-test' :
      req.headers['cf-ray'] ? 'public-unattributed' : 'local-unattributed';
    log({ kind: 'request', source, authorized: Boolean(req.auth), method, protocol: /^20\d\d-\d\d-\d\d$/.test(version) ? version : null });
    mcp = new McpServer({ name: kind === 'oauth' ? 'LDC Gemini OAuth Probe' : 'LDC Gemini Probe', version: '0.1.0' });
    mcp.registerTool('ldc_probe', {
      description: 'Echo an experiment challenge and return a fresh random nonce from the server.',
      inputSchema: { challenge: z.string().min(1).max(96).regex(/^[A-Za-z0-9 _.-]+$/) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async ({ challenge }) => {
      const result = { challenge, nonce: randomUUID(), utc: new Date().toISOString(), callId: randomUUID() };
      log({ kind: 'result', source, authorized: Boolean(req.auth), nonce: result.nonce, callId: result.callId,
        challengeHash: createHash('sha256').update(challenge).digest('hex') });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) reply(500);
    else if (!res.writableEnded) res.end();
  } finally {
    try { await mcp?.close(); } finally { active--; }
  }
}
let oauth;
const server = createServer((req, res) => {
  if (kind !== 'oauth') return serveMcp(req, res);
  if (oauth) return oauth(req, res);
  res.writeHead(503).end();
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.setTimeout(10_000, socket => socket.destroy());
let tunnel;
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  tunnel?.kill();
  server.closeAllConnections();
  server.close();
  state.stoppedUtc = new Date().toISOString();
  save();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setTimeout(stop, ttl * 1000).unref();
server.listen(0, '127.0.0.1', () => {
  state.port = server.address().port;
  save();
  if (kind === 'local') return;
  const binary = join(runtime, '..', 'cloudflared.exe');
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    USERPROFILE: runtime, HOME: runtime, LOCALAPPDATA: runtime, APPDATA: runtime, TEMP: runtime, TMP: runtime };
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2',
    '--url', 'http://127.0.0.1:' + state.port], { cwd: runtime, env, windowsHide: true });
  state.tunnelPid = tunnel.pid;
  save();
  let tail = '';
  tunnel.stdout.resume();
  tunnel.stderr.on('data', data => {
    tail = (tail + data.toString()).slice(-4096);
    const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
    if (match && !state.publicUrl) {
      if (kind === 'oauth') {
        const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
        oauth = createProbeOAuth({ issuer: new URL(match[0]), serveMcp, log,
          getManualClient: () => {
            try { return read(join(runtime, 'manual-client.json')); } catch { return undefined; }
          },
          takePreapproval: (clientId, redirectUri) => {
            const path = join(runtime, 'preapproval.json');
            try {
              const approval = read(path);
              if (approval.clientId !== clientId || approval.redirectUri !== redirectUri ||
                  !Number.isInteger(approval.expiresAt) || approval.expiresAt <= Math.floor(Date.now() / 1000)) return false;
              unlinkSync(path);
              return true;
            } catch { return false; }
          },
        });
      }
      state.publicUrl = match[0] + '/mcp';
      save();
    }
    const failure = tail.split('\n').filter(line => /ERR|failed/i.test(line)).at(-1);
    if (failure) state.lastTunnelError = failure.slice(0, 320);
  });
  tunnel.on('error', error => {
    state.tunnelError = error.code;
    stop();
  });
  tunnel.on('exit', code => {
    state.tunnelExit = code;
    stop();
  });
});
