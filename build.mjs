// dsh-voice build: esbuild-based, replicating the official tsdown.client.ts
// artifact shape for the client half; the host half is a plain ESM bundle
// with runtime deps (msedge-tts) external.

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

const PKG_ID = '@haoku123/dsh-voice'

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

mkdirSync('lib', { recursive: true })

// --- host half: plain ESM cordis plugin; runtime deps stay external ---
//
// msedge-tts is BUNDLED on purpose: dsh >= 0.2 routes CJS requires through its
// own resolver, which crashes on the browser-polyfill specifiers the package
// uses (`require('buffer/')`, `require('string_decoder/')`): the router sees
// the bare name "buffer", gets a null search-path list from Node (it is a
// builtin), and throws. Bundling resolves those at build time.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    'sherpa-onnx',
    // Optional native accelerators of ws; absence is handled by try/catch.
    'bufferutil',
    'utf-8-validate',
    'node:*',
  ],
  // Bundled CJS dependencies (axios via msedge-tts) call `require('util')`
  // dynamically. ESM has no require, so expose one built from this module's
  // URL; esbuild's __require helper picks it up.
  banner: {
    js:
      "import { createRequire as __dshCreateRequire } from 'node:module';\n" +
      'const require = __dshCreateRequire(import.meta.url);',
  },
  logLevel: 'info',
})

// --- client half: module-loader closure artifact ---
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

console.log('[dsh-voice] build done: lib/index.js (host) + lib/client.js (browser)')

// --- test surface: standalone modules for the plain-node tests ---
for (const [entry, outfile] of [
  ['src/segmenter.ts', 'lib/segmenter.js'],
  ['src/tts-queue.ts', 'lib/tts-queue.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
}
