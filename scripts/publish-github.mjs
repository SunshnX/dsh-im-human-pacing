/**
 * Publish this bundle to GitHub through the REST API, without requiring a git
 * binary. Run from the package directory:
 *
 *   GITHUB_TOKEN=... node --use-system-ca scripts/publish-github.mjs \
 *     --owner OWNER --repo NAME [--check]
 *
 * The script reads GITHUB_TOKEN from the environment so the token never appears
 * in argv or in a committed file. `--check` performs every read-only step and
 * stops before creating anything.
 *
 * `--use-system-ca` is only needed where the Node binary does not ship the TLS
 * intermediate for api.github.com; on a normal Node install the flag is
 * harmless and can be dropped. The token must be a classic token with the
 * `repo` scope: a fine-grained token needs the Administration permission to
 * create a repository, which is not granted by default.
 */

const API = 'https://api.github.com'

function parseArgs(argv) {
  const options = { check: false, owner: null, repo: null, branch: 'main', message: null, dryList: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--dry-list') options.dryList = true
    else if (arg === '--owner') options.owner = argv[++index]
    else if (arg === '--repo') options.repo = argv[++index]
    else if (arg === '--branch') options.branch = argv[++index]
    else if (arg === '--message') options.message = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function fail(message, detail) {
  const error = new Error(message)
  if (detail !== undefined) error.detail = detail
  throw error
}

/** One authenticated GitHub REST call. `body` is sent as JSON when present. */
async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'user-agent': 'dsh-im-human-pacing-publisher',
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

/** Ask git to parse a raw object so the SHA-1 matches git semantics exactly. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = process.env.GITHUB_TOKEN
  if (!token) fail('GITHUB_TOKEN is not set in the environment')
  if (!options.owner) fail('--owner is required')
  if (!options.repo) fail('--repo is required')

  const files = planFiles()
  if (options.dryList) {
    for (const file of files) console.log(file.path, file.content.length)
    return
  }

  const me = await api(token, 'GET', '/user')
  if (!me.ok) fail(`token rejected (${me.status})`, me.text)
  const login = me.data.login
  console.log(`authenticated as ${login}`)

  if (login.toLowerCase() !== options.owner.toLowerCase()) {
    fail(`token belongs to ${login}, not ${options.owner}`)
  }

  const full = `/repos/${options.owner}/${options.repo}`
  let repo = await api(token, 'GET', full)
  if (repo.status === 404) {
    if (options.check) {
      console.log(`--check: repository ${options.owner}/${options.repo} does not exist yet`)
      return
    }
    const created = await api(token, 'POST', '/user/repos', {
      name: options.repo,
      description: 'DSH plugin: split one IM reply into several human-paced chat bubbles.',
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    })
    if (!created.ok) fail(`cannot create repository (${created.status})`, created.text)
    repo = { status: 200, ok: true, data: created.data, text: '' }
    console.log(`created repository ${repo.data.full_name}`)
  } else if (repo.ok) {
    console.log(`repository already exists: ${repo.data.full_name}`)
  } else {
    fail(`cannot read repository (${repo.status})`, repo.text)
  }

  if (options.check) {
    console.log(`--check: ${files.length} files staged, nothing written`)
    return
  }

  // Build a full tree so the first commit does not need a base tree.
  const treeEntries = files.map((file) => ({
    path: file.path,
    mode: '100644',
    type: 'blob',
    content: file.content,
  }))

  // A brand-new repository has no objects at all, and the git data API refuses
  // every write until one exists. Seeding a single file through the contents
  // API creates that first commit; the real tree then replaces both the file
  // and the branch tip.
  let seededFirstCommit = false
  let tree = await api(token, 'POST', `${full}/git/trees`, { tree: treeEntries })
  if (tree.status === 409) {
    console.log('repository is empty; seeding the first commit')
    const seed = await api(token, 'PUT', `${full}/contents/.gitattributes`, {
      message: 'chore: initialize repository',
      content: Buffer.from('* text=auto eol=lf\n', 'utf8').toString('base64'),
    })
    if (!seed.ok) fail(`cannot seed repository (${seed.status})`, seed.text)
    treeEntries.push({
      path: '.gitattributes',
      mode: '100644',
      type: 'blob',
      content: '* text=auto eol=lf\n',
    })
    seededFirstCommit = true
    tree = await api(token, 'POST', `${full}/git/trees`, { tree: treeEntries })
  }
  if (!tree.ok) fail(`cannot create tree (${tree.status})`, tree.text)
  console.log(`uploaded ${treeEntries.length} blobs; tree ${tree.data.sha}`)

  // Republishing must extend history, not rewrite it: an existing branch tip
  // becomes the parent, and the seed commit is collapsed into this one.
  let parents = []
  const existingRef = await api(token, 'GET', `${full}/git/ref/heads/${options.branch}`)
  if (existingRef.ok && existingRef.data?.object?.sha) {
    parents = [existingRef.data.object.sha]
    if (seededFirstCommit) {
      const seedCommit = await api(token, 'GET', `${full}/git/commits/${existingRef.data.object.sha}`)
      const seedParents = seedCommit.ok ? (seedCommit.data.parents ?? []) : []
      parents = seedParents.map((parent) => parent.sha)
      if (parents.length === 0) {
        // Nothing to keep: the branch only holds the bootstrap commit.
        console.log('replacing the bootstrap commit')
      }
    }
  }

  const message = options.message ?? 'Initial commit: DSH plugin for human-paced IM replies'
  const commit = await api(token, 'POST', `${full}/git/commits`, {
    message,
    tree: tree.data.sha,
    parents,
  })
  if (!commit.ok) fail(`cannot create commit (${commit.status})`, commit.text)
  console.log(`created commit ${commit.data.sha} (parents: ${parents.length})`)

  let ref
  if (existingRef.ok) {
    ref = await api(token, 'PATCH', `${full}/git/refs/heads/${options.branch}`, {
      sha: commit.data.sha,
      force: parents.length === 0,
    })
  } else {
    ref = await api(token, 'POST', `${full}/git/refs`, {
      ref: `refs/heads/${options.branch}`,
      sha: commit.data.sha,
    })
  }
  if (!ref.ok) fail(`cannot update branch (${ref.status})`, ref.text)
  console.log(`branch ${options.branch} now points at ${commit.data.sha}`)

  const updated = await api(token, 'PATCH', full, { default_branch: options.branch })
  if (!updated.ok) console.log(`warning: cannot set default branch (${updated.status})`)

  if (repo.data?.private !== false) {
    console.log('note: repository is currently private')
  }
  console.log(`done: https://github.com/${options.owner}/${options.repo}`)
}

// Imported last so `--dry-list` stays usable without the file planner failing.
const { planFiles } = await import('./repo-files.mjs')

main().catch((error) => {
  console.error(`publish failed: ${error.message}`)
  if (error.detail) console.error(String(error.detail).slice(0, 800))
  process.exitCode = 1
})
