import esbuild from "./esbuild/bundle.ts"
import { Project } from "../shape.ts"
import { expose, Remote } from "comlink"

export function bundle(project: Project) {
  return esbuild(project)
}

const bundleWorker = { bundle }

export type BundleWorker = Remote<typeof bundleWorker>

expose(bundleWorker)
