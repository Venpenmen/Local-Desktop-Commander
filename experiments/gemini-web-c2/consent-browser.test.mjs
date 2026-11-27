import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createProbeOAuth } from './oauth.mjs';

test('Browser polls without a form and navigates only after matching local approval', async () => {
  const callback = 'https://oauth-redirect.googleusercontent.com/r/ldc-c2-browser-test';
  const manual = { client_id: 'browser-test', client_secret: 'test-secret', redirect_uris: [callback] };
  const pending = new Map();
  const granted = new Map();
  let app;
  const server = createServer((req, res) => app(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = new URL('http://127.0.0.1:' + server.address().port);
  app = createProbeOAuth({ issuer, getManualClient: () => manual,
    publishApproval: request => pending.set(request.ticket, request),
    takeApproval: ticket => { const grant = granted.get(ticket); granted.delete(ticket); return grant; },
    serveMcp: (_req, res) => res.sendStatus(204), log: () => {},
  });
  const browser = await chromium.launch({ channel: process.env.LDC_TEST_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const authorize = issuer.origin + '/authorize?' + new URLSearchParams({
      client_id: manual.client_id, response_type: 'code', redirect_uri: callback, scope: 'probe',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    await page.goto(authorize);
    assert.equal(await page.locator('form').count(), 0);
    const ticket = await page.locator('code').textContent();
    await page.waitForURL(issuer.origin + '/approval/' + ticket);
    assert.equal(new URL(page.url()).origin, issuer.origin);
    const callbackRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.origin + url.pathname === callback && url.searchParams.has('code');
    }, { timeout: 10000 });
    granted.set(ticket, pending.get(ticket));
    assert.equal((await callbackRequest).method(), 'GET');
    assert.equal((await fetch(issuer.origin + '/approval/' + ticket)).status, 410);
  } finally {
    await browser.close();
    server.close();
  }
});
