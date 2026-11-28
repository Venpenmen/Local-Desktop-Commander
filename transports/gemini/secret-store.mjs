import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const protect = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$raw=[Text.Encoding]::UTF8.GetBytes($plain);$sealed=[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($sealed))`;
const unprotect = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$sealed=[Convert]::FromBase64String([Console]::In.ReadToEnd());$raw=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($raw))`;
function dpapi(script, data) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: data, encoding: 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 512 * 1024, stdio: ['pipe', 'pipe', 'pipe']
  });
}
/** Local-user Windows DPAPI encrypted data. No fallback to plaintext. */
export function createSecretStore(instance,fileName='oauth-state.dpapi') {
  if(!['oauth-state.dpapi','tunnel-secret.dpapi'].includes(fileName))throw Error('INVALID_SECRET_FILE');
  const directory = join(instance, 'credentials');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw Error('UNSAFE_CREDENTIAL_DIRECTORY');
  const file = join(directory, fileName);
  const read = () => {
    if (!existsSync(file)) return {};
    if (lstatSync(file).isSymbolicLink()) throw Error('UNSAFE_CREDENTIAL_FILE');
    try {
      return JSON.parse(dpapi(unprotect, readFileSync(file, 'utf8')));
    } catch { throw Error('DPAPI_UNPROTECT_FAILED'); }
  };
  const save = state => {
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Error('UNSAFE_CREDENTIAL_FILE');
    const value = dpapi(protect, JSON.stringify(state));
    const temp = file + '.' + process.pid + '.tmp';
    try {
      writeFileSync(temp, value, { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  };
  const clear = () => { if (existsSync(file)) unlinkSync(file); };
  return { read, save, clear, file };
}
