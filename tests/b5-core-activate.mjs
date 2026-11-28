import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=fileURLToPath(new URL('..',import.meta.url));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ldc-b5-lifecycle-'));
const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const env={...process.env,LOCALAPPDATA:path.join(dir,'appdata')};
delete env.CONTROL_PLANE_API_KEY;
const checks=[];
const success=(message,check)=>{assert(check,message); checks.push(message);console.log('PASS '+message);};
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const validator='import fs from "node:fs";\nimport path from "node:path";\nimport {fileURLToPath} from "node:url";\nif(process.argv.includes("--check-root")) console.log(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"allowed-root.txt"),"utf8").trim());\n';
const engineFile={'LocalDC.ps1':'Write-Output "synthetic test runner"\n',
  'stdio.mjs':validator,'upstream/dist/index.js':'console.log("fixture");\n',
  'allowed-root.txt':path.join(dir,'engine/workspace')+'\n',
  'profile.local.yaml':'# fixture only, no key\n','proxy.local.json':'{"durationSeconds":120}\n',
  'access-mode.txt':'restricted\n'};
function cli(operation,args={}){
  const command=JSON.stringify({id:'b5-'+crypto.randomUUID().slice(0,12),
    protocol:1,operation,arguments:args})+'\n';
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(dir,'management','LDC-CLI.ps1')],
    {cwd:dir,input:command,env,encoding:'utf8',windowsHide:true,timeout:115000});
  assert([0,1].includes(r.status),'CLI crash '+operation+' '+r.stderr);
  try{return JSON.parse(r.stdout)}
  catch {throw new Error(operation+' invalid JSON '+r.stdout+' '+r.stderr)}
}
function must(operation,args){
  const r=cli(operation,args);
  assert.equal(r.ok,true,operation+' '+JSON.stringify(r.error));
  return r.result;
}
async function archive(version){
  const source=path.join(dir,'src-'+version);
  await fs.mkdir(source,{recursive:true});
  const files=[];
  for(const [rel,content] of Object.entries(engineFile)){
    const f=path.join(source,...rel.split('/'));
    await fs.mkdir(path.dirname(f),{recursive:true});
    await fs.writeFile(f,content);
    files.push({path:rel,sha256:hash(Buffer.from(content))});
  }
  const manifest={schema:1,id:version,label:'Synthetic '+version,
    directory:'versions/'+version,launcher:'LocalDC.ps1',profile:'profile.local.yaml',
    runtime:'runtime',build:'upstream/dist/index.js',rootConfig:'allowed-root.txt',
    rootValidator:'stdio.mjs',filesTools:14,terminalTools:21,files};
  await fs.writeFile(path.join(source,'ldc-package.json'),JSON.stringify(manifest));
  const file=path.join(dir,version+'.zip');
  const command='$ErrorActionPreference="Stop";Compress-Archive -Path "'+
    source+'\\*" -DestinationPath "'+file+'" -Force';
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',command],
    {cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr);
  return {path:file,sha256:hash(await fs.readFile(file))};
}
async function createMockTunnel(){
  const source=`
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
class Stub {
  static string Flag(string[] a,string key) {
    for(int i=0;i<a.Length-1;i++)if(a[i]==key)return a[i+1];
    return "";
  }
  public static void Main(string[] args) {
    string url=Flag(args,"--url-file"),health=Flag(args,"--health-url-file");
    bool broken=url.IndexOf("canaryb",StringComparison.OrdinalIgnoreCase)>=0;
    int count=Environment.GetEnvironmentVariable("LOCAL_DC_TUNNEL_TERMINAL")=="1"?21:14;
    TcpListener server=new TcpListener(IPAddress.Loopback,0);
    server.Start();
    int port=((IPEndPoint)server.LocalEndpoint).Port;
    File.WriteAllText(url,"http://127.0.0.1:"+port+"/mcp");
    File.WriteAllText(health,"http://127.0.0.1:"+port);
    for(;;){
      TcpClient socket=server.AcceptTcpClient();
      try {
        NetworkStream stream=socket.GetStream();
        byte[] bytes=new byte[2048];
        int received=stream.Read(bytes,0,bytes.Length);
        string request=Encoding.ASCII.GetString(bytes,0,Math.Max(0,received));
        string body="{}";
        if(request.Contains("/health/mcp")) body=broken?
          "{\\\"state\\\":\\\"unready\\\",\\\"details\\\":{\\\"tools_list\\\":{\\\"retained_count\\\":0,\\\"complete\\\":false}}}":
          "{\\\"state\\\":\\\"discovered\\\",\\\"details\\\":{\\\"tools_list\\\":{\\\"retained_count\\\":"+count+",\\\"complete\\\":true}}}";
        else if(request.Contains("/health/control-plane"))
          body="{\\\"state\\\":\\\"connected\\\",\\\"status\\\":\\\"ready\\\",\\\"details\\\":{\\\"consecutive_failures\\\":0}}";
        int status=broken && request.Contains("/readyz")?503:200;
        byte[] message=Encoding.UTF8.GetBytes(body);
        byte[] header=Encoding.ASCII.GetBytes("HTTP/1.1 "+status+" OK\\r\\nContent-Type: application/json\\r\\nContent-Length: "+message.Length+"\\r\\nConnection: close\\r\\n\\r\\n");
        stream.Write(header,0,header.Length);stream.Write(message,0,message.Length);
      }catch(Exception){}
      finally {socket.Close();}
    }
  }
}
`;
  const cs=path.join(dir,'fake-tunnel.cs');
  await fs.writeFile(cs,source);
  const exe=path.join(dir,'transports/openai/bin/tunnel-client.exe');
  await fs.mkdir(path.dirname(exe),{recursive:true});
  const ps='Add-Type -TypeDefinition ([IO.File]::ReadAllText("'+cs+'")) -OutputAssembly "'+
    exe+'" -OutputType ConsoleApplication -ErrorAction Stop';
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',ps],
    {cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:50000});
  assert.equal(r.status,0,'Cannot build synthetic tunnel '+r.stderr);
}
try {
  await fs.cp(path.join(repo,'management'),path.join(dir,'management'),
    {recursive:true,filter:p=>!['runtime','versions.json','instance.local.json'].includes(path.basename(p))});
  await fs.mkdir(path.join(dir,'engine/workspace'),{recursive:true});
  await fs.mkdir(path.join(dir,'transports/openai'),{recursive:true});
  await fs.copyFile(path.join(repo,'transports/openai/manifest.json'),
    path.join(dir,'transports/openai/manifest.json'));
  await fs.copyFile(path.join(dir,'management/versions.example.json'),path.join(dir,'management/versions.json'));
  await fs.writeFile(path.join(dir,'management/instance.local.json'),
    JSON.stringify({schema:1,id:'b5lifecycle',transport:'local-dev'}));
  for(const [rel,content] of Object.entries(engineFile)){
    const target=path.join(dir,'engine',...rel.split('/'));
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,content);
  }
  await createMockTunnel();
  const initial=must('state');
  const first=await archive('canarya');
  const bad=await archive('canaryb');
  must('version.install',{confirmed:true,revision:initial.configuration.revision,...first});
  let state=must('state');
  must('version.install',{confirmed:true,revision:state.configuration.revision,...bad});
  success('two separate synthetic versions registered',must('versions').length===3);
  state=must('state');
  const premature=cli('version.activate',{confirmed:true,revision:state.configuration.revision,
    version:'canarya',mode:'files'});
  success('transaction activation rejected on stopped instance',
    !premature.ok && premature.error.code==='ACCESS_BUSY');
  const startReply=cli('start',{confirmed:true});
  if(!startReply.ok)console.log('START_DIAG',JSON.stringify(startReply),JSON.stringify(cli('task.get')));
  assert.equal(startReply.ok,true,JSON.stringify(startReply.error));
  const start=startReply.result;
  success('baseline P6 fixture launch returned complete',start.state==='completed');
  let baseline;
  for(let i=0;i<15;i++){
    baseline=must('state');
    if(baseline.readiness.local && baseline.actual.state==='running')break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  success('synthetic P6 process alive and locally ready',baseline.actual.state==='running'&&baseline.readiness.local);
  const upgraded=cli('version.activate',{confirmed:true,revision:baseline.configuration.revision,
    version:'canarya',mode:'terminal'});
  if(!upgraded.ok)console.log('UPGRADE_DIAGNOSTIC',JSON.stringify(upgraded));
  success('version activate switched to canarya with ready tool snapshot',
    upgraded.ok&&upgraded.result.state==='completed'&&upgraded.result.details?.tools===21);
  const after=must('state');
  success('active synthetic process reports installed canarya target',
    after.actual.version==='canarya'&&after.configuration.target.version==='canarya'&&after.readiness.local);
  const failed=cli('version.activate',{confirmed:true,revision:after.configuration.revision,
    version:'canaryb',mode:'terminal'});
  success('unready canaryb causes managed rollback response',
    !failed.ok&&failed.error.code==='UPGRADE_ROLLED_BACK');
  const restored=must('state');
  success('failed activation restored canarya service and target',
    restored.actual.state==='running'&&restored.actual.version==='canarya'&&
    restored.configuration.target.version==='canarya'&&restored.readiness.local);
  const back=cli('version.activate',{confirmed:true,revision:restored.configuration.revision,
    version:'p6',mode:'terminal'});
  success('managed activation can return to legacy P6',back.ok);
  const final=must('state');
  success('original P6 restored and running',final.actual.version==='p6'&&final.readiness.local);
  const result={status:'PASS',utc:new Date().toISOString(),checks,
    syntheticControlPlane:true,realMcpClient:false,originalRestored:true};
  await fs.writeFile(path.join(repo,'test-runtime/b5-core-activate-fixture.json'),
    JSON.stringify(result,null,2)+'\n');
  console.log('B5_CORE_ACTIVATION_PASS '+checks.length);
} finally {
  try{
    const status=cli('state');
    if(status.ok&&status.result.actual.state==='running'){
      const stopped=cli('stop',{confirmed:true});
      console.log('FIXTURE_STOP '+stopped.ok);
    }
  }catch(err){console.log('FIXTURE_STOP_ERROR '+err.message)}
  if(process.env.B5_KEEP_FIXTURE==='1')console.log('B5_ACTIVATE_DEBUG_PATH',dir);
  else await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:1000});
}
