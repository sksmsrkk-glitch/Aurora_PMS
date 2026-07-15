import { performance } from "node:perf_hooks";

const baseUrl = process.env.PMS_BASE_URL || "http://localhost:3000";
const total = Number(process.env.PMS_REQUESTS || 300);
const concurrency = Number(process.env.PMS_CONCURRENCY || 30);
const timings = [];
let next = 0, failures = 0;

async function worker() {
  while (true) {
    const current = next++;
    if (current >= total) return;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/pms`, { headers: { accept: "application/json" } });
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
const result = { baseUrl, requests:total, concurrency, failures, throughputRps:Number((total/(wallMs/1000)).toFixed(2)), wallMs:Number(wallMs.toFixed(2)), latencyMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:Number(timings.at(-1).toFixed(2))}, target:{p95Ms:250,pass:failures===0&&percentile(.95)<250}, measuredAt:new Date().toISOString() };
console.log(JSON.stringify(result,null,2));
if (!result.target.pass) process.exitCode=1;
