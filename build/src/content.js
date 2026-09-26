(() => {
  "use strict";

  const FASTFILL_VERSION = "0.5.5";
  const INSTANCE_KEY = "__TTD_FASTFILL_INSTANCE__";
  const previousInstance = globalThis[INSTANCE_KEY];
  if (previousInstance?.version === FASTFILL_VERSION && previousInstance?.alive) {
    try { previousInstance.redetect?.("duplicate-injection"); } catch (_) {}
    return;
  }
  if (previousInstance?.shutdown) {
    try { previousInstance.shutdown("upgrade"); } catch (_) {}
  }

  const KEYS = {
    config: "ttdff_config",
    pilgrims: "ttdff_pilgrims",
    run: "ttdff_run",
    learnedMappings: "ttdff_learned_mappings",
    learnedAnswers: "ttdff_learned_answers",
    gothramAliases: "ttdff_gothram_aliases",
  };

  const OVERLAY_ID = "ttdff-status-overlay";
  const LOG_PREFIX = "[TTD FastFill]";
  let processing = false;
  let observer = null;
  let routeTimer = null;
  let sanityTimer = null;
  let rootWaitTimer = null;
  let runtimeStarted = false;
  let shuttingDown = false;
  let lastDomChangeAt = 0;
  let lastRouteChangeAt = 0;
  let lastSeenUrl = location.href;
  const cleanupCallbacks = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeLoose(value) {
    return normalizeText(value).replace(/[^a-z0-9]/g, "");
  }

  function levenshtein(a, b) {
    const left = normalizeLoose(a);
    const right = normalizeLoose(b);
    const dp = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      let previous = dp[0];
      dp[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const old = dp[j];
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, previous + cost);
        previous = old;
      }
    }
    return dp[right.length];
  }

  function similarity(a, b) {
    const left = normalizeLoose(a);
    const right = normalizeLoose(b);
    const max = Math.max(left.length, right.length);
    if (!max) return 1;
    return 1 - (levenshtein(left, right) / max);
  }

  function configDates(config) {
    if (Array.isArray(config?.targetDates) && config.targetDates.length) return config.targetDates.filter(Boolean);
    return config?.targetDate ? [config.targetDate] : [];
  }

  function readServiceContext() {
    const templeInput = document.querySelector('input[name="templeSelected"], input[label="Temple"][readonly]');
    const sevaInput = document.querySelector('input[name="sevaSelected"], input[label="Select Seva"][readonly]');
    const temple = String(templeInput?.value || "").trim();
    const seva = String(sevaInput?.value || "").trim();
    if (!temple && !seva) return null;
    return { temple, seva };
  }

  function serviceContextMatches(expected, actual) {
    if (!expected || !actual) return true;
    const templeOkay = !expected.temple || !actual.temple || normalizeText(expected.temple) === normalizeText(actual.temple);
    const sevaOkay = !expected.seva || !actual.seva || normalizeText(expected.seva) === normalizeText(actual.seva);
    return templeOkay && sevaOkay;
  }

  async function bindOrVerifyServiceContext(run) {
    const current = readServiceContext();
    if (!current) return run;
    const stored = run?.serviceContext || null;
    if (stored && !serviceContextMatches(stored, current)) {
      throw new Error(`TTD Temple/Seva changed after FastFill started. Expected ${stored.temple || "(unknown temple)"} / ${stored.seva || "(unknown seva)"}, but the page now shows ${current.temple || "(unknown temple)"} / ${current.seva || "(unknown seva)"}. Stop and Start again to use the new selection.`);
    }
    if (!stored) {
      return patchRun({
        serviceContext: current,
        actual: { ...(run?.actual || {}), temple: current.temple, seva: current.seva },
      });
    }
    return run;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getButtonByText(text) {
    const wanted = normalizeText(text);
    return [...document.querySelectorAll("button")].find(
      (button) => isVisible(button) && normalizeText(button.textContent) === wanted
    );
  }

  function waitFor(check, { timeout = 8000, interval = 40, message = "Timed out waiting for page" } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        let result = null;
        try {
          result = check();
        } catch (_) {
          result = null;
        }
        if (result) return resolve(result);
        if (Date.now() - startedAt >= timeout) return reject(new Error(message));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  async function getLocal(key) {
    const data = await chrome.storage.local.get(key);
    return data[key];
  }

  async function setLocal(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function getSession(key) {
    const data = await chrome.storage.session.get(key);
    return data[key];
  }

  async function setSession(key, value) {
    await chrome.storage.session.set({ [key]: value });
  }

  async function getConfig() {
    return (await getLocal(KEYS.config)) || null;
  }

  async function getPilgrims(config) {
    if (!config) return [];
    if (config.rememberDetails) {
      return (await getLocal(KEYS.pilgrims)) || [];
    }
    return (await getSession(KEYS.pilgrims)) || [];
  }

  async function getRun() {
    return (await getSession(KEYS.run)) || null;
  }

  async function patchRun(patch) {
    const current = (await getRun()) || {};
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await setSession(KEYS.run, next);
    updateOverlay(next);
    return next;
  }

  async function stopRun(state, message) {
    await patchRun({
      active: false,
      state,
      message,
      finishedAt: Date.now(),
    });
    log(state, message);
  }

  function showOverlay(run) {
    let root = document.getElementById(OVERLAY_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = OVERLAY_ID;
      root.style.cssText = [
        "position:fixed",
        "top:16px",
        "right:16px",
        "z-index:2147483647",
        "width:300px",
        "background:#1f2937",
        "color:#fff",
        "border-radius:12px",
        "box-shadow:0 8px 30px rgba(0,0,0,.25)",
        "font-family:Arial,sans-serif",
        "font-size:13px",
        "padding:12px",
      ].join(";");

      const title = document.createElement("div");
      title.textContent = "TTD FastFill";
      title.style.cssText = "font-weight:700;font-size:14px;margin-bottom:6px";
      root.appendChild(title);

      const status = document.createElement("div");
      status.dataset.role = "status";
      status.style.cssText = "line-height:1.4;word-break:break-word";
      root.appendChild(status);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;margin-top:8px";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText = "border:0;border-radius:8px;padding:6px 10px;cursor:pointer;background:#fff;color:#111827;font-weight:600";
      cancel.addEventListener("click", () => stopRun("cancelled", "Cancelled by user"));
      actions.appendChild(cancel);
      root.appendChild(actions);

      document.documentElement.appendChild(root);
    }
    updateOverlay(run);
  }

  function updateOverlay(run) {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) {
      if (run?.active) showOverlay(run);
      return;
    }
    const status = root.querySelector('[data-role="status"]');
    if (status) {
      status.textContent = run?.message || run?.state || "Ready";
    }
    if (!run?.active) {
      setTimeout(() => root.remove(), 2500);
    }
  }

  function parseCountdownSeconds(raw) {
    const value = String(raw || "").replace(/\s+/g, " ").trim();
    let match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    match = /^(\d{1,3}):(\d{2})$/.exec(value);
    if (match) return Number(match[1]) * 60 + Number(match[2]);

    const hours = /(\d+)\s*(?:hours?|hrs?|hr)\b/i.exec(value);
    const minutes = /(\d+)\s*(?:minutes?|mins?|min)\b/i.exec(value);
    const seconds = /(\d+)\s*(?:seconds?|secs?|sec)\b/i.exec(value);
    if (hours || minutes || seconds) {
      return Number(hours?.[1] || 0) * 3600 + Number(minutes?.[1] || 0) * 60 + Number(seconds?.[1] || 0);
    }
    return null;
  }

  function formatCountdown(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function countdownContextFor(element) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 900) return text;
    }
    return "";
  }

  function detectCountdown() {
    const bodyText = normalizeText(document.body?.innerText || "");
    const queueContext = /(virtual queue|waiting room|please wait|booking\s+(?:opens?|starts?)\s+in|starts?\s+in|countdown|you will be redirected|queue)/i.test(bodyText);
    const candidates = [...document.querySelectorAll("span,div,p,strong,b,time")].filter((element) => {
      if (element.closest?.(`#${OVERLAY_ID}`) || element.closest?.(`#${PROMPT_ID}`)) return false;
      if (element.children.length > 3) return false;
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 90) return false;
      const looksLikeTimer = /^(?:\d{1,2}:)?\d{1,3}:\d{2}$/.test(text) ||
        /\b\d+\s*(?:hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec)\b/i.test(text);
      return looksLikeTimer && isVisible(element);
    });

    let best = null;
    for (const element of candidates) {
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      const context = countdownContextFor(element);
      const contextLooksLikeQueue = /(virtual queue|waiting room|please wait|booking\s+(?:opens?|starts?)|starts?\s+in|countdown|redirected|queue)/i.test(context);
      if (!queueContext && !contextLooksLikeQueue) continue;
      // Reject normal AM/PM slot times and date-like strings.
      if (/\b(am|pm)\b/i.test(text) || /\d{1,2}\/\d{1,2}/.test(text)) continue;
      const seconds = parseCountdownSeconds(text);
      if (seconds == null) continue;
      const score = (contextLooksLikeQueue ? 3 : 0) + (/:/.test(text) ? 2 : 0) + (seconds <= 86400 ? 1 : 0);
      if (!best || score > best.score) best = { element, text, seconds, context, score };
    }

    if (!best) return null;
    return {
      text: best.text,
      seconds: best.seconds,
      formatted: formatCountdown(best.seconds) || best.text,
      context: best.context.slice(0, 240),
    };
  }

  function findReviewActionButton() {
    const payNow = getButtonByText("Pay Now");
    if (payNow) return payNow;
    const reviewRoot = document.querySelector('[class*="sevaReview_mainContainer"], [class*="ReviewDetails_desktopContainer"], [class*="ReviewDetails_mobile"]');
    if (!reviewRoot || !isVisible(reviewRoot)) return null;
    const actions = [...reviewRoot.querySelectorAll("button")].filter(isVisible);
    return actions.find((button) => {
      const text = normalizeText(button.textContent);
      const cls = String(button.className || "");
      return ["confirm", "continue", "proceed", "proceed to payment", "pay now"].includes(text) || /confirmButton|PaynowButton/i.test(cls);
    }) || null;
  }

  function detectPage() {
    // DOM structure wins over URL. TTD is a Next.js SPA and can leave the URL or
    // __NEXT_DATA__ route looking like slot-booking/curtain while the visible DOM
    // has already changed to pilgrim details.
    if (findReviewActionButton()) return "review";
    if (detectPilgrimFormSchema()) return "pilgrims";

    const body = normalizeText(document.body?.innerText);
    const hasCalendarCell = [...document.querySelectorAll("td[id]")].some((cell) =>
      /^\d{1,2}\/\d{1,2}$/.test(cell.id || "")
    );
    const isSlotRoute = /\/slot-booking\/?$/.test(location.pathname);

    // TTD does not render "Select any 1 Slot" until a date is chosen.
    // Detect the calendar itself so FastFill can make that first click.
    if ((body.includes("darshan slots") || body.includes("seva slots")) && (hasCalendarCell || isSlotRoute)) return "slot";
    if (hasCalendarCell && (body.includes("available") || body.includes("filling fast") || body.includes("quota"))) return "slot";
    if (detectCountdown()) return "countdown";
    if (body.includes("virtual queue") || body.includes("waiting room") || body.includes("please wait")) return "queue";
    if (body.includes("payment gateway") || body.includes("payment")) return "payment-or-other";
    return "other";
  }

  function setReactInputValue(input, value) {
    if (!input) throw new Error("Input not found");
    const stringValue = String(value ?? "");
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(input, stringValue);
    else input.value = stringValue;

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function selectCustomDropdown(input, wantedValue, { numeric = false } = {}) {
    if (!input) throw new Error(`Dropdown not found for ${wantedValue}`);
    input.scrollIntoView({ block: "center", inline: "nearest" });

    const wanted = normalizeText(wantedValue);
    const matchesWanted = (raw) => {
      const actual = normalizeText(raw);
      if (actual === wanted) return true;
      if (!numeric || !/^\d+$/.test(actual) || !/^\d+$/.test(wanted)) return false;
      return Number(actual) === Number(wanted);
    };
    const findVisibleOption = () => {
      const localOptions = [...input.parentElement.querySelectorAll("li")].filter(isVisible);
      const localMatch = localOptions.find((li) => matchesWanted(li.textContent));
      if (localMatch) return localMatch;
      const visibleOptions = [...document.querySelectorAll("li")].filter(isVisible);
      return visibleOptions.find((li) => matchesWanted(li.textContent)) || null;
    };

    let option = findVisibleOption();
    if (!option) {
      input.click();
      option = await waitFor(findVisibleOption, {
        timeout: 2500,
        interval: 25,
        message: `Could not find dropdown option: ${wantedValue}`,
      });
    }

    option.click();
    await waitFor(
      () => matchesWanted(input.value),
      { timeout: 2500, interval: 25, message: `TTD did not accept dropdown option: ${wantedValue}` }
    );
    await sleep(35);
  }

  function findTicketCountInput() {
    const allReadonly = [...document.querySelectorAll('input[readonly]')].filter(isVisible);
    const direct = allReadonly.find((candidate) => {
      const own = normalizeText(`${candidate.getAttribute("label") || ""} ${candidate.getAttribute("name") || ""} ${candidate.getAttribute("placeholder") || ""}`);
      return /ticket/.test(own);
    });
    if (direct) return direct;

    const ticketLabels = new Set(["number of tickets", "no. of tickets", "no of tickets", "no. of ticket", "no of ticket"]);
    const label = [...document.querySelectorAll("div,span,label")].find(
      (element) => ticketLabels.has(normalizeText(element.textContent))
    );
    if (!label) return null;

    let node = label.parentElement;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const candidates = [...node.querySelectorAll('input[readonly]')].filter((candidate) => {
        if (!isVisible(candidate)) return false;
        const name = normalizeText(candidate.name || "");
        return !["templeselected", "sevaselected"].includes(name);
      });
      const numeric = candidates.find((candidate) => /^\d+$/.test(candidate.value || ""));
      if (numeric) return numeric;
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }

  function findFixedTicketCount() {
    const labels = new Set(["number of tickets", "no. of tickets", "no of tickets", "no. of ticket", "no of ticket"]);
    const nodes = [...document.querySelectorAll("div,span,label")].filter((element) => labels.has(normalizeText(element.textContent)));
    for (const label of nodes) {
      const parent = label.parentElement;
      if (!parent || !isVisible(parent)) continue;
      const ownInput = parent.querySelector('input[readonly]');
      if (ownInput && /^\d+$/.test(ownInput.value || "")) return Number(ownInput.value);
      const text = String(parent.textContent || "").replace(/\s+/g, " ").trim();
      const match = /(?:number of tickets|no\.? of tickets?)\s*0*(\d{1,2})\b/i.exec(text);
      if (match) return Number(match[1]);
      const siblings = [...parent.children].filter((child) => child !== label && isVisible(child));
      for (const sibling of siblings) {
        const value = normalizeText(sibling.textContent);
        if (/^0*\d{1,2}$/.test(value)) return Number(value);
      }
    }
    return null;
  }

  async function selectTicketCountForPage(requested) {
    const input = findTicketCountInput();
    if (input && input.disabled) {
      const fixedInput = Number(input.value);
      const wanted = Math.max(1, Number(requested) || 1);
      if (Number.isFinite(fixedInput) && fixedInput > 0) {
        if (fixedInput > wanted) throw new Error(`TTD requires ${fixedInput} ticket(s), which is above your configured maximum of ${wanted}`);
        return { requested: wanted, chosen: fixedInput, options: [fixedInput], source: "fixed-input", input };
      }
    }
    if (input) return { ...(await selectBestTicketCount(input, requested)), source: "dropdown", input };
    const fixed = findFixedTicketCount();
    if (Number.isFinite(fixed) && fixed > 0) {
      const wanted = Math.max(1, Number(requested) || 1);
      if (fixed > wanted) throw new Error(`TTD requires ${fixed} ticket(s), which is above your configured maximum of ${wanted}`);
      return { requested: wanted, chosen: fixed, options: [fixed], source: "fixed", input: null };
    }
    return { requested: Math.max(1, Number(requested) || 1), chosen: null, options: [], source: "ttd-determined", input: null };
  }

  async function numericDropdownOptions(input) {
    if (!input) return [];
    if (input.disabled) {
      const current = Number(input.value);
      return Number.isFinite(current) && current > 0 ? [current] : [];
    }
    input.scrollIntoView({ block: "center", inline: "nearest" });
    input.click();
    await sleep(60);
    const values = [...document.querySelectorAll("li")].filter(isVisible)
      .map((li) => normalizeText(li.textContent))
      .filter((text) => /^\d+$/.test(text))
      .map(Number);
    const unique = [...new Set(values)].sort((a, b) => a - b);
    // Close without changing the selection when possible.
    input.click();
    await sleep(30);
    return unique;
  }

  async function selectBestTicketCount(input, requested) {
    const wanted = Math.max(1, Number(requested) || 1);
    const current = Number(input?.value);
    // If TTD already shows exactly the requested count (for example "01" for 1),
    // do not touch the dropdown at all. This avoids needless open/close races.
    if (Number.isFinite(current) && current > 0 && current === wanted) {
      return { requested: wanted, chosen: current, options: [current] };
    }
    let options = await numericDropdownOptions(input);
    if (!options.length) {
      const current = Number(input.value);
      options = Number.isFinite(current) && current > 0 ? [current] : [];
    }
    const allowed = options.filter((n) => n <= wanted);
    if (!allowed.length) throw new Error(`TTD does not offer a ticket count at or below ${wanted}`);
    const chosen = Math.max(...allowed);
    if (!Number.isFinite(chosen)) throw new Error("TTD ticket count options could not be read");
    if (Number(input.value) !== chosen) await selectCustomDropdown(input, String(chosen), { numeric: true });
    return { requested: wanted, chosen, options };
  }

  function monthHeadingForCell(cell) {
    const table = cell?.closest("table");
    const monthContainer = table?.parentElement?.parentElement;
    if (!monthContainer) return "";
    const match = monthContainer.textContent.match(
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i
    );
    return match ? match[0] : "";
  }

  function parseISODate(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
    if (!match) throw new Error("Target date must be in YYYY-MM-DD format");
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  function findDateCell(isoDate) {
    const { year, month, day } = parseISODate(isoDate);
    const id = `${day}/${month - 1}`;
    const expected = `${MONTHS[month - 1]} ${year}`;
    const cells = [...document.querySelectorAll(`td[id="${CSS.escape(id)}"]`)];
    if (!cells.length) return null;
    const exactMonth = cells.find((cell) => normalizeText(monthHeadingForCell(cell)) === normalizeText(expected));
    return exactMonth || (cells.length === 1 ? cells[0] : null);
  }

  function dateSelectionTexts(isoDate) {
    const parsed = parseISODate(isoDate);
    const shortMonth = MONTHS[parsed.month - 1].slice(0, 3);
    return [
      `select any 1 slot: dated ${String(parsed.day).padStart(2, "0")} ${shortMonth}, ${parsed.year}`,
      `select any 1 slot: dated ${parsed.day} ${shortMonth}, ${parsed.year}`,
      `select any 1 slot: dated ${parsed.day} ${shortMonth},${parsed.year}`,
      `select any 1 seva: dated ${String(parsed.day).padStart(2, "0")} ${shortMonth}, ${parsed.year}`,
      `select any 1 seva: dated ${parsed.day} ${shortMonth}, ${parsed.year}`,
      `select any 1 seva: dated ${parsed.day} ${shortMonth},${parsed.year}`,
      `selected date ${String(parsed.day).padStart(2, "0")} ${shortMonth}, ${parsed.year}`,
      `seva date ${String(parsed.day).padStart(2, "0")}/${String(parsed.month).padStart(2, "0")}/${parsed.year}`,
    ].map(normalizeText);
  }

  function rgbTuple(value) {
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(value || ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  }

  function nearRgb(value, expected, tolerance = 18) {
    const actual = rgbTuple(value);
    return actual && actual.every((n, i) => Math.abs(n - expected[i]) <= tolerance);
  }

  function isSelectedDateCell(cell) {
    if (!cell || !cell.isConnected) return false;
    if (cell.getAttribute("aria-selected") === "true") return true;
    if (/selected|active/i.test(String(cell.className || ""))) return true;
    const style = getComputedStyle(cell);
    // TTD currently uses its primary purple (#663399) for the chosen day.
    return nearRgb(style.backgroundColor, [102, 51, 153], 24);
  }

  function isTargetDateSelected(isoDate) {
    const body = normalizeText(document.body?.innerText);
    if (dateSelectionTexts(isoDate).some((text) => body.includes(text))) return true;
    return isSelectedDateCell(findDateCell(isoDate));
  }

  function isDateSelectable(cell) {
    if (!cell || !isVisible(cell)) return false;
    if (isSelectedDateCell(cell)) return true;
    const style = getComputedStyle(cell);
    // On the real TTD calendar, Available/Filling Fast dates use pointer-events:auto.
    // Full/not-released dates keep cursor:pointer but pointer-events:none, so cursor alone is unsafe.
    return style.pointerEvents !== "none" && style.cursor !== "not-allowed";
  }

  function describeDateCell(cell) {
    if (!cell) return null;
    const style = getComputedStyle(cell);
    return {
      id: cell.id,
      text: normalizeText(cell.textContent),
      pointerEvents: style.pointerEvents,
      cursor: style.cursor,
      backgroundColor: style.backgroundColor,
      visible: isVisible(cell),
    };
  }

  function normalizeTime(raw) {
    const value = normalizeText(raw).replace(/\./g, "");
    if (!value) return null;
    if (value === "any") return "any";

    let match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/.exec(value);
    if (match) {
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const suffix = match[3];
      if (hour < 1 || hour > 12 || minute > 59) return null;
      if (suffix === "pm" && hour !== 12) hour += 12;
      if (suffix === "am" && hour === 12) hour = 0;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return null;
  }

  function displayTimeFrom24(value) {
    const normalized = normalizeTime(value);
    if (!normalized || normalized === "any") return value;
    const [hourText, minute] = normalized.split(":");
    const hour24 = Number(hourText);
    const suffix = hour24 >= 12 ? "pm" : "am";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${minute} ${suffix}`;
  }

  function findSlotCards() {
    const cards = [];
    const seenControls = new Set();

    function addFromControl(control, card) {
      if (!control || !card || seenControls.has(control) || !isVisible(control)) return;
      const text = String(card.textContent || "").replace(/\s+/g, " ").trim();
      const timeMatch = /Slot Time\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i.exec(text);
      if (!timeMatch) return;
      const time24 = normalizeTime(timeMatch[1]);
      if (!time24) return;
      const unavailable = /quota is full|slot not available|sold out|unavailable/i.test(text) || Boolean(control.disabled);
      seenControls.add(control);
      cards.push({ control, button: control, card, text, timeText: timeMatch[1], time24, available: !unavailable });
    }

    for (const button of [...document.querySelectorAll("button[value]")].filter(isVisible)) {
      let node = button.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        if (/Slot Time\s*\d{1,2}:\d{2}\s*(am|pm)/i.test(node.textContent || "")) {
          addFromControl(button, node);
          break;
        }
      }
    }

    // Seva pages do not always use the exact same radio/button markup as darshan.
    // Anchor on visible "Slot Time" text, then find the nearest interactive control.
    const timeNodes = [...document.querySelectorAll("div,span,p")].filter((element) => {
      if (!isVisible(element) || element.children.length > 3) return false;
      return /^\s*Slot Time\s*\d{1,2}:\d{2}\s*(?:am|pm)\s*$/i.test(element.textContent || "");
    });
    for (const timeNode of timeNodes) {
      let node = timeNode.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        const control = [...node.querySelectorAll('button,input[type="radio"],[role="radio"]')].find(isVisible);
        if (control) { addFromControl(control, node); break; }
      }
    }

    const unique = new Map();
    for (const card of cards) {
      if (!unique.has(card.time24)) unique.set(card.time24, card);
    }
    return [...unique.values()];
  }

  function pickSlot(cards, preferredSlots, allowAnySlot) {
    const available = cards.filter((card) => card.available);
    if (!available.length) return null;

    const desired = (preferredSlots || []).map(normalizeTime).filter(Boolean);
    for (const wanted of desired) {
      if (wanted === "any") return available[0];
      const match = available.find((card) => card.time24 === wanted);
      if (match) return match;
    }
    return allowAnySlot ? available[0] : null;
  }

  function findSevaChoiceCards() {
    const root = document.getElementById("scrollSlotType") || document;
    const selector = 'button,input[type="radio"],[role="radio"]';
    const controls = [...root.querySelectorAll(selector)].filter(isVisible);
    const cards = [];
    const seen = new Set();

    for (const control of controls) {
      let node = control.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        if (!isVisible(node)) continue;
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
        const availabilityMatch = /(?:^|\s)(\d+)\s*available\b/i.exec(text);
        if (!availabilityMatch) continue;

        const cardControls = [...node.querySelectorAll(selector)].filter(isVisible);
        if (cardControls.length !== 1 || cardControls[0] !== control) continue;

        const availableCount = Number(availabilityMatch[1]);
        const explicitlyUnavailable = /quota(?: is)? full|slot not available|sold out|unavailable/i.test(text) || Boolean(control.disabled);
        const timeMatch = /(?:slot time\s*)?\(?\s*(\d{1,2}:\d{2}\s*(?:am|pm))\s*\)?/i.exec(text);
        const time24 = timeMatch ? normalizeTime(timeMatch[1]) : null;
        const nameMatch = /available\s+(.+?)(?:\s+\(?\d{1,2}:\d{2}\s*(?:am|pm)\)?|\s+\d+\s+persons?|\s+₹|$)/i.exec(text);
        const name = String(nameMatch?.[1] || "seva option").trim();

        if (!seen.has(control)) {
          seen.add(control);
          cards.push({
            control,
            button: control,
            card: node,
            text,
            name,
            availableCount,
            available: !explicitlyUnavailable && availableCount > 1,
            timeText: timeMatch?.[1] || null,
            time24,
          });
        }
        break;
      }
    }
    return cards;
  }

  function sevaChoiceAttemptKey(date, card) {
    const identity = normalizeLoose(card?.name || card?.timeText || card?.text || "seva-option").slice(0, 80) || "seva-option";
    return `${date}|seva:${identity}`;
  }

  function findAdditionalInput(label) {
    return document.querySelector(`input[label="${CSS.escape(label)}"]`);
  }

  function fillAdditionalServices(config) {
    const laddu = Number(config.additionalLaddus || 0);
    if (laddu > 0) {
      const input = findAdditionalInput("No. of Additional Laddus");
      if (input && !input.disabled) setReactInputValue(input, laddu);
    }
    const hundi = Number(config.hundiAmount || 0);
    if (hundi > 0) {
      const input = findAdditionalInput("Hundi Offerings");
      if (input && !input.disabled) setReactInputValue(input, hundi);
    }
  }

  async function waitForBookingMode(date, timeout = 5000) {
    const started = Date.now();
    let directReadySince = 0;
    while (Date.now() - started < timeout) {
      const page = detectPage();
      if (page !== "slot" && page !== "other") return { mode: "page", page };

      const cards = findSlotCards();
      if (cards.length) return { mode: "timed", cards };

      const sevaCards = findSevaChoiceCards();
      if (sevaCards.length) return { mode: "seva-card", cards: sevaCards };

      const body = normalizeText(document.body?.innerText || "");
      const timedHint = body.includes("select any 1 slot") || /slot time\s*\d{1,2}:\d{2}/i.test(body);
      const ticketInput = findTicketCountInput();
      const continueButton = getButtonByText("Continue");
      const selected = isTargetDateSelected(date);

      if (selected && !timedHint && (ticketInput || (continueButton && !continueButton.disabled))) {
        if (!directReadySince) directReadySince = Date.now();
        // Give React a short settling window so a slow time-slot panel is not mistaken for date-only booking.
        if (Date.now() - directReadySince >= 650) {
          const lateCards = findSlotCards();
          if (lateCards.length) return { mode: "timed", cards: lateCards };
          return { mode: "date-only", ticketInput };
        }
      } else {
        directReadySince = 0;
      }
      await sleep(70);
    }

    if (isTargetDateSelected(date) && !findSlotCards().length) {
      const sevaCards = findSevaChoiceCards();
      if (sevaCards.length) return { mode: "seva-card", cards: sevaCards };
      return { mode: "date-only", ticketInput: findTicketCountInput() };
    }
    return null;
  }

  async function submitSevaCardAttempts(config, run, date, cards, failed, submissions, maxAttempts) {
    const candidates = (cards || findSevaChoiceCards()).filter((card) => card.available && card.availableCount > 1);
    if (!candidates.length) return { handled: false, done: false, submissions };

    for (const candidate of candidates) {
      const key = sevaChoiceAttemptKey(date, candidate);
      if (failed.has(key)) continue;
      if (submissions >= maxAttempts) throw new Error(`Stopped after ${maxAttempts} booking attempts`);

      const fresh = findSevaChoiceCards().find((card) => sevaChoiceAttemptKey(date, card) === key && card.available && card.availableCount > 1);
      if (!fresh) continue;

      fresh.control.scrollIntoView({ block: "center", inline: "nearest" });
      fresh.control.click();
      await sleep(90);

      const ticketChoice = await selectTicketCountForPage(config.ticketCount);
      fillAdditionalServices(config);

      const ticketNote = ticketChoice.chosen ? `, ${ticketChoice.chosen} ticket(s)` : "";
      submissions += 1;
      await patchRun({
        state: "waiting-pilgrims",
        submissionCount: submissions,
        message: `Trying ${date}, ${fresh.name || "available seva"} (${fresh.availableCount} available)${ticketNote}...`,
        actual: {
          ...((await getRun())?.actual || {}),
          targetDate: date,
          slotMode: "seva-card",
          slotTime: null,
          slotTime24: null,
          sevaChoice: fresh.name || null,
          sevaChoiceAvailability: fresh.availableCount,
          ticketCount: ticketChoice.chosen,
          requestedTicketCount: ticketChoice.requested,
          ticketCountSource: ticketChoice.source,
        },
      });
      await recordAttempt({ date, time: fresh.name || "seva card", time24: null, status: "trying", actualTickets: ticketChoice.chosen });

      clickContinue();
      const outcome = await waitForOutcome("slot", 9000);
      if (outcome.type === "page") return { handled: true, done: true, submissions };
      if (outcome.type === "failure" && config.autoRecoverFailures !== false) {
        const reason = outcome.popup.text || "TTD rejected this seva option";
        await markCurrentAttemptFailed(reason);
        failed.add(key);
        await patchRun({ state: "recovering", message: `TTD rejected ${date} ${fresh.name || "seva option"}. Trying the next available option...` });
        await closeFailurePopup(outcome.popup);
        if (detectPage() !== "slot") {
          const recovered = await recoverToSlotPage();
          if (!recovered) throw new Error("Could not return to the TTD seva calendar after a failed seva-card attempt");
        }
        if (!isTargetDateSelected(date)) {
          const cell = findDateCell(date);
          if (cell && isDateSelectable(cell)) {
            cell.click();
            try { await waitFor(() => isTargetDateSelected(date), { timeout: 3500, interval: 60, message: "reselect date" }); }
            catch (_) { break; }
          } else break;
        }
        continue;
      }
      if (outcome.type === "failure") throw new Error(outcome.popup.text || "TTD rejected the selected seva option");
      if (outcome.type === "timeout") throw new Error("TTD did not respond after selecting the available seva option");
    }

    return { handled: true, done: false, submissions };
  }

  async function submitDateOnlyAttempt(config, run, date, failed, submissions, maxAttempts) {
    const key = attemptKey(date, null);
    if (failed.has(key)) return { handled: false, submissions };
    if (submissions >= maxAttempts) throw new Error(`Stopped after ${maxAttempts} booking attempts`);

    const ticketChoice = await selectTicketCountForPage(config.ticketCount);
    fillAdditionalServices(config);
    const ticketNote = ticketChoice.chosen
      ? `${ticketChoice.chosen} ticket(s)`
      : "TTD-determined ticket count";

    submissions += 1;
    await patchRun({
      state: "waiting-pilgrims",
      submissionCount: submissions,
      message: `Trying ${date} with no separate time slot, ${ticketNote}...`,
      actual: {
        ...((await getRun())?.actual || {}),
        targetDate: date, slotMode: "date-only", slotTime: null, slotTime24: null,
        ticketCount: ticketChoice.chosen, requestedTicketCount: ticketChoice.requested, ticketCountSource: ticketChoice.source,
      },
    });
    await recordAttempt({ date, time: "date only", time24: null, status: "trying", actualTickets: ticketChoice.chosen });

    clickContinue();
    const outcome = await waitForOutcome("slot", 9000);
    if (outcome.type === "page") return { handled: true, done: true, submissions };
    if (outcome.type === "failure" && config.autoRecoverFailures !== false) {
      const reason = outcome.popup.text || "TTD rejected this date";
      await markCurrentAttemptFailed(reason);
      failed.add(key);
      await patchRun({ state: "recovering", message: `TTD rejected ${date}. Closing the message and trying the next configured date...` });
      await closeFailurePopup(outcome.popup);
      if (detectPage() !== "slot") {
        const recovered = await recoverToSlotPage();
        if (!recovered) throw new Error("Could not return to the TTD seva calendar after a failed date-only attempt");
      }
      return { handled: true, done: false, submissions };
    }
    if (outcome.type === "failure") throw new Error(outcome.popup.text || "TTD rejected the selected date");
    if (outcome.type === "timeout") {
      const popup = failurePopup();
      if (popup && config.autoRecoverFailures !== false) {
        await markCurrentAttemptFailed(popup.text);
        failed.add(key);
        await closeFailurePopup(popup);
        return { handled: true, done: false, submissions };
      }
      throw new Error("TTD did not respond after Continue on the date-only seva");
    }
    return { handled: true, done: false, submissions };
  }

  function clickContinue() {
    const button = getButtonByText("Continue");
    if (!button) throw new Error("Continue button not found");
    if (button.disabled) throw new Error("Continue button is disabled");
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.click();
  }

  async function waitForPageChange(fromPage, timeout = 9000) {
    return waitFor(
      () => {
        const page = detectPage();
        return page !== fromPage && page !== "other" ? page : null;
      },
      { timeout, interval: 80, message: `TTD did not leave the ${fromPage} page after Continue` }
    );
  }

  const FAILURE_RE = /(unavailable|not available|quota(?: is)? full|slot(?:s)? full|failed|failure|unable to|could not|cannot|no slots|try another|try again|sold out|booking.*closed|selection.*expired|session.*expired|something went wrong|error)/i;

  function failurePopup() {
    const selectors = [
      '[role="dialog"]',
      '[class*="DialogBox_dialog"]',
      '[class*="LiveStatusErrorSheet_sheet"]',
      '[class*="notification_container"]',
      '[class*="modal"]',
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((el) => isVisible(el) && !el.closest(`#${OVERLAY_ID}`) && !el.closest(`#${PROMPT_ID}`));
    for (const element of candidates) {
      const text = element.textContent?.replace(/\s+/g, " ").trim() || "";
      if (text && FAILURE_RE.test(text)) return { element, text };
    }
    return null;
  }

  async function closeFailurePopup(popup) {
    const root = popup?.element;
    if (!root) return false;
    const clickable = [...root.querySelectorAll("button,[role='button'],img,svg")].filter(isVisible);
    const direct = clickable.find((node) => /^(close|ok|okay|cancel|dismiss|back)$/i.test(normalizeText(node.textContent || node.getAttribute?.("aria-label") || node.getAttribute?.("alt") || "")));
    const closeIcon = clickable.find((node) => /close|cross|dismiss/i.test(`${node.className || ""} ${node.getAttribute?.("src") || ""} ${node.getAttribute?.("aria-label") || ""}`));
    const target = direct || closeIcon;
    if (target) { target.click(); await sleep(120); return true; }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(120);
    if (!isVisible(root)) return true;
    // Last resort for TTD error dialogs that expose only Retry. The current
    // combination is already marked failed before this is used.
    const retry = clickable.find((node) => /^retry$/i.test(normalizeText(node.textContent || "")));
    if (retry) { retry.click(); await sleep(180); return true; }
    return !isVisible(root);
  }

  async function waitForOutcome(fromPage, timeout = 9000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const popup = failurePopup();
      if (popup) return { type: "failure", popup };
      const page = detectPage();
      if (page !== fromPage && page !== "other") return { type: "page", page };
      await sleep(80);
    }
    return { type: "timeout" };
  }

  function attemptKey(date, time24) { return `${date}|${time24 || "any"}`; }

  async function recordAttempt({ date, time, time24, status, reason = "", actualTickets = null }) {
    const run = (await getRun()) || {};
    const attempts = [...(run.attempts || [])];
    attempts.push({ date, time: time || displayTimeFrom24(time24 || ""), time24, status, reason, actualTickets, at: Date.now() });
    const failedAttempts = [...new Set(run.failedAttempts || [])];
    if (status === "failed") failedAttempts.push(attemptKey(date, time24));
    await patchRun({ attempts: attempts.slice(-40), failedAttempts: [...new Set(failedAttempts)] });
  }

  async function markCurrentAttemptFailed(reason) {
    const run = (await getRun()) || {};
    const actual = run.actual || {};
    if (!actual.targetDate) return;
    await recordAttempt({
      date: actual.targetDate, time: actual.slotTime, time24: actual.slotTime24,
      status: "failed", reason: String(reason || "TTD rejected selection").slice(0, 120), actualTickets: actual.ticketCount || null,
    });
  }

  async function recoverToSlotPage() {
    let popup = failurePopup();
    if (popup) await closeFailurePopup(popup);
    if (detectPage() === "slot") return true;
    for (let i = 0; i < 3; i += 1) {
      const back = getButtonByText("Back") || [...document.querySelectorAll("button")].find((b) => isVisible(b) && /back/i.test(b.className || ""));
      if (!back) break;
      back.click();
      try {
        await waitFor(() => detectPage() === "slot", { timeout: 3500, interval: 80, message: "waiting for slot page" });
        return true;
      } catch (_) {
        popup = failurePopup();
        if (popup) await closeFailurePopup(popup);
      }
    }
    return detectPage() === "slot";
  }

  async function processSlotPage(config, run) {
    run = await bindOrVerifyServiceContext(run);
    const context = run?.serviceContext || readServiceContext();
    const contextText = context ? ` for ${context.temple || "selected temple"}${context.seva ? ` / ${context.seva}` : ""}` : "";
    await patchRun({ state: "slot", message: `Searching your preferred dates${contextText}...` });

    const dates = configDates(config);
    if (!dates.length) throw new Error("No preferred dates are configured");
    const preferred = (config.preferredSlots || []).map(normalizeTime).filter(Boolean);
    const latestRun = (await getRun()) || run;
    const failed = new Set(latestRun.failedAttempts || []);
    const maxAttempts = Math.max(1, Number(config.maxAttempts || 20));
    let submissions = Number(latestRun.submissionCount || 0);

    for (const date of dates) {
      await bindOrVerifyServiceContext((await getRun()) || latestRun);

      let dateAlreadySelected = isTargetDateSelected(date);
      if (!dateAlreadySelected) {
        const dateCell = findDateCell(date);
        if (!dateCell || !isDateSelectable(dateCell)) {
          log("date-unavailable", date, describeDateCell(dateCell));
          continue;
        }
        dateCell.scrollIntoView({ block: "center", inline: "nearest" });
        dateCell.click();
        try {
          const selectionResult = await waitFor(() => {
            const page = detectPage();
            if (page !== "slot" && page !== "other") return { page };
            return isTargetDateSelected(date) ? { selected: true } : null;
          }, { timeout: 4500, interval: 50, message: "TTD did not accept the selected date" });
          if (selectionResult?.page) return;
        } catch (_) {
          continue;
        }
      }

      const modeInfo = await waitForBookingMode(date, 5000);
      if (!modeInfo) {
        log("booking-mode-unresolved", date);
        continue;
      }
      if (modeInfo.mode === "page") return;

      if (modeInfo.mode === "seva-card") {
        const direct = await submitSevaCardAttempts(config, (await getRun()) || latestRun, date, modeInfo.cards, failed, submissions, maxAttempts);
        submissions = direct.submissions;
        if (direct.done) return;
        continue;
      }

      if (modeInfo.mode === "date-only") {
        const direct = await submitDateOnlyAttempt(config, (await getRun()) || latestRun, date, failed, submissions, maxAttempts);
        submissions = direct.submissions;
        if (direct.done) return;
        continue;
      }

      let cards = modeInfo.cards || findSlotCards();
      if (!cards.length) continue;

      const ticketChoice = await selectTicketCountForPage(config.ticketCount);
      const requestedText = ticketChoice.chosen && ticketChoice.chosen < ticketChoice.requested
        ? ` TTD only offers ${ticketChoice.chosen}; using ${ticketChoice.chosen}.`
        : (ticketChoice.chosen ? "" : " Ticket count is fixed/decided by TTD on this seva.");
      await patchRun({ message: `Checking ${date}.${requestedText}` });

      const orderedCandidates = [];
      for (const wanted of preferred) {
        const card = cards.find((c) => c.available && c.time24 === wanted);
        if (card && !failed.has(attemptKey(date, card.time24))) orderedCandidates.push(card);
      }
      if (config.allowAnySlot) {
        for (const card of cards.filter((c) => c.available)) {
          if (!orderedCandidates.some((x) => x.time24 === card.time24) && !failed.has(attemptKey(date, card.time24))) orderedCandidates.push(card);
        }
      }

      if (!orderedCandidates.length) continue;

      for (const selectedSlot of orderedCandidates) {
        if (submissions >= maxAttempts) throw new Error(`Stopped after ${maxAttempts} booking attempts`);
        cards = findSlotCards();
        const fresh = cards.find((c) => c.available && c.time24 === selectedSlot.time24);
        if (!fresh) continue;
        const freshTicketChoice = await selectTicketCountForPage(config.ticketCount);

        fresh.control.scrollIntoView({ block: "center", inline: "nearest" });
        fresh.control.click();
        await sleep(60);
        fillAdditionalServices(config);

        submissions += 1;
        await patchRun({
          state: "waiting-pilgrims",
          submissionCount: submissions,
          message: `Trying ${date}, ${fresh.timeText}${freshTicketChoice.chosen ? `, ${freshTicketChoice.chosen} ticket(s)` : ""}...`,
          actual: {
            ...((await getRun())?.actual || {}), targetDate: date, slotMode: "timed", slotTime: fresh.timeText, slotTime24: fresh.time24,
            ticketCount: freshTicketChoice.chosen, requestedTicketCount: freshTicketChoice.requested, ticketCountSource: freshTicketChoice.source,
          },
        });
        await recordAttempt({ date, time: fresh.timeText, time24: fresh.time24, status: "trying", actualTickets: freshTicketChoice.chosen });

        clickContinue();
        const outcome = await waitForOutcome("slot", 9000);
        if (outcome.type === "page") return;
        if (outcome.type === "failure" && config.autoRecoverFailures !== false) {
          const reason = outcome.popup.text || "TTD rejected this selection";
          await markCurrentAttemptFailed(reason);
          failed.add(attemptKey(date, fresh.time24));
          await patchRun({ state: "recovering", message: `TTD rejected ${date} ${fresh.timeText}. Closing the message and trying the next option...` });
          await closeFailurePopup(outcome.popup);
          if (detectPage() !== "slot") {
            const recovered = await recoverToSlotPage();
            if (!recovered) throw new Error("Could not return to the TTD slot page after a failed attempt");
          }
          if (!isTargetDateSelected(date)) {
            const cell = findDateCell(date);
            if (cell && isDateSelectable(cell)) {
              cell.click();
              try {
                await waitFor(() => isTargetDateSelected(date), { timeout: 3500, interval: 60, message: "reselect date" });
              } catch (_) { break; }
            } else {
              break;
            }
          }
          continue;
        }
        if (outcome.type === "failure") throw new Error(outcome.popup.text || "TTD rejected the selected slot");
        if (outcome.type === "timeout") {
          const popup = failurePopup();
          if (popup && config.autoRecoverFailures !== false) {
            await markCurrentAttemptFailed(popup.text);
            failed.add(attemptKey(date, fresh.time24));
            await closeFailurePopup(popup);
            continue;
          }
          throw new Error("TTD did not respond after Continue");
        }
      }
    }

    throw new Error("None of the configured dates/times are currently available for the selected Temple/Seva");
  }

  const PILGRIM_SCHEMAS = [
    { key: "darshan", name: "fname", age: "age", gender: "gender", idType: "photoIdType", idNumber: "idProofNumber" },
    { key: "seva", name: "name", age: "age", gender: "gender", idType: "idType", idNumber: "idNumber" },
  ];
  const KNOWN_PILGRIM_NAMES = new Set(PILGRIM_SCHEMAS.flatMap((schema) => [schema.name, schema.age, schema.gender, schema.idType, schema.idNumber]));
  const PROMPT_ID = "ttdff-adaptive-prompt";

  function visibleInputsByName(name) {
    return [...document.querySelectorAll(`input[name="${name}"]`)].filter(isVisible);
  }

  function detectPilgrimFormSchema() {
    for (const schema of PILGRIM_SCHEMAS) {
      const names = visibleInputsByName(schema.name);
      if (!names.length) continue;
      const ages = visibleInputsByName(schema.age);
      const genders = visibleInputsByName(schema.gender);
      const idTypes = visibleInputsByName(schema.idType);
      const idNumbers = visibleInputsByName(schema.idNumber);
      const count = names.length;
      if ([ages.length, genders.length, idTypes.length, idNumbers.length].every((n) => n >= count)) {
        return { schema, names, ages, genders, idTypes, idNumbers, rowCount: count };
      }
    }
    return null;
  }

  function fieldLabel(control) {
    const bits = [];
    if (control.getAttribute("label")) bits.push(control.getAttribute("label"));
    if (control.getAttribute("aria-label")) bits.push(control.getAttribute("aria-label"));
    if (control.placeholder) bits.push(control.placeholder);
    if (control.id) {
      try {
        const linked = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
        if (linked?.textContent) bits.push(linked.textContent);
      } catch (_) {}
    }
    const parentLabel = control.closest("label");
    if (parentLabel?.textContent) bits.push(parentLabel.textContent);
    let node = control.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const labels = [...node.querySelectorAll(":scope > label")].map((x) => x.textContent || "");
      bits.push(...labels);
    }
    if (control.name) bits.push(control.name);
    if (control.id) bits.push(control.id);
    return bits.map((x) => String(x).replace(/\*/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean)[0] || control.name || control.id || "Unknown field";
  }

  function controlType(control) {
    if (control.tagName === "SELECT") return "select";
    if (control.type === "checkbox") return "checkbox";
    if (control.type === "radio") return "radio";
    if (control.readOnly || control.getAttribute("aria-haspopup") === "listbox") return "dropdown";
    return control.tagName === "TEXTAREA" ? "textarea" : "input";
  }

  function findPilgrimRowContainer(nameInput, schema = detectPilgrimFormSchema()?.schema) {
    if (!schema) return nameInput?.parentElement || null;
    let node = nameInput?.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const names = node.querySelectorAll(`input[name="${schema.name}"]`);
      if (names.length === 1 && node.querySelector(`input[name="${schema.age}"]`) && node.querySelector(`input[name="${schema.gender}"]`) && node.querySelector(`input[name="${schema.idType}"]`)) return node;
    }
    return nameInput?.parentElement || null;
  }

  function canonicalFromText(text) {
    const n = normalizeText(text).replace(/[^a-z0-9 ]/g, " ");
    const compact = normalizeLoose(text);
    if (/\b(gothram|gotram|gothra|gothra m|gothram name)\b/.test(n) || compact.includes("gothram")) return "gothram";
    if (/\b(email|email address|pilgrim email)\b/.test(n) || compact.includes("pilgrimemail")) return "email";
    if (/\b(city|pilgrim city)\b/.test(n) || compact.includes("pilgrimcity")) return "city";
    if (/\b(state|pilgrim state)\b/.test(n) || compact.includes("pilgrimstate")) return "state";
    if (/\b(country|pilgrim country)\b/.test(n) || compact.includes("pilgrimcountry")) return "country";
    if (/\b(pincode|pin code|postal code|zip code|zipcode)\b/.test(n) || compact.includes("pilgrimpincode")) return "pincode";
    if (/\brelationship\b|relation to/.test(n)) return "relationship";
    if (/\bnationality\b|country of citizenship/.test(n)) return "nationality";
    return "unknown";
  }

  function descriptorFor(control, rowContainers = []) {
    const rowIndex = rowContainers.findIndex((row) => row?.contains(control));
    const label = fieldLabel(control);
    const type = controlType(control);
    const signature = [normalizeText(label), normalizeText(control.name), normalizeText((control.id || "").replace(/\d+/g, "#")), type].join("|");
    return {
      element: control,
      label,
      name: control.name || "",
      id: control.id || "",
      placeholder: control.placeholder || "",
      required: Boolean(control.required || control.getAttribute("aria-required") === "true"),
      readOnly: Boolean(control.readOnly),
      disabled: Boolean(control.disabled),
      controlType: type,
      scope: rowIndex >= 0 ? "perPilgrim" : "global",
      rowIndex,
      signature,
      canonicalField: canonicalFromText(`${label} ${control.name || ""} ${control.id || ""}`),
    };
  }

  function discoverAdaptiveFields() {
    const detected = detectPilgrimFormSchema();
    const rows = detected ? detected.names.map((input) => findPilgrimRowContainer(input, detected.schema)) : [];
    const controls = [...document.querySelectorAll("input,select,textarea")].filter((control) => {
      if (!isVisible(control) || control.closest(`#${OVERLAY_ID}`) || control.closest(`#${PROMPT_ID}`)) return false;
      if (KNOWN_PILGRIM_NAMES.has(control.name)) return false;
      if (["hidden", "submit", "button"].includes(control.type)) return false;
      const row = rows.find((r) => r?.contains(control));
      if (row) return true;
      const text = `${fieldLabel(control)} ${control.name || ""} ${control.id || ""}`;
      return Boolean(control.required || canonicalFromText(text) !== "unknown");
    });
    return controls.map((c) => descriptorFor(c, rows));
  }

  async function getLearnedMappings() { return (await getLocal(KEYS.learnedMappings)) || {}; }
  async function getLearnedAnswers() { return (await getLocal(KEYS.learnedAnswers)) || {}; }

  async function saveLearnedMapping(desc, canonicalField, source) {
    const mappings = await getLearnedMappings();
    mappings[desc.signature] = {
      canonicalField,
      controlType: desc.controlType,
      scope: desc.scope,
      label: desc.label,
      name: desc.name,
      idPattern: (desc.id || "").replace(/\d+/g, "#"),
      source,
      lastSuccessfulAt: new Date().toISOString(),
    };
    await setLocal(KEYS.learnedMappings, mappings);
  }

  function answerKey(canonicalField, desc) {
    return desc.scope === "perPilgrim" ? `${canonicalField}:pilgrim:${desc.rowIndex}` : `${canonicalField}:global`;
  }

  async function optionsForControl(control) {
    if (control.tagName === "SELECT") {
      return [...control.options].map((o) => o.textContent.trim()).filter(Boolean);
    }
    if (!(control.readOnly || control.getAttribute("aria-haspopup") === "listbox")) return [];
    control.scrollIntoView({ block: "center", inline: "nearest" });
    control.click();
    await sleep(50);
    const options = [...document.querySelectorAll("li")]
      .filter(isVisible)
      .map((li) => li.textContent.replace(/\s+/g, " ").trim())
      .filter((x) => x && x.length < 120);
    // Close the dropdown without choosing a value when possible.
    control.click();
    return [...new Set(options)].slice(0, 100);
  }

  async function promptForAdaptiveValue(desc, canonicalField, options = []) {
    const previous = document.getElementById(PROMPT_ID);
    if (previous) previous.remove();
    return new Promise((resolve, reject) => {
      const root = document.createElement("div");
      root.id = PROMPT_ID;
      root.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif";
      const card = document.createElement("div");
      card.style.cssText = "width:min(430px,92vw);background:#fff;color:#111827;border-radius:14px;padding:18px;box-shadow:0 16px 50px rgba(0,0,0,.3)";
      const scope = desc.scope === "perPilgrim" ? `Pilgrim ${desc.rowIndex + 1}` : "Booking";
      card.innerHTML = `<div style="font-weight:800;font-size:16px;margin-bottom:5px">TTD needs one more detail</div>
        <div style="font-size:13px;margin-bottom:10px"><b>${desc.label}</b> · ${scope}</div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:10px">Detected as <b>${canonicalField}</b><br>id: ${desc.id || "(none)"}<br>name: ${desc.name || "(none)"}</div>`;
      let input;
      if (options.length) {
        input = document.createElement("select");
        input.style.cssText = "width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:12px";
        input.innerHTML = `<option value="">Choose...</option>` + options.map((o) => `<option></option>`).join("");
        [...input.options].slice(1).forEach((opt, i) => { opt.value = options[i]; opt.textContent = options[i]; });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = `Enter ${desc.label}`;
        input.style.cssText = "width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:12px;box-sizing:border-box";
      }
      card.appendChild(input);
      const buttons = document.createElement("div");
      buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px";
      const cancel = document.createElement("button");
      cancel.textContent = "Stop";
      const save = document.createElement("button");
      save.textContent = "Save & Continue";
      save.style.cssText = "background:#6d28d9;color:#fff;border:0;border-radius:8px;padding:9px 12px;font-weight:700";
      cancel.style.cssText = "background:#e5e7eb;color:#111827;border:0;border-radius:8px;padding:9px 12px;font-weight:700";
      cancel.onclick = () => { root.remove(); reject(new Error(`Missing value for ${desc.label}`)); };
      save.onclick = () => {
        const value = String(input.value || "").trim();
        if (!value) return;
        root.remove();
        resolve(value);
      };
      buttons.append(cancel, save);
      card.appendChild(buttons);
      root.appendChild(card);
      document.documentElement.appendChild(root);
      input.focus();
    });
  }

  async function askGeminiToIdentify(config, desc) {
    if (!config.geminiEnabled || !config.geminiApiKey) return null;
    const payload = {
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      field: {
        label: desc.label,
        name: desc.name,
        id: desc.id.replace(/\d+/g, "#"),
        placeholder: desc.placeholder,
        required: desc.required,
        readOnly: desc.readOnly,
        controlType: desc.controlType,
        scope: desc.scope,
      },
    };
    try {
      const response = await chrome.runtime.sendMessage({ type: "TTDFF_GEMINI_ANALYZE", payload });
      if (!response?.ok) throw new Error(response?.error || "Gemini failed");
      if (Number(response.result?.confidence || 0) < 0.55) return null;
      return response.result;
    } catch (error) {
      log("gemini-fallback-failed", error.message || String(error));
      return null;
    }
  }

  async function getGothramAliases() { return (await getLocal(KEYS.gothramAliases)) || {}; }

  async function saveGothramAlias(entered, actual) {
    const aliases = await getGothramAliases();
    aliases[normalizeLoose(entered)] = actual;
    await setLocal(KEYS.gothramAliases, aliases);
  }

  async function resolveDropdownValue(value, options, canonicalField) {
    if (!options?.length) return { value, confident: true, source: "raw" };
    const wanted = normalizeLoose(value);
    if (!wanted) return { value: "", confident: false };

    if (canonicalField === "gothram") {
      const aliases = await getGothramAliases();
      const learned = aliases[wanted];
      if (learned && options.some((o) => normalizeLoose(o) === normalizeLoose(learned))) {
        return { value: options.find((o) => normalizeLoose(o) === normalizeLoose(learned)), confident: true, source: "learned-alias" };
      }
    }

    const exact = options.find((o) => normalizeLoose(o) === wanted);
    if (exact) return { value: exact, confident: true, source: "exact" };

    if (wanted.length >= 3) {
      const prefixes = options.filter((o) => normalizeLoose(o).startsWith(wanted) || wanted.startsWith(normalizeLoose(o)));
      if (prefixes.length === 1) return { value: prefixes[0], confident: true, source: "prefix" };
    }

    const scored = options.map((o) => ({ option: o, score: similarity(value, o) })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    if (best && best.score >= 0.74 && (!second || best.score - second.score >= 0.08)) {
      return { value: best.option, confident: true, source: "fuzzy", score: best.score };
    }
    return { value: "", confident: false, candidates: scored.slice(0, 5) };
  }

  async function setAdaptiveControlValue(desc, value, options = [], canonicalField = "unknown") {
    const control = desc.element;
    if (desc.controlType === "select") {
      const labels = [...control.options].map((o) => o.textContent.trim()).filter(Boolean);
      const resolved = await resolveDropdownValue(value, labels, canonicalField);
      if (!resolved.confident) throw new Error(`${desc.label}: '${value}' does not uniquely match a TTD option`);
      const opt = [...control.options].find((o) => normalizeLoose(o.textContent) === normalizeLoose(resolved.value) || normalizeLoose(o.value) === normalizeLoose(resolved.value));
      if (!opt) throw new Error(`${desc.label}: matched option '${resolved.value}' disappeared`);
      control.value = opt.value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
      if (canonicalField === "gothram" && normalizeLoose(value) !== normalizeLoose(resolved.value)) await saveGothramAlias(value, resolved.value);
      return resolved.value;
    }
    if (desc.controlType === "dropdown") {
      const resolved = await resolveDropdownValue(value, options, canonicalField);
      if (!resolved.confident) throw new Error(`${desc.label}: '${value}' does not uniquely match a TTD option`);
      await selectCustomDropdown(control, resolved.value);
      if (canonicalField === "gothram" && normalizeLoose(value) !== normalizeLoose(resolved.value)) await saveGothramAlias(value, resolved.value);
      return resolved.value;
    }
    if (desc.controlType === "checkbox") {
      const desired = /^(true|yes|1|checked)$/i.test(String(value));
      if (control.checked !== desired) control.click();
      return value;
    }
    setReactInputValue(control, value);
    return value;
  }

  async function fillAdaptiveFields(config, pilgrims) {
    const fields = discoverAdaptiveFields();
    if (!fields.length) return [];
    const mappings = await getLearnedMappings();
    const answers = await getLearnedAnswers();
    const results = [];

    for (const desc of fields) {
      if (desc.disabled) continue;
      let canonicalField = desc.canonicalField;
      let source = canonicalField !== "unknown" ? "deterministic" : "";
      if (canonicalField === "unknown" && mappings[desc.signature]?.canonicalField) {
        canonicalField = mappings[desc.signature].canonicalField;
        source = "learned";
      }
      if (canonicalField === "unknown") {
        const ai = await askGeminiToIdentify(config, desc);
        if (ai?.canonicalField && ai.canonicalField !== "unknown") {
          canonicalField = ai.canonicalField;
          source = "ai-mapped";
        }
      }

      // Unknown required fields are still handled safely: ask the user instead of guessing.
      if (canonicalField === "unknown" && !desc.required) continue;
      if (canonicalField === "unknown") canonicalField = normalizeText(desc.label).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown_field";

      let options = [];
      if (desc.controlType === "select") options = await optionsForControl(desc.element);
      // For custom dropdowns only open it when we actually need to validate/prompt.

      let value = "";
      if (canonicalField === "gothram") {
        if (config.gothramMode === "same") {
          value = config.globalGothram || pilgrims[0]?.gothram || "";
        } else if (config.gothramMode === "perPilgrim") {
          value = desc.scope === "perPilgrim" ? (pilgrims[desc.rowIndex]?.gothram || "") : (config.globalGothram || pilgrims[0]?.gothram || "");
        } else {
          value = desc.scope === "perPilgrim" ? (pilgrims[desc.rowIndex]?.gothram || config.globalGothram || "") : (config.globalGothram || pilgrims[0]?.gothram || "");
        }
      }
      const configuredGeneral = {
        email: config.bookingEmail || "",
        city: config.bookingCity || "",
        state: config.bookingState || "",
        country: config.bookingCountry || "",
        pincode: config.bookingPincode || "",
      };
      if (!value && Object.prototype.hasOwnProperty.call(configuredGeneral, canonicalField)) value = configuredGeneral[canonicalField];
      if (!value) value = answers[answerKey(canonicalField, desc)] || answers[`${canonicalField}:global`] || "";
      // If the user already typed a value on TTD, keep it instead of interrupting
      // the booking with a prompt. This also helps when TTD pre-populates fields.
      if (!value && typeof desc.element?.value === "string" && desc.element.value.trim() && desc.controlType !== "dropdown") {
        value = desc.element.value.trim();
        source = source || "existing-page";
      }

      if (desc.controlType === "dropdown" && value) {
        options = await optionsForControl(desc.element);
        const resolved = await resolveDropdownValue(value, options, canonicalField);
        if (!resolved.confident) value = "";
      }
      if (!value) {
        if (desc.controlType === "dropdown" && !options.length) options = await optionsForControl(desc.element);
        value = await promptForAdaptiveValue(desc, canonicalField, options);
        source = source || "manual";
      }

      const actualValue = await setAdaptiveControlValue(desc, value, options, canonicalField);
      await saveLearnedMapping(desc, canonicalField, source || "manual");
      if (config.rememberAdaptiveAnswers) {
        answers[answerKey(canonicalField, desc)] = actualValue;
        // A global answer is a useful fallback for repeated global fields.
        if (desc.scope === "global") answers[`${canonicalField}:global`] = actualValue;
        await setLocal(KEYS.learnedAnswers, answers);
      }
      results.push({ label: desc.label, canonicalField, scope: desc.scope, rowIndex: desc.rowIndex, source, id: desc.id, name: desc.name });
    }
    return results;
  }

  function buildInspectorReport() {
    const page = detectPage();
    const countdown = detectCountdown();
    const detected = detectPilgrimFormSchema();
    const names = detected?.names || [];
    const rows = detected ? names.map((input) => findPilgrimRowContainer(input, detected.schema)) : [];
    const all = [...document.querySelectorAll("input,select,textarea")]
      .filter((c) => isVisible(c) && !c.closest(`#${OVERLAY_ID}`) && !c.closest(`#${PROMPT_ID}`))
      .map((c) => descriptorFor(c, rows));
    const age = (timestamp) => timestamp ? `${Math.max(0, Math.round((Date.now() - timestamp) / 1000))}s ago` : "not seen yet";
    const serviceContext = readServiceContext();
    const slotCards = page === "slot" ? findSlotCards() : [];
    const sevaChoiceCards = page === "slot" ? findSevaChoiceCards() : [];
    const ticketInput = page === "slot" ? findTicketCountInput() : null;
    const lines = [
      `FastFill: connected v${FASTFILL_VERSION}`,
      `Page state: ${page === "other" ? "UNKNOWN (still watching; no reload needed)" : page.toUpperCase()}`,
      `Recognition: DOM-first${detected ? ` · pilgrim schema=${detected.schema.key}` : ""}`,
      `Temple: ${serviceContext?.temple || "not detected / not applicable"}`,
      `Seva: ${serviceContext?.seva || "not detected / not applicable"}`,
      `Visible time slots: ${slotCards.length}`,
      `Visible seva cards: ${sevaChoiceCards.length}${sevaChoiceCards.length ? ` (${sevaChoiceCards.filter((card) => card.availableCount > 1 && card.available).length} with >1 available)` : ""}`,
      `Ticket selector: ${ticketInput ? `yes (${ticketInput.value || "blank"}${ticketInput.disabled ? ", disabled/fixed" : ""})` : (findFixedTicketCount() ? `fixed (${findFixedTicketCount()})` : "not visible")}`,
      `URL: ${location.href}`,
      `Countdown: ${countdown ? countdown.formatted : "not detected"}`,
      `DOM watcher: ${observer ? "active" : "starting"}`,
      `URL sanity watcher: ${sanityTimer ? "active" : "starting"}`,
      `Last DOM change: ${age(lastDomChangeAt)}`,
      `Last route/URL change: ${age(lastRouteChangeAt)}`,
      `Pilgrim rows: ${names.length}`,
      "",
    ];
    if (countdown?.context) {
      lines.push(`Countdown context: ${countdown.context}`);
      lines.push("");
    }
    all.forEach((d, i) => {
      const known = KNOWN_PILGRIM_NAMES.has(d.name) ? "known-pilgrim" : (d.canonicalField !== "unknown" ? `adaptive:${d.canonicalField}` : "unknown");
      lines.push(`${i + 1}. ${d.label}`);
      lines.push(`   status=${known} scope=${d.scope}${d.rowIndex >= 0 ? `(${d.rowIndex + 1})` : ""} type=${d.controlType} required=${d.required}`);
      lines.push(`   id=${d.id || "(none)"} name=${d.name || "(none)"}`);
    });
    if (!all.length) lines.push("No visible form fields yet. FastFill is attached and will keep watching this tab.");
    return lines.join("\n");
  }

  async function processPilgrimPage(config, pilgrims, run) {
    await patchRun({ state: "pilgrims", message: "Reading TTD pilgrim form..." });

    const detected = detectPilgrimFormSchema();
    if (!detected) throw new Error("TTD pilgrim form was not recognized");
    const { schema, names, ages, genders, idTypes, idNumbers, rowCount } = detected;
    if (!rowCount) throw new Error("TTD pilgrim rows were not found");
    if (pilgrims.length < rowCount) throw new Error(`TTD requires ${rowCount} pilgrim(s), but only ${pilgrims.length} profile(s) are prepared`);

    const actualTickets = Number(run?.actual?.ticketCount || config.ticketCount);
    const expectedByRatio = config.personsPerTicket === "auto" ? null : actualTickets * Number(config.personsPerTicket);
    const fewerNote = rowCount < pilgrims.length ? ` Using the first ${rowCount} profile(s) by your saved priority order.` : "";
    const ratioNote = expectedByRatio && expectedByRatio !== rowCount ? ` TTD rendered ${rowCount}; configured expectation from ${actualTickets} ticket(s) was ${expectedByRatio}. TTD row count wins.` : "";
    await patchRun({ state: "pilgrims", message: `Recognized TTD ${schema.key} pilgrim form with ${rowCount} row(s).${fewerNote} Filling them now.${ratioNote}`, actual: { ...(run.actual || {}), pilgrimRows: rowCount, pilgrimSchema: schema.key } });

    // Booking-level fields such as Gothram, email, city, state, country and
    // pincode are filled independently from the number of pilgrim rows.
    const adaptive = await fillAdaptiveFields(config, pilgrims);
    if (adaptive.length) log("adaptive-fields-filled", adaptive);

    for (let index = 0; index < rowCount; index += 1) {
      const pilgrim = pilgrims[index];
      if (!pilgrim?.name || pilgrim.age === "" || !pilgrim.gender || !pilgrim.idType || !pilgrim.idNumber) throw new Error(`Pilgrim ${index + 1} profile is incomplete`);
      setReactInputValue(names[index], pilgrim.name);
      setReactInputValue(ages[index], pilgrim.age);
      await selectCustomDropdown(genders[index], pilgrim.gender);
      // Some seva forms keep Photo ID Proof disabled until the preceding
      // pilgrim fields are valid. Wait for TTD/React to enable it.
      await waitFor(() => !idTypes[index].disabled, { timeout: 3000, interval: 25, message: `Photo ID type field ${index + 1} stayed disabled` });
      await selectCustomDropdown(idTypes[index], pilgrim.idType);
      await waitFor(() => !idNumbers[index].disabled, { timeout: 3000, interval: 25, message: `Photo ID number field ${index + 1} stayed disabled` });
      setReactInputValue(idNumbers[index], pilgrim.idNumber);
      await sleep(25);
    }

    await patchRun({
      state: "waiting-review",
      message: `Filled ${rowCount} pilgrim(s)${adaptive.length ? ` and ${adaptive.length} general/adaptive field(s)` : ""}. Continuing to review...`,
      actual: { ...(await getRun())?.actual, pilgrimRows: rowCount, pilgrimSchema: schema.key, adaptiveFields: adaptive },
    });

    clickContinue();
    const outcome = await waitForOutcome("pilgrims", 9000);
    if (outcome.type === "page") return;
    if (outcome.type === "failure" && config.autoRecoverFailures !== false) {
      await markCurrentAttemptFailed(outcome.popup.text);
      await patchRun({ state: "recovering", message: "TTD rejected this booking after pilgrim details. Returning to slots and trying the next option..." });
      await closeFailurePopup(outcome.popup);
      const recovered = await recoverToSlotPage();
      if (!recovered) throw new Error("Could not return to the slot page after TTD rejected the booking");
      scheduleResume("recovered-from-pilgrims");
      return;
    }
    if (outcome.type === "failure") throw new Error(outcome.popup.text || "TTD rejected the booking");
    throw new Error("TTD did not respond after pilgrim Continue");
  }

  function dateVariants(isoDate) {
    const { year, month, day } = parseISODate(isoDate);
    const shortMonth = MONTHS[month - 1].slice(0, 3);
    const longMonth = MONTHS[month - 1];
    return [
      `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
      `${day}/${month}/${year}`,
      `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`,
      `${String(day).padStart(2, "0")} ${shortMonth}, ${year}`,
      `${day} ${shortMonth}, ${year}`,
      `${day} ${shortMonth} ${year}`,
      `${longMonth} ${day}, ${year}`,
    ].map(normalizeText);
  }

  function validateReview(config, run) {
    const text = normalizeText(document.body?.innerText);
    const selectedDate = run?.actual?.targetDate || configDates(config)[0];
    const dateOkay = selectedDate && dateVariants(selectedDate).some((variant) => text.includes(variant));
    if (!dateOkay) {
      throw new Error(`Review page does not show the selected date ${selectedDate || "(unknown)"}`);
    }

    const selectedTime = run?.actual?.slotTime || displayTimeFrom24(run?.actual?.slotTime24 || "");
    if (selectedTime && !text.includes(normalizeText(selectedTime))) {
      throw new Error(`Review page does not show the selected slot ${selectedTime}`);
    }

    const action = findReviewActionButton();
    if (!action) throw new Error("Final review/payment button not found on review page");
    return action;
  }

  async function processReviewPage(config, run) {
    await patchRun({ state: "review", message: "Validating review page..." });
    const finalAction = validateReview(config, run);
    if (run?.actual?.targetDate) {
      await recordAttempt({ date: run.actual.targetDate, time: run.actual.slotTime, time24: run.actual.slotTime24, status: "success", reason: "Review reached", actualTickets: run.actual.ticketCount || null });
    }

    if (!config.autoPayNow) {
      await stopRun("review-ready", "Review is ready. Automatic final action is off, so review the details and continue manually.");
      return;
    }

    await patchRun({
      state: "payment",
      message: "Review matched. Clicking the final TTD review/payment action...",
      active: false,
      finishedAt: Date.now(),
    });
    finalAction.scrollIntoView({ block: "center", inline: "nearest" });
    finalAction.click();
  }

  async function runStateMachine(source = "auto") {
    if (processing) return;
    const run = await getRun();
    if (!run?.active) return;

    const config = await getConfig();
    if (!config) {
      await stopRun("error", "No saved booking setup found. Open the extension and save setup first.");
      return;
    }
    const pilgrims = await getPilgrims(config);
    showOverlay(run);

    const page = detectPage();
    log("resume", { source, page, step: run.state, url: location.href });

    if (page === "countdown") {
      const countdown = detectCountdown();
      await patchRun({
        state: "waiting-countdown",
        message: `TTD countdown detected${countdown ? `: ${countdown.formatted}` : ""}. FastFill is attached and watching. Do not reload this tab.`,
      });
      return;
    }

    if (page === "queue") {
      await patchRun({ state: "waiting-slot", message: "Official TTD queue detected. FastFill will not interact with it. FastFill is attached and watching; do not reload this tab." });
      return;
    }

    if (page === "other") {
      await patchRun({ state: "waiting-slot", message: "Page not recognized yet. FastFill is attached and still watching for TTD to reveal the booking page. No reload is needed." });
      return;
    }

    if (page === "payment-or-other" && run.state === "payment") {
      await stopRun("payment", "Payment page reached. FastFill has stopped.");
      return;
    }

    processing = true;
    try {
      const latestRun = (await getRun()) || run;
      if (page === "slot") {
        await processSlotPage(config, latestRun);
      } else if (page === "pilgrims") {
        await processPilgrimPage(config, pilgrims, latestRun);
      } else if (page === "review") {
        await processReviewPage(config, latestRun);
      }
    } catch (error) {
      console.error(LOG_PREFIX, error);
      const popup = failurePopup();
      if (popup && config.autoRecoverFailures !== false && ["slot", "pilgrims"].includes(page)) {
        await markCurrentAttemptFailed(popup.text);
        await closeFailurePopup(popup);
        const recovered = await recoverToSlotPage();
        if (recovered) {
          await patchRun({ active: true, state: "slot", message: "Recovered from a TTD failure. Trying the next configured option..." });
          scheduleResume("catch-recovery");
        } else {
          await stopRun("error", error?.message || String(error));
        }
      } else {
        await stopRun("error", error?.message || String(error));
      }
    } finally {
      processing = false;
    }
  }

  function scheduleResume(source) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => runStateMachine(source), 120);
  }

  function installRouteHooks() {
    const onPopState = () => {
      lastRouteChangeAt = Date.now();
      scheduleResume("popstate");
    };
    const onRouteChange = () => {
      lastRouteChangeAt = Date.now();
      scheduleResume("history");
    };

    addEventListener("popstate", onPopState);
    addEventListener("ttdff-route-change", onRouteChange);
    cleanupCallbacks.push(() => removeEventListener("popstate", onPopState));
    cleanupCallbacks.push(() => removeEventListener("ttdff-route-change", onRouteChange));

    const wrap = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("ttdff-route-change"));
        return result;
      };
      try {
        history[name] = wrapped;
        cleanupCallbacks.push(() => {
          try {
            if (history[name] === wrapped) history[name] = original;
          } catch (_) {}
        });
      } catch (_) {}
    };
    wrap("pushState");
    wrap("replaceState");
  }

  function mutationBelongsToOverlay(mutation) {
    const target = mutation.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target?.parentElement;
    if (target?.closest?.(`#${OVERLAY_ID}`) || target?.closest?.(`#${PROMPT_ID}`)) return true;

    const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    return nodes.length > 0 && nodes.every((node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return element?.id === OVERLAY_ID || element?.closest?.(`#${OVERLAY_ID}`) || element?.id === PROMPT_ID || element?.closest?.(`#${PROMPT_ID}`);
    });
  }

  function installObserver() {
    if (!document.documentElement || observer) return;
    observer = new MutationObserver((mutations) => {
      if (shuttingDown) return;
      // Updating our own UI must not wake the state machine.
      if (mutations.length && mutations.every(mutationBelongsToOverlay)) return;
      lastDomChangeAt = Date.now();
      scheduleResume("dom");
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function installSanityWatcher() {
    if (sanityTimer) return;
    let lastFingerprint = "";
    sanityTimer = setInterval(async () => {
      if (shuttingDown) return;
      const currentUrl = location.href;
      if (currentUrl !== lastSeenUrl) {
        lastSeenUrl = currentUrl;
        lastRouteChangeAt = Date.now();
        scheduleResume("url-watch");
      }

      // This is local DOM/state checking only. It does not refresh the page or call TTD.
      // It catches Next.js transitions that do not produce a useful URL or mutation signal.
      let active = false;
      try { active = Boolean((await getRun())?.active); } catch (_) { active = false; }
      if (!active) return;
      const page = detectPage();
      const countdown = page === "countdown" ? detectCountdown() : null;
      const fingerprint = `${currentUrl}|${page}|${countdown?.formatted || ""}`;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        scheduleResume("sanity");
      }
    }, 900);
  }

  function connectionSnapshot() {
    const countdown = detectCountdown();
    return {
      ok: true,
      version: FASTFILL_VERSION,
      page: detectPage(),
      url: location.href,
      countdown: countdown ? { text: countdown.text, formatted: countdown.formatted, seconds: countdown.seconds } : null,
      watchers: {
        dom: Boolean(observer),
        url: Boolean(sanityTimer),
        runtimeStarted,
      },
    };
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === "TTDFF_PING") {
      sendResponse(connectionSnapshot());
      return true;
    }
    if (message?.type === "TTDFF_START") {
      scheduleResume("popup");
      sendResponse(connectionSnapshot());
      return true;
    }
    if (message?.type === "TTDFF_STATUS") {
      sendResponse(connectionSnapshot());
      return true;
    }
    if (message?.type === "TTDFF_INSPECT") {
      const snapshot = connectionSnapshot();
      sendResponse({ ...snapshot, report: buildInspectorReport() });
      return true;
    }
    if (message?.type === "TTDFF_REDETECT") {
      scheduleResume("manual-redetect");
      sendResponse(connectionSnapshot());
      return true;
    }
    if (message?.type === "TTDFF_SHUTDOWN") {
      sendResponse({ ok: true, version: FASTFILL_VERSION });
      setTimeout(() => shutdownRuntime("message"), 0);
      return true;
    }
    return false;
  };

  function shutdownRuntime(reason = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(routeTimer);
    clearInterval(sanityTimer);
    clearInterval(rootWaitTimer);
    routeTimer = null;
    sanityTimer = null;
    rootWaitTimer = null;
    try { observer?.disconnect(); } catch (_) {}
    observer = null;
    for (const cleanup of cleanupCallbacks.splice(0)) {
      try { cleanup(); } catch (_) {}
    }
    try { chrome.runtime.onMessage.removeListener(messageListener); } catch (_) {}
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(PROMPT_ID)?.remove();
    const instance = globalThis[INSTANCE_KEY];
    if (instance?.version === FASTFILL_VERSION) instance.alive = false;
    log("shutdown", reason);
  }

  function startRuntime() {
    if (runtimeStarted || shuttingDown || !document.documentElement) return;
    runtimeStarted = true;
    installRouteHooks();
    installObserver();
    installSanityWatcher();
    scheduleResume("initial");
  }

  globalThis[INSTANCE_KEY] = {
    version: FASTFILL_VERSION,
    alive: true,
    shutdown: shutdownRuntime,
    redetect: (source = "external") => scheduleResume(source),
  };

  try { chrome.runtime.onMessage.addListener(messageListener); } catch (error) { log("message-listener-error", error); }

  if (document.documentElement) {
    startRuntime();
  } else {
    rootWaitTimer = setInterval(() => {
      if (document.documentElement) {
        clearInterval(rootWaitTimer);
        rootWaitTimer = null;
        startRuntime();
      }
    }, 10);
  }

  const onDomReady = () => startRuntime();
  document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
  cleanupCallbacks.push(() => document.removeEventListener("DOMContentLoaded", onDomReady));

})();
