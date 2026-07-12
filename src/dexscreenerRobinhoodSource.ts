import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRobinhoodHotOutput, type DexscreenerRobinhoodCandidate } from "./dexscreenerTypes.js";
import type { HolderConcentration } from "./robinhoodBlockscout.js";
import type { SignalAlert } from "./types.js";
import { appendRobinhoodPaperEvent } from "./robinhoodPaperJournal.js";
import { fetchHolderConcentration } from "./robinhoodBlockscout.js";


export type RobinhoodSourceSettings={enabled:boolean;executablePath:string;pollMs:number;seedLimit:number;cooldownMins:number;watchlistTtlMins:number;maxWatchTokens:number;minScans:number;minLiquidityUsd:number;minHolders:number;maxMarketCapUsd:number;minBuySellRatio:number;minH1Transactions:number;minH1PriceAcceleration:number;minH1VolumeAcceleration:number;maxAdjustedTop10Pct:number};
type Entry={first:DexscreenerRobinhoodCandidate;last:DexscreenerRobinhoodCandidate;scans:number;firstSeenAt:number;lastSeenAt:number;acceptedAt?:number};
export type RobinhoodSourceStatus={enabled:boolean;running:boolean;seeded:boolean;lastScan?:number;candidatesSeen:number;candidatesFiltered:number;candidatesAccepted:number;lastRejectionReason?:string;watchlistSize:number};
export type RobinhoodPaperSourceEvent={type:"snapshot"|"rejected"|"accepted";at:number;tokenAddress:string;reason?:string;priceUsd:number;liquidityUsd:number;holders:number;marketCapUsd:number;buySellRatio:number;transactionAcceleration:number;score:number};
type Deps={runner:(executable:string,args:string[])=>Promise<string>;clock:()=>number;settings:RobinhoodSourceSettings;concentration:(address:string)=>Promise<HolderConcentration>;onAcceptedCandidate?:(alert:SignalAlert)=>void|Promise<void>;onPaperEvent?:(event:RobinhoodPaperSourceEvent)=>void|Promise<void>};
const execFileAsync=promisify(execFile);
export const defaultRobinhoodRunner=async(executable:string,args:string[])=>String((await execFileAsync(executable,args,{timeout:30000,maxBuffer:8*1024*1024})).stdout);
function alert(row:DexscreenerRobinhoodCandidate,c:HolderConcentration,e:Entry):SignalAlert{return {chain:"robinhood",tokenAddress:row.tokenAddress,mint:row.tokenAddress,name:row.tokenSymbol?`${row.tokenName} (${row.tokenSymbol})`:row.tokenName,source:"dexscreener",sourceMeta:{pairAddress:row.pairAddress,pairUrl:row.pairUrl,priceUsd:row.priceUsd,txnsH1:row.txnsH1,volumeH24:row.volumeH24,scans:e.scans,rawTop10Pct:c.rawTop10Pct,adjustedTop10Pct:c.adjustedTop10Pct},score:row.score,alert_time:e.firstSeenAt,alert_mcap:row.marketCap,current_mcap:row.marketCap,return_pct:0,max_return_pct:0,max_mcap:row.marketCap,age_mins:Math.max(0,(Date.now()-e.firstSeenAt)/60000),holders:c.holderCount||row.holdersCount,bs_ratio:Math.max(0,row.analytics.txnVelocity),bot_degen_pct:0,holder_growth_pct:0,liquidity:row.liquidityUsd,bundler_pct:0,top10_pct:c.adjustedTop10Pct,kol_count:0,signal_count:row.txnsH1,degen_call_count:0,rug_ratio:0,twitter_followers:0,liq_trend:row.liquidityUsd>=e.first.liquidityUsd?"rising":"falling",completed:false};}
export function createRobinhoodWatchSource(deps:Deps){
 const entries=new Map<string,Entry>(); let seeded=false,running=false,lastScan:number|undefined,seen=0,filtered=0,accepted=0,lastRejectionReason:string|undefined;
 const paperEvent=(type:RobinhoodPaperSourceEvent["type"],row:DexscreenerRobinhoodCandidate,at:number,reason?:string):RobinhoodPaperSourceEvent=>({type,at,tokenAddress:row.tokenAddress,reason,priceUsd:row.priceUsd,liquidityUsd:row.liquidityUsd,holders:row.holdersCount,marketCapUsd:row.marketCap,buySellRatio:row.analytics.txnVelocity,transactionAcceleration:row.analytics.volumeVelocity,score:row.score});
 const reject=async(reason:string,row:DexscreenerRobinhoodCandidate,at:number)=>{filtered++;lastRejectionReason=reason;await deps.onPaperEvent?.(paperEvent("rejected",row,at,reason));};
 const refresh=async()=>{if(!deps.settings.enabled)return;running=true;const now=deps.clock();const rows=parseRobinhoodHotOutput(await deps.runner(deps.settings.executablePath,["hot","--chains","robinhood","--limit",String(deps.settings.seedLimit),"--json"]));lastScan=now;
  for(const row of rows){seen++;await deps.onPaperEvent?.(paperEvent("snapshot",row,now));const old=entries.get(row.tokenAddress);const e:Entry=old?{...old,last:row,lastSeenAt:now,scans:old.scans+1}:{first:row,last:row,firstSeenAt:now,lastSeenAt:now,scans:1};entries.set(row.tokenAddress,e);if(!seeded)continue;
   if(e.acceptedAt!==undefined&&now-e.acceptedAt<deps.settings.cooldownMins*60000){await reject("cooldown",row,now);continue;} if(e.scans<deps.settings.minScans){await reject("repeated scans",row,now);continue;} if(row.liquidityUsd<deps.settings.minLiquidityUsd){await reject("liquidity",row,now);continue;} if(deps.settings.maxMarketCapUsd>0&&row.marketCap>deps.settings.maxMarketCapUsd){await reject("market cap",row,now);continue;} if(row.txnsH1<deps.settings.minH1Transactions){await reject("H1 transactions",row,now);continue;} if(row.priceChangeH1<deps.settings.minH1PriceAcceleration){await reject("price acceleration",row,now);continue;} if(row.analytics.volumeVelocity<deps.settings.minH1VolumeAcceleration){await reject("volume acceleration",row,now);continue;} if(row.analytics.txnVelocity<deps.settings.minBuySellRatio){await reject("buy/sell momentum",row,now);continue;}
   const c=await deps.concentration(row.tokenAddress);if(c.holderCount<deps.settings.minHolders){await reject("verified holders",row,now);continue;}if(c.adjustedTop10Pct>deps.settings.maxAdjustedTop10Pct){await reject("holder concentration",row,now);continue;}e.acceptedAt=now;accepted++;await deps.onPaperEvent?.(paperEvent("accepted",row,now));await deps.onAcceptedCandidate?.(alert(row,c,e));
  }
  seeded=true;for(const [key,e] of entries)if(now-e.lastSeenAt>deps.settings.watchlistTtlMins*60000)entries.delete(key);while(entries.size>deps.settings.maxWatchTokens){const oldest=[...entries.entries()].sort((a,b)=>a[1].lastSeenAt-b[1].lastSeenAt)[0];if(oldest)entries.delete(oldest[0]);else break;}
 };
 return {refresh,start(){running=true;},stop(){running=false;},status:():RobinhoodSourceStatus=>({enabled:deps.settings.enabled,running,seeded,lastScan,candidatesSeen:seen,candidatesFiltered:filtered,candidatesAccepted:accepted,lastRejectionReason,watchlistSize:entries.size})};
}
export async function dispatchRobinhoodWatchCandidate(alert:SignalAlert,deps:{mode?:"watch"|"live";notify:(alert:SignalAlert)=>Promise<unknown>|unknown;openPosition?:(alert:SignalAlert)=>Promise<unknown>|unknown}){await deps.notify(alert);if(deps.mode==="live")await deps.openPosition?.(alert);}

