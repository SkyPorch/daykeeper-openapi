import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory;
let contract;

function resolve(value) {
  if (!value?.$ref) return value;
  const parts = value.$ref.replace(/^#\//, "").split("/");
  return parts.reduce((current, part) => current[part], contract);
}

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-api-activation-"));
  const output = path.join(directory, "contract.json");
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/@redocly/cli/bin/cli.js"),
      "bundle",
      path.join(root, "openapi/daykeeper.yaml"),
      "--output",
      output,
      "--config",
      path.join(root, "redocly.yaml"),
    ],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  contract = JSON.parse(readFileSync(output, "utf8"));
});

after(() => rmSync(directory, { recursive: true, force: true }));

test("API inbox activation is machine-owner scoped and non-cacheable", () => {
  const create =
    contract.paths["/v1/tenants/{tenantId}/inbox-activations"].post;
  const read =
    contract.paths["/v1/tenants/{tenantId}/inbox-activations/{intent}"].get;
  const revoke =
    contract.paths["/v1/tenants/{tenantId}/inbox-activations/{intent}/revoke"]
      .post;
  assert.deepEqual(create.security, [{ daykeeperMachineOwner: [] }]);
  assert.deepEqual(read.security, [{ daykeeperMachineOwner: [] }]);
  assert.deepEqual(revoke.security, [{ daykeeperMachineOwner: [] }]);
  assert.deepEqual(create["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:write",
  ]);
  assert.deepEqual(read["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:read",
  ]);
  assert.deepEqual(revoke["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:write",
  ]);
  assert.deepEqual(create.parameters, [
    { $ref: "#/components/parameters/IdempotencyKey" },
  ]);
  assert.equal(
    create.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/EmptyObject",
  );
  assert.equal(
    revoke.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/EmptyObject",
  );
  for (const operation of [create, read, revoke]) {
    for (const response of Object.values(operation.responses)) {
      const definition = resolve(response);
      assert.equal(
        definition.headers["Cache-Control"].schema.const,
        "no-store",
      );
      if (definition.headers["Retry-After"])
        assert.equal(definition.headers["Retry-After"].schema.minimum, 1);
    }
  }
  const key = contract.components.parameters.IdempotencyKey.schema;
  assert.equal(key.minLength, 16);
  assert.equal(key.maxLength, 128);
  assert.equal(key.pattern, "^[A-Za-z0-9._:-]{16,128}$");
});

test("API inbox activation receipt is exact public durable state", () => {
  const schema = contract.components.schemas.ApiInboxActivation;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "activationId",
    "tenantId",
    "channelId",
    "intent",
    "state",
    "createdAt",
    "revokedAt",
    "replayed",
  ]);
  assert.deepEqual(schema.properties.state.enum, ["active", "revoked"]);
  assert.equal(schema.properties.createdAt.format, "int64");
  assert.deepEqual(schema.properties.revokedAt.type, ["integer", "null"]);
  assert.deepEqual(Object.keys(schema.properties), [
    "activationId",
    "tenantId",
    "channelId",
    "intent",
    "state",
    "createdAt",
    "revokedAt",
    "replayed",
  ]);
  assert.equal(
    contract.components.schemas.Capabilities.properties.apiInboxes.properties
      .trafficActivation.const,
    undefined,
  );
});
