import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { GeminiRunner } from './runner.mjs';
import { modes, toolSets } from './config.mjs';

const runtime = resolve(process.argv[2] ?? './test-runtime/gemini-c4');
const instance = process.argv[3] ?? 'gemini-c4';
const runner = new GeminiRunner(runtime, { id: instance, onEvent: () => {} });
const io = createInterface({ input: process.stdin, crlfDelay: Infinity });
let busy = false;
function reply(id, ok, payload) {
  process.stdout.write(JSON.stringify({
    protocol: 1, id, ok,
    ...(ok ? { result: payload } : { error: { code: String(payload) } })
  }) + '\n');
}
async function command(req) {
  if (!req || req.protocol !== 1 || typeof req.id !== 'string' ||
      !/^[A-Za-z0-9-]{1,64}$/.test(req.id)) return reply('invalid', false, 'INVALID_REQUEST');
  if (busy) return reply(req.id, false, 'BUSY');
  busy = true;
  try {
    const args = req.arguments ?? {};
    if (req.operation === 'state') return reply(req.id, true, runner.status);
    if (req.operation === 'capabilities') {
      return reply(req.id, true, {
        schema: 1,
        operations: ['state', 'capabilities', 'start', 'stop', 'restart', 'config.get', 'config.set',
          'connection.set', 'oauth.status', 'oauth.register', 'oauth.arm',
          'oauth.credentials', 'oauth.revoke', 'tunnel.check',
          'ngrok.token.set', 'ngrok.token.clear'],
        instance: runner.id, accessModes: modes, toolModes: toolSets,
        warning: 'Terminal mode has full Windows user permissions; Restricted limits file tools only'
      });
    }
    if (req.operation === 'config.get') return reply(req.id, true, runner.status.fileAccess);
    if (req.operation === 'config.set') {
      if (args.confirmed !== true) return reply(req.id, false, 'CONFIRMATION_REQUIRED');
      if (args.revision !== runner.status.fileAccess.revision)
        return reply(req.id, false, 'REVISION_CONFLICT');
      const { revision, confirmed, riskAcknowledged, ...target } = args;
      const elevated = target.accessMode === 'full' || target.toolMode === 'terminal';
      if (elevated && riskAcknowledged !== true)
        return reply(req.id, false, 'ELEVATED_CONFIRMATION_REQUIRED');
      target.elevatedAcknowledged = elevated;
      return reply(req.id, true, runner.setTarget(target).fileAccess);
    }
    if (req.operation === 'connection.set') {
      if (args.confirmed !== true) return reply(req.id, false, 'CONFIRMATION_REQUIRED');
      if (args.resetAuth === true && args.riskAcknowledged !== true)
        return reply(req.id, false, 'ELEVATED_CONFIRMATION_REQUIRED');
      const result = runner.setEndpoint(args.issuer,{clearExistingAuthorization:args.resetAuth===true});
      return reply(req.id,true,result.connection);
    }
    if (req.operation === 'ngrok.token.set') {
      if (args.confirmed !== true) return reply(req.id,false,'CONFIRMATION_REQUIRED');
      return reply(req.id,true,runner.setNgrokToken(args.authtoken));
    }
    if (req.operation === 'ngrok.token.clear') {
      if (args.confirmed !== true) return reply(req.id,false,'CONFIRMATION_REQUIRED');
      return reply(req.id,true,runner.clearNgrokToken());
    }
    if (req.operation === 'oauth.status') return reply(req.id,true,runner.status.connection);
    if (req.operation === 'tunnel.check') {
      if (!runner.tunnel) return reply(req.id,false,'TUNNEL_NOT_RUNNING');
      const verified=await runner.tunnel.recheck();
      return reply(req.id,true,{verified,...runner.tunnel.status()});
    }
    if (['oauth.register','oauth.arm','oauth.credentials','oauth.revoke'].includes(req.operation)) {
      if (args.confirmed !== true) return reply(req.id,false,'CONFIRMATION_REQUIRED');
      if (runner.status.connection.mode !== 'oauth')
        return reply(req.id,false,'OAUTH_GATEWAY_NOT_RUNNING');
      if (req.operation === 'oauth.register') {
        const registered=runner.gateway.registerManual(args.callbackUrl);
        return reply(req.id,true,{clientConfigured:true,updated:registered.updated});
      }
      if (req.operation === 'oauth.arm') return reply(req.id,true,runner.gateway.armApproval());
      if (req.operation === 'oauth.revoke') return reply(req.id,true,runner.gateway.revokeAll());
      if (args.showSecret !== true) return reply(req.id,false,'EXPLICIT_SECRET_DISPLAY_REQUIRED');
      return reply(req.id,true,runner.gateway.credentials());
    }
    if (['start', 'stop', 'restart'].includes(req.operation)) {
      if (args.confirmed !== true) return reply(req.id, false, 'CONFIRMATION_REQUIRED');
      if (req.operation !== 'stop' &&
          (runner.config.accessMode === 'full' || runner.config.terminal) &&
          args.riskAcknowledged !== true)
        return reply(req.id, false, 'ELEVATED_CONFIRMATION_REQUIRED');
      const status = req.operation === 'start' ?
        await runner.start({oauth:args.oauth===true,tunnel:args.tunnel===true}) : await runner[req.operation]();
      return reply(req.id, true, req.operation === 'stop' ?
        runner.status : { ...runner.status, hasEphemeralToken: Boolean(status.token) });
    }
    return reply(req.id, false, 'UNKNOWN_OPERATION');
  } catch (error) {
    return reply(req.id, false, error?.message ?? 'OPERATION_FAILED');
  } finally { busy = false; }
}
for await (const line of io) {
  let request;
  try { request = JSON.parse(line); }
  catch { reply('invalid', false, 'INVALID_REQUEST'); continue; }
  await command(request);
}
await runner.stop().catch(() => {});
