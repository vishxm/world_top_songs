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
    { title: "World Top Songs — Every Country's Weekly Chart" },
    {
      name: "description",
      content:
        "Spin a quiet globe, pick any country, and hear its official weekly music chart. Songs and videos, live from YouTube Charts. No account, no keys.",
    },
    { name: "theme-color", content: "#0b0c0b" },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only-focusable fixed top-3 left-3 z-[100] rounded-control bg-accent px-3 py-2 text-small font-semibold text-accent-ink"
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
        <p style={{ padding: "2rem", color: "#f2efe7", fontFamily: "system-ui" }}>
          World Top Songs needs JavaScript to draw the globe.
        </p>
      </noscript>
    </>
  );
}
