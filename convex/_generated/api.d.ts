/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentRuns from "../agentRuns.js";
import type * as agentSummaries from "../agentSummaries.js";
import type * as agents from "../agents.js";
import type * as agents_analyst from "../agents/analyst.js";
import type * as dev from "../dev.js";
import type * as events from "../events.js";
import type * as lib_analyst from "../lib/analyst.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_runs from "../lib/runs.js";
import type * as lib_validators from "../lib/validators.js";
import type * as schema_agents from "../schema/agents.js";
import type * as schema_data from "../schema/data.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentRuns: typeof agentRuns;
  agentSummaries: typeof agentSummaries;
  agents: typeof agents;
  "agents/analyst": typeof agents_analyst;
  dev: typeof dev;
  events: typeof events;
  "lib/analyst": typeof lib_analyst;
  "lib/claude": typeof lib_claude;
  "lib/events": typeof lib_events;
  "lib/runs": typeof lib_runs;
  "lib/validators": typeof lib_validators;
  "schema/agents": typeof schema_agents;
  "schema/data": typeof schema_data;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
