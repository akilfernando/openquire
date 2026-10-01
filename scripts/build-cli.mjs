// Builds the command-line tool and Node library in cli/dist: the engine is bundled in, while
// MuPDF and Tesseract (WebAssembly with their own files) stay as package dependencies.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli')
const { version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'))
rmSync(join(cli, 'dist'), { recursive: true, force: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['mupdf', 'tesseract.js', '@tesseract.js-data/*'],
  define: { VERSION: JSON.stringify(version) },
  // Bundled CommonJS (node-forge) expects require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
}
await build({ ...common, entryPoints: [join(cli, 'src/bin.ts')], outfile: join(cli, 'dist/openquire.mjs'), banner: { js: '#!/usr/bin/env node\n' + common.banner.js } })
await build({ ...common, entryPoints: [join(cli, 'src/index.ts')], outfile: join(cli, 'dist/index.mjs') })
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(cli, 'tsconfig.json')], { stdio: 'inherit' })
copyFileSync(join(root, 'LICENSE'), join(cli, 'LICENSE'))
console.log(`Built openquire ${version} in cli/dist`)
