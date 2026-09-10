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
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-claims-contract-"));
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

test("workspace claims are machine-owner scoped, idempotent, and non-cacheable", () => {
  const collection = contract.paths["/v1/workspace-claims"];
  const revoke = contract.paths["/v1/workspace-claims/{claimId}/revoke"];
  for (const operation of [collection.post, collection.get, revoke.post]) {
    assert.deepEqual(operation.security, [{ daykeeperMachineOwner: [] }]);
    assert.deepEqual(operation.tags, ["Workspace claims"]);
  }
  assert.deepEqual(collection.post["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:write",
  ]);
  assert.deepEqual(collection.get["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:read",
  ]);
  assert.deepEqual(revoke.post["x-daykeeper-required-scopes"], [
    "daykeeper.accounts:write",
  ]);
  assert.deepEqual(collection.post.parameters, [
    { $ref: "#/components/parameters/IdempotencyKey" },
  ]);
  assert.equal(collection.get.parameters, undefined);
  assert.deepEqual(revoke.parameters, [
    { $ref: "#/components/parameters/WorkspaceClaimId" },
  ]);
  assert.deepEqual(revoke.post.requestBody.content["application/json"].schema, {
    $ref: "#/components/schemas/EmptyObject",
  });
  assert.deepEqual(contract.components.schemas.EmptyObject, {
    type: "object",
    additionalProperties: false,
  });
  assert.match(collection.post.description, /SCOPE_NOT_HELD/);
  assert.match(collection.post.description, /do not retry an uncertain/);
  for (const response of [
    collection.post.responses["200"],
    collection.post.responses["201"],
    collection.get.responses["200"],
    revoke.post.responses["200"],
  ]) {
    assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
  }
});

test("creation documents replay, conflict, rate limit, and unavailable claims", () => {
  const create = contract.paths["/v1/workspace-claims"].post;
  assert.deepEqual(
    Object.keys(create.responses).sort(),
    ["200", "201", "400", "401", "403", "409", "429", "503", "default"].sort(),
  );
  for (const status of ["200", "201"]) {
    assert.equal(
      create.responses[status].content["application/json"].schema.$ref,
      "#/components/schemas/WorkspaceClaimResultResponse",
    );
  }
  assert.match(
    create.responses["409"].description,
    /INVITATION_ALREADY_PENDING/,
  );
  assert.match(create.responses["409"].description, /ALREADY_A_MEMBER/);
  assert.match(create.responses["400"].description, /INVALID_INPUT/);
  assert.match(create.responses["503"].description, /FEATURE_UNAVAILABLE/);
  assert.equal(
    create.responses["429"].$ref,
    "#/components/responses/WorkspaceClaimRateLimited",
  );
  assert.equal(
    contract.components.responses.WorkspaceClaimRateLimited.headers[
      "Retry-After"
    ].schema.minimum,
    1,
  );
  assert.equal(
    contract.components.responses.WorkspaceClaimError.headers["Cache-Control"]
      .schema.const,
    "no-store",
  );
  assert.equal(
    contract.paths["/v1/workspace-claims"].get.responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/WorkspaceClaimListResponse",
  );
  assert.equal(
    contract.paths["/v1/workspace-claims/{claimId}/revoke"].post.responses[
      "200"
    ].content["application/json"].schema.$ref,
    "#/components/schemas/WorkspaceClaimResponse",
  );
});

test("claim schemas are strict, owner-only, and reveal the token exactly once", () => {
  const schemas = contract.components.schemas;
  for (const name of [
    "WorkspaceClaim",
    "CreateWorkspaceClaimInput",
    "WorkspaceClaimResult",
    "WorkspaceClaimList",
  ]) {
    assert.equal(schemas[name].additionalProperties, false);
  }
  assert.deepEqual(schemas.WorkspaceClaim.required.slice().sort(), [
    "createdAt",
    "email",
    "expiresAt",
    "id",
    "organizationId",
    "role",
    "state",
  ]);
  assert.equal(schemas.WorkspaceClaim.properties.role.const, "owner");
  assert.deepEqual(schemas.WorkspaceClaim.properties.state.enum, [
    "pending",
    "accepted",
    "revoked",
  ]);
  assert.equal(schemas.WorkspaceClaim.properties.token, undefined);
  assert.equal(schemas.WorkspaceClaim.properties.claimUrl, undefined);
  assert.deepEqual(schemas.CreateWorkspaceClaimInput.required, ["email"]);
  assert.equal(
    schemas.CreateWorkspaceClaimInput.properties.email.maxLength,
    254,
  );
  assert.deepEqual(schemas.WorkspaceClaimResult.required.slice().sort(), [
    "claim",
    "claimUrl",
    "replayed",
    "token",
  ]);
  for (const field of ["token", "claimUrl"]) {
    assert.deepEqual(schemas.WorkspaceClaimResult.properties[field].type, [
      "string",
      "null",
    ]);
  }
  assert.match(
    schemas.WorkspaceClaimResult.properties.claimUrl.pattern,
    /#token=/,
  );
  assert.equal(schemas.WorkspaceClaimList.properties.items.maxItems, 100);
  assert.equal(schemas.Capabilities.properties.workspaceClaims.type, "boolean");
  assert.equal(
    schemas.Capabilities.required.includes("workspaceClaims"),
    false,
  );
});

test("the OpenAPI validator accepts fresh and replayed claim results", () => {
  const document = structuredClone(contract);
  const response =
    document.paths["/v1/workspace-claims"].post.responses["201"].content[
      "application/json"
    ];
  const claim = {
    id: "40000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    email: "gabriel@acme.com",
    role: "owner",
    state: "pending",
    expiresAt: "2026-09-13T01:00:00Z",
    createdAt: "2026-09-10T01:00:00Z",
  };
  const token = `dk_invite_${"A".repeat(43)}`;
  response.examples = {
    fresh: {
      value: {
        data: {
          claim,
          token,
          claimUrl: `https://console.daykeeper.example/claim#token=${token}`,
          replayed: false,
        },
      },
    },
    replayed: {
      value: {
        data: { claim, token: null, claimUrl: null, replayed: true },
      },
    },
  };
  const result = lintDocument(document, "claim-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the OpenAPI validator rejects leaked tokens, plaintext URLs, and bad addresses", () => {
  const document = structuredClone(contract);
  const list =
    document.paths["/v1/workspace-claims"].get.responses["200"].content[
      "application/json"
    ];
  const create =
    document.paths["/v1/workspace-claims"].post.requestBody.content[
      "application/json"
    ];
  const created =
    document.paths["/v1/workspace-claims"].post.responses["201"].content[
      "application/json"
    ];
  const claim = {
    id: "40000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000001",
    email: "gabriel@acme.com",
    role: "owner",
    state: "pending",
    expiresAt: "2026-09-13T01:00:00Z",
    createdAt: "2026-09-10T01:00:00Z",
  };
  const token = `dk_invite_${"A".repeat(43)}`;
  list.examples = {
    leaked: { value: { data: { items: [{ ...claim, token }] } } },
  };
  create.examples = {
    notAnAddress: { value: { email: "gabriel.acme.com" } },
  };
  created.examples = {
    queryToken: {
      value: {
        data: {
          claim,
          token,
          claimUrl: `https://console.daykeeper.example/claim?token=${token}`,
          replayed: false,
        },
      },
    },
  };
  const result = lintDocument(document, "claim-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems;
  for (const name of ["leaked", "notAnAddress", "queryToken"]) {
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
