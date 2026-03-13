"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/cn";

export type TabsItem<T extends string> = {
  value: T;
  label: string;
};

type TabsProps<T extends string> = {
  items: readonly TabsItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
};

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
}: TabsProps<T>) {
  return (
    <div
      className="grid grid-cols-1 gap-2 rounded-[24px] border border-line bg-white/55 p-1.5 sm:[grid-template-columns:repeat(var(--tab-count),minmax(0,1fr))]"
      role="tablist"
      aria-label="XROUTE actions"
      style={{ "--tab-count": items.length } as CSSProperties}
    >
      {items.map((item) => {
        const isActive = item.value === value;

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-[18px] border-0 px-4 py-4 text-left text-muted transition duration-150 hover:bg-teal/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
              isActive &&
                "bg-[linear-gradient(135deg,rgba(13,122,115,0.14),rgba(212,107,58,0.14))] text-ink shadow-[inset_0_0_0_1px_rgba(13,122,115,0.12)]",
            )}
            onClick={() => onValueChange(item.value)}
          >
            <span className="font-extrabold tracking-[-0.02em]">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
