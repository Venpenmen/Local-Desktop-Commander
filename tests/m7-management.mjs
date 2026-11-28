import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = path.join(source, 'test-runtime');
await fs.mkdir(scratch, { recursive: true });
const project = await fs.mkdtemp(path.join(scratch, 'm7 中文 fixtures '));
const management = path.join(project, 'management');
await fs.cp(path.join(source, 'management'), management, {
  recursive: true, filter: file => !['runtime', 'versions.json', 'instance.local.json'].includes(path.basename(file)),
});
await fs.cp(path.join(source, 'transports/openai/manifest.json'), path.join(project, 'transports/openai/manifest.json'));
await fs.copyFile(path.join(management, 'versions.example.json'), path.join(management, 'versions.json'));

const env = { ...process.env, LOCALAPPDATA: path.join(project, 'appdata') };
delete env.CONTROL_PLANE_API_KEY;
const shell = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const options = { cwd: project, env, windowsHide: true, encoding: 'utf8', timeout: 45000 };
const file = (name, ...args) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, name), ...args];
const report = { utc: new Date().toISOString(), cases: [] };
const pass = name => report.cases.push({ name, result: 'PASS' });
function request(operation, args, protocol = 1) {
  const run = spawnSync(shell, file('management/LDC-CLI.ps1'), {
    ...options, input: JSON.stringify({ id: 'test', protocol, operation, arguments: args }) + '\n',
  });
  assert([0, 1].includes(run.status), run.stderr);
  const reply = JSON.parse(run.stdout);
  assert.equal(reply.ok, run.status === 0, run.stderr);
  return reply;
}
function result(operation, args) {
  const reply = request(operation, args);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}
