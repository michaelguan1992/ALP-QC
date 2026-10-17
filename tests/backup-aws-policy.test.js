import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AWS_DIRECTORY = path.join(PROJECT_ROOT, "deploy", "aws");

async function readPolicyFile(name) {
  return JSON.parse(await readFile(path.join(AWS_DIRECTORY, name), "utf8"));
}

// The lock lengths are defined once, in the backup script. The lifecycle file must follow them, so both are read here.
async function scriptLockDays() {
  const script = await readFile(path.join(PROJECT_ROOT, "deploy", "masterqc-backup.sh"), "utf8");
  const days = (name) => Number(script.match(new RegExp(`^${name}=(\\d+)$`, "m"))?.[1]);
  return {
    "half-hourly": days("HALF_HOURLY_LOCK_DAYS"),
    daily: days("DAILY_LOCK_DAYS"),
    monthly: days("MONTHLY_LOCK_DAYS"),
  };
}

test("the upload policy lets the backup job write and read back its own objects and nothing else", async () => {
  const policy = await readPolicyFile("iam-upload-policy.json");
  assert.equal(policy.Version, "2012-10-17");

  const allows = policy.Statement.filter((statement) => statement.Effect === "Allow");
  const denies = policy.Statement.filter((statement) => statement.Effect === "Deny");
  assert.equal(allows.length, 1, "exactly one Allow statement");
  assert.deepEqual([...allows[0].Action].sort(), [
    "s3:GetObject",
    "s3:GetObjectRetention",
    "s3:PutObject",
    "s3:PutObjectRetention",
  ]);
  // One bucket, limited to the backup prefix. The bucket name is a placeholder that the owner replaces.
  assert.match(allows[0].Resource, /^arn:aws:s3:::[^*/]+\/masterqc\/\*$/);

  // Explicit denies keep a later, broader policy from granting deletion, retention bypass, or bucket changes.
  const denied = new Set(denies.flatMap((statement) => statement.Action));
  for (const action of ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention", "s3:PutBucket*"]) {
    assert.ok(denied.has(action), `${action} must be denied`);
  }
  const denyResources = denies.flatMap((statement) => statement.Resource);
  assert.ok(denyResources.some((resource) => /^arn:aws:s3:::[^*/]+$/.test(resource)), "the bucket itself is covered");
  assert.ok(denyResources.some((resource) => /^arn:aws:s3:::[^*/]+\/\*$/.test(resource)), "the objects are covered");

  for (const action of allows[0].Action) {
    assert.doesNotMatch(action, /\*/, `${action} must not be a wildcard`);
    assert.doesNotMatch(action, /^s3:(Delete|BypassGovernance|PutBucket|ListBucket|PutLifecycle)/, `${action} is not needed`);
  }
});

test("the lifecycle file hides each tier one day after its lock and deletes the hidden copies a day later", async () => {
  const lifecycle = await readPolicyFile("lifecycle.json");
  const rules = new Map(lifecycle.Rules.map((rule) => [rule.ID, rule]));
  assert.equal(rules.size, lifecycle.Rules.length, "rule IDs are unique");

  assert.equal(rules.get("masterqc-half-hourly").Expiration.Days, 8);
  assert.equal(rules.get("masterqc-daily").Expiration.Days, 31);
  assert.equal(rules.get("masterqc-monthly").Expiration.Days, 367);

  const locks = await scriptLockDays();
  for (const [tier, lockDays] of Object.entries(locks)) {
    const rule = rules.get(`masterqc-${tier}`);
    assert.ok(rule, `a rule for the ${tier} tier`);
    assert.equal(rule.Status, "Enabled");
    assert.equal(rule.Filter.Prefix, `masterqc/${tier}/`);
    assert.equal(rule.Expiration.Days, lockDays + 1, `${tier} is hidden one day after its lock ends`);
    assert.equal(rule.NoncurrentVersionExpiration.NoncurrentDays, 1, `${tier} hidden copies are deleted a day later`);
  }

  const markers = rules.get("masterqc-delete-markers");
  assert.equal(markers.Expiration.ExpiredObjectDeleteMarker, true);
  assert.equal(markers.Expiration.Days, undefined, "a delete-marker rule has no day count");

  const abort = rules.get("abort-incomplete-uploads");
  assert.equal(abort.AbortIncompleteMultipartUpload.DaysAfterInitiation, 1);
});
