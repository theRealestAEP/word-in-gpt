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
  WHERE timestamp > NOW() - INTERVAL '90' DAY
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
console.log("\nChatGPT: exact users who called a tool; new means first seen since counting began on Oct 13, 2026.");
console.log("Worked on a doc: the model read (inspect, project) or edited the document, not only opened it.");
console.log("Codex desktop: installs estimated per day by network and version, so new and returning cannot be told apart.");
