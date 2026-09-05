# Daykeeper OpenAPI

The canonical, versioned API contracts for Daykeeper:

- [`openapi/daykeeper.yaml`](openapi/daykeeper.yaml) is the server-side
  management API used by `@skyporch/daykeeper`, the CLI, and MCP.
- [`openapi/customer.yaml`](openapi/customer.yaml) is the narrowly scoped
  customer conversation API used by `@skyporch/daykeeper-web` and
  `@skyporch/daykeeper-react-native`. Its lifecycle and erasure operations are
  service-only and require separately scoped short-lived tokens.

The management API issues those tenant-bound gateway tokens through the
customer-session exchange. Consuming applications authenticate their own users
and services first; no Daykeeper administrative credential is accepted by a
customer-facing SDK.

SDKs are generated or contract-tested against tagged specifications from this
repository. Service implementation types are not a public contract.

## Unreleased entitlement contract

`GET /v1/entitlements` requires `daykeeper.accounts:read` and describes only
the authenticated principal's organization. It exposes no organization selector,
assignment mutation, or upgrade endpoint. Tenant-bound principals with that
scope see the organization-wide admission count.

The `free-2026-08-31` policy's one-tenant allowance is a provisional provisioning
safeguard, not approved marketing pricing or a shipped self-serve free tier.
Legacy `metering` fields remain `not_enforced` for compatibility but are
deprecated: they do not inspect optional provider enforcement. A missing,
revoked, or exhausted assignment remains a successful status read; the
structured `ENTITLEMENT_REQUIRED` (403), `ENTITLEMENT_INACTIVE` (403), and
`TENANT_QUOTA_EXCEEDED` (409) errors describe new tenant admission failures.

This source change creates no release, deployment approval, or SDK publication.
Release coordination must account for the existing tenant-apply compatibility
impact before enforcing assignments for current consumers; the new read
operation itself is additive under [`VERSIONING.md`](VERSIONING.md).

## Unreleased usage inspection

`GET /v1/usage` requires organization-wide `daykeeper.billing:read` and rejects
tenant-bound credentials and query selectors. It returns a non-cacheable,
current-UTC-month snapshot of recorded contact, conversation, and message
resources pooled within one cell. These are provisional safety ceilings, not
billable resolutions or delivery counts. Legacy traffic is not backfilled.

Absent assignments have null limits, not unlimited usage. Paused and exhausted
assignments still return status. `writeAdmission: "not_evaluated"` means neither
remaining capacity nor a new month grants traffic access. There is no reset,
upgrade, assignment, or activation operation. Older servers may omit the
optional `capabilities.usage` field; do not turn a 404 into an automatic write.

This is unreleased additive source. SDK, CLI and MCP adoption requires a
coordinated approved release; it does not grant installation or billing approval.

## Unreleased first-inbox contract

An optional `website` on the existing tenant plan prepares one website inbox.
Check `capabilities().websiteInboxes.enabled` before requesting it; an absent
capability on an older server means unsupported. Account-only plans are
unchanged, and the operation remains `tenant.provision`.

`GET /v1/tenants/{tenantId}/website-channel` requires `daykeeper.accounts:read`
and returns non-cacheable tenant metadata, never provider credentials. Exact
HTTPS origins are normalized and must include the website origin. Inspect the
durable operation on failure; do not create another tenant as a retry strategy.

`prepared` is not ready for traffic: `trafficEnabled` remains false until
routing, signed identity, usage enforcement and installation checks are
implemented. This contract does not add activation, credential export, signup,
payments or a shipped free tier. It is additive source for a future coordinated
minor release, not a package publication or deployment approval.

## Unreleased provisioning recovery

`GET /v1/tenants/{tenantId}/provisioning-operation` rediscovers the latest
`tenant.provision` operation after a reload or lost apply response. It requires
both `daykeeper.accounts:read` and `daykeeper.provisioning:read`, checks tenant
access, rejects query selectors, and returns the existing non-cacheable
operation envelope. It does not retry, provision, or activate anything.

A tenant adopted without a creation operation, or an older server, may return 404. Inspect the tenant and reconcile the original request; never interpret a
missing operation as permission to create another tenant. This additive endpoint
is unreleased and requires coordinated server and SDK approval.

