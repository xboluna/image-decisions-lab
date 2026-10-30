"use client";
import { Check, Copy, Info, Loader2, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shortHash } from "@/lib/hash";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background,box-shadow,color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8.5 px-3.5 text-[13px]",
        variant === "primary" && "bg-accent text-white shadow-card hover:brightness-110 active:brightness-95",
        variant === "secondary" && "border border-line-strong bg-surface text-ink shadow-card hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-3 hover:text-ink",
        variant === "danger" && "border border-line-strong bg-surface text-critical-ink hover:bg-critical-wash",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx("inline-flex size-7 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </section>
  );
}

export function SectionTitle({ eyebrow, title, right, className }: { eyebrow?: string; title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{eyebrow}</div>}
        <h2 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      </div>
      {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", className, children, title }: { tone?: "neutral" | "accent" | "good" | "warning" | "serious" | "critical"; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium",
        tone === "neutral" && "bg-surface-3 text-ink-2",
        tone === "accent" && "bg-accent-wash text-accent-ink",
        tone === "good" && "bg-good-wash text-good-ink",
        tone === "warning" && "bg-warning-wash text-warning-ink",
        tone === "serious" && "bg-serious-wash text-serious-ink",
        tone === "critical" && "bg-critical-wash text-critical-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A content hash shown short, copied in full on click. */
export function HashChip({ hash, prefix, title, className }: { hash: string | undefined; prefix?: string; title?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!hash) return <span className="inline-block h-5 w-24 rounded-md shimmer" />;
  return (
    <button
      type="button"
      title={`${title ?? "Content hash"}: sha256:${hash}\nClick to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(`sha256:${hash}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cx(
        "group inline-flex h-5.5 items-center gap-1 rounded-md border border-line bg-surface-2 pl-1.5 pr-1 font-mono text-[11px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      {prefix && <span className="text-muted">{prefix}</span>}
      {shortHash(hash, 10)}
      {copied ? <Check className="size-3 text-good-ink" /> : <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />}
    </button>
  );
}

const modalStack: object[] = [];

export function Modal({ open, onClose, title, subtitle, children, footer, width = "max-w-2xl" }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const token = useRef({});
  useEffect(() => {
    if (!open) return;
    // Dialogs can open on top of each other; Escape closes only the topmost one.
    const me = token.current;
    modalStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === me) {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(me), 1);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx("animate-pop w-full rounded-2xl border border-line bg-surface shadow-pop", width)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-2">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[12px] font-medium text-ink-2">
        <span>{label}</span>
        {hint && <span className="font-normal text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-muted outline-none transition-shadow focus:border-accent focus:ring-3 focus:ring-[var(--focus)]";

export function Segmented<T extends string>({ value, options, onChange, size = "md", disabled }: { value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; size?: "sm" | "md"; disabled?: boolean }) {
  return (
    <div className={cx("inline-flex rounded-lg border border-line bg-surface-3 p-0.5", disabled && "opacity-50")} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex items-center gap-1 whitespace-nowrap rounded-md font-medium transition-all disabled:cursor-not-allowed",
            size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-7 px-2.5 text-[12.5px]",
            value === o.value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-muted", className)} />;
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-surface-3", className)}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** Closes when clicking outside. Used for small menus and popovers. */
export function Popover({ open, onClose, children, className, align = "right" }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={cx("animate-pop absolute top-full z-40 mt-1.5 rounded-xl border border-line bg-surface p-1 shadow-pop", align === "right" ? "right-0" : "left-0", className)}>
      {children}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, tone, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; tone?: "danger"; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40",
        tone === "danger" ? "text-critical-ink hover:bg-critical-wash" : "text-ink hover:bg-surface-3",
      )}
    >
      <span className="text-muted">{icon}</span>
      {children}
    </button>
  );
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  return x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)}%`;
}

export function fmtUsd(x: number): string {
  if (x === 0) return "$0";
  if (x < 0.01) return `$${x.toFixed(4)}`;
  return `$${x.toFixed(2)}`;
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** An (i) button that explains a metric on hover or keyboard focus. Rendered in a portal so cards never clip it. */
export function InfoTip({ text, label = "More information" }: { text: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const id = useRef(`tip-${Math.random().toString(36).slice(2, 9)}`).current;
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = 260;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = r.top < 120;
    setPos({ left, top: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    // Follow the icon when the page scrolls (focusing it can scroll it into view).
    const follow = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-describedby={pos ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          if (pos) hide();
          else show();
        }}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-ink focus-visible:text-ink"
      >
        <Info className="size-3" />
      </button>
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="animate-pop pointer-events-none fixed z-[60] w-[260px] rounded-lg bg-ink px-3 py-2 text-[12px] font-normal leading-snug text-surface shadow-pop"
            style={{ left: pos.left, top: pos.top, transform: pos.below ? undefined : "translateY(-100%)" }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
