// typescript 7's language server, in a worker, talking json-rpc to the editor

import wasmUrl from "tsgo-wasm/tsgo.wasm?url"
import { createLanguageService } from "./tsgo/language-service.ts"
import type { Project } from "../shape.ts"

export type TypescriptWorkerMessage =
  | { lsp: string }
  | { project: { url: string } & Project }

type Service = Awaited<ReturnType<typeof createLanguageService>>

let service: Service | undefined
const queue: TypescriptWorkerMessage[] = []

function handle(message: TypescriptWorkerMessage) {
  if ("lsp" in message) service!.lsp(message.lsp)
  else service!.project(message.project.url, message.project)
}

self.onmessage = (event: MessageEvent<TypescriptWorkerMessage>) => {
  if (service) handle(event.data)
  else queue.push(event.data)
}

createLanguageService(
  fetch(wasmUrl),
  (lsp) => self.postMessage({ lsp }),
).then((ready) => {
  service = ready
  for (const message of queue.splice(0)) handle(message)
}).catch((error) => console.error("[tsgo] failed to start", error))
