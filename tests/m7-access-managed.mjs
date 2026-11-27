import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = path.join(source, 'test-runtime');
await fs.mkdir(scratch, { recursive: true });
const project = await fs.mkdtemp(path.join(scratch, 'access-loopback-'));
const engine = path.join(project, 'engine');
const management = path.join(project, 'management');
await fs.cp(path.join(source, 'management'), management, {
  recursive: true, filter: file => !['runtime', 'versions.json', 'instance.local.json'].includes(path.basename(file)),
});
await fs.mkdir(path.join(engine, 'workspace'), { recursive: true });
await fs.cp(path.join(source, 'engine/upstream/dist'), path.join(engine, 'upstream/dist'), { recursive: true });
await fs.symlink(path.join(source, 'engine/upstream/node_modules'), path.join(engine, 'upstream/node_modules'), 'junction');
await fs.copyFile(path.join(source, 'engine/upstream/package.json'), path.join(engine, 'upstream/package.json'));
for (const file of ['LocalDC.ps1', 'stdio.mjs']) {
  await fs.copyFile(path.join(source, 'engine', file), path.join(engine, file));
}
await fs.cp(path.join(source, 'transports/openai/bin'), path.join(project, 'transports/openai/bin'), { recursive: true });
await fs.copyFile(path.join(management, 'versions.example.json'), path.join(management, 'versions.json'));
await fs.writeFile(path.join(management, 'instance.local.json'), JSON.stringify({ schema: 1, id: 'access-fixture', transport: 'local-dev' }));
await fs.writeFile(path.join(engine, 'proxy.local.json'), JSON.stringify({ durationSeconds: 120 }));

const env = { ...process.env, LOCALAPPDATA: path.join(project, 'credentials') };
delete env.CONTROL_PLANE_API_KEY;
const powershell = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function rpc(operation, args) {
  const child = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(management, 'LDC-CLI.ps1')], { env, windowsHide: true, timeout: 30000, encoding: 'utf8',
    input: JSON.stringify({ protocol: 1, id: 'access-loopback', operation, arguments: args }) + '\n',
  });
  assert([0, 1].includes(child.status), child.stderr);
  return JSON.parse(child.stdout);
}
const checks = [];
try {
  const start = rpc('start', { confirmed: true });
  assert.equal(start.ok, true, JSON.stringify(start));
  let state;
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(350);
    state = rpc('state').result;
    if (state?.readiness.local && state?.fileAccess.actual) break;
  }
  assert.equal(state?.actual.state, 'running', JSON.stringify(state?.actual));
  assert.equal(state?.readiness.local, true);
  assert.equal(state?.fileAccess.actual?.mode, 'restricted');
  assert.equal(state.fileAccess.actual.allowedRoot, path.join(engine, 'workspace'));
  assert.equal(state.fileAccess.restartRequired, false);
  checks.push('managed loopback process reports effective policy, independently of target configuration');
  const denied = rpc('access.set', { version: 'p6', mode: 'full', confirmed: true, revision: state.configuration.revision });
  assert.equal(denied.error.code, 'ACCESS_UNAVAILABLE');
  const busy = rpc('root.set', { version: 'p6', path: path.join(engine, 'workspace'), confirmed: true, revision: state.configuration.revision });
  assert.equal(busy.error.code, 'ACCESS_BUSY');
  checks.push('active instance refuses live root change and development full access');
} finally {
  const stop = rpc('stop', { confirmed: true });
  const stopped = stop.ok && rpc('state').result.actual.state === 'stopped';
  if (stopped) checks.push('isolated instance stopped');
  await fs.writeFile(path.join(scratch, 'access-managed.json'), JSON.stringify({ utc: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ checks }));
  assert(stopped, 'Isolated instance did not stop');
}
