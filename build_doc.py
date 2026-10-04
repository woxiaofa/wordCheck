# -*- coding: utf-8 -*-
"""把 Markdown 源文档转换为排版良好的 DOCX。仅使用 python-docx。"""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

WORKDIR = Path(r"D:\Documents\deepseek-harness\default-workspace")
SRC = WORKDIR / "背单词教练小程序-可行性与产品方案.md"
OUT = WORKDIR / "背单词教练小程序-可行性与产品方案.docx"

FONT_CN = "微软雅黑"
FONT_EN = "Segoe UI"
FONT_CODE = "Consolas"

# 星号强调 -> 加粗
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def set_run_font(run, cn=FONT_CN, en=FONT_EN, size=None, bold=None, color=None):
    if size is not None:
        run.font.size = size
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run.font.name = en
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), en)
    rfonts.set(qn("w:hAnsi"), en)
    rfonts.set(qn("w:eastAsia"), cn)


def style_font(style, cn=FONT_CN, en=FONT_EN):
    style.font.name = en
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), en)
    rfonts.set(qn("w:hAnsi"), en)
    rfonts.set(qn("w:eastAsia"), cn)
    rfonts.set(qn("w:cs"), en)


def add_inline(paragraph, text, base_bold=False, size=Pt(10.5), color=None, cn=FONT_CN):
    """处理 **加粗** 与 `行内代码`。"""
    for chunk in re.split(r"(`[^`]+`)", text):
        if not chunk:
            continue
        if chunk.startswith("`") and chunk.endswith("`") and len(chunk) > 2:
            run = paragraph.add_run(chunk[1:-1])
            set_run_font(run, cn=cn, en=FONT_CODE, size=Pt(9.5), bold=base_bold)
            continue
        for piece in re.split(r"(\*\*.+?\*\*)", chunk):
            if not piece:
                continue
            if piece.startswith("**") and piece.endswith("**"):
                run = paragraph.add_run(piece[2:-2])
                set_run_font(run, cn=cn, size=size, bold=True, color=color)
            else:
                run = paragraph.add_run(piece)
                set_run_font(run, cn=cn, size=size, bold=base_bold, color=color)


def shade(cell, hex_fill):
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcpr.append(shd)


def set_cell_margins(cell, top=60, bottom=60, left=100, right=100):
    tcpr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for tag, val in (("top", top), ("bottom", bottom), ("start", left), ("end", right)):
        node = OxmlElement(f"w:{tag}")
        node.set(qn("w:w"), str(val))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tcpr.append(mar)


def add_page_field(paragraph):
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._element.append(fld_begin)
    run._element.append(instr)
    run._element.append(fld_end)
    set_run_font(run, size=Pt(9), color=RGBColor(0x88, 0x88, 0x88))


def add_toc_field(paragraph):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = r'TOC \o "1-2" \h \z \u'
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "（打开文档后按 Ctrl+A、F9 可刷新目录页码）"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, sep, placeholder, end):
        run._element.append(node)
    set_run_font(run, size=Pt(10), color=RGBColor(0x55, 0x55, 0x55))


def configure_styles(doc):
    normal = doc.styles["Normal"]
    style_font(normal)
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.35

    specs = {
        "Heading 1": (16.5, RGBColor(0x0F, 0x3D, 0x66), Pt(18), Pt(8)),
        "Heading 2": (13.5, RGBColor(0x14, 0x5A, 0x91), Pt(12), Pt(6)),
        "Heading 3": (11.5, RGBColor(0x1F, 0x6F, 0xAD), Pt(9), Pt(4)),
    }
    for name, (size, color, before, after) in specs.items():
        st = doc.styles[name]
        style_font(st)
        st.font.size = Pt(size)
        st.font.color.rgb = color
        st.font.bold = True
        st.paragraph_format.space_before = before
        st.paragraph_format.space_after = after
        st.paragraph_format.keep_with_next = True

    for name in ("List Bullet", "List Number"):
        st = doc.styles[name]
        style_font(st)
        st.font.size = Pt(10.5)


