import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const engine = path.join(project, 'engine');
const entry = path.join(engine, 'stdio.mjs');
const require = createRequire(path.join(engine, 'upstream/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const scratch = path.join(project, 'test-runtime');
await fs.mkdir(scratch, { recursive: true });
const evidence = { utc: new Date().toISOString(), checks: [] };
const [rootFile, modeFile] = ['allowed-root.txt', 'access-mode.txt'].map(name => path.join(engine, name));
const readOptional = file => fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const [savedRoot, savedMode] = await Promise.all([readOptional(rootFile), readOptional(modeFile)]);
const restore = (file, content) => content === null ? fs.rm(file, { force: true }) : fs.writeFile(file, content);
assert.equal(await readOptional(path.join(engine, 'profile.local.yaml')), null, 'Use only an isolated worktree');
await fs.mkdir(path.join(engine, 'workspace'), { recursive: true });
const directory = await fs.mkdtemp(path.join(engine, 'workspace', 'access 中文 '));
const cTemp = process.env.LOCALAPPDATA;
assert.equal(path.parse(cTemp).root.toUpperCase(), 'C:\\', 'C drive requires a controlled local temp directory');
const other = await fs.mkdtemp(path.join(cTemp, 'ldc-access-'));
const link = path.join(directory, 'outside-link');
const example = path.join(directory, 'inside.txt');
const remoteExample = path.join(other, 'other.txt');
const marker = Buffer.from('M7 isolated access fixture');
const hash = data => createHash('sha256').update(data).digest('hex');
const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const env = { ...process.env };
delete env.CONTROL_PLANE_API_KEY;
delete env.LOCAL_DC_TRANSPORT;
const manager = await fs.mkdtemp(path.join(scratch, 'access-management-'));
await fs.cp(path.join(project, 'management'), path.join(manager, 'management'), {
  recursive: true, filter: file => !['versions.json', 'runtime'].includes(path.basename(file)),
});
await fs.copyFile(path.join(manager, 'management/versions.example.json'), path.join(manager, 'management/versions.json'));
await fs.mkdir(path.join(manager, 'engine/workspace'), { recursive: true });
await fs.copyFile(entry, path.join(manager, 'engine/stdio.mjs'));
const localEnv = { ...env, LOCALAPPDATA: path.join(manager, 'credentials') };

function rpc(operation, args) {
  const child = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(manager, 'management/LDC-CLI.ps1')], {
    env: localEnv, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ protocol: 1, id: 'access', operation, arguments: args }) + '\n',
  });
  assert([0, 1].includes(child.status), child.stderr);
  return JSON.parse(child.stdout);
}
function probe(root) {
  return execFileSync(process.execPath, [entry, '--check-root', root], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function start(terminal) {
  const client = new Client({ name: 'ldc-access-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--test-run',
    ...(terminal ? ['--terminal'] : [])], env, stderr: 'ignore' }));
  return client;
}
function call(client, name, args) { return client.callTool({ name, arguments: args }); }
const allowed = result => assert.notEqual(result.isError, true, JSON.stringify(result.content));
const denied = result => assert.equal(result.isError, true);
try {
  await fs.writeFile(example, marker);
  await fs.writeFile(remoteExample, marker);
  await fs.symlink(other, link, 'junction');
  assert.equal(probe('D:/'), 'D:\\');
  assert.equal(probe('C:\\'), 'C:\\');
  assert.equal(probe(directory + '\\.'), directory);
  assert.equal(probe(directory.toUpperCase() + '\\'), directory);
  for (const value of ['D:relative', '\\\\localhost\\share', link, path.join(directory, 'missing')]) {
    assert.throws(() => probe(value));
  }
  evidence.checks.push('root normalization, ordinary path compatibility, junction and invalid root rejection');

  const driveRoot = path.parse(project).root;
  await fs.writeFile(rootFile, driveRoot);
  await fs.rm(modeFile, { force: true });
  for (const mode of ['restricted', 'full']) {
    if (mode === 'full') await fs.writeFile(modeFile, mode);
    for (const terminal of [false, true]) {
      const client = await start(terminal);
      try {
        assert.equal((await client.listTools()).tools.length, terminal ? 21 : 14);
        allowed(await call(client, 'list_directory', { path: driveRoot, depth: 1 }));
        allowed(await call(client, 'read_file', { path: example }));
        const outside = await call(client, 'read_file', { path: remoteExample });
        const linked = await call(client, 'read_file', { path: path.join(link, 'other.txt') });
        if (mode === 'full') {
          allowed(outside);
          allowed(linked);
          const destination = path.join(other, 'moved-' + terminal + '.txt');
          const from = path.join(directory, 'move-' + terminal + '.txt');
          await fs.writeFile(from, marker);
          const blockedDestination = path.join(other, 'occupied-' + terminal);
          await fs.mkdir(blockedDestination);
          denied(await call(client, 'move_file', { source: from, destination: blockedDestination }));
          assert.equal(hash(await fs.readFile(from)), hash(marker));
          allowed(await call(client, 'move_file', { source: from, destination }));
          assert.equal(await readOptional(from), null);
          assert.equal(hash(await fs.readFile(destination)), hash(marker));
        } else {
          denied(outside);
          denied(linked);
          denied(await call(client, 'move_file', { source: example, destination: path.join(other, 'must-not-exist') }));
          assert.equal(hash(await fs.readFile(example)), hash(marker));
        }
        denied(await call(client, 'write_file', { path: modeFile, content: 'full', mode: 'rewrite' }));
        denied(await call(client, 'read_file', { path: example + ':alternate' }));
        evidence.checks.push({ mode, terminal, tools: terminal ? 21 : 14, result: 'PASS' });
      } finally { await client.close(); }
    }
  }
  await fs.writeFile(modeFile, 'restricted');
  await fs.writeFile(rootFile, directory);
  const samePrefix = await fs.mkdtemp(directory + '-other-');
  try {
    const sibling = path.join(samePrefix, 'sibling.txt');
    await fs.writeFile(sibling, marker);
    const client = await start(false);
    try {
      denied(await call(client, 'read_file', { path: sibling }));
      denied(await call(client, 'write_file', { path: path.join(link, 'new.txt'), content: 'denied' }));
      assert.equal(await readOptional(path.join(other, 'new.txt')), null);
    } finally { await client.close(); }
  } finally {
    await fs.rm(samePrefix, { recursive: true, force: true });
  }
  const blocked = path.join(directory, 'windows-acl.txt');
  await fs.writeFile(blocked, marker);
  const executable = name => path.join(process.env.SystemRoot, 'System32', name + '.exe');
  const sid = /S-1-[0-9-]+/.exec(execFileSync(executable('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }))[0];
  const acl = args => execFileSync(executable('icacls'), [blocked, ...args], { windowsHide: true, stdio: 'pipe' });
  acl(['/deny', '*' + sid + ':(R)']);
  try {
    for (const mode of ['restricted', 'full']) {
      await fs.writeFile(modeFile, mode);
      const client = await start(false);
      try { denied(await call(client, 'read_file', { path: blocked })); }
      finally { await client.close(); }
    }
  } finally { acl(['/remove:d', '*' + sid]); }
  assert.equal(hash(await fs.readFile(blocked)), hash(marker));
  evidence.checks.push('controlled Windows ACL denies read in either access mode');

  await fs.writeFile(modeFile, 'broken');
  const invalid = spawnSync(process.execPath, [entry, '--test-run'], { env, input: '', encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /file access mode must be restricted or full/);
  evidence.checks.push('invalid mode fails closed; prefix ambiguity and junction write denied');

  let config = rpc('config.get').result;
  assert.equal(config.accessModes.p6, 'restricted');
  assert.equal(rpc('root.set', { version: 'p6', path: 'D:/', confirmed: true, revision: config.revision }).ok, true);
  config = rpc('config.get').result;
  assert.equal(config.roots.p6, 'D:\\');
  assert.equal(rpc('access.set', { version: 'p6', mode: 'full', confirmed: true, revision: config.revision }).ok, true);
  assert.equal(rpc('access.set', { version: 'p6', mode: 'restricted', confirmed: true, revision: config.revision }).error.code, 'REVISION_CONFLICT');
  config = rpc('config.get').result;
  assert.equal(config.accessModes.p6, 'full');
  assert.equal(rpc('root.set', { version: 'p6', path: 'D:relative', confirmed: true, revision: config.revision }).error.code, 'INVALID_ROOT');
  assert.equal(rpc('access.set', { version: 'p6', mode: 'restricted', confirmed: true, revision: config.revision }).ok, true);
  const state = rpc('state').result;
  assert.equal(state.fileAccess.actual, null);
  assert.equal(state.fileAccess.target.mode, 'restricted');
  assert.equal(state.fileAccess.target.allowedRoot, 'D:\\');
  await fs.writeFile(path.join(manager, 'management/instance.local.json'), JSON.stringify({ schema: 1, id: 'access-fixture', transport: 'local-dev' }));
  config = rpc('config.get').result;
  assert.equal(rpc('access.set', { version: 'p6', mode: 'full', confirmed: true, revision: config.revision }).error.code, 'ACCESS_UNAVAILABLE');
  evidence.checks.push('management cutover roundtrip, stale revision, atomic failed root update, and development proxy limit');
} finally {
  await Promise.all([restore(rootFile, savedRoot), restore(modeFile, savedMode)]);
  await fs.rm(link, { force: true }).catch(async () => fs.rmdir(link).catch(() => {}));
  if (!(await fs.lstat(link).catch(() => undefined))) await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(other, { recursive: true, force: true });
  await fs.writeFile(path.join(scratch, 'access-matrix.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
