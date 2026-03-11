"use client";

import { useEffect, useState } from "react";

export type JourneyPhase = "idle" | "running" | "success";

type UseJourneyProgressOptions = {
  stepCount: number;
  stepDurationMs?: number;
};

export function useJourneyProgress({
  stepCount,
  stepDurationMs = 1050,
}: UseJourneyProgressOptions) {
  const [phase, setPhase] = useState<JourneyPhase>("idle");
  const [activeStep, setActiveStep] = useState(-1);

  useEffect(() => {
    if (phase !== "running" || stepCount === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setActiveStep((current) => {
        if (current >= stepCount - 1) {
          setPhase("success");
          return stepCount - 1;
        }

        return current + 1;
      });
    }, stepDurationMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeStep, phase, stepCount, stepDurationMs]);

  const startJourney = () => {
    if (phase === "running") {
      return;
    }

    setActiveStep(0);
    setPhase("running");
  };

  const resetJourney = () => {
    setActiveStep(-1);
    setPhase("idle");
  };

  return {
    activeStep,
    phase,
    resetJourney,
    startJourney,
  };
}
