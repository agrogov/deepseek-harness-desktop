import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiProxyPath = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-host-apiproxy',
  'lib',
  'index.js',
)
const dshManifestPath = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const dshMarketRoutesPath = path.join(root, 'node_modules', 'dshmarket', 'lib', 'regions.js')
const windowsNodePath = path.join(root, 'assets', 'dsh-node.exe')
const nodeLicensePath = path.join(root, 'third-party-licenses', 'nodejs-LICENSE')
export const DSH_MARKET_VERSION = '1.66.4'

const ORIGINAL_GLOBAL_CATALOG = "catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],"
const PATCHED_GLOBAL_CATALOG = `catalog: [
            { kind: 'npm', registry: DEFAULT_NPM_REGISTRY, pkg: CATALOG_PACKAGE },
            { kind: 'url', url: CATALOG_OFFICIAL },
        ],`

const ORIGINAL_WINDOWS_OPENER = `async function openWindowsPath(path, signal, run) {
\tawait run("powershell.exe", [
\t\t"-NoProfile",
\t\t"-Command",
\t\t\`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`
\t], signal);
}`

const PATCHED_WINDOWS_OPENER = `async function openWindowsPath(path, signal, run) {
\tconst command = \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`;
\tconst encodedCommand = Buffer.from(command, "utf16le").toString("base64");
\tawait run("powershell.exe", [
\t\t"-NoLogo",
\t\t"-NoProfile",
\t\t"-NonInteractive",
\t\t"-EncodedCommand",
\t\tencodedCommand
\t], signal);
}`

export function encodeWindowsOpenCommand(targetPath) {
  const literal = `'${targetPath.replaceAll("'", "''")}'`
  const command = `Invoke-Item -LiteralPath ${literal}`
  return Buffer.from(command, 'utf16le').toString('base64')
}

export function patchWindowsPathOpener(source) {
  if (source.includes(PATCHED_WINDOWS_OPENER)) return source
  const matches = source.split(ORIGINAL_WINDOWS_OPENER).length - 1
  if (matches !== 1) {
    throw new Error(`Expected exactly one DeepSeek Harness Windows path opener, found ${matches}`)
  }
  return source.replace(ORIGINAL_WINDOWS_OPENER, PATCHED_WINDOWS_OPENER)
}

export function prepareApiProxy(target = apiProxyPath) {
  // DeepSeek Harness 0.1.2 removed this package. Keep the patch for older
  // supported releases, but do not make installation fail when it is absent.
  if (!existsSync(target)) return
  const source = readFileSync(target, 'utf8')
  const patched = patchWindowsPathOpener(source)
  if (patched !== source) writeFileSync(target, patched)
}

export function patchDshManifest(source) {
  const manifest = JSON.parse(source)
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.dependencies !== 'object') {
    throw new Error('Expected the @deepseek-ai/dsh package manifest')
  }
  if (manifest.dependencies.dshmarket === DSH_MARKET_VERSION) return source
  manifest.dependencies.dshmarket = DSH_MARKET_VERSION
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function prepareDshManifest(target = dshManifestPath) {
  const source = readFileSync(target, 'utf8')
  const patched = patchDshManifest(source)
  if (patched !== source) writeFileSync(target, patched)
}

// The settings nav-icon patch is gone: dshmarket 1.66+ claims its own settings
// row at runtime (its client swaps the shell's fallback gear for the market
// mark), so injecting a `market` glyph into the settings shell is redundant.
export function patchDshMarketRoutes(source) {
  if (source.includes(PATCHED_GLOBAL_CATALOG)) return source
  const matches = source.split(ORIGINAL_GLOBAL_CATALOG).length - 1
  if (matches !== 1) {
    throw new Error(`Expected exactly one dshmarket global catalog route, found ${matches}`)
  }
  return source.replace(ORIGINAL_GLOBAL_CATALOG, PATCHED_GLOBAL_CATALOG)
}

export function prepareDshMarketRoutes(target = dshMarketRoutesPath) {
  const source = readFileSync(target, 'utf8')
  const patched = patchDshMarketRoutes(source)
  if (patched !== source) writeFileSync(target, patched)
}

// DeepSeek Harness keeps its bootstrap Include entry in a module-private WeakMap
// inside `@deepseek-ai/dsh-app-boot`. Several shipped packages carry their own
// copy of that module (`@deepseek-ai/dsh-base` mounts the config editor and HMR,
// `@deepseek-ai/dsh-settings` and friends carry more), so the entry registered by
// the boot copy is invisible to every other copy. The lookup then misses and each
// profile-patch write is refused with "dsh: profile reload requires the root
// Include entry" — the error the Settings UI shows when a preset or any other
// setting is saved. Sharing one registry through `globalThis` gives every copy the
// boot copy's entry.
const ORIGINAL_BOOTSTRAP_INCLUDES = 'const bootstrapIncludes = /* @__PURE__ */ new WeakMap();'
const PATCHED_BOOTSTRAP_INCLUDES =
  "const bootstrapIncludes = globalThis[Symbol.for('@deepseek-ai/dsh-app-boot/bootstrapIncludes')] ??= new WeakMap();"

export function patchAppBootSingleton(source) {
  if (source.includes(PATCHED_BOOTSTRAP_INCLUDES)) return source
  const matches = source.split(ORIGINAL_BOOTSTRAP_INCLUDES).length - 1
  if (matches !== 1) {
    throw new Error(`Expected exactly one bootstrap Include registry, found ${matches}`)
  }
  return source.replace(ORIGINAL_BOOTSTRAP_INCLUDES, PATCHED_BOOTSTRAP_INCLUDES)
}

/**
 * Every installed copy of the boot module under one node_modules tree.
 * @param {string} [directory] a node_modules directory, or any directory to walk.
 * @returns {string[]} absolute paths of `@deepseek-ai/dsh-app-boot/lib/index.js`.
 */
export function findAppBootModules(directory = path.join(root, 'node_modules')) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return
      throw error
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.name === 'dsh-app-boot') {
        const candidate = path.join(child, 'lib', 'index.js')
        if (existsSync(candidate)) found.push(candidate)
        continue
      }
      // Symlinked package trees are not descended into: a linked copy is patched
      // at its real location, and following links here can revisit trees forever.
      if (entry.isDirectory()) walk(child)
    }
  }
  walk(directory)
  return found
}