## Unreleased agent credentials

Hosted OAuth remains the preferred workload identity. For headless environments
that cannot complete OAuth, a current human organization owner can list, create,
and revoke bounded, expiring agent credentials. Creation requires an explicit
idempotency key and returns the bearer token exactly once; an exact replay proves
the write completed but returns `token: null`. The client must save the fresh
token in a secret manager or revoke it and create another credential.

Agent credentials can delegate only account, flow, provisioning, and billing
read/write scopes listed by the contract. They cannot administer credentials,
members, customer erasure, or lifecycle access. List responses are bounded and
contain metadata only. Creation must never be automatically retried with a new
idempotency key after an uncertain response.

This contract is unreleased and requires a coordinated server and SDK release.
It does not enable the server feature flag, publish a package, or make static
credentials the default onboarding path.

## Unreleased domain verification

Machine-owner tokens can create, inspect, DNS-verify, and revoke durable
domain-verification evidence through `/v1/tenants/{tenantId}/domain-verifications`.
The create request requires an exact HTTPS origin and an `Idempotency-Key`;
the response exposes only public TXT record instructions and lifecycle
timestamps. Verification re-observes DNS and never activates customer traffic.
Human and delegated tokens are not supported, and all success and error
responses are non-cacheable. This additive contract is unreleased and does not
authorize DNS changes, route admission, deployment, or package publication.

## Unreleased customer usage errors

Customer errors retain the required `error` code. Optional `message`, `retryable`
and `nextAction` fields add safe explanations and recovery advice. Existing
`{ "error": "..." }` responses remain valid. Do not automatically replay a request
with `retryable: false`, even when its HTTP status is 429 or 503. A retryable hint
does not make an uncertain write safe to repeat; reconcile its outcome first.

Managed usage errors include `daykeeper_usage_limit_exceeded` (429),
`daykeeper_usage_not_enabled` and `daykeeper_support_not_ready` (403),
`daykeeper_resource_conflict` (409), and `daykeeper_support_unavailable` (503).
These are opt-in implementation contracts, not automatic customer activation,
billing approval, or a release. The customer schema change is additive source
for the next coordinated minor release; no tag is created here.

## Unreleased idempotent flow mutations

Creating a flow, adding a version, and publishing a version each require an
`Idempotency-Key` header of 16 to 128 URL-safe characters. The key is bound to
the request the first time it is applied. Creation and revision answer `201`
with `replayed: false` on first application and `200` with the original result
and `replayed: true` on an exact repeat. Publication always answers `200` and
reports the same `replayed` signal. Reusing a key for a different request is
rejected with `IDEMPOTENCY_KEY_REUSED` (409) and applies no write; a missing or
malformed key is rejected with `INVALID_INPUT` (400).

Optimistic concurrency is unchanged for new keys, so a stale
`expectedLatestVersion` or `expectedResourceVersion` still returns
`RESOURCE_VERSION_CONFLICT`. When a mutation fails without a usable response its
outcome is unknown: repeat it with the same key and the exact original body to
reconcile it, and never retry an uncertain mutation under a new key. The Node
SDK reports that state as `outcomeUnknown` and does not retry it automatically.

This is not an additive change. It requires input a conforming client did not
previously send and changes the success status of two operations, so it needs a
coordinated server and SDK release rather than a routine minor bump.

## Check and bundle

```sh
corepack enable
pnpm install
pnpm check
```

`pnpm bundle` writes a dereferenced distribution artifact to
`dist/daykeeper.openapi.yaml` and `dist/customer.openapi.yaml`. Generated
files are CI artifacts, not hand-edited source.

`pnpm test` checks entitlement scopes, response shapes, and stable errors, then
uses the same OpenAPI validator to accept valid status examples and reject
malformed ones. It does not contact a deployed service.

## Compatibility

The stable `v1` contract uses semantic versioning for repository releases. A
change is breaking if a conforming client must change to keep working. Additive
optional fields and endpoints are minor changes; documentation-only fixes are
patches. See [`VERSIONING.md`](VERSIONING.md).

The contracts are available under Apache-2.0. No npm package is published from
this repository; SDK releases record the exact specification commit they use.
