#!/usr/bin/env bash
# Release Pipeline Script
# Usage: ./scripts/release.sh [version] [options]

set -euo pipefail

REPO_NAME="xint"
REPO_NAME_ALT="xint-rs"
REPO_NAME_CLOUD="xint-cloud"
GITHUB_ORG="0xNyk"

PUBLISH_CLAWDHUB=true
PUBLISH_SKILLSH=false
PUBLISH_HOMEBREW=true
UPDATE_DOCS=false
DRY_RUN=false
ALLOW_DIRTY=false
SKIP_CHECKS=false
FORCE=false
AUTO_NOTES=true
GENERATE_REPORT=true
UPLOAD_REPORT_ASSET=true
EMBED_REPORT_BODY=true

VERSION=""
GENERATED_REPORT_FILE=""

if [[ -n "${BASH_SOURCE[0]-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PATH_XINT="${REPO_PATH_XINT:-}"
REPO_PATH_XINT_RS="${REPO_PATH_XINT_RS:-}"
REPO_PATH_XINT_CLOUD="${REPO_PATH_XINT_CLOUD:-}"
REPO_PATH_HOMEBREW="${REPO_PATH_HOMEBREW:-}"
HOMEBREW_TAP_REPO="homebrew-xint"
REPORT_DIR="${RELEASE_REPORT_DIR:-$ROOT_DIR/reports/releases}"

usage() {
  cat <<USAGE
Usage:
  ./scripts/release.sh [version] [options]

Version format:
  YYYY.M.D or YYYY.M.D.N

Options:
  --dry-run        Preview release actions without mutating repos
  --ai-skill       Enable both ClawdHub and skills.sh publishing
  --no-clawdhub    Disable ClawdHub publishing for this run
  --skillsh        Enable skills.sh publishing
  --no-homebrew    Disable Homebrew tap formula update/publish
  --docs           Update README/changelog files when present
  --all            Enable --ai-skill and --docs
  --no-auto-notes  Disable GitHub auto-generated release notes
  --no-report      Disable release report generation
  --report-dir     Override output directory for release report markdown
  --no-report-asset  Do not upload report markdown to GitHub release assets
  --no-report-body  Do not embed report markdown in GitHub release body
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
  RELEASE_REPORT_DIR
  REPO_PATH_XINT
  REPO_PATH_XINT_RS
  REPO_PATH_XINT_CLOUD
  REPO_PATH_HOMEBREW
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
    "$REPO_NAME_CLOUD")
      override="$REPO_PATH_XINT_CLOUD"
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

resolve_homebrew_path() {
  local candidate=""

  if [[ -n "$REPO_PATH_HOMEBREW" && -d "$REPO_PATH_HOMEBREW/.git" ]]; then
    (cd "$REPO_PATH_HOMEBREW" && pwd)
    return
  fi

  if [[ -d "$ROOT_DIR/$HOMEBREW_TAP_REPO/.git" ]]; then
    candidate="$ROOT_DIR/$HOMEBREW_TAP_REPO"
  elif [[ -d "$ROOT_DIR/../$HOMEBREW_TAP_REPO/.git" ]]; then
    candidate="$ROOT_DIR/../$HOMEBREW_TAP_REPO"
  fi

  if [[ -n "$candidate" ]]; then
    (cd "$candidate" && pwd)
  fi
  return 0
}

homebrew_path() {
  local path
  path="$(resolve_homebrew_path)"
  [[ -n "$path" ]] || die "Missing Homebrew tap directory '$HOMEBREW_TAP_REPO' (set REPO_PATH_HOMEBREW to override)."
  printf '%s' "$path"
}

homebrew_repo_exists() {
  [[ -n "$(resolve_homebrew_path)" ]]
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

find_previous_release_tag() {
  local repo="$1"
  local current_version="$2"
  local path tag norm
  path="$(repo_path "$repo")"

  while IFS= read -r tag; do
    norm="$(parse_version_tag "$tag")"
    [[ -n "$norm" ]] || continue
    [[ "$norm" == "$current_version" ]] && continue
    printf '%s' "$tag"
    return
  done < <(git -C "$path" tag --sort=-version:refname)
}

release_url_for_repo() {
  local repo="$1"
  local fallback
  fallback="https://github.com/$GITHUB_ORG/$repo/releases/tag/$VERSION"

  if [[ "$DRY_RUN" == "true" || ! -x "$(command -v gh || true)" ]]; then
    printf '%s' "$fallback"
    return
  fi

  gh release view "$VERSION" \
    --repo "$GITHUB_ORG/$repo" \
    --json url \
    --jq '.url' 2>/dev/null || printf '%s' "$fallback"
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

sync_cargo_lock() {
  local repo="$1"
  local path
  path="$(repo_path "$repo")"

  if [[ ! -f "$path/Cargo.toml" || ! -f "$path/Cargo.lock" ]]; then
    return
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would sync $repo/Cargo.lock via cargo check"
    return
  fi

  command -v cargo >/dev/null 2>&1 || die "cargo is required to sync Cargo.lock for $repo"
  run_in_repo "$repo" cargo check --quiet >/dev/null
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
    sync_cargo_lock "$repo"
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
  local claw_version
  local source_path
  local publish_path
  local temp_dir=""
  claw_version="$(cargo_semver_version "$VERSION")"
  source_path="$(repo_path "$repo")"
  publish_path="$source_path"

  # Publish from a temporary export to avoid tool-side mutations (e.g. Cargo.lock rewrites).
  if [[ "$DRY_RUN" != "true" ]]; then
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/xint-clawdhub-$repo-XXXXXX")"
    if git -C "$source_path" archive --format=tar HEAD | tar -xf - -C "$temp_dir"; then
      publish_path="$temp_dir"
    else
      warn "Failed to create temp export for $repo; falling back to live repo path"
      publish_path="$source_path"
    fi
  fi

  if command -v clawdhub >/dev/null 2>&1; then
    if ! run clawdhub publish "$publish_path" --slug "$repo" --version "$claw_version" --changelog "Release v$VERSION"; then
      warn "ClawdHub publish failed for $repo; continuing release pipeline"
    fi
  else
    warn "clawdhub not found; skipping"
  fi

  if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then
    rm -rf "$temp_dir"
  fi
}

publish_skillsh() {
  local repo="$1"
  local npm_cache
  npm_cache="${NPM_CONFIG_CACHE:-${npm_config_cache:-${TMPDIR:-/tmp}/xint-npm-cache}}"

  if command -v npx >/dev/null 2>&1; then
    if [[ "$DRY_RUN" == "true" ]]; then
      run npx skills add "https://github.com/$GITHUB_ORG/$repo" --yes
      return
    fi

    mkdir -p "$npm_cache"
    if ! env npm_config_cache="$npm_cache" npx skills add "https://github.com/$GITHUB_ORG/$repo" --yes; then
      warn "skills.sh publish failed for $repo; continuing release pipeline"
    fi
  else
    warn "npx not found; skipping"
  fi
}

sha256_for_url() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"

  if ! curl -fsSL "$url" -o "$tmp"; then
    rm -f "$tmp"
    return 1
  fi

  shasum -a 256 "$tmp" | awk '{print $1}'
  rm -f "$tmp"
}

update_homebrew_formula_file() {
  local formula_file="$1"
  local mac_sha="$2"
  local source_sha="$3"
  local tmp_file
  tmp_file="$formula_file.release-tmp"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would update Homebrew formula: $formula_file"
    return
  fi

  perl -0pi -e 's#releases/download/\d+\.\d+\.\d+(?:\.\d+)?/xint-rs-macos-arm64-\d+\.\d+\.\d+(?:\.\d+)?\.tar\.gz#releases/download/'"$VERSION"'/xint-rs-macos-arm64-'"$VERSION"'.tar.gz#g' "$formula_file"
  perl -0pi -e 's#archive/refs/tags/\d+\.\d+\.\d+(?:\.\d+)?\.tar\.gz#archive/refs/tags/'"$VERSION"'.tar.gz#g' "$formula_file"

  awk -v mac="$mac_sha" -v src="$source_sha" '
    BEGIN { sha_count = 0 }
    /^[[:space:]]*sha256[[:space:]]*"/ {
      sha_count++
      if (sha_count == 1) {
        sub(/sha256[[:space:]]*"[^"]+"/, "sha256 \"" mac "\"")
      } else if (sha_count == 2) {
        sub(/sha256[[:space:]]*"[^"]+"/, "sha256 \"" src "\"")
      }
    }
    { print }
    END {
      if (sha_count < 2) {
        exit 2
      }
    }
  ' "$formula_file" > "$tmp_file" || {
    rm -f "$tmp_file"
    die "Failed updating sha256 entries in $formula_file"
  }

  mv "$tmp_file" "$formula_file"
}

