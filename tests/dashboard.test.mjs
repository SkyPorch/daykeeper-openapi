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

const TENANT = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION = "10000000-0000-4000-8000-000000000001";
const CONVERSATION = {
  id: 42,
  status: "open",
  preview: "Where is my order?",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:05:00Z",
};
const MESSAGE = {
  id: 7,
  conversationId: 42,
  senderType: "contact",
  messageType: 0,
  content: "Where is my order?",
  createdAt: "2026-10-01T10:00:00Z",
};
const PAGE = { limit: 50, nextCursor: "eyJwYWdlIjoyfQ", hasMore: true };
const LAST_PAGE = { limit: 50, nextCursor: null, hasMore: false };

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

function json(document, route, method, status) {
  const operation = document.paths[route][method];
  const target =
    status === "request" ? operation.requestBody : operation.responses[status];
  return target.content["application/json"];
}

/** Lints `valid` examples (must pass) and `invalid` ones (each must fail). */
function assertExamples(name, route, method, status, valid, invalid) {
  const accepting = structuredClone(contract);
  json(accepting, route, method, status).examples = Object.fromEntries(
    Object.entries(valid).map(([key, value]) => [key, { value }]),
  );
  const accepted = lintDocument(accepting, `${name}-valid`);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

  const refusing = structuredClone(contract);
  json(refusing, route, method, status).examples = Object.fromEntries(
    Object.entries(invalid).map(([key, value]) => [key, { value }]),
  );
  const refused = lintDocument(refusing, `${name}-invalid`);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(
    [...invalidExampleNames(refused)].sort(),
    Object.keys(invalid).sort(),
  );
}

const LIST = "/v1/tenants/{tenantId}/conversations";
const DETAIL = "/v1/tenants/{tenantId}/conversations/{conversationId}";
const MESSAGES =
  "/v1/tenants/{tenantId}/conversations/{conversationId}/messages";
const CUSTOMER_EMAIL = "/v1/tenants/{tenantId}/customer-email";

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-dashboard-contract-"));
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

test("profile and workspaces are human OAuth reads that are never cached", () => {
  for (const [route, operationId] of [
    ["/v1/profile", "getProfile"],
    ["/v1/workspaces", "listWorkspaces"],
  ]) {
    const operation = contract.paths[route].get;
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [
      { daykeeperOAuth: ["daykeeper.accounts:read"] },
    ]);
    assert.equal(
      operation.responses["200"].headers["Cache-Control"].schema.const,
      "no-store",
    );
    assert.match(operation.description, /receive\s+401/);
    assert.equal(Object.keys(contract.paths[route]).length, 1, route);
  }
  const schemas = contract.components.schemas;
  assert.equal(schemas.Profile.additionalProperties, true);
  assert.equal(schemas.Workspace.additionalProperties, true);
  // The deployed server does not report a role; the contract must not
  // require one.
  assert.equal(schemas.Workspace.required.includes("role"), false);
});

test("the OpenAPI validator accepts deployed profile and workspace bodies", () => {
  const workspace = {
    organizationId: ORGANIZATION,
    organizationSlug: "acme",
    name: "Acme",
  };
  assertExamples(
    "profile",
    "/v1/profile",
    "get",
    "200",
    {
      deployed: {
        data: {
          userId: "30000000-0000-4000-8000-000000000001",
          name: "Sophie",
          email: "sophie@acme.com",
          organizationId: ORGANIZATION,
          workspace,
        },
      },
    },
    {
      missingWorkspace: {
        data: {
          userId: "30000000-0000-4000-8000-000000000001",
          name: "Sophie",
          email: "sophie@acme.com",
          organizationId: ORGANIZATION,
        },
      },
    },
  );
  assertExamples(
    "workspaces",
    "/v1/workspaces",
    "get",
    "200",
    {
      deployed: { data: { items: [workspace] } },
      withRole: { data: { items: [{ ...workspace, role: "owner" }] } },
    },
    { notAList: { data: { items: workspace } } },
  );
});

