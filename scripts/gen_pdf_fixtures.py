"""
Generate PDF fixtures from raw PDF syntax using only the Python stdlib.

Deliberately independent of pdf_oxide (the library under test) and of
ReportLab, so a fixture bug cannot be shared with the parser being
exercised. Every object offset in the xref table is computed from the
actual serialized bytes.
"""
import sys, zlib, os

def build(objects, root=1):
    """objects: list of bytes bodies, 1-indexed by position."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root {root} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    return bytes(out)

def stream(dict_extra, data, compress=True):
    if compress:
        data = zlib.compress(data)
        filt = b"/Filter /FlateDecode "
    else:
        filt = b""
    return (b"<< " + filt + f"/Length {len(data)} ".encode() + dict_extra +
            b">>\nstream\n" + data + b"\nendstream")

def text_ops(lines, x=72, y=720, size=11, font=b"F1", leading=16):
    ops = [b"BT", f"/{font.decode()} {size} Tf".encode(), f"{leading} TL".encode(),
           f"1 0 0 1 {x} {y} Tm".encode()]
    for ln in lines:
        esc = ln.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        ops.append(f"({esc}) Tj T*".encode())
    ops.append(b"ET")
    return b"\n".join(ops)

HELV = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
# A math font family. Real TeX math PDFs reference CMMI/CMSY; naming the
# BaseFont this way is what a math-font heuristic must key on.
CMMI = b"<< /Type /Font /Subtype /Type1 /BaseFont /CMMI10 >>"
SYMBOL = b"<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>"

def page(contents_ref, resources, mediabox=b"[0 0 612 792]"):
    return (b"<< /Type /Page /Parent 2 0 R /MediaBox " + mediabox +
            b" /Resources " + resources + b" /Contents " + contents_ref + b" R >>")

def pages(kids, count):
    return f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode()

CATALOG = b"<< /Type /Catalog /Pages 2 0 R >>"

def rgb_image(w, h, rgb=(30, 90, 200)):
    """Uncompressed RGB image XObject — a real /Subtype /Image."""
    raw = bytes(rgb) * (w * h)
    hdr = (b"/Type /XObject /Subtype /Image " +
           f"/Width {w} /Height {h} ".encode() +
           b"/ColorSpace /DeviceRGB /BitsPerComponent 8 ")
    return stream(hdr, raw)

# ── fixtures ──────────────────────────────────────────────────────────

def f_prose():
    body = text_ops([
        "Quarterly Operations Summary",
        "Revenue increased across all regions during the period under review.",
        "The northern territory contributed the largest absolute gain, while",
        "the southern territory lagged because of supply constraints that",
        "persisted through the second half of the quarter.",
        "Management expects the constraint to ease in the coming period.",
    ])
    return build([CATALOG, pages("3 0 R", 1),
                  page(b"4 0 ", b"<< /Font << /F1 5 0 R >> >>"),
                  stream(b"", body), HELV])

def f_vector_chart():
    """Text plus a vector bar chart — paths only, NO image XObject."""
    ops = [text_ops(["Figure 1: Monthly revenue"], y=730).decode("latin-1")]
    ops.append("0.2 0.4 0.8 rg")
    for i, h in enumerate([60, 95, 140, 110, 175, 130]):
        x = 90 + i * 60
        ops.append(f"{x} 400 40 {h} re f")
    ops.append("0 G 0.8 w")
    ops.append("80 400 m 460 400 l S")     # x axis
    ops.append("80 400 m 80 600 l S")      # y axis
    for i in range(5):                      # gridlines
        y = 420 + i * 40
        ops.append(f"80 {y} m 460 {y} l S")
    ops.append("2 w 0.9 0.2 0.2 RG")
    ops.append("90 430 m 150 470 l 210 455 l 270 520 l 330 500 l 390 560 l S")
    body = "\n".join(ops).encode("latin-1")
    return build([CATALOG, pages("3 0 R", 1),
                  page(b"4 0 ", b"<< /Font << /F1 5 0 R >> >>"),
                  stream(b"", body), HELV])

def f_ruled_table():
    """A ruled table: horizontal/vertical rules plus cell text."""
    ops = [text_ops(["Table 2: Regional totals"], y=730).decode("latin-1")]
    ops.append("0 G 0.7 w")
    top, left, rowh, colw, ncol, nrow = 690, 80, 24, 110, 3, 4
    for r in range(nrow + 1):
        y = top - r * rowh
        ops.append(f"{left} {y} m {left + colw * ncol} {y} l S")
    for c in range(ncol + 1):
        x = left + c * colw
        ops.append(f"{x} {top} m {x} {top - rowh * nrow} l S")
    cells = [["Region", "Q3", "Q4"], ["North", "41", "55"],
             ["South", "33", "38"], ["East", "27", "44"]]
    for r, row in enumerate(cells):
        for c, val in enumerate(row):
            x = left + c * colw + 6
            y = top - r * rowh - 16
            ops.append(text_ops([val], x=x, y=y, size=10).decode("latin-1"))
    body = "\n".join(ops).encode("latin-1")
    return build([CATALOG, pages("3 0 R", 1),
                  page(b"4 0 ", b"<< /Font << /F1 5 0 R >> >>"),
                  stream(b"", body), HELV])

def f_equation():
    """Prose plus a display equation set in CMMI/Symbol math fonts."""
    parts = [text_ops(["Theorem 3.1. The estimator converges in probability:"],
                      y=700).decode("latin-1")]
    parts.append(text_ops(["f (x) =", "n", "i=1"], x=150, y=640, size=13,
                          font=b"F2").decode("latin-1"))
    parts.append(text_ops(["\\345", "\\326", "\\245"], x=230, y=640, size=16,
                          font=b"F3").decode("latin-1"))
    parts.append(text_ops(["where the sum runs over all observed samples."],
                          y=580).decode("latin-1"))
    body = "\n".join(parts).encode("latin-1")
    res = b"<< /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >>"
    return build([CATALOG, pages("3 0 R", 1), page(b"4 0 ", res),
                  stream(b"", body), HELV, CMMI, SYMBOL])

def f_raster_figure():
    """Native text plus an embedded raster image."""
    ops = [text_ops(["Figure 4: sensor output (photograph)"], y=730).decode("latin-1")]
    ops.append("q 300 0 0 200 ophold 400 cm /Im1 Do Q".replace("ophold", "150"))
    ops.append(text_ops(["The captured frame is reproduced above."],
                        y=360).decode("latin-1"))
    body = "\n".join(ops).encode("latin-1")
    res = b"<< /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >>"
    return build([CATALOG, pages("3 0 R", 1), page(b"4 0 ", res),
                  stream(b"", body), HELV, rgb_image(48, 32)])

def f_scan():
    """A full-page image and no text at all."""
    body = b"q 612 0 0 792 0 0 cm /Im1 Do Q"
    res = b"<< /XObject << /Im1 5 0 R >> >>"
    return build([CATALOG, pages("3 0 R", 1), page(b"4 0 ", res),
                  stream(b"", body), rgb_image(64, 80, (220, 220, 210))])

def f_broken_glyphs():
    """
    A TrueType subset font with a symbolic encoding and NO ToUnicode map.
    Extraction has no way to map codes back to characters — the mojibake
    case that must trigger a render.
    """
    font = (b"<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Custom "
            b"/FirstChar 1 /LastChar 6 /Widths [600 600 600 600 600 600] "
            b"/FontDescriptor 6 0 R >>")
    desc = (b"<< /Type /FontDescriptor /FontName /AAAAAA+Custom /Flags 4 "
            b"/ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 700 "
            b"/StemV 80 /FontBBox [0 -250 600 750] >>")
    body = b"BT /F1 14 Tf 1 0 0 1 72 700 Tm <010203040506> Tj ET"
    res = b"<< /Font << /F1 5 0 R >> >>"
    return build([CATALOG, pages("3 0 R", 1), page(b"4 0 ", res),
                  stream(b"", body), font, desc])

def f_mixed():
    """Five pages: prose, vector chart, ruled table, raster figure, scan."""
    objs = [CATALOG, None]  # pages filled in below
    kids, contents_specs = [], []
    page_objs = []

    # Build shared resources first.
    helv_ref = None
    # Object numbering: 1 catalog, 2 pages, then per page: page obj, content obj.
    # Followed by font + image objects.
    n_pages = 5
    first_page_obj = 3
    first_content_obj = first_page_obj + n_pages
    font_obj = first_content_obj + n_pages
    img_obj = font_obj + 1

    bodies = []
    # p1 prose
    bodies.append(text_ops(["Section 1 - Overview",
                            "This document mixes prose, vector graphics, a ruled",
                            "table, a photograph, and a scanned page."]))
    # p2 vector chart
    ops = [text_ops(["Section 2 - Figure"], y=730).decode("latin-1"), "0.2 0.4 0.8 rg"]
    for i, h in enumerate([50, 120, 80, 160]):
        ops.append(f"{100 + i * 70} 400 45 {h} re f")
    ops.append("0 G 80 400 m 440 400 l S")
    bodies.append("\n".join(ops).encode("latin-1"))
    # p3 ruled table
    ops = [text_ops(["Section 3 - Table"], y=730).decode("latin-1"), "0 G 0.7 w"]
    for r in range(4):
        ops.append(f"80 {690 - r * 24} m 410 {690 - r * 24} l S")
    for c in range(4):
        ops.append(f"{80 + c * 110} 690 m {80 + c * 110} 618 l S")
    for r, row in enumerate([["Item", "Qty", "Cost"], ["Bolt", "12", "4.50"],
                             ["Nut", "30", "1.20"]]):
        for c, v in enumerate(row):
            ops.append(text_ops([v], x=86 + c * 110, y=674 - r * 24, size=10).decode("latin-1"))
    bodies.append("\n".join(ops).encode("latin-1"))
    # p4 raster figure
    ops = [text_ops(["Section 4 - Photograph"], y=730).decode("latin-1"),
           "q 280 0 0 180 160 420 cm /Im1 Do Q"]
    bodies.append("\n".join(ops).encode("latin-1"))
    # p5 scan
    bodies.append(b"q 612 0 0 792 0 0 cm /Im1 Do Q")

    res_text = f"<< /Font << /F1 {font_obj} 0 R >> >>".encode()
    res_img = (f"<< /Font << /F1 {font_obj} 0 R >> "
               f"/XObject << /Im1 {img_obj} 0 R >> >>").encode()
    res_scan = f"<< /XObject << /Im1 {img_obj} 0 R >> >>".encode()
    resources = [res_text, res_text, res_text, res_img, res_scan]

    for i in range(n_pages):
        page_objs.append(page(f"{first_content_obj + i} 0 ".encode(), resources[i]))
        kids.append(f"{first_page_obj + i} 0 R")

    objs = [CATALOG, pages(" ".join(kids), n_pages)]
    objs += page_objs
    objs += [stream(b"", b) for b in bodies]
    objs += [HELV, rgb_image(40, 30)]
    return build(objs)

FIXTURES = {
    "prose.pdf": f_prose,
    "vector_chart.pdf": f_vector_chart,
    "ruled_table.pdf": f_ruled_table,
    "equation.pdf": f_equation,
    "raster_figure.pdf": f_raster_figure,
    "scan.pdf": f_scan,
    "broken_glyphs.pdf": f_broken_glyphs,
    "mixed.pdf": f_mixed,
}

if __name__ == "__main__":
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    for name, fn in FIXTURES.items():
        data = fn()
        with open(os.path.join(outdir, name), "wb") as fh:
            fh.write(data)
        print(f"{name}: {len(data)} bytes")
