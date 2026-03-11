"use client";

import { useState } from "react";

import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";

import { actionTabs, type ActionKey } from "./action-config";
import { ExecuteForm } from "./execute-form";
import { SwapForm } from "./swap-form";
import { TransferForm } from "./transfer-form";

export function LandingConsole() {
  const [activeAction, setActiveAction] = useState<ActionKey>("transfer");

  return (
    <div className="relative z-10 grid min-h-screen grid-rows-[auto_1fr]">
      <Header />
      <main className="flex items-start justify-center px-4 pb-8 pt-6 sm:px-6 sm:pb-12 md:items-center">
        <section className="relative w-full max-w-[580px]">
          <div className="absolute -top-8 right-7 h-40 w-40 rounded-full bg-teal/12 blur-3xl" />
          <div className="absolute bottom-[-48px] left-5 h-[180px] w-[180px] rounded-full bg-orange/10 blur-3xl" />

          <div className="relative z-10 grid gap-4">
            <Tabs
              items={actionTabs}
              value={activeAction}
              onValueChange={setActiveAction}
            />

            <Card>
              <CardContent className="pt-7">
                {activeAction === "transfer" ? <TransferForm /> : null}
                {activeAction === "swap" ? <SwapForm /> : null}
                {activeAction === "execute" ? <ExecuteForm /> : null}
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}
