"use client";
import { createStore, del, get, getMany, keys, set, setMany, values } from "idb-keyval";
import type { Dataset, Inference, Prompt, Run } from "./types";

/** Everything lives in this browser's IndexedDB. Nothing is sent to a server except model requests to OpenRouter. */
const DB = "harness-studio";
const stores = {
  images: () => createStore(`${DB}-images`, "images"),
  thumbs: () => createStore(`${DB}-thumbs`, "thumbs"),
  datasets: () => createStore(`${DB}-datasets`, "datasets"),
  prompts: () => createStore(`${DB}-prompts`, "prompts"),
  runs: () => createStore(`${DB}-runs`, "runs"),
  inference: () => createStore(`${DB}-inference`, "inference"),
  meta: () => createStore(`${DB}-meta`, "meta"),
};

type StoreName = keyof typeof stores;
const cache = new Map<StoreName, ReturnType<typeof createStore>>();
function store(name: StoreName) {
  let s = cache.get(name);
  if (!s) {
    s = stores[name]();
    cache.set(name, s);
  }
  return s;
}

/**
 * Images are stored as raw bytes, not Blobs: Safari refuses Blobs in IndexedDB in private windows and some other
 * modes. Older entries saved as Blobs are still read.
 */
type StoredImage = { type: string; bytes: ArrayBuffer };

async function toStored(blob: Blob): Promise<StoredImage> {
  return { type: blob.type || "image/jpeg", bytes: await blob.arrayBuffer() };
}

function fromStored(value: StoredImage | Blob | undefined): Blob | undefined {
  if (!value) return undefined;
  if (value instanceof Blob) return value;
  return new Blob([value.bytes], { type: value.type });
}

/** Reads an image; any storage error (Safari can fail to read old Blob entries) counts as not stored. */
async function readImage(name: "images" | "thumbs", hash: string): Promise<Blob | undefined> {
  try {
    const blob = fromStored(await get<StoredImage | Blob>(hash, store(name)));
    if (blob && blob.size === 0) return undefined;
    return blob;
  } catch {
    return undefined;
  }
}

export const db = {
  async putImage(hash: string, blob: Blob, thumb: Blob) {
    await set(hash, await toStored(blob), store("images"));
    await set(hash, await toStored(thumb), store("thumbs"));
  },
  async hasImage(hash: string) {
    // Both readable, not just present: an old Blob entry Safari can no longer read must be rewritten.
    const [image, thumb] = await Promise.all([db.getImage(hash), db.getThumb(hash)]);
    return image !== undefined && thumb !== undefined;
  },
  getImage: (hash: string) => readImage("images", hash),
  getThumb: (hash: string) => readImage("thumbs", hash),

  listDatasets: () => values<Dataset>(store("datasets")),
  putDataset: (d: Dataset) => set(d.id, d, store("datasets")),
  deleteDataset: (id: string) => del(id, store("datasets")),

  listPrompts: () => values<Prompt>(store("prompts")),
  putPrompt: (p: Prompt) => set(p.id, p, store("prompts")),
  deletePrompt: (id: string) => del(id, store("prompts")),

  listRuns: () => values<Run>(store("runs")),
  putRun: (r: Run) => set(r.id, r, store("runs")),
  deleteRun: (id: string) => del(id, store("runs")),

  getInference: (key: string) => get<Inference>(key, store("inference")),
  getInferences: (ks: string[]) => getMany<Inference | undefined>(ks, store("inference")),
  putInference: (i: Inference) => set(i.cacheKey, i, store("inference")),
  putInferences: (items: Inference[]) => setMany(items.map((i) => [i.cacheKey, i] as [IDBValidKey, Inference]), store("inference")),
  inferenceCount: async () => (await keys(store("inference"))).length,

  getMeta: <T>(key: string) => get<T>(key, store("meta")),
  setMeta: (key: string, value: unknown) => set(key, value, store("meta")),
};
