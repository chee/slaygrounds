import type { DocHandle } from "@automerge/vanillajs"
import esbuild from "esbuild-wasm"
import esbuildWasm from "esbuild-wasm/esbuild.wasm?url"
import esbuildVirtual from "./plugin-virtual.ts"
import { findEntryFileName } from "../util/path.ts"
import { solid } from "./plugin-solid.ts"
import { eternal } from "./plugin-dynamic-external.ts"
import { fileTreeToVirtualFileSystem } from "./virtual.ts"
import { Project } from "../../shape.ts"

let done = false
async function initializeEsbuild() {
  if (done) return
  await esbuild.initialize({ wasmURL: esbuildWasm })
  done = true
}

export default async function bundle(doc: Project, prefix = "") {
  await initializeEsbuild()
  const virtualFileSystem = fileTreeToVirtualFileSystem(
    doc.src,
    prefix,
  )

  const entry = findEntryFileName(doc)
  const jsxImportSource = doc.meta.jsxImportSource == "string"
    ? doc.meta.jsxImportSource
    : undefined

  const build = await esbuild.build({
    entryPoints: [`${prefix.endsWith("/") ? prefix : prefix + "/"}${entry}`],
    bundle: true,
    minify: false,
    sourcemap: "inline",
    format: "esm",
    treeShaking: true,
    loader: { ".css": "text" },
    plugins: [
      solid({ files: virtualFileSystem, jsxImportSource }),
      eternal,
      esbuildVirtual(virtualFileSystem),
    ],
    outdir: ".",
  })

  return build
}