test("conversation and message lists page with the server's own bounds", () => {
  for (const route of [LIST, MESSAGES]) {
    const parameters = Object.fromEntries(
      contract.paths[route].get.parameters
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => [parameter.name, parameter]),
    );
    assert.deepEqual(Object.keys(parameters).sort(), ["cursor", "limit"]);
    assert.equal(parameters.cursor.required, false);
    assert.equal(parameters.cursor.schema.maxLength, 256);
    assert.equal(parameters.limit.required, false);
    assert.equal(parameters.limit.schema.minimum, 1);
    assert.equal(parameters.limit.schema.maximum, 100);
    assert.equal(parameters.limit.schema.default, 50);
    const description = contract.paths[route].get.description.replace(
      /\s+/g,
      " ",
    );
    // Opt-in: without limit or cursor the 1.8 representation is preserved.
    assert.match(description, /Pagination is opt-in from 1\.9\.0/);
    assert.match(description, /sends neither receives the 1\.8 representation/);
    assert.match(description, /never send `page`/);
  }
  const schemas = contract.components.schemas;
  for (const name of [
    "OperatorConversationList",
    "OperatorConversationMessages",
  ]) {
    assert.equal(schemas[name].additionalProperties, true, name);
    assert.equal(schemas[name].required.includes("page"), false, name);
  }
  // The existing hard bounds remain.
  assert.equal(
    schemas.OperatorConversationList.properties.conversations.maxItems,
    100,
  );
  assert.equal(
    schemas.OperatorConversationMessages.properties.messages.maxItems,
    200,
  );
});

test("the OpenAPI validator accepts paged and older-server list bodies", () => {
  assertExamples(
    "conversation-list",
    LIST,
    "get",
    "200",
    {
      paged: {
        data: { tenantId: TENANT, conversations: [CONVERSATION], page: PAGE },
      },
      lastPage: {
        data: { tenantId: TENANT, conversations: [], page: LAST_PAGE },
      },
      olderServer: {
        data: { tenantId: TENANT, conversations: [CONVERSATION] },
      },
    },
    {
      longCursor: {
        data: {
          tenantId: TENANT,
          conversations: [],
          page: { ...PAGE, nextCursor: "a".repeat(257) },
        },
      },
      missingHasMore: {
        data: {
          tenantId: TENANT,
          conversations: [],
          page: { limit: 50, nextCursor: null },
        },
      },
    },
  );
  assertExamples(
    "message-list",
    MESSAGES,
    "get",
    "200",
    {
      paged: {
        data: {
          tenantId: TENANT,
          conversationId: 42,
          messages: [MESSAGE],
          page: PAGE,
        },
      },
      olderServer: {
        data: { tenantId: TENANT, conversationId: 42, messages: [MESSAGE] },
      },
    },
    {
      overLimit: {
        data: {
          tenantId: TENANT,
          conversationId: 42,
          messages: [],
          page: { ...PAGE, limit: 101 },
        },
      },
    },
  );
});

test("one conversation can be read and only its status changed", () => {
  const item = contract.paths[DETAIL];
  assert.equal(item.get.operationId, "getOperatorConversation");
  assert.equal(item.patch.operationId, "setOperatorConversationStatus");
  assert.deepEqual(item.get.security, [
    { daykeeperOAuth: ["daykeeper.conversations:read"] },
    { daykeeperServerKey: [] },
  ]);
  assert.deepEqual(item.patch.security, [
    { daykeeperOAuth: ["daykeeper.conversations:write"] },
    { daykeeperServerKey: [] },
  ]);
  assert.ok(item.get.responses["404"]);
  assert.ok(item.patch.responses["404"]);
  const input = contract.components.schemas.OperatorConversationStatusInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["status"]);
  assert.deepEqual(
    contract.components.schemas.OperatorConversationStatus.enum,
    ["open", "resolved"],
  );
  assert.match(item.patch.description, /confirms the requested status/);

  assertExamples(
    "status-input",
    DETAIL,
    "patch",
    "request",
    { resolve: { status: "resolved" }, reopen: { status: "open" } },
    {
      pending: { status: "pending" },
      extraField: { status: "open", assignee: 1 },
    },
  );
  assertExamples(
    "status-result",
    DETAIL,
    "patch",
    "200",
    {
      resolved: {
        data: {
          tenantId: TENANT,
          conversationId: 42,
          conversation: { ...CONVERSATION, status: "resolved" },
        },
      },
    },
    {
      missingConversation: { data: { tenantId: TENANT, conversationId: 42 } },
    },
  );
});

