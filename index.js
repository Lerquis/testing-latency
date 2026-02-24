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

const WARMUP_ROUNDS = 3;
const ROUNDS = 30;
const DELAY_BETWEEN_MS = 100;
const WS_TIMEOUT = 10000;
const HTTP_TIMEOUT = 10000;
const WS_PING_ROUNDS = 30;      // pings por WebSocket abierto
const WS_PING_INTERVAL_MS = 200; // intervalo entre pings

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
  if (!times.length) return null;
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

  const variance = times.reduce((s, t) => s + (t - avg) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);

  let jitter = 0;
  if (times.length > 1) {
    for (let i = 1; i < times.length; i++) {
      jitter += Math.abs(times[i] - times[i - 1]);
    }
    jitter /= times.length - 1;
  }

  return { avg, min, max, median, p95, p99, stddev, jitter, samples: times.length };
}

// ── DNS resolve (uncached) ──────────────────────────────────────────
function measureDNS(hostname) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    const start = process.hrtime.bigint();
    resolver.resolve4(hostname, (err, addresses) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ time: elapsed, addresses: addresses || [], error: err ? err.code : null });
    });
  });
}

// ── TCP + TLS handshake ─────────────────────────────────────────────
function measureTCPTLS(hostname, port = 443) {
  const tls = require("tls");
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const socket = tls.connect({ host: hostname, port, servername: hostname }, () => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      socket.destroy();
      resolve(elapsed);
    });
    socket.on("error", (err) => { socket.destroy(); reject(err); });
    socket.setTimeout(HTTP_TIMEOUT, () => { socket.destroy(); reject(new Error("TCP/TLS Timeout")); });
  });
}

// ── HTTP latency (fresh connection, no keep-alive) ──────────────────
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
        agent: false,
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
    req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── HTTP latency (keep-alive, reuses connection) ────────────────────
function createKeepAliveAgent() {
  return new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
}

function measureHTTPKeepAlive(endpoint, agent) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const start = process.hrtime.bigint();

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname || "/",
        port: 443,
        headers: { "User-Agent": "latency-tester/2.0" },
        agent,
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
    req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── WebSocket handshake ─────────────────────────────────────────────
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

// ── WebSocket ping/pong RTT (persistent connection) ─────────────────
function measureWSPingPong(url, rounds, interval) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      handshakeTimeout: WS_TIMEOUT,
      headers: { "User-Agent": "latency-tester/2.0" },
    });

    const times = [];
    let settled = false;

    ws.on("open", async () => {
      // Send pings and measure pong RTT
      for (let i = 0; i < rounds; i++) {
        try {
          const rtt = await new Promise((res, rej) => {
            const start = process.hrtime.bigint();
            ws.ping();
            const onPong = () => {
              const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
              cleanup();
              res(elapsed);
            };
            const onError = (err) => { cleanup(); rej(err); };
            const cleanup = () => {
              ws.removeListener("pong", onPong);
              ws.removeListener("error", onError);
            };
            ws.once("pong", onPong);
            ws.once("error", onError);
            setTimeout(() => { cleanup(); rej(new Error("Ping timeout")); }, 5000);
          });
          times.push(rtt);
        } catch {}
        await sleep(interval);
      }

      ws.close();
      settled = true;
      resolve(times);
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
    }, WS_TIMEOUT + rounds * (interval + 5000));
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

