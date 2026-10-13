// Money AI proxy v2. Paste into Cloudflare Worker "money-ai" (Edit code), then Deploy.
// Secret required: GEMINI_API_KEY. Optional plain variable: ALLOWED_ORIGIN (your app origin, e.g. https://money.arnob428.workers.dev)
// Routes: POST /  (AI),  GET /fx (daily exchange rates, cached),  GET /geo (country/city from IP, fallback only)

const MODEL = "gemini-3.5-flash-lite"; // free tier. If you see "model no longer available", try "gemini-3.8-flash"
const MAX_PROMPT_CHARS = 8000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (allowed !== "*" && origin !== allowed) return json({ error: "Origin not allowed" }, 403, cors);

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/geo") {
      const cf = request.cf || {};
      return json({ country: cf.country || "", city: cf.city || "", timezone: cf.timezone || "" }, 200, cors);
    }

    if (request.method === "GET" && url.pathname === "/fx") {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!r.ok) return json({ error: "Rates unavailable" }, 502, cors);
      const d = await r.json();
      return json({ rates: d.rates || {}, updated: d.time_last_update_utc || "" }, 200, { ...cors, "Cache-Control": "public, max-age=3600" });
    }

    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "Secret GEMINI_API_KEY is missing" }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
    const prompt = String(body.prompt || "").slice(0, MAX_PROMPT_CHARS);
    if (!prompt) return json({ error: "Empty prompt" }, 400, cors);

    const system = {
      parse: "You parse short personal expense or income sentences into JSON: {amount, wallet, category, note, tags}. Use the currency and location from the context. Reply with JSON only.",
      coach: "You are a calm, practical money coach for one person. Use only the numbers and location given. Plain language, short. Planning aid, not financial advice.",
      plan: "You build monthly, weekly and daily budget guidance for one person based on their location, goals and numbers in the context. Suggest where to buy (local store types, markets, delivery), what and when, and mark prices as estimates to verify. Planning aid, not financial advice.",
      pack: "You describe typical personal-finance setup for a country. Reply with JSON only: {\"stores\":\"comma separated common grocery store types and chains\",\"save\":[\"Name: one-line description\"],\"cycle\":\"monthly or biweekly\"}. No numbers that change often. Planning aid only.",
      scout: "You summarise savings and deposit options in the user's country. Give each option with a source or where to verify it, and flag everything as verify. Planning aid, not financial advice.",
      chat: "You answer questions about the user's own money using only the anonymised totals provided.",
    }[body.task] || "You are a helpful money assistant.";

    const req = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };
    if (body.task === "scout" && env.GROUNDING === "on") req.tools = [{ google_search: {} }]; // paid tier only
    if (body.task === "parse" || body.task === "pack") req.generationConfig = { responseMimeType: "application/json" };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(req),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data.error?.message || "Gemini error" }, res.status, cors);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    return json({ text }, 200, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
