/** Build the scoped npm tarball without renaming the local/Release package. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scopedManifest, scopedNameOf, transformRegistrationFile } from './publish-scoped.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = path.resolve(process.argv[2] ?? '.')
const npm = (cwd, ...args) => execFileSync(process.execPath,
  [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', ...args],
  { cwd, encoding: 'utf8' })
const [source] = JSON.parse(npm(root, '--dry-run'))
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scoped-npm-'))
try {
  for (const { path: file } of source.files) {
    const target = path.join(staging, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, file), target)
  }

  const manifest = path.join(staging, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const scoped = scopedNameOf(pkg)
  fs.writeFileSync(manifest, JSON.stringify(scopedManifest(pkg, scoped), null, 2) + '\n')

  for (const file of ['client.js', 'cordis.patch.yml', 'src/updater.js']) {
    const target = path.join(staging, file)
    const text = fs.readFileSync(target, 'utf8')
    fs.writeFileSync(target, transformRegistrationFile(file, text, pkg.name, scoped))
  }

  const [packed] = JSON.parse(npm(staging, '--pack-destination', destination))
  console.log(path.join(destination, packed.filename))
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
