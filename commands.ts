import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { boardOverview, displayRun, listRuns, type RunRef } from './history.ts';
import { showRun, oneLine } from './view.ts';
import { drainDiagnostics, EFFORTS, parseSettings, settingsPath, settingsLocked, type Settings } from './settings.ts';
import { validateLaunch, type Launch, type Run } from './runtime.ts';
import { grantList, GRANTABLE, parentInventory, resolveToolkit, TOOLKITS, type ParentInventory, type ResolvedToolkit, type Toolkit } from './capabilities.ts';

export interface Controls {
  settings(): Settings; save(s: Settings): void; live(): Run | undefined;
  parentInventory?: () => ParentInventory;
  start(a: Launch, ctx: ExtensionCommandContext): Promise<unknown>;
  cancel(): Promise<void>; steer(peer: string, message: string): Promise<void>;
}
export const fields: Record<keyof Settings, string> = {
  defaultAgents: 'Default peers', maxAgents: 'Maximum peers', defaultModel: 'Default model', defaultEffort: 'Thinking effort',
  peerMaxTurns: 'Peer turns', harvestMaxTurns: 'Harvest turns', reduceMaxTurns: 'Writer turns', graceTurns: 'Wrap-up turns', wallSeconds: 'Run deadline (seconds)',
  maxConcurrent: 'Peers prompting at once', runTokenCap: 'Run token cap (0 = off)',
  boardRoot: 'Board storage directory', widget: 'Status widget', notifyOnSettle: 'Completion notification', refreshMs: 'Refresh interval (ms)',
  defaultToolkit: 'Default toolkit', defaultTools: 'Default grant list', sandbox: 'Sandbox',
  grants: 'Capability grants',
};
// Value comparison, key-order independent: a parsed clone must not look like a change.
const norm = (v: unknown): any => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, val]) => [k, norm(val)]))
  : Array.isArray(v) ? v.map(norm) : v;
