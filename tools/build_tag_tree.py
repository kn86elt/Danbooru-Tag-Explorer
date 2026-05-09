#!/usr/bin/env python3
"""Build a fresh Danbooru tag tree from wiki tag-group pages.

The output shape is compatible with the existing app:

    {
      "Category": {
        "tag_name": "/wiki_pages/tag_name",
        "tag_with_children": {
          "self": "/wiki_pages/tag_with_children",
          "child_tag": "/wiki_pages/child_tag"
        }
      }
    }

This script intentionally does not edit app.js, index.html, or style.css.
By default it writes data/tag_tree.generated.json so the generated dataset can
be inspected before replacing data/tag_tree.json.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen


BASE_URL = "https://danbooru.donmai.us"
ROOT_WIKI = "tag_groups"
DEFAULT_SEED_URL = (
    "https://raw.githubusercontent.com/KohakuBlueleaf/"
    "danbooru-tag-tree/main/tag_list_urls.json"
)
USER_AGENT = "danbooru-tag-explorer/0.1 (tag tree builder)"
DEFAULT_SKIP_EXPAND_SLUGS = {
    # These are index/maintenance pages, not semantic tag categories. Expanding
    # them injects broad unrelated tags under "Copyrights ... > More".
    "list_of_disambiguation_pages",
}

LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
HEADING_RE = re.compile(r"^\s*h([1-6])\.\s+(.+?)\s*$")
MARKDOWN_HEADING_RE = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*$")
LIST_RE = re.compile(r"^\s*(\*+)\s+(.+?)\s*$")
HTML_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class BuildStats:
    fetched_pages: int = 0
    expanded_pages: list[str] = field(default_factory=list)
    failed_pages: dict[str, str] = field(default_factory=dict)


def wiki_slug_from_url(url: str) -> str:
    path = urlparse(url).path if url.startswith("http") else url
    if "/wiki_pages/" in path:
        path = path.split("/wiki_pages/", 1)[1]
    return unquote(path.strip("/"))


def is_expandable_wiki(url: str) -> bool:
    slug = wiki_slug_from_url(url).lower()
    return slug.startswith("tag_group:") or slug.startswith("tag_group%3a") or slug.startswith("list_of_")


def is_wiki_url(url: str) -> bool:
    return isinstance(url, str) and (url.startswith("/wiki_pages/") or "/wiki_pages/" in url)


def normalize_slug(slug_or_url: str) -> str:
    return wiki_slug_from_url(slug_or_url).replace("%3A", ":").replace("%3a", ":").lower()


def wiki_url(slug: str) -> str:
    slug = slug.strip()
    if slug.startswith("/wiki_pages/"):
        return slug
    slug = slug.replace(" ", "_")
    return f"/wiki_pages/{quote(slug, safe=':%_!-.,')}"


def clean_text(text: str) -> str:
    text = HTML_TAG_RE.sub("", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return " ".join(text.strip().split())


def clean_category_title(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"^tag group:\s*", "", text, flags=re.I)
    text = re.sub(r"^list of\s+", "", text, flags=re.I)
    return text.strip()


def canonical_key(text: str, tag_names: set[str], aliases: dict[str, str]) -> str:
    text = clean_category_title(text)
    candidates = [
        text,
        text.replace(" ", "_"),
        re.sub(r"\s+\([^)]+\)$", "", text).replace(" ", "_"),
    ]
    for candidate in candidates:
        if candidate in tag_names:
            return candidate
        lowered = candidate.lower()
        if lowered in tag_names:
            return lowered
        if candidate in aliases:
            return aliases[candidate]
        if lowered in aliases:
            return aliases[lowered]
    return text


def tag_key_from_wiki_url(url: str, tag_names: set[str], aliases: dict[str, str]) -> str:
    slug = wiki_slug_from_url(url)
    if is_expandable_wiki(url):
        return canonical_key(slug, tag_names, aliases)
    slug = slug.replace(" ", "_").lower()
    return canonical_key(slug, tag_names, aliases)


def extract_link(text: str) -> tuple[str, str] | None:
    match = LINK_RE.search(text)
    if not match:
        return None
    target = clean_text(match.group(1))
    label = clean_text(match.group(2) or target)
    return label, wiki_url(target)


def key_for_link(label: str, url: str, tag_names: set[str], aliases: dict[str, str]) -> str:
    if is_expandable_wiki(url):
        return canonical_key(label, tag_names, aliases)
    return tag_key_from_wiki_url(url, tag_names, aliases)


def should_skip_list_text(text: str) -> bool:
    stripped = clean_text(text)
    if not stripped:
        return True
    lowered = stripped.lower()
    return (
        lowered.startswith("(")
        or lowered.startswith("for ")
        or lowered.startswith("see ")
        or lowered.startswith("note:")
    )


def fetch_wiki_body(slug_or_url: str, delay: float, stats: BuildStats) -> str:
    slug = wiki_slug_from_url(slug_or_url)
    api_url = f"{BASE_URL}/wiki_pages/{quote(slug, safe=':%_!-.,')}.json"
    request = Request(api_url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{api_url}: {exc}") from exc
    finally:
        if delay > 0:
            time.sleep(delay)

    stats.fetched_pages += 1
    body = payload.get("body")
    if not isinstance(body, str):
        raise RuntimeError(f"{api_url}: response has no wiki body")
    return body


def fetch_json_url(url: str, delay: float) -> Any:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{url}: {exc}") from exc
    finally:
        if delay > 0:
            time.sleep(delay)
    return payload


def load_seed_tree(seed_path: Path | None, seed_url: str | None, delay: float) -> dict[str, Any] | None:
    if seed_path is not None:
        with seed_path.open("r", encoding="utf-8") as file:
            payload = json.load(file)
        if not isinstance(payload, dict):
            raise RuntimeError(f"{seed_path}: seed JSON must be an object")
        return payload

    if seed_url:
        payload = fetch_json_url(seed_url, delay)
        if not isinstance(payload, dict):
            raise RuntimeError(f"{seed_url}: seed JSON must be an object")
        return payload

    return None


def normalize_seed_tree(tree: dict[str, Any]) -> None:
    """Patch known stale placements from the historical seed skeleton."""
    try:
        media_more = tree["Copyrights, artists, projects and media"]["More"]
        attire = tree["Visual characteristics"]["Attire and body accessories"]["Attire"]
    except KeyError:
        return

    if not isinstance(media_more, dict) or not isinstance(attire, dict):
        return

    uniforms = media_more.pop("uniforms", None)
    if uniforms is not None:
        attire.setdefault("Uniforms", uniforms)


def ensure_child_container(parent: dict[str, Any], key: str, self_url: str | None = None) -> dict[str, Any]:
    current = parent.get(key)
    if isinstance(current, dict):
        return current
    child: dict[str, Any] = {}
    if isinstance(current, str):
        child["self"] = current
    elif self_url:
        child["self"] = self_url
    parent[key] = child
    return child


def insert_leaf(parent: dict[str, Any], key: str, url: str) -> None:
    existing = parent.get(key)
    if isinstance(existing, dict):
        existing.setdefault("self", url)
    elif existing is None:
        parent[key] = url


def parse_wiki_body(body: str, tag_names: set[str], aliases: dict[str, str]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    heading_stack: list[tuple[int, str]] = []
    list_stack: list[tuple[int, str]] = []

    def current_container() -> dict[str, Any]:
        container = root
        for _, key in heading_stack:
            container = ensure_child_container(container, key)
        for _, key in list_stack:
            container = ensure_child_container(container, key)
        return container

    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue

        heading = HEADING_RE.match(line) or MARKDOWN_HEADING_RE.match(line)
        if heading:
            if heading.re is HEADING_RE:
                level = int(heading.group(1))
                title = heading.group(2)
            else:
                level = len(heading.group(1))
                title = heading.group(2)
            title = clean_category_title(title)
            if title.lower() == "see also":
                break
            if not title:
                continue
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            list_stack.clear()
            ensure_child_container(current_container(), title)
            heading_stack.append((level, title))
            continue

        item = LIST_RE.match(line)
        if not item:
            continue

        depth = len(item.group(1))
        item_text = item.group(2)
        if should_skip_list_text(item_text):
            continue

        link = extract_link(item_text)
        if not link:
            continue

        label, url = link
        key = key_for_link(label, url, tag_names, aliases)
        while list_stack and list_stack[-1][0] >= depth:
            list_stack.pop()
        container = current_container()
        insert_leaf(container, key, url)
        list_stack.append((depth, key))

    return prune_empty_categories(root)


def prune_empty_categories(node: Any) -> Any:
    if not isinstance(node, dict):
        return node
    for key in list(node.keys()):
        value = prune_empty_categories(node[key])
        if isinstance(value, dict) and not value:
            del node[key]
        else:
            node[key] = value
    return node


def merge_dict(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if key not in target:
            target[key] = value
        elif isinstance(target[key], dict) and isinstance(value, dict):
            merge_dict(target[key], value)
        elif isinstance(target[key], dict) and isinstance(value, str):
            target[key].setdefault("self", value)
        elif isinstance(target[key], str) and isinstance(value, dict):
            existing = target[key]
            target[key] = value
            target[key].setdefault("self", existing)


def expand_tree(
    node: dict[str, Any],
    tag_names: set[str],
    aliases: dict[str, str],
    stats: BuildStats,
    delay: float,
    max_pages: int | None,
    skip_expand_slugs: set[str],
    seen: set[str] | None = None,
    keys: list[str] | None = None,
) -> None:
    if seen is None:
        seen = set()

    if keys is None:
        items = list(node.items())
    else:
        items = [(key, node[key]) for key in keys if key in node]

    for key, value in items:
        value = node[key]

        if isinstance(value, str) and is_expandable_wiki(value):
            slug = wiki_slug_from_url(value)
            if normalize_slug(slug) in skip_expand_slugs:
                continue
            if slug in seen:
                continue
            if max_pages is not None and len(seen) >= max_pages:
                continue
            seen.add(slug)
            try:
                body = fetch_wiki_body(value, delay, stats)
                parsed = parse_wiki_body(body, tag_names, aliases)
                node[key] = parsed
                stats.expanded_pages.append(slug)
            except RuntimeError as exc:
                stats.failed_pages[slug] = str(exc)
            continue

        if isinstance(value, dict):
            original_child_keys = [child_key for child_key in value.keys() if child_key != "self"]
            self_url = value.get("self")
            if isinstance(self_url, str) and is_expandable_wiki(self_url):
                slug = wiki_slug_from_url(self_url)
                if normalize_slug(slug) in skip_expand_slugs:
                    expand_tree(value, tag_names, aliases, stats, delay, max_pages, skip_expand_slugs, seen, original_child_keys)
                    continue
                if slug not in seen and (max_pages is None or len(seen) < max_pages):
                    seen.add(slug)
                    try:
                        body = fetch_wiki_body(self_url, delay, stats)
                        parsed = parse_wiki_body(body, tag_names, aliases)
                        value.pop("self", None)
                        merge_dict(value, parsed)
                        stats.expanded_pages.append(slug)
                    except RuntimeError as exc:
                        stats.failed_pages[slug] = str(exc)
            expand_tree(value, tag_names, aliases, stats, delay, max_pages, skip_expand_slugs, seen, original_child_keys)


def load_tag_csv(path: Path | None) -> tuple[set[str], dict[str, str]]:
    if path is None or not path.exists():
        return set(), {}

    tag_names: set[str] = set()
    aliases: dict[str, str] = {}
    with path.open("r", encoding="utf-8", newline="") as file:
        for row in csv.reader(file):
            if len(row) < 1 or not row[0].strip():
                continue
            name = row[0].strip()
            tag_names.add(name)
            if len(row) >= 4:
                for alias in row[3].split(","):
                    alias = alias.strip()
                    if alias:
                        aliases[alias] = name
    return tag_names, aliases


def collect_tree_tags(node: Any, tags: set[str] | None = None) -> set[str]:
    if tags is None:
        tags = set()
    if not isinstance(node, dict):
        return tags
    for key, value in node.items():
        if key == "self":
            continue
        if isinstance(value, str):
            if is_wiki_url(value) and not is_expandable_wiki(value):
                tags.add(key)
        elif isinstance(value, dict):
            self_url = value.get("self")
            if isinstance(self_url, str) and not is_expandable_wiki(self_url):
                tags.add(key)
            collect_tree_tags(value, tags)
    return tags


def write_report(
    report_path: Path,
    tree: dict[str, Any],
    tag_names: set[str],
    aliases: dict[str, str],
    stats: BuildStats,
    limit: int,
) -> None:
    tree_tags = collect_tree_tags(tree)
    resolved_tree_tags = {canonical_key(tag, tag_names, aliases) for tag in tree_tags}
    missing_metadata = sorted(tag for tag in resolved_tree_tags if tag not in tag_names)
    csv_not_in_tree = sorted(tag for tag in tag_names if tag not in resolved_tree_tags)

    report = {
        "summary": {
            "tree_tags": len(tree_tags),
            "resolved_tree_tags": len(resolved_tree_tags),
            "csv_tags": len(tag_names),
            "tree_tags_missing_csv_metadata": len(missing_metadata),
            "csv_tags_not_in_tree": len(csv_not_in_tree),
            "fetched_pages": stats.fetched_pages,
            "expanded_pages": len(stats.expanded_pages),
            "failed_pages": len(stats.failed_pages),
        },
        "expanded_pages": stats.expanded_pages,
        "failed_pages": stats.failed_pages,
        "tree_tags_missing_csv_metadata_sample": missing_metadata[:limit],
        "csv_tags_not_in_tree_sample": csv_not_in_tree[:limit],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Danbooru tag_tree.json from current wiki pages.")
    parser.add_argument("--out", default="data/tag_tree.generated.json", help="Output JSON path.")
    parser.add_argument("--report", default="data/tag_tree_report.json", help="CSV/tree comparison report path.")
    parser.add_argument("--csv", default="data/danbooru.csv", help="Tagcomplete-style CSV for canonicalization.")
    parser.add_argument("--root", default=ROOT_WIKI, help="Root wiki page slug or /wiki_pages/... URL.")
    parser.add_argument("--seed", default=None, help="Optional local tag_list_urls-style seed JSON.")
    parser.add_argument(
        "--seed-url",
        default=DEFAULT_SEED_URL,
        help="Remote tag_list_urls-style seed JSON. Use --seed-url '' to parse --root directly.",
    )
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between Danbooru requests in seconds.")
    parser.add_argument("--max-pages", type=int, default=None, help="Debug limit for expandable wiki pages.")
    parser.add_argument("--report-limit", type=int, default=500, help="Number of missing tags to include per report list.")
    parser.add_argument(
        "--skip-expand",
        action="append",
        default=[],
        help="Wiki page slug or URL to leave as a link instead of expanding. Can be repeated.",
    )
    parser.add_argument("--replace", action="store_true", help="Also write data/tag_tree.json after generation.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_path = Path(args.out)
    report_path = Path(args.report)
    csv_path = Path(args.csv) if args.csv else None

    tag_names, aliases = load_tag_csv(csv_path)
    stats = BuildStats()

    try:
        seed_path = Path(args.seed) if args.seed else None
        tree = load_seed_tree(seed_path, args.seed_url or None, args.delay)
        if tree is None:
            root_body = fetch_wiki_body(args.root, args.delay, stats)
            tree = parse_wiki_body(root_body, tag_names, aliases)
        else:
            normalize_seed_tree(tree)
    except RuntimeError as exc:
        print(f"Failed to load root tag tree seed: {exc}", file=sys.stderr)
        return 1

    skip_expand_slugs = set(DEFAULT_SKIP_EXPAND_SLUGS)
    skip_expand_slugs.update(normalize_slug(slug) for slug in args.skip_expand)
    expand_tree(tree, tag_names, aliases, stats, args.delay, args.max_pages, skip_expand_slugs)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tree, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(report_path, tree, tag_names, aliases, stats, args.report_limit)

    if args.replace:
        Path("data/tag_tree.json").write_text(json.dumps(tree, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"Wrote {report_path}")
    print(f"Fetched {stats.fetched_pages} pages, expanded {len(stats.expanded_pages)} pages")
    if stats.failed_pages:
        print(f"Warning: {len(stats.failed_pages)} pages failed; see {report_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
