#!/usr/bin/env python3
"""analyse.py - what briefing did in a recorded session, and what the gate blocked on.

Replaces the ad-hoc transcript archaeology that refining the mod kept needing:
the tool mix (which decides how much of the session briefing can even see), the
briefs that were delivered and through which tool, and the gate's conflicts --
including whether a blocking rule's document ever appeared in a brief, which is
the question the last few sessions kept raising.
"""
import json
import re
import sys
from collections import Counter

path = sys.argv[1]
tools = Counter()
hooks = Counter()
names = {}
briefs = []          # (tool name, files, decision titles, slugs, shown/total)
conflicts = Counter()
conflict_rules = []
briefed_pairs = set()   # (doc slug, rule id) pairs that reached the agent
rounds = 0


def walk_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from walk_strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk_strings(v)


lines = open(path, errors="replace").read().splitlines()
for line in lines:
    try:
        d = json.loads(line)
    except Exception:
        continue
    msg = d.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), list):
        for b in msg["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                tools[b.get("name")] += 1
                inp = b.get("input") or {}
                names[b.get("id")] = (
                    b.get("name"),
                    (inp.get("command") or inp.get("file_path") or "")[:70],
                )
    att = d.get("attachment")
    if isinstance(att, dict) and att.get("hookEvent"):
        hooks[att["hookEvent"]] += 1
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str) and content.startswith("Stop hook feedback"):
        rounds += 1
        for rid, level, reason in re.findall(
            r"CONFLICT (R-[A-Z0-9]+-\d+) \((MUST|SHOULD|MAY)\): ([^—]+)", content
        ):
            conflicts[(rid, level)] += 1
            conflict_rules.append((rid, level, reason.strip()[:90]))

    if "rules that apply to" not in line:
        continue
    for text in walk_strings(d):
        if "rules that apply to" not in text:
            continue
        files = re.findall(r"rules that apply to `([^`]+)`", text)
        titles = re.findall(r"^## (.+)$", text, re.M)
        slugs = sorted({s for s in re.findall(r"^- \[([^/\]]+)/", text, re.M)})
        shown = len(re.findall(r"^- \[", text, re.M))
        total = sum(int(m) for m in re.findall(r"^- \((?:\d+) of (\d+) rules shown\)", text, re.M))
        ids = set(re.findall(r'"tool_use_id":\s*"([^"]+)"', line)) | set(
            re.findall(r'"toolUseID":\s*"([^"]+)"', line)
        )
        via = sorted({names.get(i, ("?",))[0] for i in ids}) or ["?"]
        briefs.append((via, files, titles, slugs, shown, total or shown))
        for pair in re.findall(r"\[([a-z0-9-]+)/(R-[A-Z0-9]+-\d+)\]", text):
            briefed_pairs.add(pair)
        break

# De-duplicate: one delivery is recorded two or three times in a transcript.
seen = set()
unique = []
for b in briefs:
    # The raw hook reply is recorded alongside the rendered one, and its
    # escaping defeats these regexes, so it parses to no decisions at all.
    if not b[2]:
        continue
    key = (tuple(b[1]), tuple(b[2]))
    if key in seen:
        continue
    seen.add(key)
    unique.append(b)

print(f"tool calls:  {dict(tools.most_common())}")
print(f"hook events: {dict(hooks)}")
print("(for which Bash calls would have briefed, run `scenario.sh replay`)")

print(f"\nbriefs delivered: {len(unique)}")
briefed_slugs = set()
for via, files, titles, slugs, shown, total in unique:
    print(f"  via {'/'.join(via):<6} {', '.join(files) or '?'}")
    print(f"      {len(titles)} ADR(s), {shown} of {total} rules")
    for t in titles:
        print(f"      · {t[:76]}")
    briefed_slugs |= set(slugs)

print(f"\nStop gate: {rounds} round(s), {len(conflicts)} distinct rule(s)")
if conflict_rules:
    # Cross-referenced, not asserted. A conflict naming a rule the agent was
    # briefed on means briefing worked and was not enough; one naming a rule it
    # never saw means the gate judged it on something briefing withheld. Those
    # are opposite conclusions and the difference has to be checked.
    #
    # A conflict message gives only the bare rule id, and rule ids are not
    # unique across documents -- 46% of them collide in one measured corpus --
    # so a match on the id alone is reported as such rather than as proof.
    briefed_ids = {rid for _, rid in briefed_pairs}
    shown_once = set()
    for rid, level, reason in conflict_rules:
        if rid in shown_once:
            continue
        shown_once.add(rid)
        if rid in briefed_ids:
            docs = sorted(d for d, r in briefed_pairs if r == rid)
            where = f"BRIEFED (in {', '.join(docs)})" if len(docs) == 1 else \
                f"BRIEFED under {len(docs)} documents, so this id is ambiguous"
        else:
            where = "NOT briefed -- the agent was judged on a rule it never saw"
        print(f"    {rid} ({level}): {where}")
        print(f"      {reason}")
if briefed_slugs:
    print(f"\n  documents briefed this session: {len(briefed_slugs)}")
    for s in sorted(briefed_slugs):
        print(f"    {s}")
