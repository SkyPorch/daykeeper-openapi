# Daykeeper OpenAPI

Learn more about Daykeeper at [mydaykeeper.com](https://www.mydaykeeper.com).

The canonical, versioned API contracts for Daykeeper:

- [`openapi/daykeeper.yaml`](openapi/daykeeper.yaml) is the server-side
  management API used by `@skyporch/daykeeper`, the CLI, and MCP.
- [`openapi/customer.yaml`](openapi/customer.yaml) is the narrowly scoped
  customer conversation API used by `@skyporch/daykeeper-web` and
  `@skyporch/daykeeper-react-native`. Its lifecycle and erasure operations are
  service-only and require separately scoped short-lived tokens.

The management API issues those tenant-bound gateway tokens through the
customer-session exchange. Private backend integrations use a Daykeeper server key with explicit scopes
and a tenant restriction; OAuth is also supported. Keep the key on your server
and give customer SDKs only short-lived customer-session tokens.

Consuming applications authenticate their own users
and services first; no Daykeeper administrative credential is accepted by a
customer-facing SDK.

SDKs are generated or contract-tested against tagged specifications from this
repository. Service implementation types are not a public contract.

Operator conversation replies use `daykeeper.conversations:write` and return
`201` when accepted. If a reply fails after dispatch, the error may include
`outcomeUnknown: true`; inspect the conversation and messages before deciding
whether to repeat the request. Clients must not automatically retry uncertain
replies. From `1.9.0` a reply may carry a UUID `Idempotency-Key`, and
repeating the exact request with the same key returns the original message
without sending a duplicate (see below).

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

Private backends can use native server keys without configuring an OAuth
application. A current human organization owner can list, create, and revoke
bounded agent credentials. Creation requires an explicit
idempotency key and returns the bearer token exactly once; an exact replay proves
the write completed but returns `token: null`. The client must save the fresh
token in a secret manager or revoke it and create another credential.

Organization-wide credentials can delegate the account, flow, provisioning,
billing-read, customer-session, and conversation scopes listed by the contract.
Tenant-bound credentials can delegate only customer-session, lifecycle, and
customer-erasure access for their selected tenant. Neither kind can administer
credentials or members. List responses are bounded and
contain metadata only. Creation must never be automatically retried with a new
idempotency key after an uncertain response.

A credential lasts until it is revoked unless `validityDays` (1 through 365) is
given, and a credential without an expiry reports `expiresAt: null`. Contract
`1.4.0` changes that default from 30 days and makes `expiresAt` nullable, so a
server key in a deployment's environment does not stop working on a date nobody
is watching. [`VERSIONING.md`](VERSIONING.md) calls a changed default a major
change. This one ships as a minor bump on purpose: the credential routes are
still unreleased and no published client depends on the old default.

Contract `1.6.0` adds rotation: `POST
/v1/agent-credentials/{agentCredentialId}/rotate` issues a new secret with the
same name, scopes and tenant restriction, and keeps the old one working for
`overlapHours` (default 24, at most 168; 0 revokes it at once). An owner, or
the key itself, may rotate it. A key rotating itself never gets a later
expiry than it had, revoking a key revokes what it rotated itself into, and a
key that lost its rotation response may supersede the successor it never used.
The call takes an `Idempotency-Key` and reveals the new token once, like
creation.
`AgentCredential` gains optional `rotatedFromId`, `replacedById` and
`replacedAt`, capabilities gain an optional `agentCredentials.rotation`, and a
server-key response carries `Daykeeper-Credential-Expires-At` when that key
expires within 14 days, declared as the reusable
`DaykeeperCredentialExpiresAt` header on every server-key operation and on
errors. Every addition is optional, so this is a minor bump.
A server key rotating itself must not pass `overlapHours: 0`: it revokes the
caller at once, so a lost response leaves the agent no way to recover. Deployed
servers still accept it, and a server may start rejecting it with
`INVALID_INPUT`.
The agent credential response objects (`AgentCredential`, its page, the create,
revoke and rotate results, and `capabilities.agentCredentials`) now set
`additionalProperties: true`, as `VERSIONING.md` requires of response schemas,
so a client generated from `1.6.0` decodes fields a later minor version adds.
`AgentCredential` still forbids `token` and `tokenHash`. Clients generated from
`1.4.0` or earlier, where these objects were closed, already reject the
deployed server's `tenantId` and lineage fields and should regenerate.
`AgentCredential.tenantId` is optional again: servers before tenant-scoped keys
omit it, and absent means organization-wide.

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

## Unreleased API inbox activation

Machine-owner credentials with `daykeeper.accounts:write` can activate an
already prepared API inbox through `/v1/tenants/{tenantId}/inbox-activations`.
The request is a strict empty JSON object and requires an `Idempotency-Key`.
Exact replays return the original `201` receipt; an uncertain write must be
reconciled with the matching GET and is never automatically retried. A receipt
contains only durable activation state (`activationId`, `tenantId`,
`channelId`, `intent`, `state`, `createdAt`, `revokedAt`, and `replayed`); it
does not claim current traffic readiness. Use the tenant inbox read and its
`trafficEnabled` field for that observation. Revoke is also machine-owner
scoped and accepts the same strict empty body. All responses are non-cacheable.

This additive contract is unreleased and does not grant DNS, human-owner, or
customer configuration prerequisites, nor does it publish an SDK.

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

## Unreleased workspace claims

Contract `1.3.0` adds workspace claims: a machine owner hands an
agent-created workspace to a person as owner. `POST /v1/workspace-claims`
requires an `Idempotency-Key` and a machine-owner credential with
`daykeeper.accounts:write`; human bearers and delegated agent credentials get
`SCOPE_NOT_HELD` (403). A fresh application answers `201` with
`replayed: false` and reveals `token` and `claimUrl` exactly once; an exact
repeat answers `200` with `replayed: true` and both fields `null`. The token
rides in the URL fragment, so it never reaches server logs or referrers, and
the caller delivers the URL; from `1.8.0` an installation may also email it
(see "Unreleased workspace claim email" below). Never log or persist it.

The two success bodies are separate schemas rather than one loose shape.
`WorkspaceClaimCreated` is the `201` body: a non-null `token` and `claimUrl`
with `replayed` fixed to `false`. `WorkspaceClaimReplayed` is the `200` body:
both fields `null` with `replayed` fixed to `true`. Neither status can carry the
other's shape. `WorkspaceClaimResult` remains as the `oneOf` of the two, so a
generated client still has one result type to narrow on `replayed`.

One pending claim exists per email per organization. A different intent for a
pending address is `INVITATION_ALREADY_PENDING` (409), an existing member is
`ALREADY_A_MEMBER` (409), the hourly window is `RATE_LIMITED` (429), and a bad
address or key is `INVALID_INPUT` (400). `CreateWorkspaceClaimInput.email` is a
lowercase address: dot-separated local atoms, so no leading, trailing, or
doubled dot, and a domain of hyphen-safe labels with at least one dot, within
254 characters. `GET /v1/workspace-claims` needs `daykeeper.accounts:read` and
returns every pending and accepted claim without tokens, expired hidden, newest
first. That list is not paginated in v1 and the contract sets no item cap; the
hourly issue limit is what bounds growth.
`POST /v1/workspace-claims/{claimId}/revoke` is machine-owner scoped, takes the
strict empty body, and is safe to repeat. All responses are non-cacheable.

The optional `capabilities.workspaceClaims` boolean reports whether the console
origin setting is configured; when it is absent the claim routes answer
`FEATURE_UNAVAILABLE` (503). Older servers omit the field entirely. Accepting a
claim does not demote the machine owner and does not spend the person's free
workspace. Under [`VERSIONING.md`](VERSIONING.md) these additive endpoints and
the optional capability field are a minor bump, so `info.version` moves from
`1.2.0` to `1.3.0`. This source change publishes no tag, enables no server
feature, and grants no deployment or SDK release approval.

## Unreleased web messenger

Contract `1.7.0` documents the web-client resource a tenant's web messenger
boots from. `GET /v1/tenants/{tenantId}/web-client` (`daykeeper.accounts:read`)
returns the allowed websites, the publishable key, the install snippet and a
`version`, sent as `ETag`. `PUT` (`daykeeper.accounts:write`) replaces the
whole setting; the first PUT mints the key and answers `201`, later ones answer
`200` and keep it. `POST .../web-client/publishable-key:rotate` mints a new key
and keeps the previous one working for `graceSeconds` (at most seven days).
The publishable key is a public identifier, not a secret: the Origin check
against `allowedOrigins` is what keeps other websites out. Check
`capabilities.webClients` first; `enabled: false` means the routes answer
`FEATURE_UNAVAILABLE` (409), and `loopbackOrigins` says whether
`http://localhost` origins are accepted.

A PUT with no precondition is unconditional. A writer that can race another
sends `If-Match: <version>` to replace only that version, or `If-None-Match: *`
to create only; either answers `VERSION_CONFLICT` (412) when the stored state
differs and writes nothing. `If-None-Match: *` is new in `1.7.0` and servers
before it ignore the header, so a create-only caller should also confirm the
`201`. The GET, PUT and rotate operations shipped before this contract and are
documented as deployed; every addition is optional, so this is a minor bump.

## Unreleased workspace claim email

Contract `1.8.0` adds an optional boolean `emailed` to both workspace claim
results. Only an installation configured to email claim links sends it: on a
fresh `201` it says whether this request emailed the claim URL to the claimed
address, and on a replay `200` it is always `false` (a replay sends nothing).
Installations that do not email claims, the default, and servers before
`1.8.0` omit it, so their results keep the `1.7.0` shape exactly. The result
schemas keep `additionalProperties: false`, so a client that validates
strictly against `1.7.0` would refuse the new field: operators must upgrade
clients to `1.8.0` before turning claim emails on. The email carries the link and
its expiry and no text the agent chose, and a failed send never fails the
claim. One optional response field is a minor bump under
[`VERSIONING.md`](VERSIONING.md), so `info.version` moves from `1.7.0` to
`1.8.0`.

## Unreleased Dashboard management API

Contract `1.9.0` documents what the Daykeeper Dashboard (the ChatGPT app served
by `daykeeper-mcp`) reads and changes. Every addition is optional, so this is a
minor bump under [`VERSIONING.md`](VERSIONING.md).

- `GET /v1/profile` and `GET /v1/workspaces` (`daykeeper.accounts:read`) return
  the person and workspace bound to a human OAuth access token. The token
  chooses the active workspace; the list cannot change it. Other credentials
  receive `401`.
- `GET /v1/tenants/{tenantId}/conversations/{conversationId}` reads one
  conversation summary; `PATCH` on the same path sets `status` to `open` or
  `resolved` (`daykeeper.conversations:write`) and answers only after the
  server has confirmed the new status.
- Conversation and message lists accept `limit` (1-100, default 50) and an
  opaque `cursor`. Pagination is opt-in: a request that sends either gets
  `page: { limit, nextCursor, hasMore }`; a request that sends neither gets the
  1.8 representation with no `page`, so clients generated from earlier
  contracts keep decoding it. Message pages start at the latest messages,
  sorted oldest to newest; pass `nextCursor` unchanged for older ones. The
  list schemas are now open (`additionalProperties: true`).
- Replies accept an optional UUID `Idempotency-Key`. An exact replay returns
  the original message with `200`; a reused key for a different request, or a
  replay while the first attempt is in progress, answers `409`. Replies
  without the header behave exactly as before.
- `GET` and `POST /v1/tenants/{tenantId}/customer-email` expose the customer
  email switch on the bearer API. Members with `daykeeper.accounts:read` read
  it; only a human owner with `daykeeper.accounts:write` changes it.
- Capabilities may report `operatorConversations` (`pagination`,
  `statusUpdates` for both GET and PATCH on one conversation,
  `idempotentReplies`), `customerEmail`, and `dashboardIdentity`. Absent
  means the server predates the feature.
- `daykeeperOAuth` documents the authorization code flow (PKCE) that issues
  the human tokens these routes require, beside client credentials.

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
