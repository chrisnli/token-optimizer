export const DEFAULT_ROUTE_MODELS = {
  economy: "gpt-5.4-mini",
  balanced: "gpt-5.4",
  advanced: "gpt-5.6-sol"
};

export const FALLBACK_ROUTE = "balanced";

export function knownRoutes() {
  return Object.keys(DEFAULT_ROUTE_MODELS);
}

export function isKnownRoute(routeId) {
  return typeof routeId === "string" && routeId in DEFAULT_ROUTE_MODELS;
}

export function modelForRoute(routeId, env = {}) {
  if (!isKnownRoute(routeId)) {
    return null;
  }
  const override = env[`SMARTCODEX_ROUTE_${routeId.toUpperCase()}_MODEL`];
  return override || DEFAULT_ROUTE_MODELS[routeId];
}
