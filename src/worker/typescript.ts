import * as Comlink from "comlink"
import {
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs"
import ts from "typescript"
import { createWorker } from "@valtown/codemirror-ts/worker"
import { setupTypeAcquisition } from "@typescript/ata"
import fsMap from "./libmap/_map.ts"
import type { Remote } from "comlink"
import { AutomergeUrl } from "@automerge/vanillajs"
import { Project } from "../shape.ts"
import { walkies } from "./babel/walk-imports.ts"
import { fetchXTypescriptTypes } from "./types/x-typescript-types.ts"
import { cd } from "./util/path.ts"

// import { fetchXTypescriptTypes as fetchXTypescriptTypes } from "./types/x-typescript-types.ts"

const compilerOptions = {
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  lib: ["esnext", "dom"],
  module: ts.ModuleKind.ESNext,
  allowJs: true,
  checkJs: true,
  noEmit: true,
  composite: true,
  strict: true,
} as ts.CompilerOptions

const vfs = (async function () {
  // await
  const system = createSystem(fsMap)
  const vfs = createVirtualTypeScriptEnvironment(
    system,
    [],
    ts,
    compilerOptions,
  )
  return vfs
})()

const codemirrorTsWorker = createWorker({
  env: vfs,
  async onFileUpdated(env, filePath, code) {
    ata(code, filePath)
  },
})

const typescriptATA = setupTypeAcquisition({
  projectName: "hehe",
  typescript: ts,
  logger: console,
  delegate: {
    receivedFile: (code: string, path: string) => {
      codemirrorTsWorker.getEnv().createFile(path, code)
    },
  },
})

const files = {}

const javascriptFilenameRegex = /\.(m|c)?(t|j)sx?$/

function ata(code: string, filePath: string, skip = false) {
  if (!javascriptFilenameRegex.test(filePath)) {
    return
  }
  typescriptATA(code)

  if (!skip) {
    const imports = walkies(code)
    vfs.then(async (env) => {
      for (const spec of imports) {
        if (spec.startsWith("https://")) {
          fetchXTypescriptTypes(spec, files).then((content) => {
            if (content) {
              for (const [path, code] of Object.entries(content)) {
                env.createFile(
                  `/node_modules/${path}/index.d.ts`,
                  `declare module "${path}" {${code}}`,
                )
              }
            }
          })
        }
      }
    })
  }
}

const typescriptWorker = {
  tsWorker: codemirrorTsWorker,
  ata(code: string, filePath: string) {
    ata(code, filePath)
  },
  async load(url: AutomergeUrl, src: Project["src"]) {
    const env = await vfs
    for (const name in src) {
      if (!javascriptFilenameRegex.test(name)) {
        continue
      }
      const code = src[name]
      if (typeof code == "string") {
        env.createFile(`/${url}/${name}`, src[name])
        typescriptATA(code)
      }
    }
  },
}

export type TypescriptWorker = Remote<typeof typescriptWorker>

Comlink.expose(typescriptWorker)
