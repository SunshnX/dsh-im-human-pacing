/**
 * Cut a GitHub release for the current tree.
 *
 *   GITHUB_TOKEN=... node --use-system-ca scripts/release-github.mjs \
 *     --owner OWNER --repo NAME --tag v1.0.0 [--check]
 *
 * The release body is this version's section of CHANGELOG.md, so the notes stay
 * in one place. `--check` validates the arguments and prints what would happen
 * without touching GitHub. Re-running for an existing tag updates that release
 * instead of failing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const API = 'https://api.github.com'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { check: false, owner: null, repo: null, tag: null, target: 'main', name: null, prerelease: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--prerelease') options.prerelease = true
    else if (arg === '--owner') options.owner = argv[++index]
    else if (arg === '--repo') options.repo = argv[++index]
    else if (arg === '--tag') options.tag = argv[++index]
    else if (arg === '--target') options.target = argv[++index]
    else if (arg === '--name') options.name = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function fail(message, detail) {
  const error = new Error(message)
  if (detail !== undefined) error.detail = detail
  throw error
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'user-agent': 'dsh-im-human-pacing-releaser',
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { status: response.status, ok: response.ok, data, text }
}

/** Extract one release section from CHANGELOG.md, keyed by its version heading. */
export function changelogSection(markdown, version) {
  const lines = markdown.split('\n')
  const wanted = `## [${version}]`
  const start = lines.findIndex((line) => line.startsWith(wanted))
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## [')) {
      end = index
      break
    }
  }
  // Drop the heading itself and the link-reference footer of the file.
  const body = lines.slice(start + 1, end)
    .filter((line) => !/^\[.+?\]:\s+https?:/.test(line))
    .join('\n')
    .trim()
  return body
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = process.env.GITHUB_TOKEN
  if (!options.owner) fail('--owner is required')
  if (!options.repo) fail('--repo is required')
  if (!options.tag) fail('--tag is required')

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = options.tag.replace(/^v/, '')
  if (version !== manifest.version) {
    fail(`tag ${options.tag} does not match package.json version ${manifest.version}`)
  }
  const notes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
  if (!notes) fail(`CHANGELOG.md section for ${version} is empty`)

  const title = options.name ?? `${options.tag}`
  console.log(`tag:   ${options.tag}`)
  console.log(`name:  ${title}`)
  console.log(`notes: ${notes.split('\n').length} lines from CHANGELOG.md`)

  if (options.check) {
    console.log('--check: nothing sent to GitHub')
    return
  }
  if (!token) fail('GITHUB_TOKEN is not set in the environment')

  const me = await api(token, 'GET', '/user')
  if (!me.ok) fail(`token rejected (${me.status})`, me.text)
  if (me.data.login.toLowerCase() !== options.owner.toLowerCase()) {
    fail(`token belongs to ${me.data.login}, not ${options.owner}`)
  }

  const full = `/repos/${options.owner}/${options.repo}`
  const existing = await api(token, 'GET', `${full}/releases/tags/${options.tag}`)
  if (existing.ok) {
    const release = await api(token, 'PATCH', `${full}/releases/${existing.data.id}`, {
      tag_name: options.tag,
      target_commitish: options.target,
      name: title,
      body: notes,
      draft: false,
      prerelease: options.prerelease,
    })
    if (!release.ok) fail(`cannot update release (${release.status})`, release.text)
    console.log(`updated release ${release.data.html_url}`)
    return
  }
  if (existing.status !== 404) fail(`cannot read release (${existing.status})`, existing.text)

  const created = await api(token, 'POST', `${full}/releases`, {
    tag_name: options.tag,
    target_commitish: options.target,
    name: title,
    body: notes,
    draft: false,
    prerelease: options.prerelease,
  })
  if (!created.ok) fail(`cannot create release (${created.status})`, created.text)
  console.log(`created release ${created.data.html_url}`)
}

// Only run when executed directly; importing this module exposes the helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`release failed: ${error.message}`)
    if (error.detail) console.error(String(error.detail).slice(0, 800))
    process.exitCode = 1
  })
}
