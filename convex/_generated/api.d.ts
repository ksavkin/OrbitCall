/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as advocates from "../advocates.js";
import type * as agentRuns from "../agentRuns.js";
import type * as agentSummaries from "../agentSummaries.js";
import type * as agents from "../agents.js";
import type * as agents_advocate from "../agents/advocate.js";
import type * as agents_analyst from "../agents/analyst.js";
import type * as candidates from "../candidates.js";
import type * as catalog from "../catalog.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as events from "../events.js";
import type * as ingest from "../ingest.js";
import type * as lib_advocate from "../lib/advocate.js";
import type * as lib_analyst from "../lib/analyst.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_coordination from "../lib/coordination.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_operatorAccess from "../lib/operatorAccess.js";
import type * as lib_orbit from "../lib/orbit.js";
import type * as lib_orbitCandidates from "../lib/orbitCandidates.js";
import type * as lib_policies from "../lib/policies.js";
import type * as lib_policyValidators from "../lib/policyValidators.js";
import type * as lib_queue from "../lib/queue.js";
import type * as lib_runs from "../lib/runs.js";
import type * as lib_validators from "../lib/validators.js";
import type * as operators from "../operators.js";
import type * as orbit from "../orbit.js";
import type * as policies from "../policies.js";
import type * as riskMonitor from "../riskMonitor.js";
import type * as schema_agents from "../schema/agents.js";
import type * as schema_data from "../schema/data.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  advocates: typeof advocates;
  agentRuns: typeof agentRuns;
  agentSummaries: typeof agentSummaries;
  agents: typeof agents;
  "agents/advocate": typeof agents_advocate;
  "agents/analyst": typeof agents_analyst;
  candidates: typeof candidates;
  catalog: typeof catalog;
  crons: typeof crons;
  dev: typeof dev;
  events: typeof events;
  ingest: typeof ingest;
  "lib/advocate": typeof lib_advocate;
  "lib/analyst": typeof lib_analyst;
  "lib/claude": typeof lib_claude;
  "lib/coordination": typeof lib_coordination;
  "lib/events": typeof lib_events;
  "lib/operatorAccess": typeof lib_operatorAccess;
  "lib/orbit": typeof lib_orbit;
  "lib/orbitCandidates": typeof lib_orbitCandidates;
  "lib/policies": typeof lib_policies;
  "lib/policyValidators": typeof lib_policyValidators;
  "lib/queue": typeof lib_queue;
  "lib/runs": typeof lib_runs;
  "lib/validators": typeof lib_validators;
  operators: typeof operators;
  orbit: typeof orbit;
  policies: typeof policies;
  riskMonitor: typeof riskMonitor;
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