// ── Run API tests (cold + keep-alive) ───────────────────────────────
async function runAPITests() {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  REST API Latency Test (Cold Connection)"));
  console.log(bold(`  Warmup: ${WARMUP_ROUNDS} | Measured rounds: ${ROUNDS} | Delay: ${DELAY_BETWEEN_MS}ms`));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  const coldResults = [];
  const keepAliveResults = [];

  for (const ep of API_ENDPOINTS) {
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

    // ── COLD (no keep-alive) ──
    console.log(dim(`\n    --- Cold (new connection each request) ---`));
    process.stdout.write(dim(`    Warming up (${WARMUP_ROUNDS} requests)...`));
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      try { await measureHTTP(ep.url); } catch {}
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(dim(" done"));

    const coldTtfb = [];
    const coldErrors = [];

    for (let i = 0; i < ROUNDS; i++) {
      try {
        const m = await measureHTTP(ep.url);
        coldTtfb.push(m.ttfb);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  TTFB: ${colorLatency(m.ttfb)}  ${dim(`[${m.status}]`)}\n`);
      } catch (err) {
        coldErrors.push(err.message);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  ${red("ERROR: " + err.message)}\n`);
      }
      await sleep(DELAY_BETWEEN_MS);
    }

    const coldStats = computeStats(coldTtfb);
    if (coldStats) {
      coldResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: coldStats, errors: coldErrors.length, rounds: ROUNDS });
      console.log(`    ${dim("────────────────────────────────────────────────")}`);
      console.log(`    Cold  → Avg: ${colorLatency(coldStats.avg)} | Med: ${colorLatency(coldStats.median)} | P95: ${colorLatency(coldStats.p95)} | StdDev: ${dim(coldStats.stddev.toFixed(2) + "ms")}`);
    } else {
      coldResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: null, errors: coldErrors.length, rounds: ROUNDS });
      console.log(red(`    All cold rounds failed.`));
    }

    // ── KEEP-ALIVE (persistent connection) ──
    console.log(dim(`\n    --- Keep-Alive (reused connection) ---`));
    const agent = createKeepAliveAgent();

    // Warmup keep-alive (establishes the connection)
    process.stdout.write(dim(`    Establishing connection...`));
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      try { await measureHTTPKeepAlive(ep.url, agent); } catch {}
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(dim(" done"));

    const kaTtfb = [];
    const kaErrors = [];

    for (let i = 0; i < ROUNDS; i++) {
      try {
        const m = await measureHTTPKeepAlive(ep.url, agent);
        kaTtfb.push(m.ttfb);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  TTFB: ${colorLatency(m.ttfb)}  ${dim(`[${m.status}]`)}\n`);
      } catch (err) {
        kaErrors.push(err.message);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  ${red("ERROR: " + err.message)}\n`);
      }
      await sleep(DELAY_BETWEEN_MS);
    }

    agent.destroy();

    const kaStats = computeStats(kaTtfb);
    if (kaStats) {
      keepAliveResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: kaStats, errors: kaErrors.length, rounds: ROUNDS });
      console.log(`    ${dim("────────────────────────────────────────────────")}`);
      console.log(`    KA    → Avg: ${colorLatency(kaStats.avg)} | Med: ${colorLatency(kaStats.median)} | P95: ${colorLatency(kaStats.p95)} | StdDev: ${dim(kaStats.stddev.toFixed(2) + "ms")}`);
    } else {
      keepAliveResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: null, errors: kaErrors.length, rounds: ROUNDS });
      console.log(red(`    All keep-alive rounds failed.`));
    }

    // Comparison
    if (coldStats && kaStats) {
      const improvement = ((coldStats.median - kaStats.median) / coldStats.median * 100).toFixed(1);
      console.log(`\n    ${bold(`Improvement: ${improvement}% faster with keep-alive (${coldStats.median.toFixed(1)}ms → ${kaStats.median.toFixed(1)}ms median)`)}\n`);
    }
  }

  return { coldResults, keepAliveResults };
}

// ── Run WS tests (handshake + ping/pong) ────────────────────────────
async function runWSTests() {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  WebSocket Latency Test"));
  console.log(bold(`  Handshake: ${ROUNDS} rounds | Ping/Pong: ${WS_PING_ROUNDS} pings per connection`));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  const handshakeResults = [];
  const pingResults = [];

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

    // ── HANDSHAKE (new connection each time) ──
    console.log(dim(`\n    --- Handshake (new connection each time) ---`));
    process.stdout.write(dim(`    Warming up (${WARMUP_ROUNDS} connections)...`));
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      try { await measureWS(ep.url); } catch {}
      await sleep(DELAY_BETWEEN_MS);
    }
    console.log(dim(" done"));

    const hsTimes = [];
    const hsErrors = [];

    for (let i = 0; i < ROUNDS; i++) {
      try {
        const t = await measureWS(ep.url);
        hsTimes.push(t);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  Handshake: ${colorLatency(t)}\n`);
      } catch (err) {
        hsErrors.push(err.message);
        process.stdout.write(`    #${String(i + 1).padStart(2)}  ${red("ERROR: " + err.message)}\n`);
      }
      await sleep(DELAY_BETWEEN_MS);
    }

    const hsStats = computeStats(hsTimes);
    if (hsStats) {
      handshakeResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: hsStats, errors: hsErrors.length, rounds: ROUNDS });
      console.log(`    ${dim("────────────────────────────────────────────────")}`);
      console.log(`    Handshake → Avg: ${colorLatency(hsStats.avg)} | Med: ${colorLatency(hsStats.median)} | P95: ${colorLatency(hsStats.p95)}`);
    } else {
      handshakeResults.push({ name: ep.name, url: ep.url, dns: dnsAvg, stats: null, errors: hsErrors.length, rounds: ROUNDS });
      console.log(red(`    All handshake rounds failed.`));
    }

    // ── PING/PONG (persistent connection RTT) ──
    console.log(dim(`\n    --- Ping/Pong RTT (persistent connection) ---`));
    try {
      const pingTimes = await measureWSPingPong(ep.url, WS_PING_ROUNDS, WS_PING_INTERVAL_MS);

      for (let i = 0; i < pingTimes.length; i++) {
        process.stdout.write(`    #${String(i + 1).padStart(2)}  RTT: ${colorLatency(pingTimes[i])}\n`);
      }

      const pingStats = computeStats(pingTimes);
      if (pingStats) {
        pingResults.push({ name: ep.name, url: ep.url, stats: pingStats, errors: WS_PING_ROUNDS - pingTimes.length, rounds: WS_PING_ROUNDS });
        console.log(`    ${dim("────────────────────────────────────────────────")}`);
        console.log(`    Ping RTT → Avg: ${colorLatency(pingStats.avg)} | Med: ${colorLatency(pingStats.median)} | P95: ${colorLatency(pingStats.p95)}`);
      }

      // Comparison
      if (hsStats && pingStats) {
        const improvement = ((hsStats.median - pingStats.median) / hsStats.median * 100).toFixed(1);
        console.log(`\n    ${bold(`Improvement: ${improvement}% faster persistent vs handshake (${hsStats.median.toFixed(1)}ms → ${pingStats.median.toFixed(1)}ms median)`)}\n`);
      }
    } catch (err) {
      console.log(`    ${red("ERROR: " + err.message)}`);
      pingResults.push({ name: ep.name, url: ep.url, stats: null, errors: WS_PING_ROUNDS, rounds: WS_PING_ROUNDS });
    }
  }

  return { handshakeResults, pingResults };
}

