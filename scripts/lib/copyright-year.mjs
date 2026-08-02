const firstPublicationYear = 2026
const owner = "Graham McKee"
const noticePattern = /Copyright \(c\) \d{4}(?:-\d{4})? Graham McKee/

export function expectedCopyrightNotice(year = new Date().getUTCFullYear()) {
  if (!Number.isInteger(year) || year < firstPublicationYear) throw new Error(`Invalid copyright year: ${year}`)
  const years = year === firstPublicationYear ? String(year) : `${firstPublicationYear}-${year}`
  return `Copyright (c) ${years} ${owner}`
}

export function updateCopyrightNotice(license, year = new Date().getUTCFullYear()) {
  if (!noticePattern.test(license)) throw new Error("LICENSE does not contain the expected copyright notice")
  return license.replace(noticePattern, expectedCopyrightNotice(year))
}
