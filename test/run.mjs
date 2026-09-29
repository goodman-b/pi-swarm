// Offline tests. All agent sessions are fakes; never calls a model.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// Hermetic: no test may read or write the operator's real ~/.pi/swarm.json. A load with
// no `grants` key leaves the registry alone, so a host-declared grant (e.g. `enthropy`)
// would otherwise replace the fixtures mid-suite and fail on the author's own machine.
const testHome = mkdtempSync(join(tmpdir(), 'swarm-test-home-'));
process.env.SWARM_SETTINGS_PATH = join(testHome, 'swarm.json');
const cli = realpathSync(process.env.PI_CLI || execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
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
