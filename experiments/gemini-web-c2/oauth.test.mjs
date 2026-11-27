import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProbeOAuth } from './oauth.mjs';

test('OAuth metadata, exact redirect, consent, PKCE, audience, expiry and revocation', async () => {
  const external = process.env.LDC_C2_OAUTH_URL;
  const run = process.env.LDC_C2_RUN;
  if (external) assert.match(run, /^[a-f0-9]{32}$/);
  const dir = external && new URL('./runtime/' + run + '/', import.meta.url);
  const redirect = 'https://oauth-redirect.googleusercontent.com/r/ldc-c2-self-test';
  const manual = external ? JSON.parse(await readFile(new URL('manual-client.json', dir), 'utf8')) :
    { client_id: 'test-manual', client_secret: 'test-secret', redirect_uris: [redirect] };
  const requests = new Map();
  const grants = new Map();
  const issuer = new URL(external || 'https://example.test');
  const internal = !external && createServer(createProbeOAuth({
    issuer, getManualClient: () => manual, publishApproval: request => requests.set(request.ticket, request),
    takeApproval: ticket => { const grant = grants.get(ticket); grants.delete(ticket); return grant; },
    serveMcp: (_req, res) => res.sendStatus(204), log: () => {}, tokenSeconds: 2,
  }));
  if (internal) {
    internal.listen(0, '127.0.0.1');
    await once(internal, 'listening');
  }
  const base = external ? issuer.origin : 'http://127.0.0.1:' + internal.address().port;
  const resource = new URL('/mcp', issuer).href;
  const headers = { 'x-ldc-probe-test': 'codex' };
  const proxy = external && process.env.LDC_C2_TEST_PROXY ? new ProxyAgent(process.env.LDC_C2_TEST_PROXY) : undefined;
  const request = (path, init = {}) => fetch(base + path, {
    dispatcher: proxy,
    ...init, headers: { ...headers, ...init.headers }, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  const form = (path, values) => request(path, { method: 'POST', body: new URLSearchParams(values) });
  const register = values => request('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
  });
  const checks = [];
  let client;
  try {
    const unauthorized = await request('/mcp');
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
    assert.equal((await request('/mcp', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
    const protectedResource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(protectedResource.resource, resource);
    assert.deepEqual(protectedResource.authorization_servers, [metadata.issuer]);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal((await register({ redirect_uris: [redirect + '/../../other'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['https://example.org/return'] })).status, 400);
    assert.equal((await request('/.well-known/oauth-protected-resource')).status, 200);
    assert.equal((await register({ redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' })).status, 201);
    const registered = await register({ redirect_uris: [redirect] });
    assert.equal(registered.status, 201);
    const identity = await registered.json();
    assert.equal(identity.token_endpoint_auth_method, 'client_secret_basic');
    const credentials = { client_id: manual.client_id, client_secret: manual.client_secret };
    const actualRedirect = manual.redirect_uris[0];
    const basic = { Authorization: 'Basic ' + Buffer.from(credentials.client_id + ':' + credentials.client_secret).toString('base64') };
    const basicForm = (route, fields, authentication = basic) => request(route, {
      method: 'POST', headers: authentication, body: new URLSearchParams(fields),
    });

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = (extra = {}) => request('/authorize?' + new URLSearchParams({
      client_id: credentials.client_id, redirect_uri: actualRedirect, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'probe', state: 'test-state', ...extra,
    }));
    assert.equal((await authorize({ redirect_uri: actualRedirect + '-different' })).status, 400);
    assert.match((await authorize({ scope: 'files.read' })).headers.get('location'), /invalid_scope/);
    assert.match((await authorize({ code_challenge_method: 'plain' })).headers.get('location'), /invalid_request/);
    async function ticket() {
      const response = await authorize();
      assert.equal(response.status, 200);
      const ticket = (await response.text()).match(/\/approval\/([A-Za-z0-9_-]{43})/)?.[1];
      assert(ticket);
      return ticket;
    }
    const transaction = await ticket();
    const path = '/approval/' + transaction;
    const waiting = await request(path);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.headers.get('location'), null);
    assert.equal((await form('/consent', { ticket: transaction })).status, 404);
    if (external) {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('Run.ps1', import.meta.url)), 'Approve', '-Id', run, '-Transaction', transaction], { windowsHide: true });
    } else {
      for (const incorrect of [{ clientId: 'wrong' }, { expiresAt: 1 }]) {
        const separate = await ticket();
        grants.set(separate, { ...requests.get(separate), ...incorrect });
        assert.equal((await request('/approval/' + separate)).status, 403);
      }
      grants.set(transaction, requests.get(transaction));
    }
    const accepted = await request(path);
    assert.equal(accepted.status, 303);
    assert.equal((await request(path)).status, 410);
    const callback = new URL(accepted.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    const code = callback.searchParams.get('code');
    assert(code);
    const tokenGrant = { ...credentials, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: actualRedirect, resource };
    for (const invalid of [{ client_secret: 'wrong' }, { code_verifier: 'wrong' },
      { redirect_uri: actualRedirect + '-different' }, { resource: issuer.origin + '/wrong' }]) {
      assert.equal((await form('/token', { ...tokenGrant, ...invalid })).status, 400);
    }
    const { client_id: _id, client_secret: _secret, ...basicGrant } = tokenGrant;
    assert.equal((await basicForm('/token', tokenGrant)).status, 401);
    const issued = await basicForm('/token', basicGrant);
    assert.equal(issued.status, 200);
    const { access_token: token } = await issued.json();
    assert(token);
    const auth = { Authorization: 'Bearer ' + token };
    if (external) {
      client = new Client({ name: 'ldc-codex-oauth-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(external), { fetch: (input, options) => fetch(input, { ...options, dispatcher: proxy }), requestInit: { headers: { ...headers, ...auth } } }));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ldc_probe']);
      const result = await client.callTool({ name: 'ldc_probe', arguments: { challenge: 'OAUTH-SELF-TEST' } });
      assert.equal(result.structuredContent.challenge, 'OAUTH-SELF-TEST');
      const logs = await readFile(new URL('events.ndjson', dir), 'utf8');
      assert(logs.trim().split('\n').map(JSON.parse).some(item => item.kind === 'result' && item.authorized &&
        item.source === 'self-test' && item.callId === result.structuredContent.callId));
      assert.equal((await basicForm('/revoke', { token })).status, 200);
    } else {
      assert.equal((await request('/mcp', { headers: auth })).status, 204);
      await delay(2100);
    }
    assert.equal((await request('/mcp', { headers: auth })).status, 401);
    assert.equal((await form('/token', tokenGrant)).status, 400);
    checks.push('metadata', 'uncredentialed and invalid bearer rejection', 'registration and exact redirect',
      'local approval binding, one-time consumption and S256 PKCE', 'wrong target and scope rejection', 'one-use authorization code',
      external ? 'protected live MCP call and token revocation' : 'token expiry');
  } finally {
    await client?.close();
    if (internal) internal.close();
    await proxy?.close();
    if (external) await writeFile(new URL('oauth-self-test.json', dir), JSON.stringify({ checks, utc: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ scope: external ? 'public' : 'local', checks }));
  }
});