const eq = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
export async function settingsMenu(ctx: ExtensionCommandContext, c: Controls) {
  const warn = drainDiagnostics();
  if (warn.length) ctx.ui.notify(`Swarm settings: ${warn.join(' ')}`, 'warning');
  if (settingsLocked()) { ctx.ui.notify(`Not editing: ${settingsPath()} is unreadable and would be overwritten by defaults. Fix the file first.`, 'error'); return; }
  while (true) {
    const late = drainDiagnostics();
    if (late.length) ctx.ui.notify(`Swarm settings: ${late.join(' ')}`, 'warning');
    const s = c.settings(), keys = Object.keys(fields) as (keyof Settings)[];
    const labels = keys.map(k => `${fields[k]}: ${k === 'defaultModel' && !s[k] ? '(calling session model)'
      : k === 'grants' ? Object.keys(s.grants).length + ' override(s)' : oneLine(s[k])}`);
    const chosen = await ctx.ui.select('Swarm settings · changes apply to the next run', [...labels, 'Back']);
    const index = labels.indexOf(chosen ?? ''); if (index < 0) return;
    const k = keys[index], old = s[k];
    if (k === 'grants') { ctx.ui.notify(`Grant definitions are edited in ${settingsPath()} (see README § Grants) — not in this menu.`, 'info'); continue; }
    const raw = typeof old === 'boolean' ? !old
      : k === 'defaultModel' ? await ctx.ui.input(`${fields[k]} · provider/id, or "-" to use the calling session model (current: ${old || 'session model'})`)
      : k === 'defaultEffort' ? await ctx.ui.select(fields[k], EFFORTS)
      : k === 'defaultToolkit' ? await ctx.ui.select(fields[k], TOOLKITS)
      : k === 'sandbox' ? await ctx.ui.select(fields[k], ['auto', 'off'])
      : k === 'defaultTools' ? await ctx.ui.input(`${fields[k]} (grant names: ${Object.keys(GRANTABLE).join(', ') || 'none - declare some in the grants setting'}) (current: ${(old as string[]).join(', ')})`)
      : await ctx.ui.input(`${fields[k]} (current: ${old})`);
    if (raw === undefined || raw === '') continue;
    if (k === 'defaultModel' && String(raw).trim() === '-') { c.save(parseSettings({ ...s, defaultModel: '' })); continue; }
    let value: unknown;
    if (k === 'defaultTools') {
      const list = String(raw).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
      const bad = list.filter(x => !Object.hasOwn(GRANTABLE, x));
      // Whole-field fallback: one unknown grant name refuses the whole list, never a silent partial.
      if (bad.length) { ctx.ui.notify(`Unknown grant name${bad.length > 1 ? 's' : ''}: ${[...new Set(bad)].join(', ')} (grantable: ${Object.keys(GRANTABLE).join(', ')}) — unchanged.`, 'error'); continue; }
      value = list;
    } else value = typeof old === 'number' ? Number(raw) : raw;
    const next = { ...s, [k]: value };
    const parsed = parseSettings(next);
    // Do not silently drop a bad edit or change another field by clamping. `grants` is
    // excluded: normalizing a partial override (built-in fields filled in) is not an error.
    if (Object.keys(next).some(key => key !== 'grants' && !eq((next as any)[key], (parsed as any)[key]))) {
      ctx.ui.notify('Invalid value or inconsistent peer limits — unchanged.', 'error'); continue;
    }
    c.save(parsed);
  }
}
function toolkitSummary(t: ResolvedToolkit | undefined, err?: string): string[] {
  if (t) {
    const l = [`Toolkit: ${t.mode}`];
    if (t.mode === 'grants') {
      l.push(`Grants: ${t.grants.map(g => GRANTABLE[g]?.label ?? g).join(', ') || 'none'}`);
      if (t.effects.length) l.push(`Effects: ${t.effects.join(', ')}`);
      if (t.excluded.length) l.push(`Excluded: ${t.excluded.join(', ')}`);
    } else if (t.mode === 'inherit') {
      l.push(`Tools: ${t.toolNames.join(', ') || 'none'}`);
      if (t.excluded.length) l.push(`Excluded: ${t.excluded.join(', ')}`);
      l.push('Inherited extension effects are undeclared.');
      l.push('Extension-internal shell commands bypass bwrap.');
    } else {
      l.push('Tools: read, grep, find, ls (no shell, network or target writes)');
    }
    return l;
  }
  if (err) return [`Toolkit blocked: ${err}`];
  return ['Toolkit: not resolved'];
}
export async function launchMenu(ctx: ExtensionCommandContext, c: Controls) {
  const s = c.settings();
  const draft: Launch = { goal: '', done: '', agents: s.defaultAgents, effort: s.defaultEffort,
    model: s.defaultModel || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '') };
  const labels = { goal: 'Goal', done: 'Definition of done', agents: 'Peers', model: 'Model', effort: 'Thinking effort', toolkit: 'Toolkit', grants: 'Grants', toolset: 'Inherited toolset', slices: 'Candidate slices (optional)', write: 'Writer (edit files)', gate: 'Verification gate (command)' };
  let mode: string = s.defaultToolkit, selected = new Set<string>(s.defaultTools);
  // The writer toggle lives in the draft, so a run started with it on shows a different button
  // and a different confirmation. Off by default: peers stay read-only unless asked.
  let apply = false;
  const resolveAll = (): { t?: ResolvedToolkit; err?: string } => {
    try {
      const parent = mode === 'inherit' ? (c.parentInventory ? c.parentInventory() : undefined) : undefined;
      return { t: resolveToolkit(mode as Toolkit, grantList(mode as Toolkit, undefined, [...selected]), parent) };
    } catch (e: any) { return { err: String(e?.message || e) }; }
  };
  const inheritNote = (): string => {
    const { t, err } = resolveAll();
    return err ? err : `${t!.toolNames.length} tools: ${t!.toolNames.join(', ') || 'none'}`;
  };
  while (true) {
    const keys = Object.keys(labels) as (keyof typeof labels)[];
    const choiceText = (k: string): string => k === 'toolkit' ? mode
      : k === 'grants' ? mode === 'grants' ? [...selected].map(n => GRANTABLE[n]?.label ?? n).join(', ') || 'none' : 'n/a'
      : k === 'toolset' ? mode === 'inherit' ? inheritNote() : 'n/a'
      : k === 'write' ? (apply ? 'ON — one staged writer, gated' : 'off (read-only)')
      : k === 'gate' ? (apply ? oneLine(draft.reduceGate) || '(not set)' : 'n/a — set when writer is on')
      : oneLine(draft[k as keyof Launch]);
    const choices = keys.map(k => `${labels[k]}: ${choiceText(k).slice(0, 85) || '(not set)'}`);
    const startLabel = apply ? 'Start swarm with writer' : 'Start read-only swarm';
    const picked = await ctx.ui.select(`New swarm · ${s.peerMaxTurns}+${s.graceTurns} turns · ${s.wallSeconds}s deadline`,
      [...choices, startLabel, 'Back']);
    if (!picked || picked === 'Back') return;
    if (picked === startLabel) {
      const launch: Launch = { ...draft, toolkit: mode as Launch['toolkit'] };
      if (apply) launch.apply = true; else delete launch.apply;
      if (apply) launch.reduceGate = draft.reduceGate;
      if (!launch.model) delete launch.model; // empty = inherit the session model at launch
      // Only grants mode carries a tool list. start() applies grantList to the settings
      // fallback, so a leftover defaultTools needs no defending against here any more.
      if (mode === 'grants') launch.tools = [...selected];
      try { validateLaunch(launch, s); } catch (e: any) { ctx.ui.notify(e.message, 'error'); continue; }
      const first = resolveAll();
      // No silent fallback: an unresolvable toolkit refuses the launch with the resolver's own message.
      if (first.err) { ctx.ui.notify(first.err, 'error'); continue; }
      const extra = [...(s.sandbox === 'off' && first.t && (first.t.toolNames.length || first.t.mode === 'inherit') ? ['Sandbox is "off": granted or inherited tools run WITHOUT a bwrap box.'] : [])];
      // The writer line is not decoration: with it on, a reducer edits files and a passing gate
      // promotes them. Say so at the point of confirmation, with the gate named.
      const writerNote = apply ? [`Writer ENABLED: one staged writer may edit ${ctx.cwd ?? 'the workspace'}; "${launch.reduceGate}" must exit 0 or the changes are discarded.`] : [];
      if (!await ctx.ui.confirm('Launch swarm?', [`${launch.agents} peers + independent harvest`, `${launch.model || 'session model'} · ${launch.effort}`, ...toolkitSummary(first.t, first.err), ...writerNote, ...extra].join('\n'))) continue;
      // Parent state may change between preview and confirm: re-resolve and require a fresh confirmation.
      const second = resolveAll();
      if (JSON.stringify([second.t ?? null, second.err ?? '']) !== JSON.stringify([first.t ?? null, first.err ?? ''])) {
        if (!await ctx.ui.confirm('Launch swarm? (resolved toolkit changed since the last preview — confirm the new set)',
          [`${launch.agents} peers + independent harvest`, `${launch.model || 'session model'} · ${launch.effort}`, 'Resolved toolkit changed since the last preview:', ...toolkitSummary(second.t, second.err), ...writerNote, ...extra].join('\n'))) continue;
      }
      try { await c.start(launch, ctx); }
      catch (e: any) { ctx.ui.notify(String(e.message || e), 'error'); continue; }
      ctx.ui.notify('Swarm started. Open Current run to watch it.', 'info'); return;
    }
    const k = keys[choices.indexOf(picked)]; if (!k) continue;
    if (k === 'write') {
      const v = await ctx.ui.select('Writer · one staged reducer may edit files, gated by a command you supply. Peers stay read-only either way.', ['off (read-only)', 'on (staged writer)']);
      if (v !== undefined) {
        apply = v.startsWith('on');
        // Turning it on without a gate is the common half-finished state; offer one now.
        if (apply && !draft.reduceGate) { draft.reduceGate = ''; ctx.ui.notify('Set a verification gate next — without it the writer cannot start.', 'info'); }
      }
    } else if (k === 'gate') {
      if (!apply) { ctx.ui.notify('The gate only matters when the writer is on.', 'info'); continue; }
      const v = await ctx.ui.editor('Verification gate · a command run after the writer finishes, inside a read-only view of the staged tree. Exit 0 promotes the changes; anything else discards them.', draft.reduceGate ?? '');
      if (v !== undefined) draft.reduceGate = v.trim();
    } else if (k === 'effort') { const v = await ctx.ui.select('Thinking effort', EFFORTS); if (v !== undefined) draft.effort = v; }
    else if (k === 'model') {
      const models = (ctx.scopedModels?.length ? ctx.scopedModels.map(x => x.model) : ctx.modelRegistry.getAvailable());
      const options = [...new Set([String(draft.model), ...models.map(m => `${m.provider}/${m.id}`)])];
      const v = await ctx.ui.select('Model · only configured/scoped choices', options); if (v !== undefined) draft.model = v;
    } else if (k === 'toolkit') {
      const v = await ctx.ui.select('Toolkit · minimal (no grants) | grants (named read-only capabilities) | inherit (parent tool set)', [...TOOLKITS, 'Keep']);
      if (v && TOOLKITS.includes(v as any)) {
        if (v !== mode) { mode = v; if (v !== 'grants') selected.clear(); else if (!selected.size) selected = new Set(s.defaultTools); }
      }
    } else if (k === 'grants') {
      if (mode !== 'grants') { mode = 'grants'; if (!selected.size) selected = new Set(s.defaultTools); }
      const names = Object.keys(GRANTABLE);
      const rows = names.length
        ? names.map(n => `${GRANTABLE[n].label}: ${selected.has(n) ? '✓' : '○'} (${GRANTABLE[n].effects.join(', ')})`)
        : ['No grants declared - add them to the grants setting first'];
      const v = await ctx.ui.select(`Toolkit grants · toggle, rendered from the grant registry; keep = unchanged`, [...rows, 'Keep']);
      if (!v || v === 'Keep') continue;
      const n = names.find(x => v.startsWith(`${GRANTABLE[x].label}:`));
      if (n) { if (selected.has(n)) selected.delete(n); else selected.add(n); }
    } else if (k === 'toolset') {
      // Read-only preview of the live-resolved inherit set; changing it happens via the Toolkit field.
      const { t, err } = resolveAll();
      ctx.ui.notify(err ?? `Inherited now: ${t!.toolNames.length} tools — ${t!.toolNames.join(', ') || 'none'}\nExcluded: ${t!.excluded.join(', ') || 'none'}`, err ? 'error' : 'info');
    } else if (k === 'agents') {
      const v = await ctx.ui.input(`Peer count: 2–${s.maxAgents}`); if (v === undefined) continue;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 2 && n <= s.maxAgents) draft.agents = n;
      else ctx.ui.notify(`Choose a whole number from 2 to ${s.maxAgents}`, 'error');
    } else {
      const v = await ctx.ui.editor(labels[k], k === 'slices' ? draft.slices?.join('\n') ?? '' : draft[k]);
      if (v !== undefined) { if (k === 'slices') draft.slices = v.split('\n').map(x => x.trim()).filter(Boolean); else draft[k] = v; }
    }
  }
}
export async function swarmCommand(args: string, ctx: ExtensionCommandContext, c: Controls): Promise<void> {
  const session = ctx.sessionManager.getSessionId();
  const runs = (all = false) => listRuns(c.settings().boardRoot, session, all);
  const open = async (ref: RunRef, choices: RunRef[]) => showRun(ctx,
    () => displayRun(ref, c.live()), {
      settings: c.settings(),
      cycle: delta => { const i = choices.findIndex(x => x.key === ref.key); ref = choices[(i + delta + choices.length) % choices.length]; },
      controls: () => c.live()?.dir === ref.dir && !c.live()?.ended,
      steer: c.steer, cancel: c.cancel,
    });
  const browse = async (all: boolean) => {
    while (true) {
      const refs = runs(all);
      if (!refs.length) { ctx.ui.notify(all ? 'No boards found.' : 'No boards in this session. Choose All sessions for older boards.', 'info'); return; }
      const labels = refs.map(ref => {
        const r = displayRun(ref, c.live()), b = boardOverview(ref.dir);
        return oneLine(`${ref.key} · ${r.state} · ${Math.max(r.peers.filter(p => !['harvest', 'reduce'].includes(p.name)).length, b.roster)} peers · ${b.findings} findings`);
      });
      const pick = await ctx.ui.select(all ? 'All sessions · read-only browsing of other sessions' : 'This session’s swarms', [...labels, 'Back']);
      const i = labels.indexOf(pick ?? ''); if (i < 0) return;
      await open(refs[i], refs);
    }
  };
  try {
    const [cmd, id] = args.trim().split(/\s+/);
    if (!cmd || cmd === 'menu') {
      while (true) {
        const live = c.live(), refs = runs();
        const first = live ? oneLine(`Current run: ${live.id} · ${live.phase}/${live.state}`) : refs.length ? oneLine(`Latest board: ${refs[0].key}`) : undefined;
        const options = [...(first ? [first] : []), 'New swarm', 'This session’s runs', 'All sessions', 'Settings', 'Close'];
        const pick = await ctx.ui.select('Swarm · standalone peer system', options);
        if (!pick || pick === 'Close') return;
        if (pick === first) {
          const ref = live ? { key: `${live.session}/${live.id}`, dir: live.dir, mtime: live.started } : refs[0];
          await open(ref, refs.length ? refs : [ref]);
        } else if (pick === 'New swarm') await launchMenu(ctx, c);
        else if (pick === 'Settings') await settingsMenu(ctx, c);
        else await browse(pick === 'All sessions');
      }
    }
    if (cmd === 'new') return await launchMenu(ctx, c);
    if (cmd === 'settings') return await settingsMenu(ctx, c);
    if (cmd === 'runs' || cmd === 'all') return await browse(cmd === 'all' || id === 'all');
    if (cmd === 'cancel') {
      const target = c.live();
      if (!target || target.ended) { ctx.ui.notify('No active swarm.', 'info'); return; }
      if (await ctx.ui.confirm('Cancel current swarm?', 'Artifacts survive. Applied edits are not rolled back.') && c.live() === target && !target.ended) await c.cancel();
      return;
    }
    const wanted = ['status', 'board', 'peek'].includes(cmd) ? (cmd === 'peek' ? undefined : id) : cmd;
    const refs = runs();
    const ref = wanted ? refs.find(r => r.key === wanted || r.key.endsWith('/' + wanted)) : refs[0];
    if (!ref) throw new Error('No matching board in this session. Use /swarm all to browse other sessions.');
    await showRun(ctx, () => displayRun(ref, c.live()), { settings: c.settings(),
      initialTab: cmd === 'board' ? 'Board' : cmd === 'peek' ? 'Peers' : 'Overview', initialPeer: cmd === 'peek' ? id : undefined,
      controls: () => c.live()?.dir === ref.dir && !c.live()?.ended, steer: c.steer, cancel: c.cancel });
  } catch (e: any) { ctx.ui.notify(String(e.message || e), 'error'); }
}
