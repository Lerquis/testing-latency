const https = require("https");
const { URL } = require("url");
const dns = require("dns");
const os = require("os");
const WebSocket = require("ws");
const Table = require("cli-table3");

// ── Config ──────────────────────────────────────────────────────────
const API_ENDPOINTS = [
  { name: "Gamma API", url: "https://gamma-api.polymarket.com" },
  { name: "Data API", url: "https://data-api.polymarket.com" },
  { name: "CLOB API", url: "https://clob.polymarket.com" },
];

const WS_ENDPOINTS = [
  { name: "Live Data WS", url: "wss://ws-live-data.polymarket.com/" },
  { name: "CLOB Subscriptions WS", url: "wss://ws-subscriptions-clob.polymarket.com/ws/market" },
];

const WARMUP_ROUNDS = 3;       // requests descartados (cold start)
const ROUNDS = 30;             // requests medidos
const DELAY_BETWEEN_MS = 100;  // pausa entre requests para evitar throttling
const WS_TIMEOUT = 10000;
const HTTP_TIMEOUT = 10000;

// ── Helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(t, 32);
const yellow = (t) => color(t, 33);
const red = (t) => color(t, 31);
const cyan = (t) => color(t, 36);
const bold = (t) => color(t, 1);
const dim = (t) => color(t, 2);

function colorLatency(ms) {
  const val = `${ms.toFixed(2)} ms`;
  if (ms < 100) return green(val);
  if (ms < 300) return yellow(val);
  return red(val);
}

function computeStats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((s, t) => s + t, 0);
  const avg = sum / times.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const p99 = sorted[Math.ceil(sorted.length * 0.99) - 1];

  // Standard deviation
  const variance = times.reduce((s, t) => s + (t - avg) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);

  // Jitter (avg difference between consecutive measurements)
  let jitter = 0;
  if (times.length > 1) {
    for (let i = 1; i < times.length; i++) {
      jitter += Math.abs(times[i] - times[i - 1]);
    }
    jitter /= times.length - 1;
  }

  return { avg, min, max, median, p95, p99, stddev, jitter, samples: times.length };
}

// ── DNS resolve (uncached, forces new lookup) ───────────────────────
function measureDNS(hostname) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    const start = process.hrtime.bigint();
    resolver.resolve4(hostname, (err, addresses) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({
        time: elapsed,
        addresses: addresses || [],
        error: err ? err.code : null,
      });
    });
  });
}

// ── TCP + TLS handshake time (no HTTP payload) ──────────────────────
function measureTCPTLS(hostname, port = 443) {
  const tls = require("tls");
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const socket = tls.connect({ host: hostname, port, servername: hostname }, () => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      socket.destroy();
      resolve(elapsed);
    });
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
    socket.setTimeout(HTTP_TIMEOUT, () => {
      socket.destroy();
      reject(new Error("TCP/TLS Timeout"));
    });
  });
}

// ── HTTP latency (fresh connection each time) ───────────────────────
function measureHTTP(endpoint) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const start = process.hrtime.bigint();

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname || "/",
        port: 443,
        headers: { "User-Agent": "latency-tester/2.0", Connection: "close" },
        agent: false, // force new connection every time (no keep-alive pooling)
      },
      (res) => {
        const ttfb = Number(process.hrtime.bigint() - start) / 1e6;
        let size = 0;
        res.on("data", (chunk) => { size += chunk.length; });
        res.on("end", () => {
          const total = Number(process.hrtime.bigint() - start) / 1e6;
          resolve({ ttfb, total, status: res.statusCode, size });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

// ── WebSocket latency (connection handshake) ────────────────────────
function measureWS(url) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    let settled = false;

    const ws = new WebSocket(url, {
      handshakeTimeout: WS_TIMEOUT,
      headers: { "User-Agent": "latency-tester/2.0" },
    });

    ws.on("open", () => {
      if (settled) return;
      settled = true;
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      ws.close();
      resolve(elapsed);
    });

    ws.on("error", (err) => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(err);
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error("WS Timeout"));
    }, WS_TIMEOUT);
  });
}

