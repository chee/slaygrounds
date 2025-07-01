import { walkies } from "../babel/walk-imports.ts"

export async function spider(
  url: string,
  deps: Record<string, string> = {},
): Promise<Record<string, string>> {
  if (url in deps) return deps
  const res = await fetch(url)
  if (res.ok) {
    const content = await res.text()
    deps[url] = content
    const imports = walkies(content)
    for (const path of imports) {
      try {
        const depUrl = new URL(path, url).toString()
        if (!(depUrl in deps)) {
          await spider(depUrl, deps)
        }
      } catch {}
    }
  } else deps[url] = ""
  return deps
}

export async function fetchXTypescriptTypes(
  specifier: string,
  files: Record<string, string> = {},
): Promise<Record<string, string> | undefined> {
  if (specifier in files) {
    return files
  }

  const res = await fetch(specifier, { method: "HEAD" })
  const typesUrl = res.headers.get("x-typescript-types")
  if (!typesUrl) {
    console.debug(`No x-typescript-types header found for ${specifier}`)
    return
  }
  const resolvedTypesUrl = new URL(typesUrl, specifier).toString()
  const typesRes = await fetch(resolvedTypesUrl)
  if (!typesRes.ok) {
    throw new Error(`Failed to fetch types from ${resolvedTypesUrl}`)
  }
  const typesContent = await typesRes.text()
  files[specifier] = typesContent
  files[resolvedTypesUrl] = typesContent
  await spider(resolvedTypesUrl, files)
  const imports = walkies(typesContent)
  for (const path of imports) {
    try {
      const depUrl = new URL(path, resolvedTypesUrl).toString()
      if (!(depUrl in files)) {
        await spider(depUrl, files)
      }
    } catch {}
  }

  return files
}
