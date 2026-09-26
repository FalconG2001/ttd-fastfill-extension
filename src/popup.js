const FASTFILL_VERSION = "0.5.5";

const KEYS = {
  config: "ttdff_config",
  pilgrims: "ttdff_pilgrims",
  run: "ttdff_run",
  learnedMappings: "ttdff_learned_mappings",
  learnedAnswers: "ttdff_learned_answers",
  gothramAliases: "ttdff_gothram_aliases",
};

const DEFAULT_CONFIG = {
  targetDates: [],
  preferredSlots: ["15:00", "16:00"],
  allowAnySlot: true,
  ticketCount: 1,
  personsPerTicket: "auto",
  pilgrimCount: 1,
  additionalLaddus: 0,
  hundiAmount: 0,
  autoPayNow: false,
  autoRecoverFailures: true,
  maxAttempts: 20,
  rememberDetails: false,
  gothramMode: "auto",
  globalGothram: "",
  bookingEmail: "",
  bookingCity: "",
  bookingState: "",
  bookingCountry: "",
  bookingPincode: "",
  rememberAdaptiveAnswers: true,
  geminiEnabled: false,
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash-lite",
};

const el = (id) => document.getElementById(id);
let pilgrims = [];
let targetDates = [];
let preferredTimes = [];
let toastTimer = null;
let inspectTimer = null;

function emptyPilgrim() {
  return { name: "", age: "", gender: "Male", idType: "Aadhaar Card", idNumber: "", gothram: "" };
}

function normalizeUnique(list) {
  return [...new Set((list || []).map((x) => String(x || "").trim()).filter(Boolean))];
}

function normalizeConfig(raw = {}) {
  const migratedDates = Array.isArray(raw.targetDates) && raw.targetDates.length
    ? raw.targetDates
    : (raw.targetDate ? [raw.targetDate] : []);
  const slots = Array.isArray(raw.preferredSlots) ? raw.preferredSlots : DEFAULT_CONFIG.preferredSlots;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    targetDates: normalizeUnique(migratedDates),
    preferredSlots: normalizeUnique(slots),
    ticketCount: Number(raw.ticketCount ?? DEFAULT_CONFIG.ticketCount),
    pilgrimCount: Number(raw.pilgrimCount ?? DEFAULT_CONFIG.pilgrimCount),
    additionalLaddus: Number(raw.additionalLaddus ?? 0),
    hundiAmount: Number(raw.hundiAmount ?? 0),
    maxAttempts: Math.min(50, Math.max(1, Number(raw.maxAttempts ?? DEFAULT_CONFIG.maxAttempts))),
  };
}

async function getLocal(key) { const data = await chrome.storage.local.get(key); return data[key]; }
async function setLocal(key, value) { await chrome.storage.local.set({ [key]: value }); }
async function getSession(key) { const data = await chrome.storage.session.get(key); return data[key]; }
async function setSession(key, value) { await chrome.storage.session.set({ [key]: value }); }

