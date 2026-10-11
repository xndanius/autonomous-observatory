# Cloud operation

Public repository: https://github.com/xndanius/autonomous-observatory

Public site: https://autonomous-observatory-20261011.xndanius.chatgpt.site

The repository clock uses the same claim → environment wait → dispatch pattern
as While You Sleep, with its own identity, state and receipts. The `clock`
environment waits 15 minutes and permits the `main` branch. Waiting holds no
runner. Queue and execution delays are visible in actual timestamps; no catch-up
turns are invented. Start/pause/reset and exact receipt checks are documented in
[CLOUD_CLOCK.md](CLOUD_CLOCK.md).

## Decisions and state

Each tick is one fresh `gpt-6-luna`, low-effort Codex-action run. The brain sees
only an observation artifact: world, allowed actions, metrics, recent decisions,
compact memory and roles. The model job receives no source checkout, Site writer
secret or repository write permission. Its prompt requests no tool calls or
environment previews. It returns one action with reasoned alternatives per
active experiment. A separate trusted publisher reconstructs public checkpoints,
independently validates every decision and computes consequences through the
engine. A single workflow concurrency group spans gate, brain and publisher.

The Site's committed index and individual experiment snapshots are durable
state. Every run loads one exact revision. A declared `timeline_start_turn`
permits the retained twelve-event checkpoint to resume without downloading the
whole immutable archive. Older turns remain available through the history API.
An original gate artifact digest binds publication to its observed revision;
another writer's change rejects the result.

Cloud hourly launches create **new seeded instances of the five existing types**,
not new environment types. Seeded grammar, warehouse fixtures, workshop starting
assets, city water/wear and Life cells are deterministic and different. Every
new instance declares a twelve-decision campaign and a measured goal; completion
of the campaign does not claim that its hypothesis succeeded. Completed instances
remain publicly readable. The five original experiments continue while active.
Genuinely new types require tested engine/viewer code and a source deployment
from the owner session.

## Credentials and estimates

Only GitHub Actions secrets hold `OPENAI_API_KEY` and
`OBSERVATORY_WRITER_TOKEN`. The existing ignored writer file is transferred
through stdin to `gh secret set`; it is never printed, committed or given to a
model. A new OpenAI API key requires Danielius's approval and secure setup.

The deterministic gate reserves $0.10 before a model attempt. Trusted completed
brain-job CLI events supply input, cache and output counters. Standard rates for
`gpt-6-luna`, verified 11 October 2026, are $0.10/M input, $0.01/M cached input,
$0.125/M cache writes and $0.50/M output. [Official pricing](https://developers.openai.com/api/docs/pricing).
These are token estimates, not invoices or an account-level billing limit.
The approximate daily cap is $2 on UTC days. A near-cap day skips future model
calls. Missing usage retains the reservation and blocks further paid attempts
that day instead of counting it as zero. Actual usage is committed **before**
protected publication, so an API outage cannot erase a paid attempt's accounting.
Skipped attempts record no model call and zero model cost.

The present Site schema accepts at most 2,000 experiment identities and 10,000
launch records. Capacity checks stop before paid work and expose the required
owner storage deployment; the runner does not erase old experiments to fit.

## Activation evidence

1. Deploy tested source to the existing public Site and verify write protection.
2. Install approved/reused OpenAI credentials through the secure flow.
3. Record local and public `runner: cloud-validation` ownership. Local begin and
   the saved heartbeat workflow skip before any publication while cloud-owned.
4. Dispatch one owner validation tick, then start the single 15-minute clock.
5. Verify two actual cloud decision runs and one new seeded launch through the
   public API and immutable event archives. Store their exact run URLs, revisions
   and timestamps; a timer release or local test is not cloud execution evidence.
6. Pause `autonomous-observatory-new-idea-hourly` through the native automation
   tool. Retain its paused identity. Publish `runner: github-actions` with the
   actual last/next tick and verified cloud provenance.

No While You Sleep, comic, Atlas or SSE project is changed.
