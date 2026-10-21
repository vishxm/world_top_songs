import { Link } from "react-router";
import RecoveryScreen from "~/components/RecoveryScreen";

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
