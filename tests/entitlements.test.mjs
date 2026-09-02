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

test("the provisional policy and unenforced meters match the implementation", () => {
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
