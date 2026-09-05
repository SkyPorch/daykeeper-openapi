import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/@redocly/cli/bin/cli.js");
const nextActions = ["inspect_entitlements", "contact_organization_owner"];
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

function media(document) {
  return document.paths["/v1/entitlements"].get.responses["200"].content[
    "application/json"
  ];
}

function lintDocument(document, name) {
  const filename = path.join(directory, `${name}.json`);
  writeFileSync(filename, JSON.stringify(document));
  return redocly(["lint", filename, "--format", "json"]);
}

before(() => {
  directory = mkdtempSync(
    path.join(tmpdir(), "daykeeper-entitlements-contract-"),
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

test("tenant operation discovery is a tenant-scoped non-cacheable read with no mutation fallback", () => {
  assert.equal(
    typeof contract.components.securitySchemes.daykeeperOAuth.flows
      .clientCredentials.scopes["daykeeper.billing:read"],
    "string",
  );
  const route = contract.paths["/v1/tenants/{tenantId}/provisioning-operation"];
  assert.deepEqual(Object.keys(route).sort(), ["get", "parameters"]);
  assert.deepEqual(route.parameters, [
    { $ref: "#/components/parameters/TenantId" },
  ]);
  assert.equal(route.get.operationId, "getTenantProvisioningOperation");
  assert.deepEqual(route.get.security, [
    {
      daykeeperOAuth: [
        "daykeeper.accounts:read",
        "daykeeper.provisioning:read",
      ],
    },
  ]);
  assert.equal(route.get.parameters, undefined);
  assert.equal(route.get.requestBody, undefined);
  assert.equal(
    route.get.responses["200"].headers["Cache-Control"].schema.const,
    "no-store",
  );
  assert.equal(
    route.get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/OperationResponse",
  );
  for (const status of ["400", "401", "403", "404"])
    assert.equal(
      route.get.responses[status].$ref,
      "#/components/responses/Error",
    );
  assert.match(route.get.description, /never retries work/);
  assert.match(route.get.description, /older server/);
});

test("website preparation extends tenant plan/apply without changing existing operation kinds", () => {
  const schemas = contract.components.schemas;
  assert.equal(
    schemas.TenantSpec.properties.website.$ref,
    "#/components/schemas/WebsiteInboxSpec",
  );
  assert.equal(schemas.TenantSpec.required.includes("website"), false);
  assert.deepEqual(schemas.Operation.properties.kind.enum, [
    "tenant.provision",
    "channel.email.configure",
  ]);
  assert.equal(schemas.Capabilities.required.includes("websiteInboxes"), false);
  const path = contract.paths["/v1/tenants/{tenantId}/website-channel"];
  assert.deepEqual(Object.keys(path).sort(), ["get", "parameters"]);
  assert.equal(path.get.operationId, "getWebsiteChannel");
  assert.deepEqual(path.get.security, [
    { daykeeperOAuth: ["daykeeper.accounts:read"] },
  ]);
  assert.equal(
    path.get.responses["200"].headers["Cache-Control"].schema.const,
    "no-store",
  );
  assert.match(path.get.description, /never activates/);
  assert.equal(schemas.WebsiteChannel.additionalProperties, false);
  assert.equal(schemas.WebsiteChannel.properties.state.enum, undefined);
  assert.equal(
    schemas.WebsiteChannel.properties.trafficEnabled.type,
    "boolean",
  );
  assert.deepEqual(Object.keys(schemas.WebsiteChannel.properties).sort(), [
    "createdAt",
    "id",
    "organizationId",
    "spec",
    "state",
    "tenantId",
    "trafficEnabled",
    "updatedAt",
    "version",
  ]);
});

test("the OpenAPI validator accepts preparation-only status and legacy or opted-in tenant plans", () => {
  const document = structuredClone(contract);
  const request =
    document.paths["/v1/tenant-plans"].post.requestBody.content[
      "application/json"
    ];
  const account = {
    name: "Website account",
    slug: "website-account",
    locale: "en",
    administrator: { name: "Owner", email: "owner@example.test" },
  };
  request.examples = {
    legacy: { value: account },
    website: {
      value: {
        ...account,
        website: {
          websiteUrl: "https://EXAMPLE.test:443/",
          allowedOrigins: [
            "https://example.test",
            "https://other.example.test",
          ],
        },
      },
    },
  };
  const result = lintDocument(document, "website-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("TenantSpec allows machine-owned tenants without legacy administrator metadata", () => {
  const document = structuredClone(contract);
  const request =
    document.paths["/v1/tenant-plans"].post.requestBody.content[
      "application/json"
    ];
  request.examples = {
    machineOwned: {
      value: {
        name: "Machine workspace",
        slug: "machine-workspace",
        locale: "en",
      },
    },
  };
  const result = lintDocument(document, "machine-owned-tenant");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    contract.components.schemas.TenantSpec.required.includes("administrator"),
    false,
  );
  assert.deepEqual(
    Object.keys(
      contract.components.schemas.TenantSpec.properties.administrator
        .properties,
    ).sort(),
    ["email", "name"],
  );
});

test("TenantSpec keeps administrator metadata fields validated when supplied", () => {
  const document = structuredClone(contract);
  const request =
    document.paths["/v1/tenant-plans"].post.requestBody.content[
      "application/json"
    ];
  request.examples = {
    invalidPartialAdministrator: {
      value: {
        name: "Machine workspace",
        slug: "machine-workspace",
        locale: "en",
        administrator: { name: "Only a name" },
      },
    },
  };
  const result = lintDocument(document, "machine-administrator-validation");
  assert.notEqual(result.status, 0);
});

test("the OpenAPI validator rejects secret-bearing website metadata and unsafe request examples", () => {
  const document = structuredClone(contract);
  const response =
    document.paths["/v1/tenants/{tenantId}/website-channel"].get.responses[
      "200"
    ].content["application/json"];
  const mutations = {
    providerSecret: (data) => {
      data.apiToken = "must-never-be-returned";
    },
    providerInbox: (data) => {
      data.providerInboxId = "42";
    },
    missingActivationState: (data) => {
      delete data.trafficEnabled;
    },
    unsafeOrigin: (data) => {
      data.spec.allowedOrigins = ["https://example.test,evil.test"];
    },
    insecureUrl: (data) => {
      data.spec.websiteUrl = "http://example.test";
    },
    injectedSecurity: (data) => {
      data.spec.hmacMandatory = false;
    },
    emptyAllowlist: (data) => {
      data.spec.allowedOrigins = [];
    },
    duplicateOrigin: (data) => {
      data.spec.allowedOrigins = [
        "https://example.test",
        "https://example.test",
      ];
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = structuredClone(response.examples.prepared.value);
    mutate(value.data);
    response.examples[name] = { value };
  }
  const result = lintDocument(document, "website-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems.filter(
    (problem) =>
      problem.ruleId === "no-invalid-media-type-examples" &&
      problem.severity === "error",
  );
  for (const name of Object.keys(mutations))
    assert.ok(
      problems.some((problem) =>
        problem.location.some((location) =>
          location.pointer.includes(`/examples/${name}/value`),
        ),
      ),
      `Expected schema rejection for ${name}: ${result.stdout}`,
    );
});

test("entitlements are a non-cacheable current-organization read with exact account scope", () => {
  const item = contract.paths["/v1/entitlements"];
  assert.deepEqual(Object.keys(item), ["get"]);
  const operation = item.get;
  assert.equal(operation.operationId, "getEntitlements");
  assert.deepEqual(operation.security, [
    { daykeeperOAuth: ["daykeeper.accounts:read"] },
  ]);
  assert.equal(operation.parameters, undefined);
  assert.equal(operation.requestBody, undefined);
  assert.match(operation.description, /no organization selector/);
  assert.match(operation.description, /tenant-bound principal/);
  assert.deepEqual(Object.keys(operation.responses).sort(), [
    "200",
    "401",
    "403",
    "default",
  ]);
  assert.equal(
    operation.responses["200"].headers["Cache-Control"].schema.const,
    "no-store",
  );
  assert.equal(
    media(contract).schema.$ref,
    "#/components/schemas/EntitlementStatusResponse",
  );
  assert.deepEqual(
    Object.keys(contract.paths).filter((name) => /entitlement/i.test(name)),
    ["/v1/entitlements"],
  );
});

test("the provisional policy and deprecated admission-only meters retain wire compatibility", () => {
  const examples = media(contract).examples;
  assert.deepEqual(examples.available.value.data.policy, {
    version: "free-2026-08-31",
    plan: "free",
    provisional: true,
    tenantLimit: 1,
  });
  assert.deepEqual(examples.available.value.data.metering, {
    conversations: "not_enforced",
    storage: "not_enforced",
  });
  assert.equal(
    contract.components.schemas.EntitlementStatus.properties.metering
      .deprecated,
    true,
  );
  assert.equal(examples.unconfigured.value.data.policy, null);
  assert.equal(examples.unconfigured.value.data.assignmentVersion, null);
  assert.deepEqual(examples.unconfigured.value.data.tenantProvisioning, {
    enforced: true,
    allowed: false,
    used: 0,
    limit: null,
    remaining: null,
    denial: { code: "ENTITLEMENT_REQUIRED", retryable: false, nextActions },
  });
  // Clients must read the returned limit, not pin a provisional example as a
  // permanent commercial allowance.
  const limit =
    contract.components.schemas.EntitlementPolicy.properties.tenantLimit;
  assert.equal(limit.minimum, 1);
  assert.equal(limit.const, undefined);
  assert.equal(limit.enum, undefined);
});

test("usage is an organization-only billing read with no selectors or mutations", () => {
  const path = contract.paths["/v1/usage"];
  assert.deepEqual(Object.keys(path), ["get"]);
  assert.equal(path.get.operationId, "getUsage");
  assert.deepEqual(path.get.security, [
    { daykeeperOAuth: ["daykeeper.billing:read"] },
  ]);
  assert.equal(path.get.parameters, undefined);
  assert.equal(path.get.requestBody, undefined);
  assert.match(path.get.description, /Tenant-bound/);
  assert.match(
    path.get.responses["403"].description,
    /ORGANIZATION_ACCESS_REQUIRED/,
  );
  assert.equal(
    path.get.responses["200"].headers["Cache-Control"].schema.const,
    "no-store",
  );
  assert.equal(
    contract.components.schemas.Capabilities.required.includes("usage"),
    false,
  );
  assert.equal(
    contract.components.schemas.UsageStatus.properties.writeAdmission.const,
    "not_evaluated",
  );
  assert.equal(
    contract.components.schemas.UsageStatus.additionalProperties,
    false,
  );
});

test("validator accepts configured, paused and unconfigured recorded usage", () => {
  const document = structuredClone(contract);
  const examples =
    document.paths["/v1/usage"].get.responses["200"].content["application/json"]
      .examples;
  examples.paused = structuredClone(examples.active);
  examples.paused.value.data.state = "paused";
  const unconfigured = structuredClone(examples.active);
  Object.assign(unconfigured.value.data, {
    state: "unconfigured",
    assignmentVersion: null,
    policy: null,
    nextActions: ["contact_organization_owner"],
  });
  for (const resource of Object.values(unconfigured.value.data.resources))
    Object.assign(resource, {
      limit: null,
      remaining: null,
      limitReached: null,
    });
  examples.unconfigured = unconfigured;
  const result = lintDocument(document, "usage-valid-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("validator rejects unsafe or fabricated usage examples", () => {
  const document = structuredClone(contract);
  const examples =
    document.paths["/v1/usage"].get.responses["200"].content["application/json"]
      .examples;
  const mutations = {
    unsafeCount: (data) => {
      data.resources.messageRecords.used = 9007199254740992;
    },
    negativeCount: (data) => {
      data.resources.contactRecords.used = -1;
    },
    fractionalLimit: (data) => {
      data.resources.messageRecords.limit = 1.5;
    },
    excessLimit: (data) => {
      data.resources.messageRecords.limit = 100000001;
    },
    fabricatedAdmission: (data) => {
      data.writeAdmission = "allowed";
    },
    fabricatedBilling: (data) => {
      data.kind = "billable";
    },
    approvedPolicy: (data) => {
      data.policy.provisional = false;
    },
    providerSecret: (data) => {
      data.apiToken = "never-returned";
    },
    missingCounter: (data) => {
      delete data.resources.messageRecords;
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = structuredClone(examples.active.value);
    mutate(value.data);
    examples[name] = { value };
  }
  const result = lintDocument(document, "usage-invalid-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems.filter(
    (problem) =>
      problem.ruleId === "no-invalid-media-type-examples" &&
      problem.severity === "error",
  );
  for (const name of Object.keys(mutations))
    assert.ok(
      problems.some((problem) =>
        problem.location.some((location) =>
          location.pointer.includes(`/examples/${name}/value`),
        ),
      ),
      `Expected rejection for ${name}: ${result.stdout}`,
    );
});

test("new tenant admission documents all three stable non-retryable errors", () => {
  const responses = contract.paths["/v1/tenants:apply"].post.responses;
  const expected = [
    [
      "403",
      "entitlementRequired",
      "ENTITLEMENT_REQUIRED",
      "The organization needs an assigned entitlement before provisioning",
    ],
    [
      "403",
      "entitlementInactive",
      "ENTITLEMENT_INACTIVE",
      "The organization entitlement is not active for provisioning",
    ],
    [
      "409",
      "tenantQuotaExceeded",
      "TENANT_QUOTA_EXCEEDED",
      "The organization has reached its tenant provisioning allowance",
    ],
  ];
  for (const [status, name, code, message] of expected) {
    const error =
      responses[status].content["application/json"].examples[name].value.error;
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.retryable, false);
    assert.deepEqual(error.nextActions, nextActions);
    assert.equal(typeof error.correlationId, "string");
  }
  assert.deepEqual(
    contract.components.schemas.TenantAdmissionDenialCode.enum,
    expected.map(([, , code]) => code),
  );
  // Other existing conflict and authorization errors remain representable.
  assert.equal(
    contract.components.schemas.ErrorDetail.properties.code.enum,
    undefined,
  );
});

test("the OpenAPI validator accepts active, revoked, full, and unconfigured status shapes", () => {
  const document = structuredClone(contract);
  const examples = media(document).examples;
  const available = examples.available.value;
  const revoked = structuredClone(available);
  revoked.data.state = "revoked";
  revoked.data.assignmentVersion = 2;
  revoked.data.tenantProvisioning.allowed = false;
  revoked.data.tenantProvisioning.denial = {
    code: "ENTITLEMENT_INACTIVE",
    retryable: false,
    nextActions,
  };
  examples.revoked = { value: revoked };
  for (const used of [1, 3]) {
    const full = structuredClone(available);
    Object.assign(full.data.tenantProvisioning, {
      allowed: false,
      used,
      remaining: 0,
      denial: { code: "TENANT_QUOTA_EXCEEDED", retryable: false, nextActions },
    });
    examples[`full${used}`] = { value: full };
  }
  const existingUnconfigured = structuredClone(examples.unconfigured.value);
  existingUnconfigured.data.tenantProvisioning.used = 2;
  examples.existingUnconfigured = { value: existingUnconfigured };
  const result = lintDocument(document, "valid-status-examples");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the OpenAPI validator rejects malformed entitlement response examples", () => {
  const document = structuredClone(contract);
  const examples = media(document).examples;
  const mutations = {
    approvedPolicy: (data) => {
      data.policy.provisional = false;
    },
    zeroPolicyLimit: (data) => {
      data.policy.tenantLimit = 0;
    },
    negativeOccupancy: (data) => {
      data.tenantProvisioning.used = -1;
    },
    enforcedStorage: (data) => {
      data.metering.storage = "enforced";
    },
    missingConversationsMeter: (data) => {
      delete data.metering.conversations;
    },
    retryableDenial: (data) => {
      data.tenantProvisioning.denial = {
        code: "ENTITLEMENT_INACTIVE",
        retryable: true,
        nextActions,
      };
    },
    unknownDenial: (data) => {
      data.tenantProvisioning.denial = {
        code: "UNKNOWN_DENIAL",
        retryable: false,
        nextActions,
      };
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = structuredClone(examples.available.value);
    mutate(value.data);
    examples[name] = { value };
  }
  const result = lintDocument(document, "invalid-status-examples");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const problems = report.problems.filter(
    (problem) =>
      problem.ruleId === "no-invalid-media-type-examples" &&
      problem.severity === "error",
  );
  for (const name of Object.keys(mutations)) {
    assert.ok(
      problems.some((problem) =>
        problem.location.some((location) =>
          location.pointer.includes(`/examples/${name}/value`),
        ),
      ),
      `Expected a schema-validation failure for ${name}: ${result.stdout}`,
    );
  }
});
