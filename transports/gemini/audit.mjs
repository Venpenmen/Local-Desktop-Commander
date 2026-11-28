import {
  appendFileSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync
} from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;
const safeFields = new Set([
  'event', 'method', 'name', 'isError', 'reason',
  'toolCount', 'accessMode', 'toolMode'
]);
/** Bounded local trace. No raw tool arguments, results, tokens, secrets or paths. */
export function createAuditLog(instance) {
  const directory = join(instance, 'logs');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw Error('UNSAFE_LOG_DIRECTORY');
  const file = join(directory, 'events.ndjson');
  const archived = join(directory, 'events.previous.ndjson');
  return event => {
    const record = { utc: new Date().toISOString() };
    for (const [key, value] of Object.entries(event ?? {})) {
      if (!safeFields.has(key)) continue;
      if (typeof value === 'boolean') record[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
      else if (typeof value === 'string') record[key] = value.slice(0, 60);
    }
    const line = JSON.stringify(record) + '\n';
    for (const target of [file, archived]) {
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw Error('UNSAFE_LOG_FILE');
    }
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > MAX_BYTES) {
      if (existsSync(archived)) unlinkSync(archived);
      renameSync(file, archived);
    }
    appendFileSync(file, line, { encoding: 'utf8' });
  };
}
