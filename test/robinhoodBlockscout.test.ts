import test from "node:test";
import assert from "node:assert/strict";
import { calculateHolderConcentration, fetchHolderConcentration } from "../src/robinhoodBlockscout.js";

const holders=[
 {address:{hash:"0x1111111111111111111111111111111111111111",is_contract:false},value:"300"},
 {address:{hash:"0x2222222222222222222222222222222222222222",is_contract:true,name:"Uniswap Pool",is_verified:true},value:"250"},
 {address:{hash:"0x0000000000000000000000000000000000000000",is_contract:false},value:"200"},
 {address:{hash:"0x3333333333333333333333333333333333333333",is_contract:false},value:"150"},
];
test("adjusted concentration excludes pools contracts and burn/system addresses",()=>{
 const result=calculateHolderConcentration(holders,1000);
 assert.equal(result.rawTop10Pct,90);
 assert.equal(result.adjustedTop10Pct,45);
 assert.deepEqual(result.excludedAddresses.sort(),["0x0000000000000000000000000000000000000000","0x2222222222222222222222222222222222222222"]);
});
test("holder fetch follows pagination with a bounded page count",async()=>{
 let calls=0;
 const fetcher:typeof fetch=async()=>new Response(JSON.stringify(calls++===0?{items:holders.slice(0,2),next_page_params:{index:2}}:{items:holders.slice(2),next_page_params:null}),{status:200});
 const result=await fetchHolderConcentration("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",{fetcher,baseUrl:"https://example.test",maxPages:2,totalSupply:1000});
 assert.equal(calls,2); assert.equal(result.rawTop10Pct,90);
});

test("holder fetch obtains total supply from Blockscout token metadata",async()=>{
 const urls:string[]=[];
 const fetcher:typeof fetch=async(input)=>{
  const url=String(input); urls.push(url);
  if(url.endsWith("/api/v2/tokens/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) return new Response(JSON.stringify({total_supply:"1000"}),{status:200});
  return new Response(JSON.stringify({items:holders,next_page_params:null}),{status:200});
 };
 const result=await fetchHolderConcentration("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",{fetcher,baseUrl:"https://example.test",maxPages:1});
 assert.equal(result.rawTop10Pct,90);
 assert.equal(result.holderCount,4);
 assert.equal(urls.length,2);
});
