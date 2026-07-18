import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROUTE_MODELS, FALLBACK_ROUTE, isKnownRoute, modelForRoute } from "../src/router.js";

test("default route models", () => {
  assert.equal(modelForRoute("economy", {}), "gpt-5.4-mini");
  assert.equal(modelForRoute("balanced", {}), "gpt-5.4");
  assert.equal(modelForRoute("advanced", {}), "gpt-5.6-sol");
});

test("env overrides take precedence", () => {
  const env = { SMARTCODEX_ROUTE_ECONOMY_MODEL: "custom-mini" };
  assert.equal(modelForRoute("economy", env), "custom-mini");
  assert.equal(modelForRoute("balanced", env), "gpt-5.4");
});

test("unknown route returns null", () => {
  assert.equal(modelForRoute("luxury", {}), null);
  assert.equal(modelForRoute(undefined, {}), null);
  assert.equal(isKnownRoute("luxury"), false);
});

test("fallback route is a known route", () => {
  assert.ok(FALLBACK_ROUTE in DEFAULT_ROUTE_MODELS);
});
