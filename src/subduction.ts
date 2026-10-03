// a tiny replacement for automerge-repo: subduction does the syncing and
// storage, and we hand out little handles with just enough surface for
// automerge-codemirror and the rest of the app

import * as Automerge from "@automerge/automerge"
import {
  BlobMeta,
  CommitId,
  CommitInput,
  Fragment,
  FragmentInput,
  type IndexedDbStorage,
  LooseCommit,
  SedimentreeId,
  type SedimentreeStorage,
  type Signer,
  Subduction,
  SubductionWebSocket,
} from "@automerge/automerge-subduction"
import bs58check from "bs58check"

export type AutomergeUrl = `automerge:${string}`

export interface Handle<T> {
  url: AutomergeUrl
  isReady(): boolean
  doc(): Automerge.Doc<T>
  change(fn: Automerge.ChangeFn<T>): void
  on(event: "change", cb: () => void): void
  off(event: "change", cb: () => void): void
}

export function isValidAutomergeUrl(url: unknown): url is AutomergeUrl {
  if (typeof url != "string" || !url.startsWith("automerge:")) return false
  try {
    return bs58check.decode(url.slice("automerge:".length)).length == 16
  } catch {
    return false
  }
}

// automerge doc ids are 16 bytes, sedimentree ids are 32. automerge-repo
// zero-pads, so we do too or we'd never meet in the middle
function toSedimentreeId(url: AutomergeUrl) {
  const bytes = new Uint8Array(32)
  bytes.set(bs58check.decode(url.slice("automerge:".length)))
  return SedimentreeId.fromBytes(bytes)
}

