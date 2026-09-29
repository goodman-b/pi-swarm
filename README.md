# Pi swarm

Board-coordinated peer swarm for [Pi](https://pi.dev). You give a goal and a
measurable definition of done; peers claim their own slices of the work on a
shared append-only board; a separate harvest session that never participated
re-derives the findings and writes the report. No daemon, no profiles, no
workflow dependency — just the public Pi SDK and Python 3.

## What this is

Most "multi-agent" tools are a dispatcher: you write the work items, it hands
each one to a worker, it collects the results. A swarm inverts that — nobody
assigns work. Peers are ephemeral equals with the same tools and
instructions: they read the board, announce and claim slices, attack each
other's claims with evidence, and post findings as they go. `slices` is
candidate vocabulary and a hint, not an assignment. The board is the only
shared state (append-only), and the **harvest** is an independent check, not
a consensus: a session that never participated re-derives findings from
source and rules on whether the goal was met. A cancelled run is not a lost
run — board, lane reports and transcripts survive on disk.

## Quickstart

```bash
pi install npm:@goodman-b/pi-swarm
```

Alternatively: `pi install git:github.com/goodman-b/pi-swarm` or
`pi install ./pi-swarm` for a local checkout.

Requires Pi, Node ≥ 22.19 and Python 3 on POSIX. The optional writer also
requires Linux with working `bwrap` overlay support.

Then `/reload` in an idle Pi session, open `/swarm new`, and fill in the
form below. Fresh defaults are 4 read-only peers, the session's model and a
one-hour deadline per phase; existing settings may override them:

```
/swarm new
  goal:   "Review this repository's TypeScript sources for correctness problems."
  done:   "Every finding in REPORT.md cites file:line plus a code excerpt
           re-verified from source, and at least one checked-and-clean area
           is named."
```

Watch it on the dashboard, then read `REPORT.md`. **Write a measurable done,
not a quota** — "every finding cites file:line and I re-read it" is good;
"find 10 bugs" is not. A default run is **source inspection only** (no shell,
no network). Do not require peers to run `npm test`: they cannot execute
shell commands. The optional writer's verification gate is a separate step.

### What you watch, and what it costs

From `/swarm`, select the current run to open its live dashboard:
**Overview / Board / Peers / Report** tabs
(Tab switches; `f` filters the board; `Enter`/`c` opens a peer's live
transcript; `s` steers a running peer; `x` cancels). Durable artifacts:
`board.jsonl` (full event log), `lanes/*.md` (one report per peer),
`REPORT.md` (harvest summary — or, without a harvest, a deterministic digest
that never claims the goal was met), and full SDK transcripts.

**A swarm runs multiple model sessions:** peers work concurrently up to
`maxConcurrent`, followed by a separate harvest. Cost depends on peer count,
turns and context size. Measured locally, a 4-peer
audit of a ~1,800-line package: **260k–460k tokens**, 20–40 minutes,
per-peer spread 43k–130k — these are observations, not guarantees. Start
with 4 peers; adding peers increases cost without guaranteeing better coverage.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `swarm_start({goal, done, agents?, model?, effort?, runId?, toolkit?, tools?, apply?, reduceGate?, slices?})` | Start a run in the background. Read-only unless `apply: true` adds one staged writer. Only use on an explicit swarm request. |
| `swarm_status({runId?})` | Progress and transcript/artifact paths. |
| `swarm_steer({peer, message})` | Live correction; peer names include `harvest` and `reduce`. |
| `swarm_cancel({})` | Stop the current run. Artifacts survive. |
| `/swarm` | Home menu: current/latest run, new swarm, runs, settings. |
| `/swarm new` | Editable launch form: goal/DoD, peers, model, effort, toolkit, grants, candidate slices, **writer toggle and gate field**. Confirmation renders the resolved toolkit (grants + effects + excluded) before the first peer starts. |
| `/swarm <run>` or `/swarm status [run]` | Bordered live dashboard. |
| `/swarm board` · `/swarm peek peer-1` | Board tab / select a peer. |
| `/swarm runs` · `/swarm all` | Session history; other sessions too. |
| `/swarm settings` · `/swarm cancel` | Validated settings / confirmed stop. |

`swarm_start`'s tool description carries the usage rules: peers choose the work; measurable DoD; read-only means source inspection; no delegated subagents or role profiles in place of a swarm.

## Toolkits

`toolkit` (arg or `defaultToolkit` setting) resolves the peer tool set:

- **`minimal` (default).** `read`, `grep`, `find`, `ls` plus `swarm_board` —
  no shell, no network, no general writes (only scoped board events and
  that peer's lane artifact), enforced by the tool list the runtime hands
  the SDK, not by a prompt asking peers to behave.
- **`grants`.** Adds the named capabilities from your `grants` setting
  (§ Grants); the registry ships empty, every capability is declared data.
- **`inherit`.** The parent session's tool set minus delegation/board tools,
  with shell class **dropped** (listed under `excluded` in the launch preview)
  — an interactive parent has `bash`, so refusing would make inherit
  unusable. A *named* shell-class grant still fails the launch, because that
  one is deliberate. Unresolvable toolkits fail with a named error; no silent
  fallback.

Granted/inherited tools are **trusted host-process tools** running in the
parent Node process. The exclusion lists (shell: `bash`/`write`/`edit`;
delegation/run-control: `Agent`, `swarm_start`, …) match **names**, not
effects — hooks, process-global state and internal shell calls are not
guaranteed away ("Inherited extension effects are undeclared.").

In a writer (reduce) session, `read` shows the staged overlay view, but
`grep`, `find` and `ls` show the **original** tree — use `read` or `cat` to
see staged state.

## Budgets

- `peerMaxTurns` (80) stops one peer spinning on its own slice — blind to
  queueing and turn cost.
- `wallSeconds` (3600) is a **per-phase** deadline — peer, harvest and reduce
  each get a fresh budget. Reaching the peer deadline stops peers but lets
  harvest run. If harvest cannot finish, a deterministic board digest remains.
  Local turns cost ~20–45 s, so size it for the queue: `peers / maxConcurrent`
  waves × expected turns × per-turn latency.
- `runTokenCap` (1,000,000) is a **stop trigger on aggregate peer usage**,
  checked at message boundaries — **not a hard whole-run cap**: harvest and
  writer spend is extra, and in-flight work can overshoot the threshold. A
  cut-short run settles `aborted` and names the unfinished peers, without
  reporting a verified goal as unmet.
- Budgets are re-read at the start of each run (a `~/.pi/swarm.json` edit
  needs no `/reload`); `run.json` records the limits actually in force.

## The writer and its safety boundary

The writer is optional and needs **explicit authorization**: `apply: true` **and** a
`reduceGate` command, honoured only when the independent harvest verified the
goal — otherwise `apply` is skipped with a stated reason. Peers never get
the built-in `bash` tool; the writer session (called **reduce** in run
records) gets a sandboxed shell. Extension tools remain outside that sandbox.

`bwrap` with `--unshare-all` — network unshared, and deliberately **no**
`--share-net` path in the code — plus read-only `/usr`, fresh
`/proc`/`/dev`/`tmpfs /tmp`, the workspace as an overlay with writes going to
a staging upper dir, `--disable-userns` where the kernel allows (else weaker,
said in the run record), `--new-session --die-with-parent`. No host `/home` is
bound in: the blast radius is the workspace. `apply: true` with no working
`bwrap` is **refused**, not downgraded. `sandbox: "off"` likewise refuses
`apply`; it does **not** change extension isolation — granted/inherited tools
run in-process anyway, outside any box.

### What the box does not protect against

- **Extension tools run host-side**: a peer cannot *call* `bash`, but a
  granted extension hook that shells out does so unsandboxed.
- **Peer reads are not filesystem-confidentiality sandboxed:** they run
  with the host user's read access. The writer's shell sees the mounted
  workspace and system paths; secrets in the workspace remain readable.
- **Promotion is per-file, not atomic.** Staging → read-only gate →
  `promote()` copies the diff in file by file; a failure mid-promote can leave
  the workspace **partially changed** — staging kept for inspection, no
  rollback.
- **The gate sees a read-only workspace.** Commands that write build outputs
  *inside the workspace* fail there; point output at `/tmp` (a fresh tmpfs in
  the box) where suitable. No blanket guarantee that any command — `npm test`
  included — passes in the gate.
- A grant's process-global state (a fetch cache) is shared across sessions in
  this process.
- **Release status:** the apply/reduce/gate/promote path is unit-tested only;
  a live apply run promoting to a workspace is not yet on record.

## Settings

`~/.pi/swarm.json` (editable via `/swarm settings`; `grants` is JSON-only,
§ Grants). Unknown/invalid fields drop to defaults; a broken `grants` block
drops only itself; an unreadable file runs on in-memory defaults and **refuses
to save** until fixed. `SWARM_SETTINGS_PATH` overrides the path.

| Key | Default |
|---|---|
| `defaultAgents` / `maxAgents` | 4 / 16 — roster size vs. per-launch ceiling; no fixed 16 limit, accepted up to the roster's structural array-length maximum (2^32−1) |
| `defaultModel` / `defaultEffort` | *(the calling session's model)* / low |
| `peerMaxTurns` / `harvestMaxTurns` / `reduceMaxTurns` / `graceTurns` | 80 / 30 / 30 / 3 |
| `maxConcurrent` | 8 — peer sessions prompting at once; the rest queue |
| `wallSeconds` | 3600 — per-phase deadline (§ Budgets) |
| `runTokenCap` | 1000000 — aggregate peer-usage stop trigger (0 = off); harvest/writer spend excluded, in-flight turns may overshoot |
| `boardRoot` | `~/.pi/swarm-boards` |
| `widget` / `notifyOnSettle` | true / true |
| `refreshMs` | 2000 |
| `defaultToolkit` | `minimal` (`grants` or `inherit` also allowed) |
| `defaultTools` | `[]` (grant names, validated against your `grants` registry; an unknown name refuses the whole list) |
| `grants` | `{}` — the grant registry. **Fail closed:** an absent, null or unparseable block resets it, so a revoked grant cannot survive into a later run |
| `sandbox` | `auto` (`off` refuses `apply`; granted/inherited tools run unboxed either way, with a warning) |

`defaultAgents` is the default roster; `maxAgents` is the operator's per-run
ceiling; `maxConcurrent` limits simultaneous peer prompts. There is no fixed
16-peer limit: roster settings accept integers ≥ 2 up to the structural array
length maximum (2^32−1, the largest JS array the peer roster can be); the
operator must keep counts practical — the roster is allocated upfront, so huge
values are a memory cost, not a scalability guarantee. Concurrency settings
accept safe integers ≥ 1; queueing is a limit on parallel prompts, not a memory
bound. Tune these to your provider's rate limits, latency, context size and
budget, and size `wallSeconds` for queued peers.

All run paths are `<boardRoot>/<operator-session>/<run>/`. `run.json` is
authoritative runtime state.

### Model

**explicit `model` arg → `defaultModel` setting → the calling session's
model**; all phases use that one resolved model, and an unresolvable or
unauthenticated name fails launch validation, never a silent fallback.

### Grants

A grant is a named capability — an extension file path plus the tool names it
exposes — declared in settings. The registry **ships empty** (a package must
not guess where another package got installed); delegation/run-control tools
cannot be exposed by name; shell-class names are refused on a read-only run;
existence is checked at launch; `null` removes an entry; names match
`^[a-z][a-z0-9_-]{0,31}$`, `path` absolute, `tools` non-empty:

```json
{ "grants": { "web": { "path": "/home/me/somewhere/web-extension/index.ts",
                       "tools": ["web_search", "fetch_content"],
                       "effects": ["public-network"], "label": "Web" } } }
```

`effects` is declarative: stated to the peers, not an enforcement mechanism.

## Requirements and tests

Node ≥ 22.19, Python 3 on PATH (the board binary is invoked with argv, never
through a shell), `bwrap` only for `apply: true`. Developed and tested against
Pi 0.87.1; `toolkit: "inherit"` additionally needs a Pi build exposing
`getAllTools()`/`getCommands()`, else a named launch error.

`npm test` — no network, no model calls; the runner finds the Pi SDK via
`pi` on PATH (`PI_CLI=/path/to/pi npm test` otherwise). Fake sessions plus
the real Pi resource loader and the bundled Python board; covers registration,
settings, scoped tools, protocol failures, turn/wall caps, cancellation
including mid-create, steering, claim cleanup, reduce and gate failure, plus
UI checks (navigation, launch confirmation, validation, history, guarded
actions); grants use in-repo fixtures, so the suite runs without the
author's extensions installed. A **live model smoke** — a bounded swarm
against a real model (peers claim work, harvest settles, effects stay `[]`
on a read-only run) — is the real proof of the SDK integration, separate
from `npm test`.

Usage/cost is recorded in `run.json`, **not merged into Pi's `/cost`**;
compaction overhead may be missing. There is one active run per extension
instance, no cross-process admission control, and no automatic whole-peer
retry. For write and extension risks, see [the safety boundary](#the-writer-and-its-safety-boundary).

## Credits

Built on Pi's public SDK. The following are design influences, not dependencies:

- **`@tintinweb/pi-subagents`** — the swarm's first working form ran on top of it; none of its code is in this package.
- **[tcclaviger (Rob)](https://blog.robai.net/vllmdocs/)** — suggested using bubblewrap (`bwrap`) for the writer sandbox.
- Blackboard architecture for LLM agent teams: arXiv [2507.01701](https://arxiv.org/abs/2507.01701), [2510.01285](https://arxiv.org/abs/2510.01285).
- *Why Do Multi-Agent LLM Systems Fail?* (MAST), arXiv [2503.13657](https://arxiv.org/abs/2503.13657) — the failure taxonomy behind the `done`/`blocked` protocol and the independent harvest.
- Cognition, [*Don't Build Multi-Agents*](https://cognition.ai/blog/dont-build-multi-agents) — peers exchange artifacts and traces, not conversation.
- IndyDevDan's [*Astra Swarm*](https://www.youtube.com/watch?v=S2sjyokoxeE) — the original spark; unrelated to this implementation.
