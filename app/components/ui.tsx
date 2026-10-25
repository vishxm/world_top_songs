import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Region } from "~/lib/countryMeta";
import { initials } from "~/lib/format";

const MARK_SIZE = {
  lg: "h-10 w-10 text-body",
  md: "h-8 w-8 text-small",
  sm: "h-6 w-6 text-eyebrow",
} as const;

/**
 * The ISO code as a quiet index mark. It used to be tinted by region in six
 * hues, which made the picker read as a colour legend; the region is already
 * said by the group heading, so the mark stays neutral.
 */
export function CountryMark({
  iso,
  size = "md",
}: {
  iso: string;
  region?: Region;
  size?: keyof typeof MARK_SIZE;
}) {
  return (
    <span
      aria-hidden
      className={`tnum inline-flex shrink-0 items-center justify-center rounded-control border border-line bg-raised font-semibold tracking-[0.08em] text-muted ${MARK_SIZE[size]}`}
    >
      {initials(iso)}
    </span>
  );
}

/**
 * The wordmark's mark: an armillary sphere reduced to three hairline rings.
 * Drawn rather than bought so it belongs only to this app; still monochrome,
 * so it inherits whatever colour the header gives it.
 */
export function AtlasMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" strokeWidth="1.2" />
      <ellipse cx="12" cy="12" rx="4.2" ry="9" strokeWidth="0.9" opacity="0.7" />
      <path d="M3 12h18" strokeWidth="0.9" opacity="0.7" />
      <path d="M5.2 7.1h13.6M5.2 16.9h13.6" strokeWidth="0.8" opacity="0.4" />
    </svg>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  className = "",
  ...rest
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className" | "aria-label">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`btn btn-quiet h-9 w-9 shrink-0 p-0 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <span className={`block rounded-sm bg-raised ${className}`} style={style} />;
}

/** Chart-row skeleton matching the real row's metrics so the list doesn't jump
 *  when data lands. */
export function ChartRowSkeleton({ index }: { index: number }) {
  const width = 62 + ((index * 13) % 34);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Skeleton className="tnum h-4 w-5" />
      <Skeleton className="aspect-video w-[52px] shrink-0 rounded-sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3" style={{ width: `${width}%` }} />
        <Skeleton className="h-2.5 w-[38%]" />
      </span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-12 text-center">
      <span className="text-faint" aria-hidden>
        {icon}
      </span>
      <p className="display text-title text-ink">{title}</p>
      <p className="max-w-[30ch] text-pretty text-small leading-relaxed text-muted">{body}</p>
      {action ? <div className="pt-1.5">{action}</div> : null}
    </div>
  );
}

const PILL_TONE = {
  neutral: "text-faint border-line bg-raised/70",
  up: "text-up border-up/25 bg-up/10",
  down: "text-down border-down/25 bg-down/10",
  new: "text-accent border-accent/30 bg-accent/10",
  accent: "text-accent border-accent/30 bg-accent/10",
} as const;

export function Pill({
  tone = "neutral",
  children,
  title,
}: {
  tone?: keyof typeof PILL_TONE;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`tnum inline-flex h-[18px] shrink-0 items-center rounded-pill border px-1.5 text-eyebrow font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}
