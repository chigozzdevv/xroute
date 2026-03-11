import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn(
        "relative w-full overflow-hidden rounded-[32px] border border-line bg-[linear-gradient(180deg,rgba(255,252,247,0.92)_0%,rgba(255,252,247,0.76)_100%)] shadow-panel backdrop-blur-[18px] before:absolute before:left-0 before:top-0 before:h-px before:w-[42%] before:bg-[linear-gradient(90deg,rgba(13,122,115,0.72),rgba(212,107,58,0))] before:content-['']",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative z-10 px-5 pb-5 pt-7 sm:px-7", className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn(
        "font-display text-[clamp(1.8rem,4vw,2.7rem)] leading-none font-semibold tracking-[-0.05em]",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("max-w-[60ch] text-base leading-7 text-muted", className)}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative z-10 px-5 pb-7 sm:px-7", className)} {...props} />;
}

export function CardFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative z-10 px-5 pb-7 sm:px-7", className)} {...props} />;
}
