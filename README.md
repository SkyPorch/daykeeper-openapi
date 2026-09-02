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
Conversation and storage metering are explicitly `not_enforced`. A missing,
revoked, or exhausted assignment remains a successful status read; the
structured `ENTITLEMENT_REQUIRED` (403), `ENTITLEMENT_INACTIVE` (403), and
`TENANT_QUOTA_EXCEEDED` (409) errors describe new tenant admission failures.

This source change creates no release, deployment approval, or SDK publication.
Release coordination must account for the existing tenant-apply compatibility
impact before enforcing assignments for current consumers; the new read
operation itself is additive under [`VERSIONING.md`](VERSIONING.md).

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