// ── Server info ─────────────────────────────────────────────────────
function getServerInfo() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.family === "IPv4") {
        ips.push(`${name}: ${iface.address}`);
      }
    }
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpus: `${os.cpus()[0]?.model || "unknown"} x${os.cpus().length}`,
    memory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    nodeVersion: process.version,
    ips,
  };
}

// ── Run API tests ───────────────────────────────────────────────────
async function runAPITests() {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  REST API Latency Test"));
  console.log(bold(`  Warmup: ${WARMUP_ROUNDS} | Measured rounds: ${ROUNDS} | Delay: ${DELAY_BETWEEN_MS}ms`));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  const results = [];

  for (const ep of API_ENDPOINTS) {
    console.log(`  ${cyan(ep.name)} ${dim(ep.url)}`);

    const hostname = new URL(ep.url).hostname;

    // DNS (multiple samples)
    const dnsResults = [];
    for (let i = 0; i < 5; i++) {
      const d = await measureDNS(hostname);
      dnsResults.push(d.time);
    }
    const dnsAvg = dnsResults.reduce((a, b) => a + b, 0) / dnsResults.length;
    const dnsFirst = await measureDNS(hostname);
    console.log(`    DNS:     avg ${colorLatency(dnsAvg)} (5 lookups) | IPs: ${dnsFirst.addresses.join(", ") || "N/A"}`);

    // TCP+TLS
    try {
      const tlsTime = await measureTCPTLS(hostname);
      console.log(`    TCP+TLS: ${colorLatency(tlsTime)}`);
    } catch (err) {
      console.log(`    TCP+TLS: ${red("ERROR - " + err.message)}`);
    }

    // Warmup
    process.stdout.write(dim(`    Warming up (${WARMUP_ROUNDS} requests)...`));
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      try { await measureHTTP(ep.url); } catch {}
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(dim(" done"));

    // Measured rounds
    const ttfbTimes = [];
    const totalTimes = [];
    const errors = [];

    for (let i = 0; i < ROUNDS; i++) {
      try {
        const m = await measureHTTP(ep.url);
        ttfbTimes.push(m.ttfb);
        totalTimes.push(m.total);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  TTFB: ${colorLatency(m.ttfb)}  Total: ${colorLatency(m.total)}  ${dim(`[${m.status}] ${m.size}B`)}\n`);
      } catch (err) {
        errors.push(err.message);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  ${red("ERROR: " + err.message)}\n`);
      }
      await sleep(DELAY_BETWEEN_MS);
    }

    if (ttfbTimes.length > 0) {
      const ttfbStats = computeStats(ttfbTimes);
      const totalStats = computeStats(totalTimes);
      results.push({
        name: ep.name,
        url: ep.url,
        type: "REST",
        dns: dnsAvg,
        ttfb: ttfbStats,
        total: totalStats,
        errors: errors.length,
        rounds: ROUNDS,
      });
      console.log(`    ${dim("────────────────────────────────────────────────")}`);
      console.log(`    TTFB  → Avg: ${colorLatency(ttfbStats.avg)} | Med: ${colorLatency(ttfbStats.median)} | P95: ${colorLatency(ttfbStats.p95)} | StdDev: ${dim(ttfbStats.stddev.toFixed(2) + "ms")}`);
      console.log(`    Total → Avg: ${colorLatency(totalStats.avg)} | Med: ${colorLatency(totalStats.median)} | P95: ${colorLatency(totalStats.p95)} | Jitter: ${dim(totalStats.jitter.toFixed(2) + "ms")}\n`);
    } else {
      results.push({ name: ep.name, url: ep.url, type: "REST", dns: dnsAvg, ttfb: null, total: null, errors: errors.length, rounds: ROUNDS });
      console.log(red(`    All rounds failed.\n`));
    }
  }

  return results;
}

