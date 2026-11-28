import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(packageRoot, '../..');
export const modes = Object.freeze(['restricted', 'full']);
export const toolSets = Object.freeze(['files', 'terminal']);
export const fileTools = Object.freeze([
  'read_file', 'read_multiple_files', 'write_file', 'write_pdf', 'create_directory',
  'list_directory', 'move_file', 'start_search', 'get_more_search_results',
  'stop_search', 'list_searches', 'get_file_info', 'edit_block', 'get_usage_stats'
]);
export const terminalTools = Object.freeze([
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate',
  'list_sessions', 'list_processes', 'kill_process'
]);
export const knownTools = Object.freeze([...fileTools.slice(0, -1), ...terminalTools, 'get_usage_stats']);
export const expectedTools = mode => mode === 'terminal' ? knownTools : fileTools;
const configHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateRoot(path) {
  if (typeof path !== 'string' || !/^[A-Za-z]:[\\/](?![\\/])/.test(path) || path.length > 512)
    throw Error('INVALID_ROOT');
  const root = resolve(path);
  const nativeCheck = join(projectRoot, 'engine', 'stdio.mjs');
  try {
    const result = execFileSync(process.execPath, [nativeCheck, '--check-root', root], {
      windowsHide: true, encoding: 'utf8', timeout: 12000,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTROL_PLANE_API_KEY: '' }
    }).trim();
    if (result.toLowerCase() !== root.toLowerCase() || !lstatSync(root).isDirectory())
      throw Error('INVALID_ROOT');
  } catch { throw Error('INVALID_ROOT'); }
  return root;
}
export function validateConfig(candidate, instance) {
  if (!candidate || Array.isArray(candidate) || candidate.schema !== 1 ||
      typeof candidate.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(candidate.id) ||
      !modes.includes(candidate.accessMode) || !toolSets.includes(candidate.toolMode) ||
      candidate.allowPublic !== false || candidate.terminal !== (candidate.toolMode === 'terminal'))
    throw Error('INVALID_CONFIG');
  if ((candidate.accessMode === 'full' || candidate.toolMode === 'terminal') &&
      candidate.elevatedAcknowledged !== true) throw Error('ELEVATED_CONFIRMATION_REQUIRED');
  const available = expectedTools(candidate.toolMode);
  const tools = candidate.tools === 'all' ? [...available] : candidate.tools;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > available.length ||
      tools.some(name => typeof name !== 'string' || !available.includes(name)) ||
      new Set(tools).size !== tools.length) throw Error('INVALID_TOOLS');
  const root = validateRoot(candidate.root);
  if (typeof instance !== 'string' || !existsSync(instance)) throw Error('INVALID_INSTANCE');
  return Object.freeze({
    schema: 1, id: candidate.id, root, accessMode: candidate.accessMode,
    toolMode: candidate.toolMode, tools: Object.freeze([...tools]),
    allowPublic: false, terminal: candidate.toolMode === 'terminal',
    elevatedAcknowledged: candidate.elevatedAcknowledged === true
  });
}
export function createInstance(runtime, id = 'gemini-c4', target = {}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw Error('INVALID_ID');
  const instance = resolve(runtime, id);
  mkdirSync(instance, { recursive: true });
  if (lstatSync(instance).isSymbolicLink() ||
      realpathSync.native(instance).toLowerCase() !== instance.toLowerCase())
    throw Error('INVALID_INSTANCE');
  const root = join(instance, 'workspace');
  mkdirSync(root, { recursive: true });
  const mode = target.toolMode ?? 'files';
  const input = {
    schema: 1, id, root, accessMode: 'restricted', toolMode: mode,
    tools: ['read_file'], allowPublic: false, terminal: mode === 'terminal',
    elevatedAcknowledged: false, ...target, id
  };
  return validateConfig(input, instance);
}
export function configStatus(actual, target) {
  return {
    actual: actual ?? null, target, revision: configHash(target),
    restartRequired: actual !== null && configHash(actual) !== configHash(target)
  };
}
export function writeAtomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function loadConfig(file, instance) {
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')), instance);
}
