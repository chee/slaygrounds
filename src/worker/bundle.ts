import esbuild from "./esbuild/bundle.ts"
import { Project } from "../shape.ts"
import { expose, Remote } from "comlink"

export function bundle(project: Project, prefix: string) {
  try {
    return esbuild(project, prefix)
  } catch (error) {
    console.error(error)
  }
}

const bundleWorker = { bundle }

export type BundleWorker = Remote<typeof bundleWorker>

expose(bundleWorker)
