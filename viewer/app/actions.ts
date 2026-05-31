"use server";

import { revalidatePath } from "next/cache";

export async function refreshImages() {
  revalidatePath("/");
}

const SOLANA_RPC =
  process.env.HELIUS_RPC ??
  process.env.SOLANA_RPC ??
  process.env.NEXT_PUBLIC_SOLANA_RPC ??
  "https://api.mainnet-beta.solana.com";

// Server-side so we hit the RPC without browser CORS / 403 limits.
export async function getTokenBalance(
  wallet: string,
  mint: string,
): Promise<number | null> {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [wallet, { mint }, { encoding: "jsonParsed" }],
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const accounts = data?.result?.value ?? [];
    if (accounts.length === 0) return 0;
    return (
      accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? null
    );
  } catch {
    return null;
  }
}
