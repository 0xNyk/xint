#!/usr/bin/env bash
set -euo pipefail

OWNER="${OWNER:-0xNyk}"
BRANCH="${BRANCH:-main}"
REPOS="${REPOS:-xint}"
RULESET_NAME="${RULESET_NAME:-Main Branch Guardrails}"
REQUIRE_MERGE_QUEUE="${REQUIRE_MERGE_QUEUE:-false}"

fail() {
  echo "[guardrails-audit] FAIL: $1" >&2
  exit 1
}

expect_contexts() {
  case "$1" in
    xint) echo "CI / checks,Capability Contract / parity" ;;
    xint-rs) echo "CI / checks" ;;
    xint-cloud) echo "ci / checks" ;;
    *) fail "Unsupported repo '$1'" ;;
  esac
}

echo "[guardrails-audit] owner=${OWNER} branch=${BRANCH} repos=${REPOS}"

for repo in ${REPOS}; do
  expected_contexts="$(expect_contexts "${repo}")"
  echo "[guardrails-audit] checking ${OWNER}/${repo}:${BRANCH}"

  repo_auto_merge="$(gh api "repos/${OWNER}/${repo}" --jq '.allow_auto_merge')"
  repo_update_branch="$(gh api "repos/${OWNER}/${repo}" --jq '.allow_update_branch')"
  [[ "${repo_auto_merge}" == "true" ]] || fail "${repo} repository allow_auto_merge is disabled"
  [[ "${repo_update_branch}" == "true" ]] || fail "${repo} repository allow_update_branch is disabled"

  bp_contexts="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.required_status_checks.contexts | sort | join(",")')"
  bp_reviews="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.required_pull_request_reviews.required_approving_review_count')"
  bp_codeowners="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.required_pull_request_reviews.require_code_owner_reviews')"
  bp_linear="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.required_linear_history.enabled')"
  bp_convo="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.required_conversation_resolution.enabled')"
  bp_force="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.allow_force_pushes.enabled')"
  bp_delete="$(gh api "repos/${OWNER}/${repo}/branches/${BRANCH}/protection" --jq '.allow_deletions.enabled')"

  [[ "${bp_contexts}" == "${expected_contexts}" ]] || fail "${repo} branch protection status checks drift (${bp_contexts} != ${expected_contexts})"
  [[ "${bp_reviews}" == "1" ]] || fail "${repo} branch protection review count drift (${bp_reviews})"
  [[ "${bp_codeowners}" == "true" ]] || fail "${repo} branch protection code-owner review is not enforced"
  [[ "${bp_linear}" == "true" ]] || fail "${repo} branch protection linear history is not enforced"
  [[ "${bp_convo}" == "true" ]] || fail "${repo} branch protection conversation resolution is not enforced"
  [[ "${bp_force}" == "false" ]] || fail "${repo} branch protection force-push is allowed"
  [[ "${bp_delete}" == "false" ]] || fail "${repo} branch protection deletion is allowed"

  rs_id="$(gh api "repos/${OWNER}/${repo}/rulesets" --jq ".[] | select(.name==\"${RULESET_NAME}\") | .id" | head -n 1)"
  [[ -n "${rs_id}" ]] || fail "${repo} ruleset '${RULESET_NAME}' missing"

  rs_enforcement="$(gh api "repos/${OWNER}/${repo}/rulesets/${rs_id}" --jq '.enforcement')"
  rs_contexts="$(gh api "repos/${OWNER}/${repo}/rulesets/${rs_id}" --jq '[.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context] | sort | join(",")')"
  rs_reviews="$(gh api "repos/${OWNER}/${repo}/rulesets/${rs_id}" --jq '[.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count][0]')"
  rs_codeowners="$(gh api "repos/${OWNER}/${repo}/rulesets/${rs_id}" --jq '[.rules[] | select(.type=="pull_request") | .parameters.require_code_owner_review][0]')"
  rs_merge_queue="$(gh api "repos/${OWNER}/${repo}/rulesets/${rs_id}" --jq 'any(.rules[]; .type=="merge_queue")')"

  [[ "${rs_enforcement}" == "active" ]] || fail "${repo} ruleset enforcement is not active (${rs_enforcement})"
  [[ "${rs_contexts}" == "${expected_contexts}" ]] || fail "${repo} ruleset status checks drift (${rs_contexts} != ${expected_contexts})"
  [[ "${rs_reviews}" == "1" ]] || fail "${repo} ruleset review count drift (${rs_reviews})"
  [[ "${rs_codeowners}" == "true" ]] || fail "${repo} ruleset code-owner review is not enforced"
  if [[ "${REQUIRE_MERGE_QUEUE}" == "true" ]]; then
    [[ "${rs_merge_queue}" == "true" ]] || fail "${repo} merge queue rule is not enabled"
  fi

  echo "[guardrails-audit] ${repo} OK"
done

echo "[guardrails-audit] all checks passed"
