import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { compareVersions, parseVersion, validateReleaseIntent } from "./lib/release-version.mjs"

const eventPath = process.env.GITHUB_EVENT_PATH
if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required")

const event = JSON.parse(readFileSync(eventPath, "utf8"))
if (!event.pull_request) throw new Error("This check requires a pull_request event")

const basePackage = JSON.parse(execFileSync(
  "git",
  ["show", `${event.pull_request.base.sha}:package.json`],
  { encoding: "utf8" },
))
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"))
const result = validateReleaseIntent({
  baseVersion: basePackage.version,
  labels: event.pull_request.labels.map(label => label.name),
  packageVersion: packageJson.version,
  lockVersion: packageLock.version,
  lockRootVersion: packageLock.packages?.[""]?.version,
})

if (result.label !== "release:none") {
  const versions = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .flatMap(tag => {
      try {
        parseVersion(tag.slice(1))
        return [tag.slice(1)]
      } catch {
        return []
      }
    })
  const latestVersion = versions.sort(compareVersions).at(-1)
  if (latestVersion && compareVersions(result.expectedVersion, latestVersion) <= 0) {
    throw new Error(`Expected version ${result.expectedVersion} must be newer than existing tag v${latestVersion}`)
  }
}

console.log(`${result.label} requires version ${result.expectedVersion}`)
