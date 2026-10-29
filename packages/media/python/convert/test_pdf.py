"""
pdf.py on the fixture PDFs from src/test/fixtures, for real: Linux CI runs it with `uv run --locked pytest`.
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
FIXTURES = HERE / "../../src/test/fixtures"


def convert(name):
    """The JSON document pdf.py prints for a fixture."""
    stdout = subprocess.run([sys.executable, HERE / "pdf.py", FIXTURES / name], check=True, capture_output=True).stdout
    return json.loads(stdout)


def test_a_scanned_page_counts_as_textless():
    document = convert("scanned.pdf")

    assert (len(document["pages"]), document["textless"]) == (3, 2)


def test_the_outline_and_page_text_come_through():
    document = convert("book.pdf")

    assert document["title"] == "Tiny Concurrency"
    assert [entry[1:] for entry in document["toc"] if entry[0] == 1] == [["Preface", 1], ["Threads", 2], ["Locks", 4]]
    assert "Threads share the address space" in document["pages"][2]
    assert document["textless"] == 0
