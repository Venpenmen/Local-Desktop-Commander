import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareTools} from '../gui/tool-diff.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
function call(input){
  const r=spawnSync(process.execPath,[path.join(root,'gui/mcp-inspect.mjs')],
    {cwd:root,encoding:'utf8',input:input+'\n',timeout:15000,windowsHide:true});
  assert.equal(r.status,0,'diagnostic child fails to emit structured output');
  return JSON.parse(r.stdout);
}
const base={schema:1,instance:'gui',transport:'local-dev',state:'running',mode:'terminal',pid:100};
const scenarios=[
  ['service stopped',{...base,state:'stopped'},'INSTANCE_NOT_ELIGIBLE'],
  ['unsafe process',{...base,pid:-1},'INSTANCE_NOT_ELIGIBLE'],
  ['other instance',{...base,instance:'gemini'},'INSTANCE_NOT_ELIGIBLE'],
  ['hosted instance',{...base,transport:'openai'},'INSTANCE_NOT_ELIGIBLE'],
  ['invalid mode',{...base,mode:'invalid'},'INSTANCE_NOT_ELIGIBLE'],
];
for(const [label,fixture,code] of scenarios){
  const outcome=call(JSON.stringify(fixture));
  assert.equal(outcome.status,'unavailable');
  assert.match(outcome.error,new RegExp(code));
  assert.equal(outcome.counts.actual,null);
  console.log('PASS '+label+' refuses protocol inspection and reports unverified');
}
const invalid=call('{bad-json');
assert.equal(invalid.status,'unavailable');
console.log('PASS malformed request returns structured failure');
const names=['read_file','list_directory','start_process'];
const mutated=['read_file','list_directory','kill_process'];
const diff=compareTools(names,mutated);
assert.equal(diff.equal,false);
assert.deepEqual(diff.missing,['start_process']);
assert.deepEqual(diff.extra,['kill_process']);
console.log('PASS same-count tool identity regression caught');
console.log('B3_FAULTS_PASS 7');
