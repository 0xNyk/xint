export type ActionResultType =
  | "success"
  | "error"
  | "confirm"
  | "choice"
  | "input"
  | "info"
  | "progress"
  | "navigation";

export type ActionOption = {
  id: string;
  label: string;
  description?: string;
  danger?: boolean;
  default?: boolean;
};

export type ActionResult = {
  type: ActionResultType;
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  options?: ActionOption[];
  placeholder?: string;
  defaultValue?: string;
  progress?: number;
  targetPaneId?: string;
  data?: unknown;
  dismissable?: boolean;
};

export type InteractiveAction = {
  key: string;
  label: string;
  aliases: string[];
  hint: string;
  summary: string;
  example: string;
  costHint: string;
};

export const INTERACTIVE_ACTIONS: InteractiveAction[] = [
  {
    key: "1",
    label: "Search",
    aliases: ["search", "s"],
    hint: "keyword, topic, or boolean query",
    summary: "Discover relevant posts with ranked result quality.",
    example: 'xint search "open-source ai agents"',
    costHint: "Low-medium (depends on query depth)",
  },
  {
    key: "2",
    label: "Trends",
    aliases: ["trends", "trend", "t"],
    hint: "location name or blank for global",
    summary: "Surface current trend clusters globally or by location.",
    example: 'xint trends "San Francisco"',
    costHint: "Low",
  },
  {
    key: "3",
    label: "Profile",
    aliases: ["profile", "user", "p"],
    hint: "username (without @)",
    summary: "Inspect profile metadata and recent activity context.",
    example: "xint profile 0xNyk",
    costHint: "Low",
  },
  {
    key: "4",
    label: "Thread",
    aliases: ["thread", "th"],
    hint: "tweet id or tweet url",
    summary: "Expand a tweet into threaded conversation context.",
    example: "xint thread https://x.com/.../status/...",
    costHint: "Medium",
  },
  {
    key: "5",
    label: "Article",
    aliases: ["article", "a"],
    hint: "article url or tweet url",
    summary: "Fetch article content from URL or tweet-linked article.",
    example: "xint article https://x.com/.../status/...",
    costHint: "Medium-high (fetch + parse)",
  },
  {
    key: "6",
    label: "Help",
    aliases: ["help", "h", "?"],
    hint: "show full CLI help",
    summary: "Display full command reference and flags.",
    example: "xint --help",
    costHint: "None",
  },
  {
    key: "0",
    label: "Exit",
    aliases: ["exit", "quit", "q"],
    hint: "close interactive mode",
    summary: "Exit interactive dashboard.",
    example: "q",
    costHint: "None",
  },
];

export function findInteractiveAction(value: string): InteractiveAction | undefined {
  return INTERACTIVE_ACTIONS.find((action) => action.key === value);
}

export function normalizeInteractiveChoice(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim().toLowerCase();
  if (!value) return "";

  const byKey = INTERACTIVE_ACTIONS.find((action) => action.key === value);
  if (byKey) return byKey.key;

  const byAlias = INTERACTIVE_ACTIONS.find((action) => action.aliases.includes(value));
  if (byAlias) return byAlias.key;

  return "";
}

export function scoreInteractiveAction(action: InteractiveAction, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;

  let score = 0;
  if (action.key === q) score += 100;
  if (action.label.toLowerCase() === q) score += 90;
  if (action.aliases.includes(q)) score += 80;
  if (action.label.toLowerCase().startsWith(q)) score += 70;
  if (action.aliases.some((alias) => alias.startsWith(q))) score += 60;
  if (action.label.toLowerCase().includes(q)) score += 40;
  if (action.hint.toLowerCase().includes(q)) score += 20;

  return score;
}
