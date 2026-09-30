#!/usr/bin/env python3
"""Extract printed S1 inspection pages into an auditable history package.

Requires pdfplumber from the Codex bundled Python runtime and Poppler-generated
layout text in tmp/pdf-import for the companion review artifacts. The source
PDFs are read only; this script writes only the S1 output JSON.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pdfplumber


ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "tmp/pdf-import/inventory.json"
SOURCE_PREFIX = Path("/Users/michael/Documents/Projects/MasterQC/Master QC 品管主控文档/S1")
FAMILY = "s11-s14"
NAMESPACE = uuid.UUID("52ebfb87-5177-43bc-a98e-9419a66595b4")
BLANK_MARKERS = {"", "—", "–", "-", "_", "N/A", "NA"}


def stable_id(kind: str, key: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"masterqc-pdf-history|{kind}|{key}"))


def cell_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def flattened(value: Any) -> str:
    return re.sub(r"\s+", " ", cell_text(value)).strip()


def is_blank(value: Any) -> bool:
    return flattened(value).upper() in BLANK_MARKERS


def number_value(value: Any) -> int | float | None:
    raw = flattened(value)
    if is_blank(raw):
        return None
    match = re.search(r"[-+]?\d[\d,]*(?:\.\d+)?", raw)
    if not match:
        return None
    parsed = float(match.group(0).replace(",", ""))
    return int(parsed) if parsed.is_integer() else parsed


def percentage_value(value: Any) -> float | None:
    raw = flattened(value)
    if is_blank(raw):
        return None
    match = re.search(r"([-+]?\d+(?:\.\d+)?)\s*%", raw)
    return float(match.group(1)) if match else None


def nonempty(value: Any) -> str | None:
    raw = cell_text(value)
    return raw if raw else None


FIELD_LABELS = {
    "productLabel": (re.compile(r"item\s*name|品名", re.I),),
    "batchQuantity": (re.compile(r"batch\s*qty|批次数量", re.I),),
    "printedDate": (re.compile(r"batch\s*date|批次日期", re.I),),
    "recorder": (re.compile(r"recorded\s*by|记录人员", re.I),),
    "printedVersion": (re.compile(r"version|版本", re.I),),
    "printedPage": (re.compile(r"page|页数", re.I),),
}


def labelled_value(header: list[Any], field_name: str) -> str | None:
    patterns = FIELD_LABELS[field_name]
    all_patterns = [pattern for group in FIELD_LABELS.values() for pattern in group]
    for index, value in enumerate(header):
        raw = flattened(value)
        if not any(pattern.search(raw) for pattern in patterns):
            continue
        for next_index in range(index + 1, len(header)):
            candidate = cell_text(header[next_index])
            if any(pattern.search(flattened(candidate)) for pattern in all_patterns):
                break
            if candidate:
                if field_name == "printedVersion":
                    # Narrow source cells can wrap the final digit onto a new line.
                    original = cell_text(header[next_index])
                    if re.fullmatch(r"\d+(?:\.\d+)*\s+\d+", flattened(original)):
                        return re.sub(r"\s+", "", flattened(original))
                return candidate
    return None


def normalized_date(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})", value)
    if not match:
        return None
    year, month, day = map(int, match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def pick_cell(row: list[Any], index: int | None) -> str:
    return cell_text(row[index]) if index is not None and index < len(row) else ""


def index_with(rows: list[list[Any]], pattern: re.Pattern[str], start_rows: tuple[int, ...]) -> int | None:
    width = max((len(row) for row in rows), default=0)
    for index in range(width):
        value = " ".join(
            flattened(rows[row_index][index])
            for row_index in start_rows
            if row_index < len(rows) and index < len(rows[row_index])
        )
        compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", value.lower())
        if pattern.search(value) or pattern.search(compact):
            return index
    return None


def find_result_columns(rows: list[list[Any]]) -> dict[str, int | None]:
    labels = (3, 2)
    columns: dict[str, int | None] = {
        "inspected": index_with(rows, re.compile(r"inspection\s*qty|检验数量", re.I), labels),
        "defective": index_with(rows, re.compile(r"defective\s*qty|不良数", re.I), labels),
        "rate": index_with(rows, re.compile(r"defective\s*rate|不良率", re.I), labels),
        "time": index_with(rows, re.compile(r"\btime\b|时数", re.I), (2,)),
        "averageTime": index_with(rows, re.compile(r"average\s*time|单件平均工时", re.I), (2,)),
        "video": index_with(rows, re.compile(r"video|procedure|视频", re.I), (2,)),
        "remarks": index_with(rows, re.compile(r"remarks|备注", re.I), (2,)),
        "sampling": index_with(rows, re.compile(r"inspection\s*frequen|inspection/record|抽检/记录|检查百分比", re.I), (2,)),
        "recording": index_with(rows, re.compile(r"log.{0,24}frequen|recording.{0,24}frequency", re.I), (2,)),
    }
    # Some AP forms split header words across cell text runs (for example
    # "Inspecti\non qty"). The adjacent unique result headers establish the
    # inspected-qty column as the one immediately before defective qty/rate.
    if columns["inspected"] is None and columns["defective"] is not None and columns["rate"] == columns["defective"] + 1:
        columns["inspected"] = columns["defective"] - 1
    if columns["defective"] is None and columns["inspected"] is not None and columns["rate"] == columns["inspected"] + 2:
        columns["defective"] = columns["inspected"] + 1
    if columns["rate"] is None and columns["inspected"] is not None and columns["defective"] == columns["inspected"] + 1:
        columns["rate"] = columns["defective"] + 1

    # Older AP OQC pages use a single "inspection / record" percentage cell.
    # When that header is text-corrupted, the data cell itself still prints both
    # percentages separated by a slash; otherwise two preceding cells are used.
    first_data = next((row for row in rows[4:] if row and len(row) > 1 and cell_text(row[0]).isdigit() and cell_text(row[1])), [])
    inspected = columns["inspected"]
    if columns["sampling"] is None and inspected is not None and inspected > 0:
        prior = pick_cell(first_data, inspected - 1)
        if re.search(r"\d\s*%\s*/\s*\d", prior):
            columns["sampling"] = inspected - 1
        elif inspected > 1:
            columns["sampling"] = inspected - 2
            columns["recording"] = inspected - 1
    return columns


def header_history(rows: list[list[Any]], columns: dict[str, int | None]) -> list[dict[str, Any]]:
    rate_index = columns["rate"]
    time_index = columns["time"]
    if rate_index is None or time_index is None:
        return []
    history: list[dict[str, Any]] = []
    width = max((len(row) for row in rows), default=0)
    for index in range(rate_index + 1, min(time_index, width)):
        parts = [cell_text(rows[row_index][index]) for row_index in (2, 3) if row_index < len(rows) and index < len(rows[row_index])]
        header_raw = "\n".join(part for part in parts if part)
        date_match = re.search(r"\b(\d{1,2}[./]\d{1,2})\b", header_raw)
        if not date_match:
            continue
        quantity_match = re.search(r"qty\s*([\d,]+)|数量\s*([\d,]+)", header_raw, re.I)
        quantity = number_value(next((value for value in quantity_match.groups() if value), None)) if quantity_match else None
        history.append({
            "sourceColumn": index,
            "printedDateRaw": date_match.group(1),
            "printedBatchQuantity": quantity,
            "printedHeaderRaw": header_raw,
        })
    return history


def table_fill(page: Any, row_cells: list[Any]) -> tuple[bool | None, str | None]:
    if not row_cells or not row_cells[0]:
        return None, None
    left, top, _, bottom = row_cells[0]
    matches = [
        rect for rect in page.rects
        if abs(rect.get("x0", -999) - left) < 0.7
        and abs(rect.get("top", -999) - top) < 0.7
        and abs(rect.get("bottom", -999) - bottom) < 0.7
    ]
    if not matches:
        # White, unfilled source rows have no background rectangle. The rendered
        # page review confirmed these rows are not green-highlighted.
        return False, "none"
    color = matches[0].get("non_stroking_color")
    if isinstance(color, tuple) and len(color) >= 3:
        red, green, blue = color[:3]
        important = red < 0.95 and green > 0.88 and blue > red and green > blue
        return important, ",".join(f"{part:.3f}" for part in (red, green, blue))
    if isinstance(color, (int, float)):
        return color < 0.95, str(color)
    return None, str(color) if color is not None else None


def current_inspection_table(page: Any, table_rows: list[list[Any]]) -> bool:
    if not table_rows:
        return False
    header = " ".join(flattened(value) for value in table_rows[0])
    if not re.search(r"item\s*name|品名", header, re.I):
        return False
    if not re.search(r"batch\s*qty|批次数量", header, re.I):
        return False
    page_text = page.extract_text() or ""
    return bool(re.search(r"\b(?:IQC|OQC)\b.*inspection.*specification", page_text, re.I))


def factory_for_page(page_text: str) -> tuple[str | None, str | None]:
    if re.search(r"Suzhou\s+Aotuline|奥途莱", page_text, re.I):
        return "AP", re.search(r"Suzhou\s+Aotuline[^\n]*|苏州奥途莱[^\n]*", page_text, re.I).group(0).strip()
    if re.search(r"Suzhou\s+Youmite|优米特|優米特", page_text, re.I):
        match = re.search(r"Suzhou\s+Youmite[^\n]*|苏州[优優]米特[^\n]*", page_text, re.I)
        return "UI", match.group(0).strip() if match else "Unique / 优米特 logo"
    return None, None


ALLOCATION_HEADING_RE = re.compile(r"(?:本批发货数量|Quantity\s+of\s+this\s+wholesale)\s*[:：]*", re.I)
MODEL_ALLOCATION_MARKER_RE = re.compile(
    r"(?<![A-Za-z0-9])(?P<model>S1[1-4])\s*"
    r"(?:[-－]\s*(?P<prefixColor>red|yellow|红色|黄色))?\s*"
    r"(?:[:：]\s*|\s+)",
    re.I,
)
COLORED_QUANTITY_RE = re.compile(
    r"(?P<color>red|yellow|红色|黄色)\s*(?:[:：]\s*)?(?P<quantity>[\d,]+)\s*(?:pcs|件|台)?",
    re.I,
)
UNIT_QUANTITY_RE = re.compile(r"(?P<quantity>[\d,]+)\s*(?:pcs|件|台)", re.I)
FIRST_ALLOCATION_QUANTITY_RE = re.compile(r"(?P<quantity>[\d,]+)\s*(?:pcs|件|台)?", re.I)


def normalized_color(raw_color: str | None) -> str | None:
    if not raw_color:
        return None
    if raw_color.lower() in {"red", "红色"}:
        return "Red"
    if raw_color.lower() in {"yellow", "黄色"}:
        return "Yellow"
    return None


def product_allocations(notes: str | None) -> list[dict[str, Any]]:
    if not notes:
        return []
    heading = ALLOCATION_HEADING_RE.search(notes)
    if not heading:
        return []
    allocation_text = notes[heading.end():]
    markers = list(MODEL_ALLOCATION_MARKER_RE.finditer(allocation_text))
    found: dict[tuple[str, str | None, int], dict[str, Any]] = {}

    def add(model: str, raw_color: str | None, quantity_raw: str, raw: str) -> None:
        color = normalized_color(raw_color)
        quantity = int(quantity_raw.replace(",", ""))
        key = (model.upper(), color, quantity)
        if key not in found:
            found[key] = {
                "model": model.upper(),
                "color": color,
                "printedColorRaw": raw_color,
                "quantity": quantity,
                "raw": raw.strip(),
                "rawMentions": [],
            }
        if raw.strip() not in found[key]["rawMentions"]:
            found[key]["rawMentions"].append(raw.strip())

    for index, marker in enumerate(markers):
        next_start = markers[index + 1].start() if index + 1 < len(markers) else len(allocation_text)
        segment = allocation_text[marker.end():next_start]
        model = marker.group("model")
        prefix_color = marker.group("prefixColor")
        colored_matches = list(COLORED_QUANTITY_RE.finditer(segment))
        if colored_matches:
            for match in colored_matches:
                raw_color = match.group("color")
                add(model, raw_color, match.group("quantity"), match.group(0))
            continue

        # A color attached to the model applies to the quantity immediately following it.
        if prefix_color:
            match = FIRST_ALLOCATION_QUANTITY_RE.search(segment)
            if match:
                add(model, prefix_color, match.group("quantity"), marker.group(0) + match.group(0))
            continue

        # Model-only allocations in the printed notes normally carry PCS/件/台.
        match = UNIT_QUANTITY_RE.search(segment)
        if match:
            add(model, None, match.group("quantity"), marker.group(0) + match.group(0))
    return list(found.values())


def derive_product(product_label: str | None, allocations: list[dict[str, Any]], batch_quantity: int | float | None) -> tuple[str | None, str | None, str | None]:
    if len(allocations) == 1 and allocations[0]["quantity"] == batch_quantity:
        return allocations[0]["model"], allocations[0]["color"], "special-notes-single-allocation"
    if len(allocations) > 1 or allocations:
        return None, None, "special-notes-mixed-or-partial-allocation"
    label = flattened(product_label)
    match = re.search(r"\bS(11|12|13|14)\b", label, re.I)
    if match:
        return f"S{match.group(1)}", None, "printed-product-label"
    family_number = re.search(r"HyperSmoke\s+(1[1-4])\b", label, re.I)
    if family_number:
        return f"S{family_number.group(1)}", None, "printed-product-label-suffix"
    return None, None, None


def split_sampling_and_recording(sampling_raw: str, separate_recording_raw: str) -> tuple[float | None, str | None]:
    if separate_recording_raw:
        return percentage_value(sampling_raw), separate_recording_raw
    if "/" in sampling_raw:
        sample, recording = sampling_raw.split("/", 1)
        return percentage_value(sample), recording.strip() or None
    return percentage_value(sampling_raw), None


def row_images(page: Any, table: Any, row_index: int, row_id: str, remarks_index: int | None, source_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if remarks_index is None or row_index >= len(table.rows):
        return [], []
    cells = table.rows[row_index].cells
    if remarks_index >= len(cells) or not cells[remarks_index]:
        return [], []
    _, top, _, bottom = cells[remarks_index]
    assigned: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    for image_index, image in enumerate(page.images):
        image_box = (image.get("x0"), image.get("top"), image.get("x1"), image.get("bottom"))
        if None in image_box:
            continue
        left, image_top, right, image_bottom = image_box
        overlaps_y = image_bottom > top + 1 and image_top < bottom - 1
        overlaps_x = right > cells[remarks_index][0] + 1 and left < cells[remarks_index][2] - 1
        if overlaps_y and overlaps_x:
            record = {
                "sourceId": source_id,
                "pageImageIndex": image_index,
                "bboxPoints": [round(left, 2), round(image_top, 2), round(right, 2), round(image_bottom, 2)],
            }
            contained = left >= cells[remarks_index][0] - 1 and right <= cells[remarks_index][2] + 1 and image_top >= top - 1 and image_bottom <= bottom + 1
            if contained:
                assigned.append({**record, "associationBasis": "image-contained-in-row-remarks-cell"})
            else:
                ambiguous.append(record)
    return assigned, ambiguous


def extract_page(page: Any, table: Any, source_id: str, source_key: str, page_number: int, source_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rows = table.extract()
    metadata = rows[0]
    page_text = page.extract_text() or ""
    title_match = re.search(r"\b(IQC|OQC)\b\s+Inspection\s+specification", page_text, re.I)
    stage = title_match.group(1).upper() if title_match else None
    printed_version = labelled_value(metadata, "printedVersion")
    printed_date = labelled_value(metadata, "printedDate")
    product_label = labelled_value(metadata, "productLabel")
    batch_quantity_raw = labelled_value(metadata, "batchQuantity")
    recorder = labelled_value(metadata, "recorder")
    page_label = labelled_value(metadata, "printedPage")
    batch_quantity = number_value(batch_quantity_raw)

    notes_row = rows[1] if len(rows) > 1 else []
    notes = "\n".join(cell_text(value) for value in notes_row if cell_text(value) and not re.search(r"Special Notes|本批次特殊情况", cell_text(value), re.I)) or None
    allocations = product_allocations(notes)
    model, color, model_basis = derive_product(product_label, allocations, batch_quantity)
    factory, factory_raw = factory_for_page(page_text)
    columns = find_result_columns(rows)
    missing_result_columns = [key for key in ("inspected", "defective", "rate") if columns[key] is None]
    if missing_result_columns:
        raise ValueError(f"Could not resolve printed result columns {missing_result_columns} on {source_path.name} page {page_number}; refusing to treat parser failure as blank inspection data.")
    history_headers = header_history(rows, columns)
    printed_rows: list[dict[str, Any]] = []
    inspection_id = stable_id("inspection", f"{source_key}|p{page_number}")
    local_anomalies: list[dict[str, Any]] = []
    for table_row_index, source_row in enumerate(rows):
        if not source_row or not cell_text(source_row[0]).isdigit():
            continue
        title = nonempty(source_row[1]) if len(source_row) > 1 else None
        if not title:
            # The form numbers blank template lines; these are not omitted checks.
            continue
        printed_no = int(cell_text(source_row[0]))
        row_id = stable_id("row", f"{inspection_id}|{printed_no}|{table_row_index}")
        sampling_raw = pick_cell(source_row, columns["sampling"])
        separate_recording_raw = pick_cell(source_row, columns["recording"])
        sampling_percent, recording_rule = split_sampling_and_recording(sampling_raw, separate_recording_raw)
        inspected_raw = pick_cell(source_row, columns["inspected"])
        defective_raw = pick_cell(source_row, columns["defective"])
        rate_raw = pick_cell(source_row, columns["rate"])
        important, fill_color = table_fill(page, table.rows[table_row_index].cells)
        evidence_photos, ambiguous_images = row_images(page, table, table_row_index, row_id, columns["remarks"], source_id)
        comparisons = []
        for header in history_headers:
            raw_rate = pick_cell(source_row, header["sourceColumn"])
            if not raw_rate and not is_blank(raw_rate):
                continue
            comparisons.append({
                "printedDateRaw": header["printedDateRaw"],
                "printedBatchQuantity": header["printedBatchQuantity"],
                "sourceDefectiveRateRaw": raw_rate or None,
                "sourceDefectiveRate": percentage_value(raw_rate),
                "sourceColumn": header["sourceColumn"],
            })
        raw_cells = [nonempty(value) for value in source_row]
        row_record = {
            "id": row_id,
            "no": printed_no,
            "title": title,
            "specification": nonempty(source_row[2]) if len(source_row) > 2 else None,
            "devices": nonempty(source_row[3]) if len(source_row) > 3 else None,
            "samplingPercent": sampling_percent,
            "samplingPercentRaw": sampling_raw or None,
            "recordingRule": recording_rule,
            "recordingRuleRaw": (separate_recording_raw or recording_rule) or None,
            "sourceInspectedQty": number_value(inspected_raw),
            "sourceInspectedQtyRaw": inspected_raw or None,
            "defectiveQty": number_value(defective_raw),
            "defectiveQtyRaw": defective_raw or None,
            "sourceDefectiveRate": percentage_value(rate_raw),
            "sourceDefectiveRateRaw": rate_raw or None,
            "timeSeconds": number_value(pick_cell(source_row, columns["time"])),
            "timeSecondsRaw": pick_cell(source_row, columns["time"]) or None,
            "averageTimePerUnitSeconds": number_value(pick_cell(source_row, columns["averageTime"])),
            "averageTimePerUnitSecondsRaw": pick_cell(source_row, columns["averageTime"]) or None,
            "important": important,
            "importantFillRgb": fill_color,
            "remarks": nonempty(pick_cell(source_row, columns["remarks"])),
            "specificationModelReferences": sorted({match.upper() for match in re.findall(r"\bS(?:11|12|13|14|15)\b", nonempty(source_row[2]) or "", re.I)}),
            "historicalComparisons": comparisons,
            "photoEvidence": evidence_photos,
            "raw": {"tableRowIndex": table_row_index, "printedCells": raw_cells},
        }
        printed_rows.append(row_record)
        if important is None:
            local_anomalies.append({"code": "important-fill-unreadable", "rowNo": printed_no, "message": "The table row fill color could not be read from the source PDF."})
        if number_value(inspected_raw) is not None and batch_quantity is not None and number_value(inspected_raw) > batch_quantity:
            local_anomalies.append({
                "code": "source-inspected-quantity-exceeds-batch-quantity",
                "rowNo": printed_no,
                "message": "The printed source inspected quantity exceeds the page batch quantity; both printed values are preserved without correction.",
                "batchQuantity": batch_quantity,
                "sourceInspectedQty": number_value(inspected_raw),
                "sourceInspectedQtyRaw": inspected_raw,
            })
        mismatched_models = sorted(set(row_record["specificationModelReferences"]) - {"S11", "S12", "S13", "S14"})
        if mismatched_models:
            local_anomalies.append({
                "code": "specification-model-mismatch",
                "rowNo": printed_no,
                "message": "The printed specification names model(s) outside the S11-S14 source family. The printed specification is preserved and no product model is inferred from it.",
                "referencedModels": mismatched_models,
            })
        specification_text = nonempty(source_row[2]) or ""
        if stage == "OQC" and re.search(r"\b20\s*PSI\b", specification_text, re.I):
            local_anomalies.append({
                "code": "specification-model-mismatch",
                "rowNo": printed_no,
                "message": "The printed generic S1-family OQC row uses a 20 PSI leak threshold, which conflicts with the S11-S14 draft criterion. The source wording is preserved and no model is inferred.",
                "mismatchBasis": "20 PSI OQC leak threshold",
                "modelReferencePrinted": False,
            })
        if ambiguous_images:
            row_record["ambiguousPhotoEvidence"] = ambiguous_images
            local_anomalies.append({
                "code": "embedded-image-overlaps-multiple-or-shared-cells",
                "rowNo": printed_no,
                "message": "An embedded source image overlaps this row but is not fully contained in its remarks cell; it is retained in the original PDF and was not assigned to this inspection row.",
            })

    if allocations and batch_quantity is not None and sum(item["quantity"] for item in allocations) != batch_quantity:
        local_anomalies.append({
            "code": "special-note-product-quantities-do-not-match-batch-quantity",
            "message": "Printed model quantities in Special Notes do not sum to the page batch quantity; the printed values are preserved.",
            "batchQuantity": batch_quantity,
            "reportedQuantityTotal": sum(item["quantity"] for item in allocations),
        })
    if not factory:
        local_anomalies.append({"code": "factory-logo-or-footer-unresolved", "message": "Factory could not be mapped from the printed logo/footer; no factory was inferred from the filename."})
    if columns["sampling"] is None:
        local_anomalies.append({"code": "sampling-column-unresolved", "message": "The printed sampling column could not be located; the raw source page remains available."})
    if columns["time"] is None:
        local_anomalies.append({"code": "time-column-unresolved", "message": "The printed time column could not be located; the raw source page remains available."})
    if model_basis == "special-notes-mixed-or-partial-allocation":
        local_anomalies.append({
            "code": "mixed-or-partial-product-allocation",
            "message": "Special Notes report one or more model quantities, but the page does not establish a single full-batch model; model and color remain null.",
            "reportedProductQuantities": allocations,
        })

    # Keep nonempty inspection rows only; blank numbered form lines stay in the
    # source PDF and do not become synthetic inspection checks.
    inspection = {
        "id": inspection_id,
        "sourceId": source_id,
        "page": page_number,
        "printedVersion": flattened(printed_version) if printed_version else None,
        "printedVersionRaw": printed_version,
        "printedDate": flattened(printed_date) if printed_date else None,
        "printedDateRaw": printed_date,
        "date": normalized_date(printed_date),
        "printedPage": flattened(page_label) if page_label else None,
        "productLabel": product_label,
        "model": model,
        "color": color,
        "modelBasis": model_basis,
        "reportedProductQuantities": allocations,
        "factory": factory,
        "factoryRaw": factory_raw,
        "stage": stage,
        "batchQuantity": batch_quantity,
        "batchQuantityRaw": batch_quantity_raw,
        "recorder": recorder,
        "notes": notes,
        "rows": printed_rows,
        "historyColumns": history_headers,
        "sourceColumnMap": columns,
        "sourceText": page_text,
        "anomalies": local_anomalies,
    }
    return inspection, local_anomalies


def load_inventory() -> list[dict[str, Any]]:
    entries = json.loads(INVENTORY.read_text(encoding="utf-8"))
    return [entry for entry in entries if entry["key"].startswith("S1-")]


def extract_package(source_filter: str | None = None) -> dict[str, Any]:
    inventory = load_inventory()
    if source_filter:
        inventory = [entry for entry in inventory if entry["key"] == source_filter]
        if not inventory:
            raise SystemExit(f"Unknown S1 source key: {source_filter}")

    sources: list[dict[str, Any]] = []
    inspections: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []
    package_anomalies: list[dict[str, Any]] = []
    extracted_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    # This is package metadata, not a source-business timestamp. Keeping it fixed
    # makes asset records byte-for-byte stable when the extractor is rerun.
    asset_created_at = "2026-09-29T00:00:00.000Z"
    for entry in inventory:
        path = Path(entry["path"])
        if not path.is_file():
            package_anomalies.append({"sourceKey": entry["key"], "code": "source-pdf-not-found", "message": f"Source PDF is missing: {path}"})
            continue
        pdf_bytes = path.read_bytes()
        source_id = f"source-{entry['key'].lower()}"
        asset_id = stable_id("asset", entry["key"])
        source = {
            "id": source_id,
            "fileName": path.name,
            "path": str(path),
            "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
            "pageCount": None,
            "family": FAMILY,
            "assetId": asset_id,
            "inspectionPages": [],
            "nonInspectionPages": [],
        }
        with pdfplumber.open(path) as pdf:
            source["pageCount"] = len(pdf.pages)
            for page_index, page in enumerate(pdf.pages, start=1):
                tables = page.find_tables()
                matched_table = None
                matched_rows = None
                for table in tables:
                    table_rows = table.extract()
                    if current_inspection_table(page, table_rows):
                        matched_table, matched_rows = table, table_rows
                        break
                if matched_table is None or matched_rows is None:
                    raw_text = page.extract_text() or ""
                    kind = "change-log" if re.search(r"change\s*log|修改内容|date/version#", raw_text, re.I) else "other"
                    source["nonInspectionPages"].append({"page": page_index, "kind": kind, "heading": next((line.strip() for line in raw_text.splitlines() if line.strip()), None)})
                    continue
                inspection, anomalies = extract_page(page, matched_table, source_id, entry["key"], page_index, path)
                if not inspection["rows"]:
                    package_anomalies.append({"sourceId": source_id, "page": page_index, "code": "inspection-page-has-no-titled-rows", "message": "The page has inspection metadata but no titled inspection rows."})
                source["inspectionPages"].append(page_index)
                inspections.append(inspection)
                for anomaly in anomalies:
                    package_anomalies.append({"sourceId": source_id, "inspectionId": inspection["id"], "page": page_index, **anomaly})
        asset = {
            "id": asset_id,
            "name": path.name,
            "mimeType": "application/pdf",
            "dataUrl": "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode("ascii"),
            "kind": "document",
            "batchId": None,
            "rowId": None,
            "versionId": None,
            "createdAt": asset_created_at,
        }
        assets.append(asset)
        sources.append(source)

    summary = {
        "sourceCount": len(sources),
        "sourcePageCount": sum(source["pageCount"] or 0 for source in sources),
        "inspectionPageCount": len(inspections),
        "inspectionRowCount": sum(len(inspection["rows"]) for inspection in inspections),
        "blankNumberedRowsExcluded": True,
        "historicalRateColumnsAreNotInspections": True,
        "changeLogPagesAreNotInspections": True,
        "factoryCounts": count_by(inspections, "factory"),
        "stageCounts": count_by(inspections, "stage"),
    }
    return {
        "format": "masterqc-pdf-history",
        "formatVersion": 1,
        "family": FAMILY,
        "summary": summary,
        "sources": sources,
        "inspections": inspections,
        "assets": assets,
        "anomalies": package_anomalies,
        "extractedAt": extracted_at,
    }


def count_by(records: list[dict[str, Any]], key: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for record in records:
        value = record.get(key) or "unresolved"
        result[value] = result.get(value, 0) + 1
    return dict(sorted(result.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Extract only a single inventory key, such as S1-01")
    parser.add_argument("--output", default=str(ROOT / "data/pdf-import/s1-history.json"), help="Output JSON path")
    args = parser.parse_args()
    package = extract_package(args.source)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "summary": package["summary"], "anomalyCount": len(package["anomalies"])}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
