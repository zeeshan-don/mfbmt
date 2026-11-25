/**
 * Public entry point for Deep Supplier Research.
 *
 * Existing quick search remains in `engine.ts`; this module adds the bounded,
 * iterative research workflow without replacing the adapters or matching rules.
 */
export * from "./research/engine";
export * from "./research/planner";
export * from "./research/qualification";
export * from "./research/search";
export * from "./research/investigation";
export * from "./research/evidence";
export * from "./research/limits";
