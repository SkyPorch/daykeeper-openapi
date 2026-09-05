import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/@redocly/cli/bin/cli.js");
let directory;
let contract;

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-domain-contract-"));
  const output = path.join(directory, "contract.json");
  const result = spawnSync(
    process.execPath,
    [
      cli,
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

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function response(operation, status) {
  return operation.responses[status];
}

test("domain verification operations are machine-owner scoped and non-cacheable", () => {
  const create =
    contract.paths["/v1/tenants/{tenantId}/domain-verifications"].post;
  const item =
    contract.paths[
      "/v1/tenants/{tenantId}/domain-verifications/{verificationId}"
    ];
  const verify = item.post;
  const revoke =
    contract.paths[
      "/v1/tenants/{tenantId}/domain-verifications/{verificationId}/revoke"
    ].post;
  assert.deepEqual(create.security, [
    { daykeeperOAuth: ["daykeeper.accounts:write"] },
  ]);
  assert.deepEqual(item.get.security, [
    { daykeeperOAuth: ["daykeeper.accounts:read"] },
  ]);
  assert.deepEqual(verify.security, [
    { daykeeperOAuth: ["daykeeper.accounts:write"] },
  ]);
  assert.deepEqual(revoke.security, [
    { daykeeperOAuth: ["daykeeper.accounts:write"] },
  ]);
  assert.ok(
    create.parameters.some(
      (parameter) =>
        parameter.$ref === "#/components/parameters/IdempotencyKey",
    ),
  );
  for (const operation of [create, item.get, verify, revoke]) {
    for (const status of Object.keys(operation.responses)) {
      const responseDefinition = response(operation, status);
      if (status === "default") continue;
      if (responseDefinition.$ref === "#/components/responses/DomainError")
        continue;
      assert.equal(
        responseDefinition.headers["Cache-Control"].schema.const,
        "no-store",
        `${operation.operationId} ${status}`,
      );
    }
  }
  for (const operation of [verify, revoke])
    assert.equal(
      operation.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/EmptyObject",
    );
});

test("domain verification schema exposes only public DNS evidence", () => {
  const schema = contract.components.schemas.DomainVerification;
  assert.deepEqual(schema.required, [
    "challengeId",
    "tenantId",
    "origin",
    "state",
    "dns",
    "expiresAt",
    "verifiedAt",
    "revokedAt",
  ]);
  assert.deepEqual(schema.properties.state.enum, [
    "pending",
    "verified",
    "expired",
    "revoked",
  ]);
  assert.equal(
    schema.properties.dns.$ref,
    "#/components/schemas/DomainVerificationDns",
  );
  assert.equal(
    contract.components.schemas.DomainVerificationDns.properties.type.const,
    "TXT",
  );
  assert.equal(
    contract.components.schemas.DomainVerificationInput.additionalProperties,
    false,
  );
  assert.equal(
    contract.components.schemas.DomainVerificationInput.required[0],
    "origin",
  );
  assert.equal(
    contract.components.schemas.Capabilities.properties.domainVerifications
      .properties.trafficActivation.const,
    false,
  );
});
