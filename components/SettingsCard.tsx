"use client";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DECISION_MODELS, modelInfo } from "@/lib/models";
import { checkKey, type KeyInfo } from "@/lib/openrouter";
import { activeModel, useStore } from "@/lib/store";
import { Button, Card, cx, Field, inputClass } from "./ui";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; info: KeyInfo } | { state: "error"; message: string };

const CUSTOM = "__custom__";

export function useKeyCheck() {
  const apiKey = useStore((s) => s.settings.apiKey);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const seq = useRef(0);
  const run = async (key = apiKey) => {
    if (!key) return setCheck({ state: "idle" });
    const id = ++seq.current;
    setCheck({ state: "checking" });
    try {
      const info = await checkKey(key);
      if (id === seq.current) setCheck({ state: "ok", info });
    } catch (err) {
      if (id === seq.current) setCheck({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  return { check, run, setCheck };
}

export function SettingsCard() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  // The model belongs to the selected prompt: picking one edits the prompt.
  const model = useStore(activeModel);
  const promptId = useStore((s) => s.selection.prompt);
  const setPromptModel = useStore((s) => s.setPromptModel);
  const peeking = useStore((s) => !!s.peek);
  const [show, setShow] = useState(false);
  const [draft, setDraft] = useState(settings.apiKey);
  const { check, run, setCheck } = useKeyCheck();
  const known = DECISION_MODELS.some((m) => m.id === model);
  // "Other model id…" applies to the prompt it was picked on; another prompt shows its own model in the list.
  const [customFor, setCustomFor] = useState<{ prompt: string | null } | null>(null);
  const custom = customFor?.prompt === promptId || !known;

  useEffect(() => {
    setDraft(settings.apiKey);
    if (settings.apiKey) void run(settings.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    const key = draft.trim();
    setSettings({ apiKey: key });
    void run(key);
  };

  return (
    <Card className="p-4 sm:p-5" aria-label="Settings" data-panel="settings">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Settings</div>
      <div className="mt-0.5 text-[17px] font-semibold tracking-tight">Model access</div>

      <div className="mt-3 space-y-3.5">
        <Field label="OpenRouter API key">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <input
                type={show ? "text" : "password"}
                value={draft}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-v1-…"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCheck({ state: "idle" });
                }}
                onKeyDown={(e) => e.key === "Enter" && save()}
                onBlur={() => draft.trim() !== settings.apiKey && save()}
                className={cx(inputClass, "pl-8 pr-8 font-mono text-[12px]")}
                aria-label="OpenRouter API key"
              />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide key" : "Show key"} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink">
                {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <Button onClick={save} loading={check.state === "checking"} disabled={!draft.trim()}>
              {draft.trim() === settings.apiKey && check.state === "ok" ? "Recheck" : "Save & check"}
            </Button>
          </div>
        </Field>

        <KeyStatus check={check} hasKey={!!settings.apiKey} />

        <div className="flex gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-snug text-ink-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-good-ink" />
          <div>
            Your key is stored <b className="font-medium text-ink">only in this browser</b> (local storage) and is sent only to openrouter.ai. Still: use a dedicated key with a{" "}
            <b className="font-medium text-ink">spending limit</b>, never a shared or production key, and delete it from{" "}
            <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="text-accent-ink underline-offset-2 hover:underline">
              openrouter.ai/settings/keys
            </a>{" "}
            when you are done. Anyone with access to this browser profile can read it.
          </div>
        </div>

        <Field label="Decision model" hint={`Saved with the prompt${modelInfo(model)?.maxImages ? ` · up to ${modelInfo(model)?.maxImages} images per request` : ""}`}>
          <select
            value={custom ? CUSTOM : model}
            onChange={(e) => {
              if (e.target.value === CUSTOM) return setCustomFor({ prompt: promptId });
              setCustomFor(null);
              setPromptModel(e.target.value);
            }}
            disabled={peeking}
            className={cx(inputClass, "h-8.5 py-0")}
            aria-label="Decision model"
          >
            {DECISION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.id}
              </option>
            ))}
            <option value={CUSTOM}>Other model id…</option>
          </select>
        </Field>
        {custom && (
          <Field label="Model id" hint="Any model served by the Decisions API">
            <input value={model} onChange={(e) => setPromptModel(e.target.value.trim())} disabled={peeking} placeholder="vendor/model-name" className={cx(inputClass, "font-mono text-[12px]")} aria-label="Custom model id" />
          </Field>
        )}
        <Field label="Parallel requests" hint="Lower it if you hit rate limits">
          <div className="flex items-center gap-3">
            <input type="range" min={1} max={12} value={settings.concurrency} onChange={(e) => setSettings({ concurrency: Number(e.target.value) })} className="flex-1 accent-[var(--accent)]" aria-label="Parallel requests" />
            <span className="w-6 text-right text-[13px] font-medium tabular">{settings.concurrency}</span>
          </div>
        </Field>
        <p className="text-[11.5px] leading-snug text-muted">
          The model is part of the prompt: changing it makes a new prompt version, compared against the last one like any other edit, and it is saved in prompt
          exports. Answers are never reused across models. Switching back to a model you already scored brings its cached answers back.
        </p>
      </div>
    </Card>
  );
}

function KeyStatus({ check, hasKey }: { check: Check; hasKey: boolean }) {
  if (check.state === "checking")
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <Loader2 className="size-4 animate-spin" /> Checking the key with OpenRouter…
      </div>
    );
  if (check.state === "error")
    return (
      <div className="flex items-start gap-2 rounded-xl bg-critical-wash px-3 py-2 text-[12.5px] text-critical-ink">
        <XCircle className="mt-0.5 size-4 shrink-0" /> {check.message}
      </div>
    );
  if (check.state === "ok") {
    const { info } = check;
    const noCap = info.limit == null;
    return (
      <div className={cx("rounded-xl px-3 py-2 text-[12.5px]", noCap ? "bg-warning-wash text-warning-ink" : "bg-good-wash text-good-ink")}>
        <div className="flex items-center gap-2 font-medium">
          {noCap ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
          Connected · key “{info.label}”
        </div>
        <div className="mt-0.5 pl-6 text-ink-2">
          {noCap ? (
            <>This key has no spending limit. Set one on OpenRouter before running large datasets.</>
          ) : (
            <>
              Spending limit ${info.limit?.toFixed(2)} · ${info.limitRemaining?.toFixed(2)} left
            </>
          )}
        </div>
      </div>
    );
  }
  return hasKey ? null : (
    <div className="text-[12.5px] text-ink-2">
      No key yet. The demo results below are cached, so you can explore them without one. Scoring new images needs a key.
    </div>
  );
}
