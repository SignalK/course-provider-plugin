# Course Provider — benchmarks

Tinybench-based microbenchmarks for the in-process delta dispatcher.
The `worker_threads.Worker` is mocked so we measure the dispatcher in
`src/index.ts` (subscribe callback → `srcPaths` update → mock
`postMessage`) plus the `lib/delta-msg` and `lib/alarms` helpers it
touches. The actual geodesy maths runs on the worker thread in
production and is benchmarked separately if needed; the in-flight
`perf/*` PRs all target the in-process side.

## Run

```sh
npm run bench
```

CLI table with ops/s, mean (µs), p99 (µs), sample count.

## What's measured

Per scenario:

| column               | meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ops/s`              | Throughput (mean).                                                                                                                     |
| `mean (µs)`          | Mean wall time per op.                                                                                                                 |
| `p99 (µs)`           | 99th-percentile per-op latency.                                                                                                        |
| `±rme (%)`           | Relative margin of error on the mean. Smaller is better; treat any `Δmean (%)` smaller than `rme(baseline) + rme(candidate)` as noise. |
| `retained B/op`      | Heap retained per op, measured between forced GCs at both ends of the bench window. Approximates BenchmarkDotNet's `Allocated` column. |
| `GC count` / `GC ms` | Number of GC events Node ran during the bench window and total time spent in GC. From `perf_hooks` GC entries.                         |
| `samples`            | How many measured iterations tinybench took.                                                                                           |

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

| Scenario                                    | What it measures                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `position update (debug off, prod default)` | The hot path. Single position delta, debug disabled — what production looks like.                                         |
| `position update (debug ENABLED)`           | Same delta, debug enabled. Highlights `server.debug(...)` cost (target of the `perf/debug-gate` PR).                      |
| `mixed delta (4 values, debug off)`         | Realistic GPS source emit: position + heading + SOG + COG in one delta. Exercises the per-value branch in the dispatcher. |
| `mixed delta (4 values, debug ENABLED)`     | Same, debug on.                                                                                                           |
| `10-update burst in single callback`        | One callback dispatches 10 position updates (large batch). Stresses the inner loop without the outer dispatcher overhead. |

## Adding a scenario

Add an entry to the `scenarios` array in `bench/run.ts`. Each scenario
returns `{ run, teardown }`:

- `setup()` runs once before measurement starts (fresh harness, build any
  reusable input objects here).
- `run()` is the function tinybench calls in a tight loop. Do **only**
  the work you're measuring; allocate nothing inside the loop.
- `teardown()` runs after the bench completes (calls `plugin.stop()`).

The harness in `bench/harness.ts` exposes `createHarness({debugEnabled})`
plus two delta builders (`positionDelta`, `multiValueDelta`).

## Caveats

- The worker is mocked, so worker-side optimisations (e.g. changes to
  the geodesy code in `src/worker/`) won't show up here.
- Microsecond-level numbers are noisy. Use the JSON capture + compare
  flow rather than eyeballing a single run, and run on the same
  machine (ideally with no other load) for both baseline and
  candidate.
- `samplesCount` differs between runs because tinybench targets a
  fixed wall-clock budget per task (~1.5 s). Faster scenarios get more
  samples.
