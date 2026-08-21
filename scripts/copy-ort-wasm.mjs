import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const src = resolve('node_modules/onnxruntime-web/dist')
const dest = resolve('public/ort-wasm')
const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

if (!existsSync(src)) {
  console.warn('[copy-ort-wasm] onnxruntime-web 未安装，跳过')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })

for (const name of files) {
  const from = resolve(src, name)
  if (!existsSync(from)) {
    console.warn(`[copy-ort-wasm] 缺少 ${name}，跳过`)
    continue
  }
  copyFileSync(from, resolve(dest, name))
}

console.log(`[copy-ort-wasm] copied ${files.length} files to public/ort-wasm`)
