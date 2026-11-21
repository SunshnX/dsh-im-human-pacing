/**
 * The exact file set this repository publishes.
 *
 * Keeping the list here means the published tree never picks up local test
 * output, editor files, or the installer link that lives in a profile. Paths
 * are repository-relative and always use `/`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Directories copied wholesale, in stable order. */
const INCLUDE_DIRECTORIES = ['lib', 'locale', 'docs', 'test', 'scripts']

/** Top-level files that belong in the repository. */
const INCLUDE_FILES = [
  '.gitignore',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'icon.svg',
  'index.js',
  'package.json',
]

function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/** @returns {{path: string, content: string}[]} repository files as text. */
export function planFiles() {
  const absolute = [
    ...INCLUDE_FILES.map((name) => join(root, name)),
    ...INCLUDE_DIRECTORIES.flatMap((name) => walk(join(root, name))),
  ]
  const files = []
  for (const path of absolute) {
    if (!statSync(path).isFile()) continue
    const repoPath = relative(root, path).split(sep).join('/')
    files.push({ path: repoPath, content: readFileSync(path, 'utf8') })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}