// ── Run WS tests ────────────────────────────────────────────────────
async function runWSTests() {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  WebSocket Latency Test (Connection Handshake)"));
  console.log(bold(`  Warmup: ${WARMUP_ROUNDS} | Measured rounds: ${ROUNDS} | Delay: ${DELAY_BETWEEN_MS}ms`));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  const results = [];

  for (const ep of WS_ENDPOINTS) {
    console.log(`  ${cyan(ep.name)} ${dim(ep.url)}`);

    const hostname = new URL(ep.url).hostname;

    // DNS
    const dnsResults = [];
    for (let i = 0; i < 5; i++) {
      const d = await measureDNS(hostname);
      dnsResults.push(d.time);
    }
    const dnsAvg = dnsResults.reduce((a, b) => a + b, 0) / dnsResults.length;
    const dnsFirst = await measureDNS(hostname);
    console.log(`    DNS:     avg ${colorLatency(dnsAvg)} (5 lookups) | IPs: ${dnsFirst.addresses.join(", ") || "N/A"}`);

    // TCP+TLS
    try {
      const tlsTime = await measureTCPTLS(hostname);
      console.log(`    TCP+TLS: ${colorLatency(tlsTime)}`);
    } catch (err) {
      console.log(`    TCP+TLS: ${red("ERROR - " + err.message)}`);
    }

    // Warmup
    process.stdout.write(dim(`    Warming up (${WARMUP_ROUNDS} connections)...`));
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      try { await measureWS(ep.url); } catch {}
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(dim(" done"));

    // Measured rounds
    const times = [];
    const errors = [];

    for (let i = 0; i < ROUNDS; i++) {
      try {
        const t = await measureWS(ep.url);
        times.push(t);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  Handshake: ${colorLatency(t)}\n`);
      } catch (err) {
        errors.push(err.message);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  ${red("ERROR: " + err.message)}\n`);
      }
      await sleep(DELAY_BETWEEN_MS);
    }

    if (times.length > 0) {
      const s = computeStats(times);
      results.push({
        name: ep.name,
        url: ep.url,
        type: "WS",
        dns: dnsAvg,
        handshake: s,
        errors: errors.length,
        rounds: ROUNDS,
      });
      console.log(`    ${dim("────────────────────────────────────────────────")}`);
      console.log(`    Handshake → Avg: ${colorLatency(s.avg)} | Med: ${colorLatency(s.median)} | P95: ${colorLatency(s.p95)} | StdDev: ${dim(s.stddev.toFixed(2) + "ms")} | Jitter: ${dim(s.jitter.toFixed(2) + "ms")}\n`);
    } else {
      results.push({ name: ep.name, url: ep.url, type: "WS", dns: dnsAvg, handshake: null, errors: errors.length, rounds: ROUNDS });
      console.log(red(`    All rounds failed.\n`));
    }
  }

  return results;
}

// ── Summary ─────────────────────────────────────────────────────────
function printSummary(serverInfo, apiResults, wsResults) {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  SUMMARY"));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  // Server info
  console.log(dim("  Server:"));
  console.log(dim(`    Hostname:  ${serverInfo.hostname}`));
  console.log(dim(`    Platform:  ${serverInfo.platform}`));
  console.log(dim(`    CPU:       ${serverInfo.cpus}`));
  console.log(dim(`    Memory:    ${serverInfo.memory}`));
  console.log(dim(`    Node:      ${serverInfo.nodeVersion}`));
  console.log(dim(`    IPs:       ${serverInfo.ips.join(" | ")}`));
  console.log("");

  const table = new Table({
    head: ["Endpoint", "Type", "DNS", "Avg", "Median", "Min", "Max", "P95", "P99", "StdDev", "Jitter", "Err"],
    style: { head: ["cyan"] },
    colAligns: ["left", "center", "right", "right", "right", "right", "right", "right", "right", "right", "right", "center"],
  });

  const fmt = (v) => (v == null || isNaN(v) ? "N/A" : v.toFixed(2));

  for (const r of apiResults) {
    const s = r.ttfb;
    table.push([
      r.name, "REST", fmt(r.dns),
      s ? fmt(s.avg) : "N/A", s ? fmt(s.median) : "N/A",
      s ? fmt(s.min) : "N/A", s ? fmt(s.max) : "N/A",
      s ? fmt(s.p95) : "N/A", s ? fmt(s.p99) : "N/A",
      s ? fmt(s.stddev) : "N/A", s ? fmt(s.jitter) : "N/A",
      `${r.errors}/${r.rounds}`,
    ]);
  }

  for (const r of wsResults) {
    const s = r.handshake;
    table.push([
      r.name, "WS", fmt(r.dns),
      s ? fmt(s.avg) : "N/A", s ? fmt(s.median) : "N/A",
      s ? fmt(s.min) : "N/A", s ? fmt(s.max) : "N/A",
      s ? fmt(s.p95) : "N/A", s ? fmt(s.p99) : "N/A",
      s ? fmt(s.stddev) : "N/A", s ? fmt(s.jitter) : "N/A",
      `${r.errors}/${r.rounds}`,
    ]);
  }

  console.log(table.toString());
  console.log(dim("  * REST values = TTFB (Time To First Byte). All times in ms.\n"));

  // Ranking
  const all = [];
  for (const r of apiResults) if (r.ttfb) all.push({ name: r.name, avg: r.ttfb.avg, med: r.ttfb.median });
  for (const r of wsResults) if (r.handshake) all.push({ name: r.name, avg: r.handshake.avg, med: r.handshake.median });
  all.sort((a, b) => a.avg - b.avg);

  console.log(bold("  Ranking (by avg latency):\n"));
  all.forEach((r, i) => {
    const medal = i === 0 ? green("1st") : i === 1 ? yellow("2nd") : i === 2 ? red("3rd") : dim(`${i + 1}th`);
    console.log(`    ${medal}  ${r.name.padEnd(25)} Avg: ${colorLatency(r.avg)}  Med: ${colorLatency(r.med)}`);
  });
  console.log("");
}

