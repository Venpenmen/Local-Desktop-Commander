import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const candidate = path.join(project, 'engine');
const require = createRequire(path.join(candidate, 'upstream', 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { PDFDocument } = require('pdf-lib');
const out = path.join(project, 'logs');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(path.join(candidate,'workspace'), {recursive:true});
const fixture = await fs.mkdtemp(path.join(candidate, 'workspace', 'p6-smoke-'));
const childScript = path.join(fixture, 'echo.cjs');
const proof = path.join(fixture, 'proof.txt');
const marker = 'LOCAL-DC-P6-SMOKE';
const run = Date.now();
const urlFile = path.join(out, 'p6-proxy-' + run + '.json');
const healthFile = path.join(out, 'p6-health-' + run + '.url');
const launcher = path.join(candidate, 'stdio.mjs');
const networkLog = path.join(out, 'p6-node-network-' + run + '.log');
const networkGuard = pathToFileURL(path.join(project, 'tests', 'p4-no-network.mjs')).href;
const configFile = path.join(candidate, 'allowed-root.txt');
const savedRoot = await fs.readFile(configFile).catch(error => { if(error.code === 'ENOENT') return null; throw error; });
const env = { ...process.env, LOCAL_DC_TUNNEL_TERMINAL: '0', LOCAL_DC_NETWORK_REPORT: networkLog };
delete env.CONTROL_PLANE_API_KEY;
const report = { started: new Date().toISOString(), fixture, node: process.version, cases: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(transport) {
    const client = new Client({ name: 'local-dc-p6-smoke', version: '1.0.0' });
    client.onerror = error => report.errors.push(String(error));
    await client.connect(transport, { timeout: 15000 });
    return client;
}

function text(result) {
    return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
let client, proxy, foreign;
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
async function ok(name, args) {
    const result = await call(name, args);
    assert.ok(!result.isError, text(result));
    return result;
}
async function rejected(name, args, expected) {
    const result = await call(name, args);
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), expected);
}
async function check(name, fn) {
    try {
        const detail = await fn();
        report.cases.push({ name, status: 'PASS', detail });
    } catch (error) {
        report.cases.push({ name, status: 'FAIL', error: String(error.message).slice(0, 1800) });
    }
}
async function processStart() {
    const result = await ok('start_process', { command: 'node "' + childScript + '"', shell: 'cmd.exe', timeout_ms: 700 });
    const pid = result.structuredContent?.pid ?? Number(/PID\s*:?\s*(\d+)/i.exec(text(result))?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, text(result));
    return pid;
}

try {
    await fs.writeFile(childScript, "console.log('P6_READY'); process.stdin.on('data', data => console.log('P6_ECHO:' + data.toString().trim()));");
    const defaultTransport = new StdioClientTransport({
        command: process.execPath, args: ['--import', networkGuard, launcher, '--tunnel', '--test-run'], cwd: candidate, env
    });
    client = await connect(defaultTransport);
    await check('default file mode catalog and direct terminal refusal', async () => {
        const { tools } = await client.listTools();
        assert.equal(tools.length, 14);
        assert.ok(!tools.some(t => t.name === 'start_process'));
        await rejected('start_process', { command: 'echo GATED', timeout_ms: 500 }, /disabled/);
    });
    await check('Zod 4 catalog preserves required inputs and optional defaults', async () => {
        const { tools } = await client.listTools();
        const catalog = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]));
        assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));
        assert.deepEqual(catalog.write_file.required.sort(), ['content', 'path']);
        assert.equal(catalog.write_file.properties.mode.default, 'rewrite');
        assert.deepEqual(catalog.read_file.required, ['path']);
        assert.equal(catalog.read_file.properties.length.default, 1000);
        assert.ok(catalog.write_pdf.required.includes('content'));
        const content = catalog.write_pdf.properties.content;
        assert.ok((content.anyOf || content.oneOf).some(schema => schema.type === 'array'));
        assert.match(text(await ok('list_directory', { path: fixture, ignored_parameter: true })), /echo\.cjs/);
        const { detectUnsupportedParams } = await import(pathToFileURL(path.join(candidate, 'upstream/dist/utils/unsupportedParams.js')).href);
        const { ListDirectoryArgsSchema } = await import(pathToFileURL(path.join(candidate, 'upstream/dist/tools/schemas.js')).href);
        assert.deepEqual(detectUnsupportedParams({ path: fixture, ignored_parameter: true }, ListDirectoryArgsSchema), ['ignored_parameter']);
        await rejected('read_file', { path: 123 }, /invalid|expected/i);
    });
    await check('offline file, search and JSON-encoded PDF operations', async () => {
        await ok('write_file', { path: proof, content: marker });
        assert.match(text(await ok('read_multiple_files', { paths: [proof] })), new RegExp(marker));
        await ok('edit_block', { file_path: proof, old_string: marker, new_string: marker + '-EDIT' });
        const search = text(await ok('start_search', { path: fixture, pattern: marker + '-EDIT',
            searchType: 'content', filePattern: '*.txt', literalSearch: true }));
        const searchId = /session:\s*(\S+)/i.exec(search)?.[1];
        assert.ok(searchId, search);
        let found = search;
        for (let index = 0; index < 10 && !found.includes('proof.txt'); index++) {
            await delay(150);
            found += text(await ok('get_more_search_results', { sessionId: searchId }));
        }
        assert.match(found, /proof\.txt/);
        const input = path.join(fixture, 'input.pdf'), output = path.join(fixture, 'output.pdf');
        const pdf = await PDFDocument.create();
        pdf.addPage();
        pdf.addPage();
        await fs.writeFile(input, await pdf.save());
        await ok('write_pdf', { path: input, outputPath: output,
            content: JSON.stringify([{ type: 'delete', pageIndexes: [1] }]) });
        assert.equal((await PDFDocument.load(await fs.readFile(output))).getPageCount(), 1);
        const attempts = await fs.readFile(networkLog, 'utf8').catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return '';
        });
        assert.equal(attempts, '');
    });
    const healthBeforeProxy = await fs.readFile(configFile).catch(() => null);
    assert.ok(!savedRoot || healthBeforeProxy.equals(savedRoot));
    await client.close();
    client = undefined;
    await check('configured root accepts one local directory and rejects invalid or out-of-scope paths', async () => {
        const narrowed = path.join(fixture, 'scoped workspace');
        await fs.mkdir(narrowed);
        const inside = path.join(narrowed, 'ok.txt');
        await fs.writeFile(inside, marker);
        const probe = () => execFileSync(process.execPath, [launcher, '--check-root'], {
            cwd: candidate, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
        try {
            const junction = path.join(fixture, 'root-link');
            await fs.symlink(narrowed, junction, 'junction');
            for (const invalid of ['', 'relative', 'D:\\', narrowed + '\n' + fixture, junction]) {
                await fs.writeFile(configFile, invalid);
                assert.throws(probe);
            }
            await fs.writeFile(configFile, narrowed + '\n');
            assert.equal(probe(), narrowed);
            client = await connect(new StdioClientTransport({
                command: process.execPath, args: [launcher, '--tunnel', '--test-run'], cwd: candidate, env
            }));
            assert.match(text(await ok('read_file', { path: inside })), new RegExp(marker));
            await rejected('read_file', { path: proof }, /outside|not allowed/i);
        } finally {
            if (client) await client.close().catch(() => {});
            client = undefined;
            if(savedRoot) await fs.writeFile(configFile, savedRoot); else await fs.unlink(configFile);
        }
    });
    const command = 'node engine/stdio.mjs --tunnel --test-run';
    proxy = spawn(path.join(project, 'transports', 'openai', 'bin', 'tunnel-client.exe'),
        ['dev', 'proxy', '--mcp-command', command, '--duration', '60s', '--url-file', urlFile,
            '--health-url-file', healthFile, '--readiness-timeout', '15s'],
        { cwd: project, env: { ...env, LOCAL_DC_TUNNEL_TERMINAL: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let proxyError = '';
    proxy.stderr.on('data', data => { proxyError = (proxyError + data).slice(-4000); });
    let info;
    for (let i = 0; i < 75 && proxy.exitCode === null; i++) {
        const raw = await fs.readFile(urlFile, 'utf8').catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        if (raw) { info = JSON.parse(raw); break; }
        await delay(200);
    }
    assert.ok(info, proxyError || 'No local proxy URL');
    client = await connect(new StreamableHTTPClientTransport(new URL(info.mcp_url)));
    await check('authorized proxy catalog retains all 21 tools', async () => {
        const { tools } = await client.listTools();
        assert.equal(tools.length, 21);
        assert.match(tools.find(t => t.name === 'kill_process').description, /Only active Local DC/);
        const health = (await fs.readFile(healthFile, 'utf8')).trim();
        const snapshot = await (await fetch(health + '/health/mcp')).json();
        assert.equal(snapshot.details.tools_list.retained_count, 21);
        assert.equal(snapshot.details.tools_list.complete, true);
        return { retained: 21, state: snapshot.state };
    });
    await check('file quick check with valid arguments', async () => {
        await ok('write_file', { path: proof, content: marker, mode: 'rewrite' });
        assert.match(text(await ok('read_file', { path: proof })), new RegExp(marker));
        assert.equal(await fs.readFile(proof, 'utf8'), marker);
    });
    await check('remote input bounds and subsequent valid call', async () => {
        const paths = Array(4097).fill(proof);
        await rejected('read_multiple_files', { paths }, /collection budget/);
        await rejected('write_pdf', { path: path.join(fixture, 'sample.pdf'),
            content: JSON.stringify([{ type: 'delete', pageIndexes: Array(4097).fill(0) }]) }, /collection budget/);
        assert.match(text(await ok('read_multiple_files', { paths: [proof] })), new RegExp(marker));
    });
    await check('start, incremental output, interactive input and force_terminate', async () => {
        const pid = await processStart();
        try {
            assert.match(text(await ok('list_sessions', {})), new RegExp(String(pid)));
            const initial = text(await ok('read_process_output', { pid, offset: -1, timeout_ms: 1000 }));
            assert.match(initial, /P6_READY/);
            await ok('interact_with_process', { pid, input: 'HELLO_P6', wait_for_prompt: false, timeout_ms: 1000 });
            let output = '';
            for (let i = 0; i < 8 && !output.includes('P6_ECHO:HELLO_P6'); i++) {
                await delay(200);
                output += text(await ok('read_process_output', { pid, offset: 0, timeout_ms: 800 }));
            }
            assert.match(output, /P6_ECHO:HELLO_P6/);
        } finally {
            await ok('force_terminate', { pid });
        }
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
    await check('kill_process refuses outside PID and stops an owned session', async () => {
        foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: fixture, windowsHide: true, stdio: 'ignore' });
        await rejected('kill_process', { pid: foreign.pid }, /active Local DC/);
        assert.doesNotThrow(() => process.kill(foreign.pid, 0));
        const pid = await processStart();
        try {
            await ok('kill_process', { pid });
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        } finally {
            if (text(await ok('list_sessions', {})).includes(String(pid))) await ok('force_terminate', { pid });
        }
    });
    await check('stdio and local proxy protocol', () => assert.deepEqual(report.errors, []));
} catch (error) {
    report.cases.push({ name: 'setup', status: 'FAIL', error: String(error.stack).slice(0, 3000) });
} finally {
    if (foreign && foreign.exitCode === null) foreign.kill();
    if (client) await client.close().catch(() => {});
    if (proxy && proxy.exitCode === null) {
        const closed = once(proxy, 'exit');
        proxy.kill();
        await Promise.race([closed, delay(3000)]);
    }
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(out, 'p6-smoke-result.json'), JSON.stringify(report, null, 2) + '\n');
    for (const item of report.cases) console.log(item.status, item.name, item.error || '');
    process.exitCode = report.cases.some(item => item.status === 'FAIL') ? 1 : 0;
}

