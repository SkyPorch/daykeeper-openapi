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
function cli(args) {
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
function validate(examples, name) {
  const document = structuredClone(contract);
  document.components.responses.Error.content["application/json"].examples =
    examples;
  const file = path.join(directory, `${name}.json`);
  writeFileSync(file, JSON.stringify(document));
  return cli(["lint", file, "--format", "json"]);
}
before(() => {
  directory = mkdtempSync(path.join(tmpdir(), "daykeeper-customer-errors-"));
  const output = path.join(directory, "contract.json");
  const result = cli([
    "bundle",
    path.join(root, "openapi/customer.yaml"),
    "--output",
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  contract = JSON.parse(readFileSync(output, "utf8"));
});
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("customer error advice is optional, extensible and does not change legacy required fields", () => {
  const error = contract.components.schemas.CustomerError;
  assert.deepEqual(error.required, ["error"]);
  assert.equal(error.additionalProperties, true);
  assert.equal(error.properties.error.enum, undefined);
  assert.equal(error.properties.nextAction.enum, undefined);
  assert.equal(error.properties.retryable.type, "boolean");
  assert.match(
    error.properties.retryable.description,
    /do not automatically replay/,
  );
});
test("the actual OpenAPI validator accepts legacy, managed quota and newer-field responses", () => {
  const result = validate(
    {
      legacy: { value: { error: "expired_token" } },
      quota: {
        value: {
          error: "daykeeper_usage_limit_exceeded",
          message: "This workspace has reached its support usage limit.",
          retryable: false,
          nextAction: "review_usage",
        },
      },
      future: {
        value: {
          error: "future_code",
          retryable: true,
          nextAction: "future_action",
        },
      },
      unknownField: {
        value: { error: "quota", sqlDiagnostic: "added by a newer server" },
      },
    },
    "valid",
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
test("the actual OpenAPI validator rejects malformed hints and a missing error code", () => {
  const result = validate(
    {
      stringHint: { value: { error: "quota", retryable: "false" } },
      nullAction: { value: { error: "quota", nextAction: null } },
      missingError: { value: { message: "no stable code was supplied" } },
      longMessage: { value: { error: "quota", message: "x".repeat(181) } },
    },
    "invalid",
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const problems = JSON.parse(result.stdout).problems;
  for (const name of [
    "stringHint",
    "nullAction",
    "missingError",
    "longMessage",
  ]) {
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
