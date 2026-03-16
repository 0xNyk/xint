import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { loadTokens } from "./oauth";
import { bold, cyan, yellow, dim, green, red } from "./format";

const SKILL_DIR = import.meta.dir;
const SNAPSHOTS_DIR = join(SKILL_DIR, "..", "data", "snapshots");

interface SnapshotSummary {
  timestamp: string;
  count: number;
}

function loadSnapshots(username: string): SnapshotSummary[] {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  const prefix = `${username.toLowerCase()}-followers-`;
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();

  const snapshots: SnapshotSummary[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), "utf-8"));
      snapshots.push({ timestamp: data.timestamp, count: data.count });
    } catch {}
  }
  return snapshots;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function nextMilestone(current: number): number {
  const milestones = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  for (const m of milestones) {
    if (m > current) return m;
  }
  // Round up to next 500K
  return Math.ceil(current / 500000) * 500000 + 500000;
}

export async function cmdGrowth(args: string[]): Promise<void> {
  let showHistory = false;
  let showVelocity = false;
  let asJson = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--history":
        showHistory = true;
        break;
      case "--velocity":
        showVelocity = true;
        break;
      case "--json":
        asJson = true;
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

  const tokens = loadTokens();
  if (!tokens?.username) {
    console.error("OAuth required. Run 'xint auth setup' first.");
    process.exit(1);
    return;
  }

  const snapshots = loadSnapshots(tokens.username);
  if (snapshots.length === 0) {
    console.error(`No follower snapshots found for @${tokens.username}.`);
    console.error(`Run 'xint diff @${tokens.username}' to create your first snapshot.`);
    return;
  }

  const latest = snapshots[snapshots.length - 1];
  const oldest = snapshots[0];

  // Calculate velocity
  const daysBetween = (new Date(latest.timestamp).getTime() - new Date(oldest.timestamp).getTime()) / 86_400_000;
  const totalGrowth = latest.count - oldest.count;
  const dailyVelocity = daysBetween > 0 ? totalGrowth / daysBetween : 0;
  const weeklyVelocity = dailyVelocity * 7;

  // Trend direction: compare recent half vs older half
  let trend = "stable";
  if (snapshots.length >= 4) {
    const mid = Math.floor(snapshots.length / 2);
    const olderHalf = snapshots.slice(0, mid);
    const recentHalf = snapshots.slice(mid);
    const olderDays = (new Date(olderHalf[olderHalf.length - 1].timestamp).getTime() - new Date(olderHalf[0].timestamp).getTime()) / 86_400_000;
    const recentDays = (new Date(recentHalf[recentHalf.length - 1].timestamp).getTime() - new Date(recentHalf[0].timestamp).getTime()) / 86_400_000;
    const olderVelocity = olderDays > 0 ? (olderHalf[olderHalf.length - 1].count - olderHalf[0].count) / olderDays : 0;
    const recentVelocity = recentDays > 0 ? (recentHalf[recentHalf.length - 1].count - recentHalf[0].count) / recentDays : 0;
    if (recentVelocity > olderVelocity * 1.2) trend = "accelerating";
    else if (recentVelocity < olderVelocity * 0.8) trend = "decelerating";
  }

  // Milestone prediction
  const milestone = nextMilestone(latest.count);
  const remaining = milestone - latest.count;
  const daysToMilestone = dailyVelocity > 0 ? remaining / dailyVelocity : Infinity;

  if (asJson) {
    console.log(JSON.stringify({
      username: tokens.username,
      current_followers: latest.count,
      snapshots: snapshots.length,
      period_days: Math.round(daysBetween),
      total_growth: totalGrowth,
      daily_velocity: Math.round(dailyVelocity * 100) / 100,
      weekly_velocity: Math.round(weeklyVelocity * 100) / 100,
      trend,
      next_milestone: milestone,
      days_to_milestone: daysToMilestone === Infinity ? null : Math.round(daysToMilestone),
      history: showHistory ? snapshots : undefined,
    }, null, 2));
    return;
  }

  console.log(bold(`Growth Report: @${tokens.username}`) + "\n");
  console.log(`  Current followers:  ${cyan(fmtNum(latest.count))}`);
  console.log(`  Snapshots:          ${dim(String(snapshots.length))} over ${dim(Math.round(daysBetween) + "d")}`);
  console.log(`  Net growth:         ${totalGrowth >= 0 ? green("+" + fmtNum(totalGrowth)) : red(String(totalGrowth))}`);
  console.log();
  console.log(bold("Velocity"));
  console.log(`  Daily:   ${yellow(dailyVelocity.toFixed(1))} followers/day`);
  console.log(`  Weekly:  ${yellow(weeklyVelocity.toFixed(1))} followers/week`);
  console.log(`  Trend:   ${trend === "accelerating" ? green(trend) : trend === "decelerating" ? red(trend) : dim(trend)}`);
  console.log();
  console.log(bold("Milestones"));
  console.log(`  Next:    ${cyan(fmtNum(milestone))} (${remaining} to go)`);
  if (daysToMilestone !== Infinity && daysToMilestone > 0) {
    console.log(`  ETA:     ${yellow(Math.round(daysToMilestone) + " days")} at current pace`);
  } else {
    console.log(`  ETA:     ${dim("insufficient data")}`);
  }

  if (showHistory || showVelocity) {
    console.log();
    console.log(bold("History"));
    for (const s of snapshots) {
      console.log(`  ${dim(s.timestamp.slice(0, 10))}  ${fmtNum(s.count)} followers`);
    }
  }
}

function printHelp(): void {
  console.log(`
Usage: xint growth [options]

Analyze your follower growth using saved snapshots.

Options:
  --history      Show all snapshot history
  --velocity     Show velocity details
  --json         Output as JSON

Requires follower snapshots. Create them with:
  xint diff @yourusername

Examples:
  xint growth                # Growth summary
  xint growth --history      # With full snapshot history
  xint growth --json         # JSON output
`);
}
