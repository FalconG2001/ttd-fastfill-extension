const configureSessionStorage = async () => {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    }
  } catch (error) {
    console.warn("TTD FastFill: could not expose session storage to content script", error);
  }
};

configureSessionStorage();
chrome.runtime.onInstalled.addListener(configureSessionStorage);
chrome.runtime.onStartup.addListener(configureSessionStorage);

function stripJsonFence(text) {
  return String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function analyzeFieldWithGemini({ apiKey, model, field }) {
  if (!apiKey) throw new Error("Gemini API key is missing");
  const safeModel = String(model || "gemini-2.5-flash-lite").replace(/[^A-Za-z0-9._-]/g, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    "You are identifying one web-form field for a browser autofill extension.",
    "Return JSON only with keys: canonicalField, controlType, confidence, explanation.",
    "canonicalField must be a short semantic key such as gothram, email, city, state, country, pincode, relationship, nationality, address, unknown.",
    "Do NOT infer, invent, or suggest a value for the user.",
    "Use only this sanitized field metadata:",
    JSON.stringify(field),
  ].join("\n");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 180)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const parsed = JSON.parse(stripJsonFence(text));
  return {
    canonicalField: String(parsed.canonicalField || "unknown").trim().toLowerCase(),
    controlType: String(parsed.controlType || field.controlType || "unknown"),
    confidence: Number(parsed.confidence || 0),
    explanation: String(parsed.explanation || ""),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TTDFF_GEMINI_ANALYZE") return false;
  analyzeFieldWithGemini(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
