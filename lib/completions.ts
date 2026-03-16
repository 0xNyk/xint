/**
 * lib/completions.ts — Shell completion generation for bash, zsh, and fish.
 */

const COMMANDS = [
  "search", "thread", "profile", "tweet", "article",
  "tui", "bookmarks", "likes", "like", "unlike",
  "following", "follow", "unfollow", "media",
  "stream", "stream-rules", "lists", "blocks", "mutes",
  "reposts", "users",
  "bookmark", "unbookmark", "trends", "analyze",
  "costs", "billing", "health", "auth",
  "watchlist", "cache", "watch", "diff",
  "report", "ai-search", "collections", "mcp",
  "package-api-server", "capabilities", "completions",
];

function bashCompletions(): string {
  const words = COMMANDS.join(" ");
  return `# xint bash completions
# Add to ~/.bashrc: eval "$(xint completions bash)"
_xint_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=($(compgen -W "${words}" -- "\$cur"))
}
complete -F _xint_completions xint
`;
}

function zshCompletions(): string {
  const words = COMMANDS.map(c => `'${c}'`).join(" ");
  return `# xint zsh completions
# Add to ~/.zshrc: eval "$(xint completions zsh)"
_xint() {
  local -a commands
  commands=(${words})
  _describe 'command' commands
}
compdef _xint xint
`;
}

function fishCompletions(): string {
  const lines = COMMANDS.map(c => `complete -c xint -n "__fish_use_subcommand" -a "${c}"`);
  return `# xint fish completions
# Save to ~/.config/fish/completions/xint.fish
${lines.join("\n")}
`;
}

export function cmdCompletions(args: string[]): void {
  const shell = (args[0] || "").toLowerCase();

  switch (shell) {
    case "bash":
      console.log(bashCompletions());
      return;
    case "zsh":
      console.log(zshCompletions());
      return;
    case "fish":
      console.log(fishCompletions());
      return;
    default:
      console.log(`Usage: xint completions <shell>

Generate shell completions for xint.

Shells:
  bash    Bash completions (eval "$(xint completions bash)")
  zsh     Zsh completions (eval "$(xint completions zsh)")
  fish    Fish completions (xint completions fish > ~/.config/fish/completions/xint.fish)`);
  }
}
