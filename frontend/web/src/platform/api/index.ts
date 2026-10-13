// composition/external/api — canonical barrel, re-exports from @retainpdf/api
// Source of truth for ALL API clients is @retainpdf/api; this barrel keeps
// the public import surface (pages stay `from "@/platform/api/index.js"`), but
// delegates to @retainpdf/api. Mock adapters live in ./mocks so mock mode stays identical;
//
// Per-domain canonical×mock dispatch lives in ./domains/*; this file only
// re-exports them. Keep the public export names/paths stable.

export * from "./domains/http.js";
export * from "./domains/jobs.js";
export * from "./domains/jobs-events.js";
export * from "./domains/jobs-artifacts.js";
export * from "./domains/jobs-actions.js";
