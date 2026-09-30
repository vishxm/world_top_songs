import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./app.css";

export function links() {
  return [
    { rel: "icon", href: "/favicon.ico" },
    { rel: "preconnect", href: "https://www.youtube.com" },
  ];
}

export function meta() {
  return [
    { title: "World Top Songs — Hear the Planet's Weekly Top 10" },
    {
      name: "description",
      content:
        "Spin a 3D globe, pick any of 236 countries, and play its current weekly Top 10. Live YouTube and Spotify charts, no account, no keys.",
    },
    { name: "theme-color", content: "#04060b" },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="mission">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only-focusable fixed top-3 left-3 z-100 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink"
        >
          Skip to content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <Outlet />
      <noscript>
        <p style={{ padding: "2rem", color: "#eef2f8", fontFamily: "system-ui" }}>
          World Top Songs needs JavaScript to draw the globe.
        </p>
      </noscript>
    </>
  );
}