function showToast(message) {
  const toast = el("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function makeTicketOptions() {
  el("ticketCount").innerHTML = Array.from({ length: 6 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
}

function moveItem(array, index, direction) {
  const to = index + direction;
  if (to < 0 || to >= array.length) return;
  [array[index], array[to]] = [array[to], array[index]];
}

function renderOrderedList(containerId, items, type, onChange) {
  const root = el(containerId);
  root.innerHTML = "";
  items.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "ordered-row";
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.addEventListener("input", () => { items[index] = input.value; onChange(); });

    const buttons = document.createElement("div");
    buttons.className = "order-buttons";
    const up = document.createElement("button");
    up.type = "button"; up.className = "mini secondary"; up.textContent = "↑"; up.title = "Move up";
    const down = document.createElement("button");
    down.type = "button"; down.className = "mini secondary"; down.textContent = "↓"; down.title = "Move down";
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "mini danger"; remove.textContent = "×"; remove.title = "Remove";
    up.disabled = index === 0;
    down.disabled = index === items.length - 1;
    up.addEventListener("click", () => { moveItem(items, index, -1); onChange(true); });
    down.addEventListener("click", () => { moveItem(items, index, 1); onChange(true); });
    remove.addEventListener("click", () => { items.splice(index, 1); onChange(true); });
    buttons.append(up, down, remove);
    row.append(input, buttons);
    root.appendChild(row);
  });
}

function renderDates() { renderOrderedList("dateList", targetDates, "date", (rerender) => { if (rerender) renderDates(); }); }
function renderTimes() { renderOrderedList("timeList", preferredTimes, "time", (rerender) => { if (rerender) renderTimes(); }); }

function ensurePilgrimCount(count) {
  const safe = Math.min(12, Math.max(1, Number(count) || 1));
  while (pilgrims.length < safe) pilgrims.push(emptyPilgrim());
  if (pilgrims.length > safe) pilgrims = pilgrims.slice(0, safe);
  renderPilgrims();
}

function renderPilgrims() {
  const list = el("pilgrimList");
  list.innerHTML = "";
  el("pilgrimSummary").textContent = `${pilgrims.length} profile${pilgrims.length === 1 ? "" : "s"}`;
  pilgrims.forEach((pilgrim, index) => {
    const card = document.createElement("div");
    card.className = "pilgrim-card";
    card.innerHTML = `
      <h3>Pilgrim ${index + 1} <span class="priority-label">priority ${index + 1}</span></h3>
      <div class="pilgrim-grid">
        <label class="wide">Name<input data-field="name" type="text" maxlength="80"></label>
        <label>Age<input data-field="age" type="number" min="0" max="120"></label>
        <label>Gender<select data-field="gender"><option>Female</option><option>Male</option><option>Transgender</option></select></label>
        <label>ID type<select data-field="idType"><option>Aadhaar Card</option><option>Passport</option></select></label>
        <label>ID number<input data-field="idNumber" type="text" maxlength="20"></label>
        <label class="wide">Gothram (optional)<input data-field="gothram" type="text" maxlength="80" list="gothramSuggestions" placeholder="Example: Kasyapa"></label>
      </div>`;
    for (const input of card.querySelectorAll("input,select")) {
      const field = input.dataset.field;
      input.value = pilgrim[field] ?? "";
      const update = () => { pilgrims[index][field] = input.value; };
      input.addEventListener("input", update);
      input.addEventListener("change", update);
    }
    list.appendChild(card);
  });
}

function readConfigFromForm() {
  return normalizeConfig({
    targetDates: normalizeUnique(targetDates),
    preferredSlots: normalizeUnique(preferredTimes),
    allowAnySlot: el("allowAnySlot").checked,
    ticketCount: Number(el("ticketCount").value),
    personsPerTicket: el("personsPerTicket").value,
    pilgrimCount: Number(el("pilgrimCount").value),
    additionalLaddus: Number(el("additionalLaddus").value || 0),
    hundiAmount: Number(el("hundiAmount").value || 0),
    autoPayNow: el("autoPayNow").checked,
    autoRecoverFailures: el("autoRecoverFailures").checked,
    maxAttempts: Number(el("maxAttempts").value || DEFAULT_CONFIG.maxAttempts),
    rememberDetails: el("rememberDetails").checked,
    gothramMode: el("gothramMode").value,
    globalGothram: el("globalGothram").value.trim(),
    bookingEmail: el("bookingEmail").value.trim(),
    bookingCity: el("bookingCity").value.trim(),
    bookingState: el("bookingState").value.trim(),
    bookingCountry: el("bookingCountry").value.trim(),
    bookingPincode: el("bookingPincode").value.trim(),
    rememberAdaptiveAnswers: el("rememberAdaptiveAnswers").checked,
    geminiEnabled: el("geminiEnabled").checked,
    geminiApiKey: el("geminiApiKey").value.trim(),
    geminiModel: el("geminiModel").value.trim() || DEFAULT_CONFIG.geminiModel,
  });
}

function writeConfigToForm(c) {
  targetDates = [...(c.targetDates || [])];
  if (!targetDates.length) targetDates = [""];
  preferredTimes = [...(c.preferredSlots || [])];
  if (!preferredTimes.length) preferredTimes = ["15:00"];
  renderDates(); renderTimes();
  el("allowAnySlot").checked = Boolean(c.allowAnySlot);
  el("ticketCount").value = String(c.ticketCount || 1);
  el("personsPerTicket").value = String(c.personsPerTicket || "auto");
  el("pilgrimCount").value = String(c.pilgrimCount || 1);
  el("additionalLaddus").value = String(c.additionalLaddus || 0);
  el("hundiAmount").value = String(c.hundiAmount || 0);
  el("autoPayNow").checked = Boolean(c.autoPayNow);
  el("autoRecoverFailures").checked = c.autoRecoverFailures !== false;
  el("maxAttempts").value = String(c.maxAttempts || DEFAULT_CONFIG.maxAttempts);
  el("rememberDetails").checked = Boolean(c.rememberDetails);
  el("gothramMode").value = c.gothramMode || "auto";
  el("globalGothram").value = c.globalGothram || "";
  el("bookingEmail").value = c.bookingEmail || "";
  el("bookingCity").value = c.bookingCity || "";
  el("bookingState").value = c.bookingState || "";
  el("bookingCountry").value = c.bookingCountry || "";
  el("bookingPincode").value = c.bookingPincode || "";
  el("rememberAdaptiveAnswers").checked = Boolean(c.rememberAdaptiveAnswers);
  el("geminiEnabled").checked = Boolean(c.geminiEnabled);
  el("geminiApiKey").value = c.geminiApiKey || "";
  el("geminiModel").value = c.geminiModel || DEFAULT_CONFIG.geminiModel;
  el("geminiFields").hidden = !c.geminiEnabled;
}

function validate(config) {
  if (!config.targetDates.length) throw new Error("Add at least one preferred date");
  if (!config.preferredSlots.length && !config.allowAnySlot) throw new Error("Add a preferred time or allow any available time");
  if (config.pilgrimCount < 1 || config.pilgrimCount > 12) throw new Error("Pilgrim profiles must be between 1 and 12");
  if (config.geminiEnabled && !config.geminiApiKey) throw new Error("Enter a Gemini API key or turn Gemini off");
  for (let i = 0; i < config.pilgrimCount; i += 1) {
    const p = pilgrims[i];
    if (!p?.name || p.age === "" || !p.gender || !p.idType || !p.idNumber) throw new Error(`Complete pilgrim ${i + 1}`);
  }
}

async function saveSetup({ quiet = false } = {}) {
  const config = readConfigFromForm();
  validate(config);
  config.pilgrimCount = pilgrims.length;
  await setLocal(KEYS.config, config);
  if (config.rememberDetails) {
    await setLocal(KEYS.pilgrims, pilgrims);
    await chrome.storage.session.remove(KEYS.pilgrims);
  } else {
    await setSession(KEYS.pilgrims, pilgrims);
    await chrome.storage.local.remove(KEYS.pilgrims);
  }
  if (!quiet) showToast("Setup saved");
  return config;
}

async function currentTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }

