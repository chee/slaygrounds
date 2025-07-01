import { minimalSetup } from "codemirror"
import { emacsStyleKeymap, indentWithTab } from "@codemirror/commands"
import { indentUnit, syntaxHighlighting } from "@codemirror/language"
import { Compartment, EditorState, Extension } from "@codemirror/state"
import * as Comlink from "comlink"
import { dracula } from "thememirror"
import { automergeSyncPlugin } from "@automerge/automerge-codemirror"
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search"

import {
  tsAutocomplete,
  tsFacet,
  tsGoto,
  tsHover,
  tsLinter,
  tsSync,
  tsTwoslash,
} from "@valtown/codemirror-ts"
import { autocompletion } from "@codemirror/autocomplete"

import {
  AutomergeUrl,
  DocHandle,
  IndexedDBStorageAdapter,
  isValidAutomergeUrl,
  Prop,
  Repo,
  WebSocketClientAdapter,
} from "@automerge/vanillajs"
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"

import { mod, modshift } from "./modshift.ts"
import { WorkerShape } from "@valtown/codemirror-ts/worker"
import { lycheeHighlightStyle, lycheeTheme } from "./lychee.ts"
import { Project } from "./shape.ts"
import { TypescriptWorker } from "./worker/typescript.ts"

import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript"
import { cssLanguage } from "@codemirror/lang-css"
import { jsonLanguage } from "@codemirror/lang-json"
import { BundleWorker } from "./worker/bundle.ts"
import eruda from "eruda?raw"
import defaultContent from "./default.js"
import { registerSW } from "virtual:pwa-register"
const updateSW = registerSW({
  onNeedRefresh() {
    updateSW(true)
  },
})

const typescriptWorkerProgram = new Worker(
  new URL("./worker/typescript.ts", import.meta.url),
  { type: "module" },
)
const typescriptWorker = Comlink.wrap(
  typescriptWorkerProgram,
) as TypescriptWorker
const codemirrorTsWorker = typescriptWorker.tsWorker as unknown as WorkerShape

const bundleWorkerProgram = new Worker(
  new URL("./worker/bundle.ts", import.meta.url),
  { type: "module" },
)
const bundleWorker = Comlink.wrap(bundleWorkerProgram) as BundleWorker

const repo = new Repo({
  network: [new WebSocketClientAdapter("wss://galaxy.observer")],
  storage: new IndexedDBStorageAdapter("playground"),
})

function getURL() {
  const u = location.hash.slice(1)
  if (!u) return null
  return new URL(u)
}

function getAutomergeUrlFromURL(url: null): null
function getAutomergeUrlFromURL(url: URL): AutomergeUrl
function getAutomergeUrlFromURL(url: URL | null) {
  return url ? url.protocol + url.pathname.split("/")[0] : null
}

let handle: DocHandle<Project> | undefined

out:
if (location.hash) {
  const url = getURL()
  if (!url) {
    break out
  }
  const automergeUrl = getAutomergeUrlFromURL(url)
  if (isValidAutomergeUrl(automergeUrl)) {
    handle = await repo.find<Project>(automergeUrl)
  }
}

const headmap = () =>
  document.head.querySelector("script[type='importmap']")
    ?.innerHTML ?? ""

if (!handle) {
  handle = repo.create({
    meta: {},
    src: {
      "entry.tsx": defaultContent,
      "importmap.json": headmap(),
    },
  })
  const hash = `#${handle!.url}/entry.tsx`
  if (location.hash != hash) {
    location.hash = hash
  }
}

const url = getURL()
function getPathFromURL(url: URL | null) {
  if (!url) return []
  return ["src"].concat(url?.pathname.split("/").slice(1) ?? [])
}
let path = getPathFromURL(url)

const themeCompartment = new Compartment()

const darkmatch = self.matchMedia("(prefers-color-scheme: dark)")
const getSchemeTheme = () => {
  return darkmatch.matches
    ? dracula
    : [lycheeTheme, syntaxHighlighting(lycheeHighlightStyle)]
}
darkmatch.addEventListener("change", () => {
  themeCompartment.reconfigure(getSchemeTheme())
})

const iframe = document.querySelector("iframe")!

function mksrcdoc(inline: string) {
  const importmap = handle!.doc().src["importmap.json"] ?? headmap()
  return /* html */ `<!doctype html>
<meta charset="utf-8">
<script type="importmap">
${importmap}
</script>
<div id="app"></div>
${inline}
<script>${eruda}</script>
<style>
.eruda-dev-tools {
	transition: none!important;
opacity: 1!important;
}
.eruda-entry-btn {display: none!important}
</style>
<script>
eruda.init({useShadowDom: false})
eruda.show()
</script>
`
}

