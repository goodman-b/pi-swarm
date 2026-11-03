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
// Which Pi SDK these checks run against, best signal first. The `pi` on PATH is usually
// the managed launcher - a sh wrapper outside the package, so createRequire cannot resolve
// deps from it - so the release bin it execs is tried first. Every candidate is validated
// as a real Pi package, because an arbitrary or half-installed tree must not pass for the
// SDK, and the winner is printed: a green run against some other Pi release is not
// coverage, and it cannot say so silently.
const tried = [];
function managedReleaseBin(root) {
  let version;
  try {
    version = readFileSync(join(root, 'current-version'), 'utf8').trim();
  } catch (err) {
    tried.push(`${join(root, 'current-version')}: ${err.code || err.message}`);
    return null;
  }
  const bin = join(root, 'releases', version, 'node_modules', '.bin', 'pi');
  if (!existsSync(bin)) {
    tried.push(`${bin}: missing (half-finished 'pi update', or PI_MANAGED_INSTALL_ROOT points elsewhere)`);
    return null;
  }
  return bin;
}
function usable(candidate) {
  if (!candidate) return null;
  try {
    const cli = realpathSync(candidate);
    const sdk = resolve(dirname(cli), '../..');
    // createRequire needs jiti etc. next to this file, and the suite aliases the SDK to
    // <sdk>/dist/index.js — both hold only inside a real pi-coding-agent package.
    if (existsSync(join(sdk, 'package.json')) && existsSync(join(sdk, 'dist', 'index.js')))
      return { cli, sdk };
    tried.push(`${cli}: not a Pi package (the managed launcher is a shell script — pass the release bin)`);
  } catch (err) {
    tried.push(`${candidate}: ${err.code || err.message}`);
  }
  return null;
}
function piOnPath() {
  try {
    return execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  } catch {
    tried.push('`which pi`: no pi on PATH');
    return null;
  }
}
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const found = usable(process.env.PI_CLI)
  || usable(managedReleaseBin(process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir, 'install')))
  || usable(piOnPath());
if (!found) {
  if (!process.env.PI_CLI) tried.push('PI_CLI (unset)');
  throw new Error(`No Pi SDK to test against. Tried:\n  ${tried.join('\n  ')}\nSet PI_CLI to the pi entry inside the SDK (…/releases/<v>/node_modules/.bin/pi).`);
}
const { cli, sdk } = found;
console.log(`pi SDK ${JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version} — ${cli}`);
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
