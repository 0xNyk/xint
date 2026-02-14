#!/usr/bin/env python3
"""
xai_x_search_scan.py

Fetch public X signals using xAI's hosted `x_search` tool (no cookies, no GraphQL),
write a durable report artifact, and optionally emit memory candidates.

This is intended to be cron-safe and deterministic (no agent tool calls).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


DEFAULT_BASE_URL = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1").rstrip("/")
DEFAULT_MODEL = os.environ.get("XAI_X_SEARCH_MODEL", "grok-4")


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def http_post_json(url: str, api_key: str, body: Dict[str, Any], timeout_s: int) -> Dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} calling xAI: {raw[:500]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error calling xAI: {e}") from None


def extract_output_text(res: Dict[str, Any]) -> str:
    out = res.get("output")
    if not isinstance(out, list):
        return ""
    for item in out:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "message":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        parts: List[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                txt = part["text"].strip()
                if txt:
                    parts.append(txt)
        if parts:
            return "\n".join(parts).strip()
    return ""


def extract_x_search_results(res: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = res.get("output")
    if not isinstance(out, list):
        return []
    results: List[Dict[str, Any]] = []
    for item in out:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "x_search_call":
            continue
        r = item.get("results")
        if isinstance(r, list):
            for rr in r:
                if isinstance(rr, dict):
                    results.append(rr)
    return results


def safe_str(v: Any) -> str:
    return v if isinstance(v, str) else ""


def best_url(r: Dict[str, Any]) -> str:
    for k in ("url", "tweet_url", "link"):
        u = safe_str(r.get(k))
        if u:
            return u
    return ""


def best_text(r: Dict[str, Any]) -> str:
    for k in ("text", "content", "snippet", "title"):
        t = safe_str(r.get(k)).strip()
        if t:
            return t
    return ""


def best_handle(r: Dict[str, Any]) -> str:
    for k in ("username", "author", "handle"):
        h = safe_str(r.get(k)).strip()
        if h:
            return h.lstrip("@")
    return ""


def best_created_at(r: Dict[str, Any]) -> str:
    for k in ("created_at", "date", "timestamp", "time"):
        v = safe_str(r.get(k)).strip()
        if v:
            return v
    return ""


def load_existing_sources(workspace: Path) -> Set[str]:
    sources: Set[str] = set()

    # Candidates (all)
    cand_dir = workspace / "memory" / "candidates"
    if cand_dir.exists():
        for p in sorted(cand_dir.glob("*.jsonl")):
            try:
                for line in p.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    s = obj.get("source")
                    if isinstance(s, str) and s:
                        sources.add(s)
            except Exception:
                continue

    # Store (common files)
    store_dir = workspace / "memory" / "store"
    for name in ("provisional.jsonl", "confirmed.jsonl", "rejected.jsonl"):
        p = store_dir / name
        if not p.exists():
            continue
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                s = obj.get("source")
                if isinstance(s, str) and s:
                    sources.add(s)
        except Exception:
            continue

    return sources


def render_md(
    ts: str,
    queries: List[str],
    per_query: List[Tuple[str, List[Dict[str, Any]], str]],
    summary: str,
) -> str:
    lines: List[str] = []
    lines.append("# xAI X Search Scan")
    lines.append("")
    lines.append(f"- Timestamp (UTC): {ts}")
    lines.append(f"- Queries: {len(queries)}")
    lines.append("")

    if summary:
        lines.append("## Summary")
        lines.append("")
        lines.append(summary.strip())
        lines.append("")

    lines.append("## Results")
    lines.append("")

    for q, results, err in per_query:
        lines.append(f"### Query: `{q}`")
        lines.append("")
        if err:
            lines.append(f"- ERROR: {err}")
            lines.append("")
            continue
        if not results:
            lines.append("- (no results)")
            lines.append("")
            continue
        for r in results:
            handle = best_handle(r)
            text = best_text(r).replace("\n", " ").strip()
            if len(text) > 220:
                text = text[:217] + "..."
            url = best_url(r)
            created_at = best_created_at(r)
            prefix = f"@{handle}: " if handle else ""
            meta = f" ({created_at})" if created_at else ""
            if url:
                lines.append(f"- {prefix}{text}{meta} {url}")
            else:
                lines.append(f"- {prefix}{text}{meta}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True, help="Workspace root (e.g. /home/openclaw/.openclaw/workspace-jarv)")
    ap.add_argument("--queries-file", required=True, help="JSON file with {queries:[...]} or array of strings")
    ap.add_argument("--out-md", required=True, help="Path to write markdown report")
    ap.add_argument("--out-json", required=True, help="Path to write raw JSON payload")
    ap.add_argument("--emit-candidates", action="store_true", help="Append new memory candidates (deduped by source)")
    ap.add_argument("--candidates-out", default="", help="Candidate JSONL output path (default: workspace/memory/candidates/x-search-YYYY-MM-DD.jsonl)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-results", type=int, default=10)
    ap.add_argument("--timeout-seconds", type=int, default=45)
    ap.add_argument("--from-date", default="", help="YYYY-MM-DD")
    ap.add_argument("--to-date", default="", help="YYYY-MM-DD")
    args = ap.parse_args()

    api_key = (os.environ.get("XAI_API_KEY") or "").strip()
    if not api_key:
        print("ERROR: XAI_API_KEY is not set in the environment.", file=sys.stderr)
        return 2

    workspace = Path(args.workspace)
    queries_path = Path(args.queries_file)
    out_md = Path(args.out_md)
    out_json = Path(args.out_json)

    qobj = read_json(queries_path)
    if isinstance(qobj, dict) and isinstance(qobj.get("queries"), list):
        queries = [q for q in qobj["queries"] if isinstance(q, str) and q.strip()]
    elif isinstance(qobj, list):
        queries = [q for q in qobj if isinstance(q, str) and q.strip()]
    else:
        raise RuntimeError("queries-file must be a JSON array of strings or {\"queries\": [...]} object")

    if not queries:
        raise RuntimeError("No queries provided.")

    ts = utc_now_iso()
    per_query: List[Tuple[str, List[Dict[str, Any]], str]] = []
    all_payload: Dict[str, Any] = {
        "timestamp": ts,
        "base_url": args.base_url,
        "model": args.model,
        "max_results": args.max_results,
        "from_date": args.from_date or None,
        "to_date": args.to_date or None,
        "queries": [],
    }
    had_errors = False

    for q in queries:
        tool_spec: Dict[str, Any] = {"type": "x_search", "max_results": int(args.max_results)}
        if args.from_date:
            tool_spec["from_date"] = args.from_date
        if args.to_date:
            tool_spec["to_date"] = args.to_date

        body: Dict[str, Any] = {
            "model": args.model,
            "input": f"Use x_search to find recent posts relevant to: {q}\nReturn the search results.",
            "tools": [tool_spec],
            "tool_choice": "required",
            "max_output_tokens": 800,
        }

        err = ""
        results: List[Dict[str, Any]] = []
        summary = ""
        try:
            res = http_post_json(
                f"{args.base_url.rstrip('/')}/responses",
                api_key,
                body,
                int(args.timeout_seconds),
            )
            results = extract_x_search_results(res)
            summary = extract_output_text(res)
        except Exception as e:
            had_errors = True
            err = str(e)[:500]

        # Keep per-query payload minimal but useful.
        all_payload["queries"].append(
            {
                "query": q,
                "summary": summary,
                "results": results,
                "error": err or None,
            }
        )
        per_query.append((q, results, err))

    # Render report
    combined_summary = ""
    # Prefer the last non-empty summary, but don't rely on it.
    for qd in all_payload["queries"]:
        s = qd.get("summary")
        if isinstance(s, str) and s.strip():
            combined_summary = s.strip()

    write_json(out_json, all_payload)
    write_text(out_md, render_md(ts, queries, per_query, combined_summary))

    total_results = sum(len(r) for _, r, _ in per_query)
    status = "FAIL" if had_errors and total_results == 0 else ("PARTIAL" if had_errors else "OK")
    print(f"xAI X search: {status} ({len(queries)} queries, {total_results} results)")
    print(f"Report: {out_md}")

    # Emit memory candidates
    if args.emit_candidates:
        existing_sources = load_existing_sources(workspace)
        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        cand_out = Path(args.candidates_out) if args.candidates_out else (
            workspace / "memory" / "candidates" / f"x-search-{today}.jsonl"
        )
        cand_out.parent.mkdir(parents=True, exist_ok=True)

        new_lines: List[str] = []
        for q, results, err in per_query:
            if err:
                continue
            for r in results:
                url = best_url(r)
                text = best_text(r).replace("\n", " ").strip()
                handle = best_handle(r)
                if not text and not url:
                    continue
                source = f"x_search:{url}" if url else f"x_search:{handle}:{hash(text)}"
                if source in existing_sources:
                    continue

                # Keep candidates durable and non-speculative: quote-like summary + source link.
                val = text
                if handle:
                    val = f"@{handle}: {val}"
                if url:
                    val = f"{val} ({url})"

                item = {
                    "type": "fact",
                    "value": val[:900],
                    "confidence": 0.55,
                    "source": source,
                    "created_at": ts,
                }
                new_lines.append(json.dumps(item, ensure_ascii=True))
                existing_sources.add(source)

        if new_lines:
            with cand_out.open("a", encoding="utf-8") as f:
                for line in new_lines:
                    f.write(line + "\n")

        print(f"New memory candidates: {len(new_lines)}")
        if new_lines:
            print(f"Candidates appended: {cand_out}")

    # Cron should not flap on transient upstream/network issues.
    # Write FAIL/PARTIAL status into artifacts, but exit 0 so the scheduler stays stable.
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise
