import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAuditLog } from './audit.mjs';

const base = fileURLToPath(new URL('../../test-runtime/gemini-c4-audit/', import.meta.url));
test('C4 private events redact content and bound disk retention', {timeout:30000},async()=>{
  const instance=join(base,'audit-'+randomUUID().replaceAll('-','').slice(0,12));
  await mkdir(instance,{recursive:true});
  const log=createAuditLog(instance);
  const secret='C4-NOT-FOR-LOG-'+randomUUID();
  log({event:'call',method:'tools/call',name:'read_file',isError:false,
    token:secret,path:secret,content:secret,args:{password:secret}});
  for(let i=0;i<1500;i++)log({event:'call',method:'tools/call',name:'write_file',isError:false});
  const latest=join(instance,'logs','events.ndjson');
  const previous=join(instance,'logs','events.previous.ndjson');
  const current=(await readFile(latest,'utf8'));
  const older=(await readFile(previous,'utf8'));
  assert((await stat(latest)).size<=65536);
  assert((await stat(previous)).size<=65536);
  assert(!current.includes(secret)&&!older.includes(secret));
  assert(JSON.parse(current.trim().split('\n')[0]).utc);
});
