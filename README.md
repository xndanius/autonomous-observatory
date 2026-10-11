# The Autonomous Observatory

A public gallery of autonomous experiments, each with a permanent address. Fresh Codex reasoning chooses actions from observed state and compact memory; deterministic environments compute consequences. The cloud runner supports a decision tick every 15 minutes and a new seeded experiment each hour. Actual activation, timestamps and runner status are shown on the [public site](https://autonomous-observatory-20261011.xndanius.chatgpt.site).

The cloud code lives in [xndanius/autonomous-observatory](https://github.com/xndanius/autonomous-observatory). It uses GitHub Actions, the official pinned `openai/codex-action`, and a self-dispatching 15-minute environment wait chain. See [cloud setup and operation](docs/CLOUD.md) and [clock provenance](docs/CLOUD_CLOCK.md). The clock starts paused; a checked deployment alone does not establish successful unattended work.

The complete recurring workflow is in `LOOP.txt`. The existing comic, Atlas and workshop sites are separate projects.

## Operation

```sh
node lab.mjs status
node lab.mjs begin
node lab.mjs commit TOKEN .runtime/decisions-TOKEN.json
node publish.mjs
```

`begin` reserves one tick and reports whether the next hourly launch is due. `commit` validates one decision for each active experiment and creates one new experiment when due. Missed ticks do not produce invented catch-up activity. Local state, decisions, reservations, failures and the writer secret are ignored under `.runtime/`. State writes use atomic replacement. Individual decisions have unique IDs and history is immutable.

The public Worker reads R2 state and archived decisions. Its update route requires the `OBSERVATORY_WRITE_TOKEN` runtime secret. Visitors can replay history and run browser-local branches; their actions do not change the autonomous experiments. Published state omits private language-oracle information.

R2 stores a compact publication index and immutable, content-addressed experiment
states. The gallery requests `/api/index`, then only its selected experiment at
`/api/experiments/ID/state?revision=N`. The protected publisher stages changed
worlds independently, advances the shared index conditionally, and verifies each
committed world. Earlier decision archives remain intact. `/api/state` and
`/api/history?revision=N` assemble exact full records for compatibility, including
revisions stored before the split-storage migration.

The Flood Commons city is a simplified, deterministic flood simulation. A planner,
residents' advocate and budget auditor jointly fund drainage work and household
relief. Rain, upstream overflow, drainage wear and periodic debris determine the
consequences. Water and civic-credit accounts reconcile every turn. Exposure is
counted as household-events, including repeat exposure, rather than unique people.
The city starts with zero recorded harm; its initial water and wear are conditions,
not a claim of earlier autonomous activity. Visitors can copy its observed world
into a local branch and compare explicit rain/debris crises and council decisions.

## Verification and deployment

```sh
npm test
bash scripts/build.sh
node scripts/validate-artifact.mjs
node scripts/preview.mjs
```

Source identity is `.openai/hosting.json`; the public origin is in `site.json`. Use the Sites source workflow helper with fresh credentials through hidden stdin, then save and deploy the returned archive and pushed commit. Routine data updates use `publish.mjs` and verify public read-back without deployment.

The website remains available when generation is offline. Once cloud validation succeeds, GitHub runs independently of the Mac and the local heartbeat stays paused. Source deployments for genuinely new environment types still need the owner session. The viewer compares actual timestamps with the expected cadence.

To stop the cloud, fence the public schedule as paused and stop the same clock chain using the documented control procedure. Keep the local heartbeat paused. The original local workflow remains available only before cloud ownership or after an explicit user-requested handoff.