let singleton: ReturnType<typeof createRobinhoodWatchSource>|undefined;
let timer: NodeJS.Timeout|undefined;
export function startDexscreenerRobinhoodSource(options:{onAcceptedCandidate?:(alert:SignalAlert)=>void|Promise<void>}={}):void {
 void import("./settingsStore.js").then(({getRuntimeSettings})=>{const cfg=getRuntimeSettings().signals.dexscreener;
 singleton=createRobinhoodWatchSource({runner:defaultRobinhoodRunner,clock:Date.now,settings:{...cfg,cooldownMins:cfg.mintCooldownMins},concentration:(address)=>fetchHolderConcentration(address,{}),onAcceptedCandidate:options.onAcceptedCandidate,onPaperEvent:appendRobinhoodPaperEvent});
 singleton.start(); const poll=async()=>{await singleton?.refresh().catch(()=>undefined);timer=setTimeout(poll,cfg.pollMs);timer.unref?.();};void poll();});
}
export function stopDexscreenerRobinhoodSource():void {if(timer)clearTimeout(timer);timer=undefined;singleton?.stop();}
export function getDexscreenerRobinhoodStatus():RobinhoodSourceStatus {return singleton?.status()??{enabled:false,running:false,seeded:false,candidatesSeen:0,candidatesFiltered:0,candidatesAccepted:0,watchlistSize:0};}
