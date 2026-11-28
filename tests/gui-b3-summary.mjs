import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=path.join(root,'test-runtime');
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence=[];
async function capture(name){
  const bytes=await fs.readFile(path.join(dir,name));
  evidence.push({file:name,bytes:bytes.length,sha256:sha(bytes)});
  return bytes;
}
async function json(name){return JSON.parse((await capture(name)).toString('utf8'));}
async function log(name,marker){
  const content=(await capture(name)).toString('utf8');
  assert(content.includes(marker),name+' missing '+marker);
  return content;
}
const modes=await json('gui-b3-modes.json');
assert.equal(modes.status,'PASS');
assert(modes.checks.length>=12);
const visual=await json('gui-visual.json');
assert.equal(visual.status,'PASS');
assert(visual.checks.length>=20);
const e2e=await json('gui-e2e.json');
assert.equal(e2e.status,'PASS');
assert(e2e.passed.length>=17);
const partial=await json('gui-partial-recovery.json');
assert.equal(partial.status,'PASS');
const baseline=await json('gui-b2-final-evidence.json');
assert.equal(baseline.status,'PASS');
const protectedState=await json('gui-b3-protection.json');
assert.equal(protectedState.status,'PASS');
await log('gui-b3-contract.log','GUI CONTRACT TESTS PASSED');
await log('gui-b3-visual.log','PASS gui-overview-min.png rendered and persisted');
await log('gui-b3-e2e.log','PASS GUI restart invalidated and refreshed MCP discovery');
await log('gui-b3-diff.log','PASS repeated cursor refused');
await log('gui-b3-faults.log','B3_FAULTS_PASS');
const packageResult=await json('gui-b3-packaged.json');
assert.equal(packageResult.status,'PASS');
const bin=path.join(root,'dist/LocalDC-GUI-win-x64/LocalDC.Gui.exe');
const zip=path.join(root,'dist/LocalDC-GUI-win-x64.zip');
const exeBytes=await fs.readFile(bin);
const zipBytes=await fs.readFile(zip);
const payload={exe:{bytes:exeBytes.length,sha256:sha(exeBytes)},
 zip:{bytes:zipBytes.length,sha256:sha(zipBytes)}};
assert(payload.exe.bytes>100_000_000);
assert(payload.zip.bytes>30_000_000);
for(const module of ['mcp-inspect.mjs','tool-diff.mjs','tool-catalog.mjs'])
  await fs.access(path.join(root,'dist/LocalDC-GUI-win-x64/diagnostics',module));
assert.equal(packageResult.exeSha256,payload.exe.sha256);
const checks={actualModes:modes.checks.length,actualGui:e2e.passed.length,
 actualVisual:visual.checks.length,baselineB2:baseline.counts.guiE2E,
 diagnosticPaths:partial.passed.length,package:packageResult.status,
 productionAndGemini:protectedState.status};
const result={utc:new Date().toISOString(),scope:'M7-B3',status:'PASS',
 checks,package:payload,evidence,
 scopeNotes:'Read-only local MCP and isolated GUI fixtures; L4 remote client remains unverified'};
await fs.writeFile(path.join(dir,'gui-b3-final-evidence.json'),
 JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,checks,package:payload},null,2));
