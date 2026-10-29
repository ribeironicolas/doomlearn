"""
Marks where each table-of-contents entry starts in an ebook, using Calibre's own Python:
`calibre-debug -e ebook.py <file> <out>`.

Writes a copy of the book to <out> (same format) with a line `⟦n⟧` at the start of TOC entry n,
so the plain-text conversion can be split at TOC entries, and prints
{"title", "toc": [{"level", "title"}]} as JSON, the TOC flattened in reading order.
"""
import json
import sys
from collections import Counter

from calibre.ebooks.oeb.polish.container import get_container
from calibre.ebooks.oeb.polish.toc import get_toc

XHTML = "http://www.w3.org/1999/xhtml"

book, out = sys.argv[-2], sys.argv[-1]
container = get_container(book, tweak_mode=True)
# (file, element the entry starts at or None for the top of the file, level, title), in reading order.
entries = []
stack = [(node, 1) for node in reversed(list(get_toc(container)))]
while stack:
    node, level = stack.pop()
    stack.extend((child, level + 1) for child in reversed(list(node)))
    # An entry that points nowhere can't be located in the text.
    if not node.dest or node.dest not in container.name_path_map:
        continue
    target = container.parsed(node.dest).xpath("//*[@id=$frag]", frag=node.frag) if node.frag else []
    entries.append((node.dest, target[0] if target else None, level, node.title or ""))

# A TOC with fewer than 2 chapters (e.g. one "Beginning" entry) can't split the book. A chapter's title
# usually opens its own file, so instead every block styled (tag and class) like the opening block of
# 2+ files starts a chapter titled with its text. A style matching more blocks than there are files is
# body text, not titles, and the TOC is kept. Sections come from a printed contents page, the file listing
# 2+ chapter titles in another style: its other entries are section titles, and every block elsewhere
# whose text is one of them starts a section. Without such a page, sections go unmarked.
if sum(level == 1 for _, _, level, _ in entries) < 2:
    style = lambda e: (e.tag, e.get("class"))
    text = lambda e: "".join(e.itertext()).strip()
    # Per spine file with a body (not, say, an SVG cover), its elements with text of their own, in reading order.
    bodies = {name: container.parsed(name).find(f"{{{XHTML}}}body") for name, _ in container.spine_names}
    blocks = {name: [e for e in body.iter(f"{{{XHTML}}}*") if (e.text or "").strip()] for name, body in bodies.items() if body is not None}
    openers = Counter(style(found[0]) for found in blocks.values() if found)
    opener, files = openers.most_common(1)[0] if openers else (None, 0)
    titles = {text(e) for found in blocks.values() for e in found if style(e) == opener}
    if files >= 2 and sum(style(e) == opener for found in blocks.values() for e in found) <= len(blocks):
        contents = next((name for name, found in blocks.items() if sum(style(e) != opener and text(e) in titles for e in found) >= 2), None)
        sections = {text(e) for e in blocks.get(contents, [])} - titles
        entries = [
            (name, e, 1 if style(e) == opener else 2, text(e))
            for name, found in blocks.items()
            if name != contents
            for e in found
            if style(e) == opener or text(e) in sections
        ]

toc = []
for name, target, level, title in entries:
    root = container.parsed(name)
    marker = root.makeelement(f"{{{XHTML}}}p")
    marker.text = f"⟦{len(toc)}⟧"
    if target is not None:
        target.addprevious(marker)
    else:
        root.find(f"{{{XHTML}}}body").insert(0, marker)
    container.dirty(name)
    toc.append({"level": level, "title": title})
container.commit(out)
print(json.dumps({"title": container.mi.title, "toc": toc}))
