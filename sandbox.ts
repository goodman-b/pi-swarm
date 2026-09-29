import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/** Pure bubblewrap argv builder. Never shells out itself. No network, ever:
 * `--unshare-all` stays; there is deliberately no `--share-net` path.
 * `gate: true` mounts the merged view READ-ONLY, so a verification command that writes
 * (a build step, a formatter) can neither persist into the promoted tree nor mask the
 * reducer's own diff. */
export function wrap(cmd: string[], o: { cwd: string; lib64?: boolean; lockdown?: boolean; gate?: boolean; upper?: true | { dir: string; work: string } }): string[] {
  const a = ['bwrap', '--unshare-all', '--unshare-user'];
  if (o.lockdown !== false) a.push('--disable-userns'); // nested-userns denial; probed, some builds cannot write the sysctl
  a.push('--new-session', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib');
  if (o.lib64 ?? existsSync('/usr/lib64')) a.push('--symlink', 'usr/lib64', '/lib64');
  for (const p of ['/etc/ssl', '/etc/alternatives', '/etc/ld.so.cache']) a.push('--ro-bind-try', p, p);
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  if (o.upper === undefined) a.push('--ro-bind', o.cwd, o.cwd);
  else if (o.upper === true) a.push('--overlay-src', o.cwd, '--tmp-overlay', o.cwd);
  else if (o.gate) {
    // Two sources, so bwrap 0.12's --ro-overlay can mount (it requires >= 2). ORDER MATTERS:
    // --overlay-src gives the LAST source the HIGHEST priority, so the upper (the reducer's
    // staged changes) must come LAST to shadow the workspace. Reversed, the gate would verify
    // the ORIGINAL tree and pass a broken reducer. Verified against bwrap 0.12.
    // upper.dir is the WHITE-OUT NORMALISED copy (see normaliseWhiteouts), so the gate and
    // promote() see the same deletions.
    a.push('--overlay-src', o.cwd, '--overlay-src', o.upper.dir, '--ro-overlay', o.cwd);
  }
  else {
    a.push('--overlay-src', o.cwd, '--overlay', o.upper.dir, o.upper.work, o.cwd);
  }
  return [...a, '--chdir', o.cwd, '--', ...cmd];
}

export type Exec = (argv: string[], options?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface Preflight { available: boolean; smokeOk: boolean; overlayOk: boolean; lockdown?: boolean; reason?: string; toolsWarning?: string }

const isWhiteoutName = (n: string) => n.startsWith('.wh.') && n !== '.wh..wh..opq';
/** char-dev 0:0 IS the kernel's whiteout; mknod is the only way to make one, and the copy is
 * only ever read through the overlay, never executed. Falls back to a symlink where mknod is
 * unavailable (no privilege) - in that case the gate is conservative, not wrong. */
const makeWhiteout = (at: string) => {
  try { execFileSync('mknod', [at, 'c', '0', '0']); return; } catch { /* fall back */ }
  try { symlinkSync('/dev/null', at); } catch { /* exists */ }
};

/**
 * A view of the staging upper in which every NAME-form whiteout ('.wh.NAME') is replaced by
 * the char-dev 0:0 form the kernel overlay honours. promote() deletes on either form, but the
 * kernel only understands char-dev, so without this the GATE verifies a tree that is about to
 * lose those files: delete a test fixture in the reducer, the gate passes on a file promote()
 * then deletes. char-dev whiteouts - what a real `rm` inside the box leaves - pass through
 * untouched, so this is a no-op for every overlay the reducer can actually produce.
 * Ordinary files are COPIED (not symlinked): the view is mounted as an overlay source and the
 * box cannot follow a symlink that leaves the mount. The caller owns and must rm the result.
 */
export function normaliseWhiteouts(upper: string, into: string): string {
  mkdirSync(into, { recursive: true });
  const walk = (src: string, dst: string) => {
    let names: string[];
    try { names = readdirSync(src); } catch { return; }
    for (const name of names) {
      const s = join(src, name), d = join(dst, name);
      if (name === '.wh..wh..opq') continue;                       // opacity marker: a portable stand-in
      if (isWhiteoutName(name)) {
        const base = name.slice(4);
        // Same refusal as promote(): '', '.' and '..' would name the directory itself.
        if (!base || base === '.' || base === '..' || base.includes(sep)) continue;
        // The whiteout is named for the VICTIM, not for the marker: the kernel hides `base`
        // when the upper holds a char-dev 0:0 with exactly that name. A char-dev still called
        // '.wh.gone' hides nothing - which is why the kernel ignores the name form entirely.
        makeWhiteout(join(dst, base));
        continue;
      }
      let st; try { st = lstatSync(s); } catch { continue; }
      if (st.isDirectory()) { mkdirSync(d, { recursive: true }); walk(s, d); }
      else if (st.isSymbolicLink()) { try { symlinkSync(readlinkSync(s), d); } catch { /* exists */ } }
      else if (st.isCharacterDevice()) { try { symlinkSync(s, d); } catch { /* exists */ } }  // kernel already understands it
      else { try { copyFileSync(s, d); } catch { /* exists */ } }
    }
  };
  walk(upper, into);
  return into;
}

const noUsernsLock = (r: { stderr?: string; stdout?: string }) => /disable-userns|max_user_namespaces/.test(String(r.stderr || r.stdout || ''));

async function smoke(exec: Exec, lockdown: boolean) {
  return exec(wrap(['/bin/true'], { cwd: '/', lockdown }), { timeout: 15000 });
}

// pi resolves its grep helper `rg` from pi's own bin dir before PATH (getBinDir/getToolPath), so
// a host whose PATH lacks rg still has a working grep tool - probing PATH alone would falsely
// reject the bundled binary. Mirror that order: bin dir, then PATH. Inside the box neither exists
// (wrap() mounts /usr and the workspace only), which is how a healthy box can still hide rg.
const TOOL_PROBE = 'for t in rg python3; do [ -x "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/$t" ] || command -v "$t" >/dev/null 2>&1 || echo MISSING:$t; done';
// What a missing tool costs depends on which environment it is missing from: peer tool calls
// (grep/find/ls/read) resolve on the host in EVERY mode; only a staged run routes shell
// commands through the box. Saying "grep will fail" about a box-only gap would be false.
const NOTES: Record<string, { host: string; box: string }> = {
  rg: { host: 'rg unavailable - the grep tool will fail', box: 'rg unavailable to sandboxed shell commands' },
  python3: { host: 'python3 unavailable - the board and xattr helpers need it', box: 'python3 unavailable to sandboxed shell commands' },
};
async function probeTools(exec: Exec, boxed: boolean, lockdown: boolean, cwd: string) {
  // Probe with a real dir as cwd, never '/': wrap() ro-binds its cwd, so cwd:'/' would mount the
  // whole host read-only and hide the very missing mount this probe exists to find. The mounts the
  // probe cares about (which are absent) do not depend on the choice, so callers pass probeRoot.
  const argv = boxed ? wrap(['/bin/sh', '-c', TOOL_PROBE], { cwd, lockdown }) : ['/bin/sh', '-c', TOOL_PROBE];
  let r; try { r = await exec(argv, { timeout: 8000 }); }
  catch { return undefined; }   // probe itself failed: say nothing rather than claim a tool is missing
  const missing = String(r?.stdout ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('MISSING:')).map(l => l.slice(8));
  if (!missing.length) return undefined;
  return `probed ${boxed ? 'inside the bwrap box' : 'on the host (pi bin dir + PATH)'}: ` +
    missing.map(t => (NOTES[t] ?? { host: `${t} unavailable`, box: `${t} unavailable to sandboxed shell commands` })[boxed ? 'box' : 'host']).join(', ');
}

/** Box preflight plus a tool probe in each environment that can actually be used: the host (peer
 * tool calls, every mode) and - only for a staged run, which is the only case where shell commands
 * execute inside the box - the box itself. Only a staged run has a boxed shell, so `boxed` is
 * opt-in: a box-less caller must not probe a box that will never run a command. */
export async function preflight(exec: Exec, probeRoot: string = tmpdir(), boxed = false): Promise<Preflight> {
  const pf = await boxPreflight(exec, probeRoot);
  pf.toolsWarning = [(await probeTools(exec, false, pf.lockdown !== false, probeRoot)),
    ...(boxed && pf.smokeOk ? [await probeTools(exec, true, pf.lockdown !== false, probeRoot)] : [])].filter(Boolean).join('; ') || undefined;
  return pf;
}

/**
 * bwrap preflight through an injectable exec: version, wrapped /bin/true, then a
 * tmp-overlay probe. Overlay is probeable unprivileged only via --tmp-overlay
 * (same kernel userns-overlay path a persistent upper needs); if that is denied
 * we report overlayOk:false with the reason instead of guessing.
 */
async function boxPreflight(exec: Exec, probeRoot: string = tmpdir()): Promise<Preflight> {
  const none: Preflight = { available: false, smokeOk: false, overlayOk: false };
  let v;
  try { v = await exec(['bwrap', '--version'], { timeout: 5000 }); }
  catch (e: any) { const m = String(e?.message || e); return { ...none, reason: e?.code === 'ENOENT' || /ENOENT/.test(m) ? 'bwrap not found on PATH' : `bwrap --version error: ${m.slice(0, 200)}` }; }
  if (v.code !== 0 || !v.stdout.trim()) return { ...none, reason: `bwrap --version failed: ${(v.stderr || v.stdout).slice(0, 200)}` };
  try {
    let t = await smoke(exec, true);
    let lockdown = true;
    if (t.code !== 0 && noUsernsLock(t)) { t = await smoke(exec, false); lockdown = false; }
    if (t.code !== 0) return { available: true, smokeOk: false, overlayOk: false, reason: `sandbox smoke failed: ${(t.stderr || t.stdout).slice(0, 200)}` };
    // Probe where the writer will actually live, not where $TMPDIR happens to be: overlay
    // support (and user.overlay.opaque xattr) is a property of the UPPER FILESYSTEM, so on a
    // host where boardRoot and tmpfs differ, a tmp probe can bless a writer the real fs
    // refuses - and preflight then does not refuse it. audit-r2/C1.
    // Probe the SAME mechanism apply uses: a persistent upper/work pair on real dirs.
    // --tmp-overlay (tmpfs upper) needs kernel userxattr support that a usable persistent
    // overlay may still lack, so probing it gives false negatives.
    let root = '';
    try {
      mkdirSync(probeRoot, { recursive: true });
      root = mkdtempSync(join(probeRoot, 'swarm-probe-'));
      const dir = join(root, 'upper'), work = join(root, 'work'), mnt = join(root, 'mnt');
      mkdirSync(dir); mkdirSync(work); mkdirSync(mnt);   // inside the try: a throw here still cleans up
      // Write through the overlay, do not just run a command in it: a mount that is
        // accepted but read-only exits 0 from /bin/true and would report overlayOk: true.
      const o = await exec(wrap(['/bin/sh', '-c', 'echo swarm-probe > .swarm-probe && cat .swarm-probe'], { cwd: mnt, upper: { dir, work }, lockdown }), { timeout: 15000 });
      if (o.code !== 0) return { available: true, smokeOk: true, lockdown, overlayOk: false, reason: `overlay probe failed: ${(o.stderr || o.stdout).slice(0, 200)}` };
    } catch (e: any) {
      return { available: true, smokeOk: true, lockdown, overlayOk: false, reason: `overlay probe threw: ${String(e?.message || e).slice(0, 200)}` };
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });   // every path, including a mkdir throw
    }
    return { available: true, smokeOk: true, overlayOk: true, lockdown };
  } catch (e: any) {
    return { available: true, smokeOk: false, overlayOk: false, reason: `sandbox smoke threw: ${String(e?.message || e).slice(0, 200)}` };
  }
}
