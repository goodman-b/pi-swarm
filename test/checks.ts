import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SwarmRuntime, runTokens, validateLaunch, type SpawnSpec } from '../runtime.ts';
import { DEFAULTS, MAX_PEERS, parseSettings } from '../settings.ts';
import { Board, events } from '../board.ts';
import { peerOptions, peerSettings, runGate } from '../sdk.ts';
import extension, { VERSION } from '../index.ts';
import { applyGrants } from '../capabilities.ts';

const root = mkdtempSync(join(tmpdir(), 'standalone-swarm-'));
let checks = 0;
const here = realpathSync(fileURLToPath(import.meta.url));
const srcDir = dirname(here);
const extIndex = join(srcDir, '..', 'index.ts');
const extCommands = join(srcDir, '..', 'commands.ts');
// Offline tests register their own capability grants: the package ships only `web`,
// a load replaces the registry, and a test must not depend on an extension being
// installed on the running host - so both grants point at in-repo fixtures.
// DEFAULTS.grants carries the same map, so settings objects built from DEFAULTS keep it.
const FIXTURE_GRANTS = {
  web: { path: join(srcDir, 'fixtures/web-grant.ts'), tools: ['web_search', 'fetch_content', 'get_search_content'], effects: ['public-network', 'ssrf-guard', 'shared-cache-write'], label: 'Web' },
  corpus: { path: join(srcDir, 'fixtures/corpus-grant.ts'), tools: ['corpus_search'], effects: ['local-read'], label: 'Corpus' },
};
applyGrants(FIXTURE_GRANTS);
DEFAULTS.grants = FIXTURE_GRANTS;
const ok = (v: unknown, message: string) => { assert.ok(v, message); checks++; };
const s = { ...DEFAULTS, boardRoot: root, defaultAgents: 2, peerMaxTurns: 2, graceTurns: 0 };
const launch = { goal: 'Inspect evidence', done: 'All findings independently verified', agents: 2 };
const made: any[] = [];
function creator(behavior: (spec: SpawnSpec, fake: any) => Promise<void>) {
  return async (spec: SpawnSpec) => {
    let listener = (_e: any) => {};
    const fake: any = {
      spec, disposed: false, aborted: false, steered: [], prompts: [] as string[], messages: [], sessionFile: join(spec.dir, 'sessions', spec.name, 'fake.jsonl'),
      subscribe(fn: any) { listener = fn; return () => { listener = () => {}; }; },
      emit(e: any) { listener(e); },
      async steer(t: string) { fake.steered.push(t); },
      async abort() { fake.aborted = true; fake.release?.(); },
      dispose() { fake.disposed = true; },
      async prompt(p: string) {
        fake.prompts.push(p);
        await behavior(spec, fake);
        const m = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'result' }], usage: { totalTokens: 10, cost: { total: 0.01 } } };
        fake.messages.push(m); listener({ type: 'message_end', message: m });
      },
    };
    made.push(fake); return fake;
  };
}
async function success(spec: SpawnSpec, fake: any) {
  if (spec.mode === 'peer') {
    await spec.board('claim', spec.name);
    await spec.board('artifact', `Evidence from ${spec.name}`);
    await spec.board('post', 'Evidence, not consensus', 'findings');
    fake.emit({ type: 'tool_execution_end', toolName: 'read' });
    await spec.board('done', 'checked');
  } else if (spec.mode === 'harvest') spec.verdict(true, 'Independently checked source evidence');
}
try {
  const cfg = parseSettings({ maxAgents: 3, defaultAgents: 8, peerMaxTurns: 0, boardRoot: 'relative', defaultEffort: 'bogus' });
  ok(cfg.defaultAgents === 3 && cfg.peerMaxTurns === 80 && cfg.boardRoot === DEFAULTS.boardRoot, 'settings validate and clamp width');
  // issue #5: no hardcoded 16 ceiling - high but safe counts are accepted, defaults unchanged
  ok(DEFAULTS.defaultAgents === 4 && DEFAULTS.maxAgents === 16 && DEFAULTS.maxConcurrent === 8, 'defaults remain 4/16/8');
  const wide = parseSettings({ defaultAgents: 64, maxAgents: 64, maxConcurrent: 32 });
  ok(wide.defaultAgents === 64 && wide.maxAgents === 64 && wide.maxConcurrent === 32, 'settings accept 64 peers / 32 concurrent');
  const big = parseSettings({ maxAgents: MAX_PEERS, maxConcurrent: Number.MAX_SAFE_INTEGER });
  ok(big.maxAgents === MAX_PEERS && big.maxConcurrent === Number.MAX_SAFE_INTEGER, 'settings accept MAX_PEERS roster / MAX_SAFE concurrency bounds');
  ok(parseSettings({ maxAgents: MAX_PEERS + 1, defaultAgents: MAX_PEERS + 1 }).maxAgents === DEFAULTS.maxAgents, 'roster values above the array-length bound fall back');
  for (const bad of [2 ** 53, -1, 1.5, '16', null, 0]) {
    for (const key of ['defaultAgents', 'maxAgents', 'maxConcurrent'] as const) {
      const c = parseSettings({ [key]: bad });
      ok(c[key] === DEFAULTS[key], `${key}=${String(bad)} falls back to default ${DEFAULTS[key]}`);
    }
  }
  // floors differ per key: 1 is a valid maxConcurrent, invalid for the roster keys
  ok(parseSettings({ maxConcurrent: 1 }).maxConcurrent === 1, 'maxConcurrent accepts its floor 1');
  for (const bad of [1, 0]) { const c = parseSettings({ defaultAgents: bad, maxAgents: bad });
    ok(c.defaultAgents === 4 && c.maxAgents === 16, `${String(bad)} is below the roster floor and falls back`); }
  // configured limit is enforced at launch: default maxAgents 2 rejects 3; raised cap admits it
  assert.throws(() => validateLaunch({ ...launch, agents: 3 }, { ...s, maxAgents: 2 }), undefined, 'configured maxAgents 2 rejects agents 3');
  ok(validateLaunch({ ...launch, agents: 64 }, { ...s, maxAgents: 64 }) === undefined, 'raised maxAgents 64 admits a 64-peer launch');
  assert.throws(() => validateLaunch({ ...launch, agents: 65 }, { ...s, maxAgents: 64 })); checks++;
  // structural roster bound: 2**32 is rejected even when maxAgents is raised to MAX_SAFE
  assert.throws(() => validateLaunch({ ...launch, agents: 2 ** 32 }, { ...s, maxAgents: Number.MAX_SAFE_INTEGER })); checks++;
  ok(validateLaunch({ ...launch, agents: MAX_PEERS }, { ...s, maxAgents: MAX_PEERS }) === undefined, 'validateLaunch admits the structural bound itself');
  for (const n of [2 ** 53, 2 ** 32, 1.5, -3]) {
    assert.throws(() => validateLaunch({ ...launch, agents: n }, { ...s, maxAgents: Number.MAX_VALUE })); checks++;
  }
  for (const invalid of [{ goal: '' }, { agents: 17 }, { runId: '../escape' }, { apply: true }, { effort: 'wat' }, { slices: [42] }, { reduceGate: 'true' }]) {
    assert.throws(() => validateLaunch({ ...launch, ...invalid } as any, s)); checks++;
  }
  let notified = 0, gates = 0;
  const r = new SwarmRuntime(creator(success), async () => { gates++; return 'pass'; }, () => {}, () => notified++);
  r.start({ ...launch, runId: 'success' }, s, 'session', root);
  assert.throws(() => r.start(launch, s, 'session', root)); checks++;
  await r.completion;
  ok(r.run?.state === 'done' && r.run.metGoal, 'peer and harvest success');
  ok(notified === 1 && gates === 0, 'exactly one completion; no implicit writes');
  ok(made.every(x => x.disposed) && r.run!.peers.every(p => p.tokens === 10), 'dispose and usage accounting');
  ok(readFileSync(r.run!.report!, 'utf8').includes('Independently checked'), 'durable harvest report');
  ok((await new Board(join(root, 'session'), 'success').call('system', ['claims'])).includes('no active claims'), 'claims released after session stop');
  assert.throws(() => r.start({ ...launch, runId: 'success' }, s, 'session', root)); checks++;
  const PF = { available: true, smokeOk: true, overlayOk: true }; // fake preflight: apply needs a working box
  const applied = new SwarmRuntime(creator(success), async () => { gates++; return 'pass'; });
  applied.start({ ...launch, apply: true, reduceGate: 'true' }, s, 'session', root, { preflight: PF }); await applied.completion;
  ok(applied.run?.state === 'done' && gates === 1 && applied.run.peers.some(p => p.name === 'reduce'), 'explicit reduce and gate');
  const gateFailed = new SwarmRuntime(creator(success), async () => { throw new Error('bad gate'); });
  gateFailed.start({ ...launch, apply: true, reduceGate: 'false' }, s, 'session', root, { preflight: PF }); await gateFailed.completion;
  ok(gateFailed.run?.state === 'failed' && !gateFailed.run.metGoal, 'gate failure cannot claim success');
  const broken = new SwarmRuntime(creator(async (spec, fake) => {
    if (spec.mode === 'peer') return; // returns prose without terminal protocol
    await success(spec, fake);
  }), async () => { throw new Error('gate must reject a staged diff it does not accept'); });
  broken.start({ ...launch, apply: true, reduceGate: 'true' }, s, 'session', root, { preflight: PF }); await broken.completion;
  // v0.3.2 fix 5: incomplete peers no longer veto the writer. The HARVEST's verdict decides
  // whether to attempt the write, and the machine gate is the thing that actually judges the
  // diff. Here the gate rejects, so the run fails and the workspace is untouched.
  ok(broken.run?.state === 'failed' && !broken.run.metGoal && broken.run.peers.length === 4
    && broken.run.peers.some(p => p.name === 'reduce') && /gate must reject/.test(broken.run.error ?? ''),
    'incomplete peers do not block the writer - the gate is the safety net, and a rejecting gate still fails the run');
  ok(!existsSync(join(broken.run!.cwd, 'promoted-by-a-failing-gate')), 'a rejecting gate leaves the workspace untouched');
  const capped = new SwarmRuntime(creator(async (_spec, fake) => {
    fake.emit({ type: 'turn_end' }); fake.emit({ type: 'turn_end' });
    ok(fake.aborted, 'turn cap aborts session');
  }), async () => '');
  capped.start(launch, { ...s, harvestMaxTurns: 2 }, 'session', root); await capped.completion;
  ok(capped.run!.peers.every(p => p.state === 'failed'), 'caps do not count as success');
  const doneThenCap = new SwarmRuntime(creator(async (spec, fake) => {
    if (spec.mode === 'peer') {
      await spec.board('artifact', 'evidence'); await spec.board('done', 'checked');
      fake.emit({ type: 'turn_end' }); fake.emit({ type: 'turn_end' }); // sibling tool keeps the batch alive past done
    } else await success(spec, fake);
  }), async () => '');
  doneThenCap.start(launch, { ...s, peerMaxTurns: 1 }, 'session', root); await doneThenCap.completion;
  ok(doneThenCap.run!.peers.filter(p => p.name.startsWith('peer-')).every(p => p.state === 'done') && doneThenCap.run!.metGoal === true,
    'the turn-cap backstop never fails a peer that already called done');
  const disposeBoom = new SwarmRuntime(async (spec) => {
    const fake = await creator(success)(spec);
    fake.dispose = () => { throw new Error('dispose boom'); };
    return fake;
  }, async () => '');
  disposeBoom.start({ ...launch, runId: 'dispose-boom' }, s, 'session', root); await disposeBoom.completion;
  ok(disposeBoom.run!.metGoal === true && disposeBoom.run!.peers.every(p => !p.error?.startsWith('Dispose failed') || p.state === 'done'),
    'a dispose throw after success is recorded, never flips done to failed');
  let ready!: () => void;
  const entered = new Promise<void>(resolve => ready = resolve);
  const cancellation = new SwarmRuntime(creator(async (_spec, fake) => {
    ready(); await new Promise<void>(resolve => fake.release = resolve);
  }), async () => '');
  cancellation.start(launch, s, 'session', root); await entered;
  await cancellation.steer('peer-1', 'operator correction');
  await cancellation.close();
  ok(cancellation.run?.state === 'aborted' && cancellation.run.peers.length === 2, 'shutdown aborts peers and prevents harvest');
  ok(made.some(x => x.steered.includes('operator correction')), 'steering reaches session');
  await assert.rejects(() => cancellation.steer('peer-1', 'late')); checks++;
  const spendy = async (spec: SpawnSpec, fake: any) => {
    if (spec.mode === 'peer') {
      if (!fake.held) { fake.held = true; fake.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 9000 } } }); }
      while (!fake.aborted) await new Promise(r => setTimeout(r, 5));
    } else await success(spec, fake);
  };
  const budgetRun = new SwarmRuntime(creator(spendy), async () => '');
  budgetRun.start({ ...launch, runId: 'token-cap' }, { ...s, runTokenCap: 1000, wallSeconds: 60, peerMaxTurns: 500, graceTurns: 0 }, 'session', root);
  await budgetRun.completion;
  ok(budgetRun.run!.state === 'aborted' && budgetRun.run!.error?.startsWith('Run token budget reached')
    && budgetRun.run!.peers.find(p => p.name === 'harvest')?.state === 'done',
    'the run token cap stops peers on spend, not on elapsed time, and still harvests');
  ok(runTokens([{ name: 'peer-1', tokens: 5 }, { name: 'harvest', tokens: 900 }, { name: 'peer-2', tokens: 7 }]) === 12,
    'runTokens counts peer spend only - the harvest never spends its own cap');
  // v0.3.2 (audit-r3): an unreadable settings file runs on defaults, and defaults include an
  // EMPTY registry - previously the old grants stayed grantable behind the diagnostics.
  {
    const { applyGrants, GRANTABLE } = await import('../capabilities.ts');
    const { loadSettings } = await import('../settings.ts');
    const keep = JSON.parse(JSON.stringify(GRANTABLE));   // this block rewrites the global registry
    const file = join(root, 'unreadable-swarm.json');
    const prev = process.env.SWARM_SETTINGS_PATH;
    process.env.SWARM_SETTINGS_PATH = file;
    try {
      writeFileSync(file, '{"wallSeconds":60,"grants":{"tmp":{"path":"' + import.meta.dirname.replace(/\\/g, '/') + '","tools":["x"],"effects":[]}}}');
      loadSettings();
      ok(Object.hasOwn(GRANTABLE, 'tmp'), 'before it breaks: the grant is registered');
      writeFileSync(file, '{ this is not json');
      loadSettings();
      ok(!Object.hasOwn(GRANTABLE, 'tmp'), 'an unreadable swarm.json revokes grants as well as resetting limits');
    } finally {
      if (prev === undefined) delete process.env.SWARM_SETTINGS_PATH; else process.env.SWARM_SETTINGS_PATH = prev;
      applyGrants(keep);                                  // leave the fixture registry as it was
    }
  }
  // v0.2.9 (sparring review): the grant registry fails CLOSED, and a named grant cannot open
  // the recursion boundary.
  {
    const { applyGrants, resolveToolkit, GRANTABLE } = await import('../capabilities.ts');
    const fx = join(import.meta.dirname, 'fixtures', 'corpus-grant.ts');
    applyGrants(FIXTURE_GRANTS);   // re-apply: the fail-closed blocks above legitimately reset the registry
    const saved = JSON.parse(JSON.stringify(GRANTABLE)); 
    applyGrants({ spar: { path: fx, tools: ['read_corpus'], effects: ['corpus-read'] } });
    ok(resolveToolkit('grants', ['spar']).toolNames.includes('read_corpus'), 'a declared grant is grantable');
    applyGrants(null);
    let revoked = false;
    try { resolveToolkit('grants', ['spar']); } catch { revoked = true; }
    ok(revoked, 'applyGrants(null) revokes - an absent block cannot leave old grants grantable');
    applyGrants({ evil: { path: fx, tools: ['read_corpus', 'Agent'], effects: ['delegation'] } });
    let blocked = false;
    try { resolveToolkit('grants', ['evil']); } catch (e: any) { blocked = /delegation/.test(String(e?.message)); }
    ok(blocked, 'a named grant cannot hand a peer Agent/swarm_start: the recursion boundary holds in grants mode');
    applyGrants(saved);                                    // leave the fixture registry as it was
    ok(resolveToolkit('grants', ['web']).toolNames.includes('web_search'), 'the saved registry is restored');
  }
  // The merged read view must honour opaque ancestors, and an empty peer prompt must fail loudly.
  {
    const { loaderArgs, mergedReadFile } = await import('../sdk.ts');
    const SettingsManager = (await import('@earendil-works/pi-coding-agent')).SettingsManager;
    const ws = mkdtempSync(join(root, 'mv-ws-')), up = mkdtempSync(join(root, 'mv-up-'));
    mkdirSync(join(ws, 'd')); mkdirSync(join(up, 'd'));
    writeFileSync(join(up, 'd', '.wh..wh..opq'), '');          // portable opaque marker
    writeFileSync(join(ws, 'd', 'old'), 'lower'); writeFileSync(join(ws, 'plain'), 'keep');
    const stg = { dir: up, work: join(root, 'mv-w') };
    let hid = false;
    try { await mergedReadFile(ws, stg, join(ws, 'd', 'old')); } catch (e: any) { hid = e?.code === 'ENOENT'; }
    ok(hid, 'a lower file under an opaque upper dir reads as ENOENT, not as content promote will delete');
    ok((await mergedReadFile(ws, stg, join(ws, 'plain'))).toString() === 'keep', 'a lower file with no opaque ancestor still reads through');
    const spec: any = { name: 'p', cwd: ws, dir: root, model: 'm', effort: 'low', systemPrompt: '', mode: 'peer', board: async () => 'ok', verdict: () => {} };
    let threwEmpty = false;
    try { (loaderArgs(spec, SettingsManager.inMemory({})).systemPromptOverride as any)(undefined); } catch { threwEmpty = true; }
    ok(threwEmpty, 'an empty peer system prompt fails loudly instead of inheriting the host persona');
  }
  // A deadline must stop queued peers from ever spawning: with maxConcurrent 1 the later
  // peers only reach a slot after the first is cut off. No test overrode maxConcurrent before.
  let peerSpawns = 0;
  const queuedRun = new SwarmRuntime(async (spec) => {
    if (spec.mode === 'peer') peerSpawns++;
    return creator(async (sp, fake) => {
      if (sp.mode === 'peer') { let n = 0; while (!fake.aborted && n++ < 100) await new Promise(r => setTimeout(r, 5)); }
      else await success(sp, fake);
    })(spec);
  }, async () => '');
  queuedRun.start({ ...launch, agents: 3, runId: 'queued-behind-deadline' },
    { ...s, maxConcurrent: 1, wallSeconds: 0.3, peerMaxTurns: 500, graceTurns: 0 }, 'session', root);
  await queuedRun.completion;
  ok(peerSpawns === 1 && queuedRun.run!.state === 'aborted'
    && queuedRun.run!.peers.filter(p => p.name.startsWith('peer-')).every(p => p.state === 'aborted')
    && queuedRun.run!.peers.find(p => p.name === 'harvest')?.state === 'done',
    'a deadline stops queued peers from spawning at all, and the harvest still reports');
  let safe: SpawnSpec | undefined;
  const boundaries = new SwarmRuntime(creator(async (spec, fake) => {
    safe = spec;
    if (spec.mode === 'peer') {
      await assert.rejects(() => spec.board('done', 'no artifact')); checks++;
      await assert.rejects(() => spec.board('post', 'hello', 'invalid')); checks++;
      await assert.rejects(() => spec.board('rescue', 'other')); checks++;
      await spec.board('post', '$(touch /tmp/NEVER-SHELL) `whoami`\nexact', 'main');
    }
    await success(spec, fake);
  }), async () => '');
  boundaries.start(launch, s, 'session', root); await boundaries.completion;
  ok(events(boundaries.run!.dir).some(e => e.text?.includes('$(touch /tmp/NEVER-SHELL)')), 'argv transport never shell-expands board text');
  for (const mode of ['peer', 'harvest', 'reduce'] as const) {
    const opts = peerOptions({ ...safe!, mode }, {}, {}, {}, {}, {});
    ok(!opts.tools.some(x => ['Agent', 'SubagentWorkflow'].includes(x)), 'no delegation tools');
    ok(mode === 'reduce' || !opts.tools.some(x => ['bash', 'write', 'edit'].includes(x)), 'peer/harvest cannot mutate target');
    if (mode === 'peer') {
      const tool = opts.customTools[0];
      const out = await tool.execute('x', { action: 'blocked', text: 'end' } as any, undefined as any, undefined as any, {} as any).catch(() => null);
      // Runtime guards the already finished peer; adapter termination checked on a fresh callback below.
      const fresh = peerOptions({ ...safe!, mode, board: async () => 'ok' }, {}, {}, {}, {}, {});
      ok((await fresh.customTools[0].execute('x', { action: 'done' } as any, undefined as any, undefined as any, {} as any)).terminate, 'done terminates loop');
    }
  }
  // The wall cap stops the PEERS; the board is intact, so the harvest still runs and
  // REPORT.md carries a real summary instead of a bare abort note.
  const wall = new SwarmRuntime(creator(async (spec, fake) => {
    if (spec.mode === 'peer') {
      if (!fake.held) { fake.held = true; await spec.board('post', 'partial finding: index.ts:1 returns stale rows', 'findings'); }
      while (!fake.aborted) await new Promise(r => setTimeout(r, 5));
    } else await success(spec, fake);
  }), async () => '');
  wall.start(launch, { ...s, wallSeconds: 0.3 }, 'session', root); await wall.completion;
  // v0.3.2 fix 5: the wall cut the peers off, but the harvest still verified, so metGoal is
  // the harvest's TRUE. Before, peers.every(done) forced false and the run reported
  // "Goal met: false" for work the harvest had confirmed. The state stays 'aborted'.
  ok(wall.run?.state === 'aborted' && wall.run.error?.includes('wall-clock') && wall.run.metGoal === true
    && wall.run.peers.find(p => p.name === 'harvest')?.state === 'done'
    && !!wall.run.report && readFileSync(wall.run.report!, 'utf8').includes('Independently checked source evidence')
    && wall.run.peers.filter(p => p.name.startsWith('peer-')).every(p => p.state === 'aborted'),
    'the wall cap stops peers, marks them aborted, and the harvest still writes a report and keeps its verdict');
  ok(wall.run.limits?.wallSeconds === 0.3 && wall.run.limits?.peerMaxTurns === s.peerMaxTurns,
    'the limits actually in force are recorded on the run');
  // The same wall, firing while the harvest is the only live session: the phase that turns
  // the board into a report must never be aborted by a peer-phase deadline.
  // v0.3.2 fix 4: the harvest gets its OWN wall, armed fresh after the peers settle - not the
  // leftover of the peer phase, and not no wall at all. A harvest that outlasts the peer phase
  // still completes and lands its report even though the peer wall already fired, and a harvest
  // that exceeds a full wall of its own is stopped (the unbounded-writer-hang case).
  const slowHarvest = creator(async (spec, fake) => {
    if (spec.mode === 'peer') {
      // Keep the peer alive past the peer wall, so it is guaranteed to fire mid-phase.
      while (!fake.aborted) {
        if (!fake.held) { fake.held = true; await spec.board('post', 'partial evidence', 'findings'); }
        await new Promise(r => setTimeout(r, 20));
      }
    } else {
      let n = 0;
      while (!fake.aborted && n++ < 40) await new Promise(r => setTimeout(r, 10));   // ~400ms
      if (!fake.aborted) spec.verdict(true, 'harvest outlived the wall');
    }
  });
  const lateWall = new SwarmRuntime(slowHarvest, async () => '');
  // 0.5s: the peer wall fires at 0.5s, the peers' rescue prompt has budget to clear, and the
  // harvest's FRESH 0.5s then covers its own ~400ms of work.
  lateWall.start({ ...launch, runId: 'wall-during-harvest' }, { ...s, wallSeconds: 0.5, peerMaxTurns: 500, graceTurns: 0 }, 'session', root);
  await lateWall.completion;
  ok(lateWall.run?.error?.includes('wall-clock') && lateWall.run.metGoal === true
    && lateWall.run.peers.find(p => p.name === 'harvest')?.state === 'done'
    && !!lateWall.run.report && readFileSync(lateWall.run.report!, 'utf8').includes('harvest outlived the wall'),
    'the harvest is given a fresh wall after the peer wall fires - a report that outlasts the peers still lands, and keeps its verdict');
  // A cancel is intent, not a budget, so it skips the harvest - but it must not skip the
  // board. This is the loss a session /reload used to cause mid-audit.
  let evidencePosted!: () => void;
  const evidenceReady = new Promise<void>(resolve => { evidencePosted = resolve; });
  const cancelled = new SwarmRuntime(creator(async (spec, fake) => {
    if (spec.mode === 'peer') {
      if (!fake.held) { fake.held = true; await spec.board('post', 'partial finding: index.ts:1 returns stale rows', 'findings'); evidencePosted(); }
      while (!fake.aborted) await new Promise(r => setTimeout(r, 5));
    } else await success(spec, fake);
  }), async () => '');
  cancelled.start({ ...launch, runId: 'cancel-dump' }, { ...s, peerMaxTurns: 500, graceTurns: 0 }, 'session', root);
  let evidenceTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([evidenceReady, new Promise<never>((_, reject) => {
      evidenceTimeout = setTimeout(() => reject(new Error('cancel test: evidence was not posted')), 10000);
    })]);
  } finally {
    clearTimeout(evidenceTimeout);
    await cancelled.close();
  }
  ok(cancelled.run!.state === 'aborted'
    && readFileSync(cancelled.run!.report!, 'utf8').includes('partial finding: index.ts:1')
    // boardDigest() replaced the bare placeholder with a sentence that reproduces the board;
    // match the phrase, not the old exact string.
    && /No harvest report/.test(readFileSync(cancelled.run!.report!, 'utf8')),
    'a cancel writes what the board holds instead of a placeholder');
  const providerFailure = new SwarmRuntime(creator(async (_spec, fake) => {
    fake.messages.push({ role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable' });
    throw new Error('provider unavailable');
  }), async () => '');
  providerFailure.start(launch, s, 'session', root); await providerFailure.completion;
  ok(providerFailure.run!.peers.every(p => p.state === 'failed'), 'provider failures preserved');
  let releaseCreate!: () => void, createEntered!: () => void;
  const creating = new Promise<void>(r => createEntered = r);
  const creationGate = new Promise<void>(r => releaseCreate = r);
  let prompted = false, disposed = 0;
  const midSpawn = new SwarmRuntime(async () => {
    createEntered(); await creationGate;
    return { messages: [], async prompt() { prompted = true; }, async steer() {}, async abort() {},
      subscribe() { return () => {}; }, dispose() { disposed++; } };
  }, async () => '');
  midSpawn.start(launch, s, 'session', root); await creating;
  await midSpawn.abort(); releaseCreate(); await midSpawn.completion;
  ok(!prompted && disposed === 2 && midSpawn.run?.state === 'aborted', 'cancel during creation never prompts and disposes both sessions');
  // Peer budget policy: exact selected global model override only, native resolution.
  const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const four = [
    { m: { provider: 'local', id: 'lane/fast' }, window: 262144, reserve: 65536 },
    { m: { provider: 'local', id: 'lane/27b' }, window: 262144, reserve: 65536 },
    { m: { provider: 'local', id: 'lane/flash' }, window: 262144, reserve: 65536 },
    { m: { provider: 'local', id: 'remote/flash' }, window: 524288, reserve: 200000 },
  ];
  const fourGlobal: any = { compaction: { modelOverrides: Object.fromEntries(four.map(x =>
    [`${x.m.provider}/${x.m.id}`, { reserveTokens: x.reserve, keepRecentTokens: 20000 }])) } };
  for (const x of four) {
    const c = peerSettings(x.m, fourGlobal).getCompactionSettings(x.m);
    ok(c.enabled && c.reserveTokens === x.reserve && c.keepRecentTokens === 20000
      && x.window - c.reserveTokens === (x.reserve === 200000 ? 324288 : 196608), 'four exact budgets and thresholds');
  }
  for (const near of [{ provider: 'local', id: 'lane/Fast' }, { provider: 'other', id: 'lane/fast' }, { provider: 'local', id: 'lane/fast-x' }]) {
    const c = peerSettings(near, fourGlobal).getCompactionSettings(near);
    ok(c.reserveTokens === 16384 && c.keepRecentTokens === 20000, 'exact key match only; near misses use defaults, never another model reserve');
  }
  const dirty: any = {
    compaction: { enabled: false, reserveTokens: 999999, keepRecentTokens: 888888, modelOverrides: { 'local/x': { reserveTokens: 1 } } },
    retry: { enabled: true, maxRetries: 99 }, packages: ['npm:evil'], extensions: ['/tmp/evil.ts'], defaultTools: ['bash'],
  };
  const clean = peerSettings({ provider: 'local', id: 'x' }, dirty);
  const cs = clean.getCompactionSettings({ provider: 'local', id: 'x' });
  const picked: any = clean.getGlobalSettings();
  ok(cs.enabled && cs.reserveTokens === 1 && cs.keepRecentTokens === 20000
    && clean.getRetrySettings().maxRetries === 2 && picked.retry.maxRetries === 2
    && !('packages' in picked) && !('extensions' in picked) && !('defaultTools' in picked)
    && picked.compaction.enabled === true && !('reserveTokens' in picked.compaction) && !('keepRecentTokens' in picked.compaction),
    'no contamination: enabled/retry pinned, only the exact entry copied, no ordinary/global/tools policy');
  const partial = peerSettings({ provider: 'local', id: 'p' }, { compaction: { modelOverrides: { 'local/p': { reserveTokens: 5 } } } } as any);
  const pc = partial.getCompactionSettings({ provider: 'local', id: 'p' });
  ok(pc.reserveTokens === 5 && pc.keepRecentTokens === 20000, 'partial entry falls back to built-in defaults per field');
  for (const bad of [-1, 'x', 1.5, 'entry-string', 'entry-null']) {
    const g: any = { compaction: { modelOverrides: { 'local/b': bad === 'entry-string' ? 'garbage' : bad === 'entry-null' ? null : { reserveTokens: bad } } } };
    assert.throws(() => peerSettings({ provider: 'local', id: 'b' }, g)); checks++;
    assert.throws(() => peerSettings({ provider: 'local', id: 'b' }, { compaction: { modelOverrides: { 'local/b': { keepRecentTokens: bad === 'entry-string' || bad === 'entry-null' ? -1 : bad } } } } as any)); checks++;
  }
  const mixed: any = { compaction: { modelOverrides: { 'local/other': 'garbage', 'local/b': { reserveTokens: 7 } } } };
  ok(peerSettings({ provider: 'local', id: 'b' }, mixed).getCompactionSettings({ provider: 'local', id: 'b' }).reserveTokens === 7,
    'malformed unrelated entry is neither copied nor validated');
  const diskRoot = mkdtempSync(join(root, 'disk-'));
  const agentDir = join(diskRoot, 'agent'); mkdirSync(agentDir);
  mkdirSync(join(diskRoot, 'proj/.pi'), { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { modelOverrides: { 'local/d': { reserveTokens: 12345 } } } }));
  writeFileSync(join(diskRoot, 'proj/.pi/settings.json'), JSON.stringify({ compaction: { enabled: false, reserveTokens: 1, modelOverrides: { 'local/d': { reserveTokens: 1 } } }, retry: { maxRetries: 99 } }));
  const disk = SettingsManager.create(join(diskRoot, 'proj'), agentDir, { projectTrusted: false });
  ok(disk.drainErrors().length === 0, 'disk global-only loader reports no errors');
  const dc = peerSettings({ provider: 'local', id: 'd' }, disk.getGlobalSettings()).getCompactionSettings({ provider: 'local', id: 'd' });
  ok(dc.enabled && dc.reserveTokens === 12345, 'project settings cannot contaminate the global policy snapshot');
  writeFileSync(join(agentDir, 'settings.json'), '{broken');
  const brokenDisk = SettingsManager.create(join(diskRoot, 'proj'), agentDir, { projectTrusted: false });
  ok(brokenDisk.drainErrors().some(e => e.scope === 'global'), 'malformed global JSON surfaces through drainErrors');
  const noFile = SettingsManager.create(diskRoot, join(diskRoot, 'missing-agent'), { projectTrusted: false });
  ok(noFile.drainErrors().length === 0 && peerSettings({ provider: 'local', id: 'd' }, noFile.getGlobalSettings()).getCompactionSettings({ provider: 'local', id: 'd' }).reserveTokens === 16384,
    'missing global file means native defaults, not an error');
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'empty-agent-dir'),
    settingsManager: SettingsManager.inMemory({ packages: [], extensions: [new URL('../index.ts', import.meta.url).pathname] }),
    noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  ok(loaded.errors.length === 0, 'real Pi resource loader reports no errors: ' + JSON.stringify(loaded.errors));
  ok(loaded.extensions.length === 1 && loaded.extensions[0].tools.has('swarm_start'), 'real Pi loader registers standalone extension with no subagents installed');
  const tools: any[] = [], handlers: any = {}, commands: any[] = [];
  extension({ registerTool(t: any) { tools.push(t); }, registerCommand(n: string) { commands.push(n); }, on(n: string, fn: any) { handlers[n] = fn; } } as any);
  ok(tools.map(t => t.name).join(',') === 'swarm_start,swarm_status,swarm_steer,swarm_cancel', 'standalone registration without subagent extension');
  ok(tools.find((t: any) => t.name === 'swarm_start').parameters.properties.agents.maximum === MAX_PEERS,
    'swarm_start agents schema ceiling matches the settings ceiling');
  ok(commands.includes('swarm'), '/swarm registered');
  await handlers.session_shutdown();
  ok((await runGate('printf pass', root, new AbortController().signal)) === 'pass', 'gate executes locally');
  await assert.rejects(() => runGate('false | true', root, new AbortController().signal)); checks++;

  // == toolkit capabilities, sandbox argv, preflight, staging wiring
  const { resolveToolkit, parentInventory, toolkitPrompt, GRANTABLE } = await import('../capabilities.ts');
  const { wrap, preflight } = await import('../sandbox.ts');
  const { loaderArgs, checkToolDrift, sandboxArgv } = await import('../sdk.ts');
  const hasSeq = (a: string[], ...x: string[]) => a.slice(a.indexOf(x[0]), a.indexOf(x[0]) + x.length).join(' ') === x.join(' ') ||
    a.some((v, i) => v === x[0] && a.slice(i, i + x.length).join(' ') === x.join(' '));
  assert.throws(() => resolveToolkit('grants', ['nope']), /Unknown grant/); checks++;
  assert.throws(() => resolveToolkit('minimal', ['web']), /Explicit tools require/); checks++;
  assert.throws(() => resolveToolkit('grants', [42 as any]), /array of grant names/); checks++;
  // A leftover defaultTools must not break the tool path on a non-grants toolkit (v0.2.1
  // fixed only the launch form), and a slash-form runId must not escape boardRoot.
  const { grantList } = await import('../capabilities.ts');
  ok(grantList('grants', ['a'], ['b']).join() === 'a' && grantList('minimal', undefined, ['b']).length === 0
    && grantList('grants', undefined, ['b']).join() === 'b' && grantList('inherit', [], ['b']).length === 0,
    'grantList: explicit wins; a leftover defaultTools never poisons a non-grants toolkit');
  const status = tools.find(t => t.name === 'swarm_status')!;
  await assert.rejects(() => Promise.resolve(status.execute('x', { runId: '../escape' },
    new AbortController().signal, () => {}, {} as any)), /Invalid run\/session identifier/); checks++;
  await assert.rejects(() => Promise.resolve(status.execute('x', { runId: 'sess/../../etc' },
    new AbortController().signal, () => {}, {} as any)), /Invalid run\/session identifier/); checks++;
  const { fields } = await import('../commands.ts');
  ok(Object.keys(DEFAULTS).every(k => k in fields), 'every setting has a settings-menu label');
  const gg = resolveToolkit('grants', ['web', 'web', 'corpus']);
  ok(gg.grants.length === 2 && gg.toolNames.length === 4 && gg.extensionPaths.length === 2 && gg.effects.includes('ssrf-guard'), 'grants expand, deduped, with paths and effects');
  ok(Object.isFrozen(gg) && Object.isFrozen(gg.toolNames), 'resolved toolkit is frozen at resolution');
  const inv = {
    tools: [{ name: 'read', path: '/pi/tools/read.js' }, { name: 'bash', path: '/pi/tools/bash.js' },
      { name: 'Agent', path: '/p/ext-a/index.js' }, { name: 'web_search', path: '/p/ext-b/index.ts' },
      { name: 'sched', path: '/p/scheduling/index.ts' }, { name: 'assistant', path: '/p/scheduling-assistant/index.ts' }],
    paths: ['/pi/tools/read.js', '/pi/tools/bash.js', '/p/ext-a/index.js', '/p/scheduling/index.ts', '/p/ext-b/index.ts', '/p/scheduling-assistant/index.ts'],
  };
  // Shell class is dropped from an inherit resolution, never an error - an interactive
  // parent has bash, so throwing made the mode unusable everywhere (v0.2.9, audit-r2/C3).
  const inh = resolveToolkit('inherit', [], inv);
  ok(!inh.toolNames.includes('bash') && inh.excluded.includes('bash') && !inh.extensionPaths.includes('/pi/tools/bash.js'),
    'inherit drops shell-class tools by name and path, and reports the drop');
  ok(!inh.toolNames.includes('Agent') && inh.excluded.includes('Agent') &&
    inh.toolNames.includes('assistant') && !inh.extensionPaths.some(p => p === '/p/scheduling/index.ts') &&
    inh.extensionPaths.includes('/p/scheduling-assistant/index.ts'),
    'inherit strips delegation tools by name and excluded paths by whole path segment, never substring');
  ok(inh.toolNames.includes('web_search') && inh.toolNames.includes('read'), 'inherit keeps every ordinary parent tool');
  assert.throws(() => parentInventory({}), /getAllTools/); checks++;
  const pinv = parentInventory({
    getAllTools: () => [{ name: 'read', sourceInfo: { path: here } }, { name: 'swarm_start', sourceInfo: { path: extIndex } }],
    getCommands: () => [{ name: 'swarm', sourceInfo: { path: extCommands } }, { name: 'dup', sourceInfo: { path: here } }],
  });
  ok(pinv.paths.length === 3, 'parentInventory dedupes tool and command source paths');
  const pinv2 = parentInventory({
    getAllTools: () => [{ name: 'bash', sourceInfo: { path: '<builtin:bash>' } }, { name: 'read', sourceInfo: { path: here } }],
    getCommands: () => [{ name: 'x', sourceInfo: { path: '/definitely/not/here-xyz.js' } }],
  });
  ok(pinv2.paths.length === 1 && pinv2.paths[0] === here && !pinv2.tools[0].path,
    'parentInventory drops <builtin:*> and missing paths, keeps real ones');
  ok(toolkitPrompt(resolveToolkit('minimal'), 'peer').includes('Tools intentionally exclude shell'), 'minimal prompt stays verbatim');
  ok(toolkitPrompt(resolveToolkit('grants', ['web']), 'peer').includes('Web: public-network, ssrf-guard, shared-cache-write'), 'grants prompt states each grant effects');
  const ip = toolkitPrompt(inh, 'peer');
  ok(ip.includes('Inherited extension effects are undeclared.') && ip.includes('bypass bwrap'), 'inherit prompt carries both warning lines');
  const w1 = wrap(['grep', '-r', 'x', 'a b'], { cwd: '/run/target', lib64: false });
  ok(w1.slice(0, 7).join(' ') === 'bwrap --unshare-all --unshare-user --disable-userns --new-session --die-with-parent --ro-bind' &&
    hasSeq(w1, '--ro-bind', '/run/target', '/run/target') && !w1.includes('--share-net') && !hasSeq(w1, '--symlink', 'usr/lib64', '/lib64') &&
    hasSeq(w1, '--chdir', '/run/target', '--', 'grep', '-r', 'x', 'a b'), 'read-view argv: no net, no lib64, argv preserved verbatim');
  const w2 = wrap(['/bin/true'], { cwd: '/c', upper: true, lib64: true });
  ok(hasSeq(w2, '--overlay-src', '/c', '--tmp-overlay', '/c') && hasSeq(w2, '--symlink', 'usr/lib64', '/lib64'), 'tmp-overlay argv and conditional lib64');
  const w3 = wrap(['/bin/true'], { cwd: '/c', upper: { dir: '/u', work: '/w' }, lib64: false });
  ok(hasSeq(w3, '--overlay-src', '/c', '--overlay', '/u', '/w', '/c') && !w3.includes('--share-net'), 'persistent overlay never shares the network');
  const pfAbsent = await preflight(async () => { throw new Error('ENOENT'); });
  ok(!pfAbsent.available && /not found/.test(pfAbsent.reason ?? ''), 'preflight: absent bwrap fails loudly');
  const pfSmoke = await preflight(async (a) => a.includes('--version') ? { code: 0, stdout: '0.11.2', stderr: '' } : { code: 1, stdout: '', stderr: 'userns denied' });
  ok(pfSmoke.available && !pfSmoke.smokeOk, 'preflight: smoke failure surfaces');
  const pfOverlay = await preflight(async (a) => a.includes('--version') ? { code: 0, stdout: 'v', stderr: '' } : a.includes('--overlay-src') ? { code: 1, stdout: '', stderr: 'EPERM' } : { code: 0, stdout: '', stderr: '' });
  ok(pfOverlay.smokeOk && !pfOverlay.overlayOk, 'preflight: overlay denial is explicit');
  ok((await preflight(async () => ({ code: 0, stdout: 'v', stderr: '' }))).overlayOk, 'preflight: all green');
  { const r = new SwarmRuntime(creator(success), async () => 'pass');
    assert.throws(() => r.start({ ...launch, apply: true, reduceGate: 'true' }, s, 'session', root), /working bwrap sandbox/); checks++; }
  assert.throws(() => validateLaunch({ ...launch, apply: true, reduceGate: 'x' }, { ...s, sandbox: 'off' }), /no escape hatch/); checks++;
  const minimalSpec: any = { cwd: root, dir: root, name: 'peer-1', mode: 'peer', systemPrompt: 'x', board: async () => 'ok', toolkit: resolveToolkit('minimal') };
  ok(!('additionalExtensionPaths' in loaderArgs(minimalSpec, {} as any)), 'minimal loader args carry no new keys');
  ok(typeof loaderArgs(minimalSpec, {} as any).agentDir === 'string', 'loader args carry a real agentDir (SDK resolves it unconditionally)');
  const grantSpec: any = { ...minimalSpec, toolkit: resolveToolkit('grants', ['web']) };
  ok(loaderArgs(grantSpec, {} as any).additionalExtensionPaths?.length === 1, 'grants load exactly the registry path');
  const driftSession = { getActiveToolNames: () => ['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content', 'swarm_board'] };
  await assert.rejects(async () => { checkToolDrift({ getExtensions: () => ({ errors: [] }) }, driftSession, grantSpec); }, /get_search_content/); checks++;
  checkToolDrift({ getExtensions: () => ({ errors: [] }) }, { getActiveToolNames: () => ['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content', 'get_search_content', 'swarm_board'] }, grantSpec); checks++;
  const sa = sandboxArgv('echo it > f', '/ws', { dir: '/st/upper', work: '/st/work' }, false);
  ok(sa.includes("'-c' 'echo it > f'") && sa.includes("'--overlay-src' '/ws'") && sa.includes("'/st/upper'") && !sa.includes('${'),
    'sandbox argv: command is one quoted element, overlay lower is the workspace');
  const st = parseSettings({ defaultToolkit: 'grants', defaultTools: ['web', 7], sandbox: 'wat' });
  ok(st.defaultToolkit === 'grants' && st.defaultTools.length === 0 && st.sandbox === DEFAULTS.sandbox,
    'settings: valid fields kept, invalid entries fall back whole-field to default');
  {
    const { GRANTABLE } = await import('../capabilities.ts');
    const keep = JSON.parse(JSON.stringify(GRANTABLE));
    ok(parseSettings({ grants: FIXTURE_GRANTS, defaultTools: ['web', 'corpus'] }).defaultTools.join() === 'web,corpus',
      'settings: a grant list survives when the SAME file declares those grants');
    ok(parseSettings({ defaultTools: ['web'] }).defaultTools.length === 0,
      'settings: an undeclared grant name is dropped - no grants block means no grants (fail closed)');
    applyGrants(keep);
  }  ok(DEFAULTS.defaultModel === '', 'settings: no built-in default model (inherits the calling session)');
  ok(VERSION === JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')).version,
    'release: index VERSION matches package.json');
  assert.throws(() => applyGrants({ 'Bad-Name': { path: '/', tools: ['x'] } }), /Invalid grant name/); checks++;
  assert.throws(() => applyGrants({ rel: { path: 'relative/x.ts', tools: ['x'] } }), /must be an absolute path/); checks++;
  assert.throws(() => applyGrants({ empty: { path: '/', tools: [] } }), /non-empty array/); checks++;
  {
    const { GRANTABLE } = await import('../capabilities.ts');
    applyGrants({ corpus: null });
    ok(!GRANTABLE.corpus && Object.keys(GRANTABLE).join() === '',
      'grants: null removes an entry; a load replaces the registry, nothing carries over');
    applyGrants({
      web: { path: join(srcDir, 'fixtures/web-grant.ts'), tools: ['web_search', 'fetch_content', 'get_search_content'], effects: ['public-network', 'ssrf-guard', 'shared-cache-write'], label: 'Web' },
      corpus: { path: join(srcDir, 'fixtures/corpus-grant.ts'), tools: ['corpus_search'], effects: ['local-read'], label: 'Corpus' },
    });
    ok(GRANTABLE.corpus.label === 'Corpus' && GRANTABLE.web.path === join(srcDir, 'fixtures/web-grant.ts'),
      'grants: re-adding restores both fixture grants in one load');
  }
  // A grant removed mid-run must degrade the prompt, not kill the swarm (review MAJOR).
  {
    const frozen = resolveToolkit('grants', ['corpus']);
    applyGrants({ corpus: null });
    ok(toolkitPrompt(frozen, 'peer').includes('corpus'), 'prompt: a vanished grant falls back to its name instead of throwing');
    applyGrants(FIXTURE_GRANTS);   // re-apply: blocks above rewrite the global registry
  }
  // Self-declared effects are the peer's only warning: silence must be visible.
  {
    applyGrants({ ...FIXTURE_GRANTS, quiet: { path: join(srcDir, 'fixtures/web-grant.ts'), tools: ['http_fetch'] } });
    ok(toolkitPrompt(resolveToolkit('grants', ['quiet']), 'peer').includes('effects undeclared'),
      'prompt: a grant with no declared effects says so');
    applyGrants(FIXTURE_GRANTS);
  }
  // The package excludes itself by realpath, not by a name substring.
  {
    const { excludeSelf, parentInventory: pinv, selfPaths } = await import('../capabilities.ts');
    const before = selfPaths().length;
    excludeSelf('/'); excludeSelf('relative/path'); excludeSelf(join(srcDir, 'nope'));
    ok(selfPaths().length === before, 'excludeSelf: degenerate or missing paths are refused (excluding / would exclude everything)');
    excludeSelf(join(srcDir, '..'));
    const inv = pinv({
      getAllTools: () => [{ name: 'read', path: '/x/read.js' }, { name: 'swarm_status', path: join(srcDir, '..', 'board.ts') }],
      getCommands: () => [],
    });
    ok(resolveToolkit('inherit', [], inv).extensionPaths.every(p => !p.startsWith(realpathSync(join(srcDir, '..')))),
      'inherit: files belonging to this package are excluded by path');
  }

  // == review-findings regression block (F1–F17); promote() had zero coverage before this.
  const { SwarmRuntime: SR, markOpaqueUpper } = await import('../runtime.ts');
  const { mergedReadFile } = await import('../sdk.ts');
  const { toolkitLines } = await import('../view.ts');
  const specOf = (mode: 'peer' | 'harvest' | 'reduce', toolkit: any, staging?: any): any =>
    ({ name: mode === 'reduce' ? 'reduce' : mode + '-1', cwd: root, dir: root, model: 'm', effort: 'low', systemPrompt: 'x', mode, toolkit, staging, board: async () => 'ok', verdict: () => {} });
  const stagedSpec = (mode: 'peer' | 'harvest' | 'reduce', toolkit: any) =>
    specOf(mode, toolkit, { dir: join(root, 'reg-staging-upper'), work: join(root, 'reg-staging-work') });
  // (a) apply+minimal installs the staged reduce adapters; peers stay read-only
  {
    const red = peerOptions(stagedSpec('reduce', resolveToolkit('minimal')), {}, {}, {}, {}, {});
    ok(red.customTools.length === 4 && red.tools.includes('write') && red.tools.includes('bash'),
      'apply+minimal reduce installs staged adapters (staging no longer skipped for minimal)');
    const peer = peerOptions(stagedSpec('peer', resolveToolkit('minimal')), {}, {}, {}, {}, {});
    ok(!peer.tools.some(x => ['bash', 'write', 'edit'].includes(x)) &&
      !peer.customTools.some(t => ['write', 'edit', 'bash'].includes(t.name)),
      'apply+minimal peer tools list has no plain write/edit');
    const plain = peerOptions(specOf('reduce', resolveToolkit('minimal')), {}, {}, {}, {}, {});
    ok(plain.customTools.length === 0, 'non-staging minimal reduce keeps the historical byte-identical shape');
  }
  // (b) peer toolNames never contain bash/write/edit under inherit+apply
  {
    // Built by hand, not by resolveToolkit: the guard is now unconditional, and this test is
    // about peerOptions stripping shell class STRUCTURALLY even if a toolkit carries it.
    const inh = { toolNames: ['read', 'bash'], extensionPaths: [here, extIndex], effects: [], excluded: [] } as any;
    for (const mode of ['peer', 'harvest'] as const) {
      const staged = peerOptions(stagedSpec(mode, inh), {}, {}, {}, {}, {});
      ok(!staged.tools.some((x: string) => ['bash', 'write', 'edit'].includes(x)), `inherit+apply ${mode} tool list is shell-class free`);
      const plain = peerOptions(specOf(mode, inh), {}, {}, {}, {}, {});
      ok(!plain.tools.some((x: string) => ['bash', 'write', 'edit'].includes(x)), `inherit ${mode} without staging is shell-class free too`);
    }
  }
  // (c) promote into a cwd containing link -> outside leaves the outside file unchanged
  {
    const ws = mkdtempSync(join(root, 'reg-ws-'));
    const out = mkdtempSync(join(root, 'reg-out-'));
    const secret = join(out, 'secret');
    writeFileSync(secret, 'do-not-touch');
    symlinkSync(secret, join(ws, 'docs'));
    const up = mkdtempSync(join(root, 'reg-up-'));
    mkdirSync(join(up, 'docs'));
    writeFileSync(join(up, 'docs', 'new.md'), 'staged');
    let threw = false;
    try { new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }); } catch { threw = true; }
    ok(readFileSync(secret, 'utf8') === 'do-not-touch' && lstatSync(join(ws, 'docs')).isDirectory() && !threw,
      'promote replaces a pre-existing workspace symlink instead of following it out of the tree');
  }
  // (d) char-dev 0:0 whiteout deletes the victim; xattr-opaque upper dir clears the dest (skip-list spared)
  {
    let mknodOk = true;
    try { execFileSync('mknod', [join(root, 'reg-mknod-probe'), 'c', '0', '0']); rmSync(join(root, 'reg-mknod-probe'), { force: true }); }
    catch { mknodOk = false; }
    ok(true, mknodOk ? 'regression (d/j): mknod available' : 'regression (d/j): SKIPPED — mknod unavailable on this host');
    if (mknodOk) {
      const ws = mkdtempSync(join(root, 'reg-ws-'));
      const up = mkdtempSync(join(root, 'reg-up-'));
      writeFileSync(join(ws, 'doomed'), 'x');
      execFileSync('mknod', [join(up, 'doomed'), 'c', '0', '0']);
      ok(lstatSync(join(up, 'doomed')).isCharacterDevice() && lstatSync(join(up, 'doomed')).rdev === 0, 'fixture whiteout is char-dev 0:0');
      mkdirSync(join(up, 'd')); mkdirSync(join(ws, 'd'));
      writeFileSync(join(ws, 'd', 'old'), 'x');
      writeFileSync(join(up, 'd', 'new'), 'y');
      markOpaqueUpper(join(up, 'd'));
      const res = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') });
      ok(res.deleted >= 1 && !existsSync(join(ws, 'doomed')) && existsSync(join(ws, 'd', 'new')) && !existsSync(join(ws, 'd', 'old')),
        'char-dev whiteout promotes as deletion; opaque upper dir yields a clean dest');
    }
  }
  // (d2) a whiteout whose name strips to nothing or to '..' must not delete the workspace
  {
    const ws = mkdtempSync(join(root, 'reg-ws-'));
    const up = mkdtempSync(join(root, 'reg-up-'));
    mkdirSync(join(ws, 'sub')); writeFileSync(join(ws, 'sub', 'keep'), 'x'); writeFileSync(join(ws, 'keep'), 'x');
    writeFileSync(join(up, '.wh.'), '');      // slice(4) === ''  -> victim was dirCwd itself
    writeFileSync(join(up, '.wh..'), '');     // slice(4) === '.'  -> victim was dirCwd itself
    writeFileSync(join(up, '.wh...'), '');    // slice(4) === '..' -> victim was cwd's PARENT
    let msg = '';
    try { new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }); } catch (e: any) { msg = String(e.message); }
    ok(existsSync(join(ws, 'keep')) && existsSync(join(ws, 'sub', 'keep'))
      && (msg.match(/malformed whiteout name/g) || []).length === 3,
      'malformed whiteout names are refused, never turned into a recursive delete of the workspace');
  }
  // (d3) an opaque upper root clears the workspace but never the skip list - the sibling
  // of the v0.2.6 whiteout fix, which had zero skip-list coverage on either branch.
  {
    const ws = mkdtempSync(join(root, 'reg-ws-'));
    const up = mkdtempSync(join(root, 'reg-up-'));
    const keep = join(ws, 'board');
    mkdirSync(keep); writeFileSync(join(keep, 'board.jsonl'), '{}\n');
    writeFileSync(join(ws, 'doomed'), 'x'); writeFileSync(join(up, 'new'), 'y');
    markOpaqueUpper(up);
    const res = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }, [keep]);
    ok(existsSync(join(keep, 'board.jsonl')) && !existsSync(join(ws, 'doomed')) && existsSync(join(ws, 'new'))
      && res.deleted === 1 && res.failed.length === 0,
      'the opaque clear respects the skip list per child - the board root is never touched');
  }
  // (e) escaping symlink at root -> failed[] entry, the rest still promotes
  {
    const ws = mkdtempSync(join(root, 'reg-ws-'));
    const up = mkdtempSync(join(root, 'reg-up-'));
    writeFileSync(join(ws, 'keep'), 'orig');
    symlinkSync('../outside', join(up, 'escape'));
    writeFileSync(join(up, 'ok.txt'), 'new');
    let msg = '';
    try { new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }); } catch (e: any) { msg = String(e.message); }
    ok(/Promotion incomplete/.test(msg) && readFileSync(join(ws, 'ok.txt'), 'utf8') === 'new' && !existsSync(join(ws, 'escape')),
      'symlink escape is a per-entry refusal; remaining entries promote and the failure surfaces');
  }
  // (e1) overlay type replacement + directory modes - sparring pass 2, both real in v0.2.9
  {
    const mk = () => [mkdtempSync(join(root, 'ty-ws-')), mkdtempSync(join(root, 'ty-up-'))];
    // upper FILE where the workspace has a DIRECTORY (reducer: rm -rf d && touch d)
    let [ws, up] = mk();
    mkdirSync(join(ws, 'item')); writeFileSync(join(ws, 'item', 'inner'), 'lower');
    writeFileSync(join(up, 'item'), 'now-a-file');
    let e1: string[] = [];
    try { e1 = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }).failed; } catch (e: any) { e1 = [String(e.message)]; }
    ok(e1.length === 0 && readFileSync(join(ws, 'item'), 'utf8') === 'now-a-file',
      'an upper file replaces a lower directory wholesale, not EISDIR');
    // upper DIRECTORY where the workspace has a FILE (reducer: rm f && mkdir f) - used to throw
    [ws, up] = mk();
    writeFileSync(join(ws, 'item'), 'was-a-file');
    mkdirSync(join(up, 'item')); writeFileSync(join(up, 'item', 'inner'), 'new');
    let e2: string[] = [];
    try { e2 = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }).failed; } catch (e: any) { e2 = [String(e.message)]; }
    ok(e2.length === 0 && existsSync(join(ws, 'item', 'inner')), 'an upper dir replaces a lower file without aborting promote');
    // upper SYMLINK over a lower FILE
    [ws, up] = mk();
    writeFileSync(join(ws, 'item'), 'file'); writeFileSync(join(ws, 'target'), 't');
    symlinkSync('target', join(up, 'item'));
    const e3 = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }).failed;
    ok(e3.length === 0 && readlinkSync(join(ws, 'item')) === 'target', 'an upper symlink replaces a lower file');
    // directory MODE must survive the promotion, not the process umask
    [ws, up] = mk();
    mkdirSync(join(up, 'private')); chmodSync(join(up, 'private'), 0o700);
    const e4 = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }).failed;
    ok(e4.length === 0 && (statSync(join(ws, 'private')).mode & 0o777) === 0o700,
      'a staged directory keeps its mode - chmod 700 in the box is 700 on the host');
    // and the skip list still wins over a type replacement
    [ws, up] = mk();
    const keep = join(ws, 'board'); mkdirSync(keep); writeFileSync(join(keep, 'board.jsonl'), '{}\n');
    writeFileSync(join(up, 'board'), 'now-a-file');
    let e5: string[] = [];
    try { e5 = new SR(async () => { throw new Error('unused'); }, async () => '').promote(ws, { dir: up, work: join(root, 'w') }, [keep]).failed; }
    catch (e: any) { e5 = [String(e.message)]; }   // promote throws when failed[] is non-empty
    ok(existsSync(join(keep, 'board.jsonl')) && e5.some(m => /skip-listed/.test(m)),
      'a skip-listed dir is never removed for a type change, and the refusal surfaces');
  }
  // (f) abort injected between gate pass and promote -> cwd unchanged, staging discarded
  {
    const ws = mkdtempSync(join(root, 'reg-ws-'));
    const prompts: string[] = [];
    const rt = new SR(creator(async (spec, fake) => { prompts.push(...fake.prompts); await success(spec, fake); }),
      async () => { await new Promise(r => setImmediate(r)); await rt.abort('operator cancelled between gate and promote'); return 'pass'; });
    rt.start({ ...launch, runId: 'reg-abort', apply: true, reduceGate: 'true' }, s, 'regsession', ws, { preflight: PF });
    await rt.completion;
    ok(rt.run?.state === 'aborted' && !!rt.run.error && !existsSync(join(ws, 'promoted.txt')) && rt.run.phase === 'settled',
      'abort after gate pass discards staging and never writes the workspace');
    ok(prompts.some(p => p.includes('Reads via grep/find/ls show the original tree; use read or bash cat to see staged state.')),
      'reducer prompt states the staged-read semantics verbatim');
  }
  // (g) the writer box argv contains no --share-net, even with a public-network effect
  {
    const gnet = resolveToolkit('grants', ['web']);
    const sa = sandboxArgv('echo hi', root, { dir: '/st/upper', work: '/st/work' });
    ok(!sa.includes('--share-net'), 'sandboxArgv never emits --share-net');
    const red = peerOptions(stagedSpec('reduce', gnet), {}, {}, {}, {}, {});
    ok(!red.customTools.some(t => JSON.stringify(t).includes('--share-net')), 'staged adapters carry no net flag');
    if (existsSync('/usr/bin/bwrap')) {
      const sd = mkdtempSync(join(root, 'reg-bwrap-'));
      mkdirSync(join(sd, 'upper')); mkdirSync(join(sd, 'work'));
      const argv = sandboxArgv('cat /proc/net/route | wc -l', root, { dir: join(sd, 'upper'), work: join(sd, 'work'), lockdown: false });
      const out = execFileSync('/bin/sh', ['-c', argv], { encoding: 'utf8' });
      ok(parseInt(out.trim(), 10) <= 1, 'real bwrap writer box has no network (empty /proc/net/route)');

      // A name-form whiteout: promote() deletes on it, the kernel overlay does not understand
      // it. The gate must see the same tree promote() will act on, or it verifies a file that
      // is about to be deleted. Driven through runGate, which is what normalises.
      if (existsSync('/usr/bin/bwrap')) {
        const up = mkdtempSync(join(root, 'reg-wh-up-')), ws2 = mkdtempSync(join(root, 'reg-wh-ws-'));
        writeFileSync(join(ws2, 'gone'), 'still here'); writeFileSync(join(ws2, 'kept'), 'orig');
        writeFileSync(join(up, '.wh.gone'), '');            // name form: the kernel ignores this
        writeFileSync(join(up, 'staged.txt'), 'from the reducer');
        const stg2 = { dir: up, work: join(root, 'reg-wh-w'), lockdown: false };
        const seen = (await runGate('if test -e gone; then echo SEES; else echo HIDDEN; fi', ws2,
          new AbortController().signal, stg2)).trim();
        ok(seen === 'HIDDEN', 'the gate hides a name-form whiteout, so it cannot verify a file promote() will delete');
        const also = (await runGate('cat staged.txt', ws2, new AbortController().signal, stg2)).trim();
        ok(also === 'from the reducer', 'the gate still reads ordinary staged content through the normalised view');
      } else ok(true, 'whiteout gate-view check SKIPPED: /usr/bin/bwrap absent (CI without bwrap)');

      // Layer ORDER. --overlay-src gives the LAST source the highest priority, so getting the
      // two the wrong way round makes the gate verify the ORIGINAL tree and pass a broken
      // reducer. Assert it against real bwrap with a file present in BOTH layers.
      const up = mkdtempSync(join(root, 'reg-gate-up-')), lo = mkdtempSync(join(root, 'reg-gate-lo-'));
      writeFileSync(join(up, 'both'), 'STAGED'); writeFileSync(join(lo, 'both'), 'ORIGINAL');
      writeFileSync(join(up, 'only-staged'), 'S');
      const ws2 = mkdtempSync(join(root, 'reg-gate-ws-'));
      writeFileSync(join(ws2, 'both'), 'ORIGINAL');
      const gd = sandboxArgv('cat both; echo; cat only-staged', ws2, { dir: up, work: join(root, 'reg-gate-w'), lockdown: false }, true);
      const got = execFileSync('/bin/sh', ['-c', gd], { encoding: 'utf8' }).trim().split('\n');
      ok(got[0] === 'STAGED' && got[1] === 'S',
        'the gate box verifies the STAGED view: the upper shadows the workspace, not the other way round');
      // And it must not be able to write: a gate that builds must not extend the promoted tree.
      const gw = sandboxArgv('echo x > gate-write && echo WROTE', ws2, { dir: up, work: join(root, 'reg-gate-w'), lockdown: false }, true);
      let wrote = true;
      try { execFileSync('/bin/sh', ['-c', gw], { encoding: 'utf8' }); } catch { wrote = false; }
      ok(!wrote && !existsSync(join(up, 'gate-write')),
        'the gate box is read-only: a gate that writes fails and leaves nothing for promote() to copy');
    } else ok(true, 'real-bwrap network check SKIPPED: /usr/bin/bwrap absent (CI without bwrap)');
  }
  // (h) parentInventory drops <builtin:bash> and keeps only existing paths — checked above
  // (i) lockdown:false preflight -> run.sandbox.warning + badge
  {
    const rt = new SwarmRuntime(creator(success), async () => 'pass');
    rt.start({ ...launch, runId: 'reg-lock', apply: true, reduceGate: 'true' }, s, 'session', root,
      { preflight: { available: true, smokeOk: true, overlayOk: true, lockdown: false } });
    await rt.completion;
    ok(rt.run?.sandbox?.warning === 'nested-userns lockdown unavailable; sandbox is weaker' && rt.run.sandbox.scope === 'reduce+gate',
      'lockdown:false sets the weaker-sandbox warning and reduce+gate scope');
    const badge = toolkitLines(rt.run as any).join('\n');
    ok(badge.includes('reduce+gate') && badge.includes('sandbox is weaker'), 'badge shows scope and the weaker-sandbox warning');
  }
  // (j) mergedRead: whiteout in upper -> ENOENT-like, never the lower tree content
  {
    let mknodOk = true;
    try { execFileSync('mknod', [join(root, 'reg-mknod-probe2'), 'c', '0', '0']); rmSync(join(root, 'reg-mknod-probe2'), { force: true }); }
    catch { mknodOk = false; }
    if (mknodOk) {
      const ws = mkdtempSync(join(root, 'reg-ws-'));
      const sd = mkdtempSync(join(root, 'reg-stg-'));
      mkdirSync(join(sd, 'upper')); mkdirSync(join(sd, 'work'));
      writeFileSync(join(ws, 'f'), 'lower');
      execFileSync('mknod', [join(sd, 'upper', 'f'), 'c', '0', '0']);
      await assert.rejects(() => mergedReadFile(ws, { dir: join(sd, 'upper'), work: join(sd, 'work') }, join(ws, 'f')), /ENOENT/); checks++;
      rmSync(join(sd, 'upper', 'f'));
      writeFileSync(join(sd, 'upper', 'f'), 'upper');
      ok((await mergedReadFile(ws, { dir: join(sd, 'upper'), work: join(sd, 'work') }, join(ws, 'f'))).toString() === 'upper', 'mergedRead: upper wins over lower');
      rmSync(join(sd, 'upper', 'f'));
      ok((await mergedReadFile(ws, { dir: join(sd, 'upper'), work: join(sd, 'work') }, join(ws, 'f'))).toString() === 'lower', 'mergedRead falls through when upper is absent');
    }
  }
  // F15: loader errors on paths we did not inject warn instead of killing the run
  {
    let warned = '';
    checkToolDrift({ getExtensions: () => ({ errors: [{ path: '/other/ext.ts', error: 'boom' }] }) },
      { getActiveToolNames: () => ['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content', 'get_search_content', 'swarm_board'] }, grantSpec, (t: string) => { warned = t; }); checks++;
    ok(warned.includes('unrelated') === false && warned.includes('/other/ext.ts'), 'foreign loader error posts a warning, run continues');
    assert.throws(() => checkToolDrift({ getExtensions: () => ({ errors: [{ path: GRANTABLE.web.path, error: 'boom' }] }) },
      { getActiveToolNames: () => ['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content', 'get_search_content', 'swarm_board'] }, grantSpec), /Toolkit extension load failed/); checks++;
  }
  // F16: grants prompt carries the bypass line; resolveToolkit refuses registry paths missing on this host
  ok(toolkitPrompt(resolveToolkit('grants', ['web']), 'peer').includes('Extension-internal shell commands bypass bwrap.'),
    'grants prompt states the extension-shell bypass');
  ok(toolkitPrompt(resolveToolkit('grants', ['corpus']), 'peer').includes('sandboxed shell has no network'),
    'grants prompt states the sandboxed shell has no network');
  {
    const orig = GRANTABLE.web.path;
    GRANTABLE.web.path = join(root, 'no-such-extension.ts');
    assert.throws(() => resolveToolkit('grants', ['web']), /does not exist on this host/); checks++;
    GRANTABLE.web.path = orig;
  }

  // == disk path: the settings FILE, not just parseSettings (regression: a bad grants
  // block used to reset the whole file to defaults and leave a partial grant registry).
  {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-settings-'));
    const file = join(dir, 'swarm.json');
    const prevEnv = process.env.SWARM_SETTINGS_PATH;
    process.env.SWARM_SETTINGS_PATH = file;
    const { loadSettings, saveSettings, drainDiagnostics, settingsPath } = await import('../settings.ts');
    const { GRANTABLE } = await import('../capabilities.ts');
    ok(settingsPath() === file, 'disk: SWARM_SETTINGS_PATH redirects the settings file');
    const fixture = join(srcDir, 'fixtures/corpus-grant.ts');
    writeFileSync(file, JSON.stringify({ boardRoot: dir, peerMaxTurns: 12,
      grants: { good: { path: fixture, tools: ['corpus_search'] }, bad: { path: 'relative/oops', tools: ['x'] } } }));
    const loaded = loadSettings();
    ok(drainDiagnostics().some(x => x.includes('grant definitions dropped')),
      'disk: an invalid grants block is reported, never silent');
    ok(loaded.peerMaxTurns === 12 && loaded.boardRoot === dir && Object.keys(loaded.grants).length === 0,
      'disk: a broken grants block drops itself, not the file');
    ok(Object.keys(GRANTABLE).join() === '', 'disk: a rejected grants block resets to the shipped registry, never a partial one');
    writeFileSync(file, '{ not json');
    ok(loadSettings().peerMaxTurns === DEFAULTS.peerMaxTurns, 'disk: unreadable file runs on defaults in memory');
    assert.throws(() => saveSettings({ ...DEFAULTS, widget: false }), /Refusing to overwrite/); checks++;
    ok(readFileSync(file, 'utf8') === '{ not json', 'disk: a refused save leaves the unreadable file untouched');
    writeFileSync(file, JSON.stringify({ grants: { tmp: { path: fixture, tools: ['t'] } } }));
    loadSettings();
    ok(Object.hasOwn(GRANTABLE, 'tmp'), 'disk: a declared grant registers');
    writeFileSync(file, '{}'); loadSettings();
    ok(!Object.hasOwn(GRANTABLE, 'tmp'), 'disk: an ABSENT grants block revokes too - deleting the key deletes the capability');
    writeFileSync(file, '{"grants":{"tmp":{"path":"' + here.replace(/\\/g, '/') + '","tools":["x"],"effects":[]}}}'); loadSettings();
    writeFileSync(file, '{{"grants": "not-an-object"}}'); loadSettings();
    ok(Object.keys(GRANTABLE).join() === '', 'disk: an unparseable grants block drops itself, other settings survive');
    writeFileSync(file, '{"grants":{}}'); loadSettings();
    ok(Object.keys(GRANTABLE).join() === '', 'disk: an explicit empty grants block resets to the shipped registry, which is empty');
    if (prevEnv === undefined) delete process.env.SWARM_SETTINGS_PATH; else process.env.SWARM_SETTINGS_PATH = prevEnv;
    rmSync(dir, { recursive: true, force: true });
    // Restore the fixture grants for anything that follows (one call: a load replaces the registry).
    applyGrants({
      web: { path: join(srcDir, 'fixtures/web-grant.ts'), tools: ['web_search', 'fetch_content', 'get_search_content'], effects: ['public-network', 'ssrf-guard', 'shared-cache-write'], label: 'Web' },
      corpus: { path: fixture, tools: ['corpus_search'], effects: ['local-read'], label: 'Corpus' },
    });
  }

  // v0.3.2 fix 1: a top-level value that is not an object used to return BEFORE the
  // process-global registry was rebuilt, so a revoked grant survived its own revocation.
  {
    const { applyGrants, resolveToolkit, GRANTABLE } = await import('../capabilities.ts');
    const { loadSettings } = await import('../settings.ts');
    const fixturePath = join(srcDir, 'fixtures', 'corpus-grant.ts');
    const dir = mkdtempSync(join(root, 'shape-')); const file = join(dir, 'swarm.json');
    const prevEnv = process.env.SWARM_SETTINGS_PATH;
    process.env.SWARM_SETTINGS_PATH = file;
    try {
      const def = JSON.stringify({ path: here.replace(/\\/g, '/'), tools: ['x'], effects: [] });
      writeFileSync(file, '{"grants":{"tmp":' + def + '}}'); loadSettings();
      ok(Object.hasOwn(GRANTABLE, 'tmp'), 'shape: the grant registers from a normal file');
      // Each of these parses as VALID JSON, so loadSettings' catch never runs - which is
      // exactly how the leak survived: parseSettings' own guard returned the defaults.
      for (const body of ['null', '[]', '42', '"a string"', 'true']) {
        writeFileSync(file, body); loadSettings();
        ok(!Object.hasOwn(GRANTABLE, 'tmp'), `shape: a top-level ${body} revokes the grant, it does not retain it`);
      }
      let resolved = true;
      try { resolveToolkit('grants', ['tmp']); } catch { resolved = false; }
      ok(!resolved, 'shape: a grant revoked by a malformed top-level value is no longer resolvable');
    } finally {
      if (prevEnv === undefined) delete process.env.SWARM_SETTINGS_PATH; else process.env.SWARM_SETTINGS_PATH = prevEnv;
      rmSync(dir, { recursive: true, force: true });
      applyGrants({
        web: { path: join(srcDir, 'fixtures/web-grant.ts'), tools: ['web_search', 'fetch_content', 'get_search_content'], effects: ['public-network', 'ssrf-guard', 'shared-cache-write'], label: 'Web' },
        corpus: { path: fixturePath, tools: ['corpus_search'], effects: ['local-read'], label: 'Corpus' },
      });
    }
  }

  // v0.3.2 fix 2: run.cwd is CANONICAL, so a workspace reached through a symlink promotes
  // instead of refusing every entry as escaping. Driven through start() -> run.cwd, which is
  // the path the old direct promote() tests could not reach.
  {
    const real = mkdtempSync(join(root, 'sym-real-')); const link = join(root, 'sym-link');
    symlinkSync(real, link);
    const wsThroughLink = join(link, 'proj'); mkdirSync(wsThroughLink);
    writeFileSync(join(wsThroughLink, 'orig'), 'lower');
    const up = mkdtempSync(join(root, 'sym-up-')); writeFileSync(join(up, 'new'), 'staged');
    const rt = new SR(async () => { throw new Error('unused'); }, async () => '');
    rt.start(launch, { ...s, boardRoot: root }, 'symsession', wsThroughLink);
    ok(rt.run!.cwd === realpathSync(wsThroughLink), 'symlink: run.cwd is canonical, not lexical');
    const res = rt.promote(rt.run!.cwd, { dir: up, work: join(root, 'sym-w') });
    ok(res.failed.length === 0 && existsSync(join(wsThroughLink, 'new')) && existsSync(join(wsThroughLink, 'orig')),
      'symlink: a workspace behind a symlinked component promotes normally instead of failing closed on every entry');
    void rt.abort(); await rt.completion;
  }

  // v0.3.2 fix 3: the gate sees a READ-ONLY merged view, so it cannot add to the tree it verifies.
  {
    const { wrap, sandboxArgv } = { wrap: (await import('../sandbox.ts')).wrap, sandboxArgv: (await import('../sdk.ts')).sandboxArgv };
    const cwd = '/w', stg = { dir: '/u', work: '/k' };
    const gate = wrap(['/bin/true'], { cwd, upper: stg, gate: true });
    const reduce = wrap(['/bin/true'], { cwd, upper: stg });
    ok(gate.includes('--ro-overlay') && gate.filter(x => x === '--overlay-src').length === 2
      && !gate.includes('--overlay'), 'gate: the gate box is a two-source --ro-overlay, never a writable --overlay');
    ok(reduce.includes('--overlay') && !reduce.includes('--ro-overlay'), 'gate: the reducer box is still writable, so it can stage');
    ok(sandboxArgv('true', cwd, stg, true) !== sandboxArgv('true', cwd, stg), 'gate: sandboxArgv distinguishes the gate box from the writer box');
  }

  // v0.3.2 fixes 4 + 5: the harvest owns metGoal, and every phase has a wall.
  // A run cut off by the token cap used to settle 'aborted' with metGoal forced false, which
  // reported a verified run as a failed goal. Peer states are recorded, not folded in.
  {
    const cappedPeer = async (spec: SpawnSpec, fake: any) => {
      if (spec.mode !== 'peer') return success(spec, fake);
      if (spec.name === 'peer-1') {   // finishes, but its spend is what trips the cap
        await spec.board('claim', spec.name); await spec.board('artifact', 'E');
        fake.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 50_000 } } });
        await spec.board('done', 'checked');
        return;
      }
      while (!fake.aborted) await new Promise(r => setTimeout(r, 5));  // still live when the cap fires
    };
    const cut = new SR(creator(cappedPeer), async () => '');
    // maxConcurrent 1: peer-1 finishes first and its big usage figure trips the cap, while
    // peer-2 is still the live session - the exact shape a real budget cutoff has.
    cut.start(launch, { ...s, runTokenCap: 1000, wallSeconds: 3600, peerMaxTurns: 500, graceTurns: 0, maxConcurrent: 1 },
      'session', root, { preflight: PF });
    await cut.completion;
    ok(cut.run!.state === 'aborted' && cut.run!.error?.startsWith('Run token budget reached'),
      'the spend cap that stopped the peers is the reason on the record');
    ok(cut.run!.metGoal === true,
      'the harvest verdict survives a budget cutoff - a capped run is aborted, not reported as an unmet goal');
    ok(cut.run!.peers.some(p => p.state !== 'done') && /did not finish/.test(cut.run!.error ?? ''),
      'peers that did not finish are named on the record instead of silently flipping the verdict');
  }
  // A stalling harvest must be bounded: the old code cleared the wall before the harvest.
  {
    const stall = new SR(creator(async (spec, fake) => {
      if (spec.mode === 'harvest') { while (!fake.aborted) await new Promise(r => setTimeout(r, 5)); return; }  // mid-turn stall: no turn_end
      await success(spec, fake);
    }), async () => '');
    stall.start(launch, { ...s, wallSeconds: 10, runTokenCap: 0 }, 'session', root);
    const started = Date.now();
    await stall.completion;
    ok(stall.run!.ended !== undefined && Date.now() - started < 40_000,
      'a mid-turn stall in the harvest is stopped by the phase wall, so the run still settles');
    ok(stall.run!.state === 'blocked' && /harvest phase exceeded/.test(stall.run!.error ?? '')
    && stall.run!.peers.find(p => p.name === 'harvest')?.state === 'failed',
    'a phase-wall stop states which phase ran out and settles, instead of hanging the run forever');
  }
  // apply requested but the harvest did not verify: no reducer, no gate, and a stated reason.
  {
    let gates = 0;
    const unverified = new SR(creator(async (spec, fake) => {
      if (spec.mode === 'harvest') { spec.verdict(false, 'Goal not met: the audit found a blocker'); return; }
      await success(spec, fake);
    }), async () => { gates++; return 'pass'; });
    unverified.start({ ...launch, apply: true, reduceGate: 'true' }, s, 'session', root, { preflight: PF });
    await unverified.completion;
    ok(gates === 0 && !unverified.run!.peers.some(p => p.name === 'reduce')
      && /SKIPPED/.test(unverified.run!.error ?? ''),
      'apply requested but unverified: no writer, no gate, and the skip says so on the record');
    ok(unverified.run!.ended !== undefined && unverified.run!.state !== 'running',
      'an apply that was skipped still settles the run - it does not return with the state running');
  }

  // v0.3.2 review fix: a wall that fires while the session is still being CREATED has no live
  // session to abort, and the old one-shot stood down - the run hung for good, permanently
  // unstartable in this session. The spawn itself must be bounded.
  {
    const hungCreate = new SR(async (spec) => {
      if (spec.mode === 'harvest') await new Promise(() => {});   // create() never returns
      return { spec, messages: [], sessionFile: '', disposed: false, aborted: false,
        subscribe: () => () => {}, async steer() {}, async abort() { this.aborted = true; }, dispose() {},
        async prompt() { this.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'r' }], usage: { totalTokens: 1 } }); } } as any;
    }, async () => '');
    hungCreate.start(launch, { ...s, wallSeconds: 10, runTokenCap: 0 }, 'session', root);
    const raced = await Promise.race([hungCreate.completion.then(() => 'settled'), new Promise(r => setTimeout(() => r('HUNG'), 30_000))]);
    ok(raced === 'settled', 'a session that never finishes creating is stopped by the phase wall, not waited on forever');
    ok(hungCreate.run!.ended !== undefined && hungCreate.run!.peers.find(p => p.name === 'harvest')?.state === 'failed',
      'the hung spawn is recorded as a failed phase, so the run still settles with a report');
  }

  console.log(`PASS: ${checks} offline checks; no sessions/models launched`);
} finally { rmSync(root, { recursive: true, force: true }); }
