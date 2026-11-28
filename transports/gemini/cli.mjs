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
        operations: ['state', 'capabilities', 'start', 'stop', 'restart', 'config.get', 'config.set'],
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
    if (['start', 'stop', 'restart'].includes(req.operation)) {
      if (args.confirmed !== true) return reply(req.id, false, 'CONFIRMATION_REQUIRED');
      if (req.operation !== 'stop' &&
          (runner.config.accessMode === 'full' || runner.config.terminal) &&
          args.riskAcknowledged !== true)
        return reply(req.id, false, 'ELEVATED_CONFIRMATION_REQUIRED');
      const status = await runner[req.operation]();
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
