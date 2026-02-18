#!/usr/bin/env bash
# Release Pipeline Script
# Usage: ./scripts/release.sh [version] [options]

set -euo pipefail

REPO_NAME="xint"
REPO_NAME_ALT="xint-rs"
GITHUB_ORG="0xNyk"

PUBLISH_CLAWDHUB=false
PUBLISH_SKILLSH=false
UPDATE_DOCS=false
DRY_RUN=false
ALLOW_DIRTY=false
SKIP_CHECKS=false
FORCE=false
AUTO_NOTES=true

VERSION=""

if [[ -n "${BASH_SOURCE[0]-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PATH_XINT="${REPO_PATH_XINT:-}"
REPO_PATH_XINT_RS="${REPO_PATH_XINT_RS:-}"

usage() {
  cat <<USAGE
Usage:
  ./scripts/release.sh [version] [options]

Version format:
  YYYY.M.D or YYYY.M.D.N

Options:
  --dry-run        Preview release actions without mutating repos
  --ai-skill       Enable ClawdHub and skills.sh publishing
  --docs           Update README/changelog files when present
  --all            Enable --ai-skill and --docs
  --no-auto-notes  Disable GitHub auto-generated release notes
  --allow-dirty    Allow release from repos with uncommitted changes
  --skip-checks    Skip preflight checks (tests/lint/build gates)
  --force          Continue even if preflight checks fail
  -h, --help       Show this help text

Environment variables:
  CHANGELOG_ADDED
  CHANGELOG_CHANGED
  CHANGELOG_FIXED
  CHANGELOG_SECURITY
  TWEET_DRAFT
USAGE
}

log() {
  printf '[release] %s\n' "$*"
}

warn() {
  printf '[release][warn] %s\n' "$*" >&2
}

die() {
  printf '[release][error] %s\n' "$*" >&2
  exit 1
}

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

repo_path() {
  local repo="$1"
  local path
  path="$(resolve_repo_path "$repo")"
  [[ -n "$path" ]] || die "Missing repo directory for '$repo' (checked under $ROOT_DIR and its parent)."
  printf '%s' "$path"
}

resolve_repo_path() {
  local repo="$1"
  local override=""
  local candidate=""

  case "$repo" in
    "$REPO_NAME")
      override="$REPO_PATH_XINT"
      ;;
    "$REPO_NAME_ALT")
      override="$REPO_PATH_XINT_RS"
      ;;
  esac

  if [[ -n "$override" && -d "$override/.git" ]]; then
    (cd "$override" && pwd)
    return
  fi

  # Common layouts:
  # 1) script in xint repo: ROOT_DIR is xint
  # 2) script one level above repos: ROOT_DIR contains xint + xint-rs
  if [[ "$repo" == "$REPO_NAME" && -d "$ROOT_DIR/.git" ]]; then
    candidate="$ROOT_DIR"
  elif [[ -d "$ROOT_DIR/$repo/.git" ]]; then
    candidate="$ROOT_DIR/$repo"
  elif [[ -d "$ROOT_DIR/../$repo/.git" ]]; then
    candidate="$ROOT_DIR/../$repo"
  fi

  if [[ -n "$candidate" ]]; then
    (cd "$candidate" && pwd)
  fi
  return 0
}

repo_exists() {
  local repo="$1"
  [[ -n "$(resolve_repo_path "$repo")" ]]
}

run_in_repo() {
  local repo="$1"
  shift
  local path
  path="$(repo_path "$repo")"
  (cd "$path" && "$@")
}

run_mutation_in_repo() {
  local repo="$1"
  shift
  local path
  path="$(repo_path "$repo")"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] (cd %q && ' "$path"
    printf '%q ' "$@"
    printf ')\n'
  else
    (cd "$path" && "$@")
  fi
}

is_clean_repo() {
  local repo="$1"
  local path
  path="$(repo_path "$repo")"

  git -C "$path" diff --quiet --ignore-submodules -- && \
    git -C "$path" diff --cached --quiet --ignore-submodules -- && \
    [[ -z "$(git -C "$path" ls-files --others --exclude-standard)" ]]
}

has_package_script() {
  local repo="$1"
  local script_name="$2"
  local path
  path="$(repo_path "$repo")"

  [[ -f "$path/package.json" ]] || return 1

  if command -v jq >/dev/null 2>&1; then
    jq -e --arg script "$script_name" '.scripts[$script] != null' "$path/package.json" >/dev/null
  else
    return 1
  fi
}

run_check() {
  local description="$1"
  shift

  log "Preflight: $description"
  if "$@"; then
    log "Preflight passed: $description"
  else
    if [[ "$FORCE" == "true" ]]; then
      warn "Preflight failed but continuing due to --force: $description"
    else
      die "Preflight failed: $description"
    fi
  fi
}

