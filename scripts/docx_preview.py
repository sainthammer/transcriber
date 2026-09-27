"""Build the Word downloads for every summary type and render their pages to PNG, so the
document design can be reviewed by eye (by a person or an agent reading the images).

Documents are built exactly like the server's `summary.docx` / `digest.docx` downloads:
no timestamps, empty sections stripped. Content comes from the synthetic fixtures in
`web/src/dev/fixtures/` and, for types without one, from the test fixture
(`tests/test_summary_types.make_data`) — never from `recordings/`.

Rendering needs LibreOffice (`soffice`) and poppler (`pdftoppm`); without them only the
.docx files are written. LibreOffice is close to Word but not identical — check the final
result in Word or Pages.

    uv run python scripts/docx_preview.py            # -> .docx-preview/current/
    uv run python scripts/docx_preview.py --label before
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "web" / "src" / "dev" / "fixtures"
OUT = ROOT / ".docx-preview"
SOFFICE_APP = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")

sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from transcriber.docx_export import markdown_to_docx  # noqa: E402
from transcriber.summary_types import (  # noqa: E402
    TYPES, parse_summary, render_digest, render_markdown, strip_empty_sections,
    transcript_duration,
)


def load_samples() -> dict[str, tuple[dict, str | None]]:
    """Summary data and duration per type: a web fixture if there is one, else the test one."""
    from test_summary_types import make_data

    samples = {}
    for type_id in TYPES:
        data_file = FIXTURES / f"{type_id}.summary.json"
        if data_file.exists():
            transcript = FIXTURES / f"{type_id}.txt"
            duration = (transcript_duration(transcript.read_text(encoding="utf-8"))
                        if transcript.exists() else None)
            samples[type_id] = json.loads(data_file.read_text(encoding="utf-8")), duration
        else:
            samples[type_id] = make_data(type_id), "~35 мин"
    return samples


def build(out: Path) -> list[Path]:
    docs = []
    for type_id, (data, duration) in load_samples().items():
        s = parse_summary(data)
        variants = {"summary": render_markdown(s, duration, timestamps=False),
                    "digest": render_digest(s, duration)}
        for name, md in variants.items():
            path = out / f"{type_id}.{name}.docx"
            path.write_bytes(markdown_to_docx(strip_empty_sections(md)))
            docs.append(path)
    return docs


def find_soffice() -> str | None:
    found = shutil.which("soffice")
    if found:
        return found
    return str(SOFFICE_APP) if SOFFICE_APP.exists() else None


def render(docs: list[Path], out: Path, dpi: int) -> bool:
    soffice, pdftoppm = find_soffice(), shutil.which("pdftoppm")
    if not soffice or not pdftoppm:
        print("Для PNG нужны LibreOffice и poppler: "
              "brew install --cask libreoffice && brew install poppler")
        return False
    # A throwaway profile, so a running LibreOffice doesn't swallow the headless call.
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run([soffice, f"-env:UserInstallation=file://{profile}", "--headless",
                        "--convert-to", "pdf", "--outdir", str(out), *map(str, docs)],
                       check=True, capture_output=True)
    for doc in docs:
        pdf = doc.with_suffix(".pdf")
        subprocess.run([pdftoppm, "-png", "-r", str(dpi), str(pdf), str(doc.with_suffix(""))],
                       check=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Превью Word-версий summary всех типов")
    parser.add_argument("--label", default="current",
                        help="подпапка в .docx-preview/, например before (по умолчанию current)")
    parser.add_argument("--dpi", type=int, default=80, help="разрешение PNG (по умолчанию 80)")
    args = parser.parse_args()

    out = OUT / args.label
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    docs = build(out)
    rendered = render(docs, out, args.dpi)
    print(f"Документов: {len(docs)}{', страницы в PNG' if rendered else ''} — {out.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
