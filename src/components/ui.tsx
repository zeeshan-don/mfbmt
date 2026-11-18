import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{eyebrow}</p> : null}
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-soft">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  children,
  className,
  as: Tag = "div",
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
  id?: string;
}) {
  return (
    <Tag id={id} className={clsx("panel shadow-panel", className)}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-elevated text-soft",
  accent: "border-accent/30 bg-accent/10 text-accent",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

/** Status always carries text, never colour alone. */
export function Badge({ children, tone = "neutral", dot = false }: { children: ReactNode; tone?: BadgeTone; dot?: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5",
        TONES[tone],
      )}
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function statusTone(status: string | null | undefined): BadgeTone {
  if (!status) return "neutral";
  const ok = ["AVAILABLE", "APPROVED", "CONNECTED", "COMPLETED", "EXACT", "PRICE_CONFIRMED", "VERIFIED", "READY", "IN_STOCK"];
  const warn = ["PARTIAL", "PENDING", "NEEDS_REVIEW", "AWAITING_APPROVAL", "POSSIBLE", "INSUFFICIENT", "QUEUED", "SEARCHING", "NEEDS_ATTENTION", "AWAITING_SEND", "RESPONDED"];
  const danger = ["SHORT", "NONE", "FAILED", "REJECTED", "NO_MATCH", "EXPIRED", "BLOCKED", "NOT_CONFIGURED", "CLARIFY"];
  if (ok.includes(status)) return "ok";
  if (warn.includes(status)) return "warn";
  if (danger.includes(status)) return "danger";
  return "neutral";
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  type = "submit",
  name,
  value,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  className?: string;
  type?: "submit" | "button";
  name?: string;
  value?: string;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90 border border-transparent",
    secondary: "border border-line bg-surface text-ink hover:bg-elevated",
    ghost: "text-soft hover:bg-elevated hover:text-ink border border-transparent",
    danger: "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/15",
  }[variant];
  return (
    <button
      type={type}
      name={name}
      value={value}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        styles,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "secondary",
  size = "md",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-line bg-surface text-ink hover:bg-elevated",
    ghost: "text-soft hover:bg-elevated hover:text-ink",
  }[variant];
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        styles,
      )}
    >
      {children}
    </Link>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="rounded-full border border-line bg-elevated p-3 text-muted">{icon}</div> : null}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function DataTable({ children, minWidth = 720 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="scroll-x measured">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" | "center" }) {
  return (
    <th
      scope="col"
      className={clsx(
        "whitespace-nowrap border-b border-line px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <td
      className={clsx(
        "border-b border-line/70 px-3 py-2.5 align-top text-ink",
        align === "right" ? "text-right tabular" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Field({
  label,
  children,
  hint,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-xs font-medium text-soft">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-control border border-line bg-bg px-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none";

export const textareaClass =
  "w-full rounded-control border border-line bg-bg px-2.5 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none";

export function Notice({
  tone = "warn",
  title,
  children,
}: {
  tone?: "warn" | "danger" | "ok" | "info";
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    warn: "border-warn/30 bg-warn/5 text-ink",
    danger: "border-danger/30 bg-danger/5 text-ink",
    ok: "border-ok/30 bg-ok/5 text-ink",
    info: "border-accent/30 bg-accent/5 text-ink",
  }[tone];
  return (
    <div className={clsx("rounded-card border px-3.5 py-3 text-sm", styles)} role={tone === "danger" ? "alert" : "status"}>
      {title ? <p className="mb-0.5 text-[13px] font-semibold">{title}</p> : null}
      <div className="text-[13px] leading-relaxed text-soft">{children}</div>
    </div>
  );
}

export function DemoTag() {
  return <Badge tone="warn">Sample data</Badge>;
}
