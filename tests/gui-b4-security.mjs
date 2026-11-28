import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const checks=[];
const check=(ok,name)=>{assert(ok,name);checks.push(name);console.log('PASS '+name);};
const [ui,core,transport]=await Promise.all([
    fs.readFile(path.join(root,'gui/B4Window.cs'),'utf8'),
    fs.readFile(path.join(root,'management/LDC-Protocol.ps1'),'utf8'),
    fs.readFile(path.join(root,'management/LDC-Stable.ps1'),'utf8')]);
check(ui.includes('LDC-Stable.ps1')&&ui.includes('ProcessStartInfo')&&ui.includes('UseShellExecute = true'),
    'credential button explicitly opens existing interactive Windows entry');
check(ui.includes('if (!vm.CanManageHosted')&&ui.includes('Confirm('),
    'credentials unsupported locally and require confirmation');
check(transport.includes("Read-Host '输入隧道密钥")&&transport.includes('-AsSecureString')&&
    transport.includes('ConvertFrom-SecureString')&&transport.includes('Assert-StorePath'),
    'existing DPAPI secure input and protected path reused');
check(core.includes("if (!$Interactive) { throw 'INTERACTIVE_REQUIRED' }"),
    'JSON API rejects unattended credential commands');
check(!ui.includes('CONTROL_PLANE_API_KEY')&&!ui.includes('PasswordBox')&&
    !ui.includes('ConvertTo-SecureString'),
    'GUI never handles plaintext credential material or reimplements crypto');
check(ui.includes('B4Proxy.TryNormalize')&&ui.includes('revision = networkRevision')&&
    ui.includes('networkRevision != vm.Get'),
    'proxy mutations use strict CAS, loopback validation and existing manager');
check(ui.includes('OpenLogs_Click')&&ui.includes('LogExport_Click')&&
    !ui.includes('Get-Content')&&!ui.includes('ReadAllLines'),
    'GUI log view uses manager API rather than bypassing local log path boundary');
const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const script=[
    "$s=ConvertTo-SecureString ('B4_FIXTURE_'+[guid]::NewGuid().ToString('N')) -AsPlainText -Force",
    '$plain=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
    'try { $expected=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($plain) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($plain) }',
    '$cipher=$s|ConvertFrom-SecureString',
    "$s.Dispose()",
    'if($cipher.Contains($expected)){throw "PLAIN_IN_CIPHER"}',
    '$round=$cipher|ConvertTo-SecureString',
    '$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($round)',
    'try { if([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -ne $expected){throw "DPAPI_MISMATCH"} } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$round.Dispose() }',
    'Write-Output "B4_DPAPI_SYNTHETIC_PASS"'
].join('; ');
const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',script],
    {cwd:root,windowsHide:true,encoding:'utf8',timeout:20000});
check(result.status===0&&result.stdout.includes('B4_DPAPI_SYNTHETIC_PASS')&&
    !result.stdout.includes('B4_FIXTURE_'),
    'synthetic DPAPI encryption roundtrip never outputs plaintext');
await fs.writeFile(path.join(root,'test-runtime/gui-b4-security.json'),
    JSON.stringify({utc:new Date().toISOString(),status:'PASS',checks},null,2)+'\n');
console.log('B4_SECURITY_PASS '+checks.length);
