#pip install pymupdf
#converting single-page PDF to txt with bottom-page numbers; advanced dehyphenation
#insert PDF and txt names at the end of the script
import fitz  # PyMuPDF
import re


def process_pdf_to_txt(input_pdf, output_txt):
    doc = fitz.open(input_pdf)
    raw_elements = []

    # ── 1. Calculate baseline margins for indent detection ────────────────────
    def get_margin(indices):
        starts = []
        for i in indices:
            if i >= len(doc):
                continue
            blocks = doc[i].get_text("dict")["blocks"]
            for b in blocks:
                if "lines" in b and b["bbox"][1] < doc[i].rect.height * 0.8:
                    starts.append(round(b["lines"][0]["bbox"][0], 1))
        return max(set(starts), key=starts.count) if starts else 0

    odd_margin  = get_margin(range(0, min(10, len(doc)), 2))
    even_margin = get_margin(range(1, min(10, len(doc)), 2))

    # ── 2. Extract lines and metadata ─────────────────────────────────────────
    for page in doc:
        is_odd       = (page.number + 1) % 2 != 0
        margin       = odd_margin if is_odd else even_margin
        footer_limit = page.rect.height * 0.90

        # x-range where a *footer* page number sits (outer margin)
        footer_num_x = (
            (0, page.rect.width * 0.45)
            if is_odd
            else (page.rect.width * 0.55, page.rect.width)
        )

        blocks = page.get_text("dict")["blocks"]
        blocks.sort(key=lambda b: b["bbox"][1])

        for b in blocks:
            if "lines" not in b:
                continue
            for line in b["lines"]:
                x0, y0, x1, y1 = line["bbox"]
                text = (
                    "".join(s["text"] for s in line["spans"])
                    .replace("\u00ad", "-")   # soft hyphen → hard hyphen
                    .strip()
                )
                if not text:
                    continue

                # ── Page-number detection ─────────────────────────────────
                # Strategy A: footer position + outer-margin x (original logic)
                is_footer_num = (
                    y0 > footer_limit
                    and footer_num_x[0] <= x0 <= footer_num_x[1]
                    and text.isdigit()
                )
                # Strategy B: the ENTIRE line is nothing but digits.
                # This catches page numbers printed in the header (top of page)
                # or as a standalone line between paragraphs, e.g.:
                #   "...vergessen"
                #   "118"           ← whole line = "118", not part of a sentence
                #   "hast, auch..."
                # This is safe because an inline number like "119" always appears
                # as part of a longer line ("auch zu 119 würden"), never alone.
                is_standalone_num = text.isdigit()

                if is_footer_num or is_standalone_num:
                    raw_elements.append({"type": "page_num", "val": int(text)})
                    continue

                raw_elements.append({
                    "type":         "text",
                    "val":          text,
                    "is_indented":  x0 > margin + 7,
                    "starts_roman": bool(re.match(r"^[IVXLC]+\b", text)),
                })

    # ── 3. Weave elements together ────────────────────────────────────────────
    #
    # Rules:
    #   • page_num  → always formatted as " [N]", placed immediately after the
    #                 preceding word/line, before any following separator.
    #   • hyphen at line-end + lowercase start of next word
    #               → merge (drop hyphen), page nums go after the merged word.
    #   • hyphen at line-end + uppercase start of next word
    #               → keep hyphen, join compound directly, page nums after.
    #   • non-hyphenated continuation (same indent level)
    #               → join with a single space, never a line break.
    #   • indented line → new paragraph: \n before it.
    #   • Roman-numeral chapter heading → \n\n before and after.

    def peek_next_text(start):
        """Scan forward past page_nums; return (index_of_next_text, [page_num_vals])."""
        pnums = []
        for j in range(start, len(raw_elements)):
            el = raw_elements[j]
            if el["type"] == "page_num":
                pnums.append(el["val"])
            elif el["type"] == "text":
                return j, pnums
        return -1, pnums

    def fmt_pnums(pnums):
        return "".join(f" [{n}]" for n in pnums)

    parts = []
    i = 0

    while i < len(raw_elements):
        curr = raw_elements[i]

        # ── Standalone page number not yet consumed by look-ahead ─────────────
        # This occurs when a page number separates two non-hyphenated lines, e.g.:
        #   "...vergessen"  →  page_num 118  →  "hast, auch..."
        # We emit " [118]" right here; the next text line will join normally.
        if curr["type"] == "page_num":
            parts.append(f" [{curr['val']}]")
            i += 1
            continue

        text = curr["val"]

        # ── Roman-numeral chapter heading ─────────────────────────────────────
        if curr["starts_roman"]:
            while parts and parts[-1] in (" ", "\n"):
                parts.pop()
            parts.append("\n\n")
            parts.append(text)
            parts.append("\n\n")
            i += 1
            continue

        # ── Hyphenated line-end ───────────────────────────────────────────────
        if text.endswith("-"):
            # Add the normal leading space for this word's start
            if parts and parts[-1] not in ("\n", "\n\n"):
                parts.append(" ")

            next_idx, pnums = peek_next_text(i + 1)

            if next_idx != -1:
                next_text  = raw_elements[next_idx]["val"]
                first_char = next_text[0] if next_text else ""

                # Split next_text into the first word and whatever follows it
                m          = re.match(r"^(\S+)(.*)", next_text)
                first_word = m.group(1)        if m else next_text
                remainder  = m.group(2).strip() if m else ""

                if first_char.islower():
                    # Soft hyphen: drop it and glue the two halves
                    # e.g. "offe-" + "riert. So..." → "offeriert. [358] So..."
                    parts.append(text[:-1] + first_word)
                else:
                    # Hard hyphen: keep it and join the compound
                    # e.g. "Müller-" + "Straße..." → "Müller-Straße [99]..."
                    parts.append(text + first_word)

                parts.append(fmt_pnums(pnums))   # page nums go after the joined word

                if remainder:
                    parts.append(" ")
                    parts.append(remainder)

                i = next_idx + 1
            else:
                # Nothing follows; emit as-is
                parts.append(text)
                i += 1
            continue

        # ── Normal text line ──────────────────────────────────────────────────
        if curr["is_indented"]:
            # New paragraph
            while parts and parts[-1] == " ":
                parts.pop()
            parts.append("\n")
            parts.append(text)
        else:
            # Continuation line: always a single space, never a bare line break.
            # (This fixes "Ich hoffe ja\nimmer" and "Sigi\nBlau" joining as words.)
            if parts and parts[-1] not in ("\n", "\n\n"):
                parts.append(" ")
            parts.append(text)

        i += 1

    # ── 4. Assemble and clean up ──────────────────────────────────────────────
    final_text = "".join(parts)

    # German quotation marks  »open«  →  "open"
    final_text = re.sub(r"»\s*", ' "', final_text)
    final_text = re.sub(r"\s*«",  '" ', final_text)

    # Collapse runs of spaces (preserve newlines)
    final_text = re.sub(r"[^\S\n]+", " ", final_text)

    # Remove any space that snuck in immediately after a newline
    final_text = re.sub(r"\n ", "\n", final_text)

    # Collapse 3+ newlines to at most 2
    final_text = re.sub(r"\n{3,}", "\n\n", final_text)

    # "[N] \n"  →  "[N]\n"  (bracket should hug the newline, not trail a space)
    final_text = re.sub(r"(\[\d+\]) \n", r"\1\n", final_text)

    with open(output_txt, "w", encoding="utf-8") as f:
        f.write(final_text.strip())


# process_pdf_to_txt("input.pdf", "output.txt")
process_pdf_to_txt("Karriere_Neumann.pdf", "Karriere_Neumann.pdf.txt")
