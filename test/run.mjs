// Offline tests. All agent sessions are fakes; never calls a model.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// Hermetic: no test may read or write the operator's real ~/.pi/swarm.json. A load with
// no `grants` key leaves the registry alone, so a host-declared grant (e.g. `enthropy`)
// would otherwise replace the fixtures mid-suite and fail on the author's own machine.
const testHome = mkdtempSync(join(tmpdir(), 'swarm-test-home-'));
process.env.SWARM_SETTINGS_PATH = join(testHome, 'swarm.json');
// The `pi` on PATH is usually the managed launcher: a sh wrapper createRequire cannot
// resolve deps from, because it sits outside the package. Prefer the release bin it execs.
function resolvePiCli() {
  if (process.env.PI_CLI) return process.env.PI_CLI;
  const root = process.env.PI_MANAGED_INSTALL_ROOT
    || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'install');
  try {
    const bin = join(root, 'releases', readFileSync(join(root, 'current-version'), 'utf8').trim(),
      'node_modules', '.bin', 'pi');
    if (existsSync(bin)) return bin;
  } catch { /* no managed install on this host: fall back to PATH */ }
  return execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
}
const cli = realpathSync(resolvePiCli());
const sdk = resolve(dirname(cli), '../..');
const req = createRequire(cli);
const { createJiti } = req('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': resolve(sdk, 'dist/index.js'),
  '@earendil-works/pi-tui': req.resolve('@earendil-works/pi-tui'),
  typebox: req.resolve('typebox'),
}, moduleCache: false });
try {
  await jiti.import('./checks.ts');
  await jiti.import('./ui.ts');
} finally { rmSync(testHome, { recursive: true, force: true }); }
