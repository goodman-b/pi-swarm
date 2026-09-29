import { Type } from 'typebox';
import {
  createAgentSession, createBashTool, createBashToolDefinition, createEditToolDefinition, createLocalBashOperations,
  createReadToolDefinition, createWriteToolDefinition, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, defineTool,
} from '@earendil-works/pi-coding-agent';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isOpaqueUpper } from './runtime.ts';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { normaliseWhiteouts, wrap } from './sandbox.ts';
import { READONLY_VIOLATORS } from './capabilities.ts';
import type { SpawnSpec, SessionLike } from './runtime.ts';
// No private subagent imports, parent session clone, profile discovery, or global
// extension loading. The only shared layer is Pi's public SDK/model credentials.
export interface LoaderArgs {
  cwd: string; settingsManager: SettingsManager;
  noExtensions: true; noSkills: true; noPromptTemplates: true; noThemes: true; noContextFiles: true;
  systemPromptOverride: (base: string | undefined) => string | undefined; appendSystemPromptOverride: (base: string[]) => string[];
  additionalExtensionPaths?: string[];
}
/** Minimal toolkit keeps the historical loader args byte-identical (no extra keys). */
export function loaderArgs(spec: SpawnSpec, settings: SettingsManager): LoaderArgs {
  const base: Omit<LoaderArgs, 'additionalExtensionPaths'> = {
    cwd: spec.cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    // An empty prompt would reach the loader as falsy and the peer would run on the host
    // persona silently - the protocol is the whole point of a peer session.
    systemPromptOverride: () => { if (!spec.systemPrompt) throw new Error('swarm: empty peer system prompt'); return spec.systemPrompt; },
    appendSystemPromptOverride: () => [],
  };
  if (spec.toolkit && spec.toolkit.mode !== 'minimal' && spec.toolkit.extensionPaths.length)
    return { ...base, additionalExtensionPaths: [...spec.toolkit.extensionPaths] };
  return base;
}
/** Shell-quote one element; argv is never interpolated raw into a shell string. */
export const shq = (x: string) => `'${String(x).replace(/'/g, `'\\''`)}'`;
/** Shell-class tools: peers are always read-only; only the reduce session gets them (staged/boxed). */
const expectedToolNames = (spec: SpawnSpec): string[] => {
  const readonly = ['read', 'grep', 'find', 'ls'];
  const local = spec.mode === 'peer' ? 'swarm_board' : spec.mode === 'harvest' ? 'swarm_verdict' : null;
  const tools = spec.mode === 'reduce' ? [...readonly, ...READONLY_VIOLATORS] : [...readonly];
  if (spec.toolkit) for (const n of spec.toolkit.toolNames) {
    if (spec.mode !== 'reduce' && READONLY_VIOLATORS.includes(n)) continue; // peers stay read-only
    if (!tools.includes(n)) tools.push(n);
  }
  if (local) tools.push(local);
  return tools;
};
/** Fail launch before the first prompt if any expected tool failed to register.
 * Hard-fail is limited to loader errors that reference the paths WE injected; other
 * errors post a board warning and do not kill the run. */
export function checkToolDrift(loader: any, session: any, spec: SpawnSpec, warn?: (text: string) => void): string[] {
  const errors = (loader?.getExtensions?.().errors ?? []) as { path: string; error: string }[];
  const injected = new Set(spec.toolkit?.extensionPaths ?? []);
  const ours = errors.filter(e => [...injected].some(p => String(e.path ?? '').includes(p) || String(e.error ?? '').includes(p)));
  if (ours.length) throw new Error(`Toolkit extension load failed: ${ours.map(e => `${e.path}: ${e.error}`).join('; ')}`);
  const other = errors.filter(e => !ours.includes(e));
  for (const e of other) { try { const r = warn?.(`Toolkit extension warning (run continues): ${e.path}: ${e.error}`); void Promise.resolve(r).catch(() => {}); } catch { /* warn channel unavailable */ } }
  const active = new Set(session.getActiveToolNames?.() ?? []);
  const missing = expectedToolNames(spec).filter(n => !active.has(n));
  if (missing.length) throw new Error(`Expected tools not active in ${spec.name}: ${missing.join(', ')}`);
  return expectedToolNames(spec);
}
const localBash = createLocalBashOperations();
// The writer box never has network: --share-net is never emitted (no net parameter).
export const sandboxArgv = (command: string, cwd: string, staging: { dir: string; work: string; lockdown?: boolean }, gate = false) =>
  wrap(['bash', '-o', 'pipefail', '-c', command], { cwd, upper: staging, lockdown: staging.lockdown, gate }).map(shq).join(' ');
/** Sandbox-backed bash over the persistent staging overlay; plain Pi bash without staging.
 * `gate` mounts the merged view read-only: the verification command must not be able to add
 * to the tree that a pass promotes. */
export function sandboxedBash(cwd: string, staging?: { dir: string; work: string; lockdown?: boolean }, gate = false) {
  if (!staging) return createBashToolDefinition(cwd);
  return createBashToolDefinition(cwd, {
    operations: { exec: (command, _cwd, opts) => localBash.exec(sandboxArgv(command, cwd, staging, gate), _cwd, opts) },
  });
}
/** Upper-layer entry for a workspace path: '.wh.NAME' name or char-dev rdev 0:0 whiteouts. */
const upperView = (upperDir: string, cwd: string, p: string) => {
  // resolve(cwd, p), NOT relative(cwd, p): relative() resolves a relative p against
  // process.cwd(), not the workspace, so a workspace-relative path would compare against the
  // wrong base. Pi resolves to absolute before these ops run today (resolveToCwd), but the
  // guard should not depend on that holding.
  const rel = relative(cwd, resolve(cwd, p));
  // Only the segment test: relative() also returns '..hidden' for an in-workspace name that
  // merely starts with two dots, and startsWith('..') rejected it. audit-r2/D2.
  if (rel.split(sep).includes('..')) throw new Error(`Path escapes the workspace: ${p}`);
  const up = join(upperDir, rel);
  const whiteout = (name: string) => name.startsWith('.wh.') && name !== '.wh..wh..opq';
  // An opaque ancestor directory hides the whole lower subtree beneath it, so an entry that
  // is absent from the upper is NOT the lower's file - reading it would show the reducer
  // content that promote is about to delete.
  const hiddenByOpaque = () => {
    let cur = upperDir;
    for (const part of rel ? rel.split(sep) : []) {
      cur = join(cur, part);
      if (isOpaqueUpper(cur) || existsSync(join(cur, '.wh..wh..opq'))) return true;
    }
    return false;
  };
  let st; try { st = lstatSync(up); } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { up, exists: false, whiteout: false, hidden: hiddenByOpaque(), error: undefined };
    return { up, exists: false, whiteout: false, hidden: false, error: e };
  }
  const name = up.split(sep).pop() ?? '';
  const w = whiteout(name) || (st.isCharacterDevice() && st.rdev === 0);
  return { up, exists: true, whiteout: w, hidden: w, error: undefined };
};
/** Read through the staging overlay: upper wins; a whiteout reads as ENOENT (never the lower tree). */
export const mergedReadFile = async (cwd: string, staging: { dir: string; work: string; lockdown?: boolean }, p: string) => {
  const v = upperView(staging.dir, cwd, p);
  if (v.error) throw v.error;
  if (v.whiteout || v.hidden) { const e: any = new Error(`ENOENT: no such file: ${p}`); e.code = 'ENOENT'; throw e; }
  if (v.exists) return readFile(v.up);
  return readFile(p);
};
const mergedAccess = async (cwd: string, staging: { dir: string; work: string; lockdown?: boolean }, p: string) => {
  const v = upperView(staging.dir, cwd, p);
  if (v.error) throw v.error;
  if (v.whiteout || v.hidden) { const e: any = new Error(`ENOENT: no such file: ${p}`); e.code = 'ENOENT'; throw e; }
  if (v.exists) return;
  return access(p);
};
const stagedWrite = (staging: { dir: string; work: string; lockdown?: boolean }, cwd: string) => async (p: string, content: string) => {
  const rel = relative(cwd, resolve(cwd, p));   // see upperView: resolve against the workspace, not process.cwd()
  if (rel.split(sep).includes('..')) throw new Error(`Path escapes the workspace: ${p}`);
  const up = join(staging.dir, rel);
  await mkdir(dirname(up), { recursive: true });
  await writeFile(up, content);
};
/** Staging adapters: sandboxed bash + write/edit/read aimed at the overlay upper. Installed for
 * every spawn that carries staging (all toolkit modes), never for non-staging spawns. */
const stagedTools = (cwd: string, staging: { dir: string; work: string; lockdown?: boolean }) => [
  sandboxedBash(cwd, staging),
  createWriteToolDefinition(cwd, { operations: {
    writeFile: stagedWrite(staging, cwd),
    mkdir: async (d: string) => { const rel = relative(cwd, resolve(cwd, d)); if (rel.split(sep).includes('..')) throw new Error(`Path escapes the workspace: ${d}`); await mkdir(join(staging.dir, rel), { recursive: true }); },
  } }),
  createEditToolDefinition(cwd, { operations: {
    readFile: (p: string) => mergedReadFile(cwd, staging, p),
    writeFile: stagedWrite(staging, cwd),
    access: (p: string) => mergedAccess(cwd, staging, p),
  } }),
  // Read shows the STAGED view; grep/find/ls stay on the lower tree (stated in the reducer prompt).
  createReadToolDefinition(cwd, { operations: { readFile: (p: string) => mergedReadFile(cwd, staging, p), access: (p: string) => mergedAccess(cwd, staging, p) } }),
];
export function peerOptions(spec: SpawnSpec, runtime: any, model: any, loader: any, sessions: any, settings: any) {
  const board = defineTool({
    name: 'swarm_board', label: 'Swarm board',
    description: 'Coordinate with peers. Read inbox/claims/team/budget; post text to main/findings/claims; claim or release a slice using text. artifact saves text to YOUR report only. done requires an artifact; blocked records a limitation. Identity and board are fixed by the runtime.',
    parameters: Type.Object({
      action: Type.String({ enum: ['inbox', 'claims', 'team', 'budget', 'post', 'claim', 'release', 'artifact', 'done', 'blocked'] }),
      text: Type.Optional(Type.String({ maxLength: 64000 })),
      thread: Type.Optional(Type.String({ enum: ['main', 'findings', 'claims'] })),
    }),
    async execute(_id, args) {
      return { content: [{ type: 'text' as const, text: await spec.board(args.action, args.text, args.thread) }], details: {},
        ...(['done', 'blocked'].includes(args.action) ? { terminate: true } : {}) };
    },
  });
  const verdict = defineTool({
    name: 'swarm_verdict', label: 'Swarm verdict',
    description: 'Finish independent verification. Record whether the goal was met and an evidence-based report with conflicts and gaps.',
    parameters: Type.Object({ metGoal: Type.Boolean(), summary: Type.String({ minLength: 1, maxLength: 64000 }) }),
    async execute(_id, args) {
      spec.verdict(args.metGoal, args.summary);
      return { content: [{ type: 'text' as const, text: 'Verdict recorded' }], details: {}, terminate: true };
    },
  });
  const readonly = ['read', 'grep', 'find', 'ls'];
  const staging = spec.staging;
  const customTools = spec.mode === 'peer' ? [board] : spec.mode === 'harvest' ? [verdict] : [];
  if (spec.mode === 'reduce' && staging) {
    // Writes land in the overlay upper at <run.dir>/staging/upper, mirroring paths relative
    // to the workspace; every reducer call (write/edit/bash) and the gate see one staged
    // bwrap overlay whose lower layer is run.cwd. Installed for EVERY toolkit mode: a
    // minimal apply run stages too, so discard semantics stay truthful.
    customTools.push(...stagedTools(spec.cwd, staging));
    const extra = (spec.toolkit?.toolNames ?? []).filter(n => !READONLY_VIOLATORS.includes(n) && !readonly.includes(n));
    return {
      cwd: spec.cwd, modelRuntime: runtime, model, thinkingLevel: spec.effort as any,
      resourceLoader: loader, sessionManager: sessions, settingsManager: settings,
      tools: [...readonly, ...READONLY_VIOLATORS, ...extra],
      customTools,
    };
  }
  if (!spec.toolkit || spec.toolkit.mode === 'minimal') {
    // Historical shape: no sandbox, no extra tools, no extra keys (non-staging spawns only).
    return {
      cwd: spec.cwd, modelRuntime: runtime, model, thinkingLevel: spec.effort as any,
      resourceLoader: loader, sessionManager: sessions, settingsManager: settings,
      tools: spec.mode === 'reduce' ? [...readonly, ...READONLY_VIOLATORS] :
        [...readonly, spec.mode === 'peer' ? 'swarm_board' : 'swarm_verdict'],
      customTools,
    };
  }
  // Peers/harvest are always read-only: shell-class inherited/granted names stay out of the list.
  const extra = (spec.toolkit?.toolNames ?? []).filter(n => !READONLY_VIOLATORS.includes(n));
  return {
    cwd: spec.cwd, modelRuntime: runtime, model, thinkingLevel: spec.effort as any,
    resourceLoader: loader, sessionManager: sessions, settingsManager: settings,
    tools: [...readonly, spec.mode === 'peer' ? 'swarm_board' : 'swarm_verdict', ...extra],
    customTools,
  };
}
export function peerSettings(
  model: { provider: string; id: string },
  global: ReturnType<SettingsManager['getGlobalSettings']>,
) {
  const key = `${model.provider}/${model.id}`;
  const entry = global.compaction?.modelOverrides?.[key];
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      ...(entry === undefined ? {} : { modelOverrides: { [key]: entry } }),
    },
    retry: { enabled: true, maxRetries: 2 },
  });
  settings.getCompactionSettings(model); // Validate the selected entry before spawning.
  return settings;
}
export async function prepareSDK(modelName: string, scopedModels: any[] = []) {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const models = runtime.getModels();
  // Exact id or provider/id, no fuzzy fallback onto another lane.
  const matches = models.filter((m: any) => `${m.provider}/${m.id}` === modelName || m.id === modelName);
  if (matches.length !== 1) throw new Error(`Swarm model must resolve uniquely in models.json: ${modelName}`);
  const model = matches[0];
  if (scopedModels.length && !scopedModels.some(x => x.model.provider === model.provider && x.model.id === model.id)) throw new Error(`Model outside this session's enabled scope: ${modelName}`);
  if (!(await runtime.getAvailable()).some(m => m.provider === model.provider && m.id === model.id)) throw new Error(`No configured authentication for ${modelName}`);
  // Snapshot only the selected model's global budget policy; no project settings, no ordinary fallbacks.
  const source = SettingsManager.create(process.cwd(), undefined, { projectTrusted: false });
  const errors = source.drainErrors();
  if (errors.length) throw new Error(`Swarm settings: ${errors.map(x => x.error.message).join('; ')}`);
  const global = source.getGlobalSettings();
  peerSettings(model, global); // Fail launch validation, not the first peer, on malformed policy.
  return async (spec: SpawnSpec): Promise<SessionLike> => {
    if (spec.model !== modelName) throw new Error('Model changed after launch validation');
    const settings = peerSettings(model, global);
    const loader = new DefaultResourceLoader(loaderArgs(spec, settings));
    await loader.reload();
    const sm = SessionManager.create(spec.cwd, join(spec.dir, 'sessions', spec.name));
    const { session } = await createAgentSession(peerOptions(spec, runtime, model, loader, sm, settings));
    checkToolDrift(loader, session, spec, t => { try { if (spec.mode === 'peer') void spec.board('post', `Swarm: ${t}`, 'main'); else console.error(`swarm ${spec.mode} ${spec.name}: ${t}`); } catch { /* board may be closed */ } });
    return session;
  };
}
/** Gate runs inside the same bwrap staging box the reducer wrote to, when staging exists.
 * No network: the writer box never shares the host netns (no net parameter). The mount is
 * READ-ONLY (wrap gate:true): a gate that writes must not be able to extend the very tree a
 * pass promotes, so a passing gate can only ever promote the reducer's own changes. */
