// Private, read-only Ninja Analytics MCP bridge for schema_version 2 portfolio exports.
// No dependencies, external calls, or mutation tools. Keep behind an OpenAI Secure MCP Tunnel.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(process.env.NINJA_EXPORT_FILE || "./ninja-portfolio-export.json");
const port = Number(process.env.NINJA_MCP_PORT || 47831);
const datasets = ["integration_status","analytics_daily","search_daily","search_query_daily","search_page_daily","sync_runs","tracked_queries","uptime_checks"];
const tools = [
 {name:"list_sites",description:"List sites and snapshot timestamp. Does not access live data.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
 {name:"site_data",description:"Read stored rows for a named site and table, maximum 100 (snapshot only).",inputSchema:{type:"object",properties:{site_id:{type:"string"},dataset:{type:"string",enum:datasets},limit:{type:"integer",minimum:1,maximum:100}},required:["site_id","dataset"],additionalProperties:false}},
 {name:"site_queries",description:"Read top Google or Bing query rows for a site from the stored snapshot.",inputSchema:{type:"object",properties:{site_id:{type:"string"},engine:{type:"string",enum:["google","bing"]},limit:{type:"integer",minimum:1,maximum:100}},required:["site_id"],additionalProperties:false}},
 {name:"portfolio_summary",description:"Read computed intelligence and export timestamp (snapshot only).",inputSchema:{type:"object",properties:{},additionalProperties:false}}
];
const ok=(id,result)=>({jsonrpc:"2.0",id,result});
const error=(id,code,message)=>({jsonrpc:"2.0",id,error:{code,message}});
function send(res,status,body){const value=JSON.stringify(body);res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","content-length":Buffer.byteLength(value)});res.end(value)}
async function load(){const metadata=await stat(file);if(metadata.size>30*1024*1024)throw Error("Export exceeds 30 MiB");const d=JSON.parse(await readFile(file,"utf8"));if(d?.schema_version!==2||!d.tables||!Array.isArray(d.tables.sites))throw Error("Invalid schema_version 2 Ninja Analytics export");return d}
const cap=n=>Number.isInteger(n)?Math.max(1,Math.min(100,n)):25;
const dataResult=value=>({content:[{type:"text",text:JSON.stringify(value)}],isError:false});
async function invoke(name,args={}){
 const d=await load(),t=d.tables;
 if(name==="list_sites")return dataResult({source:"snapshot",generated_at:d.generated_at,sites:t.sites.map(s=>({id:s.id,name:s.name,domain:s.domain,is_active:s.is_active}))});
 if(name==="portfolio_summary")return dataResult({source:"snapshot",generated_at:d.generated_at,row_counts:d.row_counts,computed:d.computed});
 if(name!=="site_data"&&name!=="site_queries")throw Error("Unknown tool");
 if(typeof args.site_id!=="string"||!t.sites.some(s=>s.id===args.site_id))throw Error("Unknown site_id");
 const dataset=name==="site_queries"?"search_query_daily":args.dataset;
 if(!datasets.includes(dataset)||!Array.isArray(t[dataset]))throw Error("Invalid or unavailable dataset");
 let rows=t[dataset].filter(r=>r.site_id===args.site_id);
 if(name==="site_queries"){
  const engine=args.engine||"google";
  if(!["google","bing"].includes(engine))throw Error("Invalid engine");
  rows=rows.filter(r=>r.engine===engine).sort((a,b)=>(b.clicks??0)-(a.clicks??0));
 }else rows.sort((a,b)=>String(b.metric_date??b.started_at??"").localeCompare(String(a.metric_date??a.started_at??"")));
 return dataResult({source:"snapshot",generated_at:d.generated_at,dataset,site_id:args.site_id,total_rows:rows.length,rows:rows.slice(0,cap(args.limit))});
}
http.createServer(async(req,res)=>{
 if(req.url!=="/mcp"){send(res,404,{error:"Not found"});return}
 if(req.method!=="POST"){res.writeHead(405,{allow:"POST"});res.end();return}
 if(!(req.headers["content-type"]||"").startsWith("application/json")){send(res,415,{error:"JSON required"});return}
 let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>65536){send(res,413,{error:"Request too large"});return}}
 let m;try{m=JSON.parse(raw)}catch{send(res,400,error(null,-32700,"Invalid JSON"));return}
 if(m?.jsonrpc!=="2.0"||typeof m.method!=="string"){send(res,400,error(m?.id??null,-32600,"Invalid request"));return}
 if(m.method==="notifications/initialized"){res.writeHead(202);res.end();return}
 if(m.method==="initialize"){send(res,200,ok(m.id,{protocolVersion:"2025-03-26",capabilities:{tools:{listChanged:false}},serverInfo:{name:"ninja-analytics-readonly",version:"0.1.0"}}));return}
 if(m.method==="ping"){send(res,200,ok(m.id,{}));return}
 if(m.method==="tools/list"){send(res,200,ok(m.id,{tools}));return}
 if(m.method==="tools/call"){
  if(typeof m.params?.name!=="string"){send(res,200,error(m.id,-32602,"Tool name required"));return}
  try{send(res,200,ok(m.id,await invoke(m.params.name,m.params.arguments||{})))}catch(e){send(res,200,ok(m.id,{content:[{type:"text",text:String(e.message).slice(0,250)}],isError:true}))}
  return
 }
 send(res,200,error(m.id,-32601,"Method not found"));
}).listen(port,"127.0.0.1",()=>console.log(`Ninja Analytics MCP (snapshot only): http://127.0.0.1:${port}/mcp`));
