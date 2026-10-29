"use client";
import { useEffect, useState } from "react";
import { db } from "@/lib/db";

const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

async function load(hash: string, kind: "thumb" | "full"): Promise<string | null> {
  const key = `${kind}:${hash}`;
  const cached = urls.get(key);
  if (cached) return cached;
  let p = inflight.get(key);
  if (!p) {
    p = (kind === "thumb" ? db.getThumb(hash) : db.getImage(hash))
      .then((blob) => {
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      })
      .catch(() => null)
      // A miss is never cached: the image may be written moments later (an import still running).
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/**
 * An object URL for an image in this browser's store, kept for the page's lifetime. Returns "missing" when the image
 * is still not in the store after a few retries, so callers can say so instead of showing a loader forever.
 */
export function useImageUrl(hash: string | undefined, kind: "thumb" | "full" = "thumb"): string | null | "missing" {
  const [url, setUrl] = useState<string | null | "missing">(() => (hash ? (urls.get(`${kind}:${hash}`) ?? null) : null));
  useEffect(() => {
    if (!hash) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) =>
      void load(hash, kind).then((u) => {
        if (!live) return;
        if (u) setUrl(u);
        else if (n < 4) timer = setTimeout(() => attempt(n + 1), 400 * 2 ** n);
        else setUrl("missing");
      });
    attempt(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hash, kind]);
  return url;
}
