import { NextResponse } from "next/server";

const ASSET_TO_COINGECKO_ID = Object.freeze({
  DOT: "polkadot",
  GLMR: "moonbeam",
  HDX: "hydration",
  BNC: "bifrost-native-coin",
  USDT: "tether",
});

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedAssets = [
    ...new Set(
      (searchParams.get("assets") ?? "")
        .split(",")
        .map((asset) => asset.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const supportedAssets = requestedAssets.filter((asset) => asset in ASSET_TO_COINGECKO_ID);

  if (supportedAssets.length === 0) {
    return NextResponse.json({ prices: {} }, {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  }

  const ids = supportedAssets
    .map((asset) => ASSET_TO_COINGECKO_ID[asset as keyof typeof ASSET_TO_COINGECKO_ID])
    .join(",");

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_last_updated_at=true`,
      {
        headers: {
          accept: "application/json",
        },
        next: {
          revalidate: 60,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`coin price request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const prices = Object.fromEntries(
      supportedAssets.flatMap((asset) => {
        const id = ASSET_TO_COINGECKO_ID[asset as keyof typeof ASSET_TO_COINGECKO_ID];
        const usd = payload?.[id]?.usd;
        if (typeof usd !== "number" || !Number.isFinite(usd)) {
          return [];
        }

        return [[asset, {
          usd,
          lastUpdatedAt:
            typeof payload?.[id]?.last_updated_at === "number"
              ? payload[id].last_updated_at
              : null,
        }]];
      }),
    );

    return NextResponse.json(
      { prices },
      {
        headers: {
          "cache-control": "public, max-age=60, stale-while-revalidate=300",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { prices: {} },
      {
        headers: {
          "cache-control": "public, max-age=30, stale-while-revalidate=120",
        },
      },
    );
  }
}
