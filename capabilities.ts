import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export type Toolkit = 'minimal' | 'grants' | 'inherit';
export const TOOLKITS: Toolkit[] = ['minimal', 'grants', 'inherit'];

export interface Grant {
  path: string; tools: string[]; effects: string[]; label: string;
}
/** The grant registry ships EMPTY. A package must not guess where another package got
 * installed, so every capability a run may borrow is data the operator declares in the
 * `grants` setting - see README § Grants. */
export const GRANTABLE: Record<string, Grant> = {};

const GRANT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const BUILTIN: Record<string, Grant> = JSON.parse(JSON.stringify(GRANTABLE));
/** Replace the registry contents in place (call sites hold this object). */
function commit(next: Record<string, Grant>): void {
  for (const k of Object.keys(GRANTABLE)) delete GRANTABLE[k];
  Object.assign(GRANTABLE, next);
}
/** Rebuild the registry from what the package ships (empty). Used by the reset path and by tests. */
export function resetGrants(): void { commit(JSON.parse(JSON.stringify(BUILTIN))); }
/** Validate EVERY entry first, then commit once: a rejected definition can never
 * leave a partially applied registry. A load replaces the registry, so a grant that
 * disappeared from the file stops being grantable. `null` removes an entry; a partial
 * entry (e.g. just `path`) keeps the existing entry's other fields. Returns the serializable form. */
export function applyGrants(raw: unknown): Record<string, Grant | null> {
  // FAIL CLOSED. The registry is a process-global and a load is the only thing that replaces it,
  // so an absent or null block used to leave the PREVIOUS run's grants grantable forever - a
  // revoked capability that a later swarm_start({toolkit:'grants', tools:[...]}) could still use.
  // The registry ships empty by design; "no grants declared" must mean exactly that.
  if (raw === undefined || raw === null) { resetGrants(); return {}; }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('grants must be an object of {name: {path, tools, effects, label} | null}');
  const next: Record<string, Grant> = JSON.parse(JSON.stringify(BUILTIN));
  const out: Record<string, Grant | null> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!GRANT_NAME.test(name)) throw new Error(`Invalid grant name: ${name} (lowercase, starts with a letter, ≤32 chars)`);
    if (value === null) { delete next[name]; out[name] = null; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Grant ${name} must be an object or null`);
    const g = { ...(BUILTIN[name] ?? {}), ...(value as Record<string, unknown>) } as Record<string, unknown>;
    if (typeof g.path !== 'string' || !isAbsolute(g.path)) throw new Error(`Grant ${name}.path must be an absolute path${BUILTIN[name] ? '' : ` (a fresh grant needs the full {path, tools} definition; partial merges only update an existing entry)`}`);
    if (!Array.isArray(g.tools) || !g.tools.length || g.tools.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`Grant ${name}.tools must be a non-empty array of tool names`);
    if (g.effects !== undefined && (!Array.isArray(g.effects) || g.effects.some(x => typeof x !== 'string'))) throw new Error(`Grant ${name}.effects must be an array of strings`);
    if (g.label !== undefined && (typeof g.label !== 'string' || !g.label.trim() || g.label.length > 40)) throw new Error(`Grant ${name}.label must be a short string`);
    next[name] = { path: g.path, tools: (g.tools as string[]).map(x => x.trim()), effects: (g.effects as string[]) ?? [], label: (g.label as string)?.trim() || name };
    out[name] = { ...next[name] };
  }
  commit(next);
  return out;
}

// Delegation and scheduling tools are never inherited: a peer must not fan out,
// self-schedule or talk to a second swarm. Hook-only extensions produce no tool or
// command source path, so they are not inherited at all — by design, their effects are
// invisible to a peer and cannot be declared.
export const EXCLUDED_TOOLS = ['Agent', 'SubagentWorkflow', 'schedule', 'swarm_start',
  'swarm_status', 'swarm_steer', 'swarm_cancel'];
export const EXCLUDED_PATHS = ['swarm/index.ts', 'swarm/board.ts', 'scheduling'];
/** Paths of this package itself, added at load so a peer can never inherit the swarm
 * extension back. Precise by realpath - unlike the historical name substrings above.
 * A degenerate path (root, home, missing) is refused: excluding '/' would exclude everything. */
const SELF_PATHS: string[] = [];
export function excludeSelf(path: string): void {
  if (!isAbsolute(path)) return;
  const p = realPath(path);
  if (!p || p === '/' || p === dirname(p) || SELF_PATHS.includes(p)) return;
  SELF_PATHS.push(p);
}
export function selfPaths(): readonly string[] { return SELF_PATHS; }
/** Tools only mean grants in grants mode. A leftover `defaultTools` setting must not poison
 * another toolkit (the launch form clears it; the tool path used to throw instead). An
 * explicit list - including an empty one - always wins. */
export function grantList(toolkit: Toolkit, requested: string[] | undefined, fallback: string[]): string[] {
  return requested ?? (toolkit === 'grants' ? fallback : []);
}
/** Shell-class tools: peers are always read-only; only the reduce session gets them. */
export const READONLY_VIOLATORS = ['bash', 'write', 'edit'];
/** Keep only real local paths: drop '<builtin:...>'-style paths and anything that does not exist. */
const realPath = (p: string): string | undefined => {
  if (!p || p.startsWith('<')) return undefined;
  let r: string; try { r = realpathSync(p); } catch { return undefined; }
  return existsSync(r) ? r : undefined;
};

export interface ResolvedToolkit {
  mode: Toolkit; grants: string[]; extensionPaths: string[]; toolNames: string[];
  effects: string[]; excluded: string[];
}
export interface ParentInventory {
  tools: { name: string; path: string }[]; paths: string[];
}

const dedupe = (xs: string[]) => [...new Set(xs)];
/** Case-insensitive exclusion match on the realpath (realpath + casefold). */
const excludedPath = (p: string) => SELF_PATHS.some(x => p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`)) ||
  // Anchored on BOTH sides: 'audit-swarm/index.ts' is not 'swarm/index.ts', and a
  // 'scheduling-assistant' extension is not the 'scheduling' one.
  EXCLUDED_PATHS.some(x => { const n = '/' + x.toLowerCase(), h = '/' + p.toLowerCase(); return h.includes(n + '/') || h.endsWith(n); });

