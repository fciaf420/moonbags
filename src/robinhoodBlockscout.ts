export type BlockscoutHolder = {
  address?: { hash?: string; name?: string | null; is_contract?: boolean; is_verified?: boolean; public_tags?: Array<{display_name?: string; label?: string}> };
  value?: string;
};
export type HolderConcentration = { rawTop10Pct:number; adjustedTop10Pct:number; holderCount:number; excludedAddresses:string[] };
const SYSTEM=/pool|router|bridge|vault|burn|dead|uniswap|system/i;
const ZERO=/^0x0{40}$/i;
const DEAD=/^0x0{36}dead$/i;
function excluded(h:BlockscoutHolder):boolean {
 const a=h.address; const hash=a?.hash??""; const label=[a?.name,...(a?.public_tags??[]).flatMap(t=>[t.display_name,t.label])].filter(Boolean).join(" ");
 return ZERO.test(hash)||DEAD.test(hash)||SYSTEM.test(label)||(Boolean(a?.is_contract&&a?.is_verified)&&SYSTEM.test(label));
}
export function calculateHolderConcentration(holders:BlockscoutHolder[],totalSupply:number):HolderConcentration {
 const sorted=[...holders].sort((a,b)=>Number(b.value??0)-Number(a.value??0));
 const pct=(rows:BlockscoutHolder[])=>totalSupply>0?rows.slice(0,10).reduce((n,h)=>n+Number(h.value??0),0)/totalSupply*100:0;
 const excludedAddresses=sorted.filter(excluded).map(h=>(h.address?.hash??"").toLowerCase());
 return {rawTop10Pct:pct(sorted),adjustedTop10Pct:pct(sorted.filter(h=>!excluded(h))),holderCount:holders.length,excludedAddresses};
}
export async function fetchHolderConcentration(tokenAddress:string,opts:{fetcher?:typeof fetch;baseUrl?:string;maxPages?:number;timeoutMs?:number;totalSupply:number}):Promise<HolderConcentration>{
 const fetcher=opts.fetcher??fetch, base=(opts.baseUrl??"https://explorer.robinhoodchain.com").replace(/\/$/,""); const max=opts.maxPages??5; const rows:BlockscoutHolder[]=[]; let params="";
 for(let page=0;page<max;page++){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),opts.timeoutMs??10000);
  try { const res=await fetcher(`${base}/api/v2/tokens/${tokenAddress}/holders${params}`,{signal:controller.signal}); if(!res.ok) throw new Error(`Blockscout holders HTTP ${res.status}`); const body=await res.json() as {items?:BlockscoutHolder[];next_page_params?:Record<string,unknown>|null}; rows.push(...(body.items??[])); if(!body.next_page_params) break; params=`?${new URLSearchParams(Object.entries(body.next_page_params).map(([k,v]): [string, string]=>[k,String(v)])).toString()}`; }
  finally { clearTimeout(timer); }
 }
 return calculateHolderConcentration(rows,opts.totalSupply);
}
