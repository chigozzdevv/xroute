import { WalletMenu } from "@/components/wallet/wallet-menu";

export function Header() {
  return (
    <header className="relative z-10 px-4 pt-5 sm:px-6">
      <div className="mx-auto flex max-w-[1180px] flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-display text-[1.35rem] font-extrabold uppercase tracking-[0.22em]">
            XROUTE
          </span>
        </div>
        <WalletMenu />
      </div>
    </header>
  );
}
