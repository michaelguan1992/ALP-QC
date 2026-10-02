import { dataService } from "../core/app-service.js";

const form = document.querySelector("#draft-form");
const noteField = document.querySelector("#draft-note");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");
const storageStatus = document.querySelector("#storage-status");

function showStorageStatus(message, state) {
  storageStatus.textContent = message;
  storageStatus.dataset.state = state;
}

function displayError(error) {
  const message = error instanceof Error ? error.message : "未知错误";
  return `本地存储操作失败：${message}`;
}

async function loadDraft() {
  try {
    await dataService.initialize();
    showStorageStatus("IndexedDB 可用", "ready");
    noteField.value = await dataService.loadInitializationDraft();
    saveStatus.textContent = "草稿已读取。";
    noteField.disabled = false;
    saveButton.disabled = false;
  } catch (error) {
    showStorageStatus("本地存储不可用", "error");
    saveStatus.textContent = displayError(error);
    noteField.disabled = true;
    saveButton.disabled = true;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saveButton.disabled) return;

  saveButton.disabled = true;
  saveStatus.textContent = "正在保存…";
  try {
    await dataService.saveInitializationDraft(noteField.value);
    saveStatus.textContent = "草稿已保存。";
    showStorageStatus("IndexedDB 可用", "ready");
  } catch (error) {
    saveStatus.textContent = displayError(error);
    showStorageStatus("本地存储写入失败", "error");
  } finally {
    saveButton.disabled = false;
  }
});

void loadDraft();
