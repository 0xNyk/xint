#!/usr/bin/env bash
set -euo pipefail

OWNER="${OWNER:-0xNyk}"
BRANCH="${BRANCH:-main}"
MODE="${1:---dry-run}"

if [[ "${MODE}" != "--dry-run" && "${MODE}" != "--apply" ]]; then
  echo "Usage: $0 [--dry-run|--apply]"
  exit 1
fi

command -v gh >/dev/null 2>&1 || {
  echo "Missing required tool: gh"
  exit 1
}

payload_for_repo() {
  local repo="$1"
  case "${repo}" in
    xint)
      cat <<'JSON'
{
  "name": "Main Branch Guardrails",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "CI / checks" },
          { "context": "Capability Contract / parity" }
        ]
      }
    }
  ]
}
JSON
      ;;
    xint-rs)
      cat <<'JSON'
{
  "name": "Main Branch Guardrails",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "CI / checks" }
        ]
      }
    }
  ]
}
JSON
      ;;
    xint-cloud)
      cat <<'JSON'
{
  "name": "Main Branch Guardrails",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "ci / checks" }
        ]
      }
    }
  ]
}
JSON
      ;;
    *)
      echo "Unsupported repo: ${repo}" >&2
      return 1
      ;;
  esac
}

ruleset_id() {
  local repo="$1"
  gh api "repos/${OWNER}/${repo}/rulesets" --jq '.[] | select(.name=="Main Branch Guardrails") | .id' | head -n 1
}

apply_repo() {
  local repo="$1"
  local payload_file
  payload_file="$(mktemp)"
  payload_for_repo "${repo}" > "${payload_file}"

  if [[ "${MODE}" == "--dry-run" ]]; then
    echo "== ${OWNER}/${repo}:${BRANCH} ruleset payload =="
    cat "${payload_file}"
    rm -f "${payload_file}"
    return 0
  fi

  local id
  id="$(ruleset_id "${repo}")"
  if [[ -n "${id}" ]]; then
    gh api "repos/${OWNER}/${repo}/rulesets/${id}" --method PUT --input "${payload_file}" >/dev/null
    echo "Updated ruleset ${id} for ${OWNER}/${repo}"
  else
    gh api "repos/${OWNER}/${repo}/rulesets" --method POST --input "${payload_file}" >/dev/null
    echo "Created ruleset for ${OWNER}/${repo}"
  fi
  rm -f "${payload_file}"
}

print_summary() {
  local repo="$1"
  local id
  id="$(ruleset_id "${repo}")"
  if [[ -z "${id}" ]]; then
    echo "== ${OWNER}/${repo}:${BRANCH} ruleset =="
    echo "Main Branch Guardrails not found"
    echo
    return 0
  fi
  echo "== ${OWNER}/${repo}:${BRANCH} ruleset =="
  gh api "repos/${OWNER}/${repo}/rulesets/${id}" \
    --jq '{id, enforcement, checks: ([.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]), review_count: ([.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count][0]), code_owner_review: ([.rules[] | select(.type=="pull_request") | .parameters.require_code_owner_review][0]), merge_queue: (any(.rules[]; .type=="merge_queue"))}'
  echo
}

gh auth status >/dev/null

for repo in xint xint-rs xint-cloud; do
  apply_repo "${repo}"
done

if [[ "${MODE}" == "--apply" ]]; then
  for repo in xint xint-rs xint-cloud; do
    print_summary "${repo}"
  done
fi
