"""
Converts a PDF to page-numbered Markdown with pymupdf4llm (layout module off, page chunks on).

Prints {"title", "toc": [[level, title, page]], "pages": [text], "textless"} as JSON,
`textless` counting the pages without a text layer.
"""
import json
import sys

import pymupdf
import pymupdf4llm

# The layout module drops spaces inside code; off, code keeps its line breaks and spacing.
pymupdf4llm.use_layout(False)

doc = pymupdf.open(sys.argv[1])
print(json.dumps({
    "title": doc.metadata.get("title"),
    "toc": doc.get_toc(),
    "pages": [chunk["text"] for chunk in pymupdf4llm.to_markdown(doc, page_chunks=True)],
    "textless": sum(not page.get_text().strip() for page in doc),
}))
