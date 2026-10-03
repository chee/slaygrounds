// automatic type acquisition, resolved the same way the bundle resolves
// imports at runtime: bare specifiers go through the import map (falling
// back to esm.sh), and the cdn's `x-typescript-types` header says where the
// declarations live. those files are mirrored into the filesystem at
// /https/<host>/<path>, and tsconfig `paths` points each specifier there

export interface Importmap {
  imports?: Record<string, string>
}

// import/export … from "x", import "x", export * from "x"
const fromRe =
  /(^|[^.\w$])((?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?)(["'])([^"'\n]+)\3/g
// import("x"), require("x")
const callRe = /(^|[^.\w$])((?:import|require)\s*\(\s*)(["'])([^"'\n]+)\3/g
// /// <reference path="x" />
const referenceRe = /(\/\/\/\s*<reference\s+path\s*=\s*)(["'])([^"']+)\2/g
const pragmaRe = /@jsxImportSource\s+([^\s*]+)/g

function stripComments(code: string) {
  // good enough for finding imports; keeps triple-slash references
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:/])\/\/(?!\/).*$/gm, "$1")
}

export function specifiers(code: string) {
  const found = new Set<string>()
  const clean = stripComments(code)
  for (const m of clean.matchAll(fromRe)) found.add(m[4])
  for (const m of clean.matchAll(callRe)) found.add(m[4])
  for (const m of code.matchAll(pragmaRe)) found.add(`${m[1]}/jsx-runtime`)
  return found
}

const isRelative = (spec: string) => /^\.{1,2}(\/|$)/.test(spec)
const isUrl = (spec: string) => /^https?:\/\//.test(spec)

export function mirrorPath(url: string) {
  const { protocol, host, pathname } = new URL(url)
  return `/${protocol.slice(0, -1)}/${host}${pathname}`
}

// point a specifier at a mirrored file in a way typescript's resolver
// accepts: foo.d.ts -> foo, foo.d.mts -> foo.mjs, foo.js -> foo
function asImport(path: string) {
  return path
    .replace(/\.d\.ts$|\.js$/, "")
    .replace(/\.d\.mts$/, ".mjs")
    .replace(/\.d\.cts$/, ".cjs")
}

// the declaration file a specifier inside a declaration file could mean
function candidates(url: string) {
  if (/\.d\.[mc]?ts$/.test(url)) return [url]
  if (/\.[mc]?js$/.test(url)) {
    return [url.replace(/\.([mc]?)js$/, ".d.$1ts")]
  }
  if (/\.[mc]?ts$/.test(url)) return [url.replace(/\.([mc]?)ts$/, ".d.$1ts")]
  return [`${url}.d.ts`, `${url}/index.d.ts`]
}

function resolveImportmap(spec: string, importmap: Importmap) {
  const imports = importmap.imports ?? {}
  if (spec in imports) return imports[spec]
  let best = ""
  for (const key of Object.keys(imports)) {
    if (key.endsWith("/") && spec.startsWith(key) && key.length > best.length) {
      best = key
    }
  }
  if (best) return imports[best] + spec.slice(best.length)
  return undefined
}

export interface Acquirer {
  // fetch types for every bare and url import in this code
  acquire(code: string, importmap: Importmap): Promise<void>
  paths(): Record<string, string[]>
}

export function createAcquirer(opts: {
  write(path: string, text: string): void
  // called once a batch of new files is in place
  written(paths: string[]): void
}): Acquirer {
  const specs = new Map<string, Promise<void>>()
  const files = new Map<string, Promise<string | undefined>>()
  const paths: Record<string, string[]> = {}
  let batch: string[] = []
  let remapped = false
  // declaration files import each other in circles, so a file is done once
  // it's written and its dependencies are tracked here instead of awaited
  const inflight = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>) => {
    inflight.add(promise)
    promise.finally(() => inflight.delete(promise))
  }

  async function get(url: string, init?: RequestInit) {
    try {
      const res = await fetch(url, init)
      return res.ok ? res : undefined
    } catch {
      return undefined
    }
  }

  // where do the declarations for this module live?
  async function typesFor(url: string) {
    const res = await get(url, { method: "HEAD" }) ?? await get(url)
    const header = res?.headers.get("x-typescript-types")
    return header ? new URL(header, res!.url || url).href : undefined
  }

  // fetch a declaration file and everything it pulls in. returns its path
  function fetchFile(url: string): Promise<string | undefined> {
    if (!files.has(url)) {
      files.set(
        url,
        (async () => {
          let res: Response | undefined
          for (const candidate of candidates(url)) {
            res = await get(candidate)
            if (res) break
          }
          if (!res) return undefined
          const text = await res.text()
          const base = res.url || url
          // only what's really imported, not what's in a doc comment example
          const real = specifiers(text)
          const rewrite = (spec: string) => {
            if (!real.has(spec)) return spec
            if (isRelative(spec) || spec.startsWith("/") || isUrl(spec)) {
              const dep = new URL(spec, base).href
              track(fetchFile(dep))
              return asImport(mirrorPath(dep))
            }
            // a bare import from inside a declaration file
            track(acquireSpecifier(spec, {}))
            return spec
          }
          const rewritten = text
            .replace(fromRe, (_, pre, kw, q, spec) => pre + kw + q + rewrite(spec) + q)
            .replace(callRe, (_, pre, kw, q, spec) => pre + kw + q + rewrite(spec) + q)
            .replace(referenceRe, (_, kw, q, spec) => {
              const dep = new URL(spec, base).href
              track(fetchFile(dep))
              return kw + q + mirrorPath(dep) + q
            })
          const path = mirrorPath(base)
          opts.write(path, rewritten)
          batch.push(path)
          return path
        })(),
      )
    }
    return files.get(url)!
  }

  function acquireSpecifier(spec: string, importmap: Importmap) {
    if (isRelative(spec) || spec.startsWith("/") || spec.startsWith("automerge:")) {
      return Promise.resolve()
    }
    const url = isUrl(spec)
      ? spec
      : resolveImportmap(spec, importmap) ?? `https://esm.sh/${spec}`
    // keyed by url too, so editing the import map fetches again
    const key = `${spec} ${url}`
    if (!specs.has(key)) {
      specs.set(
        key,
        (async () => {
          const types = await typesFor(url)
          if (!types) {
            console.debug(`[types] nothing for ${spec}`)
            return
          }
          const path = await fetchFile(types)
          if (path && paths[spec]?.[0] != path) {
            paths[spec] = [path]
            remapped = true
          }
        })(),
      )
    }
    return specs.get(key)!
  }

  return {
    async acquire(code, importmap) {
      await Promise.all(
        [...specifiers(code)].map((spec) => acquireSpecifier(spec, importmap)),
      )
      while (inflight.size) await Promise.allSettled([...inflight])
      if (batch.length || remapped) {
        const written = batch
        batch = []
        remapped = false
        opts.written(written)
      }
    },
    paths: () => paths,
  }
}
