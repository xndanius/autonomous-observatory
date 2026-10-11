# Observatory cloud clock

The primary clock is the While You Sleep pattern: a short singleton claim, a
GitHub environment wait, then a short deterministic dispatch job. It starts
paused. No model or site writer credential is available to the clock.

Before starting, configure the public repository's `clock` environment with a
15-minute wait timer, no required reviewers, and a selected branch rule for
`main`. The workflow references that environment with `deployment: false`.
Environment waiting does not hold a runner. Runner and queue delays mean
`nextTickAt` is an earliest estimate.

An owner dispatch of `clock.yml` with `command=start` and all chain inputs empty
arms one chain. Successors use `command=continue` with the exact chain identity,
parent run ID/attempt and generation. Duplicate starts, retained-input reruns,
superseded runs and mismatched receipts stop before waiting or dispatching.

`data/cloud-clock/state.json` is tracked durable state. Tick receipts are
immutable files in `data/cloud-clock/ticks/clock-RUNID-ATTEMPT.json`. The clock
commits a `ticking` checkpoint before requesting either external dispatch. It
requires the exact returned run ID and canonical URLs from GitHub API version
`2026-03-10`; it never polls for the newest run. The final receipt authorizes one
`tick.yml` run and one next clock run. The child gate must read current `main`
under job concurrency group `observatory-record`, then call `verifyClockChild`
before any model or publishing access. The `tick.yml` workflow uses
`observatory-writer` concurrency across its complete gate/model/publish sequence.
Its publishing commit also uses `observatory-record`.

The decision inputs are `source_clock_run_id`, `source_clock_run_attempt`,
`source_clock_chain_id` and `source_clock_generation`. Map them to
`SOURCE_CLOCK_RUN_ID`, `SOURCE_CLOCK_RUN_ATTEMPT`, `SOURCE_CLOCK_CHAIN_ID` and
`SOURCE_CLOCK_GENERATION`. Empty markers identify a separate manual validation
run; `verifyClockChild` returns no clock authority for it. The child workflow
must independently require the owner for those manual runs.

To pause, the owner dispatches `clock.yml` with `command=pause` and empty chain
inputs. Control commands share the singleton workflow queue, so a current clock
run finishes before the pause command applies. The committed paused state
prevents queued successors from claiming or ticking. A direct owner commit of
`armed=false`, `phase=paused`, `nextTickAt=null` also stops the next tick after it
reloads state. Queued decision gates also require the latest state to remain
armed with the receipt's chain identity; pause/reset fences those decisions
before model access. A decision that already passed its gate can finish. For an
immediate public writer pause, commit the clock fence and the public writer's
paused schedule before cancelling active runs; the publisher must honor that
paused schedule independently.

The clock deliberately does not infer recovery after an uncertain HTTP result.
A failed dispatch leaves `phase=stalled`; a crash can leave `phase=ticking`.
Rerunning cannot repeat its external requests. Inspect the exact run and receipt,
then dispatch `command=reset` with empty chain inputs as the owner. Reset clears
the authorized lease and leaves it paused. Dispatch `command=start` separately
to resume. If an old run is still active and blocking the queue, cancel that exact
run in GitHub first. There is no automatic stale-chain restart or cron dependence.

`cloudClockStatus` returns armed state, phase, chain/generation, last tick,
next earliest tick and links to the clock, last tick and last decision run.
Show a stalled or paused clock plainly; a successful timer release alone does
not establish that an Observatory decision or hourly launch was published.

Validation: `node --test tests/cloud-clock.test.mjs`.
