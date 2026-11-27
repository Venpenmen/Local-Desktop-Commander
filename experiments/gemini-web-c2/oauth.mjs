import { randomBytes } from 'node:crypto';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const googleCallback = /^https:\/\/oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com\/[ra]\/[A-Za-z0-9._~-]+$/;
const random = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
export function createProbeOAuth({ issuer, publishApproval, takeApproval, serveMcp, log, getManualClient = () => undefined, tokenSeconds = 600 }) {
  const resource = new URL('/mcp', issuer);
  const clients = new Map();
  const pending = new Map();
  const codes = new Map();
  function waitPage(res, ticket) {
    const path = '/approval/' + ticket;
    return res.type('html').send('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=' + path +
      '"><title>Waiting for local approval</title><h1>Waiting for local approval</h1><p>Transaction <code>' +
      ticket + '</code></p><p>Copy the transaction to your local operator. This page updates automatically.</p>');
  }
  const tokens = new Map();
  const refreshGrants = new Map();
  const get = (map, key) => {
    const entry = map.get(key);
    if (entry?.expiresAt > now()) return entry;
    map.delete(key);
  };
  const add = (map, key, entry, max = 48) => {
    for (const ref of map.keys()) get(map, ref);
    if (map.size >= max) throw new InvalidRequestError('Experiment capacity reached');
    map.set(key, entry);
  };
  const assertResource = requested => {
    if (requested && requested.href !== resource.href) throw new InvalidTargetError('Unrecognized resource');
  };
  const findCode = (client, code) => {
    const grant = get(codes, code);
    if (grant?.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return grant;
  };
  function issueAccess(refreshToken, grant) {
    const token = random();
    const lifetime = Math.min(tokenSeconds, grant.expiresAt - now());
    if (lifetime <= 0) throw new InvalidGrantError('Expired refresh grant');
    add(tokens, token, { token, refreshToken, clientId: grant.clientId, scopes: ['probe'], resource, expiresAt: now() + lifetime });
    log({ kind: 'oauth', event: 'access-issued' });
    return { access_token: token, token_type: 'Bearer', expires_in: lifetime, scope: 'probe', refresh_token: refreshToken };
  }
  const provider = {
    clientsStore: {
      getClient: id => {
        const manual = getManualClient();
        return manual?.client_id === id ? manual : get(clients, id)?.client;
      },
      async registerClient(client) {
        if (client.redirect_uris.length !== 1 || !googleCallback.test(client.redirect_uris[0]) ||
            ![undefined, 'none', 'client_secret_post', 'client_secret_basic'].includes(client.token_endpoint_auth_method)) {
          throw new InvalidClientMetadataError('Register one supported Google HTTPS callback and authentication method');
        }
        client.token_endpoint_auth_method ??= 'client_secret_basic';
        add(clients, client.client_id, { client, expiresAt: now() + 7200 }, 20);
        log({ kind: 'oauth', event: 'client-registered' });
        return client;
      },
    },
    async authorize(client, params, res) {
      assertResource(params.resource);
      if (params.scopes.some(scope => scope !== 'probe')) throw new InvalidScopeError('Only probe scope is available');
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Expected an S256 challenge');
      const manual = getManualClient();
      if (!manual?.client_secret || manual.client_id !== client.client_id ||
          !manual.redirect_uris.includes(params.redirectUri)) throw new InvalidRequestError('Use the locally registered client');
      const ticket = random();
      const grant = { ...params, clientId: client.client_id, expiresAt: now() + 180 };
      add(pending, ticket, grant);
      publishApproval({ ticket, clientId: grant.clientId, redirectUri: grant.redirectUri, expiresAt: grant.expiresAt });
      log({ kind: 'oauth', event: 'local-approval-requested' });
      waitPage(res, ticket);
    },
    async challengeForAuthorizationCode(client, code) {
      return findCode(client, code).codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const grant = findCode(client, code);
      assertResource(requestedResource);
      if (redirectUri !== grant.redirectUri) throw new InvalidGrantError('Redirect URI mismatch');
      codes.delete(code);
      const refreshToken = random();
      const authorization = { clientId: client.client_id, expiresAt: now() + 1800 };
      add(refreshGrants, refreshToken, authorization);
      return issueAccess(refreshToken, authorization);
    },
    async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
      const grant = get(refreshGrants, refreshToken);
      if (grant?.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh grant');
      assertResource(requestedResource);
      if (scopes?.some(scope => scope !== 'probe')) throw new InvalidScopeError('Only probe scope is available');
      return issueAccess(refreshToken, grant);
    },
    async verifyAccessToken(token) {
      const auth = get(tokens, token);
      if (!auth || !get(refreshGrants, auth.refreshToken) || getManualClient()?.client_id !== auth.clientId) {
        throw new InvalidTokenError('Unknown, revoked or expired token');
      }
      return auth;
    },
    async revokeToken(client, request) {
      const refreshToken = get(tokens, request.token)?.refreshToken ?? request.token;
      if (get(refreshGrants, refreshToken)?.clientId === client.client_id) {
        refreshGrants.delete(refreshToken);
        log({ kind: 'oauth', event: 'access-revoked' });
      }
    },
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    const route = req.path;
    if (['/mcp','/register','/authorize','/token','/revoke','/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server'].includes(route)) {
      res.once('finish', () => log({ kind: 'oauth-http', route, method: req.method,
        source: req.headers['x-ldc-probe-test'] === 'codex' ? 'self-test' : req.headers['cf-ray'] ? 'public-unattributed' : 'local',
        status: res.statusCode, registrationMethod: route === '/register' &&
          ['none','client_secret_post','client_secret_basic'].includes(req.body?.token_endpoint_auth_method) ?
          req.body.token_endpoint_auth_method : undefined }));
    }
    if (req.url.length > 4096 || (req.path !== '/mcp' &&
        Number(req.headers['content-length']) > 4096)) return res.sendStatus(413);
    next();
  });
  app.get('/approval/:ticket', (req, res) => {
    const ticket = req.params.ticket;
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return res.sendStatus(404);
    const grant = get(pending, ticket);
    if (!grant) return res.status(410).type('text').send('Approval expired or already completed. Start again from Gemini.');
    const manual = getManualClient();
    if (manual?.client_id !== grant.clientId || !manual.redirect_uris.includes(grant.redirectUri)) {
      pending.delete(ticket);
      return res.sendStatus(403);
    }
    const approval = takeApproval(ticket);
    if (!approval) return waitPage(res, ticket);
    if (approval.ticket !== ticket || approval.clientId !== grant.clientId || approval.redirectUri !== grant.redirectUri ||
        !Number.isInteger(approval.expiresAt) || approval.expiresAt <= now() || approval.expiresAt > grant.expiresAt) {
      log({ kind: 'oauth', event: 'local-approval-rejected', reason: 'binding-or-expiry' });
      return res.sendStatus(403);
    }
    pending.delete(ticket);
    const code = random();
    try { add(codes, code, { ...grant, expiresAt: now() + 60 }); }
    catch { return res.sendStatus(429); }
    const redirect = new URL(grant.redirectUri);
    redirect.searchParams.set('code', code);
    if (grant.state !== undefined) redirect.searchParams.set('state', grant.state);
    log({ kind: 'oauth', event: 'local-approval-consumed' });
    return res.redirect(303, redirect.href);
  });
  const authRouter = mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource,
    scopesSupported: ['probe'], resourceName: 'LDC Gemini OAuth Probe', clientRegistrationOptions: { clientSecretExpirySeconds: 7200 } });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({ issuer: issuer.href, authorization_endpoint: new URL('/authorize', issuer),
      token_endpoint: new URL('/token', issuer), registration_endpoint: new URL('/register', issuer),
      revocation_endpoint: new URL('/revoke', issuer), response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'], scopes_supported: ['probe'] });
  });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({
    resource: resource.href, authorization_servers: [issuer.href], scopes_supported: ['probe'],
    resource_name: 'LDC Gemini OAuth Probe',
  }));
  app.post('/register', express.json({ limit: '4kb' }));
  // The SDK validates posted credentials. Normalize RFC 6749 Basic credentials once.
  app.post(['/token', '/revoke'], express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) return next();
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    const invalid = () => res.status(401).set('WWW-Authenticate', 'Basic realm="LDC Gemini Probe"').json({ error: 'invalid_client' });
    if (!match || !req.body || req.body.client_id !== undefined || req.body.client_secret !== undefined) return invalid();
    const pair = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = pair.indexOf(':');
    if (separator < 1) return invalid();
    try {
      const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
      req.body.client_id = decode(pair.slice(0, separator));
      req.body.client_secret = decode(pair.slice(separator + 1));
    } catch { return invalid(); }
    next();
  });
  app.use(authRouter);
  app.all('/mcp', requireBearerAuth({ verifier: provider, requiredScopes: ['probe'],
    expectedResource: resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) }), serveMcp);
  app.use((_req, res) => res.sendStatus(404));
  app.use((_error, _req, res, _next) => res.sendStatus(400));
  return app;
}
