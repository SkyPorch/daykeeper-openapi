import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const WEB_CLIENT = "/v1/tenants/{tenantId}/web-client";
const ROTATE = "/v1/tenants/{tenantId}/web-client/publishable-key:rotate";
const KEY = "dk_pk_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const BODY = {
  tenantId: "20000000-0000-4000-8000-000000000001",
  state: "enabled",
  allowedOrigins: ["https://example.test"],
  publishableKey: KEY,
  previousKeyExpiresAt: null,
  greeting: null,
  accentColor: null,
  trafficEnabled: false,
  snippet: `<script async src="https://cdn.mydaykeeper.com/messenger/v1/messenger.js"></script>`,
  version: 1,
};
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
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-web-client-"));
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

test("the contract version is 1.7.0", () => {
  assert.equal(contract.info.version, "1.7.0");
});

test("web-client operations exist with the right scopes and tag", () => {
  const operations = [
    [contract.paths[WEB_CLIENT].get, "getWebClient", "daykeeper.accounts:read"],
    [
      contract.paths[WEB_CLIENT].put,
      "putWebClient",
      "daykeeper.accounts:write",
    ],
    [
      contract.paths[ROTATE].post,
      "rotateWebClientPublishableKey",
      "daykeeper.accounts:write",
    ],
  ];
  assert.ok(contract.tags.some((tag) => tag.name === "Web messenger"));
  for (const [operation, operationId, scope] of operations) {
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.tags, ["Web messenger"]);
    assert.deepEqual(operation.security, [
      { daykeeperOAuth: [scope] },
      { daykeeperServerKey: [] },
      { daykeeperMachineOwner: [] },
    ]);
    assert.deepEqual(operation["x-daykeeper-required-scopes"], [scope]);
    // Every success carries the version as an ETag and is never cached.
    for (const [status, response] of Object.entries(operation.responses)) {
      if (!/^2/.test(status)) continue;
      assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
      assert.deepEqual(response.headers.ETag, {
        $ref: "#/components/headers/WebClientETag",
      });
      assert.equal(
        response.content["application/json"].schema.$ref,
        "#/components/schemas/WebClientResponse",
      );
    }
    for (const status of ["401", "403", "404", "409"])
      assert.ok(operation.responses[status], `${operationId} ${status}`);
  }
  assert.deepEqual(contract.paths[ROTATE].parameters, [
    { $ref: "#/components/parameters/TenantId" },
  ]);
});

test("the first PUT creates (201), later PUTs replace (200)", () => {
  const put = contract.paths[WEB_CLIENT].put;
  assert.ok(put.responses["201"]);
  assert.ok(put.responses["200"]);
  assert.match(
    put.description,
    /omitted `greeting` or\s+`accentColor` is cleared/,
  );
  assert.match(
    put.description,
    /Without a precondition the PUT is unconditional/,
  );
});

test("PUT documents If-Match and create-only If-None-Match with 412", () => {
  const put = contract.paths[WEB_CLIENT].put;
  assert.deepEqual(put.parameters, [
    { $ref: "#/components/parameters/WebClientIfMatch" },
    { $ref: "#/components/parameters/WebClientIfNoneMatch" },
  ]);
  const parameters = contract.components.parameters;
  const ifMatch = parameters.WebClientIfMatch;
  assert.equal(ifMatch.name, "If-Match");
  assert.equal(ifMatch.in, "header");
  assert.equal(ifMatch.required, false);
  const pattern = new RegExp(ifMatch.schema.pattern);
  for (const value of ["3", '"3"', 'W/"3"']) assert.match(value, pattern);
  for (const value of ["*", "0", '"1", "2"'])
    assert.doesNotMatch(value, pattern);
  const ifNoneMatch = parameters.WebClientIfNoneMatch;
  assert.equal(ifNoneMatch.name, "If-None-Match");
  assert.equal(ifNoneMatch.in, "header");
  assert.equal(ifNoneMatch.required, false);
  assert.equal(ifNoneMatch.schema.const, "*");
  assert.match(put.responses["412"].description, /If-Match/);
  assert.match(put.responses["412"].description, /If-None-Match/);
  assert.match(put.responses["412"].description, /VERSION_CONFLICT/);
  assert.match(put.responses["400"].description, /sent together/);
  // Rotation is unconditional.
  assert.equal(contract.paths[ROTATE].post.parameters, undefined);
  assert.equal(contract.paths[ROTATE].post.responses["412"], undefined);
});

test("request bodies are closed, the WebClient response is open", () => {
  const schemas = contract.components.schemas;
  const input = schemas.WebClientInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["state", "allowedOrigins"]);
  assert.deepEqual(input.properties.state.enum, ["enabled", "disabled"]);
  assert.equal(input.properties.allowedOrigins.minItems, 1);
  assert.equal(input.properties.allowedOrigins.maxItems, 10);
  assert.equal(input.properties.allowedOrigins.items.maxLength, 2048);
  assert.equal(input.properties.accentColor.pattern, "^#[0-9a-fA-F]{6}$");
  const rotate = schemas.RotateWebClientPublishableKeyInput;
  assert.equal(rotate.additionalProperties, false);
  assert.deepEqual(rotate.required, ["graceSeconds"]);
  assert.equal(rotate.properties.graceSeconds.minimum, 0);
  assert.equal(rotate.properties.graceSeconds.maximum, 604800);

  const webClient = schemas.WebClient;
  assert.equal(webClient.additionalProperties, true);
  assert.deepEqual(new Set(webClient.required), new Set(Object.keys(BODY)));
  assert.equal(
    webClient.properties.publishableKey.pattern,
    "^dk_pk_[A-Za-z0-9]{32}$",
  );
  assert.match(webClient.properties.publishableKey.description, /not a secret/);
  assert.equal(webClient.properties.version.minimum, 1);

  const capability = schemas.Capabilities.properties.webClients;
  assert.equal(capability.additionalProperties, true);
  assert.deepEqual(capability.required, ["enabled", "loopbackOrigins"]);
  assert.equal(schemas.Capabilities.required.includes("webClients"), false);
});

test("the OpenAPI validator accepts real web clients and rejects bad input", () => {
  const document = structuredClone(contract);
  const put = document.paths[WEB_CLIENT].put;
  put.responses["201"].content["application/json"].examples = {
    created: { value: { data: BODY } },
    newerServer: { value: { data: { ...BODY, laterField: 1 } } },
  };
  put.requestBody.content["application/json"].examples = {
    minimal: {
      value: { state: "disabled", allowedOrigins: ["https://example.test"] },
    },
  };
  const valid = lintDocument(document, "web-client-valid");
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  for (const [name, value] of Object.entries({
    unknownField: {
      state: "enabled",
      allowedOrigins: ["https://example.test"],
      publishableKey: KEY,
    },
    noOrigins: { state: "enabled", allowedOrigins: [] },
    badColor: {
      state: "enabled",
      allowedOrigins: ["https://example.test"],
      accentColor: "red",
    },
  })) {
    const invalid = structuredClone(document);
    invalid.paths[WEB_CLIENT].put.requestBody.content[
      "application/json"
    ].examples = { [name]: { value } };
    const result = lintDocument(invalid, `web-client-invalid-${name}`);
    assert.notEqual(result.status, 0, name);
  }

  const rotate = structuredClone(document);
  rotate.paths[ROTATE].post.requestBody.content["application/json"].examples = {
    tooLong: { value: { graceSeconds: 604801 } },
  };
  const result = lintDocument(rotate, "web-client-invalid-grace");
  assert.notEqual(result.status, 0);
});
