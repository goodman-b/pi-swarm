import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Run, Peer } from './runtime.ts';
import { events } from './board.ts';

export type DisplayRun = Omit<Run, 'state' | 'peers'> & {
  state: string; peers: (Omit<Peer, 'state'> & { state: string })[];
};
export interface RunRef { key: string; dir: string; mtime: number }
export function listRuns(root: string, session: string, all = false): RunRef[] {
  const found: RunRef[] = [];
  function walk(dir: string, key: string, depth: number) {
    try {
      const file = ['run.json', 'board.jsonl'].map(f => join(dir, f)).find(existsSync);
      if (key && file) { found.push({ key, dir, mtime: statSync(file).mtimeMs }); return; }
      if (!depth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) walk(join(dir, entry.name), key ? `${key}/${entry.name}` : entry.name, depth - 1);
      }
    } catch { /* one unreadable board must not hide the others */ }
  }
  walk(root, '', 2);
  return found.filter(r => all || r.key.startsWith(session + '/')).sort((a, b) => b.mtime - a.mtime || a.key.localeCompare(b.key));
}
export interface BoardOverview {
  goal: string; events: any[]; claims: { slice: string; agent: string }[];
  peers: DisplayRun['peers']; findings: number; collisions: number; roster: number;
}
export function boardOverview(dir: string): BoardOverview {
  const b: BoardOverview = { goal: '', events: events(dir), claims: [], peers: [], findings: 0, collisions: 0, roster: 0 };
  try { b.goal = readFileSync(join(dir, 'GOAL.md'), 'utf8'); } catch { /* seed pending */ }
  const peers = new Map<string, DisplayRun['peers'][number]>();
  for (const e of b.events) {
    if (e.kind === 'post' && e.thread === 'findings') b.findings++;
    if (e.thread === 'claims' && typeof e.text === 'string' && e.text.includes('collision')) b.collisions++;
    if (e.agent === 'system' && typeof e.text === 'string') {
      const n = /^swarm starting: (\d+) (?:peers|agents)/.exec(e.text);
      if (n) b.roster = Math.max(b.roster, Number(n[1]));
    }
    if (typeof e.agent !== 'string' || ['system', 'reaper'].includes(e.agent)) continue;
    const p = peers.get(e.agent) ?? { name: e.agent, state: 'unknown', turns: 0, toolCalls: 0, lastTool: '', lastActivity: 0, tokens: 0, cost: 0, text: '' };
    if (typeof e.ts === 'number' && Number.isFinite(e.ts)) p.lastActivity = Math.max(p.lastActivity, e.ts * 1000);
    if (e.kind === 'done' || e.kind === 'blocked') p.state = e.kind;
    p.text = (p.text + `\n${e.thread ?? e.kind}: ${e.text ?? e.reason ?? e.slice ?? ''}`).slice(-12000);
    peers.set(e.agent, p);
  }
  b.peers = [...peers.values()]; b.roster = Math.max(b.roster, b.peers.filter(p => !['harvest', 'reduce'].includes(p.name)).length);
  try {
    for (const file of readdirSync(join(dir, 'claims'), { withFileTypes: true })) {
      if (!file.isFile() || /\.(tmp|lock)$/.test(file.name)) continue;
      try {
        const c = JSON.parse(readFileSync(join(dir, 'claims', file.name), 'utf8'));
        if (c && typeof c.slice === 'string' && typeof c.agent === 'string') b.claims.push(c);
      } catch { /* claim publication can be in flight */ }
    }
  } catch { /* no claims */ }
  return b;
}
export function displayRun(ref: RunRef, live?: Run): DisplayRun {
  if (live?.dir === ref.dir) return live;
  try {
    const r = JSON.parse(readFileSync(join(ref.dir, 'run.json'), 'utf8'));
    if (!r || typeof r.id !== 'string' || !Number.isFinite(r.started) || !Array.isArray(r.peers)
      || !r.peers.every((p: any) => p && typeof p.name === 'string' && typeof p.state === 'string'
        && ['turns', 'toolCalls', 'tokens', 'cost'].every(k => Number.isFinite(p[k])))) throw new Error('Invalid run metadata');
    return { ...r, dir: ref.dir, state: r.ended ? r.state : 'unknown (recorded ' + r.state + ')',
      ...(!r.ended ? { error: 'Disk snapshot only; this UI does not own its runtime.' } : {}) };
  } catch {
    const b = boardOverview(ref.dir);
    const times = b.events.map(e => e.ts).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    return { id: basename(ref.dir), session: ref.key.includes('/') ? ref.key.split('/')[0] : '',
      dir: ref.dir, cwd: '', goal: b.goal, done: '', phase: 'legacy board', state: 'unknown', model: '',
      started: times.length ? times.reduce((a, t) => Math.min(a, t)) * 1000 : ref.mtime,
      ended: times.length ? times.reduce((a, t) => Math.max(a, t)) * 1000 : ref.mtime,
      peers: b.peers, error: 'Historical board only — runtime state and verification outcome unavailable. No automatic resume.' };
  }
}
