# Changelog

## 0.4.4

> Numbering note: 0.4.3 was cut and tagged but never shipped — the npm registry now
> reserves that version (`E409 Cannot publish over previously staged version`, and staging
> answers `Cannot stage previously published version`) while it appears in neither the
> packument nor `npm stage list`. Identical content ships as 0.4.4.

- **SECURITY: the `apply` gate was fail-open in every published release (0.4.0 – 0.4.2).**
  Pi's bash tool *resolves* on a non-zero exit (`isError: true`, text `Command exited with
  code N`) and throws only on timeout. `runGate()` mapped content → text and returned, so
  **every** failing gate read as a pass, and the caller — which treats resolution as success —
  promoted the staged tree over the workspace. That is the exact outcome the gate exists to
  prevent. Fixed by throwing on `isError` so the existing catch discards staging. Pinned by
  `runGate('false')` / `runGate('exit 9')` rejecting; deleting the guard turns the suite red
  with "Missing expected rejection". Read-only runs never reach this path. **If you ran
  `apply: true` on 0.4.2 or earlier, re-check the promoted diff against `gate.txt`.**

- **Budget honesty.** A token-cap stop now names the shortfall (`spent 4.3M of 12.0M cap;
  0.7M per peer across 6`) — "budget reached" alone reads like a misbehaving peer when it is
  an under-sized run. `wallSeconds: 0` now means the wall is off (bounded by turns and the
  token cap), and the range allows it.

- **Tested against the Pi this fleet runs.** CI pinned `pi-coding-agent@0.87.1` while hosts
  run 1.5.0, so a CI green and a local green meant different things. Pinned to 1.5.0, and
  `test/run.mjs` resolves the SDK without `which pi` (a detached job or CI runner has no `pi`
  on PATH; the managed launcher is a shell wrapper outside the package): `PI_CLI` first, then
  the release bin under `PI_MANAGED_INSTALL_ROOT` (default `~/.pi/agent/install`), then `pi`
  on PATH — each rejected unless it sits in a real `pi-coding-agent` package, the winner
  prints `pi SDK <version> — <path>`, and a total miss names every candidate it tried.

- **Pi 1.5.0 argument coercion is pinned, not assumed.** 1.5.0 moved tool-argument validation
  to `@earendil-works/pi-schema` and validates every tool call with `coerce: true`: a loose
  `agents: "4"`, `tools: "read"` or `apply: "true"` is **rewritten** before `execute()` sees
  it. Measured against our registered schema — coercion is type-level only, so `minimum`,
  `enum` and `maxItems` still reject, and `validateLaunch` still refuses the uncoerced slip.
  That is why the launch validators are strict type checks (`Number.isInteger`, `Array.isArray`)
  and stay that way. Checks: 275 + 251 + 91.

- **Changelog surface.** Pi 1.5.0 shows a package's `CHANGELOG.md` on the launch after an
  update, entries matched on the `## X.Y.Z` heading form we use. Only published versions are
  ever rendered — a `## Unreleased` heading resets the entry — so keep release notes under a
  version, and note that `pi.changelogPath` (set to `""` to go silent) is ours to set, not
  yours.

## 0.4.2

- **Tool preflight.** Before any session starts, pi-swarm probes the tools peers depend on in
  the environment that will actually use them: the host (peer `grep`/`find`/`ls`/`read` run
  there in every mode) and, for a staged `apply` run, the sandbox as well. Resolution mirrors
  Pi's own - the agent bin dir before `PATH` - so a bundled `rg` is not falsely rejected.
  Results are warnings on the existing sandbox channel, never a launch blocker.
- **Issue #7 closed:** incomplete peer coverage reporting (0.4.1) plus this preflight.
- **Discoverability.** Broader npm keywords and a search-oriented description; a new publish
  also re-triggers npm's search index, which had not been returning this package.

The sandbox does not mount Pi's bin dir, so a staged gate cannot use `rg` - still open.

## 0.4.1

- **Configurable peer limits.** Operators can raise roster and concurrency limits
  above 16. Defaults remain 4 peers, a 16-peer launch ceiling and 8 concurrent
  prompts. Higher counts are opt-in, not a scalability guarantee.
- **Honest coverage reporting.** Reports, dashboard and completion notifications
  show peer outcome counts and flag incomplete coverage. The harvest verdict
  stays separate from execution status; its prompt requires evidence-scoped
  conclusions and explicit coverage limitations.
- **Verification and maintenance.** Added offline GitHub CI, a release checklist
  and regression checks; replaced a timing-sensitive cancellation test with an
  explicit evidence-ready signal. All 599 offline checks pass; a two-peer local
  source-inspection smoke completed with an independent harvest.

Executable preflight and budget wrap-up remain future work. The optional writer
still has no recorded live apply smoke; existing safety limitations remain.

## 0.4.0 — Initial public release

First public release of pi-swarm. Everything shipped, in one summary:

- **Board-coordinated peers.** Peers self-assign named claims on an
  append-only shared board; no dispatcher, no role profiles, no workflow
  dependency. Deterministic seed, no model call. Live dashboard (board,
  per-peer transcripts, steering), durable artifacts: `board.jsonl`,
  `lanes/*.md`, per-session transcripts.
- **Independent harvest.** A harvest session that never participated
  re-derives the findings from source and writes `REPORT.md`. Agreement among
  peers is not the check; consensus can amplify a shared false belief.
- **Optional staged writer.** Explicit `apply: true` plus a `reduceGate`
  command, honoured only when the harvest verified the goal. One boxed writer
  session under `bwrap` (unshared network, staging overlay), a gate run
  against a read-only view of the staged tree, then per-file promotion into
  the workspace. `apply` is refused without a working bwrap; `sandbox: "off"`
  refuses it too.
- **Toolkits and grants.** `minimal` (default: `read`, `grep`, `find`, `ls`,
  board), `grants` (operator-declared capabilities; registry ships empty),
  `inherit` (parent tool set minus delegation/board tools, shell class
  dropped and listed). Granted/inherited tools are trusted host-process
  tools — name blacklists, not effect guarantees.
- **Settings and budgets.** `~/.pi/swarm.json` with fail-closed grants;
  `peerMaxTurns`, per-phase `wallSeconds`, and `runTokenCap` (an aggregate
  peer-usage stop trigger, not a hard whole-run cap). Budgets re-read each
  run; `run.json` records the limits actually in force.

Known limitations:

- Granted/inherited extension tools run **host-side**, in the parent Node
  process, outside bwrap; blacklisted tool names are the boundary.
- **Promotion is per-file, not atomic.** A failure mid-promote can leave the
  workspace partially changed; staging is kept, nothing is rolled back.
- **No live apply run on record yet.** The apply/reduce/gate/promote path is
  exercised by unit tests only; all recorded runs are report-only.
- Usage/cost is recorded in `run.json`, **not merged into Pi's `/cost`**, and
  compaction overhead may be missing from the totals.