/** Snapshot of what the parent session can actually load: tool sources + command sources.
 * Only real local paths survive: '<builtin:...>' and missing paths are dropped, realpaths stored. */
export function parentInventory(pi: any): ParentInventory {
  if (typeof pi?.getAllTools !== 'function' || typeof pi?.getCommands !== 'function') {
    throw new Error('toolkit "inherit" needs pi.getAllTools() and pi.getCommands(); this Pi API does not expose them — use toolkit "minimal" or "grants"');
  }
  const tools = (pi.getAllTools() as any[]).map(t => ({ name: String(t.name), path: realPath(String(t?.sourceInfo?.path ?? '')) ?? '' }));
  const commands = (pi.getCommands() as any[]).map(c => realPath(String(c?.sourceInfo?.path ?? '')) ?? '');
  return { tools, paths: dedupe([...tools.map(t => t.path), ...commands]).filter(Boolean) };
}

export function resolveToolkit(mode: Toolkit, grants: string[] = [], parent?: ParentInventory): ResolvedToolkit {
  if (!TOOLKITS.includes(mode)) throw new Error(`Unknown toolkit: ${mode}`);
  if (!Array.isArray(grants) || grants.some(x => typeof x !== 'string' || !x.trim())) throw new Error('tools must be an array of grant names');
  const list = dedupe(grants.map(x => x.trim()));
  if (mode !== 'grants' && list.length) throw new Error(`Explicit tools require toolkit "grants" (got "${mode}")`);
  if (mode === 'grants') {
    for (const g of list) if (!Object.hasOwn(GRANTABLE, g)) throw new Error(`Unknown grant: ${g} (grantable: ${Object.keys(GRANTABLE).join(', ')})`);
    const grants2 = list.filter(Boolean);
    for (const g of grants2) {
      const gr = GRANTABLE[g];
      if (!Array.isArray(gr.tools) || gr.tools.some(x => typeof x !== 'string')) throw new Error(`Grant registry ${g} has malformed tools`);
      if (!realPath(gr.path)) throw new Error(`Grant registry ${g} path does not exist on this host: ${gr.path}`);
      if (gr.tools.some(x => READONLY_VIOLATORS.includes(x))) throw new Error(`Grant ${g} is shell-class and cannot be used on a read-only run`);
      // A named grant cannot open the recursion boundary either. Inherit already strips these;
      // grants mode had no equivalent, so declaring {tools:["Agent"]} or {tools:["swarm_start"]}
      // handed a peer the very capability the package promises it never has.
      const deleg = gr.tools.filter(x => EXCLUDED_TOOLS.includes(x));
      if (deleg.length) throw new Error(`Grant ${g} exposes delegation/run-control tools (${deleg.join(', ')}); a peer must never be able to spawn`);
    }
    return freeze({ mode, grants: grants2,
      extensionPaths: dedupe(grants2.map(g => GRANTABLE[g].path)),
      toolNames: dedupe(grants2.flatMap(g => GRANTABLE[g].tools)),
      effects: dedupe(grants2.flatMap(g => GRANTABLE[g].effects)), excluded: [] });
  }
  if (mode === 'inherit') {
    if (!parent) throw new Error('toolkit "inherit" requires a parent inventory at launch');
    const excluded = [...parent.tools.filter(t => EXCLUDED_TOOLS.includes(t.name)).map(t => t.name),
      ...parent.paths.filter(excludedPath)];
    // Shell class is DROPPED here, not an error: an interactive parent almost always has bash,
    // so throwing would make inherit unusable everywhere (it did). The operator who names a
    // shell-class GRANT gets an error instead - that one is a deliberate request. Peers are
    // read-only by construction in every mode; the reducer gets shell structurally (sdk.ts).
    const kept = parent.tools.filter(t => !EXCLUDED_TOOLS.includes(t.name) && !excludedPath(t.path));
    const shell = kept.map(t => t.name).filter(t => READONLY_VIOLATORS.includes(t));
    const names = dedupe(kept.map(t => t.name).filter(t => !READONLY_VIOLATORS.includes(t)));
    return freeze({ mode, grants: [],
      extensionPaths: parent.paths.filter(p => !excludedPath(p) && !kept.some(t => t.path === p && READONLY_VIOLATORS.includes(t.name))),
      toolNames: names, effects: [], excluded: dedupe([...excluded, ...shell]) });
  }
  return freeze({ mode: 'minimal', grants: [], extensionPaths: [], toolNames: [], effects: [], excluded: [] });
}

