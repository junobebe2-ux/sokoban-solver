# Sokoban solver — build notes

Entry: `sokoban-solver-01-run-20261121` — single-file `main.ts` (driver +
push-optimal solver), `package.json` (`{"type":"module"}`), `README.md`,
`LICENSE` (MIT, SPDX line 1). Authored fresh from the prose spec only; no kit
source was read, no internet fetches, no dependencies beyond Node built-ins
(`node:fs`, `node:path`). No clock reads, no randomness — the search is
budgeted by a fixed 250,000-state cap per room, never by time.

## Practice set (kit scorer) — score 1,000,000

| instance | pushes | P* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

Every instance push-optimal. Baseline (plain-astar) scores 200,000 on this set.

## Wall time (whole 5-level run, this machine)

- Practice run 1: 1.16 s; run 2: 1.00 s. Budget is 60 s — ~60x margin.

## Determinism

Two runs on the practice set produce byte-identical `solution.txt` files for
all five instances (`diff -r` clean).

## Fresh sets (kit generator, 3 different random 64-hex seeds) — all 1,000,000

- Set 1: 1,000,000 — pushes 12/14/33/42/62 vs P* 12/14/33/42/62, 0.77 s.
- Set 2: 1,000,000 — pushes 25/17/29/44/63 vs P* 25/17/29/44/63, 0.57 s.
  (i001 P* 25 here is a much harder single room than the practice 13.)
- Set 3: 1,000,000 — pushes 12/16/32/42/56 vs P* 12/16/32/42/56, 0.64 s.

## Cross-check vs the kit's reference solver (run, not read)

`program/generator/subject/solver.mjs` `solveByRooms` was run on all 20
levels (practice + 3 fresh sets). Push counts match this entry exactly on
every level (13/16/29/47/60, 12/14/33/42/62, 25/17/29/44/63, 12/16/32/42/56).

## Edge cases (hand-built levels, replayed independently)

- e1 boxes already on goals: 0 pushes, empty answer, legal + solved, ref 0.
- e2 box on a goal at start: 6 pushes, legal + solved, ref 6.
- e3 player starts on a goal (`+`): 8 pushes, legal + solved, ref 8.
- e4 3-box room: 10 pushes, legal + solved, ref 10.

## Failure handling

- f1 (box stranded in the hallway on a dead square — level does not split,
  unsolvable): the whole-level fallback exhausts and the entry still writes a
  valid empty `solution.txt` instead of crashing or leaving the instance
  unwritten.

## Repo

Total size 19,771 bytes (well under the 1 MiB limit). No binary, no
WebAssembly, no native addon, no imports beyond Node's built-in modules.

## Not verified

- Never run under Node 22 on this machine (only Node 24.22.1 is installed
  here); the code uses only stable features and erasable TypeScript, and it
  runs under Node 24's type stripper, but the harness's Node 22 was not
  available to test against.
- The whole-level fallback was exercised only on a small unsolvable level
  (f1). A large solvable level that does not split into rooms was not tested —
  all 20 generated levels split cleanly, and the scored set is drawn the same
  way, so the fallback should never trigger in grading.
- The 60 s budget is for a 1-CPU / 512 MB harness container; this machine is
  faster, but the run takes ~1 s, so the margin is large.
