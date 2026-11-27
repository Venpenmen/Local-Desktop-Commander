import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
  const approvalKey = external ? await readFile(new URL('approval-key.txt', dir), 'utf8') : randomBytes(24).toString('base64url');
  const issuer = new URL(external || 'https://example.test');
  const internal = !external && createServer(createProbeOAuth({
    issuer, approvalKey, serveMcp: (_req, res) => res.sendStatus(204), log: () => {}, tokenSeconds: 2,
  }));
  if (internal) {
    internal.listen(0, '127.0.0.1');
    await once(internal, 'listening');
  }
  const base = external ? issuer.origin : 'http://127.0.0.1:' + internal.address().port;
  const resource = new URL('/mcp', issuer).href;
  const redirect = 'https://oauth-redirect.googleusercontent.com/r/ldc-c2-self-test';
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
    const registered = await register({ redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' });
    assert.equal(registered.status, 201);
    const identity = await registered.json();
    const credentials = { client_id: identity.client_id, client_secret: identity.client_secret };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = (extra = {}) => request('/authorize?' + new URLSearchParams({
      client_id: credentials.client_id, redirect_uri: redirect, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'probe', state: 'test-state', ...extra,
    }));
    assert.equal((await authorize({ redirect_uri: redirect + '-different' })).status, 400);
    assert.match((await authorize({ scope: 'files.read' })).headers.get('location'), /invalid_scope/);
    assert.match((await authorize({ code_challenge_method: 'plain' })).headers.get('location'), /invalid_request/);
    const getTicket = async () => {
      const consent = await authorize();
      assert.equal(consent.status, 200);
      const ticket = (await consent.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
      assert(ticket);
      return ticket;
    };
    assert.equal((await form('/consent', { ticket: await getTicket(), approval: 'wrong' })).status, 403);
    const accepted = await form('/consent', { ticket: await getTicket(), approval: approvalKey });
    assert.equal(accepted.status, 303);
    const callback = new URL(accepted.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'test-state');
    const code = callback.searchParams.get('code');
    assert(code);
    const tokenGrant = { ...credentials, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, resource };
    for (const invalid of [{ client_secret: 'wrong' }, { code_verifier: 'wrong' },
      { redirect_uri: redirect + '-different' }, { resource: issuer.origin + '/wrong' }]) {
      assert.equal((await form('/token', { ...tokenGrant, ...invalid })).status, 400);
    }
    const issued = await form('/token', tokenGrant);
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
      assert.equal((await form('/revoke', { ...credentials, token })).status, 200);
    } else {
      assert.equal((await request('/mcp', { headers: auth })).status, 204);
      await delay(2100);
    }
    assert.equal((await request('/mcp', { headers: auth })).status, 401);
    assert.equal((await form('/token', tokenGrant)).status, 400);
    checks.push('metadata', 'uncredentialed and invalid bearer rejection', 'registration and exact redirect',
      'consent and S256 PKCE', 'wrong target and scope rejection', 'one-use authorization code',
      external ? 'protected live MCP call and token revocation' : 'token expiry');
  } finally {
    await client?.close();
    if (internal) internal.close();
    await proxy?.close();
    if (external) await writeFile(new URL('oauth-self-test.json', dir), JSON.stringify({ checks, utc: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ scope: external ? 'public' : 'local', checks }));
  }
});
