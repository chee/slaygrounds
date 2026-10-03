// a project's files, its acquired types and tsgo, all in one filesystem

import { startTsgo, type Tsgo } from "./host.ts"
import { createAcquirer, type Importmap } from "./acquire.ts"
import { fileUri } from "./uri.ts"

export interface ProjectFiles {
  meta: Record<string, any>
  src: Record<string, string>
}

const javascriptFilenameRegex = /\.(m|c)?(t|j)sx?$/

const assets = `declare module "*.css" {
  const css: string
  export default css
}
`

export async function createLanguageService(
  wasm: BufferSource | Response | Promise<Response>,
  post: (message: string) => void,
) {
  const tsgo: Tsgo = await startTsgo(wasm, post)
  const { fs } = tsgo
  let current: { url: string; names: Set<string> } | undefined
  let jsxImportSource = "solid-js"
  let tsconfig = ""

  const changed = (changes: { path: string; type: 1 | 2 | 3 }[]) => {
    if (!changes.length) return
    tsgo.notify("workspace/didChangeWatchedFiles", {
      changes: changes.map(({ path, type }) => ({ uri: `file://${path}`, type })),
    })
    tsgo.refresh()
  }

  function writeTsconfig() {
    const next = JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        lib: ["esnext", "dom"],
        jsx: "preserve",
        jsxImportSource,
        paths: acquirer.paths(),
      },
      include: ["automerge/**/*", "types/**/*"],
    }, null, 2)
    if (next == tsconfig) return []
    tsconfig = next
    return [{ path: "/tsconfig.json", type: fs.writeFile("/tsconfig.json", next) == "created" ? 1 : 2 } as const]
  }

  const acquirer = createAcquirer({
    write: (path, text) => fs.writeFile(path, text),
    written(paths) {
      changed([
        ...paths.map((path) => ({ path, type: 1 as const })),
        ...writeTsconfig(),
      ])
    },
  })

  fs.writeFile("/types/assets.d.ts", assets)
  changed(writeTsconfig())

  return {
    // json-rpc from the editor
    lsp(message: string) {
      tsgo.send(message)
    },

    // the whole project, every time it changes. we work out what's new
    project(url: string, { src, meta }: ProjectFiles) {
      const changes: { path: string; type: 1 | 2 | 3 }[] = []
      if (current && current.url != url) {
        for (const name of current.names) {
          const path = fileUri(current.url, name).slice("file://".length)
          if (fs.remove(path)) changes.push({ path, type: 3 })
        }
        current = undefined
      }
      current ??= { url, names: new Set() }
      for (const name of current.names) {
        if (typeof src[name] != "string") {
          const path = fileUri(url, name).slice("file://".length)
          fs.remove(path)
          current.names.delete(name)
          changes.push({ path, type: 3 })
        }
      }
      let importmap: Importmap = {}
      try {
        importmap = JSON.parse(src["importmap.json"] ?? "{}")
      } catch {}
      for (const [name, code] of Object.entries(src)) {
        if (typeof code != "string") continue
        const path = fileUri(url, name).slice("file://".length)
        if (fs.readFile(path) != code) {
          changes.push({ path, type: fs.writeFile(path, code) == "created" ? 1 : 2 })
        }
        current.names.add(name)
        if (javascriptFilenameRegex.test(name)) {
          acquirer.acquire(code, importmap).catch((error) =>
            console.warn("[types]", error)
          )
        }
      }
      if (typeof meta?.jsxImportSource == "string") {
        jsxImportSource = meta.jsxImportSource
      }
      changes.push(...writeTsconfig())
      changed(changes)
    },
  }
}