function allowedTabUrl(url = "") {
  return url.startsWith("https://ttdevasthanams.ap.gov.in/") || url.startsWith("http://localhost:4173/");
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "TTDFF_PING" });
    return response?.ok ? response : null;
  } catch (_) {
    return null;
  }
}

async function ensureAttached(tab, { force = false } = {}) {
  if (!tab?.id || !allowedTabUrl(tab.url || "")) throw new Error("Open a TTD page first");

  const current = await pingTab(tab.id);
  if (!force && current?.version === FASTFILL_VERSION) return { response: current, attachedNow: false };

  // Ask a same-version instance to shut down before reinjection. Older/invalid
  // content-script contexts may not answer, which is fine; executeScript below
  // attaches the current extension without reloading the TTD tab.
  if (current?.version) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "TTDFF_SHUTDOWN" }); } catch (_) {}
    await sleep(40);
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"],
  });
  await sleep(90);
  const attached = await pingTab(tab.id);
  if (!attached) throw new Error("Could not attach FastFill to this tab. The TTD page was left untouched; do not reload it.");
  return { response: attached, attachedNow: true };
}

function setConnection(snapshot, attachedNow = false) {
  const state = el("connectionState");
  const detail = el("connectionDetail");
  if (!snapshot) {
    state.textContent = "Not attached";
    state.dataset.state = "off";
    detail.textContent = "Use Attach without reload. Your TTD tab does not need to be refreshed.";
    return;
  }
  state.textContent = `Attached v${snapshot.version || "?"}`;
  state.dataset.state = "on";
  const countdown = snapshot.countdown?.formatted ? ` · countdown ${snapshot.countdown.formatted}` : "";
  detail.textContent = `${attachedNow ? "Attached to the existing tab without reload. " : ""}Page: ${snapshot.page || "unknown"}${countdown}`;
}

