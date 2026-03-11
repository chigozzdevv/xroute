import type { TabsItem } from "@/components/ui/tabs";

export type ActionKey = "transfer" | "swap" | "execute";

export const actionTabs: readonly TabsItem<ActionKey>[] = [
  {
    value: "transfer",
    label: "Transfer",
  },
  {
    value: "swap",
    label: "Swap",
  },
  {
    value: "execute",
    label: "Execute",
  },
];
