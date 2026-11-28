import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, 'test-runtime');
const recorded = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function load(name) {
 const bytes = await fs.readFile(path.join(runtime, name));
 const obj = JSON.parse(bytes.toString('utf8'));
 recorded.push({ name, size: bytes.length, sha256: sha256(bytes) });
 return obj;
}
async function marker(name) {
 const bytes = await fs.readFile(path.join(runtime, name));
 assert.match(bytes.toString('utf8'), /PASS/);
 recorded.push({ name, size: bytes.length, sha256: sha256(bytes) });
}
const contract = await fs.readFile(path.join(runtime, 'gui-contract.log'), 'utf8');
assert.match(contract, /GUI CONTRACT TESTS PASSED/);
recorded.push({ name: 'gui-contract.log', size: Buffer.byteLength(contract), sha256: sha256(Buffer.from(contract)) });
const e2e = await load('gui-e2e.json');
assert.equal(e2e.status, 'PASS');
assert.equal(e2e.passed.length, 14);
const partial = await load('gui-partial-recovery.json');
assert.equal(partial.status, 'PASS');
assert.equal(partial.passed.length, 6);
const visual = await load('gui-visual.json');
assert.equal(visual.status, 'PASS');
assert(visual.checks.length >= 15);
const background = await load('gui-b2-background.json');
assert.equal(background.count, 16);
assert.equal(background.checks.length, 16);
const matrix = await load('access-matrix.json');
const modes = matrix.checks.filter(x=>x && typeof x==='object');
assert.equal(modes.length, 4);
assert(modes.every(x=>x.result === 'PASS'));
const management = await load('m7-management.json');
assert.equal(management.cases.length, 6);
assert(management.cases.every(x=>x.result==='PASS'));
const isolation = await load('m7-isolation.json');
assert.equal(isolation.cases.length, 3);
const managed = await load('access-managed.json');
assert.equal(managed.checks.length, 3);
for(const file of ['gui-crash-pass.txt','gui-packaged-pass.txt','gui-launcher-pass.txt','gui-tui-pass.txt'])
 await marker(file);
const packagePath = path.join(root, 'dist/LocalDC-GUI-win-x64/LocalDC.Gui.exe');
const stat = await fs.stat(packagePath);
assert(stat.size > 100_000_000, 'self contained release executable unexpectedly small');
const hash = sha256(await fs.readFile(packagePath));
const manifest = JSON.parse(await fs.readFile(path.join(root,'dist/LocalDC-GUI-win-x64/manifest.json'),'utf8'));
assert.equal(manifest.mode, 'win-x64/self-contained');
const summary = {
 utc: new Date().toISOString(),
 status: 'PASS',
 scope: 'M7-B0-B2',
 counts: { guiProtocol: contract.match(/\bPASS\b/g)?.length ?? 0, guiE2E: e2e.passed.length,
   partialRecovery: partial.passed.length, visual: visual.checks.length,
   background: background.checks.length, accessModes: modes.length,
   management: management.cases.length, isolation: isolation.cases.length,
   managedAccess: managed.checks.length },
 package: { relativePath: 'dist/LocalDC-GUI-win-x64/LocalDC.Gui.exe',
   bytes: stat.size, sha256: hash },
 evidence: recorded,
 protected: 'Production and Gemini are read-only checked separately',
};
await fs.writeFile(path.join(runtime,'gui-b2-final-evidence.json'),
  JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({ status:summary.status,counts:summary.counts,package:summary.package },null,2));
