# Changelog

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
