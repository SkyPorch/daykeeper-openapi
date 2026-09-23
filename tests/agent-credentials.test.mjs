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
    "daykeeper.flows:operate",
    "daykeeper.provisioning:read",
    "daykeeper.provisioning:apply",
    "daykeeper.billing:read",
    "daykeeper.customer-sessions:write",
    "daykeeper.conversations:read",
    "daykeeper.conversations:write",
    "daykeeper.lifecycle:write",
    "daykeeper.customers:delete",
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
    365,
  );
  // Omitted or null issues a credential that lasts until it is revoked.
  assert.equal(
    schemas.CreateAgentCredentialInput.properties.validityDays.default,
    null,
  );
  assert.deepEqual(schemas.AgentCredential.properties.expiresAt.type, [
    "string",
    "null",
  ]);
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
    tenantId: null,
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
    withoutExpiry: {
      value: {
        data: {
          credential: { ...credential, expiresAt: null },
          token: null,
          replayed: true,
        },
      },
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
    tenantId: null,
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

test("tenant support keys reject workspace administration and unbound lifecycle access", () => {
  const document = structuredClone(contract);
  const input =
    document.paths["/v1/agent-credentials"].post.requestBody.content[
      "application/json"
    ];
  input.examples = {
    scoped: {
      value: {
        name: "Support backend",
        tenantId: "20000000-0000-4000-8000-000000000001",
        scopes: [
          "daykeeper.customer-sessions:write",
          "daykeeper.lifecycle:write",
          "daykeeper.customers:delete",
        ],
      },
    },
  };
  let result = lintDocument(document, "scoped-valid");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  input.examples = {
    unbound: {
      value: { name: "Support backend", scopes: ["daykeeper.lifecycle:write"] },
    },
    broad: {
      value: {
        name: "Support backend",
        tenantId: "20000000-0000-4000-8000-000000000001",
        scopes: ["daykeeper.accounts:write"],
      },
    },
  };
  result = lintDocument(document, "scoped-invalid");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const problems = JSON.parse(result.stdout).problems;
  for (const name of ["unbound", "broad"])
    assert.ok(
      problems.some(
        (p) =>
          p.ruleId === "no-invalid-media-type-examples" &&
          p.location.some((l) => l.pointer.includes(`/examples/${name}/value`)),
      ),
    );
});

test("rotation is owner- or self-authorized, idempotent, bounded and reveal-once", () => {
  const rotate =
    contract.paths["/v1/agent-credentials/{agentCredentialId}/rotate"];
  assert.deepEqual(rotate.parameters, [
    { $ref: "#/components/parameters/AgentCredentialId" },
  ]);
  assert.deepEqual(rotate.post.security, [
    { daykeeperOAuth: ["daykeeper.credentials:write"] },
    { daykeeperServerKey: [] },
  ]);
  assert.deepEqual(rotate.post.parameters, [
    { $ref: "#/components/parameters/IdempotencyKey" },
  ]);
  assert.match(rotate.post.description, /can rotate only itself/);
  assert.match(rotate.post.description, /never gets a later expiry/);
  assert.match(rotate.post.description, /revokes every key it produced/);
  assert.match(rotate.post.description, /successor it never used/);
  for (const status of ["200", "201"])
    assert.equal(
      rotate.post.responses[status].headers["Cache-Control"].schema.const,
      "no-store",
    );
  const schemas = contract.components.schemas;
  const input = schemas.RotateAgentCredentialInput;
  assert.equal(input.additionalProperties, false);
  assert.equal(input.required, undefined);
  assert.equal(input.properties.overlapHours.default, 24);
  assert.equal(input.properties.overlapHours.minimum, 0);
  assert.equal(input.properties.overlapHours.maximum, 168);
  // Omitted keeps the rotated key's policy, so there is no default.
  assert.equal(input.properties.validityDays.default, undefined);
  assert.equal(input.properties.validityDays.maximum, 365);
  assert.deepEqual(schemas.RotateAgentCredentialResult.required, [
    "credential",
    "previousCredential",
    "token",
    "replayed",
  ]);
  // Older servers never emit the lineage fields, so they stay optional.
  for (const field of ["rotatedFromId", "replacedById", "replacedAt"]) {
    assert.ok(schemas.AgentCredential.properties[field]);
    assert.equal(schemas.AgentCredential.required.includes(field), false);
  }
});

test("the OpenAPI validator accepts a rotation result and rejects a wide overlap", () => {
  const document = structuredClone(contract);
  const route =
    document.paths["/v1/agent-credentials/{agentCredentialId}/rotate"].post;
  const previous = {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    tenantId: null,
    name: "Production MCP",
    hint: "dk_agent_30000000…CQkJ",
    scopes: ["daykeeper.accounts:read"],
    state: "active",
    expiresAt: "2026-09-24T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    rotatedFromId: null,
    replacedById: "30000000-0000-4000-8000-000000000002",
    replacedAt: "2026-09-23T00:00:00.000Z",
  };
  const credential = {
    ...previous,
    id: "30000000-0000-4000-8000-000000000002",
    hint: "dk_agent_30000000…DQkJ",
    expiresAt: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    rotatedFromId: previous.id,
    replacedById: null,
    replacedAt: null,
  };
  route.responses["201"].content["application/json"].examples = {
    fresh: {
      value: {
        data: {
          credential,
          previousCredential: previous,
          token: `dk_agent_${credential.id.replaceAll("-", "")}_${"A".repeat(43)}`,
          replayed: false,
        },
      },
    },
  };
  route.requestBody.content["application/json"].examples = {
    defaults: { value: {} },
    immediate: { value: { overlapHours: 0, validityDays: 90 } },
  };
  const valid = lintDocument(document, "rotation-valid-examples");
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  route.requestBody.content["application/json"].examples = {
    tooWide: { value: { overlapHours: 169 } },
  };
  const invalid = lintDocument(document, "rotation-invalid-examples");
  assert.notEqual(invalid.status, 0);
});

test("credential responses stay decodable when a later minor version adds fields", () => {
  const schemas = contract.components.schemas;
  // VERSIONING.md: response schemas are open so an older client tolerates new
  // fields. A credential still never carries its secret.
  for (const name of [
    "AgentCredential",
    "AgentCredentialPage",
    "CreateAgentCredentialResult",
    "RevokeAgentCredentialResult",
    "RotateAgentCredentialResult",
  ])
    assert.equal(schemas[name].additionalProperties, true, name);
  assert.equal(
    schemas.Capabilities.properties.agentCredentials.additionalProperties,
    true,
  );
  assert.equal(schemas.AgentCredential.properties.token, false);
  assert.equal(schemas.AgentCredential.properties.tokenHash, false);
  // Servers before tenant-scoped keys omit tenantId.
  assert.equal(schemas.AgentCredential.required.includes("tenantId"), false);
});

test("a newer server's credential fields validate, a secret still does not", () => {
  const document = structuredClone(contract);
  const list =
    document.paths["/v1/agent-credentials"].get.responses["200"].content[
      "application/json"
    ];
  const credential = {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    name: "Production MCP",
    hint: "dk_agent_30000000…CQkJ",
    scopes: ["daykeeper.accounts:read"],
    state: "active",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  list.examples = {
    olderServer: { value: { data: { items: [credential], hasMore: false } } },
    newerServer: {
      value: {
        data: {
          items: [{ ...credential, tenantId: null, laterField: "x" }],
          hasMore: false,
          laterField: 1,
        },
      },
    },
  };
  let result = lintDocument(document, "credential-open-valid");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  list.examples = {
    leakedHash: {
      value: {
        data: {
          items: [{ ...credential, tokenHash: "0".repeat(64) }],
          hasMore: false,
        },
      },
    },
  };
  result = lintDocument(document, "credential-open-invalid");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
});

test("server-key responses declare the credential-expiry header", () => {
  const header = "Daykeeper-Credential-Expires-At";
  const reference = {
    $ref: "#/components/headers/DaykeeperCredentialExpiresAt",
  };
  assert.equal(
    contract.components.headers.DaykeeperCredentialExpiresAt.schema.format,
    "date-time",
  );
  assert.deepEqual(
    contract.components.responses.Error.headers[header],
    reference,
  );
  let operations = 0;
  for (const item of Object.values(contract.paths))
    for (const operation of Object.values(item)) {
      if (
        !operation?.security?.some((requirement) =>
          Object.hasOwn(requirement, "daykeeperServerKey"),
        )
      )
        continue;
      operations += 1;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!/^2/.test(status)) continue;
        assert.deepEqual(
          response.headers?.[header],
          reference,
          `${operation.operationId} ${status}`,
        );
      }
    }
  assert.equal(operations, 5);
});

test("a server key is warned off zero-overlap self-rotation", () => {
  const rotate =
    contract.paths["/v1/agent-credentials/{agentCredentialId}/rotate"].post;
  assert.match(
    rotate.description,
    /server key rotating itself must not send `overlapHours: 0`/,
  );
  assert.match(
    contract.components.schemas.RotateAgentCredentialInput.properties
      .overlapHours.description,
    /must send at least 1/,
  );
});