export function prepareAppBootSingleton(directory) {
  for (const target of findAppBootModules(directory)) {
    const source = readFileSync(target, 'utf8')
    const patched = patchAppBootSingleton(source)
    if (patched !== source) writeFileSync(target, patched)
  }
}

export function findNodeLicense(executablePath = process.execPath) {
  const executableDirectory = path.dirname(executablePath)
  const candidates = [
    path.join(executableDirectory, 'LICENSE'),
    path.join(executableDirectory, 'LICENSE.md'),
    path.join(executableDirectory, '..', 'LICENSE'),
  ]
  return candidates.find(existsSync)
}

export function prepareWindowsNode({
  platform = process.platform,
  executablePath = process.execPath,
  outputPath = windowsNodePath,
  licenseOutputPath = nodeLicensePath,
} = {}) {
  if (platform !== 'win32') return
  const licensePath = findNodeLicense(executablePath)
  if (!licensePath) {
    throw new Error(`Could not find the Node.js license next to ${executablePath}`)
  }

  mkdirSync(path.dirname(outputPath), { recursive: true })
  mkdirSync(path.dirname(licenseOutputPath), { recursive: true })
  copyFileSync(executablePath, outputPath)
  copyFileSync(licensePath, licenseOutputPath)
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  prepareApiProxy()
  prepareDshManifest()
  prepareDshMarketRoutes()
  prepareAppBootSingleton()
  prepareWindowsNode()
}
