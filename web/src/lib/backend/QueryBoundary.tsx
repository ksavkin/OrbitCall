"use client";

import { Component, type ReactNode } from "react";

/**
 * Convex's useQuery throws when the query fails (function not deployed yet, NOT_FOUND, ...).
 * This keeps such a failure inside its own panel instead of taking the whole app down.
 * Remount it (change its `key`) to retry.
 */
export class QueryBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error) => ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  render() {
    if (this.state.error) return this.props.fallback ? this.props.fallback(this.state.error) : null;
    return this.props.children;
  }
}

/** First line of an error, without Convex's request-id prefix, for a one-line display. */
export function briefError(e: Error): string {
  const line = e.message.split("\n").find((l) => l.trim().length > 0) ?? "Unknown error";
  return line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 140);
}
