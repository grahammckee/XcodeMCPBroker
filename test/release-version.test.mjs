import assert from "node:assert/strict"
import test from "node:test"

import { compareVersions, nextVersion, validateReleaseIntent } from "../scripts/lib/release-version.mjs"

test("calculates each release increment", () => {
  assert.equal(nextVersion("1.2.3", "release:major"), "2.0.0")
  assert.equal(nextVersion("1.2.3", "release:minor"), "1.3.0")
  assert.equal(nextVersion("1.2.3", "release:patch"), "1.2.4")
  assert.equal(nextVersion("1.2.3", "release:none"), "1.2.3")
})

test("compares versions", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1)
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0)
  assert.equal(compareVersions("1.2.3", "2.0.0"), -1)
})

test("requires exactly one release label", () => {
  const input = {
    baseVersion: "1.0.0",
    packageVersion: "1.0.1",
    lockVersion: "1.0.1",
    lockRootVersion: "1.0.1",
  }
  assert.throws(() => validateReleaseIntent({ ...input, labels: [] }), /exactly one release label/)
  assert.throws(
    () => validateReleaseIntent({ ...input, labels: ["release:patch", "release:minor"] }),
    /exactly one release label/,
  )
})

test("validates package and lockfile versions", () => {
  assert.deepEqual(validateReleaseIntent({
    baseVersion: "1.0.4",
    labels: ["release:minor", "documentation"],
    packageVersion: "1.1.0",
    lockVersion: "1.1.0",
    lockRootVersion: "1.1.0",
  }), { label: "release:minor", expectedVersion: "1.1.0" })

  assert.throws(() => validateReleaseIntent({
    baseVersion: "1.0.4",
    labels: ["release:patch"],
    packageVersion: "1.0.5",
    lockVersion: "1.0.4",
    lockRootVersion: "1.0.5",
  }), /package-lock.json version/)
})
