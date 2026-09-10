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

const CLAIM = {
  id: "40000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000001",
  email: "gabriel@acme.com",
  role: "owner",
  state: "pending",
  expiresAt: "2026-09-13T01:00:00Z",
  createdAt: "2026-09-10T01:00:00Z",
  acceptedAt: null,
  revokedAt: null,
};
const TOKEN = `dk_invite_${"A".repeat(43)}`;
const FRESH = {
  claim: CLAIM,
  token: TOKEN,
  claimUrl: `https://console.daykeeper.example/claim#token=${TOKEN}`,
  replayed: false,
};
const REPLAY = { claim: CLAIM, token: null, claimUrl: null, replayed: true };

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

function mediaType(document, status) {
  return document.paths["/v1/workspace-claims"].post.responses[status].content[
    "application/json"
  ];
}

function invalidExampleNames(result) {
  const problems = JSON.parse(result.stdout).problems;
  const names = new Set();
  for (const problem of problems) {
    if (problem.ruleId !== "no-invalid-media-type-examples") continue;
    for (const location of problem.location) {
      const match = /\/examples\/([^/]+)\/value/.exec(location.pointer);
      if (match) names.add(match[1]);
    }
  }
  return names;
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
  assert.equal(
    create.responses["201"].content["application/json"].schema.$ref,
    "#/components/schemas/WorkspaceClaimCreatedResponse",
  );
  assert.equal(
    create.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/WorkspaceClaimReplayedResponse",
  );
  assert.match(
    create.responses["409"].description,
    /INVITATION_ALREADY_PENDING/,
  );
  assert.match(create.responses["409"].description, /ALREADY_A_MEMBER/);
  assert.match(create.responses["409"].description, /IDEMPOTENCY_KEY_REUSED/);
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
    "WorkspaceClaimCreated",
    "WorkspaceClaimReplayed",
    "WorkspaceClaimList",
  ]) {
    assert.equal(schemas[name].additionalProperties, false);
  }
  assert.deepEqual(schemas.WorkspaceClaim.required.slice().sort(), [
    "acceptedAt",
    "createdAt",
    "email",
    "expiresAt",
    "id",
    "organizationId",
    "revokedAt",
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
  // The lifecycle timestamps are always present and null until they happen, so
  // a client never has to tell "absent" apart from "has not happened yet".
  for (const name of ["acceptedAt", "revokedAt"]) {
    const property = schemas.WorkspaceClaim.properties[name];
    assert.deepEqual(property.type, ["string", "null"]);
    assert.equal(property.format, "date-time");
  }
  assert.deepEqual(schemas.CreateWorkspaceClaimInput.required, ["email"]);
  assert.equal(
    schemas.CreateWorkspaceClaimInput.properties.email.maxLength,
    254,
  );

  for (const name of ["WorkspaceClaimCreated", "WorkspaceClaimReplayed"]) {
    assert.deepEqual(schemas[name].required.slice().sort(), [
      "claim",
      "claimUrl",
      "replayed",
      "token",
    ]);
  }
  const created = schemas.WorkspaceClaimCreated.properties;
  assert.equal(created.token.type, "string");
  assert.equal(created.claimUrl.type, "string");
  assert.equal(created.replayed.const, false);
  assert.match(created.claimUrl.pattern, /#token=/);
  assert.match(created.token.pattern, /\^dk_invite_/);

  const replayed = schemas.WorkspaceClaimReplayed.properties;
  assert.equal(replayed.token.type, "null");
  assert.equal(replayed.claimUrl.type, "null");
  assert.equal(replayed.replayed.const, true);

  assert.deepEqual(schemas.WorkspaceClaimResult.oneOf, [
    { $ref: "#/components/schemas/WorkspaceClaimCreated" },
    { $ref: "#/components/schemas/WorkspaceClaimReplayed" },
  ]);
  assert.equal(schemas.WorkspaceClaimResult.type, undefined);

  assert.equal(schemas.Capabilities.properties.workspaceClaims.type, "boolean");
  assert.equal(
    schemas.Capabilities.required.includes("workspaceClaims"),
    false,
  );
});

test("the claim list is unbounded and documents its own ordering", () => {
  const items = contract.components.schemas.WorkspaceClaimList.properties.items;
  assert.equal(items.type, "array");
  assert.equal(items.maxItems, undefined);
  assert.equal(items.minItems, undefined);
  assert.match(items.description, /pending, accepted and revoked/i);
  assert.match(items.description, /expired\s+claims hidden/i);
  assert.match(items.description, /newest first/);
  assert.match(items.description, /hourly/);
  const list = contract.paths["/v1/workspace-claims"].get;
  assert.match(list.description, /no pagination in\s+v1/);
  assert.equal(list.parameters, undefined);
});

test("the email pattern accepts real addresses and rejects malformed ones", () => {
  const { pattern, maxLength } =
    contract.components.schemas.CreateWorkspaceClaimInput.properties.email;
  const expression = new RegExp(pattern);
  for (const address of [
    "gabriel@acme.com",
    "gabriel+claims@mail.acme.co.uk",
    "a@b.co",
    "first.last@sub.domain.example",
    "user!#$%&'*+/=?^_`{|}~-@example.com",
  ]) {
    assert.ok(expression.test(address), `expected ${address} to be accepted`);
    assert.ok(address.length <= maxLength);
  }
  for (const address of [
    ".@.",
    "user@.example",
    "User@acme.com",
    "gabriel.acme.com",
    ".gabriel@acme.com",
    "gabriel.@acme.com",
    "gabriel..b@acme.com",
    "gabriel@acme",
    "gabriel@-acme.com",
    "gabriel@acme-.com",
    "gabriel@acme.com ",
    "gabriel@ acme.com",
    "gabriel@@acme.com",
  ]) {
    assert.equal(
      expression.test(address),
      false,
      `expected ${address} to be rejected`,
    );
  }
});

test("the OpenAPI validator accepts a fresh 201 body and a replayed 200 body", () => {
  const document = structuredClone(contract);
  mediaType(document, "201").examples = { fresh: { value: { data: FRESH } } };
  mediaType(document, "200").examples = {
    replayed: { value: { data: REPLAY } },
  };
  document.paths["/v1/workspace-claims"].post.requestBody.content[
    "application/json"
  ].examples = {
    plain: { value: { email: "gabriel@acme.com" } },
    tagged: { value: { email: "gabriel+claims@mail.acme.co.uk" } },
  };
  const result = lintDocument(document, "claim-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the OpenAPI validator rejects each status carrying the other's body", () => {
  const document = structuredClone(contract);
  mediaType(document, "201").examples = {
    replayShapeUnder201: { value: { data: REPLAY } },
  };
  mediaType(document, "200").examples = {
    freshShapeUnder200: { value: { data: FRESH } },
  };
  const result = lintDocument(document, "claim-crossed-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const names = invalidExampleNames(result);
  for (const name of ["replayShapeUnder201", "freshShapeUnder200"]) {
    assert.ok(names.has(name), name);
  }
});

test("the OpenAPI validator rejects mismatched replayed flags", () => {
  const document = structuredClone(contract);
  mediaType(document, "201").examples = {
    freshFlaggedReplayed: { value: { data: { ...FRESH, replayed: true } } },
  };
  mediaType(document, "200").examples = {
    replayFlaggedFresh: { value: { data: { ...REPLAY, replayed: false } } },
  };
  const result = lintDocument(document, "claim-flag-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const names = invalidExampleNames(result);
  for (const name of ["freshFlaggedReplayed", "replayFlaggedFresh"]) {
    assert.ok(names.has(name), name);
  }
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
  list.examples = {
    leaked: { value: { data: { items: [{ ...CLAIM, token: TOKEN }] } } },
  };
  create.examples = {
    notAnAddress: { value: { email: "gabriel.acme.com" } },
    dotsOnly: { value: { email: ".@." } },
    emptyDomainLabel: { value: { email: "user@.example" } },
    uppercase: { value: { email: "User@acme.com" } },
    trailingLocalDot: { value: { email: "gabriel.@acme.com" } },
    noDotInDomain: { value: { email: "gabriel@acme" } },
  };
  mediaType(document, "201").examples = {
    queryToken: {
      value: {
        data: {
          ...FRESH,
          claimUrl: `https://console.daykeeper.example/claim?token=${TOKEN}`,
        },
      },
    },
  };
  const result = lintDocument(document, "claim-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const names = invalidExampleNames(result);
  for (const name of [
    "leaked",
    "notAnAddress",
    "dotsOnly",
    "emptyDomainLabel",
    "uppercase",
    "trailingLocalDot",
    "noDotInDomain",
    "queryToken",
  ]) {
    assert.ok(names.has(name), name);
  }
});

test("the two limits behind 429 and the authority denials are both documented", () => {
  // The hourly claim window and the generic request limiter are different
  // mechanisms with different codes. A client that only knows RATE_LIMITED
  // would misread the window, and one that only knows INVITATION_LIMIT_REACHED
  // would misread the limiter, so the contract names both.
  const create = contract.paths["/v1/workspace-claims"].post;
  const list = contract.paths["/v1/workspace-claims"].get;
  const revoke = contract.paths["/v1/workspace-claims/{claimId}/revoke"].post;
  assert.match(create.description, /INVITATION_LIMIT_REACHED/);
  assert.match(create.description, /RATE_LIMITED/);
  assert.match(create.responses["429"].description, /INVITATION_LIMIT_REACHED/);
  assert.match(create.responses["429"].description, /RATE_LIMITED/);
  const limited = contract.components.responses.WorkspaceClaimRateLimited;
  assert.match(limited.description, /INVITATION_LIMIT_REACHED/);
  assert.match(limited.description, /RATE_LIMITED/);
  assert.equal(limited.headers["Retry-After"].schema.minimum, 1);
  for (const operation of [create, list, revoke]) {
    assert.match(operation.responses["403"].description, /SCOPE_NOT_HELD/);
    assert.match(
      operation.responses["403"].description,
      /ORGANIZATION_ACCESS_REQUIRED/,
    );
  }
  assert.match(create.description, /ORGANIZATION_ACCESS_REQUIRED/);
  assert.match(revoke.responses["404"].description, /RESOURCE_NOT_FOUND/);
  assert.match(revoke.responses["409"].description, /RESOURCE_STATE_CONFLICT/);
});

test("the OpenAPI validator rejects a claim missing a lifecycle timestamp", () => {
  const document = structuredClone(contract);
  const { acceptedAt: _accepted, ...withoutAccepted } = CLAIM;
  const { revokedAt: _revoked, ...withoutRevoked } = CLAIM;
  document.paths["/v1/workspace-claims"].get.responses["200"].content[
    "application/json"
  ].examples = {
    missingAcceptedAt: { value: { data: { items: [withoutAccepted] } } },
    missingRevokedAt: { value: { data: { items: [withoutRevoked] } } },
  };
  const result = lintDocument(document, "claim-missing-timestamps");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const names = invalidExampleNames(result);
  for (const name of ["missingAcceptedAt", "missingRevokedAt"]) {
    assert.ok(names.has(name), name);
  }
});
