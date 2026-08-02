import { readFile, writeFile } from "node:fs/promises"

import { updateCopyrightNotice } from "./lib/copyright-year.mjs"

const licensePath = "LICENSE"
const license = await readFile(licensePath, "utf8")
const updatedLicense = updateCopyrightNotice(license)

if (process.argv.includes("--check")) {
  if (updatedLicense !== license) throw new Error("LICENSE copyright year is stale; run npm run copyright:update")
  console.log("LICENSE copyright year is current")
} else if (updatedLicense === license) {
  console.log("LICENSE copyright year is already current")
} else {
  await writeFile(licensePath, updatedLicense)
  console.log("Updated LICENSE copyright year")
}
