// One place that talks to the language model.
// LLM_PROVIDER: openrouter, groq, gemini or ollama. LLM_FALLBACK (optional): a second provider used when the
// first one fails, for example LLM_PROVIDER=groq with LLM_FALLBACK=gemini.
// GROQ_MODEL (default openai/gpt-oss-120b), GROQ_VISION_MODEL (default qwen/qwen3.8-27b, used when
// report images are sent), GEMINI_MODEL (default gemma-4-31b-it), OLLAMA_MODEL,
// OPENROUTER_MODEL (default google/gemma-4-31b-it). OPENROUTER_DATA=deny (default) sends requests
// only to hosts that do not keep or train on prompts. OPENROUTER_ZDR=true is stricter still.
const axios = require("axios");

const PROVIDER = (
    process.env.LLM_PROVIDER ||
    (process.env.GEMINI_API_KEY
        ? "gemini"
        : process.env.GROQ_API_KEY
          ? "groq"
          : "ollama")
).toLowerCase();
const FALLBACK = (process.env.LLM_FALLBACK || "").toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemma-4-31b-it";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL =
    process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it";
const OR_FREE = /:free$/i.test(OPENROUTER_MODEL);
// Free endpoints are served by hosts that may train on prompts, so "deny" would leave none
const OPENROUTER_DATA = (
    process.env.OPENROUTER_DATA || (OR_FREE ? "allow" : "deny")
).toLowerCase();
const OPENROUTER_ZDR = /^(1|true|yes)$/i.test(process.env.OPENROUTER_ZDR || "");
// Which host to prefer: throughput (fastest writing, default), latency or price
const OPENROUTER_SORT = (
    process.env.OPENROUTER_SORT || "throughput"
).toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base64 images carry no type, so read it from the first bytes
function mimeOf(b64) {
    const s = String(b64 || "").slice(0, 16);
    if (s.startsWith("/9j/")) return "image/jpeg";
    if (s.startsWith("iVBOR")) return "image/png";
    if (s.startsWith("UklGR")) return "image/webp";
    if (s.startsWith("R0lGOD")) return "image/gif";
    return "image/jpeg";
}

// Gemini's own JSON mode. Gemma models on the Gemini API may not accept it, so it is only
// used for gemini-* models. The prompts already ask for JSON either way.
const supportsJsonMode = (model) => /^gemini-/i.test(model);