async function refreshConnection() {
  try {
    const tab = await currentTab();
    if (!tab?.id || !allowedTabUrl(tab.url || "")) {
      setConnection(null);
      return null;
    }
    const response = await pingTab(tab.id);
    setConnection(response);
    return response;
  } catch (_) {
    setConnection(null);
    return null;
  }
}

async function attachWithoutReload({ quiet = false, force = false } = {}) {
  const tab = await currentTab();
  const result = await ensureAttached(tab, { force });
  setConnection(result.response, result.attachedNow);
  if (!quiet) showToast(result.attachedNow ? "Attached without reloading TTD" : "FastFill is already attached");
  return { tab, ...result };
}

async function startRun() {
  try {
    const config = await saveSetup({ quiet: true });
    const { tab } = await attachWithoutReload({ quiet: true });
    await setSession(KEYS.run, {
      active: true,
      state: "waiting-slot",
      message: "Started. FastFill is attached and watching for the TTD booking page. Do not reload this tab.",
      startedAt: Date.now(), updatedAt: Date.now(), tabId: tab.id,
      actual: {}, attempts: [], failedAttempts: [],
      search: { dateIndex: 0, timeIndex: 0, requestedTickets: config.ticketCount },
    });
    await chrome.tabs.sendMessage(tab.id, { type: "TTDFF_START" });
    showToast("FastFill started without reloading the page");
    await refreshStatus();
  } catch (error) { showToast(error.message || String(error)); }
}

async function stopRun() {
  const current = (await getSession(KEYS.run)) || {};
  await setSession(KEYS.run, { ...current, active: false, state: "cancelled", message: "Stopped by user", updatedAt: Date.now() });
  await refreshStatus();
}

async function refreshInspector() {
  const tab = await currentTab();
  if (!tab?.id || !allowedTabUrl(tab.url || "")) throw new Error("Open a TTD page first");
  let response = await pingTab(tab.id);
  if (!response || response.version !== FASTFILL_VERSION) {
    const attached = await ensureAttached(tab);
    response = attached.response;
    setConnection(response, attached.attachedNow);
  }
  const inspected = await chrome.tabs.sendMessage(tab.id, { type: "TTDFF_INSPECT" });
  const out = el("inspectOutput");
  out.hidden = false;
  out.textContent = inspected?.report || "FastFill is attached, but no inspectable fields are visible yet.";
  setConnection(inspected || response);
  return inspected;
}

async function inspectPage() {
  try {
    await refreshInspector();
    clearInterval(inspectTimer);
    inspectTimer = setInterval(() => {
      refreshInspector().catch(() => {});
    }, 500);
    el("inspectBtn").textContent = "Live inspector running";
  } catch (error) {
    clearInterval(inspectTimer);
    inspectTimer = null;
    showToast(error.message || "Could not inspect this TTD tab");
  }
}

async function redetectPage() {
  try {
    const { tab } = await attachWithoutReload({ quiet: true });
    await chrome.tabs.sendMessage(tab.id, { type: "TTDFF_REDETECT" });
    await refreshInspector();
    showToast("Re-detect requested. No reload performed.");
  } catch (error) { showToast(error.message || String(error)); }
}

