import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  encodeWindowsOpenCommand,
  findAppBootModules,
  patchAppBootSingleton,
  patchDshManifest,
  patchDshMarketRoutes,
  patchWindowsPathOpener,
} from '../scripts/prepare-dependencies.mjs'

const ORIGINAL = `async function openWindowsPath(path, signal, run) {
\tawait run("powershell.exe", [
\t\t"-NoProfile",
\t\t"-Command",
\t\t\`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`
\t], signal);
}`

test('Windows path opener uses a UTF-16LE encoded PowerShell command', () => {
  const encoded = encodeWindowsOpenCommand("C:\\项目\\Steven's file.txt")
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf16le'),
    "Invoke-Item -LiteralPath 'C:\\项目\\Steven''s file.txt'",
  )
})

test('dependency patch replaces exactly the pinned Windows path opener', () => {
  const patched = patchWindowsPathOpener(`before\n${ORIGINAL}\nafter`)
  assert.match(patched, /Buffer\.from\(command, "utf16le"\)/)
  assert.match(patched, /"-EncodedCommand"/)
  assert.doesNotMatch(patched, /"-Command",/)
  assert.equal(patchWindowsPathOpener(patched), patched)
})

test('dependency patch fails loudly when upstream implementation drifts', () => {
  assert.throws(
    () => patchWindowsPathOpener('async function openWindowsPath() {}'),
    /Expected exactly one/,
  )
})

test('DSH dependency fallback pins the bundled plugin market', () => {
  const source = JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: {
      commander: '^15.0.0',
    },
  }, null, 2)
  const patched = patchDshManifest(source)
  assert.deepEqual(JSON.parse(patched).dependencies, {
    commander: '^15.0.0',
    dshmarket: '1.66.4',
  })
  assert.equal(patchDshManifest(patched), patched)
})

test('dshmarket global catalog falls back to the npm catalog package', () => {
  const source = `global: {
        npmRegistry: DEFAULT_NPM_REGISTRY,
        githubProxy: null,
        catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],
    },`
  const patched = patchDshMarketRoutes(source)
  assert.match(patched, /kind: 'npm', registry: DEFAULT_NPM_REGISTRY, pkg: CATALOG_PACKAGE/)
  assert.match(patched, /kind: 'url', url: CATALOG_OFFICIAL/)
  assert.equal(patchDshMarketRoutes(patched), patched)
})

test('dshmarket catalog patch fails loudly when upstream routing drifts', () => {
  assert.throws(() => patchDshMarketRoutes('global: {}'), /Expected exactly one/)
})

test('app-boot copies share one bootstrap Include registry across the process', () => {
  const source = 'const bootstrapIncludes = /* @__PURE__ */ new WeakMap();\n'
  const patched = patchAppBootSingleton(source)
  assert.match(patched, /globalThis\[Symbol\.for\('@deepseek-ai\/dsh-app-boot\/bootstrapIncludes'\)\] \?\?= new WeakMap\(\)/)
  assert.doesNotMatch(patched, /@__PURE__ \*\/ new WeakMap/)
  assert.equal(patchAppBootSingleton(patched), patched)
})

test('app-boot singleton patch fails loudly when the registry declaration drifts', () => {
  assert.throws(
    () => patchAppBootSingleton('const bootstrapIncludes = new Map();'),
    /Expected exactly one bootstrap Include registry, found 0/,
  )
})

test('every installed app-boot copy is discovered and patched', () => {
  const modules = findAppBootModules()
  assert.ok(modules.length > 0, 'expected at least one installed @deepseek-ai/dsh-app-boot')
  for (const target of modules) {
    assert.match(
      readFileSync(target, 'utf8'),
      /globalThis\[Symbol\.for\('@deepseek-ai\/dsh-app-boot\/bootstrapIncludes'\)\]/,
    )
  }
})