let tunnel;
try {
  const first = result('state');
  assert.equal(first.actual.state, 'stopped');
  assert.equal(first.transports[0].credentials.configured, false);
  assert.equal(first.readiness.remoteInvocation, 'unverified');
  assert.equal(result('capabilities').protocol, 1);
  assert.equal(request('state', {}, 2).error.code, 'UNSUPPORTED_PROTOCOL');
  assert.equal(request('credential.configure').error.code, 'INTERACTIVE_REQUIRED');
  assert.equal(result('extensions')[0].id, 'openai');
  pass('protocol, discovery and secret boundary');

  const manifest = path.join(project, 'transports/openai/manifest.json');
  const original = await fs.readFile(manifest, 'utf8');
  await fs.writeFile(manifest, JSON.stringify({ ...JSON.parse(original), entry: '../outside.ps1' }));
  assert.equal(request('extensions').error.code, 'INVALID_MANIFEST');
  await fs.writeFile(manifest, original);
  await fs.writeFile(path.join(project, 'adapter.ps1'), [
    ". (Join-Path $PSScriptRoot 'management/LDC.ps1')",
    'Initialize-LdcRegistry',
    "$script:LdcAdapters['fixture'] = @{describe={@{id='fixture';contract=1;engineProtocol='mcp-stdio';capabilities=@('health')}}}",
    "(Invoke-LdcRequest @{protocol=1;id='fixture';operation='capabilities'}).result.transports | ConvertTo-Json -Compress -Depth 8",
  ].join('\n'));
  const discovery = spawnSync(shell, file('adapter.ps1'), options);
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.deepEqual(JSON.parse(discovery.stdout).map(adapter => adapter.id), ['openai', 'fixture']);
  pass('test adapter discovery and extension traversal rejection');

  const { revision } = first.configuration;
  assert.equal(request('select', { version: 'p6', mode: 'terminal', revision }).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(result('select', { version: 'p6', mode: 'terminal', revision, confirmed: true }).state, 'completed');
  assert.equal(request('network.set', { confirmed: true, revision, proxy: '127.0.0.1:5555' }).error.code, 'REVISION_CONFLICT');
  const current = result('config.get');
  assert.notEqual(current.revision, revision);
  assert.equal(current.target.mode, 'terminal');
  assert.equal(request('network.set', { confirmed: true, revision: current.revision, proxy: 'example.com:5555' }).error.code, 'INVALID_ARGUMENT');
  assert.equal(request('start', { confirmed: true }).error.code, 'OPERATION_FAILED');
  assert.equal(result('task.get').state, 'failed');
  assert.equal(request('rollback', { confirmed: true }).error.code, 'OPERATION_FAILED');
  assert.equal(result('config.get').target.mode, 'terminal');
  const taskPath = path.join(management, 'runtime/task.json');
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  await fs.writeFile(taskPath, JSON.stringify({ ...task, state: 'running', owner: process.pid, birth: 1 }));
  assert.equal(result('task.get').state, 'interrupted');
  assert.equal(result('state').actual.state, 'stopped');
  pass('CAS, validation, failed-start evidence and recovery');

  await fs.writeFile(path.join(project, 'hold.ps1'), [
    ". (Join-Path $PSScriptRoot 'management/LDC.ps1')",
    'Initialize-LdcRegistry',
    "Invoke-LdcLocked { [Console]::WriteLine('locked'); $null = [Console]::ReadLine() }",
  ].join('\n'));
  const holder = spawn(shell, file('hold.ps1'), options);
  const holderExit = once(holder, 'exit');
  try {
    assert.match(String((await once(holder.stdout, 'data'))[0]), /locked/);
    assert.equal(request('start', { confirmed: true }).error.code, 'BUSY');
    assert.equal(result('state').configuration.target.mode, 'terminal');
    const consoleStatus = spawnSync(shell, file('management/LDC.ps1', '-Action', 'Status'), options);
    assert.equal(consoleStatus.status, 0, consoleStatus.stderr);
    assert.match(consoleStatus.stdout, /完整终端模式/);
  } finally {
    holder.stdin.end('\n');
    await holderExit;
  }
  pass('independent clients and TUI share state and cross-process exclusion');

  const exe = path.join(project, 'transports/openai/bin/tunnel-client.exe');
  await fs.mkdir(path.dirname(exe));
  await fs.writeFile(path.join(project, 'fixture.ps1'), [
    "$ErrorActionPreference = 'Stop'",
    "$source = 'public class Fixture { public static void Main(string[] args) { if (args.Length == 10 && args[9] == fixtureFlag) System.IO.File.WriteAllText(args[4], System.Diagnostics.Process.GetCurrentProcess().Id.ToString()); System.Threading.Thread.Sleep(60000); } private const string fixtureFlag = \"fixture\"; }'",
    "Add-Type -TypeDefinition $source -OutputAssembly (Join-Path $PSScriptRoot 'transports/openai/bin/tunnel-client.exe') -OutputType ConsoleApplication",
  ].join('\n'));
  const build = spawnSync(shell, file('fixture.ps1'), options);
  assert.equal(build.status, 0, build.stderr);
  const runtime = path.join(project, 'engine/runtime');
  await fs.mkdir(runtime, { recursive: true });
  const pidPath = path.join(runtime, 'tunnel.pid');
  tunnel = spawn(exe, ['run', '--profile-file', path.join(project, 'engine/profile.local.yaml'),
    '--pid.file', pidPath, '--health.url-file', path.join(runtime, 'health.url'),
    '--log.file', path.join(runtime, 'tunnel.log')], options);
  const exit = once(tunnel, 'exit');
  await fs.writeFile(pidPath, String(tunnel.pid));
  await fs.utimes(pidPath, new Date(0), new Date(0));
  assert.equal(result('state').actual.state, 'unsafe');
  assert.equal(request('stop', { confirmed: true }).error.code, 'OPERATION_FAILED');
  assert.equal(tunnel.exitCode, null);
  await fs.writeFile(pidPath, String(tunnel.pid));
  assert.equal(result('state').actual.pid, tunnel.pid);
  assert.equal(result('state').actual.state, 'running');
  assert.equal(request('start', { confirmed: true }).error.code, 'OPERATION_FAILED');
  assert.equal(result('stop', { confirmed: true }).state, 'completed');
  await exit;
  assert.equal(result('state').actual.state, 'stopped');
  assert(result('events').some(event => event.kind === 'stopped'));
  pass('real fixture process, stale PID rejection, duplicate start, verified stop');

  const core = path.join(management, 'LDC-Core.ps1');
  const originalCore = await fs.readFile(core, 'utf8');
  const fixtureWorker = originalCore.replace("else { 'Normal' }", "else { 'Hidden' }")
    .replace('& $script:LdcAdapters.openai.launch $version $RunMode', [
      '$fixtureArgs = @("run", "--profile-file", $version.Profile, "--pid.file", $version.PidFile,',
      '    "--health.url-file", $version.HealthFile, "--log.file", $version.LogFile, "fixture")',
      '& $script:Tunnel @fixtureArgs',
    ].join('\n'));
  await fs.writeFile(core, fixtureWorker);
  const definition = JSON.parse((await fs.readFile(path.join(management, 'versions.json'), 'utf8')).trimStart());
  delete definition.versions[0].rootValidator;
  delete definition.versions[0].rootConfig;
  definition.launchMutex = 'Local\\Ldc-M7-Fixture-' + process.pid;
  await fs.writeFile(path.join(management, 'versions.json'), JSON.stringify(definition));
  await fs.mkdir(path.join(project, 'engine/workspace'), { recursive: true });
  await fs.mkdir(path.join(project, 'engine/upstream/dist'), { recursive: true });
  for (const fileName of ['LocalDC.ps1', 'profile.local.yaml', 'upstream/dist/index.js']) {
    await fs.writeFile(path.join(project, 'engine', fileName), '');
  }
  try {
    assert.equal(result('start', { confirmed: true }).state, 'completed');
    const launched = result('state');
    assert.equal(launched.actual.state, 'running');
    assert.equal(launched.actual.mode, 'terminal');
    assert.equal(result('restart', { confirmed: true }).state, 'completed');
    const restarted = result('state');
    assert.equal(restarted.actual.state, 'running');
    assert.notEqual(restarted.actual.birth, launched.actual.birth);
    assert.equal(result('rollback', { confirmed: true }).state, 'completed');
    assert.equal(result('state').actual.mode, 'files');
  } finally {
    result('stop', { confirmed: true });
  }
  assert.equal(result('state').actual.state, 'stopped');
  pass('isolated worker lifecycle, restart, rollback, and service survives CLI exit');
} finally {
  if (tunnel && tunnel.exitCode === null) tunnel.kill();
  await fs.writeFile(path.join(scratch, 'm7-management.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
