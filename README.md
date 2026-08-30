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

## Check and bundle

```sh
corepack enable
pnpm install
pnpm check
```

`pnpm bundle` writes a dereferenced distribution artifact to
`dist/daykeeper.openapi.yaml` and `dist/customer.openapi.yaml`. Generated
files are CI artifacts, not hand-edited source.

## Compatibility

The stable `v1` contract uses semantic versioning for repository releases. A
change is breaking if a conforming client must change to keep working. Additive
optional fields and endpoints are minor changes; documentation-only fixes are
patches. See [`VERSIONING.md`](VERSIONING.md).

The contracts are available under Apache-2.0. No npm package is published from
this repository; SDK releases record the exact specification commit they use.
