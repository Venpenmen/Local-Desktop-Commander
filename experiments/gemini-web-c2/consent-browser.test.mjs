import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createProbeOAuth } from './oauth.mjs';

test('Browser navigates directly to Google only with a matching local preapproval', async () => {
  const callback = 'https://oauth-redirect.googleusercontent.com/r/ldc-c2-browser-test';
  const manual = { client_id: 'browser-test', client_secret: 'test-secret', redirect_uris: [callback] };
  let armed = false;
  let app;
  const server = createServer((req, res) => app(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = new URL('http://127.0.0.1:' + server.address().port);
  app = createProbeOAuth({ issuer, getManualClient: () => manual,
    takePreapproval: (id, uri) => {
      if (!armed || id !== manual.client_id || uri !== callback) return false;
      armed = false;
      return true;
    },
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
    assert.equal((await page.goto(authorize)).status(), 403);
    armed = true;
    const callbackRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.origin + url.pathname === callback && url.searchParams.has('code');
    }, { timeout: 10000 });
    await page.goto(authorize).catch(() => {});
    assert.equal((await callbackRequest).method(), 'GET');
    assert.equal((await fetch(authorize, { redirect: 'manual' })).status, 403);
  } finally {
    await browser.close();
    server.close();
  }
});
