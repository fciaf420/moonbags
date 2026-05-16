import type { State } from "../types";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { fmtHold } from "../lib/format";

type Props = { config: State["config"] | undefined };

export function ConfigCard({ config }: Props) {
  if (!config) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Global Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="font-mono text-xs text-muted-foreground uppercase">Loading...</span>
        </CardContent>
      </Card>
    );
  }

  const rows: Array<[string, string]> = [
    ["BUY_SIZE_SOL", config.BUY_SIZE_SOL.toString()],
    ["MAX_CONCURRENT_POSITIONS", config.MAX_CONCURRENT_POSITIONS.toString()],
    ["ARM_PCT", `${(config.ARM_PCT * 100).toFixed(2)}%`],
    ["TRAIL_PCT", `${(config.TRAIL_PCT * 100).toFixed(2)}%`],
    ["STOP_PCT", `${(config.STOP_PCT * 100).toFixed(2)}%`],
    ["MAX_HOLD_SECS", fmtHold(config.MAX_HOLD_SECS)],
    ["SLIPPAGE_BPS", config.SLIPPAGE_BPS.toString()],
    // ["SCG_POLL_MS", config.SCG_POLL_MS.toString()], // [SCG Alpha temporarily disabled]
    ["PRICE_POLL_MS", config.PRICE_POLL_MS.toString()],
    ["DRY_RUN", String(config.DRY_RUN)],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Global Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {rows.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1">
              <span className="text-muted-foreground uppercase text-[10px] font-mono tracking-widest">{k}</span>
              <span className="font-mono text-sm text-foreground tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