def parse_blocks(lines):
    blocks = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        if stripped == "### 表 |":
            i += 1
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                rows.append(cells)
                i += 1
            blocks.append(("table", rows))
            continue

        if stripped.startswith("```"):
            i += 1
            code = []
            while i < n and not lines[i].strip().startswith("```"):
                code.append(lines[i].rstrip("\n"))
                i += 1
            i += 1
            blocks.append(("code", code))
            continue

        m = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        if m:
            blocks.append((f"h{len(m.group(1))}", m.group(2).strip()))
            i += 1
            continue

        if stripped.startswith(">"):
            quote = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            blocks.append(("quote", quote))
            continue

        if re.match(r"^[-*]\s+", stripped):
            items = []
            while i < n and re.match(r"^[-*]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[i].strip()))
                i += 1
            blocks.append(("bullets", items))
            continue

        if re.match(r"^\d+\.\s+", stripped):
            items = []
            while i < n and re.match(r"^\d+\.\s+", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            blocks.append(("numbers", items))
            continue

        blocks.append(("p", stripped))
        i += 1
    return blocks


def build():
    blocks = parse_blocks(SRC.read_text(encoding="utf-8").splitlines())

    doc = Document()
    configure_styles(doc)

    section = doc.sections[0]
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.3)
    section.right_margin = Cm(2.3)
    usable = section.page_width - section.left_margin - section.right_margin

    # 页脚页码
    footer_p = section.footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_page_field(footer_p)

    title = None
    body_started = False
    toc_done = False

    for kind, payload in blocks:
        if kind == "h1" and title is None:
            title = payload
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(24)
            p.paragraph_format.space_after = Pt(10)
            add_inline(p, f"**{payload}**", size=Pt(22), color=RGBColor(0x0F, 0x3D, 0x66))
            continue

        if kind == "quote":
            for q in payload:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(0.4)
                p.paragraph_format.space_after = Pt(3)
                add_inline(p, q, size=Pt(9.5), color=RGBColor(0x55, 0x55, 0x55))
            continue

        if not body_started:
            # 在正文开始前插入目录
            body_started = True
            doc.add_page_break()
            hp = doc.add_paragraph(style="Heading 1")
            add_inline(hp, "目录", size=Pt(16.5), color=RGBColor(0x0F, 0x3D, 0x66))
            toc_done = True
            add_toc_field(doc.add_paragraph())
            doc.add_page_break()

        if kind == "h1":
            p = doc.add_paragraph(style="Heading 1")
            add_inline(p, payload, size=Pt(16.5), color=RGBColor(0x0F, 0x3D, 0x66))
        elif kind == "h2":
            p = doc.add_paragraph(style="Heading 2")
            add_inline(p, payload, size=Pt(13.5), color=RGBColor(0x14, 0x5A, 0x91))
        elif kind == "h3":
            p = doc.add_paragraph(style="Heading 3")
            add_inline(p, payload, size=Pt(11.5), color=RGBColor(0x1F, 0x6F, 0xAD))
        elif kind == "p":
            p = doc.add_paragraph()
            p.paragraph_format.first_line_indent = Cm(0)
            add_inline(p, payload)
        elif kind == "bullets":
            for item in payload:
                p = doc.add_paragraph(style="List Bullet")
                p.paragraph_format.space_after = Pt(2)
                add_inline(p, item)
        elif kind == "numbers":
            for item in payload:
                p = doc.add_paragraph(style="List Number")
                p.paragraph_format.space_after = Pt(2)
                add_inline(p, item)
        elif kind == "code":
            for idx, cline in enumerate(payload):
                p = doc.add_paragraph()
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.space_before = Pt(4) if idx == 0 else Pt(0)
                p.paragraph_format.left_indent = Cm(0.35)
                p.paragraph_format.line_spacing = 1.1
                run = p.add_run(cline if cline else " ")
                set_run_font(run, cn=FONT_CODE, en=FONT_CODE, size=Pt(8.8),
                             color=RGBColor(0x1A, 0x1A, 0x1A))
            doc.add_paragraph().paragraph_format.space_after = Pt(0)
        elif kind == "table":
            rows = payload
            header = rows[0]
            data = rows[1:]
            table = doc.add_table(rows=1, cols=len(header))
            table.style = "Table Grid"
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            table.autofit = False

            header_cells = table.rows[0].cells
            for c_idx, text in enumerate(header):
                cell = header_cells[c_idx]
                cell.text = ""
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.line_spacing = 1.15
                add_inline(p, text, base_bold=True, size=Pt(9.5),
                           color=RGBColor(0xFF, 0xFF, 0xFF))
                shade(cell, "145A91")
                set_cell_margins(cell)

            for r_idx, row in enumerate(data):
                cells = table.add_row().cells
                for c_idx in range(len(header)):
                    text = row[c_idx] if c_idx < len(row) else ""
                    cell = cells[c_idx]
                    cell.text = ""
                    p = cell.paragraphs[0]
                    p.paragraph_format.space_after = Pt(2)
                    p.paragraph_format.line_spacing = 1.15
                    add_inline(p, text, size=Pt(9.5))
                    if r_idx % 2 == 1:
                        shade(cell, "EAF1F8")
                    set_cell_margins(cell)

            widths = allocate_widths(header, usable)
            for row in table.rows:
                for c_idx, cell in enumerate(row.cells):
                    cell.width = widths[c_idx]
            doc.add_paragraph().paragraph_format.space_after = Pt(0)

    doc.save(OUT)
    print(f"saved: {OUT}")
    return OUT


def allocate_widths(header, usable):
    n = len(header)
    if n == 3:
        ratios = [0.24, 0.36, 0.40]
    elif n == 4:
        ratios = [0.16, 0.30, 0.30, 0.24]
    elif n == 5:
        ratios = [0.14, 0.13, 0.26, 0.32, 0.15]
    elif n == 6:
        ratios = [0.13, 0.15, 0.09, 0.14, 0.36, 0.13]
    elif n == 8:
        ratios = [0.11, 0.12, 0.07, 0.13, 0.26, 0.20, 0.06, 0.05]
    else:
        ratios = [1.0 / n] * n
    return [int(usable * r) for r in ratios]


if __name__ == "__main__":
    build()
