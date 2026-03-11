"use client";

import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        className={cn(
          "w-full appearance-none rounded-[18px] border border-line bg-white/85 px-4 py-3 pr-14 text-sm text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.78)] transition duration-150 hover:-translate-y-px focus:border-teal/35 focus:outline-none focus:ring-4 focus:ring-teal/10",
          className,
        )}
        {...props}
      >
        {children}
      </select>

      <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-muted">
        <svg aria-hidden="true" viewBox="0 0 12 8" className="h-3.5 w-3.5" fill="none">
          <path
            d="M1 1.5L6 6.5L11 1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  );
}