function concat(chunks: Uint8Array[]) {
  if (chunks.length == 1) return chunks[0]
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

type Arrival = (sid: string, head: string, blob: Uint8Array) => void

// subduction doesn't tell us when a peer sends us something, but it does
// write it to storage, so we listen at that door
function tapStorage(storage: SedimentreeStorage, arrived: Arrival) {
  const tap = {
    saveCommit(sid, commitId, signed, blob) {
      // these may be views into wasm memory, copy before anything else runs
      arrived(sid.toString(), commitId.toHexString(), new Uint8Array(blob))
      return storage.saveCommit(sid, commitId, signed, blob)
    },
    saveFragment(sid, head, signed, blob) {
      arrived(sid.toString(), head.toHexString(), new Uint8Array(blob))
      return storage.saveFragment(sid, head, signed, blob)
    },
    saveBatchAll(sid, commits, fragments) {
      for (const c of commits) {
        arrived(sid.toString(), c.commitId.toHexString(), new Uint8Array(c.blob))
      }
      for (const f of fragments) {
        arrived(
          sid.toString(),
          f.fragmentHead.toHexString(),
          new Uint8Array(f.blob),
        )
      }
      return storage.saveBatchAll(sid, commits, fragments)
    },
  } satisfies Partial<SedimentreeStorage>
  return new Proxy(storage, {
    get(target, key) {
      if (key in tap) return tap[key as keyof typeof tap]
      const value = Reflect.get(target, key)
      return typeof value == "function" ? value.bind(target) : value
    },
  })
}

class Entry<T> implements Handle<T> {
  #doc: Automerge.Doc<T>
  #listeners = new Set<() => void>()
  // heads subduction already has, so we don't send them back
  known = new Set<string>()
  id: string
  #inbound: Uint8Array[] = []
  #saving = Promise.resolve()
  #saveQueued = false

  constructor(
    public url: AutomergeUrl,
    public sid: SedimentreeId,
    private sync: Sync,
    doc: Automerge.Doc<T>,
  ) {
    this.#doc = doc
    this.id = sid.toString()
  }

  isReady() {
    return true
  }

  doc() {
    return this.#doc
  }

  change(fn: Automerge.ChangeFn<T>) {
    this.#update(Automerge.change(this.#doc, fn))
    this.save()
  }

  on(_event: "change", cb: () => void) {
    this.#listeners.add(cb)
  }

  off(_event: "change", cb: () => void) {
    this.#listeners.delete(cb)
  }

  #update(next: Automerge.Doc<T>) {
    const before = Automerge.getHeads(this.#doc)
    this.#doc = next
    if (Automerge.equals(before, Automerge.getHeads(next))) return
    for (const cb of this.#listeners) cb()
  }

  heads() {
    return Automerge.getHeads(this.#doc)
  }

  apply(blobs: Uint8Array[]) {
    if (!blobs.length) return
    try {
      this.#update(Automerge.loadIncremental(this.#doc, concat(blobs)))
    } catch (error) {
      console.warn("couldn't load incoming changes", this.url, error)
    }
  }

  // incoming blobs come one at a time; collect a burst into one update
  receive(head: string, blob: Uint8Array) {
    if (this.known.has(head)) return
    this.known.add(head)
    if (this.#inbound.push(blob) > 1) return
    queueMicrotask(() => {
      const blobs = this.#inbound
      this.#inbound = []
      this.apply(blobs)
    })
  }

  // mark everything the doc currently holds as already stored
  settle() {
    for (const meta of Automerge.getFragmentMetadata(this.#doc)) {
      this.known.add(meta.head)
    }
  }

  save() {
    if (this.#saveQueued) return this.#saving
    this.#saveQueued = true
    this.#saving = this.#saving.then(async () => {
      // let a flurry of keystrokes land first
      await new Promise((yay) => setTimeout(yay, 100))
      this.#saveQueued = false
      try {
        if (await this.#store()) this.sync.push(this)
      } catch (error) {
        console.error("couldn't save", this.url, error)
      }
    })
    return this.#saving
  }

  // hand automerge's view of loose commits and fragments to subduction
  async #store() {
    const doc = this.#doc
    const unknown = (meta: Automerge.FragmentMeta) =>
      !this.known.has(meta.head)
    const commitMetas = Automerge.getFragmentMetadata(doc, 0).filter(unknown)
    const fragmentMetas = Automerge.getFragmentMetadata(doc, { start: 1 })
      .filter(unknown)
    if (!commitMetas.length && !fragmentMetas.length) return false

    const commitBytes = commitMetas.length
      ? Automerge.bundleFragmentMetadata(doc, commitMetas)
      : []
    const fragmentBytes = fragmentMetas.length
      ? Automerge.bundleFragmentMetadata(doc, fragmentMetas)
      : []
    const id = (hex: string) => CommitId.fromHexString(hex)
    const commits = commitMetas.map((meta, i) =>
      new CommitInput(
        new LooseCommit(
          this.sid,
          id(meta.head),
          meta.boundary.map(id),
          new BlobMeta(commitBytes[i]),
        ),
        commitBytes[i],
      )
    )
    const fragments = fragmentMetas.map((meta, i) =>
      new FragmentInput(
        new Fragment(
          this.sid,
          id(meta.head),
          meta.boundary.map(id),
          meta.checkpoints.map(id),
          new BlobMeta(fragmentBytes[i]),
        ),
        fragmentBytes[i],
      )
    )

    // mark before storing, storage hands our own writes straight back to us
    const heads = [...commitMetas, ...fragmentMetas].map((m) => m.head)
    for (const head of heads) this.known.add(head)
    try {
      const subduction = await this.sync.subduction
      await subduction.storeBuiltBatch(this.sid, commits, fragments)
    } catch (error) {
      for (const head of heads) this.known.delete(head)
      throw error
    }
    return true
  }
}

// IndexedDbStorage says undefined where the interface says null
type Storage = SedimentreeStorage | IndexedDbStorage

export interface SyncOptions {
  signer: Signer | Promise<Signer>
  storage: Storage | Promise<Storage>
  // websocket urls of subduction servers to stay connected to
  servers?: string[]
}

export class Sync {
  subduction: Promise<Subduction>
  #entries = new Map<string, Entry<any>>()
  #connected = new Set<string>()
  // resolves once every server has had its first go at connecting
  #firstContact: Promise<unknown>

  constructor(opts: SyncOptions) {
    const signer = Promise.resolve(opts.signer)
    this.subduction = Promise.all([signer, opts.storage]).then(
      ([signer, storage]) =>
        new Subduction({
          signer,
          storage: tapStorage(storage as SedimentreeStorage, (sid, head, blob) => {
            this.#entries.get(sid)?.receive(head, blob)
          }),
        }),
    )
    this.#firstContact = Promise.all(
      (opts.servers ?? []).map((url) =>
        new Promise((settle) => this.#stayConnected(url, signer, settle))
      ),
    )
  }

  async #stayConnected(
    url: string,
    signer: Promise<Signer>,
    settle: (value?: unknown) => void,
  ) {
    let backoff = 1000
    while (true) {
      try {
        const closed = Promise.withResolvers<void>()
        const subduction = await this.subduction
        const socket = await SubductionWebSocket.tryDiscover(
          new URL(url),
          await signer,
          new URL(url).host,
          () => closed.resolve(),
        )
        await subduction.addConnection(socket.toTransport())
        this.#connected.add(url)
        backoff = 1000
        // subscriptions belong to the connection, so a new connection means
        // asking about everything again
        await Promise.all([...this.#entries.values()].map((e) => this.pull(e)))
        settle()
        await closed.promise
        console.warn("disconnected from", url)
      } catch (error) {
        console.warn("couldn't connect to", url, error)
      }
      this.#connected.delete(url)
      settle()
      await new Promise((yay) => setTimeout(yay, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }

  // send what we have, take what they have, and subscribe to what's next
  async pull(entry: Entry<any>) {
    const subduction = await this.subduction
    const results = (await subduction.syncWithAllPeers(entry.sid, true))
      .entries()
    const received = results.some((r) =>
      r.stats && (r.stats.commitsReceived > 0 || r.stats.fragmentsReceived > 0)
    )
    // incoming data should already have arrived through the storage tap, but
    // read it back to be sure nothing slipped past
    if (received) entry.apply(await subduction.getBlobs(entry.sid))
  }

  push(entry: Entry<any>) {
    this.pull(entry).catch((error) =>
      console.warn("couldn't sync", entry.url, error)
    )
  }

  async find<T>(url: AutomergeUrl): Promise<Handle<T>> {
    const sid = toSedimentreeId(url)
    const existing = this.#entries.get(sid.toString())
    if (existing) return existing

    const entry = new Entry<T>(url, sid, this, Automerge.init<T>())
    this.#entries.set(entry.id, entry)
    const subduction = await this.subduction
    entry.apply(await subduction.getBlobs(sid))
    entry.settle()

    // we have it locally: show it now, catch up in the background
    if (entry.heads().length) {
      this.push(entry)
      return entry
    }

    await this.#firstContact
    await this.pull(entry).catch(() => {})
    entry.settle()
    if (!entry.heads().length) {
      this.#entries.delete(entry.id)
      throw new Error(`couldn't find ${url}`)
    }
    return entry
  }

  create<T>(initial: T): Handle<T> {
    const url: AutomergeUrl = `automerge:${
      bs58check.encode(crypto.getRandomValues(new Uint8Array(16)))
    }`
    const sid = toSedimentreeId(url)
    const entry = new Entry<T>(
      url,
      sid,
      this,
      Automerge.from(initial as Record<string, unknown>) as Automerge.Doc<T>,
    )
    this.#entries.set(entry.id, entry)
    entry.save()
    return entry
  }
}
