/** Configurable concurrent API latency and failure-rate release benchmark. */
import { performance } from "node:perf_hooks";

const baseUrl = process.env.PMS_BASE_URL || "http://localhost:3000";
const requestPath = process.env.PMS_PATH || "/api/pms?view=core";
const total = Number(process.env.PMS_REQUESTS || 300);
const concurrency = Number(process.env.PMS_CONCURRENCY || 30);
const warmupRequests = Number(process.env.PMS_WARMUP || 30);
const timings = [];
let next = 0, failures = 0;
let sessionCookie = "";

if (process.env.PMS_TEST_EMAIL || process.env.PMS_TEST_PASSWORD) {
  if (!process.env.PMS_TEST_EMAIL || !process.env.PMS_TEST_PASSWORD) throw new Error("PMS_TEST_EMAIL and PMS_TEST_PASSWORD must be provided together");
  const login=await fetch(`${baseUrl}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:process.env.PMS_TEST_EMAIL,password:process.env.PMS_TEST_PASSWORD})});
  if (!login.ok) throw new Error(`Benchmark authentication failed (${login.status})`);
  sessionCookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
}

const requestHeaders={accept:"application/json",...(sessionCookie?{cookie:sessionCookie}:{})};

let warmupFailures = 0;
await Promise.all(Array.from({ length: warmupRequests }, async () => {
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, { headers: requestHeaders });
    if (!response.ok) warmupFailures++;
    await response.arrayBuffer();
  } catch { warmupFailures++; }
}));

async function worker() {
  while (true) {
    const current = next++;
    if (current >= total) return;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}${requestPath}`, { headers: requestHeaders });
      if (!response.ok) failures++;
      await response.arrayBuffer();
    } catch { failures++; }
    timings.push(performance.now() - started);
  }
}

const wallStarted = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const wallMs = performance.now() - wallStarted;
timings.sort((a,b)=>a-b);
const percentile = p => Number(timings[Math.min(timings.length-1, Math.floor(timings.length*p))].toFixed(2));
const result = { baseUrl, requestPath, warmupRequests, warmupFailures, requests:total, concurrency, failures, throughputRps:Number((total/(wallMs/1000)).toFixed(2)), wallMs:Number(wallMs.toFixed(2)), latencyMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:Number(timings.at(-1).toFixed(2))}, target:{p95Ms:250,pass:warmupFailures===0&&failures===0&&percentile(.95)<250}, measuredAt:new Date().toISOString() };
console.log(JSON.stringify(result,null,2));
if (!result.target.pass) process.exitCode=1;
