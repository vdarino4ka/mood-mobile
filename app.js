const moods = [
  { value: "продуктивное", className: "mood-productivity" },
  { value: "грустное", className: "mood-sad" },
  { value: "тревожное", className: "mood-anxious" },
  { value: "игривое", className: "mood-playful" },
  { value: "злое", className: "mood-angry" },
  { value: "никакое", className: "mood-empty" },
];

const activities = ["батонюсь", "физ.труд", "ум. труд"];
const legacyStorageKey = "mood-mobile-prototype-records";
const migrationKey = "mood-mobile-indexeddb-migrated-at";
const databaseName = "mood-mobile-db";
const databaseVersion = 1;
const storeName = "records";

const moodButtons = document.querySelector("#moodButtons");
const activityButtons = document.querySelector("#activityButtons");
const moodStatus = document.querySelector("#moodStatus");
const activityStatus = document.querySelector("#activityStatus");
const statsList = document.querySelector("#statsList");
const historyList = document.querySelector("#historyList");
const periodSelect = document.querySelector("#periodSelect");
const modeSelect = document.querySelector("#modeSelect");
const exportButton = document.querySelector("#exportButton");
const importButton = document.querySelector("#importButton");
const importFile = document.querySelector("#importFile");
const dataStatus = document.querySelector("#dataStatus");
const toast = document.querySelector("#toast");

let toastTimer = null;
let databasePromise = null;
let recordsCache = [];

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  const allowedKinds = new Set(["mood", "activity"]);
  const allowedValues = new Set([...moods.map((mood) => mood.value), ...activities]);

  return records
    .filter((record) =>
      record &&
      allowedKinds.has(record.kind) &&
      allowedValues.has(record.value) &&
      !Number.isNaN(new Date(record.createdAt).getTime())
    )
    .map((record) => ({
      id: typeof record.id === "string" && record.id ? record.id : createId(),
      kind: record.kind,
      value: record.value,
      source: typeof record.source === "string" && record.source ? record.source : "import",
      createdAt: new Date(record.createdAt).toISOString(),
    }));
}

function openDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(storeName)) {
        const store = database.createObjectStore(storeName, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("kind", "kind");
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return databasePromise;
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function readRecordsFromStore() {
  const database = await openDatabase();

  if (!database) {
    try {
      return normalizeRecords(JSON.parse(localStorage.getItem(legacyStorageKey)) || []);
    } catch {
      return [];
    }
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();

    request.addEventListener("success", () => {
      resolve(
        normalizeRecords(request.result).sort(
          (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        )
      );
    });
    request.addEventListener("error", () => reject(request.error));
  });
}

async function writeRecordsToStore(records) {
  const normalized = normalizeRecords(records);
  const database = await openDatabase();

  if (!database) {
    localStorage.setItem(legacyStorageKey, JSON.stringify(normalized));
    return normalized;
  }

  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  store.clear();
  normalized.forEach((record) => store.put(record));
  await transactionDone(transaction);
  return normalized;
}

async function addRecordToStore(record) {
  const normalized = normalizeRecords([record])[0];

  if (!normalized) {
    return null;
  }

  const database = await openDatabase();

  if (!database) {
    const records = await readRecordsFromStore();
    await writeRecordsToStore([...records, normalized]);
    return normalized;
  }

  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(normalized);
  await transactionDone(transaction);
  return normalized;
}

async function deleteRecordFromStore(id) {
  const database = await openDatabase();

  if (!database) {
    const records = (await readRecordsFromStore()).filter((record) => record.id !== id);
    await writeRecordsToStore(records);
    return;
  }

  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(id);
  await transactionDone(transaction);
}

async function clearRecordsFromStore() {
  const database = await openDatabase();

  if (!database) {
    localStorage.removeItem(legacyStorageKey);
    recordsCache = [];
    return;
  }

  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
  recordsCache = [];
}

async function migrateLegacyRecords() {
  if (!("indexedDB" in window) || localStorage.getItem(migrationKey)) {
    return;
  }

  let legacyRecords = [];

  try {
    legacyRecords = normalizeRecords(JSON.parse(localStorage.getItem(legacyStorageKey)) || []);
  } catch {
    legacyRecords = [];
  }

  if (legacyRecords.length > 0) {
    const currentRecords = await readRecordsFromStore();
    const recordsById = new Map(currentRecords.map((record) => [record.id, record]));
    legacyRecords.forEach((record) => recordsById.set(record.id, record));
    await writeRecordsToStore([...recordsById.values()]);
  }

  localStorage.setItem(migrationKey, new Date().toISOString());
  localStorage.removeItem(legacyStorageKey);
}

async function refreshRecords() {
  recordsCache = await readRecordsFromStore();
  render();
}

async function saveRecord(kind, value, source = "prototype") {
  const record = await addRecordToStore({
    id: createId(),
    kind,
    value,
    source,
    createdAt: new Date().toISOString(),
  });

  if (!record) {
    showToast("Запись не сохранена");
    return;
  }

  updateStatus(kind, value);
  await refreshRecords();
  showToast(`Записано: ${value}`);
}

function updateStatus(kind, value) {
  if (kind === "mood") {
    moodStatus.textContent = value;
  }
  if (kind === "activity") {
    activityStatus.textContent = value;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1600);
}

function replaceChildrenWithEmptyMessage(container, message) {
  const empty = document.createElement("p");

  empty.className = "empty";
  empty.textContent = message;
  container.replaceChildren(empty);
}

function renderButtons() {
  moodButtons.replaceChildren();
  moods.forEach((mood) => {
    const button = document.createElement("button");
    button.className = `choice-button ${mood.className}`;
    button.textContent = mood.value;
    button.addEventListener("click", () => {
      saveRecord("mood", mood.value);
    });
    moodButtons.append(button);
  });

  activityButtons.replaceChildren();
  activities.forEach((activity) => {
    const button = document.createElement("button");
    button.className = "choice-button";
    button.textContent = activity;
    button.addEventListener("click", () => {
      saveRecord("activity", activity);
    });
    activityButtons.append(button);
  });
}

function isInsidePeriod(date, period) {
  const now = new Date();
  const start = new Date(now);

  if (period === "hour") {
    start.setHours(now.getHours(), 0, 0, 0);
  }
  if (period === "day") {
    start.setHours(0, 0, 0, 0);
  }
  if (period === "week") {
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
  }
  if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  if (period === "year") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }

  return date >= start && date <= now;
}

function buildStatsGroup(title, records) {
  const section = document.createElement("section");
  section.className = "stats-group";

  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);

  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty compact";
    empty.textContent = "Пока нет записей.";
    section.append(empty);
    return section;
  }

  const counts = new Map();
  records.forEach((record) => {
    counts.set(record.value, (counts.get(record.value) || 0) + 1);
  });

  const max = Math.max(...counts.values());
  const total = records.length;

  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([label, count]) => {
      const percent = Math.round((count / total) * 100);
      const value = modeSelect.value === "percent" ? `${percent}%` : String(count);
      const row = document.createElement("div");
      const labelNode = document.createElement("span");
      const track = document.createElement("div");
      const bar = document.createElement("div");
      const valueNode = document.createElement("strong");

      row.className = "stats-row";
      track.className = "bar-track";
      bar.className = "bar";
      bar.style.width = `${(count / max) * 100}%`;
      labelNode.textContent = label;
      valueNode.textContent = value;

      track.append(bar);
      row.append(labelNode, track, valueNode);
      section.append(row);
    });

  return section;
}

function renderStats() {
  const records = recordsCache.filter((record) =>
    isInsidePeriod(new Date(record.createdAt), periodSelect.value)
  );

  if (records.length === 0) {
    replaceChildrenWithEmptyMessage(statsList, "Пока нет записей за выбранный период. Нажми любую кнопку выше, и статистика появится здесь.");
    return;
  }

  statsList.replaceChildren(
    buildStatsGroup("Состояние", records.filter((record) => record.kind === "mood")),
    buildStatsGroup("Деятельность", records.filter((record) => record.kind === "activity"))
  );
}