parse_version_tag() {
  local tag="$1"
  tag="${tag#v}"
  if [[ "$tag" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s' "$tag"
  fi
}

detect_next_version() {
  local today latest latest_norm
  today="$(date +%Y.%-m.%-d)"
  latest=""

  if command -v gh >/dev/null 2>&1; then
    latest="$(gh release list \
      --repo "$GITHUB_ORG/$REPO_NAME" \
      --limit 1 \
      --json tagName \
      --jq '.[0].tagName' 2>/dev/null || true)"
  fi

  latest_norm="$(parse_version_tag "$latest")"

  if [[ -z "$latest_norm" ]]; then
    printf '%s.1' "$today"
    return
  fi

  if [[ "$latest_norm" == "$today" ]]; then
    printf '%s.1' "$today"
    return
  fi

  if [[ "$latest_norm" == "$today".* ]]; then
    local suffix
    suffix="${latest_norm##*.}"
    if [[ "$suffix" =~ ^[0-9]+$ ]]; then
      printf '%s.%s' "$today" "$((suffix + 1))"
      return
    fi
  fi

  printf '%s.1' "$today"
}

update_package_json_version() {
  local repo="$1"
  local path tmp
  path="$(repo_path "$repo")"
  tmp="$path/package.json.release-tmp"

  command -v jq >/dev/null 2>&1 || die "jq is required to update package.json"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would set $repo/package.json version to $VERSION"
    return
  fi

  jq --arg v "$VERSION" '.version = $v' "$path/package.json" > "$tmp"
  mv "$tmp" "$path/package.json"
}

update_cargo_toml_version() {
  local repo="$1"
  local path tmp
  path="$(repo_path "$repo")"
  tmp="$path/Cargo.toml.release-tmp"

  local cargo_version
  cargo_version="$(cargo_semver_version "$VERSION")"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would set $repo/Cargo.toml package version to $cargo_version (from $VERSION tag)"
    return
  fi

  awk -v version="$cargo_version" '
    BEGIN { in_package = 0; replaced = 0 }
    /^\[package\]$/ { in_package = 1; print; next }
    /^\[/ && $0 != "[package]" { in_package = 0 }
    {
      if (in_package && !replaced && $0 ~ /^version[[:space:]]*=[[:space:]]*"/) {
        sub(/^version[[:space:]]*=[[:space:]]*"[^"]+"/, "version = \"" version "\"")
        replaced = 1
      }
      print
    }
    END {
      if (!replaced) {
        exit 2
      }
    }
  ' "$path/Cargo.toml" > "$tmp" || {
    rm -f "$tmp"
    die "Failed to update [package].version in $repo/Cargo.toml"
  }

  mv "$tmp" "$path/Cargo.toml"
}

cargo_semver_version() {
  local raw="$1"
  IFS='.' read -r -a parts <<< "$raw"
  if [[ "${#parts[@]}" -eq 4 ]]; then
    printf '%s.%s.%s-%s' "${parts[0]}" "${parts[1]}" "${parts[2]}" "${parts[3]}"
    return
  fi
  printf '%s' "$raw"
}

update_pyproject_version() {
  local repo="$1"
  local path tmp
  path="$(repo_path "$repo")"
  tmp="$path/pyproject.toml.release-tmp"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would set $repo/pyproject.toml version to $VERSION"
    return
  fi

  awk -v version="$VERSION" '
    BEGIN { replaced = 0 }
    {
      if (!replaced && $0 ~ /^version[[:space:]]*=[[:space:]]*"/) {
        sub(/^version[[:space:]]*=[[:space:]]*"[^"]+"/, "version = \"" version "\"")
        replaced = 1
      }
      print
    }
    END {
      if (!replaced) {
        exit 2
      }
    }
  ' "$path/pyproject.toml" > "$tmp" || {
    rm -f "$tmp"
    die "Failed to update version in $repo/pyproject.toml"
  }

  mv "$tmp" "$path/pyproject.toml"
}

