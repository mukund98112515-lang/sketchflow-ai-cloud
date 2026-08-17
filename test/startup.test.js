"use strict";

// Boot the real production server (src/index.js) with no external services
// configured at all. The stateless backend must start instantly, bind
// 0.0.0.0:PORT, serve /health, and stay alive with zero dependencies.

const { spawn } = require("child_process");
const path = require("path");

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function main() {
  const serverRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d.toString()));
  child.stderr.on("data", (d) => (logs += d.toString()));

  try {
    // Poll /health until it answers, or fail fast.
    let health = null;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.status === 200) {
          health = await r.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }

    assert(!!health, "GET /health returns HTTP 200 in production-mode boot");
    assert(health.ok === true, "/health reports ok:true");
    assert(health.service === "sketchflow-api", "/health reports service:sketchflow-api");
    assert(child.exitCode === null, "server process stays alive (stateless, no external deps)");

    // Simple root route also answers.
    const root = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
    assert(root.status === 200, "GET / returns HTTP 200");
    const rootBody = await root.json();
    assert(rootBody.status === "online", "GET / reports status:online");

    // Startup logs show the required safe lines.
    assert(logs.includes(`listening on 0.0.0.0:${PORT}`), "startup log shows listening on 0.0.0.0:PORT");
    assert(logs.includes("health endpoint ready at /health"), "startup log shows health endpoint ready");
    assert(!/(DATABASE_URL=)|(STORAGE_ACCESS_KEY=)|(R2_SECRET)|(AI_API_KEY=)|(password=)|(secret)/i.test(logs), "startup logs contain no secrets");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => {
      child.once("exit", r);
      setTimeout(r, 3000);
    });
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
