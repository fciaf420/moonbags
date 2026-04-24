/**
 * IPv4-only fetch wrapper.
 *
 * GMGN OpenAPI rejects IPv6 connections with 403. Using a custom undici
 * Agent with connect.family=4 forces IPv4 at the TCP level, working on
 * all platforms regardless of OS DNS resolver ordering.
 */

// undici is bundled with Node.js 18+ — import directly without a type declaration.
// @ts-expect-error — no bundled type declarations for undici in this Node version
import { Agent } from "undici";

// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
const agent = new Agent({ connect: { family: 4 } });

export function ipv4Fetch(
  url: string | URL,
  init?: RequestInit,
): ReturnType<typeof fetch> {
  return fetch(url as string, {
    ...(init ?? {}),
    // undici-specific option — not in standard RequestInit
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatcher: agent as unknown as any,
  } as RequestInit);
}
