# Lark Version History Import Package

## Status and scope

`data/lark-import/version-history.v1.json` is a reproducible source package for review and import through the Web core. Creating the package does not publish a design version or establish that a version is operational in MasterQC-Web. The Lark Base and its records were read only; attachment binaries were not copied.

The source snapshot was captured on 2026-09-29 in `America/Los_Angeles` (2026-09-29 UTC). It contains 28 revision records at table revision 254, 15 product records at table revision 208, and 211 spec records at table revision 811. All three manifests report complete, single-page snapshots (`has_more: false`) with all fields and all records.

The package scope is limited to the two established Web families:

| Web family ID | Exact values observed in the source field labeled `VENTUS` | In-scope Lark product records |
| --- | --- | ---: |
| `s11-s14` | `S11`, `S12`, `S13`, `S14` | 5, including both S14 records |
| `s15` | `S15` | 1 |

The `VENTUS` label is recorded as the source field label; the mapping uses exact observed field values and does not assert what the field name means.

## Package shape

The JSON package has `schemaVersion: 1` and `packageType: "masterqc-lark-version-history"`. It includes source table metadata and verified table URLs, family product identities, version entries, a count report, and exclusions. Revision and spec rows are retained as `rawRecord` objects with their original labels and values, including blank and null values, exact version spelling, linked-record IDs, and timestamp offsets.

Each version entry has a deterministic ID in the form `lark:<Lark revision record ID>:<Web family ID>`. A source revision linked to both families produces one entry in each family while retaining the same Lark record ID. The entry's `source` includes the source table ID, verified table URL, and visible record ID; no unverified record-level URL is constructed.

`record.specs` contains only specs linked from the revision whose source product links intersect that entry's applicable family product links. Each spec row retains its `sourceRecordId`, matched `applicableProductIds`, and complete raw source record. A spec linked only to another in-scope family in the same revision is omitted from the current family projection and counted as `otherFamilySpecRowsSkipped`; this is a normal relationship projection, not an anomaly. A spec product link absent from the revision's full product link list is flagged as `SPEC_PRODUCT_OUTSIDE_REVISION_PRODUCTS`. Missing linked specs use `ORPHAN_SPEC_LINK`, missing linked products use `UNKNOWN_PRODUCT_LINK`, and broad revision product relationships use `BROAD_PRODUCT_LINKS`.

Attachment metadata remains verbatim in the revision's `rawRecord` and is also available through `record.attachments`. The package does not contain attachment file bytes.

## Generated source report

The generated `report.counts` contains these results:

| Count | Value |
| --- | ---: |
| Source revision rows | 28 |
| Source product rows | 15 |
| Source spec rows | 211 |
| In-scope product records | 6 |
| Distinct included Lark revision IDs | 13 |
| Version entries | 23: `s11-s14` 11; `s15` 12 |
| Included spec rows / distinct spec IDs | 120 / 120 |
| Other-family spec rows skipped from family projections | 86 |
| Spec-product links outside their revision's product links | 0 |
| Orphan spec links | 0 |
| Unknown product links | 0 |
| Broad-product-link source revisions | 1 |
| Attachment metadata rows | 2 |
| Entries with zero included specs | 17 |
| Excluded revision rows | 15: 9 outside-family links; 6 no product links |

Revision `recvvVYXNMjjwO` (`VENTUS`) is included once in each Web family and marked `BROAD_PRODUCT_LINKS` for review. Its raw linked-product IDs remain available in `rawRecord`; the revision is not excluded because its links include products in both Web families.

The entry for S15 revision `26.09.05` preserves raw status `生效中 Active`, effective timestamp `2026-09-24T00:00:00.000-07:00`, change description `fefe`, and zero linked specs. The distinct raw version spelling `26.4.24` is also retained.

Every excluded revision appears in `report.excludedVersionRecords` with `sourceRecordId`, `revisionValue`, `reasonCode`, and `linkedProductIds`. The generated exclusions are:

| Source record ID | Raw revision value | Exclusion reason |
| --- | --- | --- |
| `recvscXCuZfjCY` | `25.04.03` | `no_in_scope_family_links` |
| `recvscXCuZzuFz` | `25.04.15` | `no_in_scope_family_links` |
| `recvscXCuZcyy1` | `25.04.22` | `no_in_scope_family_links` |
| `recvscXCuZA0q9` | `25.05.23` | `no_in_scope_family_links` |
| `recvscXCuZ0QPE` | `25.06.02` | `no_in_scope_family_links` |
| `recvscXCuZ7CXM` | `25.06.04` | `no_in_scope_family_links` |
| `recvscXCuZ8Ava` | `25.07.01` | `no_in_scope_family_links` |
| `recvscXCuZbwTP` | `26.06.03` | `no_in_scope_family_links` |
| `recvuLGJwq6HgW` | `V3` | `no_in_scope_family_links` |
| `recvvnlhwh4PH0` | blank | `no_product_links` |
| `recvvnr60lhrml` | blank | `no_product_links` |
| `recvvnr6UBDYMX` | blank | `no_product_links` |
| `recvvKsCL3O1ir` | blank | `no_product_links` |
| `recvvVZpuOdEul` | `VENTUS` | `no_product_links` |
| `recvwbo44URWIK` | blank | `no_product_links` |

## Rebuilding the package

Run the builder from the project root after placing the three NDJSON exports and their adjacent `.manifest.json` files at the default paths:

```sh
node scripts/build-lark-import.mjs
```

The default input paths are `/tmp/masterqc-web-version-review.ndjson`, `/tmp/masterqc-lark-products.ndjson`, and `/tmp/masterqc-lark-specs.ndjson`. Each input manifest is checked for a complete all-fields/all-records snapshot and a record count matching its NDJSON file. Optional `--revisions`, `--products`, `--specs`, and `--out` flags accept alternate file paths. The generated JSON is stable for the same input snapshots and contains no unrelated source export rows.
