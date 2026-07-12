# Robinhood Uniswap Quote Spike

**Date:** 2026-07-12
**Status:** On-chain quoting works. Uniswap Trading API does NOT support Robinhood chain yet.

## Uniswap Trading API (trade-api.gateway.uniswap.org/v1)
- `/quote`: Returns 404 "No quotes available" for all Robinhood chain pairs
- API key valid (200 on Ethereum mainnet)
- Chain 4663 listed in docs but not routable yet

## On-Chain Quotes (proven working)
- **V2 Router:** `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` — `getAmountsOut` tested (0.01 ETH → 18.01 USDG)
- **V3 Pools:** Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` — WETH/USDG pool found at 1bp
- **Universal Router v2.0:** `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` — 39KB deployed code

## Recommendation
Use on-chain quoting: V2 `getAmountsOut` + V3 pool slot0 price computation. Execute via Universal Router v2.0.
