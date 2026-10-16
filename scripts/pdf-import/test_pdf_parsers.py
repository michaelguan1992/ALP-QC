#!/usr/bin/env python3
"""Self-check for the PDF history parsers. Needs only the Python standard library.

Run from the project root with:  python3 -I scripts/pdf-import/test_pdf_parsers.py
pdfplumber is not required: the extractors import it lazily, and these tests
exercise the pure helpers with synthetic table cells and rectangles.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT / "scripts/pdf-import-s15")]

import extract_s1_history as s1  # noqa: E402
import extract_s15 as s15  # noqa: E402


class RateAndNumberParsing(unittest.TestCase):
    def test_bare_number_in_rate_column_is_a_percent(self) -> None:
        self.assertEqual(s1.rate_percent_value("1.58"), 1.58)
        self.assertEqual(s1.rate_percent_value("1.58%"), 1.58)

    def test_printed_zero_stays_zero_and_blank_stays_null(self) -> None:
        self.assertEqual(s1.rate_percent_value("0"), 0.0)
        self.assertEqual(s1.rate_percent_value("0.00%"), 0.0)
        self.assertIsNone(s1.rate_percent_value("—"))
        self.assertIsNone(s1.rate_percent_value(""))
        self.assertIsNone(s1.rate_percent_value(None))

    def test_unclear_rate_text_is_not_guessed(self) -> None:
        self.assertIsNone(s1.rate_percent_value("1,58"))
        self.assertIsNone(s1.rate_percent_value("about 2"))

    def test_clean_number_accepts_one_token_only(self) -> None:
        self.assertEqual(s1.clean_number_value("380"), 380)
        self.assertEqual(s1.clean_number_value("1,234"), 1234)
        self.assertEqual(s1.clean_number_value("1.58 %", allow_percent=True), 1.58)
        self.assertIsNone(s1.clean_number_value("1.58%"))
        self.assertIsNone(s1.clean_number_value("6 defective"))
        self.assertIsNone(s1.clean_number_value("1.58 (approx.)", allow_percent=True))


class ResultCellAnomalies(unittest.TestCase):
    def check(self, raw: str, parsed, allow_percent: bool = False) -> list[dict]:
        return s1.numeric_cell_anomalies(7, "defectiveQty", raw, parsed, allow_percent)

    def test_clean_and_blank_cells_produce_no_anomaly(self) -> None:
        self.assertEqual(self.check("6", 6), [])
        self.assertEqual(self.check("—", None), [])
        self.assertEqual(self.check("——", None), [])
        self.assertEqual(self.check("1.58", 1.58, allow_percent=True), [])

    def test_unreadable_cell_is_reported_as_unparsed(self) -> None:
        anomalies = self.check("n/a text", None)
        self.assertEqual([item["code"] for item in anomalies], ["result-cell-unparsed"])

    def test_partly_readable_cell_is_a_parse_mismatch(self) -> None:
        anomalies = self.check("6 defective", 6)
        self.assertEqual([item["code"] for item in anomalies], ["result-cell-parse-mismatch"])
        self.assertEqual(anomalies[0]["evidence"], {"raw": "6 defective", "parsed": 6, "expected": None})


class ColorByQuantity(unittest.TestCase):
    def test_parity_fixture_matches_the_rule(self) -> None:
        fixture = json.loads((ROOT / "tests/fixtures/s15-color-cases.json").read_text(encoding="utf-8"))
        for case in fixture["cases"]:
            with self.subTest(case=case["name"]):
                color, basis, anomaly = s15.derive_color(case["notes"], case["batchQuantity"])
                expected = case["expected"]
                self.assertEqual(color, expected["color"])
                self.assertEqual(basis, expected["colorBasis"])
                self.assertEqual(anomaly, expected["anomaly"])

    def test_partial_remaining_quantity_never_colors_the_whole_batch(self) -> None:
        color, basis, anomaly = s15.derive_color("Remaining red: 384PCS. Production: 832PCS.", 832)
        self.assertIsNone(color)
        self.assertEqual(basis, "special-notes-partial-color-quantity")
        self.assertEqual(anomaly["code"], "partial-color-allocation")

    def test_quantity_equal_to_batch_assigns_the_color(self) -> None:
        self.assertEqual(s15.derive_color("S15 -red：768 PCS；", 768)[0], "red")


class FillRectangles(unittest.TestCase):
    CELL = [(10.0, 100.0, 300.0, 120.0)]

    class Page:
        def __init__(self, rects: list[dict]) -> None:
            self.rects = rects

    def rect(self, **overrides) -> dict:
        base = {"x0": 10.0, "x1": 300.0, "top": 100.0, "bottom": 120.0, "non_stroking_color": (0.757, 0.941, 0.784), "fill": True}
        base.update(overrides)
        return base

    def test_green_highlight_is_important(self) -> None:
        important, rgb = s1.table_fill(self.Page([self.rect()]), self.CELL)
        self.assertTrue(important)
        self.assertEqual(rgb, "0.757,0.941,0.784")

    def test_hairline_border_is_not_a_fill(self) -> None:
        border = self.rect(x1=10.5, non_stroking_color=(0, 0, 0))
        self.assertEqual(s1.table_fill(self.Page([border]), self.CELL), (False, "none"))

    def test_stroke_only_rectangle_is_not_a_fill(self) -> None:
        outline = self.rect(fill=False, non_stroking_color=(0, 0, 0))
        self.assertEqual(s1.table_fill(self.Page([outline]), self.CELL), (False, "none"))

    def test_widest_filled_rectangle_wins_over_a_border(self) -> None:
        border = self.rect(x1=10.5, non_stroking_color=(0, 0, 0))
        green = self.rect()
        important, rgb = s1.table_fill(self.Page([border, green]), self.CELL)
        self.assertTrue(important)
        self.assertEqual(rgb, "0.757,0.941,0.784")


class SourceResolution(unittest.TestCase):
    def test_entries_resolve_only_inside_their_folder_with_a_pdf_header(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "S1").mkdir()
            (root / "S1" / "good.pdf").write_bytes(b"%PDF-1.4\n%test\n")
            (root / "S1" / "text.pdf").write_bytes(b"not a pdf")
            (root / "outside.pdf").write_bytes(b"%PDF-1.4\n")
            entry = {"key": "S1-01", "folder": "S1", "fileName": "good.pdf"}
            resolved = s1.resolve_source_pdf(root, entry)
            self.assertEqual(resolved.name, "good.pdf")
            self.assertTrue(s1.read_source_pdf(resolved).startswith(b"%PDF-"))

            with self.assertRaises(SystemExit):
                s1.resolve_source_pdf(root, {"key": "S1-02", "folder": "S1", "fileName": "missing.pdf"})
            with self.assertRaises(SystemExit):
                s1.resolve_source_pdf(root, {"key": "S1-03", "folder": "S1", "fileName": "../outside.pdf"})
            with self.assertRaises(SystemExit):
                s1.read_source_pdf(root / "S1" / "text.pdf")

    def test_committed_manifest_lists_fifteen_files_per_family(self) -> None:
        self.assertEqual(len(s1.load_source_manifest("S1-")), 15)
        self.assertEqual(len(s1.load_source_manifest("S15-")), 15)


class SyntheticTable:
    """Minimal stand-in for a pdfplumber table: rows of cell text plus cell boxes."""

    COLUMNS = 13

    def __init__(self, rows: list[list[str]]) -> None:
        self._rows = rows
        self.rows = [type("Row", (), {"cells": [self._box(col, index) for col in range(self.COLUMNS)]})() for index in range(len(rows))]

    @staticmethod
    def _box(col: int, row: int) -> tuple[float, float, float, float]:
        left = 10.0 + col * 20.0
        top = 100.0 + row * 20.0
        return (left, top, left + 20.0, top + 20.0)

    def extract(self) -> list[list[str]]:
        return self._rows


class SyntheticPage:
    def __init__(self, rects: list[dict]) -> None:
        self.rects = rects
        self.images: list[dict] = []

    def extract_text(self) -> str:
        return "OQC Inspection specification 出货检验规范\nSuzhou Aotuline Precision Manufacturing Co., Ltd."


def synthetic_form() -> tuple[SyntheticTable, list[dict]]:
    def data(no: int, title: str, sampling: str, inspected: str, defective: str, rate: str) -> list[str]:
        return [str(no), title, "Spec text", "Gauge", sampling, "", inspected, defective, rate, "30", "30", "", ""]

    rows = [
        ["Item Name 品名", "HyperSmoke 15", "Batch Qty 批次数量", "832", "Batch Date 批次日期", "2026.5.21", "Recorded by 记录人员", "Tester", "Version 版本", "25.10.29", "Page 页数", "1/1", ""],
        ["Special Notes 本批次特殊情况", "Production: 832PCS. Remaining red: 384PCS.", "", "", "", "", "", "", "", "", "", "", ""],
        ["", "", "", "", "Inspection frequency 检验频率", "Logging frequency", "", "", "", "Time 时数", "Average time 单件平均工时", "Video 视频", "Remarks 备注"],
        ["序号", "QC Task 检查项目", "Specifications", "Devices", "", "", "Inspection qty 检验数量", "Defective qty 不良数", "Defective rate 不良率", "", "", "", ""],
        data(1, "Air Pump Test", "100%", "380", "6", "1.58"),
        data(2, "Power Test", "10%", "832", "0", "0"),
        data(3, "Leak Test", "10%", "832", "x", "0.5%"),
        data(4, "Final Packaging", "10%", "832", "6 defective", "1.58%"),
    ]
    table = SyntheticTable(rows)
    rects = []
    left, top, _, bottom = table.rows[4].cells[0]
    rects.append({"x0": left, "x1": left + 300, "top": top, "bottom": bottom, "non_stroking_color": (0.757, 0.941, 0.784), "fill": True})
    left, top, _, bottom = table.rows[5].cells[0]
    rects.append({"x0": left, "x1": left + 0.5, "top": top, "bottom": bottom, "non_stroking_color": (0, 0, 0), "fill": False})
    return table, rects


class PageLevelExtraction(unittest.TestCase):
    def test_s15_page_rows_rates_colors_and_anomalies(self) -> None:
        table, rects = synthetic_form()
        inspection, _ = s15.extract_inspection(SyntheticPage(rects), table, "source-s15-99", "S15-99", 1)
        self.assertIsNone(inspection["color"])
        self.assertEqual(inspection["colorBasis"], "special-notes-partial-color-quantity")
        codes = [item["code"] for item in inspection["anomalies"]]
        self.assertIn("partial-color-allocation", codes)
        self.assertIn("result-cell-unparsed", codes)
        self.assertIn("result-cell-parse-mismatch", codes)
        for item in inspection["anomalies"]:
            self.assertNotIn("inspectionId", item, "inspection-level anomalies carry no extractor identifiers")
        rows = {row["no"]: row for row in inspection["rows"]}
        self.assertEqual(rows[1]["sourceDefectiveRate"], 1.58)
        self.assertTrue(rows[1]["important"])
        self.assertEqual(rows[2]["sourceDefectiveRate"], 0.0)
        self.assertEqual(rows[2]["important"], False)
        self.assertEqual(rows[2]["importantFillRgb"], "none")
        self.assertIsNone(rows[3]["defectiveQty"])
        self.assertEqual(rows[4]["defectiveQty"], 6)

    def test_s1_page_reads_bare_rates_and_reports_unreadable_cells(self) -> None:
        table, rects = synthetic_form()
        inspection, _ = s1.extract_page(SyntheticPage(rects), table, "source-s1-99", "S1-99", 1, Path("S1-99.pdf"))
        rows = {row["no"]: row for row in inspection["rows"]}
        self.assertEqual(rows[1]["sourceDefectiveRate"], 1.58)
        self.assertEqual(rows[2]["sourceDefectiveRate"], 0.0)
        self.assertEqual(rows[2]["importantFillRgb"], "none")
        codes = {item["code"] for item in inspection["anomalies"]}
        self.assertIn("result-cell-unparsed", codes)
        self.assertIn("result-cell-parse-mismatch", codes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
