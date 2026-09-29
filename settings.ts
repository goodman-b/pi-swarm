import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { GRANTABLE, TOOLKITS, applyGrants, resetGrants, type Grant } from './capabilities.ts';

export const SETTINGS_PATH = join(homedir(), '.pi', 'swarm.json');
/** Resolved per call so tests (and a second operator home) can point it elsewhere. */
export function settingsPath(): string { return process.env.SWARM_SETTINGS_PATH || SETTINGS_PATH; }
/** Operator-facing problems found while loading. Drained by the UI layer, never silent. */
const DIAGNOSTICS: string[] = [];
export function drainDiagnostics(): string[] { return DIAGNOSTICS.splice(0, DIAGNOSTICS.length); }
let unreadable = false;
export function settingsLocked(): boolean { return unreadable; }
export const DEFAULTS = {
  defaultAgents: 4, maxAgents: 16, defaultModel: '', defaultEffort: 'low',
  peerMaxTurns: 80, harvestMaxTurns: 30, reduceMaxTurns: 30, graceTurns: 3, wallSeconds: 3600, maxConcurrent: 8,
  // 1M for the WHOLE run (not per peer): a 4-peer audit of a ~1800-line package measured
  // 65k-130k per peer, so a 4-peer run lands around 300-500k. At 256k the cap cut 4-of-4
  // peers with zero lane files and the harvest had to re-derive everything from source.
  // The wall clock is the better lever for runaway runs; this is a backstop, not a throttle.
  runTokenCap: 1_000_000,
  boardRoot: join(homedir(), '.pi', 'swarm-boards'),
  widget: true, notifyOnSettle: true, refreshMs: 2000,
  defaultToolkit: 'minimal' as const, defaultTools: [] as string[], sandbox: 'auto' as const,
  grants: {} as Record<string, Grant | null>,
};
export type Settings = typeof DEFAULTS;
const ranges = {
  defaultAgents: [2, 16], maxAgents: [2, 16], peerMaxTurns: [1, 500], maxConcurrent: [1, 16],
  harvestMaxTurns: [1, 100], reduceMaxTurns: [1, 100], graceTurns: [0, 10], wallSeconds: [10, 14400], refreshMs: [250, 60000],
  runTokenCap: [0, 100_000_000],
} as const;
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function parseSettings(raw: unknown): Settings {
  const out = { ...DEFAULTS };
  // Grants FIRST, ahead of every early return. The registry is process-global, so a top-level
  // value that is not an object (null, [], 42, "x") parses fine, skips loadSettings' catch and
  // used to return at the guard below - leaving the PREVIOUS run's grants grantable. Revocation
  // must not depend on the shape of the rest of the file. v0.3.2.
  try { out.grants = applyGrants((raw as any)?.grants); }
  catch (e: any) {
    resetGrants(); out.grants = {};
    DIAGNOSTICS.push(`grants: ${e?.message ?? e} - grant definitions dropped, other settings kept`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    const v = r[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) (out as any)[key] = v;
  }
  for (const key of ['widget', 'notifyOnSettle'] as const) if (typeof r[key] === 'boolean') out[key] = r[key];
  if (typeof r.boardRoot === 'string' && isAbsolute(r.boardRoot)) out.boardRoot = r.boardRoot;
  if (typeof r.defaultModel === 'string' && r.defaultModel.trim()) out.defaultModel = r.defaultModel.trim();
  // defaultTools names are validated against the registry built above; a broken grants block
  // dropped ITSELF only - never the whole file - and left the registry empty (fail closed).
  if (typeof r.defaultEffort === 'string' && EFFORTS.includes(r.defaultEffort)) out.defaultEffort = r.defaultEffort;
  if (typeof r.defaultToolkit === 'string' && TOOLKITS.includes(r.defaultToolkit as any)) out.defaultToolkit = r.defaultToolkit as typeof out.defaultToolkit;
  if (Array.isArray(r.defaultTools)) {
    // Whole-field fallback, unchanged: one unusable name refuses the list. Now it says so.
    const list = [...new Set(r.defaultTools.map(x => typeof x === 'string' ? x.trim() : '').filter(Boolean))];
    const bad = r.defaultTools.filter(x => typeof x !== 'string' || !x.trim() || !Object.hasOwn(GRANTABLE, String(x).trim()));
    if (list.length && !bad.length) out.defaultTools = list;
    if (bad.length) DIAGNOSTICS.push(`defaultTools: refused the whole list (unknown grant name: ${bad.map(x => String(x)).join(', ')}) - grantable: ${Object.keys(GRANTABLE).join(', ')}`);
  }
  if (r.sandbox === 'auto' || r.sandbox === 'off') out.sandbox = r.sandbox;
  out.defaultAgents = Math.min(out.defaultAgents, out.maxAgents);
  return out;
}
export function loadSettings(): Settings {
  const file = settingsPath();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e: any) {
    // Missing file is normal. An unreadable one must never be replaced by defaults.
    unreadable = existsSync(file);
    if (unreadable) DIAGNOSTICS.push(`${file} is unreadable (${e?.message ?? e}) - running on defaults; saves are refused until you fix the file`);
    // The registry is process-global, so both branches must state it explicitly: a broken file
    // FAILS CLOSED (nothing grantable), a missing one gets the shipped defaults. Returning
    // DEFAULTS without touching GRANTABLE left last run's capabilities live either way.
    if (unreadable) resetGrants(); else applyGrants(DEFAULTS.grants);
    return { ...DEFAULTS };
  }
  unreadable = false;
  return parseSettings(raw);
}
export function saveSettings(raw: unknown): Settings {
  const file = settingsPath();
  if (unreadable) throw new Error(`Refusing to overwrite ${file}: it is unreadable. Fix or remove it, then retry.`);
  const settings = parseSettings(raw);
  mkdirSync(dirname(file), { recursive: true });
  // Same rule as board.ts atomicJson: unique name, chmod (mode is only honoured on create),
  // unlink on every path. A pid-only name collides on pid reuse and a throw left litter behind.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
  return settings;
}
