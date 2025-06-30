import { basicSetup, minimalSetup } from "codemirror"
import { emacsStyleKeymap, indentWithTab } from "@codemirror/commands"
import { indentUnit, syntaxHighlighting } from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import * as Comlink from "comlink"
import { birdsOfParadise, boysAndGirls, dracula } from "thememirror"
import { automergeSyncPlugin } from "@automerge/automerge-codemirror"
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search"

const typescriptWorkerProgram = new Worker(
  new URL("./worker/typescript.ts", import.meta.url),
  { type: "module" },
)
const typescriptWorker = Comlink.wrap(
  typescriptWorkerProgram,
) as TypescriptWorker
const codemirrorTsWorker = typescriptWorker.tsWorker as unknown as WorkerShape
codemirrorTsWorker.initialize()
const bundleWorkerProgram = new Worker(
  new URL("./worker/bundle.ts", import.meta.url),
  { type: "module" },
)
const bundleWorker = Comlink.wrap(bundleWorkerProgram) as BundleWorker

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
  DocHandle,
  IndexedDBStorageAdapter,
  isValidAutomergeUrl,
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

import { tsxLanguage } from "@codemirror/lang-javascript"
import { BundleWorker } from "./worker/bundle.ts"
import erudaURL from "eruda/eruda.js?url"

const repo = new Repo({
  network: [new WebSocketClientAdapter("wss://galaxy.observer")],
  storage: new IndexedDBStorageAdapter("playground"),
})

const path = ["src", "entry.tsx"]

let handle: DocHandle<Project> | undefined
if (location.hash) {
  const u = location.hash.slice(1)
  const url = new URL(u)
  const automergeUrl = url.protocol + url.pathname.split("/")[0]
  if (isValidAutomergeUrl(automergeUrl)) {
    handle = await repo.find<Project>(automergeUrl)
  }
}

if (!handle) {
  handle = repo.create({
    meta: {},
    src: { "entry.tsx": "function x() {}" },
  })
  history.replaceState({}, "", `#${handle.url}/entry.tsx`)
}

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

function mksrcdoc(text: string) {
  const importmap = document.head.querySelector("script[type='importmap']")
    ?.outerHTML
  return /* html */ `<!doctype html>
<meta charset="utf-8">
${importmap}
<div id="app"></div>
<script type="module">${text}</script>
<script src="${erudaURL}"></script>
<script>eruda.init({useShadowDom: false}); eruda.show()</script>`
}

let timer = setTimeout(() => {})

async function update() {
  const result = await bundleWorker.bundle(handle!.doc())
  iframe.srcdoc = mksrcdoc(result.outputFiles?.[0]?.text ?? "")
}
update()

handle.on("change", () => {
  clearTimeout(timer)
  timer = setTimeout(update, 500)
})

const view = new EditorView({
  doc: handle.doc().src["entry.tsx"],
  parent: document.querySelector(".code")!,
  extensions: [
    minimalSetup,
    automergeSyncPlugin({ handle, path }),
    tsxLanguage,
    indentUnit.of("\t"),
    search(),
    highlightSpecialChars(),
    // highlightTrailingWhitespace(),
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
    tsFacet.of({
      worker: codemirrorTsWorker,
      path: "/entry.tsx",
    }),
    autocompletion({ override: [tsAutocomplete()] }),
    tsSync(),
    tsGoto(),
    tsHover(),
    tsTwoslash(),
    tsLinter(),
  ],
})
