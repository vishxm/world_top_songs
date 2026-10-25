import { data, Link } from "react-router";
import RecoveryScreen from "~/components/RecoveryScreen";

/**
 * An unknown address is a real 404, not a 200 page that says "404". This also
 * keeps build inputs that used to live in `public/` (the full and simplified
 * world maps) from answering with the app shell after they moved to `data/`.
 */
export function loader() {
  return data(null, { status: 404 });
}

export function meta() {
  return [{ title: "Page not found — World Top Songs" }];
}

export default function NotFound() {
  return (
    <RecoveryScreen
      eyebrow="Off the map · 404"
      title="This page isn’t on the chart"
      actions={
        <Link to="/" className="btn btn-primary">
          Back to the globe
        </Link>
      }
    >
      <p>The address doesn’t match any page here. The globe is one tap away.</p>
    </RecoveryScreen>
  );
}
