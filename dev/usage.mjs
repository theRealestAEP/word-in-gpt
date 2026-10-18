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
// Analytics Engine keeps three months of data.
const pairs = await query(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS client, blob2 AS event, index1 AS user
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '90' DAY
  GROUP BY day, client, event, user
  FORMAT JSON`);

const days = new Map();
const firstSeen = new Map();
for (const { day, client, event, user } of pairs) {
  const date = day.slice(0, 10);
  const counts = days.get(date) ?? { chatgpt: new Set(), connected: new Set(), used: new Set() };
  if (client === "chatgpt") {
    counts.chatgpt.add(user);
    if (!firstSeen.has(user) || date < firstSeen.get(user)) firstSeen.set(user, date);
  } else if (event === "connect") counts.connected.add(user);
  else counts.used.add(user);
  days.set(date, counts);
}

const pad = (value, width) => String(value).padStart(width);
console.log("day (UTC)   ChatGPT users   new  returning   Codex connected  Codex used a tool");
for (const date of [...days.keys()].sort()) {
  const { chatgpt, connected, used } = days.get(date);
  const fresh = [...chatgpt].filter((user) => firstSeen.get(user) === date).length;
  console.log(`${date}  ${pad(chatgpt.size, 13)}  ${pad(fresh, 4)}  ${pad(chatgpt.size - fresh, 9)}   ${pad(connected.size, 15)}  ${pad(used.size, 17)}`);
}
console.log(`\nChatGPT users ever: ${firstSeen.size}`);

const lastHour = await query(`
  SELECT blob1 AS client, blob2 AS event, count(DISTINCT index1) AS users
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '1' HOUR
  GROUP BY client, event
  FORMAT JSON`);
const hour = (client, event) => lastHour.find((row) => row.client === client && row.event === event)?.users ?? 0;
console.log(`Last hour: ${hour("chatgpt", "tool-call")} ChatGPT users · ${hour("codex-desktop", "connect")} Codex connected · ${hour("codex-desktop", "tool-call")} Codex used a tool`);
console.log("\nChatGPT: exact users who called a tool; new means first seen since counting began on Oct 13, 2026.");
console.log("Codex desktop: installs estimated per day by network and version, so new and returning cannot be told apart.");
