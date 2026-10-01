# MasterQC Web Domain

MasterQC Web organizes product inspection standards, batch inspection results, issue disposition, and purchase quantity tracking. This glossary distinguishes shared inspection requirements from individual products and recorded inspection facts.

## Language

**Inspection family (检验类别)**:
A grouping of product models that share inspection requirements. The current families are S11-S14 and S15.
_Avoid_: Product model, color variant

**Product model (产品型号)**:
A distinct product identity such as S11, S12, S13, S14, or S15. Different models can belong to the same inspection family.
_Avoid_: Inspection family

**Product variant (产品变体)**:
A product model distinguished by color or another minor variation relevant to purchasing. Different variants can share inspection requirements while requiring separate purchase quantity tracking.
_Avoid_: Design version

**Normal color variant (普通颜色款)**:
The normal red variant, whose displayed product name omits a color label, such as `S15`.

**Yellow variant (黄色款)**:
The special yellow variant identified by the `Yellow` display label, such as `S15 Yellow`, and tracked separately from the normal variant for purchase quantities.

**Purchase order (采购订单 / PO)**:
An order specifying quantities to purchase for particular product variants, whose quantity requirements can be met across multiple batches.

**Released quantity (已放行数量)**:
The quantity covered by an inspection release. Only released quantities attributable to a purchase requirement count toward its quantity completion; unreleased quantities and inspection sample counts do not.

**Design version (设计版本)**:
A family-specific version of a product's design that defines one complete inspection standard set. A batch may use one shared version label that resolves to a different version entity for each selected family.

**Inspection standard set (整套检验规范)**:
The collection of inspection items defined by one design version, including their applicability to different factories and inspection stages.
_Avoid_: Inspection record, batch result

**Inspection item (检验项目)**:
An individual check in an inspection standard set, with its requirements and factory/stage applicability.
_Avoid_: Inspection record

**Inspection stage (检验阶段)**:
The IQC or OQC context used with the factory to identify the applicable inspection items.

**Batch (批次)**:
The business object for a batch inspection. A newly entered batch belongs to one purchase order and contains one or more colors of one product model with separate quantities. Existing mixed-model records remain supported, but new batches cannot mix models. It selects one shared design-version label; each product resolves that label within its inspection family and locks its applicable inspection standards at creation. Historical batches preserve the version, standards, and results recorded in the original inspection, including unknown order or variant links. Both appear in the same Batches workspace.

**Batch attachment (批次附件)**:
An optional document associated with a batch, such as its original inspection PDF. The attachment is supporting evidence, not the batch itself. One source document may support several batches, and a batch entered directly in the system need not have a PDF.

**Inspection record (检测记录)**:
The recorded inspection facts for an inspection item and product in a particular batch. Records for different products or batches are separate facts, even when they use the same standard item.
_Avoid_: Inspection standard, inspection item
