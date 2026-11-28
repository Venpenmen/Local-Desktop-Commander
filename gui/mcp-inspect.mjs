// Read-only MCP inspection for the isolated GUI instance. No tools/call.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compareTools } from './tool-diff.mjs';
import { collectToolNames } from './tool-catalog.mjs';
const workspace = process.cwd();
const require = createRequire(path.join(workspace, 'engine/upstream/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const result = { schema: 1, status: 'unavailable', actual: [], expected: [], missing: [],
  extra: [], counts: { actual: null, expected: null }, checkedUtc: new Date().toISOString(),
  endpoint: null, layers: { engine: 'unverified', mcp: 'unverified',
    transport: 'not_applicable', client: 'unverified' }, http: {},
  control: {}, error: null };
let actualClient, expectedClient, filesClient;
result.fileCatalog = [];
const local = value => {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password ||
      !Number.isInteger(+u.port) || +u.port < 1 || +u.port > 65535) throw Error('LOCAL_ENDPOINT_INVALID');
  return u;
};
async function health(base, endpoint) {
  try {
    const url=local(new URL(endpoint,base).href);
    const r=await fetch(url, {signal: AbortSignal.timeout(2500),redirect:'error'});
    let data=null;
    if(endpoint.startsWith('health/')) data=await r.json().catch(()=>null);
    return {code:r.status,data};
  } catch { return {code:null,data:null}; }
}
const fail = e => String(e?.message||e||'MCP_DIAGNOSTIC_FAILED').slice(0,180);
try {
  const line=await new Promise((resolve,reject)=>{
    let input='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',x=>{input+=x;if(input.length>8192) reject(Error('INPUT_TOO_LARGE'));});
    process.stdin.on('end',()=>resolve(input));
    process.stdin.on('error',reject);
  });
  const config=JSON.parse(line);
  if(config.schema!==1 || config.instance!=='gui' || config.transport!=='local-dev' ||
    !['files','terminal'].includes(config.mode) || !Number.isSafeInteger(config.pid) ||
    config.pid<1 || config.state!=='running')throw Error('INSTANCE_NOT_ELIGIBLE');
  result.layers.engine='ready';
  // Independent catalog from installed engine version; never assume 14/21 identities.
  const engine=path.join(workspace,'engine/stdio.mjs');
  expectedClient=new Client({name:'ldc-gui-expected',version:'1.0'});
  await expectedClient.connect(new StdioClientTransport({command:process.execPath,
    args:[engine,'--test-run',...(config.mode==='terminal'?['--terminal']:[])],
    env:{...process.env, CONTROL_PLANE_API_KEY:'',LOCAL_DC_TRANSPORT:'',LOCAL_DC_TUNNEL_TERMINAL:''},
    stderr:'ignore'}),{timeout:5000});
  result.expected=await collectToolNames(expectedClient);
  result.counts.expected=result.expected.length;
  if(config.mode==='files') result.fileCatalog=result.expected;
  else {
    filesClient=new Client({name:'ldc-gui-file-catalog',version:'1.0'});
    await filesClient.connect(new StdioClientTransport({command:process.execPath,
      args:[engine,'--test-run'],
      env:{...process.env,CONTROL_PLANE_API_KEY:'',LOCAL_DC_TRANSPORT:'',LOCAL_DC_TUNNEL_TERMINAL:''},
      stderr:'ignore'}),{timeout:5000});
    result.fileCatalog=await collectToolNames(filesClient);
  }
  const settings=JSON.parse(await fs.readFile(path.join(workspace,'engine/runtime/proxy-url.json'),'utf8'));
  const url=local(settings.mcp_url);
  const hu=local(settings.health_url);
  result.endpoint=url.href;
  const healthBase=new URL('/',hu);
  const [alive,ready,control,mcp]=await Promise.all([
    health(healthBase,'healthz'),health(healthBase,'readyz'),
    health(healthBase,'health/control-plane'),health(healthBase,'health/mcp')
  ]);
  result.http={healthz:alive.code,readyz:ready.code,mcp:mcp.code};
  result.layers.engine=alive.code===200&&ready.code===200?'ready':'degraded';
  const ctl=control.data;
  result.control={status: ctl?.status||null, state:ctl?.state||null,
    pollFailures:Number.isFinite(ctl?.details?.consecutive_failures)?
       ctl.details.consecutive_failures:null,
    mcpState:mcp.data?.state||null,
    mcpObservedCount:Number.isInteger(mcp.data?.details?.tools_list?.retained_count)?
       mcp.data.details.tools_list.retained_count:null,
    mcpObservedComplete:mcp.data?.details?.tools_list?.complete===true};
  actualClient=new Client({name:'ldc-gui-diagnostics',version:'1.0'});
  await actualClient.connect(new StreamableHTTPClientTransport(url),{timeout:5000});
  result.actual=await collectToolNames(actualClient);
  result.counts.actual=result.actual.length;
  const difference=compareTools(result.expected,result.actual);
  result.missing=difference.missing;
  result.extra=difference.extra;
  result.status=difference.equal?'ok':'mismatch';
  result.layers.mcp=result.status==='ok'?'ready':'mismatch';
} catch(e) {
  result.status='unavailable';result.error=fail(e);
  result.layers.mcp='failed';
} finally {
  try {await actualClient?.close();} catch{}
  try {await expectedClient?.close();} catch{}
  try {await filesClient?.close();} catch{}
  process.stdout.write(JSON.stringify(result)+'\n');
}
