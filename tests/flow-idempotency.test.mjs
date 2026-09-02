import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/@redocly/cli/bin/cli.js");
const keyParameter = { $ref: "#/components/parameters/IdempotencyKey" };
const organizationId = "10000000-0000-4000-8000-000000000001";
const tenantId = "20000000-0000-4000-8000-000000000001";
const flowId = "30000000-0000-4000-8000-000000000001";
let directory;
let contract;

function redocly(args) {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--config", path.join(root, "redocly.yaml")],
    {
      // CLI example validation is local; do not load a repository .env file.
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

function mutationOperations(document) {
  return [
    document.paths["/v1/tenants/{tenantId}/flows"].post,
    document.paths["/v1/flows/{flowId}/versions"].post,
    document.paths["/v1/flows/{flowId}/versions/{version}/publish"].post,
  ];
}

function flowMutationResult(replayed) {
  return {
    flow: {
      id: flowId,
      organizationId,
      tenantId,
      slug: "default-handoff",
      name: "Default Handoff",
      state: "published",
      latestVersion: 2,
      publishedVersion: 2,
      resourceVersion: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
    version: {
      flowId,
      organizationId,
      tenantId,
      version: 2,
      definition: {
        schemaVersion: "2026-08-01",
        trigger: { event: "conversation.created", channel: "email" },
        conditions: [],
        actions: [{ id: "priority", type: "set_priority", priority: "urgent" }],
      },
      contentHash: "a".repeat(64),
      createdBy: { actorId: "agent-1", actorType: "agent" },
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    replayed,
  };
}

before(() => {
  directory = mkdtempSync(
    path.join(tmpdir(), "daykeeper-flow-idempotency-contract-"),
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

test("every flow mutation requires the shared idempotency key", () => {
  for (const operation of mutationOperations(contract)) {
    assert.ok(
      operation.parameters.some(
        (parameter) => parameter.$ref === keyParameter.$ref,
      ),
      operation.operationId,
    );
    assert.match(operation.description, /Idempotency-Key/);
    assert.match(operation.description, /IDEMPOTENCY_KEY_REUSED \(409\)/);
    assert.match(operation.description, /outcomeUnknown/);
    assert.match(operation.description, /do not retry an uncertain mutation/);
    assert.equal(
      operation.responses["409"].$ref,
      "#/components/responses/IdempotencyKeyReused",
    );
    assert.match(operation.responses["400"].description, /INVALID_INPUT/);
  }
});

test("a valid key is accepted and a too-short key is not", () => {
  const parameter = contract.components.parameters.IdempotencyKey;
  assert.equal(parameter.name, "Idempotency-Key");
  assert.equal(parameter.in, "header");
  assert.equal(parameter.required, true);
  assert.match(parameter.description, /replay/i);
  assert.equal(parameter.schema.minLength, 16);
  assert.equal(parameter.schema.maxLength, 128);
  assert.equal(parameter.schema.pattern, "^[A-Za-z0-9._:-]{16,128}$");
  const accepts = new RegExp(parameter.schema.pattern);
  assert.equal(accepts.test("flow-create-api-0001"), true);
  assert.equal(accepts.test(`a:b.c-${"d".repeat(122)}`), true);
  // Fifteen characters: one short of the smallest accepted key.
  assert.equal(accepts.test("flow-create-000"), false);
  assert.equal(accepts.test("a".repeat(129)), false);
  assert.equal(accepts.test("flow create api 0001"), false);
});

test("create and revise answer 201 first and 200 on replay, publish always 200", () => {
  const create = contract.paths["/v1/tenants/{tenantId}/flows"].post;
  const revise = contract.paths["/v1/flows/{flowId}/versions"].post;
  const publish =
    contract.paths["/v1/flows/{flowId}/versions/{version}/publish"].post;
  for (const operation of [create, revise]) {
    assert.match(operation.responses["201"].description, /replayed is false/);
    assert.match(operation.responses["200"].description, /replayed is true/);
  }
  assert.equal(publish.responses["201"], undefined);
  assert.match(publish.responses["200"].description, /replayed is true/);
  for (const operation of mutationOperations(contract)) {
    for (const status of Object.keys(operation.responses)) {
      if (!status.startsWith("2")) continue;
      assert.equal(
        operation.responses[status].content["application/json"].schema.$ref,
        "#/components/schemas/FlowMutationResultResponse",
        `${operation.operationId} ${status}`,
      );
    }
  }
});

test("the mutation result carries replayed and stays open to new fields", () => {
  const result = contract.components.schemas.FlowMutationResult;
  assert.equal(result.additionalProperties, true);
  assert.deepEqual(result.required, ["flow", "version", "replayed"]);
  assert.equal(result.properties.replayed.type, "boolean");
  assert.deepEqual(result.properties.flow, {
    $ref: "#/components/schemas/Flow",
  });
  assert.deepEqual(result.properties.version, {
    $ref: "#/components/schemas/FlowVersion",
  });
  // The read-only view stays closed; only mutation results report a replay.
  assert.equal(contract.components.schemas.FlowWithVersion.required.length, 2);
});

test("the OpenAPI validator accepts fresh and replayed flow mutation results", () => {
  const document = structuredClone(contract);
  const media =
    document.paths["/v1/flows/{flowId}/versions"].post.responses["201"].content[
      "application/json"
    ];
  media.examples = {
    fresh: { value: { data: flowMutationResult(false) } },
    replayed: { value: { data: flowMutationResult(true) } },
    // Response envelopes are open, so a newer field must still validate.
    grown: {
      value: {
        data: {
          ...flowMutationResult(true),
          replayedAt: "2026-09-02T00:00:00Z",
        },
      },
    },
  };
  const result = lintDocument(document, "flow-mutation-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the OpenAPI validator rejects a mutation result without replayed", () => {
  const document = structuredClone(contract);
  const media =
    document.paths["/v1/flows/{flowId}/versions/{version}/publish"].post
      .responses["200"].content["application/json"];
  const { replayed: _omitted, ...withoutReplayed } = flowMutationResult(true);
  media.examples = {
    missingReplayed: { value: { data: withoutReplayed } },
  };
  const result = lintDocument(document, "flow-mutation-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems;
  assert.ok(
    problems.some(
      (problem) =>
        problem.ruleId === "no-invalid-media-type-examples" &&
        problem.location.some((location) =>
          location.pointer.includes("/examples/missingReplayed/value"),
        ),
    ),
    result.stdout,
  );
});

test("the reused-key response names its code, status, and next action", () => {
  const response = contract.components.responses.IdempotencyKeyReused;
  assert.match(response.description, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(response.description, /no write was applied/);
  assert.equal(
    response.content["application/json"].schema.$ref,
    "#/components/schemas/ErrorResponse",
  );
  const example =
    response.content["application/json"].examples.idempotencyKeyReused.value
      .error;
  assert.equal(example.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(example.retryable, false);
  assert.deepEqual(example.nextActions, ["use_new_idempotency_key"]);
});
