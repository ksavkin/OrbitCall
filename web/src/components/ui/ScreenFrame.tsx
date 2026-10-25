"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Full-screen sheet under the navbar, same frame as Rooms. */
export function ScreenFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <motion.div
      role="region"
      aria-label={label}
      initial={{ opacity: 0, scale: 0.99, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.99, filter: "blur(6px)" }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="pointer-events-auto absolute inset-x-2.5 bottom-[42px] top-[58px] z-[38] flex flex-col overflow-hidden rounded-[18px] bg-[rgba(4,4,5,0.94)] text-neutral-200 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_40px_100px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl select-text"
    >
      {children}
    </motion.div>
  );
}

export function ScreenMessage({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div className="max-w-[440px]">
        <div className="text-[16px] font-semibold text-white">{title}</div>
        <p className="mt-2 text-[13px] leading-[1.6] text-neutral-500">{body}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