function freeze(t: ResolvedToolkit): ResolvedToolkit {
  for (const k of ['grants', 'extensionPaths', 'toolNames', 'effects', 'excluded'] as const) Object.freeze(t[k]);
  return Object.freeze(t);
}

/** Peer-facing truth about what this toolkit can reach, plus the terminal protocol line. */
export function toolkitPrompt(t: ResolvedToolkit, mode: 'peer' | 'harvest' | 'reduce'): string {
  const lines: string[] = [];
  if (t.mode === 'grants') {
    lines.push(`Granted capabilities beyond read-only source inspection: ${t.grants.map(g => GRANTABLE[g]?.label ?? g).join(', ') || 'none'}.`);
    for (const g of t.grants) {
      const gr = GRANTABLE[g];
      lines.push(gr?.effects.length ? `${gr.label}: ${gr.effects.join(', ')}.`
        : `${gr?.label ?? g}: effects undeclared by its grant definition - assume it can reach whatever its tools can reach.`);
    }
    lines.push('Granted tools run in-process; the sandboxed shell has no network access.');
    lines.push('Everything else stays off: no shell, no project writes.');
    if (t.extensionPaths.length) lines.push('Extension-internal shell commands bypass bwrap.');
  } else if (t.mode === 'inherit') {
    lines.push(`Inherited parent tools: ${t.toolNames.join(', ') || 'none'}.`);
    lines.push('Inherited extension effects are undeclared.');
    lines.push('Extension-internal shell commands bypass bwrap.');
  } else lines.push('Tools intentionally exclude shell, network and project writes. If these are needed, report the limitation.');
  if (mode !== 'reduce') lines.push('Final text alone does not mark your work done; call done or blocked. Do not modify the target.');
  return lines.join('\n') + '\n';
}
