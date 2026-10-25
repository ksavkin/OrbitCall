import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { convexClient } from "./provider";

// Mutations and actions from event handlers, outside React. They reject with a ConvexError whose data is
// { code, message }; read it with backendError (./errors). Queries stay in the sync components (components/live/sync).

function client() {
  if (!convexClient) throw new ConvexError({ code: "NOT_CONNECTED", message: "The backend is not connected." });
  return convexClient;
}

export function mutate<M extends FunctionReference<"mutation", "public">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>> {
  return client().mutation(ref, args);
}

export function act<A extends FunctionReference<"action", "public">>(ref: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>> {
  return client().action(ref, args);
}
