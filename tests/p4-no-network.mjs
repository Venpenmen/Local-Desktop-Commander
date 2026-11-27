import { appendFileSync } from 'node:fs';
import { Socket } from 'node:net';

const connect = Socket.prototype.connect;
Socket.prototype.connect = function () {
    appendFileSync(process.env.LOCAL_DC_NETWORK_REPORT, 'socket.connect\n');
    throw new Error('Network disabled for local MCP acceptance test');
};
globalThis.fetch = async () => {
    appendFileSync(process.env.LOCAL_DC_NETWORK_REPORT, 'fetch\n');
    throw new Error('Network disabled for local MCP acceptance test');
};
