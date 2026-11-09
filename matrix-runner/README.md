# Trusted pilot matrix runner

The deployed execution target is Cloudflare Containers only. Docker commands below
are local image-build and validation commands, never submission dispatch targets.
The idle image command is `sleep infinity`; the trusted control plane executes
`python /opt/judge/controller.py` and sends one JSON document to stdin. Stdout is
one JSON document with `checks`. No participant stdout is forwarded to that stream.

`matrices.json` is the single versioned check catalog shared with the dashboard.
Checks have equal weight; security checks are mandatory. Each probe gets fresh
source files and a fresh unprivileged subprocess. The parent imports no submitted
module and independently compares raw function outputs against numeric oracles.
Snapshots accept only ordinary `src/**/*.py` files. No participant installation,
private dataset, organizer solution or hidden test file is included in the image.
The private pilot suites were inspected to establish existing public interfaces;
the published probes use independently authored, synthetic inputs.

This is a deliberately limited acceptance subset: Noyyal content deduplication,
spot conversion and malformed forecast rejection with a valid 13-week Monday
forecast positive control; Rasoi first-order incremental
profit, expected discount cost, opt-out and zero-budget boundaries. It does not
score full forecast quality, model uplift, treasury solvency, API authentication,
all budget combinations, or event-scale throughput. The two scalability sizes
assert every returned value under the same fixed runtime/memory ceiling; they do
not establish an asymptotic complexity claim. Security PASS describes only the
stated domain boundary, separately from runtime isolation.

Each process is UID/GID 65534, with no supplementary groups, no-new-privileges and
an inherited seccomp filter denying sockets, process/thread creation, namespace
changes, mounts, tracing, filesystem mutations and file opens with write/create
flags (including `/dev/shm`). Limits: 12s wall time, 8s CPU, 512MiB virtual address
space, 8MiB per file, 32 descriptors, one process, no core dumps, 1MiB combined
stdout/stderr. Rule, source and scratch directories are root-owned/read-only. Pure function
probes require no writable filesystem; inherited output pipes remain writable. Parent environment is replaced before
exec. Per-probe setup failures are UNVERIFIED; a workload that reached the adapter
and failed/timed out is FAIL. The fixed adapter marker means workload startup,
not an assertion that a particular participant function was reached.

Cloudflare must additionally disable internet, isolate credentials, bound the
container filesystem/memory and destroy the instance after each attempt. Local
validation uses a read-only root filesystem, a 128MiB `/work` tmpfs, no network,
64 container PIDs and 768MiB container memory. Runtime isolation is only verified
for the platform where canaries actually ran; image build success alone is not
isolation proof. Cloudflare platform verification must precede real scoring.

```sh
python3 -m unittest discover -s matrix-runner/tests -v
docker --context default build -t doomforge-matrix:test matrix-runner
MATRIX_IMAGE=doomforge-matrix:test python3 -m unittest discover -s matrix-runner/tests -v
python3 matrix-runner/tests/canaries.py noyyal-treasury
python3 matrix-runner/tests/canaries.py rasoi-offer-roulette --fail
```

The canaries intentionally implement only this small public matrix surface. A
passing synthetic canary is a transport/judge smoke test, never an evaluation of
a real submission. Dependencies are exact pins, the Python base is digest-pinned,
and `pip check` runs during the build. No runtime package downloads occur.

## Challenge brief checker primitives

`challenge_checks.py` adds pure trusted validators for brief-defined portions
of Veera Footwear and PricingPulse. It returns metric evidence states only and
does not calculate participant marks or import participant code. Its unit
tests use synthetic organizer inputs. The existing controller does not call
these helpers yet, so they do not enable official judging by themselves.

Veera checks exact portfolio row and unique-ID counts, integer post allocations
from one to three, spend under ₹40,00,000 using canonical per-post prices,
platform spend shares no greater than 50%, at least three organizer-classified
regional creators, and exclusion of known adjudicated fake creators. The
validator accepts canonical creator records, the platform catalog, and fake
labels as separate organizer inputs. Missing catalog, cost, regional, platform,
or label evidence yields `UNVERIFIED` for the affected check. It ignores
participant-provided prices and fake labels. A known fake selection remains a
failure even when other labels are missing.

The briefs in `repos/` do not include the 400 canonical creator records, the
80 adjudicated fake labels, platform vocabulary, hidden buyer simulator, fixed
scenarios, or approved buyer-score normalization. Those artifacts and a
versioned, owner-approved scoring configuration are required before Veera
results can be published. The brief defines only 60 marks and leaves 40
unallocated. No marks or ranking are inferred here.

PricingPulse validates supplied-input revenue, profit, margin, discounted
price, post-discount revenue and profit, and post-discount margin. The scenario
must provide post-discount quantity and costs before those outputs can be
checked. Missing assumptions leave the discount checks `UNVERIFIED`. The
organizer must supply the allowed discount range and cost assumptions. Rates
outside zero through one are invalid. When the organizer's maximum is absent,
arithmetic can still be compared, while the rate-range check stays
`UNVERIFIED`. Zero-revenue margins must be represented as JSON `null`. Invalid
and non-finite inputs require an explicit `INVALID_INPUT` response.

PricingPulse's briefs do not provide hidden demand scenarios, an elasticity
convention, reference optima, or approved weights. The arithmetic helpers do
not evaluate demand quality, tier usability, recommendations, or assign scores.
Those inputs and an approved scoring configuration remain required.

The module also exposes Mazhai's published weighted-MAPE, P99 log-error, and
loss-ratio gate-factor formulas without mapping them to marks. Hidden seasonal
data, storm and data-quality fixtures, test labels, and organizer-calibrated
thresholds are still required. Proposed thresholds in the metric brief are not
treated as frozen official scoring rules.

### Local benchmark fixture bundle

`challenge_benchmarks.py` generates a deterministic, versioned JSON fixture
bundle for PricingPulse, Veera Footwear (the supplied Borrowed Audiences brief),
and Mazhai Cover. It includes known-answer arithmetic, synthetic portfolio
constraint cases, and synthetic Mazhai formula cases. Provenance names the
source brief and sections; a SHA-256 digest covers the exact generated cases.

```sh
python3 matrix-runner/challenge_benchmarks.py --challenge all --pretty --verify-repeatability
python3 matrix-runner/challenge_benchmarks.py --challenge pricingpulse --output /tmp/pricingpulse-fixtures.json
python3 -m unittest discover -s matrix-runner/tests -p 'test_challenge_benchmarks.py' -v
```

The bundle is fixture/spec evidence only. It does not import participant code,
claim official score weights, emit marks, or establish a participant's six
category results. All category statuses remain `UNVERIFIED`; formula and
constraint oracle evidence is explicitly scoped to synthetic fixtures.

Run the deterministic checker tests with:

```sh
python3 -m unittest discover -s matrix-runner/tests -p 'test_challenge_checks.py' -v
```