// ── Summary ─────────────────────────────────────────────────────────
function printSummary(serverInfo, apiData, wsData) {
  console.log(bold("\n══════════════════════════════════════════════════════════════"));
  console.log(bold("  SUMMARY"));
  console.log(bold("══════════════════════════════════════════════════════════════\n"));

  console.log(dim("  Server:"));
  console.log(dim(`    Hostname:  ${serverInfo.hostname}`));
  console.log(dim(`    Platform:  ${serverInfo.platform}`));
  console.log(dim(`    CPU:       ${serverInfo.cpus}`));
  console.log(dim(`    Memory:    ${serverInfo.memory}`));
  console.log(dim(`    Node:      ${serverInfo.nodeVersion}`));
  console.log(dim(`    IPs:       ${serverInfo.ips.join(" | ")}`));
  console.log("");

  // Cold vs Keep-Alive table
  console.log(bold("  REST API - Cold vs Keep-Alive:\n"));
  const apiTable = new Table({
    head: ["Endpoint", "Mode", "Avg", "Median", "Min", "Max", "P95", "StdDev", "Jitter", "Err"],
    style: { head: ["cyan"] },
    colAligns: ["left", "center", "right", "right", "right", "right", "right", "right", "right", "center"],
  });

  const fmt = (v) => (v == null || isNaN(v) ? "N/A" : v.toFixed(2));

  for (let i = 0; i < apiData.coldResults.length; i++) {
    const cold = apiData.coldResults[i];
    const ka = apiData.keepAliveResults[i];
    const cs = cold.stats;
    const ks = ka.stats;

    apiTable.push([
      cold.name, "Cold",
      cs ? fmt(cs.avg) : "N/A", cs ? fmt(cs.median) : "N/A",
      cs ? fmt(cs.min) : "N/A", cs ? fmt(cs.max) : "N/A",
      cs ? fmt(cs.p95) : "N/A", cs ? fmt(cs.stddev) : "N/A",
      cs ? fmt(cs.jitter) : "N/A", `${cold.errors}/${cold.rounds}`,
    ]);
    apiTable.push([
      "", "KA",
      ks ? fmt(ks.avg) : "N/A", ks ? fmt(ks.median) : "N/A",
      ks ? fmt(ks.min) : "N/A", ks ? fmt(ks.max) : "N/A",
      ks ? fmt(ks.p95) : "N/A", ks ? fmt(ks.stddev) : "N/A",
      ks ? fmt(ks.jitter) : "N/A", `${ka.errors}/${ka.rounds}`,
    ]);
  }
  console.log(apiTable.toString());

  // WS Handshake vs Ping/Pong table
  console.log(bold("\n  WebSocket - Handshake vs Ping/Pong RTT:\n"));
  const wsTable = new Table({
    head: ["Endpoint", "Mode", "Avg", "Median", "Min", "Max", "P95", "StdDev", "Jitter", "Err"],
    style: { head: ["cyan"] },
    colAligns: ["left", "center", "right", "right", "right", "right", "right", "right", "right", "center"],
  });

  for (let i = 0; i < wsData.handshakeResults.length; i++) {
    const hs = wsData.handshakeResults[i];
    const pg = wsData.pingResults[i];
    const hss = hs.stats;
    const pgs = pg ? pg.stats : null;

    wsTable.push([
      hs.name, "Handshake",
      hss ? fmt(hss.avg) : "N/A", hss ? fmt(hss.median) : "N/A",
      hss ? fmt(hss.min) : "N/A", hss ? fmt(hss.max) : "N/A",
      hss ? fmt(hss.p95) : "N/A", hss ? fmt(hss.stddev) : "N/A",
      hss ? fmt(hss.jitter) : "N/A", `${hs.errors}/${hs.rounds}`,
    ]);
    wsTable.push([
      "", "Ping RTT",
      pgs ? fmt(pgs.avg) : "N/A", pgs ? fmt(pgs.median) : "N/A",
      pgs ? fmt(pgs.min) : "N/A", pgs ? fmt(pgs.max) : "N/A",
      pgs ? fmt(pgs.p95) : "N/A", pgs ? fmt(pgs.stddev) : "N/A",
      pgs ? fmt(pgs.jitter) : "N/A", pg ? `${pg.errors}/${pg.rounds}` : "N/A",
    ]);
  }
  console.log(wsTable.toString());
  console.log(dim("  * Cold = new TCP+TLS+HTTP per request. KA = reused connection. Ping RTT = round-trip on open WS."));
  console.log(dim("  * All times in ms.\n"));

  // Production ranking (keep-alive + ping)
  const all = [];
  for (const r of apiData.keepAliveResults) if (r.stats) all.push({ name: r.name + " (KA)", avg: r.stats.avg, med: r.stats.median });
  for (const r of wsData.pingResults) if (r && r.stats) all.push({ name: r.name + " (Ping)", avg: r.stats.avg, med: r.stats.median });
  all.sort((a, b) => a.avg - b.avg);

  console.log(bold("  Production Ranking (persistent connections):\n"));
  all.forEach((r, i) => {
    const medal = i === 0 ? green("1st") : i === 1 ? yellow("2nd") : i === 2 ? red("3rd") : dim(`${i + 1}th`);
    console.log(`    ${medal}  ${r.name.padEnd(30)} Avg: ${colorLatency(r.avg)}  Med: ${colorLatency(r.med)}`);
  });
  console.log("");
}

