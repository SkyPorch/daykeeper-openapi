# Customer message cursor pagination migration

Cursor pagination is an opt-in addition to the stable v1 message-list
operation. Requests that omit `pagination=cursor` keep the legacy response
shape and `after` behavior; legacy message IDs retain their existing range.
This allows existing scripts and headless SDK integrations that make one
`after` request and process up to the provider's 100-record response to
continue working unchanged.

New clients should upgrade the gateway first, then opt into the cursor profile
on every initial, `before`, and `after` request by sending
`pagination=cursor`. The cursor response has a required top-level
`pagination: "cursor"` marker. Clients must validate that marker and report an
invalid-response error if a gateway ignores the opt-in. Do not silently treat a
legacy response as a cursor page.

Cursor pages contain at most 20 customer-visible messages and the complete
normalized JSON response, including the marker, is at most 786432 UTF-8 bytes.
Initial and `before` requests return the newest contiguous suffix; `after`
requests return the oldest contiguous prefix. Continue from the last returned
ID until an empty page. A short non-empty response does not mean history is
exhausted. Cursor-mode IDs and cursors must be positive JavaScript safe
integers. An unrepresentable message ID returns HTTP 502 with
`message_id_out_of_range`; a single message exceeding the page budget returns
HTTP 413 with `message_too_large`.

A safe rollout order is:

1. Deploy a gateway that implements the cursor profile while preserving legacy
   behavior when the query parameter is absent.
2. Release SDKs that send `pagination=cursor` on every history request and
   validate the response marker.
3. Monitor cursor-mode errors and only remove legacy behavior in a future
   explicitly breaking contract generation with a published migration path.
