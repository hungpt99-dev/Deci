import { checkout } from "./cart.js";

// Minimal route table (framework-agnostic fixture).
export const routes: Array<{ method: string; path: string; handler: string }> = [
  { method: "POST", path: "/checkout", handler: "checkout" },
];

export function handleCheckout(body: unknown): unknown {
  const { cart, discountPct } = body as { cart: Parameters<typeof checkout>[0]; discountPct: number };
  return checkout(cart, discountPct);
}
