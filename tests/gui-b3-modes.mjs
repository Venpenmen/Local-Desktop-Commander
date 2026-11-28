import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const cli=path.join(root,'management/LDC-CLI.ps1');
const checks=[];
const report={utc:new Date().toISOString(),status:'IN_PROGRESS',checks};
function rpc(operation,argumentsValue) {
  const input=JSON.stringify({protocol:1,id:'b3-modes',operation,arguments:argumentsValue})+'\n';
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',cli],
    {input,encoding:'utf8',windowsHide:true,timeout:65000});
  if(!r.stdout) throw Error(operation+' CLI empty response');
  const result=JSON.parse(r.stdout);
  if(!result.ok) throw Error(operation+': '+result.error.code);
  return result.result;
}
const check=(condition,message)=>{assert(condition,message);checks.push(message);console.log('PASS '+message);};
const state=()=>rpc('state');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(mode) {
  for(let i=0;i<65;i++){
    const s=state();
    if(s.actual.state==='running' && s.actual.mode===mode && s.readiness.local)return s;
    if(s.actual.state==='unsafe')throw Error('Unsafe instance');
    await delay(500);
  }
  throw Error(mode+' service not ready');
}
function inspect(mode,pid){
  const input=JSON.stringify({schema:1,instance:'gui',transport:'local-dev',
    state:'running',mode,pid})+'\n';
  const p=spawnSync(process.execPath,[path.join(root,'gui/mcp-inspect.mjs')],
    {cwd:root,input,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(p.status,0,'MCP inspector exited nonzero');
  assert(p.stdout.length < 100000,'unexpectedly large inspector response');
  return JSON.parse(p.stdout);
}
const start=()=>rpc('start',{confirmed:true});
const stop=()=>rpc('stop',{confirmed:true});
const change=mode=>{
  const s=state();
  return rpc('select',{confirmed:true,revision:s.configuration.revision,
    version:s.configuration.target.version,mode});
};
const original=state();
check(original.instance.id==='gui'&&original.instance.transport==='local-dev',
  'isolated GUI instance only');
const originalMode=original.configuration.target.mode;
const originalWasRunning=original.actual.state==='running';
const originalRoot=original.fileAccess.target.allowedRoot;
try {
  for(const mode of ['files','terminal']){
    const s=state();
    if(s.actual.state==='running')stop();
    if(s.configuration.target.mode!==mode)change(mode);
    start();
    const live=await ready(mode);
    const result=inspect(mode,live.actual.pid);
    check(result.status==='ok','real '+mode+' MCP initialize/tools-list success');
    const count=mode==='files'?14:21;
    check(result.counts.expected===count&&result.counts.actual===count,
      'real '+mode+' list contains '+count+' expected/actual tools');
    check(result.expected.join('|')===result.actual.join('|') &&
        result.fileCatalog.length===14 && result.missing.length===0 && result.extra.length===0,
      'real '+mode+' names match independent expected catalog');
    check(result.http.healthz===200&&result.http.readyz===200,
      'real '+mode+' local health and readiness 200');
    const r=spawnSync(process.execPath,[path.join(root,'tests/gui-mcp-probe.mjs'),mode],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:25000});
    check(r.status===0,'real '+mode+' actual tools/call and root access checks');
  }
  report.status='PASS';
}finally {
  const s=state();
  if(s.actual.state==='running' &&
    (s.configuration.target.mode!==originalMode || !originalWasRunning))stop();
  const t=state();
  if(t.configuration.target.mode!==originalMode)change(originalMode);
  if(originalWasRunning) {
    const now=state();
    if(now.actual.state!=='running') start();
    await ready(originalMode);
  }
  const fin=state();
  check(fin.configuration.target.mode===originalMode &&
        fin.fileAccess.target.allowedRoot===originalRoot &&
        fin.fileAccess.target.mode===original.fileAccess.target.mode &&
        fin.actual.state===original.actual.state,
        'developer instance mode, root and running state restored');
  await fs.writeFile(path.join(root,'test-runtime/gui-b3-modes.json'),
    JSON.stringify(report,null,2)+'\n');
}
if(report.status!=='PASS')throw Error('B3 modes failed');
console.log('B3_REAL_MODES_PASS '+checks.length);
