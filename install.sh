#!/usr/bin/env bash
set -euo pipefail

OWNER="0xNyk"
REPO="xint"

INSTALL_BIN_DIR="${XINT_INSTALL_BIN_DIR:-$HOME/.local/bin}"
INSTALL_ROOT="${XINT_INSTALL_ROOT:-$HOME/.local/share/xint}"
REQUESTED_VERSION="${XINT_INSTALL_VERSION:-latest}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing required command '$1'" >&2
    exit 1
  fi
}

resolve_version() {
  if [[ "$REQUESTED_VERSION" != "latest" ]]; then
    printf '%s' "$REQUESTED_VERSION"
    return
  fi

  local api_url="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
  local tag
  tag="$(curl -fsSL "$api_url" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  printf '%s' "$tag"
}

main() {
  require_cmd curl
  require_cmd tar
  require_cmd python3
  require_cmd bun

  local version
  version="$(resolve_version)"
  local tarball_url="https://github.com/${OWNER}/${REPO}/archive/refs/tags/${version}.tar.gz"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  echo "==> Downloading ${REPO} ${version}"
  local tarball="${tmpdir}/xint.tar.gz"
  curl -fsSL "$tarball_url" -o "$tarball"

  # Checksum verification
  local checksums_url="https://github.com/${OWNER}/${REPO}/releases/download/${version}/checksums.txt"
  local checksums_file="${tmpdir}/checksums.txt"
  if curl -fsSL "$checksums_url" -o "$checksums_file" 2>/dev/null; then
    local asset_name
    asset_name="$(basename "$tarball_url")"
    local expected
    expected="$(awk -v name="$asset_name" '$0 ~ name {print $1; exit}' "$checksums_file" || true)"
    if [[ -n "$expected" ]]; then
      local actual=""
      if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$tarball" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$tarball" | awk '{print $1}')"
      fi
      if [[ -n "$actual" ]]; then
        if [[ "$actual" != "$expected" ]]; then
          echo "error: checksum mismatch for $asset_name" >&2
          exit 1
        fi
        echo "==> Checksum verified"
      else
        if [[ "${XINT_INSTALL_REQUIRE_CHECKSUM:-0}" == "1" ]]; then
          echo "error: checksum required but neither sha256sum nor shasum is available" >&2
          exit 1
        fi
        echo "==> Checksum tool unavailable; skipping verification"
      fi
    else
      if [[ "${XINT_INSTALL_REQUIRE_CHECKSUM:-0}" == "1" ]]; then
        echo "error: checksum required but no entry found in checksums.txt" >&2
        exit 1
      fi
      echo "==> Checksums file present but no entry for $asset_name; skipping verification"
    fi
  else
    if [[ "${XINT_INSTALL_REQUIRE_CHECKSUM:-0}" == "1" ]]; then
      echo "error: checksum required but checksums.txt not found in release" >&2
      exit 1
    fi
    echo "==> No checksums.txt in release; skipping checksum verification"
  fi

  echo "==> Extracting"
  tar -xzf "$tarball" -C "$tmpdir"
  local src_dir
  src_dir="$(find "$tmpdir" -maxdepth 1 -type d -name "${REPO}-*" | head -n1)"
  if [[ -z "$src_dir" ]]; then
    echo "error: failed to locate extracted source directory" >&2
    exit 1
  fi

  local release_dir="${INSTALL_ROOT}/releases/${version}"
  mkdir -p "$release_dir"
  cp -R "${src_dir}/." "$release_dir/"

  echo "==> Installing dependencies with Bun"
  (cd "$release_dir" && bun install --frozen-lockfile)

  mkdir -p "${INSTALL_ROOT}"
  ln -sfn "$release_dir" "${INSTALL_ROOT}/current"

  mkdir -p "$INSTALL_BIN_DIR"
  local launcher="${INSTALL_BIN_DIR}/xint"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec bun run "${INSTALL_ROOT}/current/xint.ts" "\$@"
EOF
  chmod +x "$launcher"

  echo "==> Installed xint ${version}"
  echo "   Binary: ${launcher}"
  if [[ ":$PATH:" != *":${INSTALL_BIN_DIR}:"* ]]; then
    echo "   Add to PATH: export PATH=\"${INSTALL_BIN_DIR}:\$PATH\""
  fi
}

main "$@"
