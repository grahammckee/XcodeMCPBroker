import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

import { compareVersions, parseVersion } from "./lib/release-version.mjs"

const eventPath = process.env.GITHUB_EVENT_PATH
const outputPath = process.env.GITHUB_OUTPUT
if (!eventPath || !outputPath) throw new Error("GITHUB_EVENT_PATH and GITHUB_OUTPUT are required")

const event = JSON.parse(readFileSync(eventPath, "utf8"))
const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"))
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.[""]?.version) {
  throw new Error("package.json and package-lock.json versions are not synchronized")
}

let previousVersion = packageJson.version
if (event.before && !/^0+$/.test(event.before)) {
  const previousPackage = JSON.parse(execFileSync(
    "git",
    ["show", `${event.before}:package.json`],
    { encoding: "utf8" },
  ))
  previousVersion = previousPackage.version
}

const releaseRequired = packageJson.version !== previousVersion
if (releaseRequired && compareVersions(packageJson.version, previousVersion) <= 0) {
  throw new Error(`Release version ${packageJson.version} must be greater than ${previousVersion}`)
}

if (releaseRequired) {
  const currentCommit = event.after ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const tag = `v${packageJson.version}`
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`])
    const taggedCommit = execFileSync("git", ["rev-list", "-n", "1", tag], { encoding: "utf8" }).trim()
    if (taggedCommit !== currentCommit) throw new Error(`${tag} already points to ${taggedCommit}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${tag} already points`)) throw error
  }

  const otherVersions = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
    .split("\n")
    .filter(tagName => tagName && tagName !== tag)
    .flatMap(tagName => {
      try {
        parseVersion(tagName.slice(1))
        return [tagName.slice(1)]
      } catch {
        return []
      }
    })
  const latestOtherVersion = otherVersions.sort(compareVersions).at(-1)
  if (latestOtherVersion && compareVersions(packageJson.version, latestOtherVersion) <= 0) {
    throw new Error(`Release version ${packageJson.version} must be newer than existing tag v${latestOtherVersion}`)
  }
}

const values = {
  "release-required": String(releaseRequired),
  version: packageJson.version,
  "previous-version": previousVersion,
  tag: `v${packageJson.version}`,
}
for (const [name, value] of Object.entries(values)) appendFileSync(outputPath, `${name}=${value}\n`)
console.log(releaseRequired
  ? `Release ${values.tag} is required (previous version: ${previousVersion})`
  : `Version remains ${packageJson.version}; no release is required`)
