import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectRoot, validateConfig } from './config.mjs';

const install=join(projectRoot,'engine');
export async function createBridge(config,instance,{onEvent=()=>{},timeout=10000,transportFactory}={}) {
  const target=validateConfig(config,instance);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw Error('INVALID_TIMEOUT');
  mkdirSync(instance,{recursive:true});
  const copy=join(instance,'stdio.mjs');
  if (!existsSync(copy)) copyFileSync(join(install,'stdio.mjs'),copy);
  else if (readFileSync(copy,'utf8')!==readFileSync(join(install,'stdio.mjs'),'utf8')) throw Error('ENGINE_VERSION_MISMATCH');
  for(const component of ['upstream','ripgrep']) {
    const dest=join(instance,component);
    if (!existsSync(dest)) symlinkSync(join(install,component),dest,'junction');
    const expected=realpathSync.native(join(install,component)).toLowerCase();
    if (realpathSync.native(dest).toLowerCase()!==expected) throw Error('ENGINE_SOURCE_MISMATCH');
  }
  const rootFile=join(instance,'allowed-root.txt');
  const modeFile=join(instance,'access-mode.txt');
  for(const [file,expected] of [[rootFile,target.root],[modeFile,target.accessMode]]) {
    if (existsSync(file) && readFileSync(file,'utf8').trim().toLowerCase() !== expected.toLowerCase())
      throw Error('INSTANCE_CONFIG_MISMATCH');
    writeFileSync(file,expected);
  }
  const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC']
    .filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  env.LOCAL_DC_TRANSPORT='local-dev';
  const transport=transportFactory?.() ?? new StdioClientTransport({
    command:process.execPath,args:[copy,'--test-run'],cwd:target.root,env,stderr:'pipe'
  });
  const client=new Client({name:'ldc-gemini-adapter',version:'0.1.0'});
  try{
    await client.connect(transport,{timeout:Math.max(timeout,12000)});
    const found=(await client.listTools({}, {timeout})).tools;
    if(found.length!==14) throw Error('UNEXPECTED_NATIVE_TOOL_COUNT');
    const allowed=found.filter(tool=>target.tools.includes(tool.name));
    if(allowed.length!==target.tools.length) throw Error('ALLOWLIST_TOOL_MISSING');
    let closed=false;
    let queue=Promise.resolve();
    const call=async (name,args={})=>{
      if(closed) throw Error('BRIDGE_CLOSED');
      if(!target.tools.includes(name)) throw Error('TOOL_NOT_ALLOWED');
      if(!args || typeof args!=='object' || Array.isArray(args)) throw Error('INVALID_ARGUMENTS');
      if(name==='read_file' && (typeof args.path!=='string' || args.path.length>512 ||
          args.isUrl!==undefined || /:\/\//.test(args.path))) throw Error('INVALID_PATH');
      const values={...args};
      if(name==='read_file') values.isUrl=false;
      const job=queue.then(()=>client.callTool({name,arguments:values},undefined,{timeout}));
      queue=job.then(()=>{},()=>{});
      return await job;
    };
    onEvent({event:'engine-ready',pid:transport.pid,toolCount:found.length,exposed:target.tools});
    return {instance,config:target,pid:transport.pid,toolList:()=>allowed.map(t=>({...t})),call,
      async close(){if(closed)return;closed=true;await client.close();onEvent({event:'engine-closed'});}};
  }catch(err){await client.close().catch(()=>{});throw err;}
}
