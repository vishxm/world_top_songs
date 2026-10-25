import type { ReactNode } from "react";
import { AtlasMark } from "./ui";

/**
 * The one recovery surface.
 *
 * Used by the 404 route and by the root error boundary, so a dead end still
 * looks like this app rather than the stock router page. It deliberately has no
 * card: the mark, the sentence and one clear way back are enough.
 */
export default function RecoveryScreen({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <main
      id="main"
      className="relative grid min-h-dvh place-items-center overflow-hidden bg-void px-6 py-16 text-ink"
    >
      <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0" />
      <div className="relative flex w-full max-w-md flex-col items-center text-center">
        <AtlasMark className="h-10 w-10 text-accent" />
        <p className="eyebrow mt-5">{eyebrow}</p>
        <h1 className="display mt-2 text-balance text-heading text-ink">{title}</h1>
        <div className="mt-3 text-pretty text-body leading-relaxed text-muted">{children}</div>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      </div>
    </main>
  );
}
