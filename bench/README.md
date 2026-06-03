# Course Provider — benchmarks

Mitata-based microbenchmarks for the per-tick delta path. Each scenario
drives synthetic deltas through the plugin's subscribe callback and
measures the full per-tick cost: `srcPaths` update + `parseSKPaths` +
`calcs` + `buildDeltaMsg` + `lib/alarms`.

## Run

```sh
npm run bench
```

CLI table with `avg`, `(min … max)`, `p75` / `p99`, and a per-iter heap row.

## What's measured

Per scenario, mitata prints:

| column        | meaning                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avg`         | Mean wall time per op — the headline number.                                                                                                                                           |
| `(min … max)` | Fastest and slowest single iteration.                                                                                                                                                  |
| `p75` / `p99` | 75th- / 99th-percentile per-op latency.                                                                                                                                                |
| heap row      | Per-iter heap allocation `(min … max) median`, printed when the bench runs with `--expose-gc` (the `npm run bench` script sets it). Approximates BenchmarkDotNet's `Allocated` column. |

## Compare two refs

```sh
git checkout master
npm run bench -- --json bench/results/master.json

git checkout perf/<branch>
npm run bench -- --json bench/results/perf-<branch>.json

node --import tsx bench/compare.ts \
  bench/results/master.json bench/results/perf-<branch>.json
```

`compare.ts` prints a side-by-side delta with a **signal vs. noise**
verdict per row:

```
┌──────────────────────────┬───────────────────┬────────────────────┬────────────┬──────────┬──────────────────┬───────────────┬──────────┐
│ name                     │ baseline mean ns  │ candidate mean ns  │ Δmean (%)  │ Δhz (%)  │ signal?          │ ΔretainedB/op │ ΔGC count│
├──────────────────────────┼───────────────────┼────────────────────┼────────────┼──────────┼──────────────────┼───────────────┼──────────┤
│ position update (debug…) │ 312               │ 240                │ -23.1      │ +30.0    │ YES              │ 0             │ 0        │
└──────────────────────────┴───────────────────┴────────────────────┴────────────┴──────────┴──────────────────┴───────────────┴──────────┘
```

`signal?` reports `YES` when |Δmean| exceeds the combined relative
margin-of-error of both runs; otherwise it shows `noise (±X%)` with
the threshold that would have been needed.

## Scenarios

| Scenario                                    | What it measures                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `position update (debug off, prod default)` | The hot path. Single position delta, debug disabled — what production looks like.                                                          |
| `position update (debug ENABLED)`           | Same delta, debug enabled. Highlights `server.debug(...)` cost (target of the `perf/debug-gate` PR).                                       |
| `mixed delta (4 values, debug off)`         | Realistic GPS source emit: position + heading + SOG + COG in one delta. Exercises the per-value branch in the dispatcher.                  |
| `mixed delta (4 values, debug ENABLED)`     | Same, debug on.                                                                                                                            |
| `10-update burst in single callback`        | One callback dispatches 10 position updates (large batch). Stresses the inner loop without the outer dispatcher overhead.                  |
| `position update with active route`         | Position delta with a multi-waypoint active route primed, so `calcs()` exercises `routeRemaining` and its reference-keyed cache each tick. |

## Adding a scenario

Add an entry to the `scenarios` array in `bench/run.ts`. Each entry is
`{ name, build }`, where `build()` is async and returns `{ run, teardown }`:

- `build()` runs once before measurement starts: create a fresh harness
  and build any reusable input objects here.
- `run()` is the function mitata calls in a tight loop. Do **only** the
  work you're measuring; allocate nothing inside the loop.
- `teardown()` runs after the bench completes (calls `plugin.stop()`).

The harness in `bench/harness.ts` exposes
`createHarness({ debugEnabled, primeCourse, primeRoute })` plus two delta
builders (`positionDelta`, `multiValueDelta`).

## Caveats

- Microsecond-level numbers are noisy. Use the JSON capture + compare
  flow rather than eyeballing a single run, and run on the same
  machine (ideally with no other load) for both baseline and
  candidate.
- `samplesCount` differs between runs because mitata targets a
  fixed wall-clock budget per task. Faster scenarios get more samples.
