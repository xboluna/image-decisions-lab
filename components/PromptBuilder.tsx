"use client";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, Check, ChevronDown, Copy, Download, Eye, FileText, GripVertical, ImagePlus, Images, Plus, Trash2, Undo2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { db } from "@/lib/db";
import { exportPrompt } from "@/lib/export";
import { sha256Bytes } from "@/lib/hash";
import { imageSize, resizeJpeg } from "@/lib/image";
import { modelInfo } from "@/lib/models";
import { promptProblems } from "@/lib/prompt";
import { importPromptZip } from "@/lib/promptImport";
import { useStore } from "@/lib/store";
import type { Dataset, LabelSchema, Prompt, PromptExample } from "@/lib/types";
import { classColor } from "./colors";
import { StoredImage } from "./StoredImage";
import { Badge, Button, Card, cx, Field, HashChip, IconButton, inputClass, MenuItem, Modal, Popover, Segmented } from "./ui";

function PromptPicker({ prompt }: { prompt: Prompt | undefined }) {
  const prompts = useStore((s) => s.prompts);
  const hashes = useStore((s) => s.promptHashes);
  const selectPrompt = useStore((s) => s.selectPrompt);
  const createPrompt = useStore((s) => s.createPrompt);
  const addPrompt = useStore((s) => s.addPrompt);
  const duplicatePrompt = useStore((s) => s.duplicatePrompt);
  const deletePrompt = useStore((s) => s.deletePrompt);
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Prompt | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const currentHash = prompt ? hashes[prompt.id] : undefined;

  async function importZip(file: File) {
    try {
      const { prompt: imported, warnings } = await importPromptZip(file, prompts.map((p) => p.name));
      await addPrompt(imported);
      notify(`Imported “${imported.name}” with ${imported.examples.length} example${imported.examples.length === 1 ? "" : "s"}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`, warnings.length ? "error" : "info");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <div className="relative -ml-1.5 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Choose prompt"
        className="group flex min-w-0 max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-3"
      >
        <span className="truncate text-[17px] font-semibold tracking-tight">{prompt?.name ?? "No prompt"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-aria-expanded:rotate-180" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="left" className="w-[min(400px,85vw)]">
        <div className="max-h-[50vh] overflow-y-auto scroll-thin">
          {prompts.map((p) => (
            <div key={p.id} className={cx("group/row flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-3", p.id === prompt?.id && "bg-accent-wash/60")}>
              <button
                type="button"
                onClick={() => {
                  selectPrompt(p.id);
                  setOpen(false);
                }}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
              >
                <FileText className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {p.targetKey || "no label"} · {p.examples.length} example{p.examples.length === 1 ? "" : "s"} · {hashes[p.id]?.slice(0, 8)}
                  </span>
                </span>
              </button>
              <IconButton label={`Duplicate ${p.name}`} onClick={() => void duplicatePrompt(p.id)} className="opacity-60 group-hover/row:opacity-100">
                <Copy className="size-3.5" />
              </IconButton>
              <IconButton label={`Delete ${p.name}`} onClick={() => setConfirmDelete(p)} className="opacity-60 hover:text-critical-ink group-hover/row:opacity-100">
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-line pt-1">
          <MenuItem
            icon={<Plus className="size-4" />}
            onClick={() => {
              setOpen(false);
              void createPrompt();
            }}
          >
            New blank prompt
          </MenuItem>
          <MenuItem icon={<Upload className="size-4" />} onClick={() => importInput.current?.click()}>
            Import prompt (.zip)…
          </MenuItem>
          <MenuItem
            icon={<Download className="size-4" />}
            disabled={!prompt || !currentHash}
            onClick={() => {
              setOpen(false);
              if (prompt && currentHash) void exportPrompt(prompt, currentHash);
            }}
          >
            Download “{prompt?.name ?? "prompt"}” (.zip)
          </MenuItem>
        </div>
      </Popover>
      <input
        ref={importInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        aria-label="Import prompt zip"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          setOpen(false);
          if (f) void importZip(f);
        }}
      />
      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title={`Delete “${confirmDelete.name}”?`}
          subtitle="Runs made with it stay in the history, and its cached answers are kept."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await deletePrompt(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete prompt
              </Button>
            </>
          }
        >
          <p className="text-[12.5px] text-ink-2">Download it first to keep a copy of the text, the question and the reference images. A downloaded prompt can be imported again.</p>
        </Modal>
      )}
    </div>
  );
}

function ExampleRow({ example, index, prompt, schema }: { example: PromptExample; index: number; prompt: Prompt; schema: LabelSchema | undefined }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: example.id });
  const updateExample = useStore((s) => s.updateExample);
  const removeExample = useStore((s) => s.removeExample);
  const target = schema ? (schema.type === "boolean" ? ({ type: "boolean" } as const) : ({ type: "categorical", classes: schema.classes } as const)) : null;
  const badLabel = schema?.type === "categorical" && !schema.classes.includes(String(example.label));
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("flex gap-2 rounded-xl border bg-surface p-2", isDragging ? "z-10 border-accent shadow-pop" : "border-line")}
    >
      <button type="button" className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted hover:bg-surface-3 hover:text-ink active:cursor-grabbing" aria-label={`Reorder example ${index + 1}`} {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <div className="relative h-[62px] w-[92px] shrink-0 overflow-hidden rounded-lg bg-surface-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <StoredImage hash={example.imageHash} alt={example.fileName} className="size-full object-cover" />
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold text-white tabular">#{index + 1}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {prompt.targetType === "boolean" ? (
            <Segmented<"pos" | "neg">
              size="sm"
              value={example.label === true ? "pos" : "neg"}
              onChange={(v) => updateExample(example.id, { label: v === "pos" })}
              options={[
                { value: "pos", label: <span className="inline-flex items-center gap-1"><span className="size-2 rounded-[3px]" style={{ background: "var(--class-1)" }} />Positive</span> },
                { value: "neg", label: <span className="inline-flex items-center gap-1"><span className="size-2 rounded-[3px]" style={{ background: "var(--class-2)" }} />Negative</span> },
              ]}
            />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: classColor(target, {}, String(example.label)) }} />
              <select
                aria-label={`Class of example ${index + 1}`}
                value={String(example.label)}
                onChange={(e) => updateExample(example.id, { label: e.target.value })}
                className={cx("h-6.5 rounded-md border bg-surface px-1.5 text-[12px] font-medium outline-none focus:border-accent", badLabel ? "border-critical text-critical-ink" : "border-line-strong")}
              >
                {badLabel && <option value={String(example.label)}>{String(example.label)} (not in dataset)</option>}
                {(schema?.type === "categorical" ? schema.classes : []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-muted" title={example.fileName}>
            {example.fileName.split("/").pop()}
          </span>
          <IconButton label={`Remove example ${index + 1}`} onClick={() => removeExample(example.id)} className="size-6">
            <X className="size-3.5" />
          </IconButton>
        </div>
        <textarea
          value={example.caption}
          onChange={(e) => updateExample(example.id, { caption: e.target.value })}
          rows={1}
          placeholder="Annotation: what to notice in this image (optional)"
          className={cx(inputClass, "min-h-[30px] resize-y py-1 text-[12px] leading-snug [field-sizing:content]")}
        />
      </div>
    </li>
  );
}

