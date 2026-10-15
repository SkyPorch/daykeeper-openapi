import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const bundled = () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "daykeeper-client-context-"),
  );
  try {
    const output = path.join(directory, "customer.json");
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/@redocly/cli/bin/cli.js"),
        "bundle",
        path.join(root, "openapi/customer.yaml"),
        "--dereferenced",
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, CI: "1", REDOCLY_TELEMETRY: "off" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const contract = bundled();
const headerOf = (pathItem, operation) =>
  [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].find(
    (parameter) =>
      parameter.in === "header" && parameter.name === "Daykeeper-Client",
  );

test("every customer session operation accepts the optional device report", () => {
  const customer = [
    ["/v1/identity", "get"],
    ["/v1/conversations", "get"],
    ["/v1/conversations", "post"],
    ["/v1/unread", "get"],
    ["/v1/conversations/{conversationId}/seen", "post"],
    ["/v1/conversations/{conversationId}/messages", "get"],
    ["/v1/conversations/{conversationId}/messages", "post"],
    ["/v1/anonymous-conversations/claim", "post"],
  ];
  for (const [route, method] of customer) {
    const pathItem = contract.paths[route];
    const header = headerOf(pathItem, pathItem[method]);
    assert.ok(header, `${method.toUpperCase()} ${route}`);
    assert.equal(header.required, false);
    assert.equal(header.schema.maxLength, 4096);
    assert.equal(header.schema.pattern, "^[A-Za-z0-9_-]+$");
  }
});

test("service-token operations describe no device", () => {
  for (const [route, method] of [
    ["/v1/lifecycle-messages", "post"],
    ["/v1/contacts/erasure-preview", "post"],
    ["/v1/contacts", "delete"],
  ]) {
    const pathItem = contract.paths[route];
    assert.equal(headerOf(pathItem, pathItem[method]), undefined, route);
  }
});

test("the decoded report is open, optional and bounded", () => {
  const header = headerOf(
    contract.paths["/v1/conversations"],
    contract.paths["/v1/conversations"].get,
  );
  const decoded = header["x-daykeeper-decoded-schema"];
  assert.equal(decoded.additionalProperties, true);
  assert.equal(decoded.required, undefined);
  assert.deepEqual(decoded.properties.platform.enum, ["ios", "android", "web"]);
  for (const [name, property] of Object.entries(decoded.properties))
    if (name !== "platform") assert.ok(property.maxLength <= 200, name);
});

test("the customer contract version is 0.2.0", () => {
  assert.equal(contract.info.version, "0.2.0");
});
