# Sokoban Solver

A push-optimal Sokoban solver for the make.fun bounty "Build the best Sokoban solver, 21 November 2026". It decomposes each level into rooms, solves every room push-optimally with a breadth-first search over pushes (dead-square and frozen-2x2 pruning), and joins the rooms' solutions with walks through the hallway. The search is fully deterministic: it is budgeted by a fixed cap on states searched, never by the clock, so the same input always produces byte-identical output.

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/junobebe2-ux/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/junobebe2-ux/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

Without the environment variables it reads `/input` and writes `/output`. Each instance gets `<output>/<id>/solution.txt` holding the move string in LURD followed by a newline.

<sub>Entered on [make.fun](https://make.fun/?ref=52m6pxck&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