function ExamplePicker({ open, onClose, dataset, prompt }: { open: boolean; onClose: () => void; dataset: Dataset | undefined; prompt: Prompt }) {
  const addExample = useStore((s) => s.addExample);
  const [filter, setFilter] = useState<string>("all");
  const schema = dataset?.schema.find((s) => s.key === prompt.targetKey);
  const target = schema ? (schema.type === "boolean" ? ({ type: "boolean" } as const) : ({ type: "categorical", classes: schema.classes } as const)) : null;
  const values = schema ? (schema.type === "boolean" ? ["true", "false"] : schema.classes) : [];
  const items = (dataset?.items ?? []).filter((i) => filter === "all" || String(i.labels[prompt.targetKey]) === filter);
  const used = new Set(prompt.examples.map((e) => e.imageHash));
  return (
    <Modal open={open} onClose={onClose} width="max-w-4xl" title="Add reference examples from the training set" subtitle="Click images to add them with their labelled answer. Tip: pick the cases the model gets wrong.">
      {!dataset ? (
        <p className="text-[13px] text-ink-2">Select a training dataset first.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[{ value: "all", label: "All" }, ...values.map((v) => ({ value: v, label: schema?.type === "boolean" ? (v === "true" ? "Positives" : "Negatives") : v }))]}
            />
            <span className="ml-auto text-[12px] text-muted">{prompt.examples.length} in prompt</span>
          </div>
          <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 lg:grid-cols-5 scroll-thin">
            {items.map((item) => (
              <PickerTile
                key={item.id}
                hash={item.imageHash}
                name={item.fileName}
                label={item.labels[prompt.targetKey]}
                color={classColor(target, {}, item.labels[prompt.targetKey] == null ? null : String(item.labels[prompt.targetKey]))}
                boolean={schema?.type === "boolean"}
                used={used.has(item.imageHash)}
                onAdd={() => {
                  const v = item.labels[prompt.targetKey];
                  if (v == null) return;
                  addExample({ imageHash: item.imageHash, fileName: item.fileName, caption: "", label: prompt.targetType === "boolean" ? v === true : String(v) });
                }}
              />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function PickerTile({ hash, name, label, color, boolean, used, onAdd }: { hash: string; name: string; label: unknown; color: string; boolean: boolean; used: boolean; onAdd: () => void }) {
  return (
    <button type="button" disabled={used || label == null} onClick={onAdd} className={cx("group relative overflow-hidden rounded-lg border text-left transition-shadow", used ? "border-accent" : "border-line hover:shadow-pop")}>
      <div className="aspect-[16/10] bg-surface-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <StoredImage hash={hash} alt={name} className={cx("size-full object-cover", used && "opacity-50")} />
      </div>
      <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
        <span className="size-2 rounded-[3px]" style={{ background: color }} />
        {label == null ? "unlabelled" : boolean ? (label ? "yes" : "no") : String(label)}
      </span>
      {used ? (
        <span className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-accent text-white">
          <Check className="size-3" />
        </span>
      ) : (
        <span className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-surface/90 text-ink opacity-0 transition-opacity group-hover:opacity-100">
          <Plus className="size-3" />
        </span>
      )}
    </button>
  );
}

export function PromptBuilder() {
  const selected = useStore((s) => s.prompts.find((p) => p.id === s.selection.prompt));
  const selectedHash = useStore((s) => (selected ? s.promptHashes[selected.id] : undefined));
  const peek = useStore((s) => s.peek);
  const endPeek = useStore((s) => s.endPeek);
  // While peeking, the builder shows the earlier version, read-only.
  const prompt = peek?.prompt ?? selected;
  const hash = peek?.hash ?? selectedHash;
  const train = useStore((s) => s.datasets.find((d) => d.id === s.selection.train));
  const model = useStore((s) => s.settings.model);
  const updatePrompt = useStore((s) => s.updatePrompt);
  const setTarget = useStore((s) => s.setTarget);
  const moveExample = useStore((s) => s.moveExample);
  const addExample = useStore((s) => s.addExample);
  const createPrompt = useStore((s) => s.createPrompt);
  const notify = useStore((s) => s.notify);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const noSensors = useSensors();
  const schema = train?.schema.find((s) => s.key === prompt?.targetKey);
  const problems = useMemo(() => (prompt ? promptProblems(prompt, train?.schema) : []), [prompt, train]);
  const maxImages = modelInfo(model)?.maxImages;

  if (!prompt) {
    return (
      <Card className="p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Prompt builder</div>
        <div className="mt-6 flex flex-col items-center text-center">
          <FileText className="size-6 text-muted" />
          <div className="mt-2 text-[14px] font-semibold">No prompt yet</div>
          <p className="mt-1 text-[12.5px] text-ink-2">A prompt is the system text, the question, and reference images sent with every image.</p>
          <Button className="mt-3" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => void createPrompt()}>
            New prompt
          </Button>
        </div>
      </Card>
    );
  }

  const onDragEnd = (e: DragEndEvent) => {
    if (peek || !e.over || e.active.id === e.over.id) return;
    const from = prompt.examples.findIndex((x) => x.id === e.active.id);
    const to = prompt.examples.findIndex((x) => x.id === e.over!.id);
    if (from >= 0 && to >= 0) moveExample(from, to);
  };

  async function addFiles(files: File[]) {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const imageHash = await sha256Bytes(bytes);
      const blob = new Blob([bytes], { type: file.type });
      try {
        await imageSize(blob);
      } catch {
        notify(`${file.name} is not a readable image.`, "error");
        continue;
      }
      if (!(await db.hasImage(imageHash))) await db.putImage(imageHash, blob, (await resizeJpeg(blob, 384, 0.8)).blob);
      addExample({ imageHash, fileName: file.name, caption: "", label: prompt!.targetType === "boolean" ? true : (schema?.type === "categorical" ? schema.classes[0] : "") });
    }
  }

  const criteriaKeys = prompt.targetType === "boolean" ? ["true", "false"] : schema?.type === "categorical" ? schema.classes : Object.keys(prompt.criteria);
  const imageCount = prompt.examples.length + 1;

  return (
    <Card className="p-4 sm:p-5" aria-label="Prompt builder" data-panel="prompt">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Prompt builder</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
            {peek ? <span className="truncate text-[17px] font-semibold tracking-tight">{prompt.name}</span> : <PromptPicker prompt={prompt} />}
            <HashChip hash={hash} prefix="prompt" title="Prompt version (sha256 over everything sent to the model)" />
          </div>
        </div>
      </div>

      {peek && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-warning/60 bg-warning-wash px-3 py-2 text-[12.5px] text-warning-ink" data-peek-banner>
          <Eye className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Viewing an earlier version, read-only{peek.model !== model ? ` (scored with ${peek.model.split("/").pop()})` : ""}. Your working prompt is unchanged.
          </span>
          <Button size="sm" variant="primary" icon={<Undo2 className="size-3.5" />} onClick={endPeek}>
            Switch back
          </Button>
        </div>
      )}

      <fieldset disabled={!!peek} className={cx("m-0 mt-3 min-w-0 space-y-3.5 border-0 p-0", peek && "opacity-90")}>
        <Field label="Name" hint="Not part of the hash">
          <input value={prompt.name} onChange={(e) => updatePrompt(prompt.id, { name: e.target.value })} className={inputClass} aria-label="Prompt name" />
        </Field>

        <Field label="System prompt" hint="Sent first, before the examples">
          <textarea
            value={prompt.systemPrompt}
            onChange={(e) => updatePrompt(prompt.id, { systemPrompt: e.target.value })}
            rows={4}
            placeholder="Describe the scene, the camera, and anything the model should know before it looks at the images."
            className={cx(inputClass, "max-h-72 min-h-24 resize-y leading-relaxed [field-sizing:content]")}
          />
        </Field>

        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-ink-2">Label to classify</span>
            <select
              aria-label="Label to classify"
              value={prompt.targetKey}
              onChange={(e) => {
                const s = train?.schema.find((x) => x.key === e.target.value);
                if (s) setTarget(s);
              }}
              className="h-7 max-w-[60%] rounded-lg border border-line-strong bg-surface px-2 text-[12.5px] font-medium outline-none focus:border-accent"
            >
              {!train?.schema.some((s) => s.key === prompt.targetKey) && <option value={prompt.targetKey}>{prompt.targetKey || "Choose a label"}</option>}
              {train?.schema.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key} ({s.type === "boolean" ? "yes/no" : `${s.classes.length} classes`})
                </option>
              ))}
            </select>
          </div>
          <Field className="mt-2.5" label="Question" hint={prompt.targetType === "boolean" ? "Answered as P(yes)" : "Answered as P(class)"}>
            <textarea value={prompt.instructions} onChange={(e) => updatePrompt(prompt.id, { instructions: e.target.value })} rows={2} className={cx(inputClass, "resize-y leading-relaxed [field-sizing:content]")} aria-label="Question" />
          </Field>
          <div className="mt-2 space-y-1.5">
            {criteriaKeys.map((k) => (
              <div key={k} className="flex items-start gap-2">
                <span className="mt-1.5 inline-flex w-[88px] shrink-0 items-center gap-1.5 text-[12px] font-medium">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: classColor(schema ? (schema.type === "boolean" ? { type: "boolean" } : { type: "categorical", classes: schema.classes }) : null, {}, k) }} />
                  <span className="truncate">{prompt.targetType === "boolean" ? (k === "true" ? "Yes means" : "No means") : k}</span>
                </span>
                <textarea
                  rows={1}
                  aria-label={`Criterion for ${k}`}
                  value={prompt.criteria[k] ?? ""}
                  onChange={(e) => updatePrompt(prompt.id, { criteria: { ...prompt.criteria, [k]: e.target.value } })}
                  className={cx(inputClass, "min-h-[30px] resize-y py-1 text-[12.5px] leading-snug [field-sizing:content]")}
                />
              </div>
            ))}
          </div>
        </div>

        <div
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDropping(true);
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDropping(false);
            void addFiles(Array.from(e.dataTransfer.files));
          }}
          className={cx("rounded-xl transition-colors", dropping && "bg-accent-wash outline-2 outline-dashed outline-accent")}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-ink-2">
              Reference examples <span className="text-muted">· sent in this order</span>
            </span>
            <Badge tone={maxImages && imageCount > maxImages ? "critical" : "neutral"} title={maxImages ? `${model} accepts up to ${maxImages} images per request` : undefined}>
              {imageCount} image{imageCount === 1 ? "" : "s"} / request{maxImages ? ` · max ${maxImages}` : ""}
            </Badge>
          </div>
          {prompt.examples.length > 0 ? (
            <DndContext sensors={peek ? noSensors : sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={prompt.examples.map((e) => e.id)} strategy={verticalListSortingStrategy}>
                <ol className="space-y-1.5">
                  {prompt.examples.map((e, i) => (
                    <ExampleRow key={e.id} example={e} index={i} prompt={prompt} schema={schema} />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[12px] text-ink-2">
              No examples: the model sees only the text. Add labelled images to show it what {prompt.targetType === "boolean" ? "positive and negative cases" : "each class"} look like.
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" icon={<Images className="size-3.5" />} onClick={() => setPickerOpen(true)} disabled={!train}>
              From training set
            </Button>
            <Button size="sm" icon={<ImagePlus className="size-3.5" />} onClick={() => fileInput.current?.click()}>
              Upload image
            </Button>
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void addFiles(Array.from(e.target.files))} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            Image size sent
            <select
              value={prompt.imageMaxSide}
              onChange={(e) => updatePrompt(prompt.id, { imageMaxSide: Number(e.target.value) })}
              className="h-7 rounded-lg border border-line-strong bg-surface px-1.5 text-[12px] outline-none focus:border-accent"
            >
              {[512, 768, 1024, 1280, 1600].map((n) => (
                <option key={n} value={n}>
                  ≤ {n}px
                </option>
              ))}
            </select>
          </label>

        </div>

        {problems.length > 0 && (
          <div className="flex gap-2 rounded-xl bg-critical-wash px-3 py-2.5 text-[12.5px] text-critical-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <ul className="space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
      <ExamplePicker open={pickerOpen} onClose={() => setPickerOpen(false)} dataset={train} prompt={prompt} />
    </Card>
  );
}
