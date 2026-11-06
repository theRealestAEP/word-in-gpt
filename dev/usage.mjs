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

// blob1 = client kind, blob2 = event, blob3 = what the call did (open, connect, read, edit),
// index1 = hashed user (see src/server/usage.ts). Analytics Engine keeps three months of data.
// Days before blob3 existed have it empty, so their "worked" columns show n/a.
const pairs = await query(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob1 AS client, blob2 AS event, blob3 AS action, index1 AS user
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '90' DAY AND blob2 IN ('connect', 'tool-call')
  GROUP BY day, client, event, action, user
  FORMAT JSON`);

const days = new Map();
const firstSeen = new Map();
for (const { day, client, event, action, user } of pairs) {
  const date = day.slice(0, 10);
  const counts = days.get(date) ?? { chatgpt: new Set(), chatgptWorked: new Set(), connected: new Set(), used: new Set(), codexWorked: new Set(), hasKinds: false };
  const worked = action === "read" || action === "edit";
  if (action) counts.hasKinds = true;
  if (client === "chatgpt") {
    counts.chatgpt.add(user);
    if (worked) counts.chatgptWorked.add(user);
    if (!firstSeen.has(user) || date < firstSeen.get(user)) firstSeen.set(user, date);
  } else if (event === "connect") counts.connected.add(user);
  else {
    counts.used.add(user);
    if (worked) counts.codexWorked.add(user);
  }
  days.set(date, counts);
}

const pad = (value, width) => String(value).padStart(width);
console.log("day (UTC)   ChatGPT  new  returning | worked on a doc  returning who worked | Codex connected  used a tool  worked on a doc");
for (const date of [...days.keys()].sort()) {
  const { chatgpt, chatgptWorked, connected, used, codexWorked, hasKinds } = days.get(date);
  const fresh = [...chatgpt].filter((user) => firstSeen.get(user) === date).length;
  const returningWorked = [...chatgptWorked].filter((user) => firstSeen.get(user) !== date).length;
  const worked = hasKinds ? pad(chatgptWorked.size, 14) : pad("n/a", 14);
  const retWorked = hasKinds ? pad(`${returningWorked} of ${chatgpt.size - fresh}`, 20) : pad("n/a", 20);
  const codexWork = hasKinds ? pad(codexWorked.size, 15) : pad("n/a", 15);
  console.log(`${date}  ${pad(chatgpt.size, 7)}  ${pad(fresh, 3)}  ${pad(chatgpt.size - fresh, 9)} | ${worked}  ${retWorked} | ${pad(connected.size, 15)}  ${pad(used.size, 11)}  ${codexWork}`);
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
const failures = await query(`
  SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob3 AS reason, blob4 AS place, blob1 AS client,
    SUM(_sample_interval) AS failures, count(DISTINCT index1) AS users
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob2 = 'failure'
  GROUP BY day, reason, place, client
  ORDER BY day, failures DESC
  FORMAT JSON`);
console.log("\nFailures, last 7 days");
console.log("day (UTC)   failures  users  client         reason               tool or route");
for (const { day, reason, place, client, failures: count, users } of failures) {
  console.log(`${day.slice(0, 10)}  ${pad(count, 8)}  ${pad(client === "unknown" ? "-" : users, 5)}  ${client.padEnd(13)}  ${reason.padEnd(19)}  ${place}`);
}
const timings = await query(`
  SELECT blob3 AS size, blob4 AS page, SUM(_sample_interval) AS loads,
    quantileWeighted(0.5, double1 + double2 + double3 + double4, _sample_interval) AS median,
    quantileWeighted(0.9, double1 + double2 + double3 + double4, _sample_interval) AS p90,
    quantileWeighted(0.9, double1, _sample_interval) AS p90Start,
    quantileWeighted(0.9, double2, _sample_interval) AS p90Read,
    quantileWeighted(0.9, double3, _sample_interval) AS p90Show,
    quantileWeighted(0.9, double4, _sample_interval) AS p90Connect
  FROM word_in_gpt_usage
  WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob2 = 'timing'
  GROUP BY size, page
  ORDER BY size, page
  FORMAT JSON`);
const seconds = (ms) => pad((ms / 1000).toFixed(1), 6);
console.log("\nEditor load, seconds from page start to connected, last 7 days");
console.log("size         page     loads  median     p90  | p90 start  read  show  connect");
for (const { size, page, loads, median, p90, p90Start, p90Read, p90Show, p90Connect } of timings) {
  console.log(`${size.padEnd(11)}  ${page.padEnd(7)}  ${pad(loads, 5)}  ${seconds(median)}  ${seconds(p90)}  | ${seconds(p90Start)}  ${seconds(p90Read)}  ${seconds(p90Show)}  ${seconds(p90Connect)}`);
}
console.log("\nChatGPT: exact users who called a tool; new means first seen since counting began on Oct 13, 2026.");
console.log("Worked on a doc: the model read (inspect, project) or edited the document, not only opened it.");
console.log("Codex desktop: installs estimated per day by network and version, so new and returning cannot be told apart.");
console.log("Failures: fixed labels only, never error text. Browser requests carry no user ID, so their users show as -.");
