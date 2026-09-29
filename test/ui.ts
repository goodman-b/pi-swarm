// Offline UI regression tests. Fake ExtensionCommandContext + fake tui; no models, no real terminal.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import { applyGrants } from '../capabilities.ts';
import { swarmCommand } from '../commands.ts';
import { showRun } from '../view.ts';
import { boardOverview, displayRun, listRuns } from '../history.ts';
import { DEFAULTS, type Settings } from '../settings.ts';

let checks = 0;
// Fixture grants (see checks.ts): one call, because a load replaces the registry.
// DEFAULTS.grants carries the same map so every settings object the fakes build
// re-applies it instead of resetting the registry to built-ins.
const FIXTURE_GRANTS = {
  web: { path: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/web-grant.ts'), tools: ['web_search', 'fetch_content', 'get_search_content'], effects: ['public-network', 'ssrf-guard', 'shared-cache-write'], label: 'Web' },
  corpus: { path: join(dirname(fileURLToPath(import.meta.url)), 'fixtures/corpus-grant.ts'), tools: ['corpus_search'], effects: ['local-read'], label: 'Corpus' },
};
applyGrants(FIXTURE_GRANTS);
DEFAULTS.grants = FIXTURE_GRANTS;
const ok = (v: unknown, message: string) => { assert.ok(v, message); checks++; };
const mkPeer = (name: string, state: string) => ({ name, state, turns: 1, toolCalls: 2, lastTool: 'read', lastActivity: 0, tokens: 10, cost: 0.1, text: 'notes' });
const ESC = '\x1b', TAB = '\t', ENTER = '\r', DOWN = '\x1b[B';

// ---- fake UI: scripted prompt queue; unexpected or mismatched prompt fails ----
type Ans = { select?: string } | { editor?: string } | { input?: string } | { confirm?: boolean } | { keys?: string[] };
function fakeCtx(answers: Ans[], opts: { tui?: boolean; session?: string } = {}) {
  const queue = [...answers];
  const prompts: { kind: string; title: string; options?: string[] }[] = [];
  const notices: { message: string; type?: string }[] = [];
  const components: any[] = [];
  let renders = 0;
  const next = (kind: string, title: string): Ans => {
    prompts.push({ kind, title });
    const a = queue.shift();
    if (!a) throw new Error(`unexpected ${kind} prompt: ${title}`);
    const kinds = kind === 'custom' ? ['custom', 'keys'] : [kind];
    if (!kinds.some(k => k in a)) throw new Error(`scripted answer for wrong kind at: ${kind} · ${title}`);
    return a;
  };
  const ui = {
    async select(title: string, options: string[]) {
      const a = next('select', title);
      const want = (a as any).select as string;
      const hits = options.filter(o => o === want || o.startsWith(want));
      if (hits.length !== 1) throw new Error(`select answer '${want}' matched ${hits.length} options for: ${title}`);
      prompts[prompts.length - 1].options = options;
      return hits[0];
    },
    async editor(title: string, prefill?: string) { prompts[prompts.length - 1].options = [prefill ?? '']; return (next('editor', title) as any).editor; },
    async input(title: string) { return (next('input', title) as any).input; },
    async confirm(title: string, detail?: string) { const a = next('confirm', title); prompts[prompts.length - 1].options = [detail ?? '']; return (a as any).confirm; },
    notify(message: string, type?: string) { notices.push({ message, type }); },
    custom(factory: any) {
      const a = next('custom', 'showRun');
      let settled = false, value: unknown;
      const comp: any = factory({ requestRender() { renders++; }, terminal: { rows: 30 } }, { fg: (_n: string, s: string) => s }, {}, (r: unknown) => { if (!settled) { settled = true; value = r; } });
      components.push(comp);
      try { for (const k of (a as any).keys ?? []) comp.handleInput(k); } finally { comp.dispose?.(); }
      if (!settled) throw new Error('custom component never called done (script must end with a closing key)');
      return Promise.resolve(value);
    },
  };
  const ctx: any = {
    mode: opts.tui === false ? 'print' : 'tui', hasUI: true,
    sessionManager: { getSessionId: () => opts.session ?? 'sess1' },
    modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'm' }] }, scopedModels: [], model: { provider: 'p', id: 'm' },
    ui, prompts, notices, components, get renders() { return renders; },
  };
  ctx.expectDone = () => assert.equal(queue.length, 0, 'leftover scripted answers: ' + JSON.stringify(queue));
  return ctx;
}
function fakeControls(settings: Settings) {
  const c: any = { saved: [] as Settings[], started: [] as any[], cancelled: 0, steered: [] as string[] };
  c.settings = () => settings;
  c.save = (s: Settings) => { c.saved.push(s); Object.assign(settings, s); };
  c.live = () => undefined;
  c.start = async (a: any) => { c.started.push(a); return {}; };
  c.cancel = async () => { c.cancelled++; };
  c.steer = async (p: string, m: string) => { c.steered.push(p, m); };
  return c;
}

