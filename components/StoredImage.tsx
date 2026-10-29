"use client";
import { ImageOff } from "lucide-react";
import { useImageUrl } from "./useImage";
import { cx } from "./ui";

/** An image from this browser's store: a shimmer while it loads, a clear notice if it is not there. */
export function StoredImage({ hash, kind = "thumb", alt, className, placeholderClassName }: { hash: string; kind?: "thumb" | "full"; alt: string; className?: string; placeholderClassName?: string }) {
  const url = useImageUrl(hash, kind);
  if (url === "missing") {
    return (
      <div className={cx("flex size-full flex-col items-center justify-center gap-1 bg-surface-3 text-center text-[10.5px] text-muted", placeholderClassName)} title="This image is not in this browser's storage. Re-import the dataset to restore it.">
        <ImageOff className="size-4" />
        Image not stored
      </div>
    );
  }
  if (!url) return <div className={cx("size-full shimmer", placeholderClassName)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}