collect_release_files() {
  local repo="$1"
  local -n out_ref="$2"
  local path
  path="$(repo_path "$repo")"

  out_ref=()

  if [[ -f "$path/package.json" ]]; then
    update_package_json_version "$repo"
    out_ref+=("package.json")
  fi

  if [[ -f "$path/Cargo.toml" ]]; then
    update_cargo_toml_version "$repo"
    out_ref+=("Cargo.toml")
    if [[ -f "$path/Cargo.lock" ]]; then
      out_ref+=("Cargo.lock")
    fi
  fi

  if [[ -f "$path/pyproject.toml" ]]; then
    update_pyproject_version "$repo"
    out_ref+=("pyproject.toml")
  fi

  if [[ "$UPDATE_DOCS" == "true" ]]; then
    if [[ -f "$path/README.md" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        log "Would update version references in $repo/README.md"
      else
        perl -i -pe 's/v\d+\.\d+\.\d+(?:\.\d+)?/v'"$VERSION"'/g' "$path/README.md"
      fi
      out_ref+=("README.md")
    fi

    if [[ -f "$path/docs/CHANGELOG.md" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        log "Would append $VERSION entry to $repo/docs/CHANGELOG.md"
      else
        printf '%s - %s\n' "$VERSION" "$(date +%Y-%m-%d)" >> "$path/docs/CHANGELOG.md"
      fi
      out_ref+=("docs/CHANGELOG.md")
    fi
  fi

  if [[ ${#out_ref[@]} -eq 0 ]]; then
    die "No release-manifest files found for $repo"
  fi
}

preflight_repo() {
  local repo="$1"
  local path
  path="$(repo_path "$repo")"

  if [[ ! -d "$path" ]]; then
    return
  fi

  if [[ "$ALLOW_DIRTY" != "true" ]]; then
    run_check "$repo has a clean working tree" is_clean_repo "$repo"
  else
    warn "Skipping clean-tree requirement for $repo (--allow-dirty)"
  fi

  if [[ "$SKIP_CHECKS" == "true" ]]; then
    warn "Skipping tests/lint checks for $repo (--skip-checks)"
    return
  fi

  if [[ -f "$path/package.json" ]]; then
    command -v bun >/dev/null 2>&1 || die "bun is required for JS preflight checks"

    if has_package_script "$repo" "lint"; then
      run_check "$repo lint" run_in_repo "$repo" bun run lint
    else
      warn "No lint script in $repo/package.json; skipping lint"
    fi

    if has_package_script "$repo" "test"; then
      run_check "$repo tests (package script)" run_in_repo "$repo" bun test
    else
      warn "No test script in $repo/package.json; running bun test directly"
      run_check "$repo tests (bun test)" run_in_repo "$repo" bun test
    fi
  fi

  if [[ -f "$path/Cargo.toml" ]]; then
    command -v cargo >/dev/null 2>&1 || die "cargo is required for Rust preflight checks"
    run_check "$repo cargo fmt --check" run_in_repo "$repo" cargo fmt --check
    run_check "$repo cargo clippy -- -D warnings" run_in_repo "$repo" cargo clippy -- -D warnings
    run_check "$repo cargo test" run_in_repo "$repo" cargo test
  fi
}

commit_repo() {
  local repo="$1"
  shift
  local files=("$@")
  local branch

  branch="$(git -C "$(repo_path "$repo")" rev-parse --abbrev-ref HEAD)"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would commit in $repo on branch $branch with files: ${files[*]}"
    return
  fi

  run_in_repo "$repo" git add -- "${files[@]}"

  if run_in_repo "$repo" git diff --cached --quiet; then
    warn "No staged release changes in $repo; skipping commit"
    return
  fi

  run_in_repo "$repo" git commit -m "chore(release): v$VERSION"
}

push_repo() {
  local repo="$1"
  local branch
  branch="$(git -C "$(repo_path "$repo")" rev-parse --abbrev-ref HEAD)"
  run_mutation_in_repo "$repo" git push origin "$branch"
}

publish_clawdhub() {
  local repo="$1"
  if command -v clawdhub >/dev/null 2>&1; then
    run clawdhub publish "$(repo_path "$repo")" --slug "$repo" --version "$VERSION" --changelog "Release v$VERSION"
  else
    warn "clawdhub not found; skipping"
  fi
}

publish_skillsh() {
  local repo="$1"
  if command -v npx >/dev/null 2>&1; then
    run npx skills add "https://github.com/$GITHUB_ORG/$repo" --yes
  else
    warn "npx not found; skipping"
  fi
}

create_github_release() {
  local repo="$1"
  local notes="$2"
  local use_auto_notes="$3"
  local branch

  if ! command -v gh >/dev/null 2>&1; then
    warn "gh not found; skipping GitHub release for $repo"
    return
  fi

  branch="$(git -C "$(repo_path "$repo")" rev-parse --abbrev-ref HEAD)"

  if [[ "$use_auto_notes" == "true" ]]; then
    if [[ -n "$notes" ]]; then
      run gh release create "$VERSION" \
        --title "$repo $VERSION" \
        --generate-notes \
        --notes "$notes" \
        --target "$branch" \
        --repo "$GITHUB_ORG/$repo"
    else
      run gh release create "$VERSION" \
        --title "$repo $VERSION" \
        --generate-notes \
        --target "$branch" \
        --repo "$GITHUB_ORG/$repo"
    fi
  else
    run gh release create "$VERSION" \
      --title "$repo $VERSION" \
      --notes "$notes" \
      --target "$branch" \
      --repo "$GITHUB_ORG/$repo"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    --ai-skill)
      PUBLISH_CLAWDHUB=true
      PUBLISH_SKILLSH=true
      ;;
    --docs)
      UPDATE_DOCS=true
      ;;
    --all)
      PUBLISH_CLAWDHUB=true
      PUBLISH_SKILLSH=true
      UPDATE_DOCS=true
      ;;
    --no-auto-notes)
      AUTO_NOTES=false
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      ;;
    --force)
      FORCE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$VERSION" && "$1" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
        VERSION="$1"
      else
        die "Unknown argument: $1"
      fi
      ;;
  esac
  shift
done

repo_exists "$REPO_NAME" || die "Missing repo directory: $REPO_NAME"
if [[ -n "$REPO_NAME_ALT" ]]; then
  repo_exists "$REPO_NAME_ALT" || die "Missing repo directory: $REPO_NAME_ALT"
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(detect_next_version)"
fi

log "Preparing release version: $VERSION"

preflight_repo "$REPO_NAME"
if [[ -n "$REPO_NAME_ALT" ]]; then
  preflight_repo "$REPO_NAME_ALT"
fi

log "Bumping manifest versions"
declare -a RELEASE_FILES_PRIMARY
declare -a RELEASE_FILES_ALT

collect_release_files "$REPO_NAME" RELEASE_FILES_PRIMARY
if [[ -n "$REPO_NAME_ALT" ]]; then
  collect_release_files "$REPO_NAME_ALT" RELEASE_FILES_ALT
fi

log "Committing release manifests"
commit_repo "$REPO_NAME" "${RELEASE_FILES_PRIMARY[@]}"
if [[ -n "$REPO_NAME_ALT" ]]; then
  commit_repo "$REPO_NAME_ALT" "${RELEASE_FILES_ALT[@]}"
fi

log "Pushing release commits"
push_repo "$REPO_NAME"
if [[ -n "$REPO_NAME_ALT" ]]; then
  push_repo "$REPO_NAME_ALT"
fi

if [[ "$PUBLISH_CLAWDHUB" == "true" ]]; then
  log "Publishing to ClawdHub"
  publish_clawdhub "$REPO_NAME"
  if [[ -n "$REPO_NAME_ALT" ]]; then
    publish_clawdhub "$REPO_NAME_ALT"
  fi
fi

if [[ "$PUBLISH_SKILLSH" == "true" ]]; then
  log "Publishing to skills.sh"
  publish_skillsh "$REPO_NAME"
  if [[ -n "$REPO_NAME_ALT" ]]; then
    publish_skillsh "$REPO_NAME_ALT"
  fi
fi

CUSTOM_NOTES=false
if [[ -n "${CHANGELOG_ADDED:-}" || -n "${CHANGELOG_CHANGED:-}" || -n "${CHANGELOG_FIXED:-}" || -n "${CHANGELOG_SECURITY:-}" ]]; then
  CUSTOM_NOTES=true
fi

CHANGELOG_ADDED="${CHANGELOG_ADDED:-- Add release notes here}"
CHANGELOG_CHANGED="${CHANGELOG_CHANGED:-- Add changed items here}"
CHANGELOG_FIXED="${CHANGELOG_FIXED:-- Fix various bugs and improvements}"
CHANGELOG_SECURITY="${CHANGELOG_SECURITY:-- None}"

USE_AUTO_NOTES=false
if [[ "$AUTO_NOTES" == "true" && "$CUSTOM_NOTES" != "true" ]]; then
  USE_AUTO_NOTES=true
fi

RELEASE_NOTES=""
if [[ "$USE_AUTO_NOTES" != "true" || "$CUSTOM_NOTES" == "true" ]]; then
  RELEASE_NOTES="### Added
$CHANGELOG_ADDED

### Changed
$CHANGELOG_CHANGED

### Fixed
$CHANGELOG_FIXED

### Security
$CHANGELOG_SECURITY"
fi

log "Creating GitHub releases"
create_github_release "$REPO_NAME" "$RELEASE_NOTES" "$USE_AUTO_NOTES"
if [[ -n "$REPO_NAME_ALT" ]]; then
  create_github_release "$REPO_NAME_ALT" "$RELEASE_NOTES" "$USE_AUTO_NOTES"
fi

if [[ -z "${TWEET_DRAFT:-}" ]]; then
  if [[ "$USE_AUTO_NOTES" == "true" ]]; then
    TWEET_DRAFT="xint $VERSION is available.

See GitHub release notes for details."
  else
    TWEET_DRAFT="xint $VERSION is available.

$CHANGELOG_CHANGED"
  fi
fi

cat <<EOF_BANNER

==============================
Tweet draft
==============================
$TWEET_DRAFT

==============================
EOF_BANNER

log "Release pipeline complete"
