import { closeSync, openSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { boardOverview, type DisplayRun, type BoardOverview } from './history.ts';
import { GRANTABLE } from './capabilities.ts';
import { peerCounts } from './runtime.ts';
import type { Settings } from './settings.ts';

export const clean = (s: unknown) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\t/g, '    ');
export const oneLine = (s: unknown) => clean(s).replace(/[\n\r\t]+/g, ' · ');
export const TABS = ['Overview', 'Board', 'Peers', 'Report'] as const;
type Tab = typeof TABS[number];
export interface ViewOptions {
  settings?: Settings; initialTab?: Tab; initialPeer?: string;
  cycle?: (delta: number) => void; controls?: () => boolean;
  steer?: (peer: string, message: string) => Promise<void>; cancel?: () => Promise<void>;
}
function fileTail(file: string, limit = 131072): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r'); const size = fstatSync(fd).size, start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start); const n = readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString('utf8');
    return start ? '[Earlier content omitted]\n' + text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function transcript(r: DisplayRun, selected: number): string[] {
  const p = r.peers[selected]; if (!p) return ['No peer selected.'];
  const lines = [oneLine(`${p.name} · ${p.state}`), r.phase === 'legacy board' ? 'Recorded board activity; runtime usage unavailable.' : `${p.turns} turns · ${p.toolCalls} tools · ${p.tokens} tokens`,
    ...(p.error ? [clean(p.error)] : []), `Transcript: ${oneLine(p.transcript ?? '(not available for this board)')}`, ''];
  let source = '';
  try { if (p.transcript && realpathSync(p.transcript).startsWith(realpathSync(r.dir) + sep)) source = fileTail(p.transcript); } catch { /* absent */ }
  if (source.startsWith('[Earlier content omitted]')) lines.push('[Earlier transcript omitted; full history is in the file above.]');
  for (const row of source.split('\n')) {
    try {
      const entry = JSON.parse(row), m = entry.message;
      if (!m || typeof m.role !== 'string') continue;
      lines.push(oneLine(`── ${m.role}${m.toolName ? ' · ' + m.toolName : ''} ──`));
      if (typeof m.content === 'string') lines.push(clean(m.content));
      else for (const c of m.content ?? []) {
        if (c.type === 'text') lines.push(clean(c.text));
        else if (c.type === 'toolCall') {
          const args = JSON.stringify(c.arguments ?? {});
          lines.push(clean(`${c.name}: ${args.slice(0, 2000)}${args.length > 2000 ? '… [truncated]' : ''}`));
        }
      }
    } catch { /* partial JSONL */ }
  }
  if (!source) lines.push(clean(p.text || 'No text recorded yet.'));
  else if (p.state === 'running' && p.text) lines.push('── latest live text ──', clean(p.text));
  return lines;
}
export function frame(lines: string[], width: number, paint = (s: string) => s): string[] {
  if (width < 4) return lines.map(l => truncateToWidth(l, Math.max(0, width)));
  const inner = width - 4;
  return [paint('╭' + '─'.repeat(width - 2) + '╮'),
    ...lines.map(l => { const text = truncateToWidth(l, inner); return paint('│ ') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + paint(' │'); }),
    paint('╰' + '─'.repeat(width - 2) + '╯')];
}
export function toolkitLines(r: DisplayRun): string[] {
  const t = r.toolkit, sb = r.sandbox;
  const out: string[] = [];
  if (!t) out.push('Toolkit: not recorded (run from before toolkits)');
  else if (t.mode === 'grants') {
    out.push(`Toolkit: grants · ${t.grants.map(g => GRANTABLE[g]?.label ?? g).join(', ') || 'none'}`);
    if (t.effects.length) out.push(`Effects: ${t.effects.join(', ')}`);
  } else if (t.mode === 'inherit') {
    out.push(`Toolkit: inherit · ${t.toolNames.length} inherited tools`);
    out.push('Inherited extension effects are undeclared.');
  } else out.push('Toolkit: minimal · read/grep/find/ls only (no shell/network/writes)');
  if (!sb) out.push('Sandbox: not recorded');
  else if (!sb.available && sb.warning) out.push(`Sandbox: ${oneLine(sb.warning)}`);
  else {
    out.push(`Sandbox: ${oneLine(sb.requested)} · available${sb.available && sb.scope ? ` · ${oneLine(sb.scope)}` : ''}`);
    if (sb.warning) out.push(`Sandbox: ${oneLine(sb.warning)}`); // e.g. nested-userns lockdown unavailable
  }
  return out;
}
export function overviewLines(r: DisplayRun, b: BoardOverview): string[] {
  const first = b.events.find(e => e.kind === 'claim' && typeof e.ts === 'number');
  // A legacy board carries no run.json: its roster is what the board events record
  // (the original Math.max(peers, b.roster) fallback that used to live inline here).
  const c = peerCounts(r.peers, r.phase === 'legacy board' ? b.roster : 0);
  // INCOMPLETE only after a terminal run - a live run with queued/running peers must not look failed.
  const terminal = r.phase === 'settled' || r.phase === 'legacy board';
  const incomplete = terminal && c.unfinished + c.failed + c.aborted + c.blocked > 0;
  return [
    `Status: ${oneLine(r.phase)} / ${oneLine(r.state)}${incomplete ? ' · INCOMPLETE' : ''}`,
    `Peers: ${c.done}/${c.total} done · ${c.aborted} aborted · ${c.failed} failed · ${c.blocked} blocked · ${c.unfinished} unfinished`,
    `${b.findings} findings · ${b.collisions} collisions · ${b.claims.length} held claims`,
    ...(first && Number.isFinite(first.ts) ? [`First claim: ${Math.max(0, Math.round((first.ts * 1000 - r.started) / 1000))}s`] : []),
    `Model: ${oneLine(r.model || 'not recorded')} · goal verified: ${r.metGoal === undefined ? 'unknown / pending' : r.metGoal ? 'yes' : 'no'}`,
    ...toolkitLines(r),
    r.phase === 'legacy board' ? 'Usage: not recorded for this board.' : `Tokens: ${r.peers.reduce((n, p) => n + (p.tokens || 0), 0)} · recorded cost: $${r.peers.reduce((n, p) => n + (p.cost || 0), 0).toFixed(4)}`,
    ...(r.error ? ['', oneLine(r.error)] : []), '',
    `Goal: ${oneLine(r.goal || b.goal || '(not seeded yet)')}`,
    ...(r.done ? [`Done when: ${oneLine(r.done)}`] : []), '', 'Held claims',
    ...(b.claims.length ? b.claims.map(c => `  ${oneLine(c.agent)} → ${oneLine(c.slice)}`) : ['  None']),
    '', `Artifacts: ${oneLine(r.dir)}`, ...(r.report ? [`Report: ${oneLine(r.report)}`] : []),
  ];
}
export async function showRun(ctx: ExtensionContext, get: () => DisplayRun, opts: ViewOptions = {}) {
  if (ctx.mode !== 'tui') { ctx.ui.notify(overviewLines(get(), boardOverview(get().dir)).join('\n'), 'info'); return; }
  let tab: Tab = opts.initialTab ?? 'Overview', peer = Math.max(0, get().peers.findIndex(p => p.name === opts.initialPeer));
  if (opts.initialPeer && !get().peers.some(p => p.name === opts.initialPeer)) throw new Error('Unknown peer: ' + opts.initialPeer);
  let offset = 0, inspector = false, filter = 'all', follow = tab === 'Board';
  while (true) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let action: string | undefined;
    try {
      action = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        let b: BoardOverview, report = '', conversation: string[] = [];
        const refresh = () => {
          try {
            const r = get(); b = boardOverview(r.dir); report = fileTail(join(r.dir, 'REPORT.md'));
            if (inspector) conversation = transcript(r, peer);
          } catch { /* board may disappear during refresh; keep last snapshot */ }
          tui.requestRender();
        };
        const dispose = () => { if (timer) { clearInterval(timer); timer = undefined; } };
        refresh(); timer = setInterval(refresh, opts.settings?.refreshMs ?? 2000);
        return {
          dispose, invalidate() {},
          handleInput(key: string) {
            const r = get();
            if (key === 'q' || matchesKey(key, 'escape') || matchesKey(key, 'ctrl+c')) {
              if (inspector) { inspector = false; offset = 0; refresh(); }
              else { dispose(); done(undefined); } return;
            }
            if (matchesKey(key, 'tab') || matchesKey(key, 'shift+tab')) {
              tab = TABS[(TABS.indexOf(tab) + (matchesKey(key, 'tab') ? 1 : TABS.length - 1)) % TABS.length];
              inspector = false; offset = 0; follow = tab === 'Board';
            } else if (key === 'n' || key === 'p') { opts.cycle?.(key === 'n' ? 1 : -1); offset = peer = 0; inspector = false; follow = tab === 'Board'; }
            else if ((matchesKey(key, 'enter') || key === 'c') && tab === 'Peers' && !inspector) { inspector = true; offset = 0; follow = true; }
            else if ((key === 's' || (inspector && matchesKey(key, 'enter'))) && tab === 'Peers' && opts.controls?.() && r.peers[peer]?.state === 'running') { dispose(); done('steer'); return; }
            else if (key === 'x' && opts.controls?.()) { dispose(); done('cancel'); return; }
            else if (key === 'f' && tab === 'Board') { filter = ['all', 'findings', 'claims'][(['all', 'findings', 'claims'].indexOf(filter) + 1) % 3]; offset = 0; follow = true; }
            else if (matchesKey(key, 'up') || matchesKey(key, 'down')) {
              const delta = matchesKey(key, 'down') ? 1 : -1;
              if (tab === 'Peers' && !inspector) peer = Math.max(0, Math.min(r.peers.length - 1, peer + delta));
              else { offset = Math.max(0, offset + delta); follow = false; }
            } else if (matchesKey(key, 'pageDown')) { offset += 10; follow = false; }
            else if (matchesKey(key, 'pageUp')) { offset = Math.max(0, offset - 10); follow = false; }
            else if (matchesKey(key, 'home')) { offset = 0; follow = false; }
            else if (matchesKey(key, 'end')) follow = true;
            refresh();
          },
          render(width: number) {
            if (width < 6) return [];
            if (tui.terminal.rows < 10) return frame(['Swarm · enlarge terminal', 'Esc back'], width);
            const r = get(), inner = Math.max(1, width - 4);
            peer = Math.max(0, Math.min(peer, r.peers.length - 1));
            const active = opts.controls?.() === true;
            let lines: string[];
            if (inspector) lines = conversation;
            else if (tab === 'Overview') lines = overviewLines(r, b);
            else if (tab === 'Board') {
              const ev = b.events.filter(e => filter === 'all' || e.thread === filter || (filter === 'claims' && ['claim', 'release'].includes(e.kind)));
              lines = [`${filter} · last ${Math.min(200, ev.length)} of ${ev.length} events · f changes filter`, ''];
              for (const e of ev.slice(-200)) {
                lines.push(`${oneLine(e.agent ?? 'system')} · ${oneLine(e.thread ?? e.kind)}`,
                  clean(e.text ?? e.reason ?? e.slice ?? e.kind), '');
              }
            } else if (tab === 'Report') lines = report ? clean(report).split('\n') : ['No report yet.', 'The independent harvest writes REPORT.md after peer work.', `Artifacts remain at ${r.dir}`];
            else lines = r.peers.length ? r.peers.map((p, i) => {
              const metrics = r.phase === 'legacy board' ? 'board activity only' : `${p.turns} turns · ${p.toolCalls} tools · ${oneLine(p.lastTool || '—')}`;
              const line = `${i === peer ? '›' : ' '} ${oneLine(p.name).padEnd(12)} ${oneLine(p.state).padEnd(9)} ${metrics}`;
              return truncateToWidth(i === peer ? theme.fg('accent', line) : line, inner);
            }) : ['No peers have started.'];
            const rows = lines.flatMap(l => wrapTextWithAnsi(l, inner));
            const height = Math.max(1, (tui.terminal.rows ?? 30) - 10);
            if (tab === 'Peers' && !inspector) offset = Math.max(0, Math.min(peer - Math.floor(height / 2), rows.length - height));
            if (follow && (tab !== 'Peers' || inspector)) offset = Math.max(0, rows.length - height);
            offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - height)));
            const footer = inspector
              ? '↑↓ PgUp/PgDn scroll · Esc back' + (active && r.peers[peer]?.state === 'running' ? ' · Enter steer' : '')
              : (tab === 'Peers' ? '↑↓ select · Enter inspect' : '↑↓ PgUp/PgDn scroll') + ' · Tab section · Esc back';
            return frame([
              theme.fg('accent', `Swarm · ${oneLine(r.id)} · ${oneLine(r.phase)}/${oneLine(r.state)}`),
              inner < 48 ? theme.fg('accent', `${TABS.indexOf(tab) + 1}/4 [${tab}] · Tab →`)
                : TABS.map(t => t === tab ? theme.fg('accent', `[${t}]`) : theme.fg('muted', ` ${t} `)).join(' '),
              theme.fg('border', '─'.repeat(inner)),
              ...Array.from({ length: height }, (_, i) => rows[offset + i] ?? ''),
              theme.fg('border', '─'.repeat(inner)),
              theme.fg('muted', `${offset + 1}–${Math.min(rows.length, offset + height)} / ${rows.length}${tab === 'Board' ? ` · f ${filter}` : ''}${follow ? ' · following' : ''}${opts.cycle ? ' · n/p run' : ''}${active ? (tab === 'Peers' && r.peers[peer]?.state === 'running' ? ' · s steer' : '') + ' · x cancel' : ' · read-only'}`),
              theme.fg('muted', footer),
            ], width, s => theme.fg('borderAccent', s));
          },
        };
      }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '95%' } });
    } finally { if (timer) clearInterval(timer); }
    if (!action) return;
    try {
      if (action === 'steer' && opts.controls?.()) {
        const p = get().peers[peer];
        const message = await ctx.ui.input(`Steer ${p.name}`);
        if (message?.trim() && opts.controls?.()) await opts.steer?.(p.name, message);
      } else if (action === 'cancel' && opts.controls?.() && await ctx.ui.confirm('Cancel this swarm?', 'Stops this run only. Artifacts survive; applied changes are not rolled back.') && opts.controls?.()) await opts.cancel?.();
    } catch (e: any) { ctx.ui.notify(String(e.message || e), 'error'); }
  }
}