publish_homebrew_tap() {
  local tap_path formula_xint formula_xint_rs
  local binary_url source_url binary_sha source_sha

  if [[ "$PUBLISH_HOMEBREW" != "true" ]]; then
    return
  fi

  if ! homebrew_repo_exists; then
    warn "Homebrew tap repo '$HOMEBREW_TAP_REPO' not found; skipping formula publish"
    return
  fi

  if [[ "$DRY_RUN" != "true" ]]; then
    command -v curl >/dev/null 2>&1 || die "curl is required to update Homebrew formulas"
    command -v shasum >/dev/null 2>&1 || die "shasum is required to update Homebrew formulas"
  fi

  tap_path="$(homebrew_path)"
  formula_xint="$tap_path/Formula/xint.rb"
  formula_xint_rs="$tap_path/Formula/xint-rs.rb"

  [[ -f "$formula_xint" ]] || die "Missing formula: $formula_xint"
  [[ -f "$formula_xint_rs" ]] || die "Missing formula: $formula_xint_rs"

  if [[ "$ALLOW_DIRTY" != "true" ]]; then
    git -C "$tap_path" diff --quiet --ignore-submodules -- && \
      git -C "$tap_path" diff --cached --quiet --ignore-submodules -- && \
      [[ -z "$(git -C "$tap_path" ls-files --others --exclude-standard)" ]] || \
      die "Homebrew tap repo is dirty; use --allow-dirty or clean $tap_path first"
  fi

  binary_url="https://github.com/$GITHUB_ORG/$REPO_NAME_ALT/releases/download/$VERSION/xint-rs-macos-arm64-$VERSION.tar.gz"
  source_url="https://github.com/$GITHUB_ORG/$REPO_NAME_ALT/archive/refs/tags/$VERSION.tar.gz"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would compute Homebrew SHA256 for:"
    log "- $binary_url"
    log "- $source_url"
    binary_sha="<dry-run-binary-sha256>"
    source_sha="<dry-run-source-sha256>"
  else
    log "Computing Homebrew SHA256 for release artifacts"
    binary_sha="$(sha256_for_url "$binary_url")" || die "Failed to download/hash binary artifact: $binary_url"
    source_sha="$(sha256_for_url "$source_url")" || die "Failed to download/hash source artifact: $source_url"
  fi

  update_homebrew_formula_file "$formula_xint" "$binary_sha" "$source_sha"
  update_homebrew_formula_file "$formula_xint_rs" "$binary_sha" "$source_sha"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would commit and push Homebrew tap formula updates in $tap_path"
    return
  fi

  git -C "$tap_path" add -- Formula/xint.rb Formula/xint-rs.rb
  if git -C "$tap_path" diff --cached --quiet; then
    warn "No Homebrew formula changes detected; skipping tap commit"
    return
  fi

  git -C "$tap_path" commit -m "chore(release): bump formulas to v$VERSION"
  git -C "$tap_path" push origin HEAD
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

upload_release_report_asset() {
  local repo="$1"
  local report_file="$2"

  if [[ "$UPLOAD_REPORT_ASSET" != "true" || "$GENERATE_REPORT" != "true" ]]; then
    return
  fi

  if [[ -z "$report_file" ]]; then
    return
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would upload release report asset for $repo: $report_file"
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    warn "gh not found; skipping report asset upload for $repo"
    return
  fi

  run gh release upload "$VERSION" "$report_file" --clobber --repo "$GITHUB_ORG/$repo"
}

embed_release_report_in_body() {
  local repo="$1"
  local report_file="$2"
  local start_marker end_marker current_body cleaned_body new_body tmp
  start_marker="<!-- xint-release-report:start -->"
  end_marker="<!-- xint-release-report:end -->"

  if [[ "$EMBED_REPORT_BODY" != "true" || "$GENERATE_REPORT" != "true" ]]; then
    return
  fi

  if [[ -z "$report_file" ]]; then
    return
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Would embed release report in body for $repo from $report_file"
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    warn "gh not found; skipping release body report embed for $repo"
    return
  fi

  current_body="$(gh release view "$VERSION" --repo "$GITHUB_ORG/$repo" --json body --jq '.body' 2>/dev/null || true)"
  cleaned_body="$(printf '%s\n' "$current_body" | awk -v start="$start_marker" -v end="$end_marker" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ')"

  new_body="$cleaned_body

$start_marker
## Detailed Release Report

<details>
<summary>Expand full report</summary>

$(cat "$report_file")

</details>
$end_marker
"

  tmp="$(mktemp)"
  printf '%s\n' "$new_body" > "$tmp"
  run gh release edit "$VERSION" --repo "$GITHUB_ORG/$repo" --notes-file "$tmp"
  rm -f "$tmp"
}

repo_commit_lines_md() {
  local repo="$1"
  local range="$2"
  local path lines
  path="$(repo_path "$repo")"
  lines="$(git -C "$path" log --no-merges --pretty='- `%h` %s (%an)' "$range" 2>/dev/null || true)"
  if [[ -z "$lines" ]]; then
    printf '%s' "- No commits in range"
    return
  fi
  printf '%s' "$lines"
}

repo_file_changes_md() {
  local repo="$1"
  local previous_tag="$2"
  local head_ref="$3"
  local path raw
  path="$(repo_path "$repo")"

  if [[ -n "$previous_tag" ]]; then
    raw="$(git -C "$path" diff --name-status "$previous_tag" "$head_ref" 2>/dev/null || true)"
  else
    raw="$(git -C "$path" show --name-status --pretty='' "$head_ref" 2>/dev/null || true)"
  fi

  if [[ -z "$raw" ]]; then
    printf '%s' "- No file changes detected"
    return
  fi

  printf '%s\n' "$raw" | awk 'NF { printf("- `%s`\n", $0) }'
}

append_repo_release_section() {
  local report_file="$1"
  local repo="$2"
  local previous_tag="$3"
  local release_url="$4"
  local path head_sha head_short branch range commit_count compare_url commits_md files_md
  path="$(repo_path "$repo")"
  head_sha="$(git -C "$path" rev-parse HEAD)"
  head_short="$(git -C "$path" rev-parse --short HEAD)"
  branch="$(git -C "$path" rev-parse --abbrev-ref HEAD)"

  if [[ -n "$previous_tag" ]]; then
    range="${previous_tag}..${head_sha}"
    compare_url="https://github.com/$GITHUB_ORG/$repo/compare/${previous_tag}...$VERSION"
  else
    range="$head_sha"
    compare_url=""
  fi

  commit_count="$(git -C "$path" rev-list --count "$range" 2>/dev/null || printf '0')"
  commits_md="$(repo_commit_lines_md "$repo" "$range")"
  files_md="$(repo_file_changes_md "$repo" "$previous_tag" "$head_sha")"

  cat >> "$report_file" <<EOF
## $repo
- Release URL: $release_url
- Branch: \`$branch\`
- Head commit: \`$head_short\`
- Previous tag: \`${previous_tag:-none}\`
- Commit range: \`$range\`
- Compare: ${compare_url:-n/a}
- Commit count: $commit_count

### Commits
$commits_md

### File Changes
$files_md

EOF
}

generate_release_report() {
  local previous_tag_primary="$1"
  local previous_tag_alt="$2"
  local previous_tag_cloud="$3"
  local release_url_primary="$4"
  local release_url_alt="$5"
  local release_url_cloud="$6"
  local report_file
  report_file="$REPORT_DIR/$VERSION.md"
  GENERATED_REPORT_FILE=""

  if [[ "$GENERATE_REPORT" != "true" ]]; then
    return
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    GENERATED_REPORT_FILE="$report_file"
    log "Would generate release report at $report_file"
    return
  fi

  mkdir -p "$REPORT_DIR"

  cat > "$report_file" <<EOF
# Release Report: $VERSION

- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Organization: $GITHUB_ORG
- Auto notes: $USE_AUTO_NOTES
- Custom notes supplied: $CUSTOM_NOTES
- ClawdHub publish: $PUBLISH_CLAWDHUB
- skills.sh publish: $PUBLISH_SKILLSH

EOF

  append_repo_release_section "$report_file" "$REPO_NAME" "$previous_tag_primary" "$release_url_primary"
  if [[ -n "$REPO_NAME_ALT" ]]; then
    append_repo_release_section "$report_file" "$REPO_NAME_ALT" "$previous_tag_alt" "$release_url_alt"
  fi
  if [[ -n "$REPO_NAME_CLOUD" ]]; then
    append_repo_release_section "$report_file" "$REPO_NAME_CLOUD" "$previous_tag_cloud" "$release_url_cloud"
  fi

  GENERATED_REPORT_FILE="$report_file"
  log "Release report generated: $report_file"
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
    --no-clawdhub)
      PUBLISH_CLAWDHUB=false
      ;;
    --skillsh)
      PUBLISH_SKILLSH=true
      ;;
    --no-homebrew)
      PUBLISH_HOMEBREW=false
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
    --no-report)
      GENERATE_REPORT=false
      ;;
    --no-report-asset)
      UPLOAD_REPORT_ASSET=false
      ;;
    --no-report-body)
      EMBED_REPORT_BODY=false
      ;;
    --report-dir)
      shift
      [[ $# -gt 0 ]] || die "--report-dir requires a path"
      REPORT_DIR="$1"
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
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  repo_exists "$REPO_NAME_CLOUD" || die "Missing repo directory: $REPO_NAME_CLOUD"
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(detect_next_version)"
fi

log "Preparing release version: $VERSION"

PREVIOUS_TAG_PRIMARY="$(find_previous_release_tag "$REPO_NAME" "$VERSION")"
PREVIOUS_TAG_ALT=""
PREVIOUS_TAG_CLOUD=""
if [[ -n "$REPO_NAME_ALT" ]]; then
  PREVIOUS_TAG_ALT="$(find_previous_release_tag "$REPO_NAME_ALT" "$VERSION")"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  PREVIOUS_TAG_CLOUD="$(find_previous_release_tag "$REPO_NAME_CLOUD" "$VERSION")"
fi

preflight_repo "$REPO_NAME"
if [[ -n "$REPO_NAME_ALT" ]]; then
  preflight_repo "$REPO_NAME_ALT"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  preflight_repo "$REPO_NAME_CLOUD"
fi

log "Bumping manifest versions"
declare -a RELEASE_FILES_PRIMARY
declare -a RELEASE_FILES_ALT
declare -a RELEASE_FILES_CLOUD

collect_release_files "$REPO_NAME" RELEASE_FILES_PRIMARY
if [[ -n "$REPO_NAME_ALT" ]]; then
  collect_release_files "$REPO_NAME_ALT" RELEASE_FILES_ALT
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  collect_release_files "$REPO_NAME_CLOUD" RELEASE_FILES_CLOUD
fi

log "Committing release manifests"
commit_repo "$REPO_NAME" "${RELEASE_FILES_PRIMARY[@]}"
if [[ -n "$REPO_NAME_ALT" ]]; then
  commit_repo "$REPO_NAME_ALT" "${RELEASE_FILES_ALT[@]}"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  commit_repo "$REPO_NAME_CLOUD" "${RELEASE_FILES_CLOUD[@]}"
fi

log "Pushing release commits"
push_repo "$REPO_NAME"
if [[ -n "$REPO_NAME_ALT" ]]; then
  push_repo "$REPO_NAME_ALT"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  push_repo "$REPO_NAME_CLOUD"
fi

if [[ "$PUBLISH_CLAWDHUB" == "true" ]]; then
  log "Publishing to ClawdHub"
  publish_clawdhub "$REPO_NAME"
  if [[ -n "$REPO_NAME_ALT" ]]; then
    publish_clawdhub "$REPO_NAME_ALT"
  fi
  if [[ -n "$REPO_NAME_CLOUD" ]]; then
    publish_clawdhub "$REPO_NAME_CLOUD"
  fi
fi

if [[ "$PUBLISH_SKILLSH" == "true" ]]; then
  log "Publishing to skills.sh"
  publish_skillsh "$REPO_NAME"
  if [[ -n "$REPO_NAME_ALT" ]]; then
    publish_skillsh "$REPO_NAME_ALT"
  fi
  if [[ -n "$REPO_NAME_CLOUD" ]]; then
    publish_skillsh "$REPO_NAME_CLOUD"
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
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  create_github_release "$REPO_NAME_CLOUD" "$RELEASE_NOTES" "$USE_AUTO_NOTES"
fi

log "Publishing Homebrew tap formulas"
publish_homebrew_tap

RELEASE_URL_PRIMARY="$(release_url_for_repo "$REPO_NAME")"
RELEASE_URL_ALT=""
RELEASE_URL_CLOUD=""
if [[ -n "$REPO_NAME_ALT" ]]; then
  RELEASE_URL_ALT="$(release_url_for_repo "$REPO_NAME_ALT")"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  RELEASE_URL_CLOUD="$(release_url_for_repo "$REPO_NAME_CLOUD")"
fi

generate_release_report \
  "$PREVIOUS_TAG_PRIMARY" \
  "$PREVIOUS_TAG_ALT" \
  "$PREVIOUS_TAG_CLOUD" \
  "$RELEASE_URL_PRIMARY" \
  "$RELEASE_URL_ALT" \
  "$RELEASE_URL_CLOUD"

upload_release_report_asset "$REPO_NAME" "$GENERATED_REPORT_FILE"
if [[ -n "$REPO_NAME_ALT" ]]; then
  upload_release_report_asset "$REPO_NAME_ALT" "$GENERATED_REPORT_FILE"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  upload_release_report_asset "$REPO_NAME_CLOUD" "$GENERATED_REPORT_FILE"
fi

embed_release_report_in_body "$REPO_NAME" "$GENERATED_REPORT_FILE"
if [[ -n "$REPO_NAME_ALT" ]]; then
  embed_release_report_in_body "$REPO_NAME_ALT" "$GENERATED_REPORT_FILE"
fi
if [[ -n "$REPO_NAME_CLOUD" ]]; then
  embed_release_report_in_body "$REPO_NAME_CLOUD" "$GENERATED_REPORT_FILE"
fi

if [[ -z "${TWEET_DRAFT:-}" ]]; then
  if [[ "$USE_AUTO_NOTES" == "true" ]]; then
    TWEET_DRAFT="xint $VERSION is available.

$RELEASE_URL_PRIMARY
$RELEASE_URL_ALT
$RELEASE_URL_CLOUD"
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

cat <<EOF_HOMEBREW

==============================
Homebrew update reminder
==============================
brew update
brew upgrade xint

==============================
EOF_HOMEBREW

log "Release pipeline complete"
