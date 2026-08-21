import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import compression from 'vite-plugin-compression'

function wipeDir(dir: string): void {
  for (const name of readdirSync(dir)) {
    const filePath = path.join(dir, name)
    if (lstatSync(filePath).isDirectory()) wipeDir(filePath)
    else unlinkSync(filePath)
  }
  rmdirSync(dir)
}

function cleanOutDir(): Plugin {
  let root: string | undefined
  let outDir: string | undefined
  return {
    name: 'clean-out-dir',
    apply: 'build',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(config.root, config.build.outDir)
    },
    buildStart() {
      if (outDir && root && outDir !== root && existsSync(outDir)) wipeDir(outDir)
    },
  }
}

function removeUnusedOrtWasm(): Plugin {
  return {
    name: 'remove-unused-ort-wasm',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        const base = name.split('/').pop() ?? name
        if (base.startsWith('ort-wasm-') && base.endsWith('.wasm')) {
          delete bundle[name]
          console.log('[cleanup] dropped unused wasm asset:', name)
        }
      }
    },
  }
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    allowedHosts: ['.trycloudflare.com'],
  },
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  plugins: [
    cleanOutDir(),
    react(),
    compression({ algorithm: 'brotliCompress' }),
    removeUnusedOrtWasm(),
  ],
  build: {
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor';
          }
          if (id.includes('node_modules/onnxruntime-web')) {
            return 'ort';
          }
        },
      },
    },
  },
})
