import {createRequire} from 'node:module';
import {resolve, join} from 'node:path';
import {writeFile, mkdir} from 'node:fs/promises';
const deployment=resolve(process.argv[2]);
const require=createRequire(join(deployment,'engine/upstream/package.json'));
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
await mkdir(join(deployment,'engine/workspace'),{recursive:true});
async function catalog(terminal){
 const client=new Client({name:'schema-docs',version:'1.0.0'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(deployment,'engine/stdio.mjs'),'--test-run',...(terminal?['--terminal']:[])],stderr:'pipe'}));
  return (await client.listTools()).tools;
 } finally {await client.close();}
}
const files=await catalog(false);
const tools=await catalog(true);
if(files.length!==14||tools.length!==21)throw new Error('Unexpected catalog');
const lines=['# 工具目录','', '以下名称、输入参数及说明摘自部署候选的 MCP tools/list。完整终端以当前 Windows 用户权限运行。',''];
for(const tool of tools){
 const required=new Set(tool.inputSchema.required);
 lines.push('## '+tool.name,'',files.some(t=>t.name===tool.name)?'文件及终端模式。':'仅完整终端模式。','',(tool.description||'').trim(),'',
 '参数：'+Object.keys(tool.inputSchema.properties||{}).map(k=>k+(required.has(k)?'（必填）':'')).join('、')+'.','');
}
lines.push('## 调用示例','','list_directory: {"path":"C:/Test","depth":1}','','start_process: {"command":"echo hello","shell":"cmd.exe","timeout_ms":1000}','');
await writeFile('docs/tools.md',lines.join('\n'));