test("replies stay compatible without a key and replay with one", () => {
  const reply = contract.paths[MESSAGES].post;
  const key = reply.parameters.find(
    (parameter) => parameter.name === "Idempotency-Key",
  );
  assert.equal(key.in, "header");
  assert.equal(key.required, false);
  assert.equal(key.schema.format, "uuid");
  for (const status of ["200", "201", "409"])
    assert.ok(reply.responses[status]);
  assert.match(reply.description, /behavior before 1\.9\.0, still accepted/);
  assert.match(reply.description, /answers 409/);
  assert.match(reply.description, /FEATURE_UNAVAILABLE \(503\)/);
  assert.deepEqual(
    reply.responses["200"].content["application/json"].schema,
    reply.responses["201"].content["application/json"].schema,
  );
});

test("customer email reads for members and writes for human owners", () => {
  const item = contract.paths[CUSTOMER_EMAIL];
  assert.deepEqual(item.get.security, [
    { daykeeperOAuth: ["daykeeper.accounts:read"] },
  ]);
  assert.deepEqual(item.post.security, [
    { daykeeperOAuth: ["daykeeper.accounts:write"] },
  ]);
  assert.match(item.get.description, /members can read/);
  assert.match(item.post.description, /human principal/);
  for (const method of ["get", "post"])
    assert.equal(
      item[method].responses["200"].headers["Cache-Control"].schema.const,
      "no-store",
    );
  const input = contract.components.schemas.CustomerEmailInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["enabled"]);

  const deployed = {
    data: {
      tenantId: TENANT,
      enabled: true,
      customSender: false,
      senderName: "Acme",
      sendingDomain: "mail.mydaykeeper.com",
      deliveryEnabled: true,
    },
  };
  assertExamples(
    "customer-email",
    CUSTOMER_EMAIL,
    "get",
    "200",
    {
      deployed,
      noDelivery: {
        data: { ...deployed.data, sendingDomain: null, deliveryEnabled: false },
      },
    },
    {
      // The deployed server reports customSender as a boolean.
      stringSender: {
        data: { ...deployed.data, customSender: "help@acme.com" },
      },
      nullName: { data: { ...deployed.data, senderName: null } },
    },
  );
  assertExamples(
    "customer-email-input",
    CUSTOMER_EMAIL,
    "post",
    "request",
    { on: { enabled: true } },
    {
      extraField: { enabled: true, senderName: "x" },
      stringFlag: { enabled: "yes" },
    },
  );
});

test("human-only routes document an authorization code flow", () => {
  const flows = contract.components.securitySchemes.daykeeperOAuth.flows;
  assert.ok(flows.clientCredentials, "machine flow stays");
  const human = flows.authorizationCode;
  assert.match(human.authorizationUrl, /^https:\/\//);
  assert.match(human.tokenUrl, /^https:\/\//);
  for (const scope of [
    "daykeeper.accounts:read",
    "daykeeper.accounts:write",
    "daykeeper.billing:read",
    "daykeeper.conversations:read",
    "daykeeper.conversations:write",
  ])
    assert.ok(human.scopes[scope], scope);
  for (const operation of [
    contract.paths["/v1/profile"].get,
    contract.paths["/v1/workspaces"].get,
    contract.paths[CUSTOMER_EMAIL].post,
  ])
    assert.match(operation.description, /authorization\s+code/);
});

test("capabilities describe the Dashboard features as optional and open", () => {
  const capabilities = contract.components.schemas.Capabilities;
  for (const name of [
    "operatorConversations",
    "customerEmail",
    "dashboardIdentity",
  ]) {
    assert.equal(capabilities.required.includes(name), false, name);
    assert.equal(
      capabilities.properties[name].additionalProperties,
      true,
      name,
    );
    assert.deepEqual(capabilities.properties[name].required, ["enabled"], name);
  }
  assert.deepEqual(
    Object.keys(
      capabilities.properties.operatorConversations.properties,
    ).sort(),
    ["enabled", "idempotentReplies", "pagination", "statusUpdates"],
  );
  // One flag covers both methods on the single-conversation path.
  assert.match(
    capabilities.properties.operatorConversations.properties.statusUpdates
      .description,
    /GET .* and PATCH/,
  );
});
