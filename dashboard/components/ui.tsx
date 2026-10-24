import type React from "react";
import type { ReactNode } from "react";

export type Tone = "neutral" | "good" | "warn" | "danger" | "info";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink border-line",
  good: "bg-accent-soft text-accent border-accent/40",
  warn: "bg-warn-soft text-warn border-warn/40",
  danger: "bg-danger-soft text-danger border-danger/40",
  info: "bg-info-soft text-info border-info/40",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
  wrap = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Allow long text (signal lists) to wrap on narrow screens. */
  wrap?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-base font-semibold ${wrap ? "max-w-full break-words" : "whitespace-nowrap"} ${toneClass[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6 ${className}`}
    >
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-xl font-bold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1 text-lg text-muted">{subtitle}</p>}
      </div>
      {aside}
    </header>
  );
}

export function Meter({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: Tone;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const fill: Record<Tone, string> = {
    neutral: "bg-muted",
    good: "bg-accent",
    warn: "bg-warn",
    danger: "bg-danger",
    info: "bg-info",
  };
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-4 w-full overflow-hidden rounded-full border border-line bg-surface-2"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fill[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="py-8 text-lg text-muted" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line bg-surface-2/50 px-5 py-8 text-center text-lg text-muted">
      {children}
    </p>
  );
}

export function Placeholder({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <Badge tone="info">Coming in {phase}</Badge>
        <div className="mt-4 space-y-3 text-lg text-muted">{children}</div>
      </Card>
    </>
  );
}

type ButtonVariant = "primary" | "danger" | "secondary" | "ghost";

const buttonClass: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent hover:bg-accent-strong focus-visible:ring-accent/40",
  danger: "bg-danger text-canvas hover:opacity-90 focus-visible:ring-danger/40",
  secondary:
    "border border-line bg-surface text-ink hover:bg-surface-2 focus-visible:ring-accent/40",
  ghost: "text-accent hover:bg-surface-2 focus-visible:ring-accent/40",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "md" | "lg";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50 ${
        size === "lg" ? "min-h-14 px-6 text-xl" : "min-h-11 px-4 text-lg"
      } ${buttonClass[variant]} ${className}`}
    />
  );
}

/** Inline error under a form or action, announced to screen readers. */
export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 text-base font-semibold text-danger">
      {children}
    </p>
  );
}

/** Small "label: value" stat for big-screen panels. */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  const color: Record<Tone, string> = {
    neutral: "text-ink",
    good: "text-accent",
    warn: "text-warn",
    danger: "text-danger",
    info: "text-info",
  };
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-4">
      <dt className="text-base text-muted">{label}</dt>
      <dd className={`mt-1 text-4xl font-bold tabular-nums ${color[tone]}`}>
        {value}
      </dd>
      {hint && <dd className="mt-1 text-base text-muted">{hint}</dd>}
    </div>
  );
}
