<!-- SPDX-License-Identifier: Apache-2.0 -->
# Gateway sizing harness

Produces the measurements published in
[`docs/reference-architecture.md` §2](../../../docs/reference-architecture.md#2-sizing-guidance).

```bash
npx tsc -b                                          # the harness runs dist/, not src/
node packages/gateway/bench/run.mjs                 # full run, roughly 3 minutes
node packages/gateway/bench/run.mjs --quick         # smaller sweep, for a smoke test
node packages/gateway/bench/run.mjs --out results.json
```

Flags: `--connections 1,2,4,…` · `--spec-sizes 10,50,…` · `--duration-ms` ·
`--warmup-ms` · `--upstream-delay-ms` · `--out`.

The run prints a markdown table on stdout and progress on stderr, and **exits
non-zero if it could not certify its own numbers** (see *The publish gate*).

---

## Decision: this adds no load-testing dependency

Issue #197 asks explicitly whether to add an out-of-process load generator
(k6 or autocannon). **We did not.** Since that is the kind of choice that should
be visible rather than discovered in a diff, here is the reasoning and what
replaces it.

### k6 is excluded on licence grounds

k6 is **AGPL-3.0** (verified against the registry, not from memory). This
repository's licence gate — `.github/scripts/check-licenses.mjs`, run on every
PR — fails the build on AGPL without an approved entry in
`LICENSE_EXCEPTIONS.md`. Adding k6 would mean either failing that gate or
filing an exception for a development convenience. Neither is warranted here.

This is a hard, checkable exclusion rather than a preference.

### autocannon was a real option, and was declined

autocannon is **MIT**, so the licence gate would pass. It was declined for three
reasons, in descending order of weight:

1. **It solves the half of the problem we did not have.** The deliverable is
   "CPU/memory **per instance** × QPS band". autocannon measures the client
   side; it has no view of the server process at all, so the CPU and RSS figures
   — the actual ask — would still have had to be built here. What it would have
   contributed is latency percentiles and throughput, which are the easy half.
2. **It costs 62 packages.** Measured, not estimated:
   `npm install autocannon --dry-run` reports *added 62 packages*. This
   repository has **two** root devDependencies by deliberate policy. Those 62
   would enter the licence gate, the SBOM and `NOTICE` permanently, in exchange
   for a harness that runs occasionally and by hand.
3. **Its main advantage does not apply at this sample size.** autocannon's
   accuracy argument rests on HDR histograms — which exist to bound *memory*
   when the sample count is unbounded, and pay for that bound with quantisation.
   Our runs are bounded, so the harness keeps every sample and sorts. For these
   sample sizes that is strictly *more* accurate, not a compromise.

### What replaces it

A dependency-free driver (`driver.mjs`), fanned out across processes
(`driver-worker.mjs`), plus **two independent checks that the harness was not
the thing being measured**. The checks are the point: a hand-written load
generator is only worth trusting if it can show it was not the bottleneck.

---

## The publish gate

`run.mjs` refuses to certify a run unless at least one of two independent lines
of evidence holds. If neither does it prints the table, says `INCONCLUSIVE`, and
**exits 1** — because an uncertifiable number reaching a capacity-planning
document is precisely the failure #197 exists to prevent.

### 1. Server-side saturation (primary)

Measured **inside the gateway process**, where the driver cannot reach. The
gateway reports its own `process.cpuUsage()` and `process.memoryUsage.rss()`, so
these are attributable to it by construction and unaffected by whatever else is
running on the machine. A run is saturated when, across at least three
concurrency levels:

- throughput is flat (within 5% of peak), **and**
- the gateway's own CPU is pegged at a plateau (spread ≤ 10%), **and**
- p50 latency keeps rising with concurrency.

That combination is queueing against a fixed service rate, which is what
saturation *is*. A driver-limited run does not look like this: adding
connections would buy throughput and the gateway's CPU would sag rather than
plateau.

**No off-the-shelf load generator can supply this evidence** — it is a
server-side fact, and a client-side tool measures the client by construction.

### 2. Driver headroom (corroborating)

The harness also drives a null server and compares. If it can push many times
more requests per second at nothing-in-particular than it managed against the
gateway, it had capacity to spare.

This bound is deliberately reported as **conservative**: the calibration target
is itself a single-threaded Node server, so the figure is
`min(driver, null server)` and the driver alone may be faster. Isolating it
properly would need several null servers sharing one port, and `reusePort` is
unsupported here (verified: `listen ENOTSUP` on darwin/Node 25). So a *failing*
ratio means "not proven from this side", not "contaminated" — which is exactly
why it is the second opinion and not the gate.

Either ground is sufficient. Requiring both would reject a run whose server was
provably pegged, merely because a conservative bound could not also be cleared.

---

## Method

| Concern | Choice | Why |
|---|---|---|
| Process layout | gateway alone in a forked child; driver and upstream elsewhere | CPU/RSS must be attributable to the instance being sized |
| Load model | closed-loop, N connections in flight | cannot commit coordinated omission — there is no schedule to fall behind |
| Driver | several processes | one Node event loop cannot outrun another by enough to prove anything |
| Percentiles | every sample kept, sorted, nearest-rank | exact at this sample size; see the decision above |
| Warmup | once, unmeasured, before the sweep | a first-run number measures JIT compilation |
| Sweep | one warm gateway for all levels | a production instance is warm; restarting per level would fold compilation into whichever level ran first |
| Upstream | local mock, 0 ms by default | upstream latency is time *awaited*, not CPU — it changes the concurrency needed to saturate, not the cost per call |
| Audit sink | off for the sweep, measured separately | so the headline number states what it includes |
| Spec sizes | synthetic, uniform operations | operation count must be the only variable, or the fitted slope confounds size with schema complexity |
| Build | runs `dist/`, not `src/` | measures the code an operator would deploy |

### What the numbers do and do not transfer

Raw QPS is a property of **this machine**. Do not copy it to another instance
type. Two derived figures travel much better:

- **CPU-ms per call** — a property of the work per request. Divide your core
  budget by it for a first-order capacity estimate.
- **Cores used at saturation** — shows how much of an instance one event loop
  can ever occupy, which is what makes scale-out rather than scale-up the right
  move.

Adjust both by your target's single-core performance relative to the recorded
hardware.

### Known limits

- **One machine, one workload.** Small constant-size responses through a local
  mock upstream. Large or variable payloads shift cost toward JSON handling.
- **Latency is affected by co-location**; CPU and RSS are not (they are read
  from inside the SUT). Treat the latency column as indicative.
- **The memory slope is an average over a stepwise curve** (R² ≈ 0.84), not a
  law. Per-step cost measured between 4.6 and 97 KiB/operation. Do not
  extrapolate beyond the measured range.

---

## Re-measuring

A sizing table with no date and no hardware is barely better than none, so the
harness records the CPU model, core count, RAM, platform, Node version and a
UTC timestamp into every result file, and the published table repeats them.

To refresh: run with `--out`, commit the JSON under `docs/sizing/`, and update
the table and its stated provenance together.

---
*Operum Engineer · [operum.ai](https://operum.ai)*
