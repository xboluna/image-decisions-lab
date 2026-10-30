"use client";
import { AlertTriangle, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { DatasetPanel } from "./DatasetPanel";
import { Header } from "./Header";
import { PromptBuilder } from "./PromptBuilder";
import { SettingsCard } from "./SettingsCard";
import { cx } from "./ui";

function Skeleton() {
  return (
    <div className="mx-auto grid max-w-[1680px] gap-5 px-4 py-5 sm:px-6 xl:grid-cols-3">
      <div className="h-[640px] rounded-2xl shimmer xl:col-span-2" />
      <div className="h-[640px] rounded-2xl shimmer" />
      <div className="h-[360px] rounded-2xl shimmer xl:col-span-3" />
      <div className="col-span-full -mt-[1040px] flex justify-center pt-40 text-[13px] text-ink-2">Loading your workspace from this browser…</div>
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div className={cx("animate-pop pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] shadow-pop", toast.tone === "error" ? "bg-critical text-white" : "bg-ink text-surface")}>
        {toast.tone === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
        {toast.text}
      </div>
    </div>
  );
}

/** Height of the prompt + settings column on wide screens, so the training panel can match it. */
function useColumnHeight(): [React.RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wide = window.matchMedia("(min-width: 1280px)");
    const update = () => setHeight(wide.matches ? Math.round(el.getBoundingClientRect().height) : null);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    wide.addEventListener("change", update);
    update();
    return () => {
      ro.disconnect();
      wide.removeEventListener("change", update);
    };
  });
  return [ref, height];
}

export function Studio() {
  const ready = useStore((s) => s.ready);
  const [rightColumn, rightHeight] = useColumnHeight();
  const hydrate = useStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  // A file dropped anywhere outside a drop zone must not make the browser open it and leave the app (and lose
  // in-memory state such as an earlier version being viewed). Drop zones handle their own drops first.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
  return (
    <>
      <Header />
      {!ready ? (
        <Skeleton />
      ) : (
        <main className="mx-auto max-w-[1680px] space-y-5 px-4 py-5 sm:px-6">
          <div className="grid items-start gap-5 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <DatasetPanel role="train" fillHeight={rightHeight} />
            </div>
            <div ref={rightColumn} className="min-w-0 space-y-5">
              <PromptBuilder />
              <SettingsCard />
            </div>
          </div>
          <DatasetPanel role="test" />
          <footer className="flex flex-wrap items-center justify-between gap-2 pb-6 pt-1 text-[11.5px] text-muted">
            <span>Datasets, prompts, runs and your API key live in this browser only. Model calls go straight from your browser to OpenRouter.</span>
            <span>
              Demo images: LabWare_Items, ABC-iRobotics (MIT license), via{" "}
              <a className="underline-offset-2 hover:underline" href="https://huggingface.co/datasets/ABC-iRobotics/LabWare_Items" target="_blank" rel="noreferrer">
                Hugging Face
              </a>
            </span>
          </footer>
        </main>
      )}
      <Toast />
    </>
  );
}
