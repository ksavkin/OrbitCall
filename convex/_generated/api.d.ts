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
import type * as call_core from "../call/core.js";
import type * as call_demo from "../call/demo.js";
import type * as call_ingest from "../call/ingest.js";
import type * as call_join from "../call/join.js";
import type * as call_livekitToken from "../call/livekitToken.js";
import type * as call_messages from "../call/messages.js";
import type * as call_presence from "../call/presence.js";
import type * as candidates from "../candidates.js";
import type * as catalog from "../catalog.js";
import type * as coordinationHost from "../coordinationHost.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as lib_accounts from "../lib/accounts.js";
import type * as lib_advocate from "../lib/advocate.js";
import type * as lib_advocateMemory from "../lib/advocateMemory.js";
import type * as lib_analyst from "../lib/analyst.js";
import type * as lib_backboard from "../lib/backboard.js";
import type * as lib_candidateCards from "../lib/candidateCards.js";
import type * as lib_checker from "../lib/checker.js";
import type * as lib_claude from "../lib/claude.js";
import type * as lib_coordination from "../lib/coordination.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_host from "../lib/host.js";
import type * as lib_operatorAccess from "../lib/operatorAccess.js";
import type * as lib_orbitClient from "../lib/orbitClient.js";
import type * as lib_policies from "../lib/policies.js";
import type * as lib_policyValidators from "../lib/policyValidators.js";
import type * as lib_queue from "../lib/queue.js";
import type * as lib_runs from "../lib/runs.js";
import type * as lib_validators from "../lib/validators.js";
import type * as operators from "../operators.js";
import type * as policies from "../policies.js";
import type * as rationaleCheck from "../rationaleCheck.js";
import type * as riskMonitor from "../riskMonitor.js";
import type * as schema_agents from "../schema/agents.js";
import type * as schema_call from "../schema/call.js";
import type * as schema_data from "../schema/data.js";
import type * as schema_demo from "../schema/demo.js";
import type * as schema_records from "../schema/records.js";
import type * as schema_rooms from "../schema/rooms.js";
import type * as schema_scans from "../schema/scans.js";
import type * as schema_schedule from "../schema/schedule.js";
import type * as session from "../session.js";

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
  "call/core": typeof call_core;
  "call/demo": typeof call_demo;
  "call/ingest": typeof call_ingest;
  "call/join": typeof call_join;
  "call/livekitToken": typeof call_livekitToken;
  "call/messages": typeof call_messages;
  "call/presence": typeof call_presence;
  candidates: typeof candidates;
  catalog: typeof catalog;
  coordinationHost: typeof coordinationHost;
  crons: typeof crons;
  dev: typeof dev;
  events: typeof events;
  http: typeof http;
  ingest: typeof ingest;
  "lib/accounts": typeof lib_accounts;
  "lib/advocate": typeof lib_advocate;
  "lib/advocateMemory": typeof lib_advocateMemory;
  "lib/analyst": typeof lib_analyst;
  "lib/backboard": typeof lib_backboard;
  "lib/candidateCards": typeof lib_candidateCards;
  "lib/checker": typeof lib_checker;
  "lib/claude": typeof lib_claude;
  "lib/coordination": typeof lib_coordination;
  "lib/events": typeof lib_events;
  "lib/host": typeof lib_host;
  "lib/operatorAccess": typeof lib_operatorAccess;
  "lib/orbitClient": typeof lib_orbitClient;
  "lib/policies": typeof lib_policies;
  "lib/policyValidators": typeof lib_policyValidators;
  "lib/queue": typeof lib_queue;
  "lib/runs": typeof lib_runs;
  "lib/validators": typeof lib_validators;
  operators: typeof operators;
  policies: typeof policies;
  rationaleCheck: typeof rationaleCheck;
  riskMonitor: typeof riskMonitor;
  "schema/agents": typeof schema_agents;
  "schema/call": typeof schema_call;
  "schema/data": typeof schema_data;
  "schema/demo": typeof schema_demo;
  "schema/records": typeof schema_records;
  "schema/rooms": typeof schema_rooms;
  "schema/scans": typeof schema_scans;
  "schema/schedule": typeof schema_schedule;
  session: typeof session;
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
