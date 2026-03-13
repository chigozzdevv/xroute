import type { TabsItem } from "@/components/ui/tabs";

export type ActionKey = "transfer" | "swap" | "execute" | "workflow";

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
  {
    value: "workflow",
    label: "Workflow",
  },
];