// ── JSON dump to console ────────────────────────────────────────────
function printJSONReport(serverInfo, apiData, wsData) {
  const fmt = (v) => (v == null || isNaN(v)) ? null : +v.toFixed(2);
  const fmtStats = (s) => s ? { avg: fmt(s.avg), median: fmt(s.median), min: fmt(s.min), max: fmt(s.max), p95: fmt(s.p95), p99: fmt(s.p99), stddev: fmt(s.stddev), jitter: fmt(s.jitter) } : null;

  const report = {
    timestamp: new Date().toISOString(),
    server: serverInfo,
    config: { warmupRounds: WARMUP_ROUNDS, measuredRounds: ROUNDS, delayBetweenMs: DELAY_BETWEEN_MS, wsPingRounds: WS_PING_ROUNDS },
    results: {
      api: apiData.coldResults.map((r, i) => ({
        name: r.name, url: r.url, dns_ms: fmt(r.dns),
        cold: fmtStats(r.stats),
        keepAlive: fmtStats(apiData.keepAliveResults[i]?.stats),
        errors: { cold: r.errors, keepAlive: apiData.keepAliveResults[i]?.errors || 0 },
        rounds: r.rounds,
      })),
      websocket: wsData.handshakeResults.map((r, i) => ({
        name: r.name, url: r.url, dns_ms: fmt(r.dns),
        handshake: fmtStats(r.stats),
        pingRTT: fmtStats(wsData.pingResults[i]?.stats),
        errors: { handshake: r.errors, ping: wsData.pingResults[i]?.errors || 0 },
        rounds: { handshake: r.rounds, ping: WS_PING_ROUNDS },
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

  console.log(bold("\n  Polymarket Latency Tester v3.0"));
  console.log(dim(`  ${serverInfo.hostname} | ${serverInfo.platform} | Node ${serverInfo.nodeVersion}`));
  console.log(dim(`  Started at ${new Date().toISOString()}`));
  console.log(dim(`  Config: ${WARMUP_ROUNDS} warmup + ${ROUNDS} measured rounds, ${DELAY_BETWEEN_MS}ms delay`));
  console.log(dim(`  WS Ping: ${WS_PING_ROUNDS} pings per connection, ${WS_PING_INTERVAL_MS}ms interval\n`));

  const apiData = await runAPITests();
  const wsData = await runWSTests();

  printSummary(serverInfo, apiData, wsData);
  printJSONReport(serverInfo, apiData, wsData);

  console.log(dim(`\n  Finished at ${new Date().toISOString()}\n`));
}

main().catch((err) => {
  console.error(red("Fatal error:"), err);
  process.exit(1);
});
