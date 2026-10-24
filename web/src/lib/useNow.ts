"use client";

import { useEffect, useState } from "react";

/** Wall clock that re-renders every `ms`; 0 on the server and first paint (no hydration mismatch). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [ms]);
  return now;
}
