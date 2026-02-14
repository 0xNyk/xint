#!/usr/bin/env python3
"""
xai_collections.py

Official xAI APIs only:
- api.x.ai (XAI_API_KEY): files, search
- management-api.x.ai (XAI_MANAGEMENT_API_KEY): collections management, attach docs

This script is designed to be cron-safe:
- deterministic outputs
- optional --dry-run (prints request plan, never headers)
- never prints API keys
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


API_BASE = os.environ.get("XAI_API_BASE", "https://api.x.ai/v1").rstrip("/")
MGMT_BASE = os.environ.get("XAI_MGMT_BASE", "https://management-api.x.ai/v1").rstrip("/")


def _now_iso_z() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def _read_env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 256), b""):
            h.update(chunk)
    return h.hexdigest()


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=True) + "\n"


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@dataclass(frozen=True)
class HttpPlan:
    method: str
    url: str
    headers: Dict[str, str]
    body_bytes: int


def _http_json(
    *,
    base: str,
    path: str,
    api_key_env: str,
    method: str,
    body: Optional[Dict[str, Any]] = None,
    query: Optional[Dict[str, str]] = None,
    timeout_s: int = 60,
    dry_run: bool = False,
) -> Tuple[Dict[str, Any], HttpPlan]:
    api_key = _read_env(api_key_env)
    if not api_key and not dry_run:
        _die(f"{api_key_env} is not set")

    q = ""
    if query:
        q = "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    url = f"{base}{path}{q}"

    data = None
    body_bytes = 0
    headers = {"Authorization": f"Bearer {api_key}" if api_key else "Bearer "}
    if body is not None:
        raw = json.dumps(body, ensure_ascii=True).encode("utf-8")
        data = raw
        body_bytes = len(raw)
        headers["Content-Type"] = "application/json"

    plan = HttpPlan(method=method.upper(), url=url, headers={"Content-Type": headers.get("Content-Type", ""), "Authorization": "Bearer ***"}, body_bytes=body_bytes)

    if dry_run:
        return {}, plan

    req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            txt = resp.read().decode("utf-8", errors="replace")
            return (json.loads(txt) if txt else {}), plan
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {raw[:800]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error calling xAI: {e}") from None


def _multipart_body(field_name: str, filename: str, content_type: str, content: bytes, boundary: str) -> bytes:
    # Minimal RFC 7578 multipart/form-data
    lines: List[bytes] = []
    b = boundary.encode("ascii")
    lines.append(b"--" + b)
    disp = f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"'
    lines.append(disp.encode("utf-8"))
    lines.append(f"Content-Type: {content_type}".encode("utf-8"))
    lines.append(b"")
    lines.append(content)
    lines.append(b"--" + b + b"--")
    lines.append(b"")
    return b"\r\n".join(lines)


def files_upload(*, path: Path, purpose: str, timeout_s: int, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    api_key = _read_env("XAI_API_KEY")
    if not api_key and not dry_run:
        _die("XAI_API_KEY is not set")

    url = f"{API_BASE}/files"
    content = path.read_bytes()
    ctype, _ = mimetypes.guess_type(str(path))
    if not ctype:
        ctype = "application/octet-stream"

    boundary = "xai_boundary_" + hashlib.sha256(os.urandom(16)).hexdigest()[:16]

    file_part = _multipart_body("file", path.name, ctype, content, boundary)
    purpose_part = _multipart_body("purpose", "purpose.txt", "text/plain", purpose.encode("utf-8"), boundary)

    # Merge parts into one multipart payload (two separate bodies is not valid).
    # We'll build it by trimming the final boundary from the first part and the leading boundary from the second.
    # This keeps the implementation dependency-free and deterministic.
    def _strip_final(body: bytes) -> bytes:
        marker = (b"--" + boundary.encode("ascii") + b"--\r\n").replace(b"\n", b"\r\n")
        if marker in body:
            return body.split(marker, 1)[0]
        return body

    def _strip_first(body: bytes) -> bytes:
        start = (b"--" + boundary.encode("ascii") + b"\r\n")
        if body.startswith(start):
            return body[len(start) :]
        return body

    merged = _strip_final(file_part) + b"\r\n" + _strip_first(purpose_part)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    plan = HttpPlan(
        method="POST",
        url=url,
        headers={"Content-Type": headers["Content-Type"], "Authorization": "Bearer ***"},
        body_bytes=len(merged),
    )

    if dry_run:
        return {}, plan

    req = urllib.request.Request(url, data=merged, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            txt = resp.read().decode("utf-8", errors="replace")
            return (json.loads(txt) if txt else {}), plan
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} POST /files: {raw[:800]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error calling xAI: {e}") from None


def collections_list(*, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    return _http_json(
        base=MGMT_BASE,
        path="/collections",
        api_key_env="XAI_MANAGEMENT_API_KEY",
        method="GET",
        dry_run=dry_run,
    )


def collections_create(*, name: str, description: str, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    body: Dict[str, Any] = {"name": name}
    if description:
        body["description"] = description
    return _http_json(
        base=MGMT_BASE,
        path="/collections",
        api_key_env="XAI_MANAGEMENT_API_KEY",
        method="POST",
        body=body,
        dry_run=dry_run,
    )


def collections_ensure(*, name: str, description: str, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    res, plan = collections_list(dry_run=dry_run)
    if dry_run:
        return {"status": "dry_run", "note": "would list collections then create if missing"}, plan
    items = res.get("data") if isinstance(res, dict) else None
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and (it.get("name") == name):
                return {"status": "ok", "collection": it}, plan
    created, plan2 = collections_create(name=name, description=description, dry_run=dry_run)
    return {"status": "ok", "created": created}, plan2


def collections_add_document(*, collection_id: str, document_id: str, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    # The management API supports adding documents to collections. Exact field names can vary;
    # we keep this minimal and align with the docs' "document_id" naming.
    body = {"document_id": document_id}
    return _http_json(
        base=MGMT_BASE,
        path=f"/collections/{urllib.parse.quote(collection_id)}/documents",
        api_key_env="XAI_MANAGEMENT_API_KEY",
        method="POST",
        body=body,
        dry_run=dry_run,
    )


def search_documents(*, collection_ids: List[str], query: str, top_k: int, dry_run: bool) -> Tuple[Dict[str, Any], HttpPlan]:
    body: Dict[str, Any] = {"query": query, "top_k": int(top_k)}
    if collection_ids:
        body["collection_ids"] = collection_ids
    return _http_json(
        base=API_BASE,
        path="/documents/search",
        api_key_env="XAI_API_KEY",
        method="POST",
        body=body,
        dry_run=dry_run,
    )


def sync_dir(
    *,
    collection_name: str,
    directory: Path,
    globs: List[str],
    limit: int,
    report_md: Path,
    purpose: str,
    dry_run: bool,
) -> None:
    ts = _now_iso_z()
    plans: List[HttpPlan] = []
    notes: List[str] = []

    # 1) Ensure collection exists (mgmt key)
    ensure_res, ensure_plan = collections_ensure(name=collection_name, description="OpenClaw KB sync", dry_run=dry_run)
    plans.append(ensure_plan)

    collection_id = ""
    if not dry_run:
        coll = None
        if isinstance(ensure_res, dict) and isinstance(ensure_res.get("collection"), dict):
            coll = ensure_res["collection"]
        if isinstance(ensure_res, dict) and isinstance(ensure_res.get("created"), dict):
            coll = ensure_res["created"].get("data") if isinstance(ensure_res["created"].get("data"), dict) else ensure_res["created"]
        if isinstance(coll, dict):
            collection_id = str(coll.get("id") or coll.get("collection_id") or "").strip()
        if not collection_id:
            notes.append("WARN: could not determine collection_id from response; add-document step may fail.")

    # 2) Enumerate files
    paths: List[Path] = []
    for g in globs:
        paths.extend(sorted(directory.glob(g)))
    # Dedupe while preserving order
    seen: set[str] = set()
    uniq: List[Path] = []
    for p in paths:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        if p.is_file():
            uniq.append(p)
    uniq = uniq[: max(0, int(limit))]

    uploaded = 0
    attached = 0
    failures: List[str] = []

    # 3) Upload + attach
    for p in uniq:
        try:
            up_res, up_plan = files_upload(path=p, purpose=purpose, timeout_s=90, dry_run=dry_run)
            plans.append(up_plan)
            uploaded += 1

            # Best-effort: extract document/file id for attachment.
            doc_id = ""
            if not dry_run and isinstance(up_res, dict):
                data = up_res.get("data")
                if isinstance(data, dict):
                    doc_id = str(data.get("id") or data.get("file_id") or data.get("document_id") or "").strip()
                if not doc_id:
                    doc_id = str(up_res.get("id") or "").strip()

            if collection_id and doc_id:
                add_res, add_plan = collections_add_document(collection_id=collection_id, document_id=doc_id, dry_run=dry_run)
                plans.append(add_plan)
                attached += 1
            else:
                if dry_run:
                    notes.append(f"DRY_RUN: would attach uploaded doc for {p.name}")
                else:
                    notes.append(f"WARN: missing ids to attach {p.name} (collection_id={bool(collection_id)} doc_id={bool(doc_id)})")
        except Exception as e:
            failures.append(f"{p.name}: {e}")

    # 4) Write report
    lines: List[str] = []
    lines.append("# xAI Collections KB Sync")
    lines.append("")
    lines.append(f"- Timestamp (UTC): {ts}")
    lines.append(f"- Collection name: `{collection_name}`")
    lines.append(f"- Directory: `{directory}`")
    lines.append(f"- Globs: `{', '.join(globs)}`")
    lines.append(f"- Limit: {limit}")
    lines.append(f"- Dry run: {str(bool(dry_run)).lower()}")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Files considered: {len(uniq)}")
    lines.append(f"- Upload attempts: {uploaded}")
    lines.append(f"- Attach attempts: {attached}")
    lines.append(f"- Failures: {len(failures)}")
    lines.append("")
    if notes:
        lines.append("## Notes")
        lines.append("")
        for n in notes[:50]:
            lines.append(f"- {n}")
        lines.append("")
    if failures:
        lines.append("## Failures")
        lines.append("")
        for f in failures[:50]:
            lines.append(f"- {f}")
        lines.append("")
    lines.append("## HTTP Plan (Sanitized)")
    lines.append("")
    for p in plans[:200]:
        lines.append(f"- {p.method} {p.url} body_bytes={p.body_bytes}")
    lines.append("")

    _write_text(report_md, "\n".join(lines).rstrip() + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Plan only; do not make network calls")

    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collections")
    csub = c.add_subparsers(dest="subcmd", required=True)
    csub.add_parser("list")
    ce = csub.add_parser("ensure")
    ce.add_argument("--name", required=True)
    ce.add_argument("--description", default="")
    cc = csub.add_parser("create")
    cc.add_argument("--name", required=True)
    cc.add_argument("--description", default="")
    cad = csub.add_parser("add-document")
    cad.add_argument("--collection-id", required=True)
    cad.add_argument("--document-id", required=True)

    f = sub.add_parser("files")
    fsub = f.add_subparsers(dest="subcmd", required=True)
    fu = fsub.add_parser("upload")
    fu.add_argument("--path", required=True)
    fu.add_argument("--purpose", default="kb_sync")

    s = sub.add_parser("search")
    s.add_argument("--collection-ids", default="", help="Comma-separated collection ids")
    s.add_argument("--query", required=True)
    s.add_argument("--top-k", type=int, default=8)

    sd = sub.add_parser("sync-dir")
    sd.add_argument("--collection-name", required=True)
    sd.add_argument("--dir", required=True)
    sd.add_argument("--glob", action="append", default=["*.md"])
    sd.add_argument("--limit", type=int, default=50)
    sd.add_argument("--purpose", default="kb_sync")
    sd.add_argument("--report-md", default="", help="Where to write a markdown report")

    args = ap.parse_args(argv)
    dry_run = bool(args.dry_run)

    try:
        if args.cmd == "collections":
            if args.subcmd == "list":
                res, plan = collections_list(dry_run=dry_run)
                print(_json_dumps({"result": res, "plan": plan.__dict__}))
                return 0
            if args.subcmd == "create":
                res, plan = collections_create(name=str(args.name), description=str(args.description), dry_run=dry_run)
                print(_json_dumps({"result": res, "plan": plan.__dict__}))
                return 0
            if args.subcmd == "ensure":
                res, plan = collections_ensure(name=str(args.name), description=str(args.description), dry_run=dry_run)
                print(_json_dumps({"result": res, "plan": plan.__dict__}))
                return 0
            if args.subcmd == "add-document":
                res, plan = collections_add_document(collection_id=str(args.collection_id), document_id=str(args.document_id), dry_run=dry_run)
                print(_json_dumps({"result": res, "plan": plan.__dict__}))
                return 0

        if args.cmd == "files":
            if args.subcmd == "upload":
                p = Path(str(args.path)).expanduser().resolve()
                res, plan = files_upload(path=p, purpose=str(args.purpose), timeout_s=90, dry_run=dry_run)
                print(_json_dumps({"result": res, "plan": plan.__dict__}))
                return 0

        if args.cmd == "search":
            cids = [x.strip() for x in str(args.collection_ids).split(",") if x.strip()]
            res, plan = search_documents(collection_ids=cids, query=str(args.query), top_k=int(args.top_k), dry_run=dry_run)
            print(_json_dumps({"result": res, "plan": plan.__dict__}))
            return 0

        if args.cmd == "sync-dir":
            directory = Path(str(args.dir)).expanduser().resolve()
            report_md = Path(str(args.report_md)).expanduser().resolve() if str(args.report_md) else (directory / "xai-collections-sync-latest.md")
            sync_dir(
                collection_name=str(args.collection_name),
                directory=directory,
                globs=list(args.glob or ["*.md"]),
                limit=int(args.limit),
                report_md=report_md,
                purpose=str(args.purpose),
                dry_run=dry_run,
            )
            print("NO_REPLY")
            return 0

        _die("unknown command")
    except Exception as e:
        print(_json_dumps({"status": "error", "error": str(e)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
