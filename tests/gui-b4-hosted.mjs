import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await fs.mkdtemp(path.join(root, 'test-runtime', 'b4-hosted-'));
const management = path.join(scratch, 'management');
const checks=[];
const pass = (ok,label)=>{assert(ok,label);checks.push(label);console.log('PASS '+label);};
const env={...process.env,LOCALAPPDATA:path.join(scratch,'appdata')};
delete env.CONTROL_PLANE_API_KEY;
const powershell=path.join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
let startProxy=process.env.HTTP_PROXY;
try {
  await fs.cp(path.join(root,'management'),management,{recursive:true,
    filter:file=>!['runtime','versions.json','instance.local.json'].includes(path.basename(file))});
  await fs.mkdir(path.join(scratch,'transports','openai'),{recursive:true});
  await fs.copyFile(path.join(root,'transports','openai','manifest.json'),
    path.join(scratch,'transports','openai','manifest.json'));
  await fs.copyFile(path.join(management,'versions.example.json'),
    path.join(management,'versions.json'));
  function rpc(op,args){
    const req={protocol:1,id:'b4-fixture',operation:op,arguments:args};
    const r=spawnSync(powershell,
      ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        path.join(management,'LDC-CLI.ps1')],
      {cwd:scratch,env,windowsHide:true,encoding:'utf8',
        input:JSON.stringify(req)+'\n',timeout:30000});
    assert([0,1].includes(r.status),r.stderr);
    const res=JSON.parse(r.stdout);
    return res.ok?res.result:{error:res.error.code};
  }
  let s=rpc('state');
  pass(s.instance.transport==='openai'&&s.actual.state==='stopped',
    'isolated hosted fixture with no service');
  pass(s.transports[0].credentials.configured===false,
    'credentials status only; no secret in state');
  pass(rpc('credential.configure').error==='INTERACTIVE_REQUIRED' &&
       rpc('credential.forget').error==='INTERACTIVE_REQUIRED',
       'noninteractive API never exposes credential mutation');
  let rev=s.configuration.revision;
  pass(rpc('network.set',{confirmed:true,revision:rev,proxy:'example.com:7897'}).error==='INVALID_ARGUMENT',
    'public proxy address refused by shared manager');
  pass(rpc('network.set',{confirmed:true,revision:rev,proxy:'http://127.0.0.1:7897'}).state==='completed',
    'loopback HTTP proxy stored by shared manager');
  s=rpc('state');
  pass(s.configuration.proxy==='http://127.0.0.1:7897'&&s.configuration.revision!==rev,
    'proxy canonicalized and revision rotated');
  pass(rpc('network.set',{confirmed:true,revision:rev,proxy:null}).error==='REVISION_CONFLICT',
    'stale proxy form cannot overwrite later changes');
  rev=s.configuration.revision;
  pass(rpc('network.set',{revision:rev,proxy:null}).error==='CONFIRMATION_REQUIRED',
    'proxy configuration requires explicit confirmation');
  pass(rpc('network.set',{confirmed:true,revision:rev,proxy:null}).state==='completed',
    'null proxy restores automatic selection');
  pass(rpc('state').configuration.proxy===null,'auto proxy persisted without editing system settings');
  pass(process.env.HTTP_PROXY===startProxy,'global process proxy unaffected');
  pass(rpc('logs').tunnel.length===0,'absent runtime log returns bounded empty list');
  const runtime=path.join(scratch,'engine','runtime');
  await fs.mkdir(runtime,{recursive:true});
  await fs.writeFile(path.join(runtime,'tunnel.log'),[
    JSON.stringify({time:'2026-11-28T15:01:00Z',level:'INFO',msg:'Health ready'}),
    JSON.stringify({time:'2026-11-28T15:02:00Z',level:'ERROR',msg:'Authorization: Bearer TESTSECRET'})
  ].join('\n')+'\n');
  const logs=rpc('logs');
  pass(logs.tunnel.some(x=>x.includes('Health ready'))&&
       !JSON.stringify(logs).includes('TESTSECRET'),
       'shared management logs API redacts credential-bearing messages');
  const output={utc:new Date().toISOString(),status:'PASS',checks};
  await fs.writeFile(path.join(root,'test-runtime','gui-b4-hosted.json'),
    JSON.stringify(output,null,2)+'\n');
  console.log('B4_HOSTED_CONTRACT_PASS '+checks.length);
} finally {
  await fs.rm(scratch,{force:true,recursive:true});
}
