import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const candidateRoot = fileURLToPath(new URL('.', import.meta.url));
let configuredRoot = resolve(candidateRoot, 'workspace');
try {
    configuredRoot = readFileSync(resolve(candidateRoot, 'allowed-root.txt'), 'utf8').trim();
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (process.argv[2] === '--check-root' && process.argv[3]) configuredRoot = process.argv[3];
if (!/^[A-Za-z]:[\\/]/.test(configuredRoot) ||
    /[:<>"|?*\x00-\x1f]/.test(configuredRoot.slice(2))) {
    throw new Error('Local DC allowed-root.txt must contain one absolute Windows drive path.');
}
const allowedRoot = resolve(configuredRoot);
if (/^[A-Za-z]:[\\/]$/.test(allowedRoot)) {
    throw new Error('Local DC authorized root must be a directory below the drive root.');
}
const rootInfo = lstatSync(allowedRoot);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
    realpathSync.native(allowedRoot).toLowerCase() !== allowedRoot.toLowerCase()) {
    throw new Error('Local DC authorized root must be an existing regular local directory.');
}

if (process.argv.includes('--check-root')) {
    process.stdout.write(allowedRoot + '\n');
} else {
    delete process.env.CONTROL_PLANE_API_KEY;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    process.env.LOCAL_DC_ROOT = allowedRoot;
    const testRun = process.argv.includes('--test-run');
    process.env.LOCAL_DC_REMOTE = process.argv.includes('--tunnel') ? '1' : '0';
    process.env.LOCAL_DC_STATE_DIR = resolve(candidateRoot, testRun ? 'test-runtime' : 'runtime');
    process.env.LOCAL_DC_TERMINAL = process.argv.includes('--terminal') ||
        (process.argv.includes('--tunnel') && process.env.LOCAL_DC_TUNNEL_TERMINAL === '1') ? '1' : '0';
    process.env.PATH = resolve(candidateRoot, 'ripgrep/bin') + delimiter + (process.env.PATH || '');
    process.chdir(allowedRoot);
    process.argv = [process.argv[0], process.argv[1], '--no-onboarding'];
    await import('./upstream/dist/index.js');
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
