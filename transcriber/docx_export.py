"""Word export: turns the summary Markdown from `render_markdown` into a styled .docx.

Only the Markdown subset `render_markdown` produces is supported: `#`–`###` headings,
`- ` bullets, pipe tables, `---`, paragraphs with **bold**, _italic_ and `code`
(timestamps). Converting the Markdown rather than the summary model keeps one source
of section order and wording for every summary type.
"""

import re
from io import BytesIO
from pathlib import Path

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# Present on both macOS (Pages, Word) and Windows; Calibri isn't installed on a Mac without Office.
FONT = "Arial"
TEXT = RGBColor(0x1D, 0x1D, 0x1F)  # headings and body copy: hierarchy comes from size/weight,
MUTED = RGBColor(0x6E, 0x6E, 0x73)  # not from a second hue
# The single accent: reserved for the few things that earn attention — the table's top
# edge and header labels, timestamps, bullet glyphs, the page number and the rules that
# frame the title block. Everything else stays neutral (text/muted/hairline gray) so the
# accent still reads as an accent on a long, table-heavy document.
ACCENT = RGBColor(0x2B, 0x6C, 0xB0)
ACCENT_HEX = "2B6CB0"
DIVIDER = "E3E3E8"  # hairline rules: table row lines, the section break, the footer rule

# (size pt, space before, space after) for `#`, `##`, `###`
HEADINGS = {1: (25, 0, 8), 2: (15, 22, 8), 3: (12, 14, 4)}
# Italic content can't start or end with "_", so model text like `__init__` stays literal.
INLINE = re.compile(r"\*\*(.+?)\*\*|(?<!\w)_([^_\s](?:.*?[^_\s])?)_(?!\w)|`([^`]+)`")
TABLE_SEPARATOR = re.compile(r"^\|(\s*:?-+:?\s*\|)+$")
MARGIN = Cm(2.2)
CONTENT_WIDTH = Cm(21) - 2 * MARGIN
# Column shares by column count: figures, competencies, action items (# is narrow).
COLUMN_SHARES = {2: (0.55, 0.45), 3: (0.3, 0.2, 0.5), 4: (0.06, 0.52, 0.24, 0.18)}
# Paragraph alignment by column count; only the action items' "#" column isn't left-aligned.
_LEFT, _CENTER = WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.CENTER
COLUMN_ALIGN = {4: (_CENTER, _LEFT, _LEFT, _LEFT)}


def _set_font(target, name: str) -> None:
    """Set the font for all scripts; theme font attributes would override the name."""
    rpr = target.element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("ascii", "hAnsi", "cs", "eastAsia"):
        fonts.set(qn(f"w:{attr}"), name)
        fonts.attrib.pop(qn(f"w:{attr}Theme"), None)


# w:rPr child order per the OOXML schema, from `w:spacing` onward — python-docx has no
# wrapper for `w:spacing`, so inserting it in the right slot (rather than appending
# blindly, which could land it after `w:sz`/`w:color`) is on us.
_RPR_AFTER_SPACING = ("w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u",
                      "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs",
                      "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath")


def _set_tracking(target, twips: int) -> None:
    """Character spacing (letter-tracking) in twentieths of a point; negative tightens,
    positive loosens (works on both a style and a run — both expose `.element`)."""
    rpr = target.element.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), str(twips))
    for tag in _RPR_AFTER_SPACING:
        successor = rpr.find(qn(tag))
        if successor is not None:
            successor.addprevious(spacing)
            return
    rpr.append(spacing)


def _border(side: str, color: str = DIVIDER, size: int = 4, space: int = 1) -> OxmlElement:
    """size is in eighths of a point, space in points."""
    border = OxmlElement(f"w:{side}")
    for key, value in {"val": "single", "sz": str(size), "space": str(space),
                       "color": color}.items():
        border.set(qn(f"w:{key}"), value)
    return border


