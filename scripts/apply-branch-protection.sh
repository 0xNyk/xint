#!/usr/bin/env bash
set -euo pipefail

OWNER="${OWNER:-0xNyk}"
BRANCH="${BRANCH:-main}"
MODE="${1:---dry-run}"

if [[ "${MODE}" != "--dry-run" && "${MODE}" != "--apply" ]]; then
  echo "Usage: $0 [--dry-run|--apply]"
  exit 1
fi

require_tools() {
  command -v gh >/dev/null 2>&1 || {
    echo "Missing required tool: gh"
    exit 1
  }
}

show_current() {
  local repo="$1"
  echo "== ${OWNER}/${repo}:${BRANCH} current protection =="
  gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" \
    --jq '{required_status_checks: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled, required_approvals: .required_pull_request_reviews.required_approving_review_count, code_owner_reviews: .required_pull_request_reviews.require_code_owner_reviews, conversation_resolution: .required_conversation_resolution.enabled, linear_history: .required_linear_history.enabled, allow_force_pushes: .allow_force_pushes.enabled, allow_deletions: .allow_deletions.enabled}' \
    || echo "No existing protection (or insufficient permissions)"
  echo
}

apply_repo() {
  local repo="$1"
  local payload
  case "${repo}" in
    xint)
      payload='{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI / checks", "Capability Contract / parity"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}'
      ;;
    xint-rs)
      payload='{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI / checks"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}'
      ;;
    xint-cloud)
      payload='{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci / checks"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}'
      ;;
    *)
      echo "Unsupported repo: ${repo}"
      return 1
      ;;
  esac

  if [[ "${MODE}" == "--dry-run" ]]; then
    echo "== ${OWNER}/${repo}:${BRANCH} planned protection payload =="
    echo "${payload}"
    echo
    return 0
  fi

  echo "Applying protection to ${OWNER}/${repo}:${BRANCH}..."
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" \
    --input - <<<"${payload}" >/dev/null
  echo "Applied protection to ${OWNER}/${repo}:${BRANCH}"
}

require_tools
gh auth status >/dev/null

for repo in xint xint-rs xint-cloud; do
  show_current "${repo}"
done

for repo in xint xint-rs xint-cloud; do
  apply_repo "${repo}"
done

if [[ "${MODE}" == "--apply" ]]; then
  echo
  echo "Verification:"
  for repo in xint xint-rs xint-cloud; do
    show_current "${repo}"
  done
fi
