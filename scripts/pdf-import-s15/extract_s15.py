#!/usr/bin/env python3
"""Extract original S15 inspection forms into the MasterQC PDF-history package.

Run with the bundled Python runtime because the shared table-cell helper uses
pdfplumber. Source PDFs remain read only; output is written under data/pdf-import.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pdfplumber


ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "tmp/pdf-import/inventory.json"
SHARED_SCRIPT_DIR = ROOT / "scripts/pdf-import"
sys.path.insert(0, str(SHARED_SCRIPT_DIR))
import extract_s1_history as shared  # noqa: E402


FAMILY = "s15"
ASSET_CREATED_AT = "2026-09-29T00:00:00.000Z"
DASH_MARKERS = {"", "—", "–", "-", "_", "N/A", "NA"}
DASH_CHARACTERS = set("—–-―－−_")
S15_COLOR_PATTERNS = {
    "red": re.compile(
        r"\bs15\s*[-－–]\s*red\b|\bred\s*[:：]\s*[\d,]+\s*(?:pcs|件|台)\b|"
        r"(?:剩余|remaining)\s*red\s*[:：]?\s*[\d,]+\s*(?:pcs|件|台)\b|"
        r"[\d,]+\s*(?:pcs|件|台)\s*红色|红色\s*[:：]?\s*[\d,]+\s*(?:pcs|件|台)",
        re.I,
    ),
    "yellow": re.compile(
        r"\bs15\s*[-－–]\s*yellow\b|\byellow\s*[:：]\s*[\d,]+\s*(?:pcs|件|台)\b|"
        r"(?:剩余|remaining)\s*yellow\s*[:：]?\s*[\d,]+\s*(?:pcs|件|台)\b|"
        r"[\d,]+\s*(?:pcs|件|台)\s*黄色|黄色\s*[:：]?\s*[\d,]+\s*(?:pcs|件|台)",
        re.I,
    ),
}


def normalize_task_identity(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title).casefold()
    return "".join(character for character in normalized if character.isalnum())


def derive_color(notes: str | None) -> tuple[str | None, str | None]:
    if not notes:
        return None, None
    normalized = shared.flattened(notes)
    found = [name for name, pattern in S15_COLOR_PATTERNS.items() if pattern.search(normalized)]
    if len(found) == 1:
        return found[0], "special-notes-explicit-product-quantity"
    if len(found) > 1:
        return None, "special-notes-mixed-color-quantities"
    return None, None


def is_blank_or_dash(raw: str) -> bool:
    normalized = shared.flattened(raw).replace(" ", "")
    return not normalized or normalized.upper() in DASH_MARKERS or all(char in DASH_CHARACTERS for char in normalized)


def visible_factory_line(page_text: str, factory: str | None, fallback: str | None) -> str | None:
    if not factory:
        return fallback
    for line in page_text.splitlines():
        candidate = line.strip()
        if "Suzhou" in candidate and ("Co." in candidate or "Manufacturing" in candidate):
            return candidate
    return fallback


def clean_history_columns(rows: list[list[Any]], columns: dict[str, int | None]) -> list[dict[str, Any]]:
    history = shared.header_history(rows, columns)
    rate_index = columns.get("rate")
    time_index = columns.get("time")
    if rate_index is None or time_index is None:
        return history
    return [
        {
            **header,
            "sourceColumn": header["sourceColumn"],
        }
        for header in history
        if rate_index < header["sourceColumn"] < time_index
    ]


def numeric_parse_anomalies(
    source_id: str,
    inspection_id: str,
    page_number: int,
    printed_no: int,
    cell_name: str,
    raw: str,
    parsed: int | float | None,
    parser,
) -> list[dict[str, Any]]:
    cleaned = shared.flattened(raw)
    if is_blank_or_dash(raw):
        return []
    if parsed is None:
        return [
            {
                "code": "result-cell-unparsed",
                "inspectionId": inspection_id,
                "page": page_number,
                "rowNo": printed_no,
                "field": cell_name,
                "message": "A printed result cell could not be parsed as a number; the raw cell is preserved and the parsed value remains null.",
                "evidence": raw,
            }
        ]
    expected = parser(raw)
    if expected != parsed:
        return [
            {
                "code": "result-cell-parse-mismatch",
                "inspectionId": inspection_id,
                "page": page_number,
                "rowNo": printed_no,
                "field": cell_name,
                "message": "Parsed result does not match the shared parser's reading of the raw source cell.",
                "evidence": {"raw": raw, "parsed": parsed, "expected": expected},
            }
        ]
    return []


def extract_inspection(
    page: Any,
    table: Any,
    source_id: str,
    source_key: str,
    page_number: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    rows = table.extract()
    metadata = rows[0]
    page_text = page.extract_text() or ""
    title_match = re.search(r"\b(IQC|OQC)\b\s+Inspection\s+specification", page_text, re.I)
    stage = title_match.group(1).upper() if title_match else None
    printed_version = shared.labelled_value(metadata, "printedVersion")
    printed_date = shared.labelled_value(metadata, "printedDate")
    product_label = shared.labelled_value(metadata, "productLabel")
    batch_quantity_raw = shared.labelled_value(metadata, "batchQuantity")
    recorder = shared.labelled_value(metadata, "recorder")
    page_label = shared.labelled_value(metadata, "printedPage")
    batch_quantity = shared.number_value(batch_quantity_raw)
    notes_row = rows[1] if len(rows) > 1 else []
    notes = "\n".join(
        shared.cell_text(value)
        for value in notes_row
        if shared.cell_text(value)
        and not re.search(r"Special Notes|本批次特殊情况", shared.cell_text(value), re.I)
    ) or None
    color, color_basis = derive_color(notes)
    factory, factory_raw = shared.factory_for_page(page_text)
    factory_raw = visible_factory_line(page_text, factory, factory_raw)
    columns = shared.find_result_columns(rows)
    history_headers = clean_history_columns(rows, columns)
    inspection_id = shared.stable_id("inspection", f"{source_key}|p{page_number}")
    local_anomalies: list[dict[str, Any]] = []
    if not factory:
        local_anomalies.append(
            {
                "code": "factory-logo-or-footer-unresolved",
                "message": "Factory could not be mapped from the printed logo/footer; no factory was inferred from the filename.",
            }
        )
    if color_basis == "special-notes-mixed-color-quantities":
        local_anomalies.append(
            {
                "code": "mixed-product-colors",
                "message": "Special Notes include explicit quantities for more than one S15 color; color remains null and all source notes are preserved.",
                "notes": notes,
            }
        )

    required_columns = ("inspected", "defective", "rate", "sampling", "time")
    missing_columns = [name for name in required_columns if columns.get(name) is None]
    if missing_columns:
        local_anomalies.append(
            {
                "code": "inspection-table-column-unmapped",
                "message": "One or more required source columns were not found in the printed table headers.",
                "columns": missing_columns,
                "columnMap": columns,
            }
        )

    printed_rows: list[dict[str, Any]] = []
    for table_row_index, source_row in enumerate(rows):
        if not source_row or not shared.cell_text(source_row[0]).isdigit():
            continue
        title = shared.nonempty(source_row[1]) if len(source_row) > 1 else None
        if not title:
            # The printed PDF numbers blank template lines. They are not checks.
            continue
        printed_no = int(shared.cell_text(source_row[0]))
        row_id = shared.stable_id("row", f"{inspection_id}|{printed_no}|{table_row_index}")
        sampling_raw = shared.pick_cell(source_row, columns.get("sampling"))
        recording_raw = shared.pick_cell(source_row, columns.get("recording"))
        sampling_percent, recording_rule = shared.split_sampling_and_recording(sampling_raw, recording_raw)
        inspected_raw = shared.pick_cell(source_row, columns.get("inspected"))
        defective_raw = shared.pick_cell(source_row, columns.get("defective"))
        rate_raw = shared.pick_cell(source_row, columns.get("rate"))
        time_raw = shared.pick_cell(source_row, columns.get("time"))
        average_raw = shared.pick_cell(source_row, columns.get("averageTime"))
        important, fill_color = shared.table_fill(page, table.rows[table_row_index].cells)
        photo_evidence, ambiguous_images = shared.row_images(
            page,
            table,
            table_row_index,
            row_id,
            columns.get("remarks"),
            source_id,
        )
        historical_comparisons = []
        for header in history_headers:
            raw_rate = shared.pick_cell(source_row, header["sourceColumn"])
            historical_comparisons.append(
                {
                    "printedDateRaw": header["printedDateRaw"],
                    "printedBatchQuantity": header["printedBatchQuantity"],
                    "sourceDefectiveRate": shared.percentage_value(raw_rate),
                    "sourceDefectiveRateRaw": raw_rate or None,
                    "sourceColumn": header["sourceColumn"],
                }
            )

        source_inspected = shared.number_value(inspected_raw)
        defective = shared.number_value(defective_raw)
        source_rate = shared.percentage_value(rate_raw)
        row_anomalies = []
        for field_name, raw, parsed, value_parser in (
            ("sourceInspectedQty", inspected_raw, source_inspected, shared.number_value),
            ("defectiveQty", defective_raw, defective, shared.number_value),
            ("sourceDefectiveRate", rate_raw, source_rate, shared.percentage_value),
            ("timeSeconds", time_raw, shared.number_value(time_raw), shared.number_value),
            ("averageTimePerUnitSeconds", average_raw, shared.number_value(average_raw), shared.number_value),
        ):
            row_anomalies.extend(
                numeric_parse_anomalies(
                    source_id,
                    inspection_id,
                    page_number,
                    printed_no,
                    field_name,
                    raw,
                    parsed,
                    value_parser,
                )
            )
        if source_inspected is not None and batch_quantity is not None and source_inspected > batch_quantity:
            row_anomalies.append(
                {
                    "code": "source-inspected-quantity-exceeds-batch-quantity",
                    "rowNo": printed_no,
                    "message": "The printed inspected quantity exceeds the printed page batch quantity; both printed values are preserved without correction.",
                    "batchQuantity": batch_quantity,
                    "sourceInspectedQty": source_inspected,
                    "sourceInspectedQtyRaw": inspected_raw,
                }
            )
        if source_inspected is not None and defective is not None and defective > source_inspected:
            row_anomalies.append(
                {
                    "code": "defective-quantity-exceeds-inspected-quantity",
                    "rowNo": printed_no,
                    "message": "The printed defective quantity exceeds the printed inspected quantity; neither source cell was corrected.",
                    "sourceInspectedQty": source_inspected,
                    "defectiveQty": defective,
                }
            )
        if ambiguous_images:
            row_anomalies.append(
                {
                    "code": "embedded-image-not-contained-in-row-remarks",
                    "rowNo": printed_no,
                    "message": "An embedded image overlaps a row remarks cell but is not fully contained there, so it remains evidence in the original PDF and is not assigned to this row.",
                    "evidence": ambiguous_images,
                }
            )

        raw_cells = [shared.nonempty(value) for value in source_row]
        row_record = {
            "id": row_id,
            "no": printed_no,
            "taskIdentity": normalize_task_identity(title),
            "title": title,
            "specification": shared.nonempty(source_row[2]) if len(source_row) > 2 else None,
            "devices": shared.nonempty(source_row[3]) if len(source_row) > 3 else None,
            "samplingPercent": sampling_percent,
            "samplingPercentRaw": sampling_raw or None,
            "recordingRule": recording_rule,
            "recordingRuleRaw": (recording_raw or recording_rule) or None,
            "sourceInspectedQty": source_inspected,
            "sourceInspectedQtyRaw": inspected_raw or None,
            "defectiveQty": defective,
            "defectiveQtyRaw": defective_raw or None,
            "sourceDefectiveRate": source_rate,
            "sourceDefectiveRateRaw": rate_raw or None,
            "timeSeconds": shared.number_value(time_raw),
            "timeSecondsRaw": time_raw or None,
            "averageTimePerUnitSeconds": shared.number_value(average_raw),
            "averageTimePerUnitSecondsRaw": average_raw or None,
            "important": important,
            "importantFillRgb": fill_color,
            "remarks": shared.nonempty(shared.pick_cell(source_row, columns.get("remarks"))),
            "videoProcedureReport": shared.nonempty(shared.pick_cell(source_row, columns.get("video"))),
            "historicalComparisons": historical_comparisons,
            "photoEvidence": photo_evidence,
            "raw": {"tableRowIndex": table_row_index, "printedCells": raw_cells},
        }
        if ambiguous_images:
            row_record["ambiguousPhotoEvidence"] = ambiguous_images
        printed_rows.append(row_record)
        local_anomalies.extend(row_anomalies)

    inspection = {
        "id": inspection_id,
        "sourceId": source_id,
        "page": page_number,
        "printedVersion": shared.flattened(printed_version) if printed_version else None,
        "printedVersionRaw": printed_version,
        "printedDate": shared.flattened(printed_date) if printed_date else None,
        "printedDateRaw": printed_date,
        "date": shared.normalized_date(printed_date),
        "printedPage": shared.flattened(page_label) if page_label else None,
        "productLabel": product_label,
        "model": "S15",
        "modelBasis": "source-folder-and-printed-S15-form-title",
        "color": color,
        "colorBasis": color_basis,
        "factory": factory,
        "factoryRaw": factory_raw,
        "stage": stage,
        "batchQuantity": batch_quantity,
        "batchQuantityRaw": batch_quantity_raw,
        "recorder": recorder,
        "notes": notes,
        "rows": printed_rows,
        "historyColumns": history_headers,
        "sourceText": page_text,
        "anomalies": local_anomalies,
    }
    return inspection, local_anomalies


def detect_new_tasks(inspections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for inspection in inspections:
        for row in inspection["rows"]:
            key = (
                inspection.get("printedVersion") or "",
                inspection.get("factory") or "unresolved",
                inspection.get("stage") or "unresolved",
                row["taskIdentity"],
            )
            grouped.setdefault(key, []).append((inspection, row))
    anomalies = []
    for (version, factory, stage, task_identity), appearances in grouped.items():
        appearances.sort(
            key=lambda pair: (
                pair[0].get("date") or "",
                pair[0]["sourceId"],
                pair[0]["page"],
            )
        )
        first_inspection, first_row = appearances[0]
        same_group = [
            inspection
            for inspection in inspections
            if (inspection.get("printedVersion") or "") == version
            and (inspection.get("factory") or "unresolved") == factory
            and (inspection.get("stage") or "unresolved") == stage
        ]
        first_group_date = min((item.get("date") or "") for item in same_group)
        if (first_inspection.get("date") or "") <= first_group_date:
            continue
        anomalies.append(
            {
                "id": f"{first_inspection['sourceId']}-p{first_inspection['page']}-row-{first_row['no']}-first-seen",
                "sourceId": first_inspection["sourceId"],
                "inspectionId": first_inspection["id"],
                "page": first_inspection["page"],
                "rowNo": first_row["no"],
                "scope": "row-presence",
                "code": "task-first-appears-in-retained-forms",
                "message": f"This printed task first appears in {factory} {stage} forms for printed version {version} on {first_inspection['printedDate']}; earlier printed forms retain their original row lists.",
                "evidence": {
                    "taskIdentity": task_identity,
                    "title": first_row["title"],
                    "factory": factory,
                    "stage": stage,
                    "printedVersion": version,
                },
            }
        )
    return anomalies


def count_by(records: list[dict[str, Any]], field: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for record in records:
        value = record.get(field) or "unresolved"
        result[value] = result.get(value, 0) + 1
    return dict(sorted(result.items()))


def load_inventory() -> list[dict[str, Any]]:
    entries = json.loads(INVENTORY.read_text(encoding="utf-8"))
    return sorted(
        (entry for entry in entries if entry["key"].startswith("S15-")),
        key=lambda entry: int(entry["key"].split("-")[1]),
    )


def extract_package(source_filter: str | None = None, include_assets: bool = True) -> dict[str, Any]:
    inventory = load_inventory()
    if source_filter:
        inventory = [entry for entry in inventory if entry["key"] == source_filter]
        if not inventory:
            raise SystemExit(f"Unknown S15 source key: {source_filter}")

    sources: list[dict[str, Any]] = []
    inspections: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []
    package_anomalies: list[dict[str, Any]] = []
    extracted_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    for entry in inventory:
        path = Path(entry["path"])
        if not path.is_file():
            package_anomalies.append(
                {
                    "sourceKey": entry["key"],
                    "code": "source-pdf-not-found",
                    "message": f"Source PDF is missing: {path}",
                }
            )
            continue
        pdf_bytes = path.read_bytes()
        source_id = f"source-{entry['key'].lower()}"
        asset_id = shared.stable_id("asset", entry["key"])
        source = {
            "id": source_id,
            "inventoryKey": entry["key"],
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
                matched_table = None
                matched_rows = None
                for table in page.find_tables():
                    table_rows = table.extract()
                    if shared.current_inspection_table(page, table_rows):
                        matched_table, matched_rows = table, table_rows
                        break
                if matched_table is None or matched_rows is None:
                    raw_text = page.extract_text() or ""
                    kind = "change-log" if re.search(r"change\s*log|修改内容|date/version#", raw_text, re.I) else "other"
                    source["nonInspectionPages"].append(
                        {
                            "page": page_index,
                            "kind": kind,
                            "heading": next((line.strip() for line in raw_text.splitlines() if line.strip()), None),
                        }
                    )
                    continue
                inspection, local_anomalies = extract_inspection(
                    page,
                    matched_table,
                    source_id,
                    entry["key"],
                    page_index,
                )
                if not inspection["rows"]:
                    package_anomalies.append(
                        {
                            "sourceId": source_id,
                            "page": page_index,
                            "code": "inspection-page-has-no-titled-rows",
                            "message": "The page has inspection metadata but no titled inspection rows.",
                        }
                    )
                source["inspectionPages"].append(page_index)
                inspections.append(inspection)
                for anomaly in local_anomalies:
                    package_anomalies.append(
                        {
                            "sourceId": source_id,
                            "inspectionId": inspection["id"],
                            "page": page_index,
                            **anomaly,
                        }
                    )
        if include_assets:
            assets.append(
                {
                    "id": asset_id,
                    "name": path.name,
                    "mimeType": "application/pdf",
                    "dataUrl": "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode("ascii"),
                    "kind": "document",
                    "batchId": None,
                    "rowId": None,
                    "versionId": None,
                    "createdAt": ASSET_CREATED_AT,
                }
            )
        sources.append(source)

    package_anomalies.extend(detect_new_tasks(inspections))
    summary = {
        "sourceCount": len(sources),
        "sourcePageCount": sum(source["pageCount"] or 0 for source in sources),
        "inspectionPageCount": len(inspections),
        "inspectionRowCount": sum(len(inspection["rows"]) for inspection in inspections),
        "blankNumberedRowsExcluded": True,
        "historicalRateColumnsAreNotCurrentResults": True,
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Extract only one inventory key, such as S15-15")
    parser.add_argument("--output", default="data/pdf-import/s15-extraction.json")
    parser.add_argument("--without-assets", action="store_true", help="Omit embedded PDF data URLs")
    args = parser.parse_args()
    package = extract_package(args.source, include_assets=not args.without_assets)
    output = Path(args.output)
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output),
                "summary": package["summary"],
                "assetCount": len(package["assets"]),
                "anomalyCount": len(package["anomalies"]),
                "bytes": output.stat().st_size,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