async function geminiGenerate(
    prompt,
    { images = [], json = false, temperature, timeout },
) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    const parts = [
        ...images.map((b64) => ({
            inline_data: { mime_type: mimeOf(b64), data: b64 },
        })),
        { text: prompt },
    ];
    const generationConfig = {};
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (json && supportsJsonMode(GEMINI_MODEL))
        generationConfig.responseMimeType = "application/json";

    // 429 (rate limit) and 500/502/503/504 (Google's side failing) usually pass quickly.
    // Wait and try again, up to 3 tries in all.
    const TRIES = 3;
    for (let attempt = 0; attempt < TRIES; attempt++) {
        try {
            const r = await axios.post(
                `${GEMINI_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
                { contents: [{ role: "user", parts }], generationConfig },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": key,
                    },
                    timeout,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                },
            );
            const cand = r.data?.candidates?.[0];
            const text = (cand?.content?.parts || [])
                .filter((p) => typeof p.text === "string" && !p.thought) // skip any thinking
                .map((p) => p.text)
                .join("");
            if (!text) {
                const why =
                    cand?.finishReason ||
                    r.data?.promptFeedback?.blockReason ||
                    "empty reply";
                throw new Error(`Model gave no text (${why})`);
            }
            return text;
        } catch (err) {
            const status = err.response?.status;
            const last = attempt === TRIES - 1;
            if (status === 429 && !last) {
                const retry = (err.response?.data?.error?.details || []).find(
                    (d) => d.retryDelay,
                )?.retryDelay; // like "17s"
                const ms = Math.min((parseFloat(retry) || 5) * 1000, 30000);
                console.log(
                    `⚠️ Gemini rate limit. Waiting ${Math.round(ms / 1000)} s`,
                );
                await sleep(ms);
                continue;
            }
            if ([500, 502, 503, 504].includes(status) && !last) {
                const ms = [2000, 5000][attempt] || 5000;
                console.log(
                    `⚠️ Gemini ${status}. Trying again in ${ms / 1000} s`,
                );
                await sleep(ms);
                continue;
            }
            const msg = err.response?.data?.error?.message;
            if (msg) err.message = `Gemini ${status}: ${msg}`;
            throw err;
        }
    }
    throw new Error("Gemini kept failing");
}

async function ollamaGenerate(
    prompt,
    { images = [], json = false, temperature, timeout },
) {
    const payload = { model: OLLAMA_MODEL, prompt, stream: false };
    if (images.length) payload.images = images;
    if (temperature !== undefined) payload.options = { temperature };
    if (json) payload.format = "json";
    const r = await axios.post("https://ollama.com/api/generate", payload, {
        headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
        timeout,
    });
    return String(r.data?.response || "");
}

// Reasoning models may put their thinking in <think> tags. Only the answer is wanted.
const stripThinking = (s) =>
    String(s || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();

async function groqGenerate(prompt, { images = [], temperature, timeout }) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set");
    const vision = images.length > 0;
    const model = vision ? GROQ_VISION_MODEL : GROQ_MODEL;
    const content = vision
        ? [
              { type: "text", text: prompt },
              ...images.map((b64) => ({
                  type: "image_url",
                  image_url: { url: `data:${mimeOf(b64)};base64,${b64}` },
              })),
          ]
        : prompt;
    const body = { model, messages: [{ role: "user", content }] };
    if (temperature !== undefined) body.temperature = temperature;
    // Keep the model's thinking out of the answer
    if (/gpt-oss/i.test(model)) body.include_reasoning = false;
    else body.reasoning_format = "hidden";

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await axios.post(GROQ_URL, body, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                },
                timeout,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            const text = stripThinking(r.data?.choices?.[0]?.message?.content);
            if (!text) throw new Error("Groq gave no text");
            return text;
        } catch (err) {
            const status = err.response?.status;
            const msg = err.response?.data?.error?.message;
            // 429 with a short wait: wait and try once more. A long wait or a request that is
            // too big for the free limits (413, or 429 about tokens) goes to the fallback instead.
            const wait = parseFloat(err.response?.headers?.["retry-after"]);
            if (
                attempt === 0 &&
                (status === 429 || status >= 500) &&
                !/too large|tokens per/i.test(msg || "") &&
                (status !== 429 || (wait || 3) <= 15)
            ) {
                const ms = status === 429 ? (wait || 3) * 1000 : 2000;
                console.log(
                    `⚠️ Groq ${status}. Trying again in ${Math.round(ms / 1000)} s`,
                );
                await sleep(ms);
                continue;
            }
            if (msg) err.message = `Groq ${status}: ${msg}`;
            throw err;
        }
    }
    throw new Error("Groq kept failing");
}

async function openrouterGenerate(
    prompt,
    { images = [], temperature, timeout },
) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    const content = images.length
        ? [
              { type: "text", text: prompt },
              ...images.map((b64) => ({
                  type: "image_url",
                  image_url: { url: `data:${mimeOf(b64)};base64,${b64}` },
              })),
          ]
        : prompt;
    const body = {
        model: OPENROUTER_MODEL,
        messages: [{ role: "user", content }],
        provider: {
            data_collection: OPENROUTER_DATA,
            ...(OPENROUTER_ZDR ? { zdr: true } : {}),
            ...(OPENROUTER_SORT !== "none" ? { sort: OPENROUTER_SORT } : {}),
        },
        // No thinking step: it adds a lot of time and the prompts do not need it.
        // ("exclude" alone only hides the thinking; the model still does it.)
        reasoning: { effort: "none" },
    };
    if (temperature !== undefined) body.temperature = temperature;

    const TRIES = 3;
    for (let attempt = 0; attempt < TRIES; attempt++) {
        let status;
        let msg;
        try {
            const t0 = Date.now();
            const r = await axios.post(OPENROUTER_URL, body, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    "X-Title": "OneMD Scribe",
                },
                timeout,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            // OpenRouter can report a host failure inside a 200 reply
            const e = r.data?.error || r.data?.choices?.[0]?.error;
            if (e) {
                status = Number(e.code) || 502;
                msg = e.message || "host error";
            } else {
                const text = stripThinking(
                    r.data?.choices?.[0]?.message?.content,
                );
                const u = r.data?.usage || {};
                const think = u.completion_tokens_details?.reasoning_tokens;
                console.log(
                    `🤖 ${((Date.now() - t0) / 1000).toFixed(1)} s · ${r.data?.provider || "?"} · in ${u.prompt_tokens ?? "?"} · out ${u.completion_tokens ?? "?"}${think ? ` (thinking ${think})` : ""}${images.length ? ` · ${images.length} image(s)` : ""}`,
                );
                if (text) return text;
                status = 502;
                msg = `no text (${r.data?.choices?.[0]?.finish_reason || "empty reply"})`;
            }
        } catch (err) {
            status = err.response?.status;
            msg = err.response?.data?.error?.message || err.message;
            if (!status) throw err; // network error or timeout: let the caller decide
            // A model that must think rejects effort "none". Let it think and try again.
            if (status === 400 && body.reasoning && /reason/i.test(msg)) {
                delete body.reasoning;
                attempt--;
                continue;
            }
        }
        const last = attempt === TRIES - 1;
        if ((status === 429 || status >= 500) && !last) {
            const ms = status === 429 ? 5000 : [2000, 5000][attempt] || 5000;
            console.log(
                `⚠️ OpenRouter ${status}. Trying again in ${ms / 1000} s`,
            );
            await sleep(ms);
            continue;
        }
        throw new Error(`OpenRouter ${status}: ${msg}`);
    }
    throw new Error("OpenRouter kept failing");
}

const RUN = {
    openrouter: openrouterGenerate,
    groq: groqGenerate,
    gemini: geminiGenerate,
    ollama: ollamaGenerate,
};
const label = (p) =>
    p === "openrouter"
        ? `OpenRouter ${OPENROUTER_MODEL} (data: ${OPENROUTER_DATA}${OPENROUTER_ZDR ? ", ZDR" : ""}, fastest by ${OPENROUTER_SORT})`
        : p === "groq"
          ? `Groq ${GROQ_MODEL} (images: ${GROQ_VISION_MODEL})`
          : p === "gemini"
            ? `Gemini API ${GEMINI_MODEL}`
            : `Ollama ${OLLAMA_MODEL}`;

// Returns the model's text. Throws on failure, so callers keep their own retry and fallback.
// opts: { images: [base64], json: true to ask for strict JSON, temperature, timeout (ms) }
async function generate(prompt, opts = {}) {
    const o = { timeout: 120000, ...opts };
    try {
        return await RUN[PROVIDER](prompt, o);
    } catch (err) {
        if (!FALLBACK || FALLBACK === PROVIDER || !RUN[FALLBACK]) throw err;
        console.log(
            `⚠️ ${PROVIDER} failed (${err.message}). Using ${FALLBACK}`,
        );
        return RUN[FALLBACK](prompt, o);
    }
}

if (!RUN[PROVIDER]) throw new Error(`Unknown LLM_PROVIDER: ${PROVIDER}`);
if ([PROVIDER, FALLBACK].includes("openrouter") && OR_FREE)
    console.log(
        "⚠️ OpenRouter free model: served by Google AI Studio's free tier, which may use prompts to improve its products. Do not send real patient data.",
    );
console.log(
    `🤖 Language model: ${label(PROVIDER)}${FALLBACK && RUN[FALLBACK] && FALLBACK !== PROVIDER ? `, fallback ${label(FALLBACK)}` : ""}`,
);

module.exports = { generate, PROVIDER };
