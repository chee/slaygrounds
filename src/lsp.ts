// the editor's end of the language server: a transport over the typescript
// worker, and a workspace that knows how to open other files in the project

import {
  jumpToDefinition,
  languageServerExtensions,
  LSPClient,
  LSPPlugin,
  type Transport,
  Workspace,
  type WorkspaceFile,
} from "@codemirror/lsp-client"
import type { Text } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { fromFileUri } from "./worker/tsgo/uri.ts"
import type { TypescriptWorkerMessage } from "./worker/typescript.ts"

export { fileUri } from "./worker/tsgo/uri.ts"

class File implements WorkspaceFile {
  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView,
  ) {}
  getView() {
    return this.view
  }
}

// like the default workspace, but going to a definition in another file
// navigates there (by changing the url) instead of giving up
class ProjectWorkspace extends Workspace {
  files: File[] = []
  #versions: Record<string, number> = {}
  #opening = new Map<string, (view: EditorView) => void>()

  constructor(client: LSPClient, private navigate: (url: string) => void) {
    super(client)
  }

  #nextVersion(uri: string) {
    return this.#versions[uri] = (this.#versions[uri] ?? -1) + 1
  }

  syncFiles() {
    const updates = []
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view)
      if (!plugin || plugin.unsyncedChanges.empty) continue
      updates.push({ changes: plugin.unsyncedChanges, file, prevDoc: file.doc })
      file.doc = file.view.state.doc
      file.version = this.#nextVersion(file.uri)
      plugin.clear()
    }
    return updates
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    if (this.getFile(uri)) this.closeFile(uri)
    const file = new File(
      uri,
      languageId,
      this.#nextVersion(uri),
      view.state.doc,
      view,
    )
    this.files.push(file)
    this.client.didOpen(file)
    this.#opening.get(uri)?.(view)
    this.#opening.delete(uri)
  }

  closeFile(uri: string) {
    if (!this.getFile(uri)) return
    this.files = this.files.filter((file) => file.uri != uri)
    this.client.didClose(uri)
  }

  override displayFile(uri: string): Promise<EditorView | null> {
    const open = this.getFile(uri) as File | null
    if (open) return Promise.resolve(open.view)
    const where = fromFileUri(uri)
    // declarations from a cdn: nowhere to show them
    if (!where) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.#opening.set(uri, resolve)
      this.navigate(`${where.url}/${where.name}`)
      setTimeout(() => {
        if (this.#opening.get(uri) == resolve) {
          this.#opening.delete(uri)
          resolve(null)
        }
      }, 5000)
    })
  }
}

export function createLanguageClient(
  worker: Worker,
  navigate: (url: string) => void,
) {
  const post = (message: TypescriptWorkerMessage) => worker.postMessage(message)
  const handlers = new Set<(message: string) => void>()
  worker.addEventListener("message", (event) => {
    if (typeof event.data?.lsp == "string") {
      for (const handler of handlers) handler(event.data.lsp)
    }
  })
  const transport: Transport = {
    send: (lsp) => post({ lsp }),
    subscribe: (handler) => handlers.add(handler),
    unsubscribe: (handler) => handlers.delete(handler),
  }
  const client = new LSPClient({
    rootUri: "file:///",
    // first answers wait on a 50MB wasm compiling
    timeout: 30_000,
    workspace: (client) => new ProjectWorkspace(client, navigate),
    extensions: [
      ...languageServerExtensions(),
      // cmd/ctrl-click goes to the definition, like it used to
      EditorView.domEventHandlers({
        click(event, view) {
          if (!(event.metaKey || event.ctrlKey)) return false
          const pos = view.posAtCoords(event)
          if (pos == null) return false
          view.dispatch({ selection: { anchor: pos } })
          return jumpToDefinition(view)
        },
      }),
    ],
  }).connect(transport)
  return {
    client,
    project(url: string, project: { meta: Record<string, any>; src: Record<string, string> }) {
      post({ project: { url, ...project } })
    },
  }
}

export function languageId(filename: string) {
  if (/\.[mc]?tsx$/.test(filename)) return "typescriptreact"
  if (/\.[mc]?ts$/.test(filename)) return "typescript"
  if (/\.[mc]?jsx$/.test(filename)) return "javascriptreact"
  return "javascript"
}