const encoder = new TextEncoder()

async function getBundledCode(handle: DocHandle<Project>) {
  const result = await bundleWorker.bundle(handle!.doc(), `/${handle!.url}`)
  return result?.outputFiles?.reduce((cont, file) => {
    if (file.path.endsWith(".js")) {
      return cont + `<script type="module">${file.text}</script>`
    }
    if (file.path.endsWith(".css")) {
      return cont + `<style>${file.text}</style>`
    }
    return cont
  }, "") ?? ""
}

async function update() {
  try {
    const srcdoc = mksrcdoc(await getBundledCode(handle!))
    const uint8array = encoder.encode(srcdoc)
    const blob = new Blob([uint8array], { type: "text/html" })
    const url = URL.createObjectURL(blob)
    iframe.contentWindow?.location.replace(url)
  } catch (error) {
    console.info(error)
  }
}
update()

let timer = setTimeout(() => {})
function updateSoon() {
  clearTimeout(timer)
  timer = setTimeout(update, 250)
}
handle.on("change", updateSoon)

function get<T>(obj: any, path: (string | number)[]): T | undefined {
  return path.reduce((current, key) => current?.[key], obj)
}
function set(obj: any, path: (string | number)[], value: any): void {
  const lastKey = path[path.length - 1]
  const target = path.slice(0, -1).reduce((current, key) => {
    if (current[key] == null) {
      current[key] = typeof path[path.indexOf(key) + 1] === "number" ? [] : {}
    }
    return current[key]
  }, obj)

  target[lastKey] = value
}

await codemirrorTsWorker.initialize()
typescriptWorker.load(handle.url, handle.doc().src)

const map = {
  js: javascriptLanguage,
  jsx: jsxLanguage,
  ts: typescriptLanguage,
  tsx: tsxLanguage,
  css: cssLanguage,
  json: jsonLanguage,
}

const javascriptFilenameRegex = /\.(m|c)?(t|j)sx?$/

function createView(opts: { handle: DocHandle<Project>; path: string[] }) {
  if (!get(opts.handle.doc(), opts.path)) {
    opts.handle.change((doc) => {
      set(doc, opts.path, "")
    })
  }

  const tsExtensions: Extension[] = [
    tsFacet.of({
      worker: codemirrorTsWorker,
      path: ["", opts.handle.url, ...opts.path.slice(1)].join("/"),
    }),
    autocompletion({ override: [tsAutocomplete()] }),
    tsSync(),
    tsGoto({
      gotoHandler(path, hover, view) {
        const fileName = hover.typeDef?.[0]?.fileName
        if (fileName?.startsWith("/automerge:")) {
          location.hash = fileName.slice(1)
        }
        return undefined
      },
    }),
    tsHover(),
    tsTwoslash(),
    tsLinter(),
  ]

  const filename = opts.path[opts.path.length - 1]

  const ext = filename.split(".")[1] as keyof typeof map
  const lang = map[ext]

  {
    return new EditorView({
      doc: get(opts.handle.doc(), opts.path),
      parent: document.querySelector(".code")!,
      extensions: [
        javascriptFilenameRegex.exec(filename) ? tsExtensions : [],
        lang ?? [],
        minimalSetup,
        automergeSyncPlugin(opts),
        tsxLanguage,
        indentUnit.of("\t"),
        search(),
        highlightSpecialChars(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        autocompletion(),
        EditorView.lineWrapping,
        lineNumbers(),
        keymap.of([indentWithTab, ...emacsStyleKeymap, ...searchKeymap]),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(2),
        EditorView.clickAddsSelectionRange.of((event) => {
          const mask = modshift(event)
          if (mask == 1 << mod.option) return true
          return false
        }),
        rectangularSelection({
          eventFilter(event) {
            const mask = modshift(event)
            if (mask == ((1 << mod.shift) | (1 << mod.option))) return true
            return false
          },
        }),
        themeCompartment.of(getSchemeTheme()),
        tsExtensions,
      ],
    })
  }
}

function fix() {
  const filename = path[path.length - 1]
  if (path.length < 2 || !filename) {
    location.hash = location.hash.replace(/\/?$/, "/entry.tsx")
    location.reload()
  }
}
fix()

let view = createView({ handle, path })

async function postbrowse() {
  view.destroy()
  const url = getURL()!
  const automergeUrl = getAutomergeUrlFromURL(url)
  if (automergeUrl != handle?.url) {
    handle?.off("change", updateSoon)
    handle = await repo.find<Project>(automergeUrl)!
    handle.on("change", updateSoon)
  }
  path = getPathFromURL(url)

  fix()
  view = createView({ handle, path })
}

self.addEventListener("popstate", postbrowse)
