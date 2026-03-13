import { NextResponse } from "next/server";

import { quoteRequest, type QuoteRequest } from "@/lib/xroute/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as QuoteRequest;
    const result = await quoteRequest(payload);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "quote request failed",
      },
      { status: 422 },
    );
  }
}
