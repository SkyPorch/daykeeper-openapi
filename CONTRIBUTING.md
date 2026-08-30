# Contributing

Public behavior starts here. Give every operation a stable `operationId`, list
its exact OAuth scopes, model structured errors, and include idempotency
requirements for retried mutations. Never expose Chatwoot identifiers, routes,
credentials, or response bodies.

Run `pnpm check` before requesting review. A breaking stable-`v1` change needs
a major contract release and a migration path; do not hide one in an SDK or
service pull request. Link implementation and generated-SDK pull requests to the
exact contract commit they implement.
