import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fetch, ProxyAgent } from 'undici';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createProbeOAuth } from './oauth.mjs';

test('Chromium submits an actual URL-encoded consent form with a verifiable origin', async () => {
  const external = process.env.LDC_C2_BROWSER_URL;
  const run = process.env.LDC_C2_RUN;
  if (external) assert.match(run, /^[a-f0-9]{32}$/);
  const runtime = external && new URL('./runtime/' + run + '/', import.meta.url);
  const started = Date.now();
  const approvalKey = external ? await readFile(new URL('approval-key.txt', runtime), 'utf8') : randomBytes(24).toString('base64url');
  const evidence = [];
  let app;
  const server = !external && createServer((req, res) => app(req, res));
  if (server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const issuer = new URL(external || 'http://127.0.0.1:' + server.address().port);
  if (server) app = createProbeOAuth({ issuer, approvalKey, serveMcp: (_req, res) => res.sendStatus(204), log: event => evidence.push(event) });
  const proxy = external && process.env.LDC_C2_TEST_PROXY;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const browser = await chromium.launch({ channel: process.env.LDC_TEST_BROWSER || 'msedge', headless: true,
    proxy: proxy ? { server: proxy } : undefined });
  async function observed() {
    if (!external) return evidence;
    const logs = await readFile(new URL('events.ndjson', runtime), 'utf8');
    return logs.trim().split('\n').map(JSON.parse).filter(event => Date.parse(event.utc) >= started);
  }
  try {
    const callback = 'https://oauth-redirect.googleusercontent.com/r/ldc-c2-browser-test';
    const registered = await fetch(new URL('/register', issuer), {
      method: 'POST', dispatcher, headers: { 'Content-Type': 'application/json', 'x-ldc-probe-test': 'codex' },
      body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' }),
    });
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const authorize = issuer.origin + '/authorize?' + new URLSearchParams({
      client_id, response_type: 'code', redirect_uri: callback, scope: 'probe',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const page = await browser.newPage({ extraHTTPHeaders: { 'x-ldc-probe-test': 'codex' } });
    async function submit(expected, key) {
      await page.locator('input[name="approval"]').fill(key);
      const response = page.waitForResponse(response => response.url() === issuer.origin + '/consent');
      await page.locator('button').click().catch(error => {
        if (!String(error).includes('ERR_FAILED')) throw error;
      });
      const post = await response;
      assert.equal(post.status(), expected);
      assert.match(await post.request().headerValue('content-type'), /^application\/x-www-form-urlencoded/);
      assert.deepEqual([...new URLSearchParams(post.request().postData()).keys()].sort(), ['approval', 'interaction', 'ticket']);
      return post;
    }
    const oldPolicy = async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'referrer-policy': 'no-referrer' } });
    };
    await page.route('**/authorize?**', oldPolicy);
    await page.goto(authorize);
    const old = await submit(400, approvalKey);
    assert.equal(await old.request().headerValue('origin'), 'null');
    assert((await observed()).some(event => event.reason === 'origin-mismatch' && event.origin === 'opaque'));
    await page.unroute('**/authorize?**', oldPolicy);
    const fixed = await page.goto(authorize);
    assert.equal(await fixed.headerValue('referrer-policy'), 'origin');
    await submit(403, 'wrong-approval-key');
    assert((await observed()).some(event => event.reason === 'approval-rejected'));
    await page.goto(authorize);
    const accepted = await submit(200, approvalKey);
    assert.equal(await accepted.request().headerValue('origin'), issuer.origin);
    assert((await observed()).some(event => event.event === 'consent-approved'));
    const callbackRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.origin + url.pathname === callback && url.searchParams.has('code');
    }, { timeout: 7000 });
    await page.getByRole('link', { name: 'Continue to Google' }).click();
    assert.equal((await callbackRequest).method(), 'GET');
  } finally {
    await browser.close();
    if (server) server.close();
    await dispatcher?.close();
  }
});
