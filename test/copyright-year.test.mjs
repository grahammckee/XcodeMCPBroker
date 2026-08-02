import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { expectedCopyrightNotice, updateCopyrightNotice } from "../scripts/lib/copyright-year.mjs"

test("preserves the first publication year and extends later years", () => {
  assert.equal(expectedCopyrightNotice(2026), "Copyright (c) 2026 Graham McKee")
  assert.equal(expectedCopyrightNotice(2027), "Copyright (c) 2026-2027 Graham McKee")
})

test("LICENSE uses the current UTC year", async () => {
  const license = await readFile("LICENSE", "utf8")
  assert.equal(updateCopyrightNotice(license), license)
})
