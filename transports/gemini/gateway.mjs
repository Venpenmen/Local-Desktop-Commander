import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const methods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping']);
const MAX_BODY = 4 * 1024 * 1024;
const authorized = (secret, header) => {
  if (typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/i.test(header)) return false;
  const a = Buffer.from(header.slice(7), 'hex');
  const b = Buffer.from(secret, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
export async function createGateway(bridge, {
  host = '127.0.0.1', port = 0, token = randomBytes(32).toString('hex'),
  timeout = 20000, onEvent = () => {}
} = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('LOOPBACK_ONLY');
  if (!/^[a-f0-9]{64}$/i.test(token)) throw Error('INVALID_TOKEN');
  let active = 0, credits = 40, last = Date.now(), closed = false;
  const respond = (res, status, body = {}) => res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store'
  }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp') return respond(res, 404);
    if (req.headers.origin) return respond(res, 403);
    if (!authorized(token, req.headers.authorization)) return respond(res, 401);
    if (req.method !== 'POST') return respond(res, 405);
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return respond(res, 415);
    if (Number(req.headers['content-length']) > MAX_BODY) return respond(res, 413);
    const now = Date.now();
    credits = Math.min(40, credits + (now - last) / 750);
    last = now;
    if (active >= 8 || credits < 1) return respond(res, 429);
    credits--; active++;
    let mcp;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.setHeader('Connection', 'close');
          return respond(res, 413);
        }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch {
        return respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400);
      onEvent({ event: 'request', method: methods.has(body.method) ? body.method : 'other' });
      mcp = new Server({ name: 'Local DC Gemini Adapter', version: '0.2.0' }, {
        capabilities: { tools: {} }
      });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.toolList() }));
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const name = params?.name;
        if (!bridge.toolList().some(tool => tool.name === name)) {
          return { content: [{ type: 'text', text: 'Tool is not allowed' }], isError: true };
        }
        try {
          const result = await bridge.call(name, params.arguments ?? {});
          onEvent({ event: 'call', name, isError: result.isError === true });
          // Keep native output schema, structuredContent, files and metadata intact.
          return result;
        } catch (error) {
          const reason = error?.code === -32001 ? 'MCP_TIMEOUT' : 'ENGINE_ERROR';
          onEvent({ event: 'call', name, isError: true, reason });
          return { content: [{ type: 'text', text: 'Local DC engine call failed' }], isError: true };
        }
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      onEvent({ event: 'gateway-error' });
      if (!res.headersSent) respond(res, 500);
      else if (!res.writableEnded) res.end();
    } finally {
      await mcp?.close().catch(() => {});
      active--;
    }
  });
  server.requestTimeout = timeout + 3000;
  server.headersTimeout = 5000;
  server.setTimeout(timeout + 3000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    host, port: server.address().port, token,
    status: () => ({ state: closed ? 'stopped' : 'running', pid: process.pid, port: server.address()?.port ?? null }),
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