// ── JSON dump to console ────────────────────────────────────────────
function printJSONReport(serverInfo, apiResults, wsResults) {
  const fmt = (v) => (v == null || isNaN(v)) ? null : +v.toFixed(2);

  const report = {
    timestamp: new Date().toISOString(),
    server: serverInfo,
    config: { warmupRounds: WARMUP_ROUNDS, measuredRounds: ROUNDS, delayBetweenMs: DELAY_BETWEEN_MS },
    results: {
      api: apiResults.map((r) => ({
        name: r.name, url: r.url, dns_ms: fmt(r.dns),
        ttfb: r.ttfb ? { avg: fmt(r.ttfb.avg), median: fmt(r.ttfb.median), min: fmt(r.ttfb.min), max: fmt(r.ttfb.max), p95: fmt(r.ttfb.p95), p99: fmt(r.ttfb.p99), stddev: fmt(r.ttfb.stddev), jitter: fmt(r.ttfb.jitter) } : null,
        total: r.total ? { avg: fmt(r.total.avg), median: fmt(r.total.median), min: fmt(r.total.min), max: fmt(r.total.max) } : null,
        errors: r.errors, rounds: r.rounds,
      })),
      websocket: wsResults.map((r) => ({
        name: r.name, url: r.url, dns_ms: fmt(r.dns),
        handshake: r.handshake ? { avg: fmt(r.handshake.avg), median: fmt(r.handshake.median), min: fmt(r.handshake.min), max: fmt(r.handshake.max), p95: fmt(r.handshake.p95), p99: fmt(r.handshake.p99), stddev: fmt(r.handshake.stddev), jitter: fmt(r.handshake.jitter) } : null,
        errors: r.errors, rounds: r.rounds,
      })),
    },
  };

  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  JSON REPORT (copy-paste friendly)"));
  console.log(bold("══════════════════════════════════════════════════════════════"));
  console.log(JSON.stringify(report, null, 2));
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const serverInfo = getServerInfo();

  console.log(bold("\n  Polymarket Latency Tester v2.0"));
  console.log(dim(`  ${serverInfo.hostname} | ${serverInfo.platform} | Node ${serverInfo.nodeVersion}`));
  console.log(dim(`  Started at ${new Date().toISOString()}`));
  console.log(dim(`  Config: ${WARMUP_ROUNDS} warmup + ${ROUNDS} measured rounds, ${DELAY_BETWEEN_MS}ms delay\n`));

  const apiResults = await runAPITests();
  const wsResults = await runWSTests();

  printSummary(serverInfo, apiResults, wsResults);
  printJSONReport(serverInfo, apiResults, wsResults);

  console.log(dim(`\n  Finished at ${new Date().toISOString()}\n`));
}

main().catch((err) => {
  console.error(red("Fatal error:"), err);
  process.exit(1);
});
