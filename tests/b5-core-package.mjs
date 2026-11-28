import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const work=await fs.mkdtemp(path.join(os.tmpdir(),'ldc-b5-core-fixture-'));
const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const localapp=path.join(work,'AppData');
const env={...process.env,LOCALAPPDATA:localapp};
delete env.CONTROL_PLANE_API_KEY;
const checks=[];
const pass=(name,fn)=>{assert(fn(),name);checks.push(name); console.log('PASS '+name);};
function invoke(op,args,externalEnv={}){
  const req=JSON.stringify({protocol:1,id:'b5-'+crypto.randomUUID().slice(0,12),operation:op,arguments:args})+'\n';
  const r=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(work,'management','LDC-CLI.ps1')],
    {input:req,cwd:work,env:{...env,...externalEnv},encoding:'utf8',windowsHide:true,timeout:45000});
  if(![0,1].includes(r.status))throw new Error('CLI failed '+op+' '+r.stderr);
  try{return JSON.parse(r.stdout)}catch {throw new Error(op+' output '+r.stdout+' '+r.stderr)}
}
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function packageVersion(id,override={}){
  const stage=path.join(work,'package-src-'+id+'-'+crypto.randomUUID().slice(0,4));
  await fs.mkdir(stage,{recursive:true});
  const files={
    'LocalDC.ps1':'param([string]$Action)\nWrite-Output "Synthetic launch"\n',
    'stdio.mjs':'import fs from "node:fs"; console.log("SYNTHETIC_FIXTURE");\n',
    'upstream/dist/index.js':'console.log("SYNTHETIC_FIXTURE");\n',
    'allowed-root.txt':path.join(work,'engine/workspace')+'\n',
    'access-mode.txt':'restricted\n',
    'profile.local.yaml':'# Test fixture without secrets\n',
    'proxy.local.json':'{"durationSeconds":60}\n'
  };
  Object.assign(files,override.files||{});
  const hashes=[];
  for(const [rel,body] of Object.entries(files)){
    const target=path.join(stage,...rel.split('/'));
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,body,'utf8');
    hashes.push({path:rel,sha256:sha(Buffer.from(body))});
  }
  const manifest={schema:1,id,label:'Synthetic '+id,status:'test-only',
    directory:'versions/'+id,runtime:'runtime',launcher:'LocalDC.ps1',
    profile:'profile.local.yaml',build:'upstream/dist/index.js',
    rootConfig:'allowed-root.txt',rootValidator:'stdio.mjs',
    filesTools:14,terminalTools:21,files:hashes,
    ...(override.manifest||{})};
  await fs.writeFile(path.join(stage,'ldc-package.json'),JSON.stringify(manifest,null,2));
  const zipPath=path.join(work,id+'-'+crypto.randomUUID().slice(0,6)+'.zip');
  // PowerShell -Command argument passing isn't reliable for -LiteralPath wildcard. Use explicit -Path via -EncodedCommand.
  const command='$ErrorActionPreference="Stop"; Compress-Archive -Path "'+
    stage.replaceAll('"','')+'\\*" -DestinationPath "'+zipPath.replaceAll('"','')+'" -Force';
  const cr=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',command],
    {cwd:work,env,encoding:'utf8',windowsHide:true,timeout:40000});
  assert.equal(cr.status,0,cr.stderr);
  return {file:zipPath,sha:sha(await fs.readFile(zipPath)),manifest};
}
try{
  await fs.cp(path.join(root,'management'),path.join(work,'management'),
    {recursive:true,filter:p=>!['runtime','versions.json','instance.local.json'].includes(path.basename(p))});
  await fs.mkdir(path.join(work,'engine','workspace'),{recursive:true});
  await fs.mkdir(path.join(work,'transports','openai'),{recursive:true});
  await fs.copyFile(path.join(root,'transports','openai','manifest.json'),
    path.join(work,'transports','openai','manifest.json'));
  await fs.copyFile(path.join(work,'management','versions.example.json'),
    path.join(work,'management','versions.json'));
  await fs.writeFile(path.join(work,'management','instance.local.json'),
    JSON.stringify({schema:1,id:'b5fixture',transport:'local-dev'}));
  let res=invoke('state');
  pass('isolated local-dev fixture stopped and has only p6',()=>
    res.ok&&res.result.instance.id==='b5fixture'&&res.result.actual.state==='stopped');
  const rev=res.result.configuration.revision;
  pass('new capability advertised only by maintenance candidate',()=>
    invoke('capabilities').result.operations.includes('version.install'));
  const a=await packageVersion('canarya');
  res=invoke('version.install',{confirmed:false,revision:rev,path:a.file,sha256:a.sha});
  pass('installation requires explicit confirmation',()=>!res.ok&&res.error.code==='CONFIRMATION_REQUIRED');
  res=invoke('version.install',{confirmed:true,revision:rev,path:a.file,sha256:'0'.repeat(64)});
  pass('wrong external SHA never writes registry',()=>!res.ok&&res.error.code==='PACKAGE_HASH_MISMATCH');
  pass('no failed install modified versions',()=>invoke('versions').result.length===1);
  res=invoke('version.install',{confirmed:true,revision:rev,path:a.file,sha256:a.sha});
  if(!res.ok)console.log('DIAGNOSTIC_INSTALL_RESPONSE',JSON.stringify(res));
  pass('trusted fixture package installed and registered',()=>res.ok&&res.result.state==='completed');
  pass('versions API lists newly installed canarya',()=>invoke('versions').result.some(x=>x.Id==='canarya'));
  pass('existing engine target remains p6 after registration',()=>invoke('state').result.configuration.target.version==='p6');
  const b=await packageVersion('canaryb');
  const rev2=invoke('state').result.configuration.revision;
  res=invoke('version.install',{confirmed:true,revision:rev2,path:b.file,sha256:b.sha});
  pass('second signed fixture installed independently',()=>res.ok && invoke('versions').result.length===3);
  pass('installed synthetic version immutable files verified',()=>
    invoke('version.verify',{id:'canarya'}).result?.verified===true);
  pass('legacy P6 correctly shown as unverified rather than signed',()=>
    invoke('version.verify',{id:'p6'}).result?.status==='unmanaged');
  const original=await fs.readFile(path.join(work,'versions','canaryb','stdio.mjs'));
  await fs.appendFile(path.join(work,'versions','canaryb','stdio.mjs'),'\n// fixture alteration\n');
  pass('modified immutable version rejected by integrity report',()=>
    invoke('version.verify',{id:'canaryb'}).result?.status==='modified');
  await fs.writeFile(path.join(work,'versions','canaryb','stdio.mjs'),original);
  pass('restored immutable payload verifies again',()=>
    invoke('version.verify',{id:'canaryb'}).result?.verified===true);
  const rev3=invoke('state').result.configuration.revision;
  const again=invoke('version.install',{confirmed:true,revision:rev3,path:a.file,sha256:a.sha});
  pass('duplicate version rejected',()=>!again.ok&&again.error.code==='VERSION_EXISTS');
  const traversal=await packageVersion('pathbad',{manifest:{files:[{path:'../bad',sha256:'1'.repeat(64)}]}});
  res=invoke('version.install',{confirmed:true,revision:rev3,path:traversal.file,sha256:traversal.sha});
  pass('malformed payload manifest refused',()=>!res.ok && res.error.code==='INVALID_PACKAGE');
  pass('package failure does not create managed directory',()=>
    !existsSync(path.join(work,'versions','pathbad')));
  res=invoke('version.remove',{confirmed:false,revision:rev3,id:'canarya'});
  pass('version removal requires explicit confirmation',()=>!res.ok&&res.error.code==='CONFIRMATION_REQUIRED');
  res=invoke('version.remove',{confirmed:true,revision:rev3,id:'p6'});
  pass('legacy stable P6 protected from removal',()=>!res.ok&&res.error.code==='VERSION_PROTECTED');
  res=invoke('select',{confirmed:true,revision:rev3,version:'canaryb',mode:'files'});
  pass('stopped fixture selects installed target without spawning service',()=>res.ok &&
    invoke('state').result.configuration.target.version==='canaryb');
  const targetRev=invoke('state').result.configuration.revision;
  res=invoke('version.remove',{confirmed:true,revision:targetRev,id:'canaryb'});
  pass('active target version protected from removal',()=>!res.ok&&res.error.code==='VERSION_PROTECTED');
  res=invoke('select',{confirmed:true,revision:targetRev,version:'p6',mode:'files'});
  pass('fixture restores stable p6 target',()=>res.ok &&
    invoke('state').result.configuration.target.version==='p6');
  const removalRev=invoke('state').result.configuration.revision;
  res=invoke('version.remove',{confirmed:true,revision:removalRev,id:'canarya'});
  pass('unused managed version removed using shared manager',()=>res.ok &&
    !invoke('versions').result.some(x=>x.Id==='canarya') &&
    !existsSync(path.join(work,'versions','canarya')));
  pass('other installed canary preserved',()=>invoke('version.verify',{id:'canaryb'}).result?.verified===true);
  const output={status:'PASS',utc:new Date().toISOString(),checks,
    added:['canarya','canaryb'],baseVersion:'p6',workRemoved:true};
  await fs.writeFile(path.join(root,'test-runtime','b5-core-package-fixture.json'),
    JSON.stringify(output,null,2)+'\n');
  console.log('B5_CORE_PACKAGE_PASS '+checks.length);
} finally {
  if(process.env.B5_KEEP_FIXTURE==='1')console.log('B5_DIAG_WORK',work);
  else await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
