# Versioning and release policy

Contract releases use semantic versions and immutable GitHub tags of the form
`vMAJOR.MINOR.PATCH`.

- Patch: descriptions, examples, or constraints corrected without changing a
  conforming request or response.
- Minor: additive endpoints, operations, enum values documented as extensible,
  or optional request/response fields.
- Major: removed or renamed operations or fields; stricter accepted input;
  changed authentication, authorization, defaults, status codes, or semantics.

Response schemas set `additionalProperties: true` so a client generated from an
older contract still decodes responses that carry newly added fields; request
bodies stay closed so unknown input is rejected rather than silently ignored.

The path prefix (`/v1`) changes only for an intentionally incompatible API
generation. SDK versions do not have to equal contract versions, but every SDK
release records the exact contract tag and commit used to generate or verify it.

Preview operations live outside the stable document or use an explicit preview
media type. They are never silently promoted into `v1`.
