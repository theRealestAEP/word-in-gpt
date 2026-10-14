// Unique users per day from the Worker's Analytics Engine dataset.
// Needs a Cloudflare API token with the "Account Analytics: Read" permission,
// stored once in the macOS Keychain (the prompt hides what you type):
//   security add-generic-password -a "$USER" -s word-in-gpt-analytics -w
import { execFileSync } from "node:child_process";

const account = "08d4b257b06d9963dceb8819bd226c35";
const keychainService = "word-in-gpt-analytics";

function readToken() {
  if (process.env.CLOUDFLARE_ANALYTICS_TOKEN) return process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  try {
    return execFileSync("security", ["find-generic-password", "-s", keychainService, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const token = readToken();
if (!token) {
  console.error(`Store a Cloudflare API token with Account Analytics: Read in the Keychain:\n  security add-generic-password -a "$USER" -s ${keychainService} -w`);
  process.exit(1);
}

async function query(sql) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: sql,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text).data;
}

// blob1 = client kind, blob2 = event, index1 = hashed user (see src/server/usage.ts).
const rows = await query(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS client, blob2 AS event,
         count(DISTINCT index1) AS users
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '14' DAY
  GROUP BY day, client, event
  ORDER BY day DESC, client, event
  FORMAT JSON`);

console.log("day         client          connected  used a tool");
const days = new Map();
for (const { day, client, event, users } of rows) {
  const key = `${day.slice(0, 10)}  ${client.padEnd(14)}`;
  const counts = days.get(key) ?? { connect: 0, "tool-call": 0 };
  counts[event] = Number(users);
  days.set(key, counts);
}
for (const [key, counts] of days) {
  console.log(`${key}  ${String(counts.connect).padStart(9)}  ${String(counts["tool-call"]).padStart(11)}`);
}
console.log("\nchatgpt: exact users (anonymized ChatGPT user ID). codex-desktop: installs, estimated per day by network and version.");
