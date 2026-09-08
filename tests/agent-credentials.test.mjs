import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory;
let contract;

function redocly(args) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/@redocly/cli/bin/cli.js"),
      ...args,
      "--config",
      path.join(root, "redocly.yaml"),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: "1", REDOCLY_TELEMETRY: "off" },
    },
  );
  assert.ifError(result.error);
  return result;
}

function lintDocument(document, name) {
  const filename = path.join(directory, `${name}.json`);
  writeFileSync(filename, JSON.stringify(document));
  return redocly(["lint", filename, "--format", "json"]);
}

before(() => {
  directory = mkdtempSync(
    path.join(tmpdir(), "daykeeper-credentials-contract-"),
  );
  const output = path.join(directory, "contract.json");
  const result = redocly([
    "bundle",
    path.join(root, "openapi/daykeeper.yaml"),
    "--output",
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  contract = JSON.parse(readFileSync(output, "utf8"));
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("agent credential routes are owner-managed, bounded, and reveal-once", () => {
  const collection = contract.paths["/v1/agent-credentials"];
  const revoke =
    contract.paths["/v1/agent-credentials/{agentCredentialId}/revoke"];
  assert.deepEqual(collection.get.security, [
    { daykeeperOAuth: ["daykeeper.credentials:read"] },
  ]);
  assert.deepEqual(collection.post.security, [
    { daykeeperOAuth: ["daykeeper.credentials:write"] },
  ]);
  assert.deepEqual(collection.post.parameters, [
    { $ref: "#/components/parameters/IdempotencyKey" },
  ]);
  assert.match(collection.post.description, /current human organization owner/);
  assert.match(collection.post.description, /Do not automatically retry/);
  assert.deepEqual(revoke.parameters, [
    { $ref: "#/components/parameters/AgentCredentialId" },
  ]);
  assert.deepEqual(revoke.post.requestBody.content["application/json"].schema, {
    type: "object",
    additionalProperties: false,
  });
  for (const response of [
    collection.get.responses["200"],
    collection.post.responses["200"],
    collection.post.responses["201"],
    revoke.post.responses["200"],
  ]) {
    assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
  }
});

test("machine onboarding uses five signed-body routes with raw status-specific results", () => {
  const routes = [
    [
      "/v1/machine-enrollments/challenges",
      "MachineEnrollmentInput",
      { 201: "MachineChallenge" },
    ],
    [
      "/v1/machine-enrollments",
      "MachineProofInput",
      { 200: "MachineEnrollmentResult", 201: "MachineEnrollmentResult" },
    ],
    [
      "/v1/machine-credential-rotations/challenges",
      "MachineRotationInput",
      { 201: "MachineChallenge" },
    ],
    [
      "/v1/machine-credential-rotations",
      "MachineProofInput",
      { 200: "MachineRotationResult", 201: "MachineRotationResult" },
    ],
    [
      "/v1/machine-credential-rotations/current",
      "MachineProofInput",
      { 200: "MachineCredentialMetadata" },
    ],
  ];
  for (const [path, input, results] of routes) {
    const route = contract.paths[path].post;
    assert.deepEqual(route.security, []);
    assert.equal(route.requestBody.required, true);
    assert.equal(
      route.requestBody.content["application/json"].schema.$ref,
      `#/components/schemas/${input}`,
    );
    assert.deepEqual(
      Object.keys(route.responses)
        .filter((status) => /^2/.test(status))
        .sort(),
      Object.keys(results).sort(),
    );
    for (const [status, schema] of Object.entries(results)) {
      assert.equal(
        route.responses[status].content["application/json"].schema.$ref,
        `#/components/schemas/${schema}`,
      );
      assert.equal(
        contract.components.schemas[schema].properties.data,
        undefined,
      );
    }
  }
});

test("machine key and proof inputs are bounded and metadata cannot expose secrets", () => {
  const schemas = contract.components.schemas;
  for (const name of [
    "MachinePublicKey",
    "MachineEnrollmentInput",
    "MachineProofInput",
    "MachineRotationInput",
    "MachineCredentialMetadata",
  ]) {
    assert.equal(schemas[name].additionalProperties, false);
  }
  assert.deepEqual(schemas.MachinePublicKey.required.slice().sort(), [
    "crv",
    "kty",
    "x",
    "y",
  ]);
  assert.equal(schemas.MachinePublicKey.properties.d, undefined);
  assert.equal(schemas.MachineProofInput.properties.proof.maxLength, 4096);
  assert.equal(schemas.MachineCredentialMetadata.properties.token, undefined);
  assert.equal(
    schemas.MachineCredentialMetadata.properties.tokenHash,
    undefined,
  );
  assert.deepEqual(schemas.MachineEnrollmentResult.properties.token.type, [
    "string",
    "null",
  ]);
  assert.deepEqual(schemas.MachineRotationResult.properties.token.type, [
    "string",
    "null",
  ]);
});

test("agent credentials cannot delegate credential administration", () => {
  const schemas = contract.components.schemas;
  const delegated = schemas.AgentCredentialScope.enum;
  assert.deepEqual(delegated, [
    "daykeeper.accounts:read",
    "daykeeper.accounts:write",
    "daykeeper.flows:read",
    "daykeeper.flows:write",
    "daykeeper.flows:publish",
    "daykeeper.provisioning:read",
    "daykeeper.provisioning:apply",
    "daykeeper.billing:read",
  ]);
  assert.equal(delegated.includes("daykeeper.credentials:read"), false);
  assert.equal(delegated.includes("daykeeper.credentials:write"), false);
  assert.equal(schemas.AgentCredentialPage.properties.items.maxItems, 100);
  assert.equal(
    schemas.CreateAgentCredentialInput.properties.scopes.uniqueItems,
    true,
  );
  assert.equal(
    schemas.CreateAgentCredentialInput.properties.validityDays.maximum,
    90,
  );
  assert.equal(
    schemas.Capabilities.required.includes("agentCredentials"),
    false,
  );
});

test("the OpenAPI validator accepts fresh and replayed reveal-once results", () => {
  const document = structuredClone(contract);
  const response =
    document.paths["/v1/agent-credentials"].post.responses["201"].content[
      "application/json"
    ];
  const credential = {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    name: "Production MCP",
    hint: "dk_agent_30000000…CQkJ",
    scopes: ["daykeeper.accounts:read"],
    state: "active",
    expiresAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  response.examples = {
    fresh: {
      value: {
        data: {
          credential,
          token: `dk_agent_${credential.id.replaceAll("-", "")}_${"A".repeat(43)}`,
          replayed: false,
        },
      },
    },
    replayed: {
      value: { data: { credential, token: null, replayed: true } },
    },
  };
  const result = lintDocument(document, "credential-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the OpenAPI validator rejects secret-bearing lists and overbroad input", () => {
  const document = structuredClone(contract);
  const list =
    document.paths["/v1/agent-credentials"].get.responses["200"].content[
      "application/json"
    ];
  const create =
    document.paths["/v1/agent-credentials"].post.requestBody.content[
      "application/json"
    ];
  const credential = {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    name: "Production MCP",
    hint: "dk_agent_30000000…CQkJ",
    scopes: ["daykeeper.accounts:read"],
    state: "active",
    expiresAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    token: "must-never-be-listed",
  };
  list.examples = {
    leaked: { value: { data: { items: [credential], hasMore: false } } },
  };
  create.examples = {
    administerCredentials: {
      value: {
        name: "Overbroad agent",
        scopes: ["daykeeper.credentials:write"],
        validityDays: 30,
      },
    },
  };
  const result = lintDocument(document, "credential-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems;
  for (const name of ["leaked", "administerCredentials"]) {
    assert.ok(
      problems.some(
        (problem) =>
          problem.ruleId === "no-invalid-media-type-examples" &&
          problem.location.some((location) =>
            location.pointer.includes(`/examples/${name}/value`),
          ),
      ),
      name,
    );
  }
});
