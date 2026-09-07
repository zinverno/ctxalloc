# Local and VPS staging

Phase 20 provides a built Node 22 HTTP process and a Docker image definition.
The application has **no authentication**. Bind a bare process to `127.0.0.1`;
publish a container only on host loopback. External access requires an
operator-controlled authenticated proxy or tunnel and firewall rules. Supplying
scope strings is a data-isolation contract, not authorization.

Docker runtime validation in the implementation environment: **NOT_RUN** because
Docker was unavailable. Static image checks and the built localhost process
smoke are separate evidence; neither is reported as a successful container run.

## Prerequisites

Use Linux, Node 22 (`.nvmrc`), Corepack and the pinned `pnpm@10.33.0`, Git, and
Python 3 for the example setup. Docker is required for the container procedure.
Allow outbound access during image/dependency installation. The running API
requires no model credential, model network call, retrieval service, or native
build. Keep the source root and its ancestor directories under operator control;
mount sources read-only. SQLite state needs one writable local filesystem.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check:declarations
pnpm smoke:cli
pnpm smoke:api
pnpm acceptance:mvp
```

`acceptance:mvp` emits a versioned report. A zero exit code means the measurement
completed without an engineering failure; read both acceptance states and all
missing gates before treating it as release evidence. Product target failures
remain visible and do not get hidden by a successful CI job.

## Bare localhost process

The complete public sample files are under [`examples/api`](../examples/api/).
Every server field is explicit. The executable accepts exactly `--config <path>`;
there are no environment fallbacks, default config locations, or parent searches.
Relative database/source paths resolve against the config file's directory.

```sh
mkdir -p .ctxalloc/local/config .ctxalloc/local/sources .ctxalloc/local/state
cp examples/api/sources/handbook.md .ctxalloc/local/sources/handbook.md
cp examples/api/registration.json examples/api/scope.json examples/api/request.json .ctxalloc/local/config/
python3 - <<'PY'
import json
from pathlib import Path
folder = Path('.ctxalloc/local/config')
config = json.loads(Path('examples/api/config.json').read_text())
config['databasePath'] = '../state/ctxalloc.sqlite'
config['sourceRoot'] = '../sources'
(folder / 'ctxalloc-api.json').write_text(json.dumps(config, indent=2))
config.pop('server')
(folder / 'ctxalloc-cli.json').write_text(json.dumps(config, indent=2))
PY
node apps/cli/dist/bin.js source add --config .ctxalloc/local/config/ctxalloc-cli.json --registration .ctxalloc/local/config/registration.json
node apps/cli/dist/bin.js source list --config .ctxalloc/local/config/ctxalloc-cli.json --scope .ctxalloc/local/config/scope.json
node apps/api/dist/bin.js --config .ctxalloc/local/config/ctxalloc-api.json
```

In another terminal, compile and retrieve the persisted trace:

```sh
curl --fail-with-body http://127.0.0.1:8787/ready
curl --fail-with-body -H 'Content-Type: application/json' --data-binary @examples/api/request.json http://127.0.0.1:8787/v1/context/compile > .ctxalloc/local/result.json
python3 - <<'PY'
import json
import urllib.parse
import urllib.request
from pathlib import Path
result = json.loads(Path('.ctxalloc/local/result.json').read_text())
id = urllib.parse.quote(result['compilationId'], safe='')
query = urllib.parse.urlencode({'tenantId': 'local', 'workspaceId': 'example'})
with urllib.request.urlopen('http://127.0.0.1:8787/v1/traces/' + id + '?' + query) as response:
    print(response.read().decode('utf-8'))
