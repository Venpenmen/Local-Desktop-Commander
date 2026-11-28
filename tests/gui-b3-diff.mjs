import assert from 'node:assert/strict';
import {compareTools} from '../gui/tool-diff.mjs';

const a=['alpha','beta','gamma'];
assert.deepEqual(compareTools(a,a),{missing:[],extra:[],equal:true});
console.log('PASS same names and count');
const swapped=compareTools(a,['alpha','beta','delta']);
assert.equal(swapped.equal,false);
assert.deepEqual(swapped.missing,['gamma']);
assert.deepEqual(swapped.extra,['delta']);
console.log('PASS equal counts but different names rejected');
const missing=compareTools(a,['alpha','beta']);
assert.deepEqual(missing.missing,['gamma']);
console.log('PASS missing names identified');
const extra=compareTools(a,['alpha','beta','gamma','delta']);
assert.deepEqual(extra.extra,['delta']);
console.log('PASS extra names identified');
assert.throws(()=>compareTools(['alpha','alpha'],a),/DUPLICATE/);
console.log('PASS malformed duplicate list rejected');
console.log('B3_DIFF_PASS');

import {collectToolNames} from '../gui/tool-catalog.mjs';
let called=0;
const paged={async listTools(options){
  called++;
  if(!options?.cursor)return {tools:[{name:'file_a'}],nextCursor:'page2'};
  assert.equal(options.cursor,'page2');
  return {tools:[{name:'file_b'}]};
}};
assert.deepEqual(await collectToolNames(paged),['file_a','file_b']);
assert.equal(called,2);
console.log('PASS real SDK pagination contract collects subsequent pages');
await assert.rejects(collectToolNames({async listTools(){
  return {tools:[{name:'duplicate'},{name:'duplicate'}]};
}}),/DUPLICATE/);
console.log('PASS duplicate name refused');
await assert.rejects(collectToolNames({async listTools(){
  return {tools:[],nextCursor:'loop'};
}}),/CURSOR/);
console.log('PASS repeated cursor refused');
