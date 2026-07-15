# Integration QA — the map, peers, TCP apps

Apps declare needs in `op.json`: container resources, raw TCP ports,
pre-placed assets, provided endpoints, consumed peers. Here is how you QA
that side of a feature.

## Pull the integration map first

REVIEW.md names the platform origin as `Issuer`. Fetch the derived app graph
from it (with the platform CA, like every HTTPS call you make):

```ts
const ca = await Bun.file(process.env.OP_CA_FILE!).text();
const map = await (
  await fetch(`${issuer}/api/v1/integration-map`, { tls: { ca } })
).json();
```

The preview host is `pr-<n>-` + the app's prod host — strip that prefix and
match `map.apps[].host` to find the app under review. Each entry carries
`state`, `manifestError`, `provides`, `consumes` (each with `satisfied`),
and `tcp`; `map.edges` is the same consume graph flattened. Note the map
reflects each app's DEPLOYED (main) op.json — a consume the PR adds appears
only after merge, so also check whether the peers the feature calls exist in
`map.apps` at all.

## Findings from the map

- A non-null `manifestError` on the app under review means its shipped
  op.json is broken — report it verbatim.
- An unsatisfied consume edge (`satisfied: false`) means the peer is not
  deployed: every call to it will 404. That is a finding to name in your
  verdict — and it is also your free degradation test (next section).

## Peer degradation — absent peers are normal, crashes are not

Peer URLs are injected whether or not the peer exists; an absent peer answers
404 and a down one 502. For every route the feature has calling a peer, hit
it and confirm the app returns a clean degraded response — an empty state or
a "peer unavailable" message — never a 500, a hang, or a dead process. When
the map shows the peer absent, that IS the outage scenario: run the route and
judge the degradation for real. Re-request afterwards to confirm the app kept
serving.

## TCP apps — QA the HTTP control plane

Previews NEVER bind `tcpPorts`: you cannot join the raw port, and its absence
is not a bug. The routes on `PORT` are the mandatory control plane and must
prove the feature by themselves (status, config, whatever ISSUE.md promises).
In production the public port arrives as `OP_TCP_PORT_<containerPort>` env —
absent in previews — so a preview page showing a concrete join address or
port number has it hardcoded: that is a finding. Expect an honest
"no public port yet" state instead.

## `x-plat-user` — gate-set, unforgeable

The gate strips inbound `x-plat-user` from clients and injects its own
verified value; humans arrive as `alice`, peer apps as `app:<owner>/<app>`
(previews append `@pr-N`). The `app:` prefix is structurally unforgeable —
user names cannot contain `:`.

- Prove the app never trusts a client-sent header: send
  `x-plat-user: admin` with NO cookie to a protected route — you must not be
  treated as that user.
- If ISSUE.md gives peer callers special treatment, judge how routes handle
  `app:` identities against the spec: they must key on the full prefixed
  identity, and an `app:` caller must never pollute a human user's data.

Your verdict stays one line — when integration is the problem, name the edge
or the exact request that exposed it.