PY
```

Source registration remains a CLI operation against the same database. There is
no HTTP source CRUD. `source add` is not an upsert: use `source update` for an
existing logical source. Corpus content is read from files per compilation.

## Docker on a VPS

The multi-stage [`Dockerfile`](../Dockerfile) installs the frozen lockfile, builds
TypeScript, installs production dependencies, and assembles workspace manifests,
`dist` output, and dependency links. The final image contains no local config,
source corpus, database, or workspace `src` directories. The process runs as the
image's `node` user. Node is the direct entrypoint, so SIGTERM reaches it.

```sh
docker build -t ctxalloc:phase20 .
mkdir -p .ctxalloc/staging/config .ctxalloc/staging/sources .ctxalloc/staging/state
cp examples/api/sources/handbook.md .ctxalloc/staging/sources/handbook.md
cp examples/api/registration.json examples/api/scope.json examples/api/request.json .ctxalloc/staging/config/
python3 - <<'PY'
import json
from pathlib import Path
folder = Path('.ctxalloc/staging/config')
config = json.loads(Path('examples/api/config.json').read_text())
config['databasePath'] = '/data/state/ctxalloc.sqlite'
config['sourceRoot'] = '/data/sources'
config['server']['host'] = '0.0.0.0'
(folder / 'ctxalloc-api.json').write_text(json.dumps(config, indent=2))
config.pop('server')
(folder / 'ctxalloc-cli.json').write_text(json.dumps(config, indent=2))
PY
```

Make only the state mount writable by the image user. Check the image's UID/GID
with `docker run --rm --entrypoint id ctxalloc:phase20 node`, then set that
ownership on `.ctxalloc/staging/state` (the official image normally uses
`1000:1000`). Keep config/source files readable by that user and write-protected.
Do not make the whole checkout writable by the container.

Register before starting the API, using the built CLI in the same image:

```sh
docker run --rm --entrypoint node \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/config,dst=/config,readonly" \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/sources,dst=/data/sources,readonly" \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/state,dst=/data/state" \
  ctxalloc:phase20 apps/cli/dist/bin.js source add \
  --config /config/ctxalloc-cli.json --registration /config/registration.json

docker run -d --name ctxalloc-api \
  --publish 127.0.0.1:8787:8787 \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/config,dst=/config,readonly" \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/sources,dst=/data/sources,readonly" \
  --mount "type=bind,src=$PWD/.ctxalloc/staging/state,dst=/data/state" \
  ctxalloc:phase20
```

The container binds `0.0.0.0` internally so Docker can reach it. The host publish
is explicitly `127.0.0.1:8787:8787`; do not omit the loopback address. Configure
any remote proxy authentication and firewall policy outside this application.
Do not expose this unauthenticated service directly on the public Internet.

Use the same curl requests above after `/ready` returns 200. The image's health
check uses Node to probe `/ready` on the configured IPv4 port; no curl package is
installed. Inspect with `docker inspect --format '{{.State.Health.Status}}'
ctxalloc-api`. The sample uses port 8787 in the container and host mapping.

## Health, drain, and restart

`GET /health` returns only `{"schemaVersion":1,"status":"ok"}` and performs no
database or source work. `/ready` returns `ready` only after config, SQLite
schema-version initialization, runtime composition, and listener startup. It is
runtime-state readiness, not continuous dependency probing. External filesystem
changes or a later lock can still make a request fail while readiness is true.

On SIGINT/SIGTERM, readiness flips false before draining. The listener stops new
connections; existing application requests finish before both SQLite stores
close, once each. After `shutdownGraceMs`, Node connections are forcibly closed.
A disconnected client does not prove that its application work has completed:
stores remain open until that work finishes. Synchronous compiler CPU work
cannot be interrupted by HTTP timeouts, the grace timer, or an abort signal.

```sh
docker stop --time 30 ctxalloc-api
docker start ctxalloc-api
curl --fail-with-body http://127.0.0.1:8787/ready
```

Retrieve the earlier compilation ID with the same exact scope after restart.
Neither source content nor compiled context is reconstructed from SQLite; only
the privacy-minimized settled trace is stored. For a bare process, use SIGTERM,
wait for exit, and start the same executable/config again.

## Backup and upgrade

1. Stop the API and any CLI writers; wait for exit.
2. Copy the database into a separate backup directory with a new backup name.
   Retain the matching config and source snapshot separately under the
   operator's access controls. Do not copy a live database during writes.
3. Build and validate the replacement binary/image. Preserve the state mount.
4. Start the replacement and require `/ready` to return 200.
5. Retrieve a saved trace and run a public sample compilation before exposing
   the service through the operator's proxy.

SQLite schema version 1 is shared by the two independent control/trace
connections. Phase 20 changes no migration or journal mode and does not enable
WAL. A future schema version is rejected by older adapters; downgrade is not a
migration path. A rollback requiring older data must restore the stopped backup,
with all writers stopped, using the matching supported binary.

## Limits

This is one local process with SQLite, explicit concurrency and body limits, and
request-local lexical retrieval. It has no authentication, tenant administration,
quotas, billing, model execution over HTTP, CORS preflight support, persistent
retrieval index, semantic/hybrid search, embeddings/vector database, watchers,
background jobs, report persistence, model gateway, UI, distributed state,
replication, orchestration, or high-availability guarantee. A source directory
whose ancestors are actively replaced by an adversary is outside the portable
Node filesystem confinement guarantee; read-only operator-owned mounts are part
of this staging model.