def _setup_styles(doc) -> None:
    normal = doc.styles["Normal"]
    _set_font(normal, FONT)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = TEXT
    normal.paragraph_format.space_after = Pt(8)
    normal.paragraph_format.line_spacing = 1.28
    lang = OxmlElement("w:lang")
    lang.set(qn("w:val"), "ru-RU")
    normal.element.get_or_add_rPr().append(lang)  # Russian spell check

    for level, (size, before, after) in HEADINGS.items():
        style = doc.styles[f"Heading {level}"]
        _set_font(style, FONT)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.italic = False
        style.font.color.rgb = TEXT  # one neutral ink for all levels: size and weight
        style.paragraph_format.space_before = Pt(before)  # carry the hierarchy, not a second hue
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
        if level == 1:  # tight, confident title tracking
            _set_tracking(style, -8)
        if level == 2:  # thin accent rule; left bars aren't rendered by Pages / Quick Look
            borders = OxmlElement("w:pBdr")
            borders.append(_border("bottom", ACCENT_HEX, size=6, space=4))
            style.element.get_or_add_pPr().append(borders)

    bullet = doc.styles["List Bullet"]
    bullet.paragraph_format.space_after = Pt(3)
    # Blue bullet glyphs: the color lives in the numbering definitions, not the style.
    for lvl in doc.part.numbering_part.element.iter(qn("w:lvl")):
        rpr = lvl.find(qn("w:rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            lvl.append(rpr)
        color = OxmlElement("w:color")
        color.set(qn("w:val"), ACCENT_HEX)
        rpr.append(color)


def _setup_page(doc) -> None:
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)  # A4
    section.top_margin = section.bottom_margin = Cm(2)
    section.left_margin = section.right_margin = MARGIN

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    borders = OxmlElement("w:pBdr")
    borders.append(_border("top", size=4, space=4))  # hairline: a printed page, not a banner
    footer._p.get_or_add_pPr().append(borders)
    run = footer.add_run()
    run.font.size, run.font.color.rgb = Pt(9), MUTED
    for tag, text in (("begin", None), (None, "PAGE"), ("end", None)):
        if tag:
            field = OxmlElement("w:fldChar")
            field.set(qn("w:fldCharType"), tag)
        else:
            field = OxmlElement("w:instrText")
            field.text = text
        run._r.append(field)


def _add_inline(paragraph, text: str, bold: bool = False) -> None:
    """Add text with **bold**, _italic_ (muted) and `code` (timestamps, small and blue)."""
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            paragraph.add_run(text[pos:m.start()]).bold = bold or None
        strong, em, code = m.groups()
        if strong is not None:
            paragraph.add_run(strong).bold = True
        elif em is not None:
            run = paragraph.add_run(em)
            run.italic, run.bold = True, bold or None
            run.font.color.rgb = MUTED
        else:
            run = paragraph.add_run(code)
            run.font.size, run.font.color.rgb, run.bold = Pt(9), ACCENT, True
        pos = m.end()
    if pos < len(text):
        paragraph.add_run(text[pos:]).bold = bold or None


def _cells(row: str) -> list[str]:
    parts = re.split(r"(?<!\\)\|", row.strip())[1:-1]
    return [p.strip().replace("\\|", "|") for p in parts]


def _add_table(doc, rows: list[str]) -> None:
    header, body = _cells(rows[0]), [_cells(r) for r in rows[1:] if not TABLE_SEPARATOR.match(r)]
    table = doc.add_table(rows=1 + len(body), cols=len(header))
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    # No fills, no vertical lines: an accent-colored top edge marks the table as a block,
    # a neutral hairline separates rows — the header gets its own, stronger rule below.
    borders = OxmlElement("w:tblBorders")
    borders.append(_border("top", ACCENT_HEX, size=12))
    for side in ("bottom", "insideH"):
        borders.append(_border(side))
    table._tbl.tblPr.append(borders)
    margins = OxmlElement("w:tblCellMar")
    for side, width in (("left", "100"), ("right", "100"), ("top", "40"), ("bottom", "40")):
        margin = OxmlElement(f"w:{side}")
        margin.set(qn("w:w"), width)  # twips
        margin.set(qn("w:type"), "dxa")
        margins.append(margin)
    table._tbl.tblPr.append(margins)

    # Full content width with fixed columns; widths go both to the grid (Pages,
    # Quick Look read it) and to every cell (Word reads those).
    table.autofit = False
    shares = COLUMN_SHARES.get(len(header), [1 / len(header)] * len(header))
    for grid_col, column, share in zip(table._tbl.tblGrid.gridCol_lst, table.columns, shares,
                                       strict=False):
        grid_col.w = int(CONTENT_WIDTH * share)
        for cell in column.cells:
            cell.width = int(CONTENT_WIDTH * share)

    aligns = COLUMN_ALIGN.get(len(header), [_LEFT] * len(header))
    for r, values in enumerate([header, *body]):
        row = table.rows[r]
        for c, value in enumerate(values[:len(header)]):
            cell = row.cells[c]
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            paragraph = cell.paragraphs[0]
            paragraph.alignment = aligns[c]
            paragraph.paragraph_format.space_before = Pt(3)
            paragraph.paragraph_format.space_after = Pt(3)
            _add_inline(paragraph, value, bold=r == 0)
            if r == 0:  # small, spaced-out, capitalized labels rather than a filled band
                tc_borders = OxmlElement("w:tcBorders")
                tc_borders.append(_border("bottom", ACCENT_HEX, size=8))
                cell._tc.get_or_add_tcPr().append(tc_borders)
                for run in paragraph.runs:
                    run.font.size, run.font.color.rgb, run.font.all_caps = Pt(9), ACCENT, True
                    _set_tracking(run, 8)
    header_row = table.rows[0]._tr.get_or_add_trPr()
    header_row.append(OxmlElement("w:tblHeader"))  # repeat on every page
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def _add_rule(doc) -> None:
    """A quiet chapter break before "Ход обсуждения": neutral, not accent-colored, so it
    doesn't compete with the section heading's own accent rule right after it."""
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(20)
    ppr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    borders.append(_border("bottom", DIVIDER, size=4))
    ppr.append(borders)


def markdown_to_docx(md: str) -> bytes:
    doc = Document()
    _setup_styles(doc)
    _setup_page(doc)

    lines = md.splitlines()
    first_paragraph = True  # the line under the title is the meta line
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if heading := re.match(r"^(#{1,3}) (.+)$", line):
            level = len(heading[1])
            if level == 1:
                doc.core_properties.title = heading[2]
            _add_inline(doc.add_heading(level=level), heading[2])
        elif line.startswith("- "):
            _add_inline(doc.add_paragraph(style="List Bullet"), line[2:])
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(lines[i])
                i += 1
            _add_table(doc, rows)
            continue
        elif line.strip() == "---":
            _add_rule(doc)
        else:
            paragraph = doc.add_paragraph()
            _add_inline(paragraph, line)
            if first_paragraph and doc.core_properties.title:  # meta line under the title:
                for run in paragraph.runs:                      # tracked labels, thin rule
                    run.font.size = Pt(9.5)
                    if run.bold:
                        run.font.color.rgb, run.font.all_caps = ACCENT, True
                        _set_tracking(run, 8)
                    else:
                        run.font.color.rgb = MUTED
                paragraph.paragraph_format.space_after = Pt(18)
                borders = OxmlElement("w:pBdr")
                borders.append(_border("bottom", ACCENT_HEX, size=6, space=6))
                paragraph._p.get_or_add_pPr().append(borders)
            first_paragraph = False
        i += 1

    out = BytesIO()
    doc.save(out)
    return out.getvalue()


def save_docx(md: str, path: Path) -> None:
    path.write_bytes(markdown_to_docx(md))
