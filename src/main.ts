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

import { autocompletion } from "@codemirror/autocomplete"

import {
  IndexedDbStorage,
  WebCryptoSigner,
} from "@automerge/automerge-subduction"
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
import { lycheeHighlightStyle, lycheeTheme } from "./lychee.ts"
import { Project } from "./shape.ts"
import { createLanguageClient, fileUri, languageId } from "./lsp.ts"

import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript"
import { cssLanguage } from "@codemirror/lang-css"
import { jsonLanguage } from "@codemirror/lang-json"
import { BundleWorker } from "./worker/bundle.ts"
import {
  type AutomergeUrl,
  type Handle,
  isValidAutomergeUrl,
  Sync,
} from "./subduction.ts"
import erudaSource from "eruda?raw"
import defaultContent from "./default.js"
import { registerSW } from "virtual:pwa-register"
const updateSW = registerSW({
  onNeedRefresh() {
    updateSW(true)
  },
})

const typescript = createLanguageClient(
  new Worker(new URL("./worker/typescript.ts", import.meta.url), {
    type: "module",
  }),
  (url) => {
    location.hash = url
  },
)

const bundleWorkerProgram = new Worker(
  new URL("./worker/bundle.ts", import.meta.url),
  { type: "module" },
)
const bundleWorker = Comlink.wrap(bundleWorkerProgram) as BundleWorker

const sync = new Sync({
  signer: WebCryptoSigner.setup(),
  storage: IndexedDbStorage.setup(indexedDB, "slaygrounds"),
  servers: ["wss://galaxy.observer"],
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

let handle: Handle<Project> | undefined

out:
if (location.hash) {
  const url = getURL()
  if (!url) {
    break out
  }
  const automergeUrl = getAutomergeUrlFromURL(url)
  if (isValidAutomergeUrl(automergeUrl)) {
    handle = await sync.find<Project>(automergeUrl)
  }
}

const headmap = () =>
  `{
	"imports": {
		"solid-js": "https://esm.sh/solid-js",
		"solid-js/web": "https://esm.sh/solid-js/web"
	}
}
`

if (!handle) {
  handle = sync.create<Project>({
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
function getCurrentFilename() {
  const path = getPathFromURL(getURL())
  return path.slice(1).join("/")
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

// inlined into a blob: url, a relative source map can only ever fail
const eruda = erudaSource.replace(/\/\/# sourceMappingURL=\S+\s*$/, "")

function mksrcdoc(inline: string) {
  const importmap = handle!.doc().src["importmap.json"] || headmap()
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

async function getBundledCode(handle: Handle<Project>) {
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

// the language server reads every file in the project, not just open ones
let projectTimer = setTimeout(() => {})
function sendProject() {
  clearTimeout(projectTimer)
  projectTimer = setTimeout(() => {
    typescript.project(handle!.url, handle!.doc())
  }, 100)
}

let timer = setTimeout(() => {})
function updateSoon() {
  clearTimeout(timer)
  timer = setTimeout(update, 250)
  sendProject()
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

  if (value === undefined) {
    delete target[lastKey]
  } else {
    target[lastKey] = value
  }
}

function del(obj: any, path: (string | number)[]): void {
  set(obj, path, undefined)
}

typescript.project(handle.url, handle.doc())

const map = {
  js: javascriptLanguage,
  jsx: jsxLanguage,
  ts: typescriptLanguage,
  tsx: tsxLanguage,
  css: cssLanguage,
  json: jsonLanguage,
}

const javascriptFilenameRegex = /\.(m|c)?(t|j)sx?$/
const filenamesListElement = document.querySelector("#files")!

filenamesListElement.addEventListener("click", (event) => {
  if (event.target instanceof HTMLButtonElement) {
    const filename = event.target.textContent
    location.hash = getAutomergeUrlFromURL(getURL()!) + "/" +
      filename
    renderFilenames(handle!)
  }
})

filenamesListElement.addEventListener("dblclick", (event) => {
  if (event.target instanceof HTMLButtonElement) {
    const filename = event.target.textContent!
    const newname = self.prompt("new name", filename!)
    event.target.textContent = newname!
    if (!newname) return
    if (newname == filename) return
    handle!.change((doc) => {
      set(doc, ["src", newname], get(doc, ["src", filename]))
      set(doc, ["src", filename], undefined)
    })
    location.hash = getAutomergeUrlFromURL(getURL()!) + "/" +
      newname
  }
})

filenamesListElement.addEventListener("contextmenu", (event) => {
  if (event.target instanceof HTMLButtonElement) {
    event.preventDefault()
    const filename = event.target.textContent!
    const yes = self.confirm(`delete ${filename}?`)
    if (!yes) return
    handle!.change((doc) => {
      del(doc, ["src", filename])
    })
    console.log(
      filename == getCurrentFilename(),
      filename,
      getCurrentFilename(),
    )
    if (filename == getCurrentFilename()) {
      location.hash = getAutomergeUrlFromURL(getURL()!) + "/entry.tsx"
    }

    renderFilenames(handle!)
  }
})

const newFilenameForm = document.getElementById(
  "filename-form",
) as HTMLFormElement
const newFilenameInput = document.getElementById("filename") as HTMLInputElement
newFilenameForm.addEventListener("submit", (event) => {
  event.preventDefault()
  const name = newFilenameInput.value
  newFilenameInput.value = ""
  location.hash = getAutomergeUrlFromURL(getURL()!) + "/" +
    name
  renderFilenames(handle!)
  view.focus()
})

function renderFilenames(handle: Handle<Project>) {
  const filenames = Array.from(Object.keys(handle.doc().src))
  const currentFilename = getCurrentFilename()

  filenamesListElement!.innerHTML = filenames.map((filename) =>
    `<li><button aria-current="${
      currentFilename == filename ? "page" : "false"
    }">${filename}</button></li>`
  ).join("")
}
renderFilenames(handle)

function createView(opts: { handle: Handle<Project>; path: string[] }) {
  if (!get(opts.handle.doc(), opts.path)) {
    opts.handle.change((doc) => {
      set(doc, opts.path, "")
    })
  }

  const filename = opts.path[opts.path.length - 1]
  const name = opts.path.slice(1).join("/")
  const tsExtensions: Extension = typescript.client.plugin(
    fileUri(opts.handle.url, name),
    languageId(filename),
  )

  const ext = filename.split(".")?.[1] as keyof typeof map | undefined
  const lang = ext && map[ext]

  const isJS = javascriptFilenameRegex.exec(filename) ||
    filename == "jsx-runtime"

  {
    return new EditorView({
      doc: get(opts.handle.doc(), opts.path) || "",
      // doc: "",
      parent: document.querySelector(".code")!,
      extensions: [
        isJS ? tsExtensions : [],
        lang ?? isJS ? tsxLanguage : [],
        minimalSetup,
        automergeSyncPlugin(opts),
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
    handle = await sync.find<Project>(automergeUrl)
    handle.on("change", updateSoon)
    typescript.project(handle.url, handle.doc())
  }
  path = getPathFromURL(url)

  fix()
  view = createView({ handle, path })
}

self.addEventListener("popstate", postbrowse)
