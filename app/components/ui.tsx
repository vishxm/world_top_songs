import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Region } from "~/lib/countryMeta";
import { initials } from "~/lib/format";

/** Region-tinted swatch carrying the ISO code. Chosen over flag emoji because
 *  emoji flags render as bare letter pairs on Windows/Chrome and can't be
 *  tinted, sized or aligned consistently — this can. */
const REGION_TONE: Record<Region, string> = {
  Africa: "text-accent",
  Americas: "text-up",
  Asia: "text-live",
  Europe: "text-[#c4b5fd]",
  Oceania: "text-down",
  "Polar & Remote": "text-muted",
};

const MARK_SIZE = {
  lg: "h-11 w-11 rounded-[14px] text-[13px]",
  md: "h-8 w-8 rounded-[10px] text-[11px]",
  sm: "h-6 w-6 rounded-[7px] text-[9px]",
} as const;

export function CountryMark({
  iso,
  region = "Polar & Remote",
  size = "md",
}: {
  iso: string;
  region?: Region;
  size?: keyof typeof MARK_SIZE;
}) {
  return (
    <span
      aria-hidden
      className={`tnum inline-flex shrink-0 items-center justify-center border border-current/25 bg-current/10 font-semibold tracking-[0.08em] ${MARK_SIZE[size]} ${REGION_TONE[region]}`}
    >
      {initials(iso)}
    </span>
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
      className={`inline-grid h-9 w-9 place-items-center rounded-xl border border-line bg-panel/70 text-muted backdrop-blur transition hover:border-line-bright hover:text-ink active:scale-95 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span className={`relative block overflow-hidden rounded-md bg-raised ${className}`} style={style}>
      <span className="absolute inset-0 animate-shimmer bg-linear-to-r from-transparent via-line/70 to-transparent" />
    </span>
  );
}

/** Chart-row skeleton matching the real row's metrics so the list doesn't jump
 *  when data lands. */
export function ChartRowSkeleton({ index }: { index: number }) {
  const width = 62 + ((index * 13) % 34);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Skeleton className="tnum h-4 w-5" />
      <Skeleton className="aspect-video w-[52px] shrink-0 rounded-md" />
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
    <div className="flex flex-col items-center gap-3 px-8 py-14 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-2xl border border-line bg-raised text-faint">
        {icon}
      </span>
      <p className="display text-lg text-ink">{title}</p>
      <p className="max-w-[28ch] text-pretty text-[13px] leading-relaxed text-muted">{body}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

const PILL_TONE = {
  neutral: "text-faint bg-raised border-line",
  up: "text-up bg-up/12 border-transparent",
  down: "text-down bg-down/12 border-transparent",
  new: "text-accent bg-accent/16 border-transparent",
  accent: "text-accent bg-accent/14 border-transparent",
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
      className={`tnum inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 text-[10px] font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}
