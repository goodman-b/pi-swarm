import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const BOARD_BIN = join(dirname(fileURLToPath(import.meta.url)), 'board', 'swarm-board');
export function component(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error('Invalid run/session identifier');
  return value;
}
export function atomicJson(path: string, value: unknown): void {
  // Unique name + finally-unlink: a pid-only name collides across concurrent writers and a
  // throw (ENOSPC) left run.json.<pid>.tmp behind forever. mode is chmodded, not just set on
  // create - an existing 0644 file keeps its mode otherwise. audit-r2/B13.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }   // gone after a successful rename; rmSync is forgiving
}
export function events(dir: string): any[] {
  try {
    return readFileSync(join(dir, 'board.jsonl'), 'utf8').split('\n').flatMap(line => {
      try { const e = JSON.parse(line); return e && typeof e.kind === 'string' ? [e] : []; }
      catch { return []; }
    });
  } catch { return []; }
}
export class Board {
  constructor(readonly root: string, readonly runId: string) { component(runId); }
  get dir() { return join(this.root, this.runId); }
  async call(who: string, args: string[], signal?: AbortSignal): Promise<string> {
    component(who);
    try {
      const r = await exec('python3', [BOARD_BIN, '--root', this.root, '--run', this.runId, '--me', who, ...args],
        { signal, timeout: 25000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, SWARM_BOARD_LOCK_TIMEOUT: '10' } });
      return r.stdout;
    } catch (e: any) {
      if (e.code === 3) return e.stdout || 'Claim denied';
      throw new Error(`Board operation failed: ${String(e.stderr || e.message).slice(0, 1000)}`);
    }
  }
}
