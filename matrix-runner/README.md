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
