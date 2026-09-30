import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("api/charts", "routes/api.charts.ts"),
] satisfies RouteConfig;
