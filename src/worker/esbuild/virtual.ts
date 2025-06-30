import { Project } from "../../shape.ts"

export type VirtualFileSystem = {
  [key: string]: string
}

export function fileTreeToVirtualFileSystem(
  src: Project["src"],
  prefix = "",
  files?: Record<string, string>,
): VirtualFileSystem {
  if (!files) files = {}
  for (const [key, value] of Object.entries(src)) {
    const path = prefix ? [prefix, key].join("/") : key
    if (typeof value == "string") files[path] = value
    else if (typeof value == "object" && value !== null) {
      fileTreeToVirtualFileSystem(value, path, files)
    }
  }
  return files
}
