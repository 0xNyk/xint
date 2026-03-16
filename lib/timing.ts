import { loadTokens, getValidToken } from "./oauth";
import { getUserTimeline, type TweetWithEngagement } from "./timeline";
import { bold, cyan, yellow, dim, green } from "./format";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BLOCKS = ["░", "▒", "▓", "█"];

function getDayIndex(dateStr: string): number {
  const d = new Date(dateStr).getDay();
  // Convert from Sun=0 to Mon=0
  return d === 0 ? 6 : d - 1;
}

function getHour(dateStr: string): number {
  return new Date(dateStr).getHours();
}

function quantize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  const normalized = (value - min) / (max - min);
  return Math.min(Math.floor(normalized * 4), 3);
}

export async function cmdTiming(args: string[]): Promise<void> {
  let since = "30d";
  let asJson = false;
  let pages = 5;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--since":
        since = args[++i] || "30d";
        break;
      case "--json":
        asJson = true;
        break;
      case "--pages":
        pages = Math.min(parseInt(args[++i] || "5"), 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        return;
      default:
        break;
    }
    i++;
  }

  let token: string;
  try {
    token = await getValidToken();
  } catch (e: any) {
    console.error("OAuth required. Run 'xint auth setup' first.");
    console.error(`Error: ${e.message}`);
    process.exit(1);
    return;
  }

  const tokens = loadTokens();
  if (!tokens?.user_id) {
    console.error("Could not determine user ID. Re-run 'xint auth setup'.");
    process.exit(1);
    return;
  }

  console.error(`Fetching your tweets (since ${since})...`);

  const tweets = await getUserTimeline(tokens.user_id, token, {
    since,
    pages,
    exclude: ["replies", "retweets"],
  });

  if (tweets.length < 5) {
    console.error("Not enough tweets for timing analysis (need at least 5).");
    return;
  }

  console.error(`Analyzing timing for ${tweets.length} tweets...\n`);

  // Group by hour and day
  const hourSlots = new Map<number, { rates: number[]; count: number }>();
  const daySlots = new Map<number, { rates: number[]; count: number }>();
  const gridSlots = new Map<string, { rates: number[]; count: number }>();

  for (const t of tweets) {
    const hour = getHour(t.created_at);
    const day = getDayIndex(t.created_at);
    const key = `${day}-${hour}`;

    const hSlot = hourSlots.get(hour) || { rates: [], count: 0 };
    hSlot.rates.push(t.engagement_rate);
    hSlot.count++;
    hourSlots.set(hour, hSlot);

    const dSlot = daySlots.get(day) || { rates: [], count: 0 };
    dSlot.rates.push(t.engagement_rate);
    dSlot.count++;
    daySlots.set(day, dSlot);

    const gSlot = gridSlots.get(key) || { rates: [], count: 0 };
    gSlot.rates.push(t.engagement_rate);
    gSlot.count++;
    gridSlots.set(key, gSlot);
  }

  // Calculate averages
  const hourAvg = new Map<number, number>();
  for (const [h, data] of hourSlots) {
    hourAvg.set(h, data.rates.reduce((s, r) => s + r, 0) / data.rates.length);
  }

  const dayAvg = new Map<number, number>();
  for (const [d, data] of daySlots) {
    dayAvg.set(d, data.rates.reduce((s, r) => s + r, 0) / data.rates.length);
  }

  // Find top 3 windows
  const windows: { day: number; hour: number; avg: number; count: number }[] = [];
  for (const [key, data] of gridSlots) {
    const [d, h] = key.split("-").map(Number);
    const avg = data.rates.reduce((s, r) => s + r, 0) / data.rates.length;
    windows.push({ day: d, hour: h, avg, count: data.count });
  }
  windows.sort((a, b) => b.avg - a.avg);
  const top3 = windows.slice(0, 3);

  if (asJson) {
    console.log(JSON.stringify({
      tweet_count: tweets.length,
      by_hour: Object.fromEntries([...hourAvg].sort((a, b) => a[0] - b[0])),
      by_day: Object.fromEntries([...dayAvg].sort((a, b) => a[0] - b[0]).map(([d, v]) => [DAYS[d], v])),
      top_windows: top3.map(w => ({
        day: DAYS[w.day],
        hour: w.hour,
        avg_engagement: w.avg,
        tweet_count: w.count,
      })),
    }, null, 2));
    return;
  }

  // Render heatmap
  const allAvgs = windows.map(w => w.avg);
  const minAvg = Math.min(...allAvgs);
  const maxAvg = Math.max(...allAvgs);

  console.log(bold("Posting Time Heatmap") + "\n");
  console.log("       " + Array.from({ length: 24 }, (_, h) => String(h).padStart(2)).join(" "));
  console.log("       " + "---".repeat(24));

  for (let d = 0; d < 7; d++) {
    let row = `  ${DAYS[d]}  `;
    for (let h = 0; h < 24; h++) {
      const key = `${d}-${h}`;
      const slot = gridSlots.get(key);
      if (slot) {
        const avg = slot.rates.reduce((s, r) => s + r, 0) / slot.rates.length;
        const level = quantize(avg, minAvg, maxAvg);
        row += " " + BLOCKS[level] + " ";
      } else {
        row += " · ";
      }
    }
    console.log(row);
  }

  console.log();
  console.log(`  Legend: · no data  ${BLOCKS[0]} low  ${BLOCKS[1]} medium  ${BLOCKS[2]} high  ${BLOCKS[3]} best`);
  console.log();

  // Top windows
  console.log(bold("Best Posting Windows") + "\n");
  for (let j = 0; j < top3.length; j++) {
    const w = top3[j];
    const pct = (w.avg * 100).toFixed(2);
    console.log(`  ${cyan(String(j + 1))}. ${green(DAYS[w.day])} ${yellow(String(w.hour) + ":00")} — ${yellow(pct + "%")} avg engagement (${w.count} tweets)`);
  }

  // By day summary
  console.log();
  console.log(bold("By Day") + "\n");
  const sortedDays = [...dayAvg].sort((a, b) => b[1] - a[1]);
  for (const [d, avg] of sortedDays) {
    const count = daySlots.get(d)?.count || 0;
    const bar = "█".repeat(Math.min(Math.round(avg * 500), 30));
    console.log(`  ${DAYS[d]}  ${bar} ${yellow((avg * 100).toFixed(2) + "%")} (${count} tweets)`);
  }
}

function printHelp(): void {
  console.log(`
Usage: xint timing [options]

Analyze when your tweets perform best with an engagement heatmap.

Options:
  --since <dur>    Time period (default: 30d)
  --pages <N>      Pages of tweets to fetch (default: 5, max 10)
  --json           Output as JSON

Examples:
  xint timing                   # Heatmap for last 30 days
  xint timing --since 90d       # Last 90 days
  xint timing --json            # JSON output
`);
}