export async function runGate(command: string, cwd: string, signal: AbortSignal, staging?: { dir: string; work: string; lockdown?: boolean }): Promise<string> {
  // The gate's view of the upper must agree with promote() about what is DELETED. A real `rm`
  // inside the box leaves a char-dev whiteout the kernel already honours, so this is a no-op
  // in practice; it only rewrites hand-built '.wh.NAME' markers, which the kernel overlay
  // ignores but promote() honours.
  const view = staging ? mkdtempSync(join(tmpdir(), 'swarm-gate-')) : undefined;
  const gateStaging = staging && view ? { ...staging, dir: normaliseWhiteouts(staging.dir, view) } : staging;
  try {
    // Reuse Pi's bounded output and process-tree cancellation, not a shell
    // subprocess whose grandchildren survive timeout/abort. The bash tool REJECTS on timeout
    // but NOT on non-zero exit: it resolves with isError:true and the failure text. Without the
    // guard below a failing gate reads as a pass and promote() writes the staged tree over the
    // workspace. (Measured: runGate('false') resolves with "Command exited with code 1".)
    const tool = gateStaging
      ? createBashTool(cwd, { operations: { exec: (cmd, _cwd, opts) => localBash.exec(sandboxArgv(cmd, cwd, gateStaging, true), _cwd, opts) } })
      : createBashTool(cwd);
    const r = await tool.execute('swarm-gate', { command: 'set -o pipefail\n' + command, timeout: 120 }, signal);
    const out = r.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (r.isError) throw new Error(out);   // non-zero exit: the catch below discards staging
    return out;
  } catch (e: any) {
    // An operator cancel mid-gate is a different event from a failing gate. Both discard
    // staging and leave the workspace untouched, but reporting a cancel as "Reduce gate
    // failed" sends whoever reads the log looking for a broken reducer.
    if (signal.aborted) throw new Error('Reduce gate cancelled; staged changes are discarded, the workspace is untouched.');
    throw new Error(`Reduce gate failed; staged changes are discarded, the workspace is untouched. ${String(e.stdout || '')}${String(e.stderr || e.message)}`.slice(0, 16000));
  } finally { if (view) { try { rmSync(view, { recursive: true, force: true }); } catch { /* tmp */ } } }
}
