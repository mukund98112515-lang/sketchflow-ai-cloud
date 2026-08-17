"use strict";

// Boot the real production server (src/index.js) in two modes:
// 1. No API keys → algorithmic mode, /health shows aiConfigured:false
// 2. With XAI_API_KEY → xai mode, /health shows aiConfigured:true
//
// Both must start instantly, bind 0.0.0.0:PORT, serve /health, and stay alive.

const { spawn } = require("child_process");
const path = require("path");

const PORT_NO_KEY = 8798;
const PORT_XAI = 8799;
const BASE_NO_KEY = `http://127.0.0.1:${PORT_NO_KEY}`;
const BASE_XAI = `http://127.0.0.1:${PORT_XAI}`;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`PASS ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(base, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return null;
}

function kill(child) {
  return new Promise((r) => {
    child.kill("SIGTERM");
    child.once("exit", r);
    setTimeout(r, 3000);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
}

/**
 * Test 1: Boot with NO API keys — algorithmic mode.
 */
async function testNoKey() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT_NO_KEY),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE_NO_KEY,
      // Explicitly ensure no AI keys are set
      AI_API_KEY: "",
      XAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForHealth(BASE_NO_KEY);
    assert(!!health, "no-key: GET /health returns HTTP 200");
    assert(health.ok === true, "no-key: /health reports ok:true");
    assert(health.service === "sketchflow-api", "no-key: /health reports service:sketchflow-api");
    assert(health.aiConfigured === false, "no-key: /health reports aiConfigured:false");
    assert(health.aiProvider === "local", "no-key: /health reports aiProvider:local");
    assert(child.exitCode === null, "no-key: server process stays alive");

    const root = await fetch(`${BASE_NO_KEY}/`, { signal: AbortSignal.timeout(1500) });
    assert(root.status === 200, "no-key: GET / returns HTTP 200");

    assert(logs.includes(`listening on 0.0.0.0:${PORT_NO_KEY}`), "no-key: startup log shows listening");
    assert(logs.includes("health endpoint ready at /health"), "no-key: startup log shows health endpoint ready");
    assert(logs.includes("AI provider: algorithmic (no API key)"), "no-key: startup log shows algorithmic mode");
    assert(!/(DATABASE_URL=)|(STORAGE_ACCESS_KEY=)|(R2_SECRET)|(AI_API_KEY=)|(XAI_API_KEY=)|(password=)|(secret)/i.test(logs), "no-key: startup logs contain no secrets");
  } finally {
    await kill(child);
  }
}

/**
 * Test 2: Boot with XAI_API_KEY set — xAI mode.
 * The key value is fake; we only check detection, not real API calls.
 */
async function testXaiConfig() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT_XAI),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE_XAI,
      AI_PROVIDER: "xai",
      XAI_API_KEY: "test-secret-not-real",
      AI_MODEL: "grok-4.5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForHealth(BASE_XAI);
    assert(!!health, "xai-config: GET /health returns HTTP 200");
    assert(health.ok === true, "xai-config: /health reports ok:true");
    assert(health.aiConfigured === true, "xai-config: /health reports aiConfigured:true");
    assert(health.aiProvider === "xai", "xai-config: /health reports aiProvider:xai");
    assert(child.exitCode === null, "xai-config: server process stays alive");

    // Startup log must show xai, not algorithmic
    assert(logs.includes("AI provider: xai"), "xai-config: startup log shows AI provider: xai");
    assert(!logs.includes("algorithmic (no API key)"), "xai-config: startup log does NOT show algorithmic mode");
    assert(!logs.includes("test-secret"), "xai-config: secret key is not leaked in logs");
    assert(!/(XAI_API_KEY=)|(AI_API_KEY=)|(password=)|(secret=)/i.test(logs), "xai-config: no key values in logs");
  } finally {
    await kill(child);
  }
}

async function main() {
  await testNoKey();
  await testXaiConfig();
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
