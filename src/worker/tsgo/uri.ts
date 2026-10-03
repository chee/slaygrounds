// automerge:abc + entry.tsx <-> file:///automerge/abc/entry.tsx

export function fileUri(url: string, name: string) {
  return `file:///automerge/${url.replace(/^automerge:/, "")}/${name}`
}

export function fromFileUri(uri: string) {
  const match = /^file:\/\/\/automerge\/([^/]+)\/(.+)$/.exec(uri)
  return match ? { url: `automerge:${match[1]}`, name: match[2] } : null
}
