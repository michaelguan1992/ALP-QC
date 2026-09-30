(function (global) {
  "use strict";

  const templateItems = global.PrototypeMemory.inspectionItems;
  const variants = global.PrototypeMemory.variantCatalog;

  function fail(message) {
    throw new Error(message);
  }

  function requireBatch(state, batchId) {
    const batch = state.batches.find((candidate) => candidate.id === batchId);
    if (!batch) fail("That demo batch is no longer available in this session.");
    return batch;
  }

  function requireEditable(batch) {
    if (batch.status === "released") fail("This batch is released. Its demo records are read-only.");
  }

  function findIssue(state, batch, rowId) {
    return state.issues[`${batch.id}:${rowId}`] || null;
  }

  function fullItem(item, batch) {
    const isS15 = batch.family === "S15";
    let specificationEnglish = item.specificationEnglish;
    let specificationChinese = item.specificationChinese;
    if (item.id === "power-test") {
      if (batch.model === "S11" || batch.model === "S13") {
        specificationEnglish = "At 12.7V, check at 3 seconds. Passing power consumption: 32.3–34.0W.";
        specificationChinese = "12.7V电源通电测试，开机3秒功耗在32.3~34.0W范围内则为合格。";
      } else if (batch.model === "S12" || batch.model === "S14") {
        specificationEnglish = "At 12.7V, check at 3 seconds. Passing power consumption: 30.1–31.8W.";
        specificationChinese = "12.7V电源通电测试，开机3秒功耗在30.1~31.8W范围内则为合格。";
      } else {
        specificationEnglish = "At 12.7V, check at 3 seconds. Passing power consumption: 30.1–31.8W.";
        specificationChinese = "12.7V电源通电测试，开机3秒功耗在30.1~31.8W范围内（S15）则为合格。";
      }
    } else if (item.id === "leak-test") {
      if (isS15) {
        specificationEnglish = "20 PSI pressure decay test: after 30 seconds, pressure must remain ≥19.8 PSI.";
        specificationChinese = "S15：20PSI气压衰减测试，30秒后气压不能低于19.8PSI。";
      } else {
        specificationEnglish = "12 PSI pressure decay test: after 30 seconds, pressure must remain ≥11.8 PSI.";
        specificationChinese = "S11–S14：12PSI气压衰减测试，30秒后气压不能低于11.8PSI。";
      }
    }
    return {
      ...item,
      specificationEnglish,
      specificationChinese,
      samplingRule: isS15 ? item.sampleS15 : item.sampleFamily
    };
  }

  function inspectionQuantity(item, batch) {
    const samplingRule = fullItem(item, batch).samplingRule;
    const percentageMatch = typeof samplingRule === "string"
      ? /^\s*(\d+(?:\.\d+)?)\s*%/.exec(samplingRule)
      : null;
    if (!percentageMatch) {
      fail(`Unsupported inspection sampling rule for ${item.taskEnglish}: ${samplingRule || "missing"}`);
    }
    const percentage = Number(percentageMatch[1]);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      fail(`Unsupported inspection sampling percentage for ${item.taskEnglish}: ${percentageMatch[1]}%`);
    }
    if (!Number.isSafeInteger(batch.quantity) || batch.quantity <= 0) {
      fail("Batch quantity must be a positive whole number.");
    }
    return Math.ceil(batch.quantity * percentage / 100);
  }

  class PrototypeService {
    constructor(memory) {
      this.memory = memory;
    }

    getOverview() {
      const state = this.memory.read();
      return {
        batches: state.batches,
        currentBatchId: state.currentBatchId,
        orderLines: state.orderLines
      };
    }

    selectBatch(batchId) {
      const state = this.memory.read();
      requireBatch(state, batchId);
      this.memory.write((current) => { current.currentBatchId = batchId; });
      return this.getBatchWorkspace(batchId);
    }

    getBatchWorkspace(batchId) {
      const state = this.memory.read();
      const id = batchId || state.currentBatchId;
      const batch = requireBatch(state, id);
      return {
        batch,
        items: templateItems.map((item) => {
          const inspection = batch.inspections[item.id];
          return {
            ...fullItem(item, batch),
            inspection: {
              ...inspection,
              inspectedQty: batch.status === "released"
                ? inspection.inspectedQty
                : inspectionQuantity(item, batch)
            },
            photos: batch.photos[item.id],
            issue: findIssue(state, batch, item.id)
          };
        })
      };
    }

    saveBatchDetails(batchId, details) {
      const state = this.memory.read();
      const batch = requireBatch(state, batchId);
      requireEditable(batch);
      if (typeof details.recorder !== "string" || typeof details.batchDate !== "string" || typeof details.specialNotes !== "string") {
        fail("Enter a recorder, batch date, and special notes using the fields shown.");
      }
      this.memory.write((current) => {
        const target = requireBatch(current, batchId);
        target.recorder = details.recorder.trim();
        target.batchDate = details.batchDate;
        target.specialNotes = details.specialNotes.trim();
      });
      return this.getBatchWorkspace(batchId);
    }

    createBatch(details) {
      const state = this.memory.read();
      const line = state.orderLines.find((candidate) => candidate.id === details.poLineId);
      if (!line) fail("Choose a demo purchase order line.");
      const quantity = Number(details.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) fail("Batch quantity must be a positive whole number.");
      if (typeof details.recorder !== "string" || typeof details.batchDate !== "string") fail("Enter a recorder and batch date.");
      const variant = variants.find((candidate) => candidate.id === line.variantId);
      if (!variant) fail("The selected product variant is unavailable.");
      const number = state.nextBatchNumber;
      const suffix = String(number).padStart(2, "0");
      const batchId = `B-DEMO-${variant.model}${variant.color === "Yellow" ? "Y" : "R"}-${suffix}`;
      const batch = global.PrototypeMemory.createBatch({
        poLineId: line.id,
        ...variant,
        variantId: variant.id,
        id: batchId,
        quantity,
        batchDate: details.batchDate,
        recorder: details.recorder,
        specialNotes: details.specialNotes || ""
      });
      this.memory.write((current) => {
        if (current.batches.some((candidate) => candidate.id === batchId)) fail("The demo batch ID already exists.");
        current.batches.push(batch);
        current.nextBatchNumber += 1;
        current.currentBatchId = batchId;
      });
      return this.getBatchWorkspace(batchId);
    }

    saveInspection(batchId, rowId, details) {
      const state = this.memory.read();
      const batch = requireBatch(state, batchId);
      requireEditable(batch);
      if (!templateItems.some((item) => item.id === rowId)) fail("That inspection row is unavailable.");
      if (details.defectiveQty == null || String(details.defectiveQty).trim() === "") fail("Enter a defective quantity before saving this row.");
      const item = templateItems.find((candidate) => candidate.id === rowId);
      const inspectedQty = inspectionQuantity(item, batch);
      const defectiveQty = Number(details.defectiveQty);
      if (!Number.isSafeInteger(defectiveQty) || defectiveQty < 0) fail("Defective quantity must be a whole number of zero or more.");
      if (defectiveQty > inspectedQty) fail("Defective quantity cannot exceed inspection quantity.");
      if (typeof details.remarks !== "string") fail("Remarks must be text.");
      this.memory.write((current) => {
        const target = requireBatch(current, batchId);
        const row = target.inspections[rowId];
        row.inspectedQty = inspectedQty;
        row.defectiveQty = defectiveQty;
        row.defectiveRate = inspectedQty === 0 ? null : Number(((defectiveQty / inspectedQty) * 100).toFixed(2));
        row.remarks = details.remarks.trim();
        row.saved = true;
        row.savedAt = new Date().toISOString();
      });
      return this.getBatchWorkspace(batchId);
    }

    addPhoto(batchId, rowId, photo) {
      const state = this.memory.read();
      const batch = requireBatch(state, batchId);
      requireEditable(batch);
      if (!batch.photos[rowId]) fail("That inspection row is unavailable.");
      if (!photo || typeof photo.name !== "string" || typeof photo.dataUrl !== "string" || !photo.dataUrl.startsWith("data:image/")) {
        fail("Choose an image file to add demo evidence.");
      }
      const photoId = `PHOTO-DEMO-${String(state.nextPhotoNumber).padStart(3, "0")}`;
      this.memory.write((current) => {
        requireBatch(current, batchId).photos[rowId].push({ id: photoId, name: photo.name, dataUrl: photo.dataUrl });
        current.nextPhotoNumber += 1;
      });
      return photoId;
    }

    removePhoto(batchId, rowId, photoId) {
      const batch = requireBatch(this.memory.read(), batchId);
      requireEditable(batch);
      if (!batch.photos[rowId]) fail("That inspection row is unavailable.");
      this.memory.write((current) => {
        const photos = requireBatch(current, batchId).photos[rowId];
        const index = photos.findIndex((photo) => photo.id === photoId);
        if (index >= 0) photos.splice(index, 1);
      });
    }

    createIssueFromInspection(batchId, rowId) {
      const state = this.memory.read();
      const batch = requireBatch(state, batchId);
      requireEditable(batch);
      const item = templateItems.find((candidate) => candidate.id === rowId);
      if (!item) fail("That inspection row is unavailable.");
      const existing = findIssue(state, batch, rowId);
      if (existing) return existing;
      const issueId = `ISSUE-DEMO-${String(state.nextIssueNumber).padStart(3, "0")}`;
      const record = batch.inspections[rowId];
      const full = fullItem(item, batch);
      const issue = {
        id: issueId,
        sourceKey: `${batchId}:${rowId}`,
        batchId,
        rowId,
        sourceSnapshot: {
          batchId,
          batchName: `${batch.displayName} · ${batchId}`,
          rowId,
          taskEnglish: item.taskEnglish,
          taskChinese: item.taskChinese,
          standardEnglish: full.specificationEnglish,
          standardChinese: full.specificationChinese,
          saved: record.saved,
          inspectedQty: inspectionQuantity(item, batch),
          defectiveQty: record.defectiveQty,
          defectiveRate: record.defectiveRate,
          remarks: record.remarks,
          photoIds: batch.photos[rowId].map((photo) => photo.id)
        },
        status: "open",
        owner: "",
        formalDisposition: "",
        confirmations: ["", "", ""],
        discussion: [],
        createdAt: new Date().toISOString(),
        closedAt: null
      };
      this.memory.write((current) => {
        if (current.issues[`${batchId}:${rowId}`]) return;
        current.issues[`${batchId}:${rowId}`] = issue;
        requireBatch(current, batchId).issues[rowId] = issueId;
        current.nextIssueNumber += 1;
      });
      return this.memory.read().issues[`${batchId}:${rowId}`];
    }

    saveIssueDisposition(issueId, details) {
      const issue = this.getIssue(issueId);
      if (issue.status === "closed") fail("This issue is closed and is read-only in the demo.");
      if (typeof details.owner !== "string" || typeof details.formalDisposition !== "string" || !Array.isArray(details.confirmations)) {
        fail("Complete the disposition fields shown.");
      }
      this.memory.write((state) => {
        const target = state.issues[`${issue.batchId}:${issue.rowId}`];
        target.owner = details.owner.trim();
        target.formalDisposition = details.formalDisposition.trim();
        target.confirmations = [0, 1, 2].map((index) => String(details.confirmations[index] || "").trim());
      });
      return this.getIssue(issueId);
    }

    addIssueDiscussion(issueId, text) {
      const issue = this.getIssue(issueId);
      if (issue.status === "closed") fail("This issue is closed and is read-only in the demo.");
      const message = String(text || "").trim();
      if (!message) fail("Enter a discussion note before adding it.");
      this.memory.write((state) => {
        state.issues[`${issue.batchId}:${issue.rowId}`].discussion.push({
          text: message,
          createdAt: new Date().toISOString()
        });
      });
      return this.getIssue(issueId);
    }

    closeIssue(issueId) {
      const issue = this.getIssue(issueId);
      if (issue.status === "closed") fail("This issue is already closed.");
      if (!issue.owner.trim()) fail("Assign a disposition owner before closing the issue.");
      if (!issue.formalDisposition.trim()) fail("Save a formal disposition before closing the issue.");
      if (issue.confirmations.some((name) => !name.trim())) fail("Enter all three manual name confirmations before closing the issue.");
      this.memory.write((state) => {
        const target = state.issues[`${issue.batchId}:${issue.rowId}`];
        target.status = "closed";
        target.closedAt = new Date().toISOString();
      });
      return this.getIssue(issueId);
    }

    getIssue(issueId) {
      const issues = this.memory.read().issues;
      const issue = Object.values(issues).find((candidate) => candidate.id === issueId);
      if (!issue) fail("The linked demo issue is unavailable.");
      return issue;
    }

    releaseBatch(batchId) {
      const state = this.memory.read();
      const batch = requireBatch(state, batchId);
      if (batch.status === "released") fail("This batch is already released; its PO quantity was counted once.");
      const incomplete = templateItems.filter((item) => !batch.inspections[item.id].saved);
      if (incomplete.length) fail(`Save all four inspection records first. Still missing: ${incomplete.map((item) => item.taskEnglish).join(", ")}.`);
      const openIssues = Object.values(state.issues).filter((issue) => issue.batchId === batchId && issue.status === "open");
      if (openIssues.length) fail("Close every linked issue before releasing this batch.");
      this.memory.write((current) => {
        const target = requireBatch(current, batchId);
        if (target.status === "released") fail("This batch is already released; its PO quantity was counted once.");
        target.status = "released";
        target.releasedAt = new Date().toISOString();
      });
      return this.getBatchWorkspace(batchId);
    }

    getPurchaseOrderProgress() {
      const state = this.memory.read();
      return state.orderLines.map((line) => {
        const batches = state.batches.filter((batch) => batch.poLineId === line.id);
        const releasedQty = batches
          .filter((batch) => batch.status === "released")
          .reduce((total, batch) => total + batch.quantity, 0);
        return {
          ...line,
          releasedQty,
          remainingQty: Math.max(line.orderedQty - releasedQty, 0),
          excessQty: Math.max(releasedQty - line.orderedQty, 0),
          batches: batches.map((batch) => ({
            id: batch.id,
            quantity: batch.quantity,
            status: batch.status,
            batchDate: batch.batchDate
          }))
        };
      });
    }
  }

  global.PrototypeService = {
    create: (memory) => new PrototypeService(memory || global.PrototypeMemory.create()),
    PrototypeService
  };
})(window);