async function deleteRecord(id) {
  await deleteRecordFromStore(id);
  await refreshRecords();
  showToast("Запись удалена");
}

function renderHistory() {
  const records = recordsCache.slice().reverse().slice(0, 20);

  if (records.length === 0) {
    replaceChildrenWithEmptyMessage(historyList, "История пока пустая.");
    return;
  }

  historyList.replaceChildren();
  records.forEach((record) => {
    const item = document.createElement("div");
    const date = new Date(record.createdAt);
    const content = document.createElement("div");
    const value = document.createElement("strong");
    const meta = document.createElement("span");
    const actions = document.createElement("div");
    const time = document.createElement("time");
    const deleteButton = document.createElement("button");

    item.className = "history-item";
    actions.className = "history-meta";
    value.textContent = record.value;
    meta.textContent = `${record.kind === "mood" ? "состояние" : "деятельность"} · ${record.source}`;
    time.textContent = date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    deleteButton.className = "delete-button";
    deleteButton.type = "button";
    deleteButton.dataset.deleteId = record.id;
    deleteButton.setAttribute("aria-label", "Удалить запись");
    deleteButton.textContent = "×";

    content.append(value, meta);
    actions.append(time, deleteButton);
    item.append(content, actions);
    historyList.append(item);
  });

  historyList.querySelectorAll("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", () => deleteRecord(button.dataset.deleteId));
  });
}

async function exportRecords() {
  await refreshRecords();
  const backup = {
    app: "mood-mobile",
    version: 2,
    storage: "IndexedDB",
    exportedAt: new Date().toISOString(),
    records: recordsCache,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);

  link.href = url;
  link.download = `mood-mobile-backup-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  dataStatus.textContent = `экспортировано записей: ${recordsCache.length}`;
  showToast("Файл экспорта создан");
}

function importRecords(file) {
  const reader = new FileReader();

  reader.addEventListener("load", async () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const incoming = normalizeRecords(parsed.records || parsed);

      if (incoming.length === 0) {
        dataStatus.textContent = "нет подходящих записей";
        showToast("Импорт не выполнен");
        return;
      }

      const recordsById = new Map(recordsCache.map((record) => [record.id, record]));
      incoming.forEach((record) => recordsById.set(record.id, record));
      const merged = [...recordsById.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      recordsCache = await writeRecordsToStore(merged);
      render();
      dataStatus.textContent = `импортировано записей: ${incoming.length}`;
      showToast("Импорт завершен");
    } catch {
      dataStatus.textContent = "файл не прочитан";
      showToast("Импорт не выполнен");
    } finally {
      importFile.value = "";
    }
  });

  reader.readAsText(file);
}

function render() {
  renderStats();
  renderHistory();
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");

      document.querySelectorAll(".panel").forEach((panel) => panel.classList.add("hidden"));
      document.querySelector(`#${tab.dataset.tab}Panel`).classList.remove("hidden");
    });
  });
}

function setupQuickWidget() {
  document.querySelectorAll("[data-quick-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      saveRecord(button.dataset.quickKind, button.dataset.quickValue, "widget");
    });
  });
}

async function initializeApp() {
  renderButtons();
  setupTabs();
  setupQuickWidget();

  await migrateLegacyRecords();
  await refreshRecords();

  document.querySelector("#clearButton").addEventListener("click", async () => {
    if (!confirm("Очистить все тестовые записи?")) {
      return;
    }

    await clearRecordsFromStore();
    localStorage.removeItem(legacyStorageKey);
    moodStatus.textContent = "не выбрано";
    activityStatus.textContent = "не выбрано";
    render();
    showToast("Тестовые записи очищены");
  });

  exportButton.addEventListener("click", exportRecords);
  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    if (file) {
      importRecords(file);
    }
  });

  periodSelect.addEventListener("change", renderStats);
  modeSelect.addEventListener("change", renderStats);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // The app still works without offline caching.
      });
    });
  }
}

initializeApp().catch(() => {
  replaceChildrenWithEmptyMessage(statsList, "Не удалось открыть локальное хранилище. Попробуй обновить страницу.");
  showToast("Хранилище недоступно");
});