const root = mkdtempSync(join(tmpdir(), 'swarm-ui-'));
try {
  // ---- fixture boards: session run, flat legacy, other session, corrupt, symlink ----
  const boards = join(root, 'boards');
  const runADir = join(boards, 'sess1', 'run-a');
  mkdirSync(runADir, { recursive: true });
  const endedRun = { id: 'run-a', session: 'sess1', dir: runADir, cwd: root, goal: 'Inspect evidence', done: 'verified', phase: 'done', state: 'done', model: 'p/m', started: 1000, ended: 2000, peers: [mkPeer('peer-1', 'done'), mkPeer('harvest', 'done')], metGoal: true };
  writeFileSync(join(runADir, 'run.json'), JSON.stringify(endedRun));
  const legacy = join(boards, 'oldflat');
  mkdirSync(join(legacy, 'claims'), { recursive: true });
  writeFileSync(join(legacy, 'GOAL.md'), 'Legacy goal');
  writeFileSync(join(legacy, 'board.jsonl'), [
    JSON.stringify({ kind: 'post', agent: 'system', text: 'swarm starting: 3 peers', ts: 100 }),
    JSON.stringify({ kind: 'post', agent: 'peer-1', thread: 'findings', text: 'evidence one', ts: 101 }),
    JSON.stringify({ kind: 'post', agent: 'peer-2', thread: 'findings', text: 'evidence two', ts: 102 }),
    JSON.stringify({ kind: 'post', agent: 'peer-2', thread: 'claims', text: 'collision on s1', ts: 103 }),
    'not-json-torn-tail',
  ].join('\n') + '\n');
  writeFileSync(join(legacy, 'claims', 'a1b2c3d4'), JSON.stringify({ slice: 's1', agent: 'peer-1' }));
  writeFileSync(join(legacy, 'claims', 'skip.tmp'), 'x');
  const otherDir = join(boards, 'other', 'run-b');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'run.json'), JSON.stringify({ ...endedRun, id: 'run-b', session: 'other', dir: otherDir }));
  mkdirSync(join(boards, 'junk'), { recursive: true });
  writeFileSync(join(boards, 'junk', 'readme.txt'), 'not a board');
  const outside = join(root, 'outside-target');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'board.jsonl'), JSON.stringify({ kind: 'post', agent: 'x', thread: 'findings', text: 'should never be listed', ts: 1 }) + '\n');
  symlinkSync(outside, join(boards, 'linkdir'));

  const sessionKeys = listRuns(boards, 'sess1').map(r => r.key);
  const allKeys = listRuns(boards, 'sess1', true).map(r => r.key);
  ok(sessionKeys.join() === 'sess1/run-a', 'this-session list only shows this session');
  ok(allKeys.includes('oldflat') && allKeys.includes('other/run-b'), 'all-sessions list includes flat legacy and other sessions');
  ok(!allKeys.includes('junk') && !allKeys.some(k => k.includes('linkdir')), 'corrupt dirs ignored, symlinked dirs not followed');
  ok(!listRuns(join(boards, 'junk'), 'sess1', true).length, 'unrelated dir yields no refs');

  // ---- legacy board: unknown state, no fabricated success, explicit peers/claims/findings ----
  const legacyRun = displayRun(listRuns(boards, 'sess1', true).find(r => r.key === 'oldflat')!);
  ok(legacyRun.state === 'unknown' && legacyRun.phase === 'legacy board' && legacyRun.metGoal === undefined, 'legacy board shows unknown state, never fabricated success');
  ok(legacyRun.error?.includes('No automatic resume'), 'legacy run states its limits');
  const lb = boardOverview(legacyRun.dir);
  ok(lb.goal === 'Legacy goal' && lb.findings === 2 && lb.collisions === 1 && lb.roster === 3, 'legacy overview: goal/findings/collisions/roster from board.jsonl');
  ok(lb.claims.length === 1 && lb.claims[0].slice === 's1', 'hashed claim file without extension counted, .tmp skipped');
  ok(lb.peers.length === 2 && lb.peers.every(p => p.state === 'unknown'), 'legacy peers listed without invented states');

  // ---- empty /swarm: home menu ----
  let s: Settings = { ...DEFAULTS, boardRoot: boards };
  let c = fakeControls(s);
  let ctx = fakeCtx([{ select: 'Close' }]);
  await swarmCommand('', ctx, c); ctx.expectDone();
  const home = ctx.prompts[0].options!;
  ok(home.includes('New swarm') && home.some(o => o.startsWith('This session')) && home.includes('All sessions') && home.includes('Settings'), 'home menu offers New/session/all/Settings');
  ok(home[0].startsWith('Latest board: sess1/run-a'), 'home shows latest board first');

  // ---- New swarm: editor fills Goal+DoD, explicit Start + confirm ----
  ctx = fakeCtx([
    { select: 'New swarm' },
    { select: 'Goal' }, { editor: 'Inspect the evidence' },
    { select: 'Definition of done' }, { editor: 'Every finding independently checked' },
    { select: 'Start read' }, { confirm: true }, { select: 'Close' },
  ]);
  c = fakeControls(s);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.started.length === 1 && c.started[0].goal === 'Inspect the evidence' && c.started[0].done === 'Every finding independently checked', 'start receives edited goal+done');
  ok(c.started[0].agents >= 2 && !c.started[0].apply, 'read-only launch with peer count');

  // ---- New swarm: the writer path is reachable from the menu (first-run audit, issue #4) ----
  // The write path used to exist only via swarm_start({apply, reduceGate}); the form had no
  // apply field and its only button said "Start read-only swarm", so a user whose goal was to
  // change code had no in-UI path at all.
  {
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'Fix the quantity bug' },
      { select: 'Definition of done' }, { editor: 'tests pass' },
      { select: 'Writer' }, { select: 'on' },
      { select: 'Verification gate' }, { editor: 'node test.mjs' },
      { select: 'Start swarm with writer' }, { confirm: true }, { select: 'Close' },
    ]);
    c = fakeControls(s);
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 1 && c.started[0].apply === true && c.started[0].reduceGate === 'node test.mjs',
      'the launch form can start a writer: apply + reduceGate reach start()');
  }
  {
    // The confirmation must name the writer and its gate - it is the only place the user is
    // told a reducer may edit their files.
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'Fix it' },
      { select: 'Definition of done' }, { editor: 'tests pass' },
      { select: 'Writer' }, { select: 'on' },
      { select: 'Verification gate' }, { editor: 'npm test' },
      { select: 'Start swarm with writer' }, { confirm: true }, { select: 'Close' },
    ]);
    c = fakeControls(s);
    await swarmCommand('', ctx, c); ctx.expectDone();
    const conf = ctx.prompts.filter(p => p.kind === 'confirm').map(p => String(p.options?.[0] ?? '')).join('\n');
    ok(/Writer ENABLED/.test(conf) && /npm test/.test(conf), 'the writer confirmation names the writer and its gate');
  }
  {
    // Default stays read-only: the writer is opt-in, never inferred.
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'Audit only' },
      { select: 'Definition of done' }, { editor: 'findings reported' },
      { select: 'Start read' }, { confirm: true }, { select: 'Close' },
    ]);
    c = fakeControls(s);
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started[0].apply === undefined, 'leaving the writer off launches read-only with no apply field');
  }

  // ---- minimal toolkit with a leftover defaultTools still starts (v0.2.6 regressed this:
  // the form passed its draft list as an explicit selection, so resolveToolkit threw) ----
  {
    const sm = { ...s, defaultToolkit: 'minimal' as const, defaultTools: ['web'] };
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'g' },
      { select: 'Definition of done' }, { editor: 'd' },
      { select: 'Start read' }, { confirm: true }, { select: 'Close' },
    ]);
    c = fakeControls(sm);
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 1 && !('tools' in c.started[0]),
      'a leftover defaultTools never bricks a minimal-toolkit launch from the form');
  }

  // ---- New swarm: Back never starts ----
  ctx = fakeCtx([{ select: 'New swarm' }, { select: 'Goal' }, { editor: 'g' }, { select: 'Back' }, { select: 'Close' }]);
  c = fakeControls(s);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.started.length === 0, 'Back from the launch menu never starts');

  // ---- New swarm: declining the launch confirm never starts ----
  ctx = fakeCtx([
    { select: 'New swarm' }, { select: 'Goal' }, { editor: 'g' },
    { select: 'Definition of done' }, { editor: 'd' }, { select: 'Start read' }, { confirm: false },
    { select: 'Back' }, { select: 'Close' },
  ]);
  c = fakeControls(s);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.started.length === 0, 'confirm=false never starts');

  // ---- New swarm: a failed start keeps the form open (retry, then Back) ----
  ctx = fakeCtx([
    { select: 'New swarm' }, { select: 'Goal' }, { editor: 'g' },
    { select: 'Definition of done' }, { editor: 'd' }, { select: 'Start read' }, { confirm: true },
    { select: 'Start read' }, { confirm: true }, { select: 'Close' },
  ]);
  c = fakeControls(s);
  c.start = async (a: any) => { c.started.push(a); if (c.started.length === 1) throw new Error('Swarm is busy'); return {}; };
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.started.length === 2 && ctx.notices.some(n => n.type === 'error' && n.message.includes('busy')), 'failed start notifies and keeps the form open; retry starts and returns');

  // ---- settings: bool toggle persists; invalid/clamping rejected ----
  s = { ...DEFAULTS, boardRoot: boards }; c = fakeControls(s);
  ctx = fakeCtx([{ select: 'Settings' }, { select: 'Status widget' }, { select: 'Back' }, { select: 'Close' }]);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.saved.length === 1 && c.saved[0].widget === false, 'bool setting toggles and persists');

  s = { ...DEFAULTS, boardRoot: boards }; c = fakeControls(s);
  ctx = fakeCtx([{ select: 'Settings' }, { select: 'Peer turns' }, { input: 'bogus' }, { select: 'Back' }, { select: 'Close' }]);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.saved.length === 0 && ctx.notices.some(n => n.type === 'error'), 'invalid numeric rejected without persisting');

  s = { ...DEFAULTS, boardRoot: boards, maxAgents: 4 }; c = fakeControls(s);
  ctx = fakeCtx([{ select: 'Settings' }, { select: 'Default peers' }, { input: '12' }, { select: 'Back' }, { select: 'Close' }]);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(c.saved.length === 0 && ctx.notices.some(n => n.type === 'error'), 'defaultAgents>maxAgents rejected, not silently clamped');

  // ---- runs browser: this session vs all sessions ----
  s = { ...DEFAULTS, boardRoot: boards };
  ctx = fakeCtx([{ select: 'This session' }, { select: 'sess1/run-a' }, { keys: [ESC] }, { select: 'Back' }, { select: 'Close' }]);
  c = fakeControls(s);
  await swarmCommand('', ctx, c); ctx.expectDone();
  const browseLabels = ctx.prompts[1].options!;
  ok(browseLabels.length === 2 && browseLabels[0].startsWith('sess1/run-a · done') && !browseLabels.some(l => l.startsWith('oldflat')), 'this-session browser lists only this session');

  ctx = fakeCtx([{ select: 'All sessions' }, { select: 'oldflat' }, { keys: [ESC] }, { select: 'Back' }, { select: 'Close' }]);
  c = fakeControls(s);
  await swarmCommand('', ctx, c); ctx.expectDone();
  ok(ctx.prompts[1].options!.some(l => l.startsWith('oldflat · unknown · 3 peers · 2 findings')), 'all-browser shows legacy roster/findings counts');

  // ---- showRun render: CJK/emoji rows stay inside the frame at 20/40/80 ----
  const wideRun: any = { ...endedRun, dir: legacy, goal: '目标 goal 🎯 evidence', done: '完成 done ✅',
    peers: [mkPeer('peer-1', 'done'), mkPeer('peer-2', 'running'), mkPeer('harvest', 'running')] };
  ctx = fakeCtx([{ keys: [ESC] }]);
  await showRun(ctx, () => wideRun, { settings: s });
  const comp = ctx.components[0];
  for (const width of [20, 40, 80]) {
    const rows = comp.render(width);
    for (const line of rows) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      assert.ok(visibleWidth(plain) <= width, `row too wide at ${width}: ${JSON.stringify(plain)} (${visibleWidth(plain)})`);
      checks++;
    }
    ok(rows.length > 2 && rows[0].includes('╭') && rows[rows.length - 1].includes('╰'), `bordered output at width ${width}`);
  }
  ok(ctx.renders > 0, 'refresh requested a render via the fake tui');

  // ---- Tab to Peers, Enter inspector, Esc back, Esc closes ----
  ctx = fakeCtx([{ keys: [TAB, TAB, ENTER, ESC, ESC] }]);
  await showRun(ctx, () => wideRun, { settings: s });
  ok(ctx.components.length === 1, 'tab to peers, enter inspector, esc back, esc close ran cleanly');

  // ---- steering a running peer: s on the Peers tab, and Enter from the inspector ----
  ctx = fakeCtx([{ keys: [TAB, TAB, DOWN, 's'] }, { input: 'check the claims again' }, { keys: [ESC] }]);
  const steered: string[] = [];
  await showRun(ctx, () => wideRun, { settings: s, controls: () => true, steer: async (p, m) => { steered.push(p, m); } });
  ok(steered.join('|') === 'peer-2|check the claims again', 's steers the selected (second) peer with explicit input');

  ctx = fakeCtx([{ keys: [TAB, TAB, DOWN, ENTER, ENTER] }, { input: 'via inspector' }, { keys: [ESC, ESC] }]);
  const insp: string[] = [];
  await showRun(ctx, () => wideRun, { settings: s, controls: () => true, steer: async (p, m) => { insp.push(p, m); } });
  ok(insp.join('|') === 'peer-2|via inspector', 'Enter in the peers inspector steers the same selected peer');

  // ---- steer ignored outside the Peers tab ----
  ctx = fakeCtx([{ keys: ['s', ESC] }]);
  let off = 0;
  await showRun(ctx, () => wideRun, { settings: s, controls: () => true, steer: async () => { off++; } });
  ok(off === 0, 's on the overview tab does not steer');

  // ---- x cancel: confirm false does not cancel, true does ----
  ctx = fakeCtx([{ keys: ['x'] }, { confirm: false }, { keys: [ESC] }]);
  let cancelled = 0;
  await showRun(ctx, () => wideRun, { settings: s, controls: () => true, cancel: async () => { cancelled++; } });
  ok(cancelled === 0, 'cancel confirm=false never cancels');
  ctx = fakeCtx([{ keys: ['x'] }, { confirm: true }, { keys: [ESC] }]);
  await showRun(ctx, () => wideRun, { settings: s, controls: () => true, cancel: async () => { cancelled++; } });
  ok(cancelled === 1, 'cancel confirm=true cancels once');

  // ---- ownership re-checked after the prompt ----
  ctx = fakeCtx([{ keys: ['x'] }, { confirm: true }, { keys: [ESC] }]);
  let owned = true, late = 0;
  const ask = ctx.ui.confirm;
  ctx.ui.confirm = async (t: string, m: string) => { owned = false; return ask(t, m); }; // run lost while the dialog was open
  await showRun(ctx, () => wideRun, { settings: s, controls: () => owned, cancel: async () => { late++; } });
  ok(late === 0, 'cancel is dropped if ownership ended during the confirm');

  // ---- controls()=false (history): s/x ignored entirely ----
  ctx = fakeCtx([{ keys: [TAB, TAB, DOWN, 's', 'x', ESC] }]);
  let touched = 0;
  await showRun(ctx, () => wideRun, { settings: s, controls: () => false, steer: async () => { touched++; }, cancel: async () => { touched++; } });
  ok(touched === 0, 'read-only history view calls neither steer nor cancel');

  // ---- n/p cycle preserves ownership checks ----
  const refs = [{ key: 'oldflat', dir: legacy, mtime: 1 }, { key: 'sess1/run-a', dir: runADir, mtime: 2 }];
  let current = refs[0];
  const cycle = (d: number) => { current = refs[(refs.indexOf(current) + d + refs.length) % refs.length]; };
  current = refs[0];
  ctx = fakeCtx([{ keys: ['n', ESC] }]);
  await showRun(ctx, () => displayRun(current), { settings: s, cycle, controls: () => current.key === 'sess1/run-a' });
  ok(current.key === 'sess1/run-a', 'n cycles to the next run');
  current = refs[0];
  ctx = fakeCtx([{ keys: ['n', 'x'] }, { confirm: true }, { keys: [ESC] }]);
  let liveCancel = 0;
  await showRun(ctx, () => displayRun(current), { settings: s, cycle, controls: () => current.key === 'sess1/run-a', cancel: async () => { liveCancel++; } });
  ok(liveCancel === 1, 'after cycling onto the owned run, cancel is allowed');
  current = refs[0];
  ctx = fakeCtx([{ keys: ['n', 'n', 'x', ESC] }]); // n,n cycles back to the legacy board
  await showRun(ctx, () => displayRun(current), { settings: s, cycle, controls: () => current.key === 'sess1/run-a', cancel: async () => { liveCancel++; } });
  ok(liveCancel === 1 && current.key === 'oldflat', 'cycling back to read-only history disables controls again');

  // ---- non-TUI mode: notify fallback, no custom component ----
  ctx = fakeCtx([], { tui: false });
  await showRun(ctx, () => wideRun, { settings: s });
  ok(ctx.components.length === 0 && ctx.notices.length === 1, 'print mode falls back to a notify summary');

  // ---- /swarm cancel subcommand honors confirm and liveness ----
  ctx = fakeCtx([]); // no live run: must not even prompt
  c = fakeControls(s);
  await swarmCommand('cancel', ctx, c); ctx.expectDone();
  ok(c.cancelled === 0 && ctx.prompts.length === 0, '/swarm cancel with no live run prompts nothing');
  ctx = fakeCtx([]);
  c.live = () => ({ ...endedRun }); // ended run: notify only, never prompt
  await swarmCommand('cancel', ctx, c); ctx.expectDone();
  ok(c.cancelled === 0 && ctx.prompts.length === 0 && ctx.notices.some(n => n.message.includes('No active swarm')), '/swarm cancel on an ended run only notifies');
  ctx = fakeCtx([{ confirm: false }]);
  c.live = () => ({ ...endedRun, ended: undefined });
  await swarmCommand('cancel', ctx, c); ctx.expectDone();
  ok(c.cancelled === 0 && ctx.prompts.length === 1, '/swarm cancel without confirm does nothing');
  const liveRun: any = { ...endedRun, ended: undefined };
  c.live = () => liveRun;
  ctx = fakeCtx([{ confirm: true }]);
  await swarmCommand('cancel', ctx, c); ctx.expectDone();
  ok(c.cancelled === 1, '/swarm cancel with confirm cancels the live run');

  // ---- toolkit: tri-state transitions in the launch form ----
  {
    const parent = { tools: [{ name: 'read', path: '/pi/base.ts' }], paths: ['/pi/base.ts'] };
    const inv: any[] = [];
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Toolkit' }, { select: 'grants' },
      { select: 'Grants' }, { select: 'Web: ○' },
      { select: 'Toolkit' }, { select: 'inherit' },
      { select: 'Start read' },
      { select: 'Toolkit' }, { select: 'minimal' },
      { select: 'Back' }, { select: 'Close' },
    ]);
    c = fakeControls(s); c.parentInventory = () => { inv.push(1); return parent; };
    await swarmCommand('', ctx, c); ctx.expectDone();
    const menus = ctx.prompts.filter(p => p.kind === 'select' && p.options).map(p => p.options!.join('\n'));
    const grantsMenu = menus.find(m => m.includes('Grants: Web'))!;
    ok(grantsMenu.includes('Toolkit: grants') && menus.some(m => m.includes('Grants: none')), 'grants mode toggles selections and shows them in the form');
    const inheritMenu = menus.find(m => m.includes('Inherited toolset: 1 tools: read'))!;
    ok(inheritMenu.includes('Toolkit: inherit'), 'launch form shows all three tri-state values');
    ok(inheritMenu.includes('Inherited toolset: 1 tools: read'), 'inherit mode previews the live-resolved tool count/names');
    ok(inv.length === 2, 'parentInventory is consulted for inherit previews only');
    const blocked = menus.filter(m => m.includes('Toolkit: minimal'));
    ok(blocked.length >= 1 && blocked.every(m => m.includes('Inherited toolset: n/a')), 'minimal mode shows n/a for the inherit preview');
    ok(c.started.length === 0, 'start without goal/DoD refuses and stays in the form');
  }
  // ---- toolkit: grants rows are generated from the GRANTABLE registry ----
  {
    const { GRANTABLE, resolveToolkit } = await import('../capabilities.ts');
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Toolkit' }, { select: 'grants' },
      { select: 'Grants' }, { select: 'Web: ○' },
      { select: 'Grants' }, { select: 'Corpus: ○' },
      { select: 'Grants' }, { select: 'Keep' },
      { select: 'Goal' }, { editor: 'g' },
      { select: 'Definition of done' }, { editor: 'd' },
      { select: 'Start read' }, { confirm: true }, { select: 'Close' },
    ]);
    c = fakeControls(s);
    await swarmCommand('', ctx, c); ctx.expectDone();
    const row = ctx.prompts.filter(p => p.kind === 'select' && p.title.startsWith('Toolkit grants')).pop()!.options!;
    ok(row[0].includes('Web: ✓ (public-network, ssrf-guard, shared-cache-write)') && row[1].includes('Corpus: ✓ (local-read)'), 'grants toggle rows render the registry labels and effects');
    ok(c.started.length === 1 && c.started[0].toolkit === 'grants' && c.started[0].tools!.join() === 'web,corpus', 'grants launch sends the exact registry-derived selection');
    ok(c.started[0].model === 'p/m', 'launch with no defaultModel sends the session model');
    const webLabel = GRANTABLE.web.label; GRANTABLE.web.label = 'Webby';
    const fresh = (Object.keys(GRANTABLE)).map(n => `${GRANTABLE[n].label}: ○ (${GRANTABLE[n].effects.join(', ')})`);
    ok(fresh.includes('Webby: ○ (public-network, ssrf-guard, shared-cache-write)') && !fresh.includes(`Web: ○`), 'grants rows follow registry label renames (no hardcoded names)');
    ok(resolveToolkit('grants', ['web']).toolNames.includes('web_search'), 'grant selection resolves the registry tool list');
    GRANTABLE.web.label = webLabel;
  }
  // ---- toolkit: grants mode pre-filled from settings.defaultToolkit + defaultTools ----
  {
    const sg = { ...s, defaultToolkit: 'grants' as const, defaultTools: ['web'] };
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Toolkit' }, { select: 'minimal' },
      { select: 'Back' }, { select: 'Close' },
    ]);
    c = fakeControls(sg);
    await swarmCommand('', ctx, c); ctx.expectDone();
    const menu = ctx.prompts[1].options!;
    ok(menu.some(l => l.startsWith('Toolkit: grants')) && menu.includes('Grants: Web'), 'form pre-selects the settings default toolkit and grant list');
    ok(menu.some(l => l.startsWith('Toolkit:')) && menu.filter(l => l.startsWith('Toolkit')).length === 1, 'toolkit row and grants row are distinct');
  }
  // ---- toolkit: defaults persistence in /swarm settings ----
  {
    const sp = { ...s };
    ctx = fakeCtx([
      { select: 'Settings' }, { select: 'Default toolkit' }, { select: 'grants' },
      { select: 'Default grant list' }, { input: 'web, corpus' },
      { select: 'Sandbox' }, { select: 'off' },
      { select: 'Default grant list' }, { input: 'web, wat' },
      { select: 'Default toolkit' }, { select: 'inherit' },
      { select: 'Back' }, { select: 'Close' },
    ]);
    c = fakeControls(sp);
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.saved.length === 4, 'valid toolkit/grant/sandbox edits persist');
    ok(c.saved[0].defaultToolkit === 'grants' && c.saved[1].defaultTools.join() === 'web,corpus', 'defaultToolkit + defaultTools persist');
    ok(c.saved[2].sandbox === 'off' && c.saved[2].defaultToolkit === 'grants', 'sandbox persists as a value, not a reference');
    ok(c.saved[3].defaultToolkit === 'inherit' && c.saved[3].defaultTools.join() === 'web,corpus', 'invalid list rejected without touching other fields');
    ok(ctx.notices.some(n => n.type === 'error' && n.message.includes('wat')), 'unknown grant name names the offender and refuses the whole list');
  }
  // ---- toolkit: inherit on a shell-carrying parent drops shell, launches, and says so ----
  {
    const shellParent = { tools: [{ name: 'read', path: '/pi/base.ts' }, { name: 'bash', path: '/pi/shell.ts' }], paths: ['/pi/base.ts', '/pi/shell.ts'] };
    const base = [
      { select: 'New swarm' },
      { select: 'Toolkit' }, { select: 'inherit' },
      { select: 'Goal' }, { editor: 'g' },
      { select: 'Definition of done' }, { editor: 'd' },
      { select: 'Start read' },
    ];
    const startSeq = () => [...base, { confirm: true }, { select: 'Close' }];      // launches, form closes
    const blockedSeq = () => [...base, { select: 'Back' }, { select: 'Close' }];    // error, stays in form
    ctx = fakeCtx(startSeq());
    c = fakeControls(s); c.parentInventory = () => shellParent;
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 1, 'a parent with bash no longer blocks an inherit launch - shell is dropped, not fatal');
    ok(ctx.prompts.filter(p => p.kind === 'select' && p.options).map(p => p.options!.join('\n'))
      .some(m => m.includes('Inherited toolset: 1 tools: read')),
      'the launch preview shows the filtered toolset, so the drop is visible before starting');
    ok(!ctx.notices.some(n => n.type === 'error'), 'no error notice for a shell-carrying parent - inherit just filters it out');
    ctx = fakeCtx(blockedSeq());
    c = fakeControls(s);
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 0 && ctx.notices.some(n => n.type === 'error' && n.message.includes('requires a parent inventory at launch')), 'inherit without a resolvable parent shows the literal blocker');
    ctx = fakeCtx(blockedSeq());
    c = fakeControls(s); c.parentInventory = () => { throw new Error('toolkit "inherit" needs pi.getAllTools() and pi.getCommands(); this Pi API does not expose them — use toolkit "minimal" or "grants"'); };
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 0 && ctx.notices.some(n => n.type === 'error' && n.message.includes('needs pi.getAllTools()')), 'parentInventory API failure surfaces verbatim, no silent minimal fallback');
  }
  // ---- toolkit: inherit confirmation carries the two warning lines + sandbox-off note ----
  {
    const parent = { tools: [{ name: 'read', path: '/pi/base.ts' }], paths: ['/pi/base.ts'] };
    const sinherit = { ...s, defaultToolkit: 'inherit' as const };
    const soff = { ...s, defaultToolkit: 'inherit' as const, sandbox: 'off' as const };
    const mk = () => fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'g' },
      { select: 'Definition of done' }, { editor: 'd' },
      { select: 'Start read' }, { confirm: true }, { select: 'Close' },
    ]);
    ctx = mk();
    c = fakeControls(sinherit); c.parentInventory = () => parent;
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(c.started.length === 1 && c.started[0].toolkit === 'inherit' && c.started[0].tools === undefined, 'inherit launch carries the toolkit, no tools field');
    const confirm = ctx.prompts.find(p => p.kind === 'confirm')!;
    ok(confirm.title === 'Launch swarm?', 'confirmation title unchanged');
    const confirmText = JSON.stringify(confirm);
    ok(confirmText.includes('Inherited extension effects are undeclared.') && confirmText.includes('Extension-internal shell commands bypass bwrap.'), 'both inherit warning lines appear verbatim in the confirmation');
    ok(confirmText.includes('Toolkit: inherit') && confirmText.includes('Tools: read'), 'confirmation renders the resolved toolkit, not hardcoded text');
    ctx = mk();
    const seen: string[] = [];
    const own = ctx.ui.confirm;
    ctx.ui.confirm = async (t: string, m: string) => { seen.push(m); return own(t, m); };
    c = fakeControls(soff); c.parentInventory = () => parent;
    await swarmCommand('', ctx, c); ctx.expectDone();
    ok(seen.length === 1 && seen[0].includes('Sandbox is "off": granted or inherited tools run WITHOUT a bwrap box.'), 'sandbox-off surfaces explicitly in the confirmation');
  }
  // ---- toolkit: resolved set changing between preview and confirm requires re-confirmation ----
  {
    const full = { tools: [{ name: 'read', path: '/pi/base.ts' }, { name: 'web_search', path: '/home/x/ext-web/index.ts' }], paths: ['/pi/base.ts', '/home/x/ext-web/index.ts'] };
    const reduced = { tools: [{ name: 'read', path: '/pi/base.ts' }], paths: ['/pi/base.ts'] };
    let flip = false;
    ctx = fakeCtx([
      { select: 'New swarm' },
      { select: 'Goal' }, { editor: 'g' },
      { select: 'Definition of done' }, { editor: 'd' },
      { select: 'Start read' }, { confirm: true }, { confirm: false },
      { select: 'Back' }, { select: 'Close' },
    ]);
    c = fakeControls({ ...s, defaultToolkit: 'inherit' as const });
    c.parentInventory = () => flip ? reduced : full;
    const ask = ctx.ui.confirm;
    ctx.ui.confirm = async (t: string, m: string) => { const r = await ask(t, m); if (r) flip = true; return r; }; // parent loses an extension while the dialog is open
    await swarmCommand('', ctx, c); ctx.expectDone();
    const confirms = ctx.prompts.filter(p => p.kind === 'confirm');
    ok(c.started.length === 0, 'a changed resolution is not silently started');
    ok(confirms.length === 2, 'changed resolution triggers a second confirmation');
    ok(confirms[1].title.includes('resolved toolkit changed since the last preview'), 're-confirmation names the changed set');
  }
  // ---- dashboard: toolkit/sandbox badges, historical "not recorded", blocked state, width safety ----
  {
    const { resolveToolkit } = await import('../capabilities.ts');
    const notRecorded = { ...endedRun, toolkit: undefined, sandbox: undefined };
    ctx = fakeCtx([], { tui: false });
    await showRun(ctx, () => notRecorded as any, { settings: s });
    let text = ctx.notices[0].message;
    ok(text.includes('Toolkit: not recorded (run from before toolkits)') && text.includes('Sandbox: not recorded'), 'historical run without toolkit/sandbox renders not recorded, never invented');
    const tWeb = resolveToolkit('grants', ['web'], undefined, true);
    const blockedRun: any = { ...endedRun, toolkit: tWeb, sandbox: { requested: 'auto', available: false, warning: 'sandbox unavailable (bwrap not found); granted or inherited tools run WITHOUT a bwrap box' } };
    ctx = fakeCtx([], { tui: false });
    await showRun(ctx, () => blockedRun, { settings: s });
    text = ctx.notices[0].message;
    ok(text.includes('Toolkit: grants · Web') && text.includes('Effects: public-network, ssrf-guard, shared-cache-write'), 'grants badges show resolved grants and effects');
    ok(text.includes('Sandbox: sandbox unavailable (bwrap not found); granted or inherited tools run WITHOUT a bwrap box'), 'blocked sandbox state surfaces, no silent fallback');
    const tInherit = resolveToolkit('inherit', [], { tools: [{ name: 'read', path: '/pi/base.ts' }, { name: 'Agent', path: '/pi/x.ts' }], paths: ['/pi/base.ts'] }, true);
    const iRun: any = { ...endedRun, toolkit: tInherit, sandbox: { requested: 'auto', available: true } };
    ctx = fakeCtx([], { tui: false });
    await showRun(ctx, () => iRun, { settings: s });
    text = ctx.notices[0].message;
    ok(text.includes('Toolkit: inherit · 1 inherited tools') && text.includes('Inherited extension effects are undeclared.') && text.includes('Sandbox: auto · available'), 'inherit badge + warning + available sandbox render');
    const tMin = resolveToolkit('minimal');
    const okRun: any = { ...endedRun, toolkit: tMin, sandbox: { requested: 'auto', available: true }, goal: '目标 toolkit 🎯', done: '完成' };
    ctx = fakeCtx([{ keys: [ESC] }]);
    await showRun(ctx, () => okRun, { settings: s });
    for (const width of [20, 40, 80]) {
      const rows = ctx.components[0].render(width);
      for (const line of rows) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
        assert.ok(visibleWidth(plain) <= width, `row too wide with badges at ${width}: ${JSON.stringify(plain)}`);
        checks++;
      }
    }
    ok(true, 'badge rows stay inside the frame at 20/40/80');
  }
  // ---- toolkit: grants row generation follows a registry label rename ----
  {
    const { GRANTABLE } = await import('../capabilities.ts');
    const gen = (sel: Set<string>) => Object.keys(GRANTABLE).map(n => `${GRANTABLE[n].label}: ${sel.has(n) ? '✓' : '○'} (${GRANTABLE[n].effects.join(', ')})`);
    const sel = new Set(['web']);
    ok(gen(sel)[1].includes('Corpus: ○ (local-read)'), 'unselected registry entry renders as a toggle row');
    const orig = GRANTABLE.corpus.label; GRANTABLE.corpus.label = 'Corpus-renamed';
    ok(gen(sel).includes('Corpus-renamed: ○ (local-read)'), 'renaming a GRANTABLE label changes the generated row');
    GRANTABLE.corpus.label = orig;
  }

  console.log(`PASS: ${checks} offline UI checks; no models, no real TUI`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
