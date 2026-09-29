#!/usr/bin/env python3
"""Regression suite for swarm-board.

Every case here corresponds to a defect found while auditing this tool: six peers
coordinating through a board (`peers1`) and six assigned-slice workers (the fan-out
control), 2026-09-16.

Run:  python3 board/test-swarm-board.py   (or: npm test)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

BOARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "swarm-board")
ROOT = tempfile.mkdtemp(prefix="sbtest-")
PASS = FAIL = 0


def run(*args, run_id="t", stdin=None):
    return subprocess.run(
        [sys.executable, BOARD, "--run", run_id] + list(args),
        capture_output=True, text=True, errors="replace",
        input=stdin,
        env={**os.environ, "SWARM_BOARD_ROOT": ROOT},
    )


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s   %s" % (name, detail))


def board_file(run_id):
    return os.path.join(ROOT, run_id, "board.jsonl")


def section(t):
    print("\n== %s" % t)


# --------------------------------------------------------------- malformed input
section("torn / malformed board lines (fan-out: torn-input)")
run("--me", "a", "post", "main", "hello", run_id="junk")
JUNK = ['null', '5', '"hi"', '[]', '[{"kind":"post"}]', '{}', '{"agent":"x"}',
        '{"kind":5}', 'true', '{"kind":"post"', 'not json at all', '',
        '{"kind":"post","ts":"notanumber"}', '\x00\x01binary',
        '{"kind":"post","agent":null}', '{"kind":"post","text":null}']
with open(board_file("junk"), "a", encoding="utf-8", errors="replace") as fh:
    for j in JUNK:
        fh.write(j + "\n")
for verb in (["team"], ["budget"], ["claims"], ["log"], ["--me", "r", "inbox"]):
    r = run(*verb, run_id="junk")
    check("%-22s survives %d junk lines" % (verb[-1], len(JUNK)),
          r.returncode == 0, r.stderr.strip()[-160:])

section("torn tail loses only itself (peers1 scout/DEFECT C)")
run("--me", "a", "post", "main", "first", run_id="torn")
with open(board_file("torn"), "a") as fh:
    fh.write('{"kind":"post","agent":"ghost","text":"TORN')      # crash mid-write
run("--me", "b", "post", "main", "second", run_id="torn")
out = run("log", "--tail", "50", run_id="torn").stdout
check("record after a torn one survives", "second" in out)
check("torn record itself is dropped", "TORN" not in out)

# --------------------------------------------------------------- claim semantics
section("claim de-confliction (peers1 + fan-out claim-atomicity)")
run("--me", "w1", "claim", "auth-layer", run_id="c")
check("exact duplicate denied", run("--me", "w2", "claim", "auth-layer", run_id="c").returncode == 3)
check("case variant denied", run("--me", "w2", "claim", "Auth-Layer", run_id="c").returncode == 3)
check("upper variant denied", run("--me", "w2", "claim", "AUTH-LAYER", run_id="c").returncode == 3)
run("--me", "w1", "claim", "a b", run_id="c")
check("distinct slice 'a_b' NOT blocked by 'a b'",
      run("--me", "w2", "claim", "a_b", run_id="c").returncode == 0)
# fan-out arg-safety/#8 exact repro: three distinct slices, three locks
run("--me", "alice", "claim", "a/b", run_id="inj8")
check("'a_b' not blocked by 'a/b'", run("--me", "m", "claim", "a_b", run_id="inj8").returncode == 0)
check("'a.b' not blocked either", run("--me", "m", "claim", "a.b", run_id="inj8").returncode == 0)
check("three distinct slices -> three locks",
      len(os.listdir(os.path.join(ROOT, "inj8", "claims"))) == 3)
run("--me", "u", "claim", "OS", run_id="inj8")
check("fullwidth 'OS' is a distinct slice",
      run("--me", "u", "claim", "\uff2f\uff33", run_id="inj8").returncode == 0)

check("owner re-claim is idempotent",
      run("--me", "w1", "claim", "auth-layer", run_id="c").returncode == 0)
check("non-owner release refused",
      run("--me", "w2", "release", "auth-layer", run_id="c").returncode == 3)
check("release of never-held slice refused",
      run("--me", "w2", "release", "no-such-slice", run_id="c").returncode == 3)
check("phantom release not logged",
      "no-such-slice" not in run("log", "--tail", "99", run_id="c").stdout)
check("owner release succeeds",
      run("--me", "w1", "release", "auth-layer", run_id="c").returncode == 0)
lock_dir = os.path.join(ROOT, "c", "claims")
modes = {oct(os.stat(os.path.join(lock_dir, f)).st_mode)[-3:] for f in os.listdir(lock_dir)}
check("locks are 0600", modes <= {"600"}, str(modes))

section("stale claims (fan-out claim-atomicity/D9)")
run("--me", "ghost", "claim", "stuck", run_id="reap")
check("blocked while held", run("--me", "live", "claim", "stuck", run_id="reap").returncode == 3)
check("fresh claim spared", "0 reaped" in run("reap", "--older-than", "900", run_id="reap").stdout)
run("reap", "--older-than", "0", run_id="reap")
check("stale claim freed", run("--me", "live", "claim", "stuck", run_id="reap").returncode == 0)
check("reap is logged", "reaped" in run("log", "--tail", "99", run_id="reap").stdout)

section("rescue (harnessprobe 2026-09-09: dead peers hold their slices forever)")
run("--me", "dead", "post", "main", "working", run_id="rescue")
run("--me", "dead", "claim", "slice-a", run_id="rescue")
check("rescue refuses a live peer", run("rescue", "slice-a", run_id="rescue").returncode == 2)
check("live peer's claim survives", "slice-a" in run("claims", run_id="rescue").stdout)
# Fake death: backdate the peer's last event 10 minutes.
bf = board_file("rescue")
lines = open(bf).read().splitlines()
for i, l in enumerate(lines):
    e = json.loads(l)
    if e.get("agent") == "dead":
        e["ts"] = time.time() - 600
        lines[i] = json.dumps(e)
open(bf, "w").write("\n".join(lines) + "\n")
check("dead peer's claim is rescued", run("rescue", "slice-a", run_id="rescue").returncode == 0)
check("rescue is logged with the reason", "rescued from dead" in run("log", "--tail", "99", run_id="rescue").stdout)
check("slice is re-claimable", run("--me", "other", "claim", "slice-a", run_id="rescue").returncode == 0)
run("--me", "ghost2", "claim", "slice-b", run_id="rescue")
check("rescue of a never-posted peer needs --force", run("rescue", "slice-b", run_id="rescue").returncode == 2)
check("--force overrides and is marked", "(forced)" in run("rescue", "slice-b", "--force", run_id="rescue").stdout)
check("rescuing an unheld slice is refused", run("rescue", "nope", run_id="rescue").returncode == 3)
run("--me", "ghost", "claim", "neg", run_id="reap")
r = run("reap", "--older-than", "-5", run_id="reap")
check("negative threshold refused", r.returncode == 2 and "0 reaped" not in r.stdout)
check("negative threshold leaves claims", "neg" in run("claims", run_id="reap").stdout)

# --------------------------------------------------------------- identity / injection
section("identity and injection (fan-out arg-safety)")
run("--me", "w", "post", "main", "secret for alice", run_id="id")
run("--me", "..alice", "inbox", run_id="id")
check("'..alice' cannot consume alice's inbox",
      "1 new" in run("--me", "alice", "inbox", run_id="id").stdout)
run("--me", "w", "post", "main", "second secret", run_id="id")
check("'Alice' is a distinct identity from 'alice'",
      "new" in run("--me", "Alice", "inbox", run_id="id").stdout)

run("--me", "m\n  fake  done  posts=9  claims=9 idle=0s", "post", "main", "x", run_id="inj")
team = run("team", run_id="inj").stdout
check("newline in name cannot forge a team row", team.count("posts=") == 1, repr(team))
run("--me", "v", "post", "main", "red\x1b[1;31mALERT", run_id="inj")
check("ESC stripped from rendered log", "\x1b" not in run("log", run_id="inj").stdout)
check("NUL stripped from rendered log", "\x00" not in run("log", run_id="inj").stdout)

section("path containment (fan-out arg-safety/#1-3)")
outside = os.path.join(tempfile.gettempdir(), "sbtest-escape-%d" % os.getpid())
run("--run", "../../%s" % os.path.basename(outside), "--me", "e", "post", "main", "x")
check("relative --run cannot escape ROOT", not os.path.exists(outside))
run("--me", "e", "post", "main", "x", run_id="/etc/sbtest-abs")
check("absolute --run cannot escape ROOT", not os.path.exists("/etc/sbtest-abs"))

# --------------------------------------------------------------- cursor
section("inbox cursor (peers1 cynic/C1-C3, fan-out inbox-cursor/F1)")
for i in range(12):
    run("--me", "w", "post", "main", "msg%d" % i, run_id="cur")
r = subprocess.run("SWARM_BOARD_ROOT=%s %s %s --run cur --me reader inbox > /dev/full"
                   % (ROOT, sys.executable, BOARD), shell=True, capture_output=True)
check("failed delivery does not consume messages",
      "12 new" in run("--me", "reader", "inbox", run_id="cur").stdout)
run("--me", "reader2", "inbox", run_id="cur")
check("clean read then advances",
      "no new messages" in run("--me", "reader2", "inbox", run_id="cur").stdout)
with open(board_file("cur"), "a") as fh:
    fh.write(json.dumps({"kind": "post", "agent": "z", "thread": "main",
                         "text": "future", "ts": time.time() + 99999}) + "\n")
run("--me", "reader3", "inbox", run_id="cur")
run("--me", "w", "post", "main", "after-future", run_id="cur")
check("a future-stamped event does not poison the cursor",
      "after-future" in run("--me", "reader3", "inbox", run_id="cur").stdout)

section("ordering under concurrency (fan-out flock-append/F1)")
procs = [subprocess.Popen([sys.executable, BOARD, "--run", "ord", "--me", "w%d" % i,
                           "post", "main", "m%d" % i],
                          stdout=subprocess.DEVNULL,
                          env={**os.environ, "SWARM_BOARD_ROOT": ROOT}) for i in range(30)]
[p.wait() for p in procs]
ts = [json.loads(l)["ts"] for l in open(board_file("ord")) if l.strip()]
check("30 concurrent writers, all records intact", len(ts) == 30, "got %d" % len(ts))
check("on-disk order == ts order",
      all(ts[i] >= ts[i - 1] for i in range(1, len(ts))))

section("lock liveness and rotation (fan-out flock-append/F2, F4)")
run("--me", "a", "post", "main", "seed", run_id="lk")
holder = subprocess.Popen(["flock", "-x", os.path.join(ROOT, "lk", "board.lock"), "sleep", "5"])
time.sleep(0.4)
t0 = time.time()
r = subprocess.run([sys.executable, BOARD, "--run", "lk", "--me", "b", "post", "main", "x"],
                   capture_output=True, text=True,
                   env={**os.environ, "SWARM_BOARD_ROOT": ROOT, "SWARM_BOARD_LOCK_TIMEOUT": "2"})
waited = time.time() - t0
holder.wait()
check("wedged holder -> bounded wait, not forever", waited < 4, "waited %.1fs" % waited)
check("wedged holder -> distinct exit code", r.returncode == 4, "rc=%d" % r.returncode)
check("wedged holder -> tells the caller", "locked by another process" in r.stderr)

run("--me", "a", "post", "main", "one", run_id="rot")
os.rename(board_file("rot"), board_file("rot") + ".old")
run("--me", "b", "post", "main", "two", run_id="rot")
check("rotation does not corrupt the live board",
      sum(1 for l in open(board_file("rot")) if l.strip()) == 1)

section("hostile argv (fan-out claim-atomicity/D5-D6)")
check("non-UTF-8 slice name", run("--me", "a", "claim", "q\udcff", run_id="hostile").returncode in (0, 3))
check("non-UTF-8 agent name", run("--me", "b\udcff", "post", "main", "x", run_id="hostile").returncode == 0)
check("non-UTF-8 message", run("--me", "c", "post", "main", "x\udcffy", run_id="hostile").returncode == 0)
check("300-char slice name", run("--me", "d", "claim", "z" * 300, run_id="hostile").returncode in (0, 3))
check("board still readable after hostile input", run("log", run_id="hostile").returncode == 0)
check("empty slice name handled", run("--me", "e", "claim", "", run_id="hostile").returncode in (0, 3))
check("'..' as slice name handled", run("--me", "f", "claim", "..", run_id="hostile").returncode in (0, 3))

section("read paths (fan-out read-paths)")
run("goal", "--set", "G", run_id="rp")
run("--me", "alice", "post", "main", "hi", run_id="rp")
check("--tail 0 prints nothing", run("log", "--tail", "0", run_id="rp").stdout.strip() == "")
check("--tail -5 prints nothing (was: dropped from the front)",
      run("log", "--tail", "-5", run_id="rp").stdout.strip() == "")
run("log", run_id="typo-no-such-run")
check("a read verb does not materialise a typo'd run",
      not os.path.isdir(os.path.join(ROOT, "typo-no-such-run")))
os.makedirs(os.path.join(ROOT, "nots", "claims"), exist_ok=True)
open(os.path.join(ROOT, "nots", "claims", "s.abc"), "w").write('{"agent":"z","slice":"s"}')
check("claim payload with no ts renders 'age?' not a huge number",
      "age?" in run("claims", run_id="nots").stdout,
      run("claims", run_id="nots").stdout.strip())
check("goal does not create a phantom agent", "system" not in run("team", run_id="rp").stdout)
check("reaper is not a roster agent", "reaper" not in run("team", run_id="reap").stdout)

section("read verbs on hostile state (Astra code review F1-F4)")
r = run("claims", run_id="no-such-run-at-all")
check("claims on a nonexistent run says so, not a traceback",
      r.returncode == 0 and "no active claims" in r.stdout, r.stderr[-160:])
os.makedirs(os.path.join(ROOT, "bts", "claims"), exist_ok=True)
open(os.path.join(ROOT, "bts", "claims", "s1.abc"), "w").write(
    '{"kind":"claim","agent":"a","ts":"soon","slice":"s1"}')
r = run("reap", "--older-than", "1", run_id="bts")
check("reap survives a claim with a non-numeric ts", r.returncode == 0, r.stderr[-160:])
check("reap does NOT destroy a claim whose age is unknown",
      os.path.exists(os.path.join(ROOT, "bts", "claims", "s1.abc")))
run("--me", "a", "post", "main", "hi", run_id="bud")
open(os.path.join(ROOT, "bud", "budget.json"), "w").write("[1,2]")
r = run("budget", run_id="bud")
check("budget survives a non-dict budget.json", r.returncode == 0, r.stderr[-160:])
open(os.path.join(ROOT, "bud", "budget.json"), "w").write('{"wall_s":600}')
with open(board_file("bud"), "a") as fh:
    fh.write('{"kind":"post","agent":"z","text":"no ts"}\n')
r = run("budget", run_id="bud")
check("one ts-less record does not fake a 57-year elapsed",
      "OVER WALL-CLOCK BUDGET" not in r.stdout and "17888" not in r.stdout, r.stdout[:160])

section("claims-dir race (found by run html1/smoke1 peers)")
run("goal", "--set", "G", run_id="race")
import threading
_bad = []
def _churn(me):
    for _ in range(15):
        c = run("--me", me, "claim", "s", run_id="race")
        if c.returncode == 0:
            r = run("--me", me, "release", "s", run_id="race")
            if r.returncode != 0:
                _bad.append((me, r.stdout.strip(), r.stderr.strip()))
ts = [threading.Thread(target=_churn, args=("w%d" % i,)) for i in range(6)]
[t.start() for t in ts]; [t.join() for t in ts]
check("an owner never loses its own lock to a concurrent release",
      not _bad, str(_bad[:2]))
check("no claim files leak after concurrent churn",
      [f for f in os.listdir(os.path.join(ROOT, "race", "claims"))
       if not f.endswith(".lock")] == [])
check("claims/releases balance on the board",
      sum(1 for l in open(board_file("race")) if '"kind": "claim"' in l) ==
      sum(1 for l in open(board_file("race")) if '"kind": "release"' in l))

# This package's board suite is self-contained; its own UI is tested separately in test/.

section("evidence preservation (found by peers in run rsi1, 2026-09-16)")
run("--me", "scribe", "post", "findings", "first finding", run_id="evid")
r = run("--me", "scribe", "log", "--tail", "1", run_id="evid")
check("an omitted --me is refused, not posted as 'anon'",
      run("post", "main", "x", run_id="evid").returncode == 2)
check("a read verb still works without --me",
      run("claims", run_id="evid").returncode == 0)
check("a newline renders as a visible boundary, not a glued sentence",
      "\u00b6" in run("--me", "scribe", "post", "main", "a\nb", run_id="evid").stdout
      or "\u00b6" in run("--me", "scribe", "log", "--tail", "1", run_id="evid").stdout)
r = run("--me", "quill", "post", "findings", "--stdin", stdin="keeps `id` and $(whoami)\nsecond\n",
        run_id="evid")
stored = [json.loads(l) for l in open(board_file("evid")) if l.strip()]
last = [e for e in stored if e.get("agent") == "quill"][-1]["text"]
check("--stdin preserves shell metacharacters verbatim",
      "$(whoami)" in last and "`id`" in last, last)
check("--stdin does not leave a trailing separator",
      not last.endswith("\n"), repr(last[-12:]))
check("an empty post fails loudly instead of posting nothing",
      run("--me", "quill", "post", "main", "--stdin", stdin="", run_id="evid").returncode == 2)

# ---------------------------------------------------------------- audit-r2 regressions
section("audit-r2: non-finite ts, phantom runs, name collapse, unknown liveness")

# B3 - MAJOR: a JSON float that is not finite (1e999 -> Infinity) passed the isinstance repair,
# reached time.localtime() and int(time.time() - inf), and because inbox advances its cursor only
# after printing, ONE such line wedged the inbox for the whole run.
poison = '{"kind":"post","agent":"x","thread":"main","text":"poisoned","ts":1e999}\n'
run("--me", "a", "post", "main", "before", run_id="inf")
with open(board_file("inf"), "a") as f:
    f.write(poison)
run("--me", "a", "post", "main", "after", run_id="inf")
r1 = run("--me", "a", "inbox", run_id="inf")
r2 = run("--me", "a", "inbox", run_id="inf")
check("a non-finite ts does not wedge the inbox (first read rc=0)", r1.returncode == 0, r1.stderr[-160:])
check("the run still delivers later messages (second read rc=0)", r2.returncode == 0, r2.stderr[-160:])
check("team survives a non-finite ts", run("team", run_id="inf").returncode == 0)
check("budget survives a non-finite ts", run("budget", run_id="inf").returncode == 0)

# B1 - a typo'd --run must not materialise a board and report "no new messages"
ghost = os.path.join(ROOT, "typo-run-xyz")
r = run("--me", "a", "inbox", run_id="typo-run-xyz")
check("inbox on a nonexistent run fails loudly", r.returncode != 0, r.stdout.strip())
check("inbox does not create a run dir", not os.path.exists(ghost), ghost)

# B4 - budget.json is hand-authored; a string cap must not raise TypeError for every peer
d = os.path.join(ROOT, "bcap"); os.makedirs(os.path.join(d, "claims"), exist_ok=True)
with open(os.path.join(d, "budget.json"), "w") as f:
    f.write('{"wall_s": "3600"}')
r = run("budget", run_id="bcap")
check("a string wall_s in budget.json is ignored, not a crash", r.returncode == 0 and "cap" not in r.stdout, r.stdout[-120:])

# B5 - a truthy non-string agent must not crash the sort in team
run("--me", "a", "post", "main", "ok", run_id="tagent")
with open(board_file("tagent"), "a") as f:
    f.write('{"kind":"post","agent":5,"thread":"main","text":"x","ts":1770000000.5}\n')
check("team survives a non-string agent", run("team", run_id="tagent").returncode == 0)

# B7 - safe_name must not collapse distinct names onto one directory (silent board merge)
# B7 - safe_name(run_id) collapsed "..a", "...a" and "a" onto ONE directory: two runs sharing a
# board, each seeing the other's messages. (ident_key/slice_key already hash; the run dir did not.)
run("--me", "a", "post", "main", "one", run_id="a")
run("--me", "a", "post", "main", "two", run_id="..a")
a_log = run("log", run_id="a").stdout + run("--me", "a", "inbox", "--all", run_id="a").stdout
dot_log = run("log", run_id="..a").stdout + run("--me", "a", "inbox", "--all", run_id="..a").stdout
check("run id '..a' is a separate board from 'a' (no silent merge)",
      "one" in a_log and "two" not in a_log and "two" in dot_log,
      (a_log[-90:], dot_log[-90:]))

# B8 - unknown liveness is not proof of death: rescue must require --force
run("--me", "dead", "claim", "s1", run_id="rcue")
with open(os.path.join(os.path.dirname(board_file("rcue")), "board.jsonl"), "w") as f:
    f.write("")                       # rotated board: nothing proves the holder dead or alive
r = run("--me", "live", "rescue", "s1", run_id="rcue")
check("rescue requires --force when liveness cannot be proven", r.returncode == 2, (r.stdout + r.stderr)[-140:])

# B12 - SWARM_BOARD_LOCK_TIMEOUT must not be able to produce an infinite spin
env_bad = {**os.environ, "SWARM_BOARD_LOCK_TIMEOUT": "nan"}
r = subprocess.run([sys.executable, BOARD, "--run", "b12", "--me", "a", "post", "main", "x"],
                   capture_output=True, text=True, env=env_bad, timeout=30)
check("a NaN lock timeout falls back instead of spinning", r.returncode == 0, r.stderr[-140:])


# rabbit #33 - a CLAIM file (not a board event) with a NaN ts: json.loads accepts NaN, and the
# old guard `ts <= TS_FLOOR` is False for NaN, so the claim was unlinked and then "%d" raised,
# aborting the reap loop having destroyed a lock.
d = os.path.join(ROOT, "cnan"); os.makedirs(os.path.join(d, "claims"), exist_ok=True)
with open(os.path.join(d, "claims", "s1.json"), "w") as f:
    f.write('{"slice":"s1","agent":"x","ts":NaN}')
r = run("reap", "--older-than", "0", run_id="cnan")
check("a NaN claim ts is unknown age: skipped, not reaped-then-fatal",
      r.returncode == 0 and os.path.exists(os.path.join(d, "claims", "s1.json")), (r.stdout + r.stderr)[-140:])

# audit-r3: the third non-finite ts site - cmd_claims read `ts > 0`, True for +Infinity, then
# int(time.time() - inf) raised OverflowError and the whole `claims` verb (protocol step 1) died.
d = os.path.join(ROOT, "cinf"); os.makedirs(os.path.join(d, "claims"), exist_ok=True)
with open(os.path.join(d, "claims", "s1.json"), "w") as f:
    f.write('{"slice":"s1","agent":"x","ts":1e999}')
r = run("claims", run_id="cinf")
check("claims survives an Infinity ts (age unknown, verb alive)",
      r.returncode == 0 and "s1" in r.stdout, (r.stdout + r.stderr)[-120:])

shutil.rmtree(ROOT, ignore_errors=True)
print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
