import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(packageRoot, '../..');
export const modes = Object.freeze(['restricted']);
export const toolSets = Object.freeze(['files']);
const plain = path => {
  if (!isAbsolute(path) || !/^[A-Za-z]:[\\/]/.test(path)) throw Error('INVALID_ROOT');
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink() ||
      realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) throw Error('INVALID_ROOT');
  return absolute;
};
const configHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateConfig(candidate, runtime) {
  if (!candidate || Array.isArray(candidate) || candidate.schema !== 1 ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(candidate.id) || !modes.includes(candidate.accessMode) ||
      !toolSets.includes(candidate.toolMode) || !Array.isArray(candidate.tools) || !candidate.tools.length ||
      candidate.tools.length > 14 || candidate.tools.some(x => !/^[a-z][a-z0-9_]{1,60}$/.test(x)) ||
      new Set(candidate.tools).size !== candidate.tools.length) throw Error('INVALID_CONFIG');
  if (candidate.allowPublic !== false || candidate.terminal !== false) throw Error('UNSAFE_CONFIG');
  if (candidate.tools.some(name => name !== 'read_file')) throw Error('TOOL_NOT_REVIEWED');
  const targetRoot = plain(candidate.root);
  const base = realpathSync.native(resolve(runtime));
  const prefix = base.toLowerCase() + '\\';
  if (!targetRoot.toLowerCase().startsWith(prefix)) throw Error('ROOT_OUTSIDE_INSTANCE');
  return Object.freeze({schema:1,id:candidate.id,root:targetRoot,accessMode:'restricted',
    toolMode:'files',tools:Object.freeze([...candidate.tools]),allowPublic:false,terminal:false});
}
export function createInstance(runtime,id='gemini-c3',target={}) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw Error('INVALID_ID');
  const base=resolve(runtime,id);
  mkdirSync(base,{recursive:true});
  const root=join(base,'workspace');
  mkdirSync(root,{recursive:true});
  return validateConfig({schema:1,id,root,accessMode:'restricted',toolMode:'files',
    tools:['read_file'],allowPublic:false,terminal:false,...target},base);
}
export function configStatus(actual,target) {
  return {actual:actual ?? null,target,revision:configHash(target),restartRequired:actual !== null &&
    configHash(actual) !== configHash(target)};
}
export function writeAtomicJson(file,value) {
  mkdirSync(dirname(file),{recursive:true});
  const temp=file+'.'+process.pid+'.tmp';
  writeFileSync(temp,JSON.stringify(value));
  renameSync(temp,file);
}
export function loadConfig(file,instance) {
  const cfg=JSON.parse(readFileSync(file,'utf8'));
  return validateConfig(cfg,instance);
}
