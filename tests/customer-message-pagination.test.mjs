import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const customer = readFileSync(
  fileURLToPath(new URL("../openapi/customer.yaml", import.meta.url)),
  "utf8",
);
const migration = readFileSync(
  fileURLToPath(new URL("../CURSOR_PAGINATION_MIGRATION.md", import.meta.url)),
  "utf8",
);
function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section terminator ${end}`);
  return source.slice(from, to);
}

const messageOperation = section(
  customer,
  '"/v1/conversations/{conversationId}/messages":',
  "    post:\n      operationId: sendCustomerMessage",
);
const schemas = customer.slice(customer.indexOf("  schemas:"));
const legacyMessage = section(
  schemas,
  "    Message:\n",
  "    CursorMessage:\n",
);
const cursorMessage = section(
  schemas,
  "    CursorMessage:\n",
  "    MessageSender:\n",
);
const cursorList = section(
  schemas,
  "    CursorMessageList:\n",
  "    MessageResult:\n",
);

test("cursor pagination is opt-in and leaves legacy after behavior unbounded by new cursor limits", () => {
  assert.match(
    messageOperation,
    /Requests without\s+`pagination=cursor` retain the legacy v1 response and\s+`after` behavior/,
  );
  assert.match(messageOperation, /name: pagination[\s\S]*?enum: \[cursor\]/);
  const after = section(
    messageOperation,
    "        - name: after",
    "        - name: before",
  );
  assert.doesNotMatch(after, /maximum:/);
  assert.match(after, /100-record limit/);
  assert.match(
    messageOperation,
    /oneOf:[\s\S]*?MessageList[\s\S]*?CursorMessageList/,
  );
  assert.match(
    migration,
    /Requests that omit `pagination=cursor` keep the legacy response/,
  );
  assert.match(migration, /Deploy a gateway[\s\S]*?Release SDKs/);
});

test("cursor pages are marked, bounded, and use safe message IDs without narrowing legacy IDs", () => {
  assert.doesNotMatch(legacyMessage, /maximum:/);
  assert.match(
    cursorMessage,
    /id:[\s\S]*?minimum: 1[\s\S]*?maximum: 9007199254740991/,
  );
  assert.match(cursorList, /required: \[pagination, messages\]/);
  assert.match(cursorList, /pagination:[\s\S]*?const: cursor/);
  assert.match(
    cursorList,
    /messages:[\s\S]*?maxItems: 20[\s\S]*?CursorMessage/,
  );
  assert.match(messageOperation, /786432 UTF-8 bytes/);
  assert.match(messageOperation, /message_id_out_of_range/);
  assert.match(messageOperation, /message_too_large/);
});
