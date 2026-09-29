import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantList, parentInventory, resolveToolkit, excludeSelf, type ParentInventory } from './capabilities.ts';
import { preflight } from './sandbox.ts';
import { component } from './board.ts';
import { swarmCommand } from './commands.ts';
import { loadSettings, saveSettings, drainDiagnostics, settingsPath, MAX_PEERS } from './settings.ts';
import { SwarmRuntime, validateLaunch, peerCounts, peerCountsLine, type Launch, type Run } from './runtime.ts';
import { prepareSDK, runGate } from './sdk.ts';
import { displayRun, type DisplayRun } from './history.ts';

export const VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
).version;
// A peer must never inherit the swarm extension itself.
excludeSelf(dirname(fileURLToPath(import.meta.url)));
function compact(run: Run) {
  return { ...run, peers: run.peers.map(({ text, ...p }) => ({ ...p, preview: text.slice(-800) })) };
}
function result(data: unknown) {
  const value = JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text: value.slice(0, 24000) + (value.length > 24000 ? '\n[truncated; inspect run.json on disk]' : '') }], details: {} };
}
export default function swarm(pi: ExtensionAPI) {
  let settings = loadSettings(), engine: SwarmRuntime | undefined;
  let closing = false, launching = false, generation = 0;
  let owner: ExtensionContext | undefined;
  const sessionId = (ctx: ExtensionContext) => component(ctx.sessionManager.getSessionId());
  const summary = (r: Run) => `swarm ${r.id} · ${r.phase}/${r.state} · ${r.peers.filter(p => p.state === 'running').length} running · ${r.peers.reduce((n, p) => n + p.tokens, 0)} tokens`;
  const widget = (r: Run) => {
    if (!closing && settings.widget && owner?.hasUI) owner.ui.setWidget('swarm', [summary(r)], { placement: 'belowEditor' });
  };
  const readRun = (ctx: ExtensionContext, id?: string): DisplayRun => {
    const live = engine?.run;
    if (!id) { if (live) return live; throw new Error('No run in this session; use /swarm runs'); }
    // Accept the exact key the browser prints ('session/runId') or a bare runId.
    const key = id.includes('/') ? id.split('/').map(component).join('/') : `${sessionId(ctx)}/${component(id)}`;
    return displayRun({ key, dir: join(settings.boardRoot, key), mtime: 0 }, live);
  };
  async function start(a: Launch, ctx: ExtensionContext) {
    if (closing || launching || (engine?.run && !engine.run.ended)) throw new Error('Swarm is busy or shutting down');
    // Read before ANYTHING else: validateLaunch, defaultModel and the budget knobs must all see
    // the same snapshot, or an edit landing between session_start and launch tears the run down
    // after the preflight, or silently mixes two files. audit-r2/C5 + D1.
    settings = loadSettings();
    if (a.model === '') delete a.model; // empty string means "inherit", not "invalid"
    validateLaunch(a, settings);
    // Model precedence: explicit arg > settings default > the calling session's model.
    const model = a.model || settings.defaultModel || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '');
    if (!model) throw new Error(`No swarm model: pass model, set defaultModel in ${settingsPath()}, or launch from a session with a current model`);
    a.model = model;
    launching = true;
    try { // launching must clear on every exit path; engine.run covers the guard afterwards
    const current = generation;
    let parent: ParentInventory | undefined;
    // Probe tools where THEY RUN: peers/harvest resolve rg (pi's grep helper) in-process on the
    // host PATH; only a staged apply run puts a shell inside the box. sandbox:'off' means host.
    const pf = await preflight(async argv => {
      const r = await (pi as any).exec?.(argv[0], argv.slice(1), { timeout: 20000 });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }, settings.boardRoot, settings.sandbox !== 'off' && a.apply === true);   // probe the filesystem the writer will actually use, not $TMPDIR
    if (closing || current !== generation) throw new Error('Session changed during launch');
    // Resolve the frozen capability selection from the parent inventory before any session exists.
    const toolkit = a.toolkit ?? settings.defaultToolkit;
    const grants = grantList(toolkit, a.tools, settings.defaultTools);
    parent = toolkit === 'inherit' ? parentInventory(pi) : undefined;
    const resolved = resolveToolkit(toolkit, grants, parent);
    const create = await prepareSDK(a.model, ctx.scopedModels);
    if (closing || current !== generation) throw new Error('Session changed during launch');
    owner = ctx;
    engine = new SwarmRuntime(create, (c, cwd, signal, staging) => runGate(c, cwd, signal, staging), widget, r => {
      if (closing || current !== generation) return;
      if (ctx.hasUI) ctx.ui.setWidget('swarm', undefined);
      if (settings.notifyOnSettle) pi.sendMessage({ customType: 'swarm-result',
        content: `${summary(r)}\n${peerCountsLine(r.peers)}${peerCounts(r.peers).done < peerCounts(r.peers).total ? ' · INCOMPLETE: not all peers finished' : ''}\nGoal met: ${r.metGoal ?? false}\nReport: ${r.report ?? r.dir}\n${r.error ?? ''}\n${r.sandbox?.warning ? `Sandbox: ${r.sandbox.warning}\n` : ''}Use swarm_status for details.`,
        display: true, details: compact(r),
      }, { triggerTurn: true, deliverAs: 'followUp' });
    }, async () => pf, () => resolved);
    return compact(engine.start(a, settings, sessionId(ctx), ctx.cwd, { parent, preflight: pf }));
    } finally { launching = false; }
  }
  pi.registerTool({
    name: 'swarm_start', label: 'Start swarm',
    description: 'Start the standalone self-organising peer swarm. Use only when the user requests a swarm. Peers choose and claim work, challenge findings, and an independent harvest verifies results. Peers are this package\'s own SDK sessions, not delegated subagents or role profiles. Background; completion is notified. Read-only by default (no shell/network). toolkit grants opt in named read-only capabilities declared in the `grants` setting (the registry ships empty); inherit mirrors the parent session\'s tool set minus delegation tools. apply=true explicitly enables a single staged writer and requires a working bwrap sandbox plus a shell verification gate; a failing gate discards all staged changes. Never enable apply without user authorization. Peers choose the work: do not pre-split fixed lanes when discovery is the point. Give a measurable definition of done, not a quota. A read-only run means source inspection only - state that limitation rather than swapping in unrestricted subagents. Peers beyond maxConcurrent queue against one shared wall clock, so size the roster and the deadline together; hitting either limit stops the peers but the harvest still reports what was found.',
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 32000 }), done: Type.String({ minLength: 1, maxLength: 32000 }),
      agents: Type.Optional(Type.Integer({ minimum: 2, maximum: MAX_PEERS })), model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()), runId: Type.Optional(Type.String()),
      slices: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      apply: Type.Optional(Type.Boolean()), reduceGate: Type.Optional(Type.String()),
      toolkit: Type.Optional(Type.String({ enum: ['minimal', 'grants', 'inherit'] })),
      tools: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
    }),
    async execute(_id, args, _signal, _update, ctx) { return result(await start(args, ctx)); },
  });
  pi.registerTool({
    name: 'swarm_status', label: 'Swarm status', description: 'Inspect this session’s current or historical swarm, peer activity, artifacts and transcript paths. No inference.',
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) { return result(compact(readRun(ctx, args.runId))); },
  });
  pi.registerTool({
    name: 'swarm_steer', label: 'Steer peer', description: 'Send an operator correction to a running swarm peer, including harvest or reduce. Does not use subagent handles.',
    parameters: Type.Object({ peer: Type.String(), message: Type.String({ minLength: 1, maxLength: 8000 }) }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!engine) throw new Error('No active swarm');
      await engine.steer(args.peer, args.message); return result({ delivered: true });
    },
  });
  pi.registerTool({
    name: 'swarm_cancel', label: 'Cancel swarm', description: 'Cancel the current swarm, preserving board, reports and transcripts. Discards any staged (not yet promoted) changes.',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) { if (!engine) throw new Error('No active swarm'); await engine.abort(); return result({ cancellationRequested: true }); },
  });
  pi.on('session_start', (_e, ctx) => {
    closing = false; owner = ctx; settings = loadSettings();
    const d = drainDiagnostics();
    if (d.length && ctx.hasUI) ctx.ui.notify(`Swarm settings: ${d.join(' ')}`, 'warning');
  });
  pi.on('session_shutdown', async () => {
    closing = true; generation++;
    if (owner?.hasUI) owner.ui.setWidget('swarm', undefined);
    await engine?.close(); engine = undefined; owner = undefined;
  });
  pi.registerCommand('swarm', {
    description: `Standalone swarm v${VERSION}: menu | new | runs | all | status [run] | board [run] | peek <peer> | cancel | settings`,
    handler: (args, ctx) => swarmCommand(args, ctx, {
      settings: () => settings,
      save: next => { settings = saveSettings(next); },
      live: () => engine?.run,
      parentInventory: () => parentInventory(pi),
      start,
      cancel: async () => { await engine?.abort(); },
      steer: async (peer, message) => {
        if (!engine) throw new Error('No active swarm');
        await engine.steer(peer, message);
      },
    }),
  });
}