async function clearLearned() {
  await chrome.storage.local.remove([KEYS.learnedMappings, KEYS.learnedAnswers, KEYS.gothramAliases]);
  showToast("Learned field mappings cleared");
}

async function clearDetails() {
  await chrome.storage.local.remove([KEYS.config, KEYS.pilgrims, KEYS.learnedMappings, KEYS.learnedAnswers, KEYS.gothramAliases]);
  await chrome.storage.session.remove([KEYS.pilgrims, KEYS.run]);
  pilgrims = [emptyPilgrim()];
  writeConfigToForm(DEFAULT_CONFIG);
  renderPilgrims();
  showToast("Setup, IDs and learned fields cleared");
  await refreshStatus();
}

function formatAttempts(run) {
  const attempts = run?.attempts || [];
  if (!attempts.length) return "";
  return attempts.slice(-10).map((a) => {
    const mark = a.status === "success" ? "✓" : a.status === "failed" ? "✕" : "→";
    const tickets = a.actualTickets ? ` · ${a.actualTickets} ticket${a.actualTickets === 1 ? "" : "s"}` : "";
    return `${mark} ${a.date} · ${a.time || "any"}${tickets}${a.reason ? ` · ${a.reason}` : ""}`;
  }).join("\n");
}

async function refreshStatus() {
  const run = await getSession(KEYS.run);
  el("runState").textContent = run?.state || "Idle";
  el("runMessage").textContent = run?.message || "Save your setup before booking opens.";
  el("stopBtn").disabled = !run?.active;
  const log = formatAttempts(run);
  el("attemptLog").hidden = !log;
  el("attemptLog").textContent = log;
}

function updateCountFromRatio() {
  const ratio = el("personsPerTicket").value;
  if (ratio === "auto") return;
  const expected = Math.min(12, Number(el("ticketCount").value) * Number(ratio));
  el("pilgrimCount").value = String(expected);
  ensurePilgrimCount(expected);
}

async function initialize() {
  makeTicketOptions();
  const savedConfig = normalizeConfig((await getLocal(KEYS.config)) || DEFAULT_CONFIG);
  writeConfigToForm(savedConfig);
  const savedPilgrims = savedConfig.rememberDetails ? ((await getLocal(KEYS.pilgrims)) || []) : ((await getSession(KEYS.pilgrims)) || []);
  pilgrims = savedPilgrims.length ? savedPilgrims.map((p) => ({ ...emptyPilgrim(), ...p })) : Array.from({ length: savedConfig.pilgrimCount || 1 }, emptyPilgrim);
  ensurePilgrimCount(savedConfig.pilgrimCount || pilgrims.length || 1);

  el("addDateBtn").addEventListener("click", () => { targetDates.push(""); renderDates(); });
  el("addTimeBtn").addEventListener("click", () => { preferredTimes.push("15:00"); renderTimes(); });
  el("pilgrimCount").addEventListener("input", () => ensurePilgrimCount(el("pilgrimCount").value));
  el("ticketCount").addEventListener("change", updateCountFromRatio);
  el("personsPerTicket").addEventListener("change", updateCountFromRatio);
  el("geminiEnabled").addEventListener("change", () => { el("geminiFields").hidden = !el("geminiEnabled").checked; });
  el("saveBtn").addEventListener("click", () => saveSetup().catch((e) => showToast(e.message || String(e))));
  el("startBtn").addEventListener("click", startRun);
  el("stopBtn").addEventListener("click", stopRun);
  el("inspectBtn").addEventListener("click", inspectPage);
  el("attachBtn").addEventListener("click", () => attachWithoutReload().catch((e) => showToast(e.message || String(e))));
  el("redetectBtn").addEventListener("click", redetectPage);
  el("clearLearnedBtn").addEventListener("click", clearLearned);
  el("clearBtn").addEventListener("click", clearDetails);
  await refreshStatus();
  await refreshConnection();
  setInterval(refreshStatus, 600);
  setInterval(refreshConnection, 1200);
}

initialize().catch((error) => showToast(error.message || String(error)));
