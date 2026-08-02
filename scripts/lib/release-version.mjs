export const releaseLabels = [
  "release:major",
  "release:minor",
  "release:patch",
  "release:none",
]

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new Error(`Invalid version: ${value}`)
  return match.slice(1).map(Number)
}

export function nextVersion(baseVersion, releaseLabel) {
  const [major, minor, patch] = parseVersion(baseVersion)
  switch (releaseLabel) {
    case "release:major": return `${major + 1}.0.0`
    case "release:minor": return `${major}.${minor + 1}.0`
    case "release:patch": return `${major}.${minor}.${patch + 1}`
    case "release:none": return baseVersion
    default: throw new Error(`Unknown release label: ${releaseLabel}`)
  }
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index])
  }
  return 0
}

export function validateReleaseIntent({ baseVersion, labels, packageVersion, lockVersion, lockRootVersion }) {
  const selected = labels.filter(label => releaseLabels.includes(label))
  if (selected.length !== 1) {
    throw new Error(`Expected exactly one release label (${releaseLabels.join(", ")}); found ${selected.length}`)
  }

  const expectedVersion = nextVersion(baseVersion, selected[0])
  const versions = [
    ["package.json", packageVersion],
    ["package-lock.json", lockVersion],
    ["package-lock.json root package", lockRootVersion],
  ]
  for (const [source, version] of versions) {
    if (version !== expectedVersion) {
      throw new Error(`${source} version ${version} does not match expected version ${expectedVersion}`)
    }
  }

  return { label: selected[0], expectedVersion }
}
