(function (global) {
  "use strict";

  const inspectionItems = [
    {
      id: "air-pump",
      taskEnglish: "Air Pump Test",
      taskChinese: "气泵测试",
      specificationEnglish: "Power on to check whether the air pump and EVAP knob are working properly.",
      specificationChinese: "通电检查气泵、气压调节钮是否正常工作",
      deviceEnglish: "DC power supply",
      deviceChinese: "直流电源",
      sampleFamily: "10% / 0%",
      sampleS15: "10% / 0%",
      timeSeconds: 15,
      history: ["0.00%", "0.00%", "0.00%", "0.00%"]
    },
    {
      id: "power-test",
      taskEnglish: "Power Test",
      taskChinese: "功率测试",
      specificationEnglish: "At 12.7V, check at 3 seconds. S15: 30.1–31.8W. S11/S13: 32.3–34.0W. S12/S14: 30.1–31.8W.",
      specificationChinese: "12.7V电源通电测试，开机3秒功耗在规定范围内（S15范围为30.1~31.8W；S11/S13范围为32.3~34.0W；S12/S14范围为30.1~31.8W）则为合格",
      deviceEnglish: "DC power supply",
      deviceChinese: "直流电源",
      sampleFamily: "10% / 50% + all failed units",
      sampleS15: "10% / 50% + all failed units",
      timeSeconds: 80,
      history: ["0.00%", "0.00%", "0.00%", "0.00%"]
    },
    {
      id: "leak-test",
      taskEnglish: "Smoke Machine Leak Test",
      taskChinese: "发烟器漏气测试",
      specificationEnglish: "Pressure decay after 30 seconds: S15 at 20 PSI must be ≥19.8 PSI. S11–S14 at 12 PSI must be ≥11.8 PSI.",
      specificationChinese: "充气测试，是否漏气，S15气压衰减，30秒后气压不能低于19.8PSI。S11–S14气压衰减，30秒后气压不能低于11.8PSI。",
      deviceEnglish: "Differential pressure gauge / air pump",
      deviceChinese: "差压计/气泵",
      sampleFamily: "10% / 50% + all failed units",
      sampleS15: "10% / 50% + all failed units",
      timeSeconds: 80,
      history: ["0.00%", "0.00%", "0.00%", "0.00%"]
    },
    {
      id: "final-packaging",
      taskEnglish: "Final Packaging",
      taskChinese: "最终包装检查",
      specificationEnglish: "EVAP knob pointing to EVAP; check accessory placement and support sticker.",
      specificationChinese: "旋钮位置指向EVAP，物品放置位置，贴纸",
      deviceEnglish: "Visual inspection",
      deviceChinese: "目测",
      sampleFamily: "10% / 0%",
      sampleS15: "100% / 0%",
      timeSeconds: 8,
      history: ["1.25%", "0.00%", "2.50%", "0.00%"]
    }
  ];

  const variantCatalog = ["S11", "S12", "S13", "S14", "S15"].flatMap((model) => [
    { id: `${model}-red`, model, color: "Red", displayName: model, family: model === "S15" ? "S15" : "S11–S14" },
    { id: `${model}-yellow`, model, color: "Yellow", displayName: `${model} Yellow`, family: model === "S15" ? "S15" : "S11–S14" }
  ]);

  function emptyInspection() {
    return { inspectedQty: null, defectiveQty: null, defectiveRate: null, remarks: "", saved: false };
  }

  function makeBatch(details) {
    const inspections = {};
    for (const item of inspectionItems) inspections[item.id] = emptyInspection();
    return {
      id: details.id,
      poLineId: details.poLineId,
      variantId: details.variantId,
      model: details.model,
      color: details.color,
      displayName: details.displayName,
      family: details.family,
      quantity: details.quantity,
      batchDate: details.batchDate,
      recorder: details.recorder,
      specialNotes: details.specialNotes || "",
      factory: "AP",
      stage: "OQC",
      sourceRevision: "25.10.29",
      status: "draft",
      inspections,
      photos: Object.fromEntries(inspectionItems.map((item) => [item.id, []])),
      issues: {},
      releasedAt: null
    };
  }

  function createInitialState() {
    const orderLines = variantCatalog.map((variant, index) => ({
      id: `PO-DEMO-0927-L${index + 1}`,
      poId: "PO-DEMO-0927",
      poNumber: "PO-DEMO-0927",
      variantId: variant.id,
      model: variant.model,
      color: variant.color,
      displayName: variant.displayName,
      family: variant.family,
      orderedQty: variant.color === "Yellow" ? (variant.model === "S15" ? 180 : 120) : (variant.model === "S15" ? 800 : 500)
    }));

    const releasedS15 = makeBatch({
      poLineId: orderLines.find((line) => line.variantId === "S15-red").id,
      variantId: "S15-red",
      ...variantCatalog.find((variant) => variant.id === "S15-red"),
      id: "B-DEMO-S15-01",
      quantity: 240,
      batchDate: "2026-09-20",
      recorder: "Demo recorder",
      specialNotes: "Seeded released example. All figures in this example are synthetic demo values."
    });
    for (const item of inspectionItems) {
      const inspectedQty = item.id === "final-packaging" ? 240 : 24;
      releasedS15.inspections[item.id] = {
        inspectedQty,
        defectiveQty: 0,
        defectiveRate: 0,
        remarks: "Seeded demo result",
        saved: true,
        savedAt: "2026-09-20T10:00:00.000Z"
      };
    }
    releasedS15.status = "released";
    releasedS15.releasedAt = "2026-09-20T12:00:00.000Z";

    const activeS15 = makeBatch({
      poLineId: orderLines.find((line) => line.variantId === "S15-red").id,
      variantId: "S15-red",
      ...variantCatalog.find((variant) => variant.id === "S15-red"),
      id: "B-DEMO-S15-02",
      quantity: 160,
      batchDate: "2026-09-27",
      recorder: "",
      specialNotes: ""
    });
    const yellowS15 = makeBatch({
      poLineId: orderLines.find((line) => line.variantId === "S15-yellow").id,
      variantId: "S15-yellow",
      ...variantCatalog.find((variant) => variant.id === "S15-yellow"),
      id: "B-DEMO-S15Y-01",
      quantity: 80,
      batchDate: "2026-09-27",
      recorder: "",
      specialNotes: ""
    });
    return {
      orderLines,
      batches: [releasedS15, activeS15, yellowS15],
      issues: {},
      currentBatchId: activeS15.id,
      nextBatchNumber: 2,
      nextPhotoNumber: 1,
      nextIssueNumber: 1
    };
  }

  class PrototypeMemory {
    constructor(state) {
      this.state = state || createInitialState();
    }

    read() {
      return this.state;
    }

    write(mutator) {
      return mutator(this.state);
    }
  }

  global.PrototypeMemory = {
    create: () => new PrototypeMemory(createInitialState()),
    createBatch: makeBatch,
    inspectionItems,
    variantCatalog
  };
})(window);
