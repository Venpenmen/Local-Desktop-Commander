import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const candidateRoot = fileURLToPath(new URL('.', import.meta.url));
let configuredRoot = resolve(candidateRoot, 'workspace');
try {
    configuredRoot = readFileSync(resolve(candidateRoot, 'allowed-root.txt'), 'utf8').trim();
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (process.argv[2] === '--check-root' && process.argv[3]) configuredRoot = process.argv[3];
if (!/^[A-Za-z]:[\\/](?![\\/])/.test(configuredRoot) || /[:<>"|?*\x00-\x1f]/.test(configuredRoot.slice(2)) ||
    configuredRoot.slice(3).split(/[\\/]/).some(part => (/[ .]$/.test(part) && part !== '.' && part !== '..') ||
        /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i.test(part.split('.')[0].trimEnd()))) {
    throw new Error('Local DC requires an ordinary absolute Windows drive path.');
}
const allowedRoot = resolve(configuredRoot);
const rootInfo = lstatSync(allowedRoot);
const canonicalRoot = realpathSync.native(allowedRoot);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot.toLowerCase() !== allowedRoot.toLowerCase()) {
    throw new Error('Local DC authorized root must be an existing regular local directory.');
}

const powershell = resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const localDrives = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '[IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -in "Fixed","Removable","Ram","CDRom" } | ForEach-Object { $_.Name.Substring(0,1) }'],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim().toUpperCase().split(/\s+/);
if (!localDrives.includes(canonicalRoot[0].toUpperCase())) {
    throw new Error('Local DC only permits local Windows drives.');
}

if (process.argv.includes('--check-root')) {
    process.stdout.write(canonicalRoot + '\n');
} else {
    let accessMode = 'restricted';
    try {
        accessMode = readFileSync(resolve(candidateRoot, 'access-mode.txt'), 'utf8').trim();
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (!['restricted', 'full'].includes(accessMode)) throw new Error('Local DC file access mode must be restricted or full.');
    if (accessMode === 'full' && process.env.LOCAL_DC_TRANSPORT === 'local-dev') {
        throw new Error('Full file access is disabled on the development loopback proxy.');
    }
    delete process.env.CONTROL_PLANE_API_KEY;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    process.env.LOCAL_DC_ROOT = canonicalRoot;
    process.env.LOCAL_DC_INSTALL = realpathSync.native(resolve(candidateRoot, '..'));
    process.env.LOCAL_DC_FILE_ACCESS = accessMode;
    process.env.LOCAL_DC_DRIVES = localDrives.join('');
    const testRun = process.argv.includes('--test-run');
    process.env.LOCAL_DC_REMOTE = process.argv.includes('--tunnel') ? '1' : '0';
    const stateDir = resolve(candidateRoot, testRun ? 'test-runtime' : 'runtime');
    process.env.LOCAL_DC_STATE_DIR = stateDir;
    process.env.LOCAL_DC_TERMINAL = process.argv.includes('--terminal') ||
        (process.argv.includes('--tunnel') && process.env.LOCAL_DC_TUNNEL_TERMINAL === '1') ? '1' : '0';
    process.env.PATH = resolve(candidateRoot, 'ripgrep/bin') + delimiter + (process.env.PATH || '');
    process.chdir(canonicalRoot);
    process.argv = [process.argv[0], process.argv[1], '--no-onboarding'];
    await import('./upstream/dist/index.js');
    if (process.env.LOCAL_DC_REMOTE === '1' && !testRun) {
        mkdirSync(stateDir, { recursive: true });
        const record = resolve(stateDir, 'effective-access.json');
        const staged = resolve(stateDir, 'effective-access-' + process.pid + '.tmp');
        writeFileSync(staged, JSON.stringify({ pid: process.pid, accessMode, allowedRoot: canonicalRoot }));
        renameSync(staged, record);
    }
    const { terminalManager } = await import('./upstream/dist/terminal-manager.js');
    const { searchManager } = await import('./upstream/dist/search-manager.js');
    let stopping = false;
    async function stopManagedWork() {
        if (stopping) return;
        stopping = true;
        searchManager.dispose();
        const sessions = terminalManager.listActiveSessions();
        const outcomes = await Promise.all(sessions.map(({ pid }) => terminalManager.forceTerminate(pid)));
        if (outcomes.includes('failed')) {
            process.stderr.write('Local DC could not stop every managed terminal session.\n');
            process.exitCode = 1;
        }
    }
    process.stdin.once('end', stopManagedWork);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            stopManagedWork().finally(() => { process.stdin.pause(); });
        });
    }
}
