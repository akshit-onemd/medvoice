const express = require("express");
const { randomUUID } = require("crypto");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const { pdf } = require("pdf-to-img");
const app = express();
const path = require("path");
require("dotenv").config();
const FormData = require("form-data");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
const { clerkMiddleware, getAuth } = require("@clerk/express");
const createTerminology = require("./terminology");
// CORS (must allow Authorization + handle preflight)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // ideally your frontend URL
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});
app.get("/health", (req, res) => res.json({ ok: true }));
// Attach Clerk session info to every request
app.use(clerkMiddleware());

// Reject anything without a valid signed-in user
app.use(async (req, res, next) => {
    const { userId } = getAuth(req);
    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    try {
        const doctorId = await lookupDoctorForStaff(userId);
        req.actorId = userId; // who is really signed in
        req.role = doctorId ? "staff" : "doctor";
        req.userId = doctorId || userId; // owner scope used by every existing filter
        next();
    } catch (err) {
        console.log("⚠️ Role lookup failed:", err.message);
        res.status(503).json({ error: "Please try again" });
    }
});

// Staff may only use these routes. Everything else is denied by default.
const STAFF_ALLOWED = [
    ["GET", /^\/me$/],
    ["GET", /^\/patients\/search$/],
    ["POST", /^\/patients$/],
    ["PUT", /^\/patients\/[0-9a-f-]{36}$/i],
    ["GET", /^\/patients$/],
    ["GET", /^\/rate-card$/],
    ["GET", /^\/patients\/[0-9a-f-]{36}\/pending-services$/i],
    ["PUT", /^\/patients\/[0-9a-f-]{36}\/pending-services$/i],
];
app.use((req, res, next) => {
    if (req.role !== "staff") return next();
    const ok = STAFF_ALLOWED.some(
        ([m, re]) => m === req.method && re.test(req.path),
    );
    if (!ok)
        return res
            .status(403)
            .json({ error: "Not available for staff accounts" });
    next();
});
app.use(express.json({ limit: "2mb" }));
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const staffCache = new Map(); // staffUserId -> { doctorId | null, at }
const STAFF_TTL = 60 * 1000;
const createBrands = require("./brands");
const brands = createBrands({ supabase, llmJson });
async function lookupDoctorForStaff(userId) {
    const hit = staffCache.get(userId);
    if (hit && Date.now() - hit.at < STAFF_TTL) return hit.doctorId;
    const { data, error } = await supabase
        .from("staff_links")
        .select("doctor_id")
        .eq("staff_user_id", userId)
        .maybeSingle();
    if (error) throw error;
    const doctorId = data?.doctor_id || null;
    staffCache.set(userId, { doctorId, at: Date.now() });
    return doctorId;
}
const upload = multer({
    dest: "uploads/",
});
const UMLS_API_KEY = process.env.UMLS_API_KEY;
const UTS_BASE_URL = "https://uts-ws.nlm.nih.gov/rest";

// Maps each JSON field name to its UMLS source vocabulary abbreviation (SAB).

// In-memory cache so repeated codes (fixed vitals LOINC codes, common
// conditions across patients) don't re-hit UMLS every single request.
async function attachmentToImages(file) {
    if (file.mimetype.startsWith("image/")) {
        return [fs.readFileSync(file.path).toString("base64")];
    }
    if (file.mimetype === "application/pdf") {
        const images = [];
        const doc = await pdf(file.path, { scale: 2 });
        for await (const page of doc) {
            images.push(page.toString("base64"));
        }
        return images;
    }
    console.log(
        `⚠️ Unsupported attachment type: ${file.mimetype} (${file.originalname})`,
    );
    return [];
}
async function transcribeWithGroq(filePath, originalName, mimetype) {
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), {
        filename: originalName || "audio.mp3",
        contentType: mimetype || "audio/mpeg",
    });
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");

    const response = await axios.post(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        form,
        {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
        },
    );

    return {
        transcript: response.data.text || "",
        language: response.data.language || "unknown",
    };
}
const { SarvamAIClient } = require("sarvamai");
const sarvamClient = new SarvamAIClient({
    apiSubscriptionKey: process.env.SARVAM_API_KEY,
});
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const elevenlabsClient = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});
async function transcribeWithSarvam(filePath) {
    console.log("📤 Creating Sarvam batch job...");
    const job = await sarvamClient.speechToTextJob.createJob({
        model: "saaras:v4",
        mode: "transcribe",
    });

    console.log("🆔 Sarvam job ID:", job.jobId || job.job_id);

    console.log("📤 Uploading audio to Sarvam...");
    await job.uploadFiles([filePath]);

    console.log("▶️ Starting job...");
    await job.start();

    console.log("⏳ Waiting for Sarvam to finish...");
    await job.waitUntilComplete();

    console.log("📋 Checking file results...");
    const fileResults = await job.getFileResults();

    if (fileResults.successful.length === 0) {
        const failure = fileResults.failed[0];
        throw new Error(
            `Sarvam transcription failed: ${failure?.error_message || "unknown error"}`,
        );
    }

    const jobId = job.jobId || job.job_id;
    const outputDir = path.join("sarvam-outputs", jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    console.log("📥 Downloading outputs...");
    await job.downloadOutputs(outputDir);

    const outputFiles = fs
        .readdirSync(outputDir)
        .filter((f) => f.endsWith(".json"));
    if (outputFiles.length === 0) {
        throw new Error("Sarvam downloadOutputs() produced no output files");
    }

    const result = JSON.parse(
        fs.readFileSync(path.join(outputDir, outputFiles[0]), "utf-8"),
    );
    console.log("Sarvam result:", result);

    fs.rm(outputDir, { recursive: true, force: true }, () => {});

    return {
        transcript: result.transcript || "",
        language: result.language_code || "unknown",
    };
}
function buildDiarizedTranscript(words) {
    if (!Array.isArray(words) || words.length === 0) return "";

    const turns = [];
    let current = null;

    for (const w of words) {
        if (w.type === "spacing") continue; // skip whitespace tokens

        const speaker = w.speakerId || "unknown";
        if (!current || current.speaker !== speaker) {
            current = { speaker, text: "" };
            turns.push(current);
        }
        current.text += (current.text ? " " : "") + w.text;
    }

    return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}
async function transcribeWithElevenLabs(filePath, originalName, mimetype) {
    const fileBuffer = fs.readFileSync(filePath);
    const audioBlob = new Blob([fileBuffer], {
        type: mimetype || "audio/mpeg",
    });

    const result = await elevenlabsClient.speechToText.convert({
        file: audioBlob,
        modelId: "scribe_v2_medical",
        diarize: true,
    });

    return {
        transcript: result.text || "",
        language: result.languageCode || "unknown",
        diarizedTranscript: buildDiarizedTranscript(result.words),
        words: result.words || [],
    };
}
async function llmJson(prompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const payload = {
                model: "gemma4:31b-cloud",
                prompt,
                stream: false,
                options: { temperature: 0 }, // same input, same answer
            };
            if (attempt > 0) payload.format = "json"; // unconfirmed for this model. Delete if it causes a 400.
            const r = await axios.post(
                "https://ollama.com/api/generate",
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                    },
                    timeout: 90000,
                },
            );
            const obj = parseModelJson(r.data?.response);
            if (obj) return obj;
        } catch (err) {
            console.log(
                `⚠️ Model call ${attempt + 1} failed:`,
                err.response?.status || err.message,
            );
        }
    }
    return null;
}

const terminology = createTerminology({
    axios,
    apiKey: process.env.UMLS_API_KEY,
    llmJson,
});

const FIELD_VOCAB = {
    snomed_ct_code: "snomed",
    icd10_code: "icd10",
    rxnorm_code: "rxnorm",
    loinc_code: "loinc",
    interpretation_snomed_code: "snomed",
};
const FIELD_KIND = {
    rxnorm_code: "drug",
    loinc_code: "lab",
    interpretation_snomed_code: "interpretation",
};

function termForField(entry, key) {
    if (key === "loinc_code")
        return entry.investigation_name || entry.name || null;
    if (key === "interpretation_snomed_code")
        return entry.interpretation || null;
    return entry.name || null;
}

const verifiedFlag = (status) =>
    status === "verified" ? true : status === "review" ? null : false;

function applyResult(target, key, res) {
    target[key] = res.code || "";
    target[`${key}_verified`] = verifiedFlag(res.status);
    target[`${key}_corrected`] = false;
    target[`${key}_umls_term`] = res.term || null;
    target[`${key}_status`] = res.status;
    target[`${key}_alts`] = res.alts || [];
    if (key === "snomed_ct_code" && "snomed_ct_term" in target)
        target.snomed_ct_term = res.term || "";
}

// The model's own codes are ignored. Every code is looked up from the name.
async function verifyEntry(entry, kind = "condition") {
    if (!entry || typeof entry !== "object") return;
    if ("icd10_pcs_code" in entry) entry.icd10_pcs_code = ""; // not coded
    for (const key of Object.keys(FIELD_VOCAB)) {
        if (!(key in entry)) continue;
        const term = termForField(entry, key);
        if (!term) {
            entry[key] = "";
            continue;
        }
        applyResult(
            entry,
            key,
            await terminology.resolve(
                FIELD_VOCAB[key],
                term,
                FIELD_KIND[key] || kind,
            ),
        );
    }
}

async function verifyFamilyIllness(entry) {
    if (!Array.isArray(entry.illness)) return;
    const s = [];
    const i = [];
    for (const term of entry.illness) {
        s.push(await terminology.resolve("snomed", term, "disorder"));
        i.push(await terminology.resolve("icd10", term, "disorder"));
    }
    const put = (key, list) => {
        entry[key] = list.map((r) => r.code || "");
        entry[`${key}_verified`] = list.map((r) => verifiedFlag(r.status));
        entry[`${key}_corrected`] = list.map(() => false);
        entry[`${key}_status`] = list.map((r) => r.status);
        entry[`${key}_alts`] = list.map((r) => r.alts || []);
        entry[`${key}_terms`] = list.map((r) => r.term || "");
    };
    put("snomed_ct_codes", s);
    put("icd10_codes", i);
}

async function verifyFindings(findings) {
    if (!Array.isArray(findings)) return;
    for (const f of findings) {
        if (!f?.finding) {
            if (f) f.snomed_ct_code = "";
            continue;
        }
        applyResult(
            f,
            "snomed_ct_code",
            await terminology.resolve("snomed", f.finding, "finding"),
        );
    }
}

const KIND_BY_SECTION = {
    allergies: "allergy",
    conditions: "condition",
    procedures: "procedure",
    lifestyle_habits: "lifestyle",
    social_history: "social",
    medication_history: "drug",
};
const KIND_BY_RX = {
    symptoms: "symptom",
    medications: "drug",
    diagnosis: "diagnosis",
};

async function verifyAllCodes(data) {
    for (const [sectionName, section] of Object.entries(data)) {
        if (
            ["vitals", "consultation_summary", "suggested_plan"].includes(
                sectionName,
            )
        )
            continue;

        if (sectionName === "family_history") {
            for (const entry of Array.isArray(section) ? section : [])
                await verifyFamilyIllness(entry);
            continue;
        }
        if (
            sectionName === "prescription" &&
            section &&
            typeof section === "object"
        ) {
            for (const [sub, list] of Object.entries(section)) {
                if (!Array.isArray(list)) continue;
                for (const entry of list)
                    await verifyEntry(entry, KIND_BY_RX[sub] || "condition");
            }
            continue;
        }
        if (!Array.isArray(section)) continue;
        const kind = KIND_BY_SECTION[sectionName] || "condition";
        for (const entry of section) {
            await verifyEntry(entry, kind);
            if (Array.isArray(entry?.readings))
                for (const r of entry.readings) await verifyEntry(r, "lab");
            if (Array.isArray(entry?.findings))
                await verifyFindings(entry.findings);
        }
    }
    return data;
}

// Every (vocabulary, term) the record needs, so lookups run together
function codeJobs(sd) {
    const jobs = [];
    const list = (v) => (Array.isArray(v) ? v : []);
    const add = (vocab, text, kind) =>
        text && jobs.push({ vocab, text: String(text), kind });
    const both = (text, kind) => {
        add("snomed", text, kind);
        add("icd10", text, kind);
    };
    list(sd.allergies).forEach((e) => both(e?.name, "allergy"));
    list(sd.conditions).forEach((e) => both(e?.name, "condition"));
    list(sd.procedures).forEach((e) => add("snomed", e?.name, "procedure"));
    list(sd.lifestyle_habits).forEach((e) =>
        add("snomed", e?.name, "lifestyle"),
    );
    list(sd.social_history).forEach((e) => add("snomed", e?.name, "social"));
    list(sd.medication_history).forEach((e) => add("rxnorm", e?.name, "drug"));
    list(sd.family_history).forEach((e) =>
        list(e?.illness).forEach((t) => both(t, "disorder")),
    );
    list(sd.system_review).forEach((e) =>
        list(e?.findings).forEach((f) =>
            add("snomed", typeof f === "string" ? f : f?.finding, "finding"),
        ),
    );
    list(sd.investigation_history).forEach((inv) =>
        list(inv?.readings).forEach((r) => {
            add("loinc", r?.investigation_name, "lab");
            add("snomed", r?.interpretation, "interpretation");
        }),
    );
    const rx = sd.prescription || {};
    list(rx.symptoms).forEach((e) => add("snomed", e?.name, "symptom"));
    list(rx.medications).forEach((e) => add("rxnorm", e?.name, "drug"));
    list(rx.diagnosis).forEach((e) => both(e?.name, "diagnosis"));
    return jobs;
}
const warmCodes = (sd) => terminology.warm(codeJobs(sd));
async function regeneratePatientSummary(patientId) {
    const { data, error } = await supabase
        .from("consultations")
        .select("created_at, structured_data")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: true });
    if (error) throw error;

    const summaries = data
        .map((c) => ({
            date: c.created_at,
            summary: c.structured_data?.consultation_summary?.details,
        }))
        .filter((s) => Array.isArray(s.summary) && s.summary.length > 0);
    let patientSummary = { overview: "", details: [] };

    if (summaries.length > 0) {
        const formatted = summaries
            .map(
                (s) =>
                    `[${new Date(s.date).toISOString().slice(0, 10)}]\n${s.summary
                        .map((l) => `- ${l}`)
                        .join("\n")}`,
            )
            .join("\n\n");

        let prompt = fs.readFileSync("patient-summary-prompt.md", "utf-8");
        prompt = prompt.replace("{{consultation_summaries}}", formatted);

        try {
            const ollamaResponse = await axios.post(
                "https://ollama.com/api/generate",
                { model: "gemma4:31b-cloud", prompt, stream: false },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                    },
                },
            );
            let rawResponse = ollamaResponse.data.response.trim();
            rawResponse = rawResponse
                .replace(/```json/g, "")
                .replace(/```/g, "")
                .trim();
            const parsed = JSON.parse(rawResponse);
            patientSummary = {
                overview:
                    typeof parsed.overview === "string" ? parsed.overview : "",
                details: Array.isArray(parsed.details)
                    ? parsed.details
                    : summaries[summaries.length - 1].summary, // fallback: most recent visit's shorthand
            };
        } catch (err) {
            console.log(
                "⚠️ Patient summary LLM call failed, using latest visit:",
                err.message,
            );
            patientSummary = {
                overview: "", // no plain-language line available without the LLM
                details: summaries[summaries.length - 1].summary,
            };
        }
    }

    const { error: updateError } = await supabase
        .from("patients")
        .update({
            patient_summary: patientSummary,
            patient_summary_updated_at: new Date().toISOString(),
        })
        .eq("id", patientId);
    if (updateError) throw updateError;

    return patientSummary;
}
function summarizeSectionForPrompt(sd) {
    const lines = [];
    const push = (label, text) => text && lines.push(`${label}: ${text}`);
    const j = (arr, f) =>
        Array.isArray(arr)
            ? arr
                  .map((e) => f(e))
                  .filter(Boolean)
                  .join("; ")
            : "";

    push(
        "Symptoms",
        j(sd.prescription?.symptoms, (e) => e.name),
    );
    push(
        "Vitals",
        j(sd.vitals, (v) =>
            v.value ? `${v.name} ${v.value}${v.units || ""}` : "",
        ),
    );
    push(
        "Allergies",
        j(sd.allergies, (e) => e.name),
    );
    push(
        "Conditions",
        j(sd.conditions, (e) => e.name),
    );
    push(
        "Medication history",
        j(
            sd.medication_history,
            (e) => `${e.name} ${e.dosage || ""} (${e.status || ""})`,
        ),
    );
    push(
        "Investigations",
        j(
            sd.investigation_history,
            (i) =>
                `${i.name}: ${j(i.readings, (r) => `${r.investigation_name} ${r.result || ""}${r.unit || ""} (${r.interpretation || ""})`)}`,
        ),
    );
    push(
        "Procedures",
        j(sd.procedures, (e) => `${e.name} (${e.date || ""})`),
    );
    push(
        "System review",
        j(
            sd.system_review,
            (e) => `${e.name}: ${j(e.findings, (f) => f.finding)}`,
        ),
    );
    push(
        "Family history",
        j(
            sd.family_history,
            (e) => `${e.relationship}: ${(e.illness || []).join(", ")}`,
        ),
    );
    push(
        "Lifestyle",
        j(sd.lifestyle_habits, (e) => e.name),
    );
    push(
        "Social history",
        j(sd.social_history, (e) => e.name),
    );
    push(
        "Other history",
        j(sd.other_history, (e) => e.name),
    );
    push(
        "Diagnosis",
        j(sd.prescription?.diagnosis, (e) => e.name),
    );
    push(
        "Medications prescribed",
        j(
            sd.prescription?.medications,
            (e) =>
                `${e.name} ${(e.dosage || []).join("-")} (${e.duration || ""})`,
        ),
    );
    push(
        "Follow up",
        j(
            sd.prescription?.followup,
            (e) =>
                `${e.next_visit_duration || e.date || ""}: ${e.advice || ""}`,
        ),
    );

    return lines.join("\n");
}

async function regenerateConsultationSummary(structuredData) {
    const record = summarizeSectionForPrompt(structuredData);
    if (!record.trim())
        return (
            structuredData.consultation_summary || { overview: "", details: [] }
        );

    let prompt = fs.readFileSync(
        "consultation-summary-refresh-prompt.md",
        "utf-8",
    );
    prompt = prompt.replace("{{record}}", record);

    try {
        const ollamaResponse = await axios.post(
            "https://ollama.com/api/generate",
            { model: "gemma4:31b-cloud", prompt, stream: false },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                },
            },
        );
        let raw = ollamaResponse.data.response
            .trim()
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        const parsed = JSON.parse(raw);
        return {
            overview:
                typeof parsed.overview === "string" ? parsed.overview : "",
            details: Array.isArray(parsed.details) ? parsed.details : [],
        };
    } catch (err) {
        console.log(
            "⚠️ Consultation summary regeneration failed, keeping previous summary:",
            err.message,
        );
        return (
            structuredData.consultation_summary || { overview: "", details: [] }
        );
    }
}
async function afterConsultationEdit(consultationId, sd) {
    const summary = await regenerateConsultationSummary(sd);
    const updated = { ...sd, consultation_summary: summary };

    const { error } = await supabase
        .from("consultations")
        .update({ structured_data: updated })
        .eq("id", consultationId);
    if (error) throw error;

    const { data: row } = await supabase
        .from("consultations")
        .select("patient_id")
        .eq("id", consultationId)
        .maybeSingle();
    if (row?.patient_id) {
        regeneratePatientSummary(row.patient_id).catch((err) =>
            console.log("⚠️ Patient summary regeneration failed:", err.message),
        );
    }

    return updated;
}
function parseModelJson(text) {
    const s = String(text || "")
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    try {
        const obj = JSON.parse(s.slice(a, b + 1));
        return obj && typeof obj === "object" && !Array.isArray(obj)
            ? obj
            : null;
    } catch {
        return null;
    }
}

const EXPECTED_KEYS = [
    "consultation_summary",
    "prescription",
    "conditions",
    "vitals",
    "allergies",
    "system_review",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// First try plus two retries. Throws if none gives usable JSON.
async function extractStructured(basePrompt, images) {
    const MAX_ATTEMPTS = 3;
    let lastErr = new Error("No attempt made");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const payload = {
                model: "gemma4:31b-cloud",
                prompt:
                    attempt === 0
                        ? basePrompt
                        : `${basePrompt}\n\nIMPORTANT: Your previous reply could not be read. Reply with exactly one valid JSON object that follows the template. No text before or after it.`,
                images,
                stream: false,
            };
            // Retries ask Ollama for strict JSON. I have not confirmed this model honors it.
            // If retries start failing with a 400, delete the next line.
            if (attempt > 0) payload.format = "json";

            const r = await axios.post(
                "https://ollama.com/api/generate",
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                    },
                    timeout: 180000,
                },
            );
            const obj = parseModelJson(r.data?.response);
            if (obj && EXPECTED_KEYS.some((k) => k in obj)) return obj;
            lastErr = new Error("The model reply was not usable JSON");
        } catch (err) {
            lastErr = err;
        }
        console.log(
            `⚠️ Summary attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`,
            lastErr.message,
        );
        if (attempt < MAX_ATTEMPTS - 1) await sleep(700 * (attempt + 1));
    }
    throw lastErr;
}
const HISTORY_LABELS = {
    diabetes: "Diabetes mellitus",
    hypertension: "Hypertension",
    hypothyroidism: "Hypothyroidism",
    alcohol: "Alcohol",
    tobacco: "Tobacco",
    smoke: "Smoking",
};

// Registration record as context. No name, phone or address.
function patientContext(p) {
    if (!p) return "";
    const lines = [];
    const age = ageFromDob(p.dob) ?? p.age;
    if (age != null) lines.push(`Age: ${age}`);
    if (p.gender) lines.push(`Gender: ${p.gender}`);
    if (p.occupation) lines.push(`Occupation: ${p.occupation}`);
    const m = p.medical && typeof p.medical === "object" ? p.medical : {};
    if (m.blood_group) lines.push(`Blood group: ${m.blood_group}`);
    if (m.no_known_history)
        lines.push("Reported no known medical history at registration");
    for (const [k, label] of Object.entries(HISTORY_LABELS)) {
        if (m[k]) lines.push(`${label}: ${m[k]}`);
    }
    return lines.join("\n");
}

function suggestionContext(sd) {
    const j = (arr, f) =>
        Array.isArray(arr) ? arr.map(f).filter(Boolean).join("; ") : "";
    const lines = [];
    const add = (label, text) => text && lines.push(`${label}: ${text}`);
    add(
        "Symptoms",
        j(sd.prescription?.symptoms, (e) => e?.name),
    );
    add(
        "Allergies noted in this visit",
        j(sd.allergies, (e) => e?.name),
    );
    add(
        "Known conditions",
        j(sd.conditions, (e) => e?.name),
    );
    add(
        "Current medicines",
        j(
            sd.medication_history,
            (e) => e?.name && `${e.name}${e.dosage ? ` ${e.dosage}` : ""}`,
        ),
    );
    add(
        "Vitals",
        j(sd.vitals, (v) => v?.value && `${v.name} ${v.value}${v.units || ""}`),
    );
    return lines.join("\n");
}

function cleanSuggestion(obj) {
    if (!obj || typeof obj !== "object") return null;
    const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
    const items = [];
    let n = 0;
    const nid = (k) => `${k}${++n}`;

    for (const m of list(obj.medications, 8)) {
        const name = pstr(m?.name, 120);
        if (!name) continue;
        const dosage = (Array.isArray(m?.dosage) ? m.dosage : [m?.dosage])
            .map((x) => pstr(x, 80))
            .filter(Boolean)
            .slice(0, 6);
        items.push({
            id: nid("m"),
            kind: "medication",
            name,
            dosage,
            duration: pstr(m?.duration, 60),
            instructions: pstr(m?.instructions, 200),
            rationale: pstr(m?.rationale, 200),
        });
    }
    for (const d of list(obj.diagnosis, 3)) {
        const name = pstr(d?.name, 120);
        if (name)
            items.push({
                id: nid("d"),
                kind: "diagnosis",
                name,
                rationale: pstr(d?.rationale, 200),
            });
    }
    for (const f of list(obj.followup, 1)) {
        const when = pstr(f?.next_visit_duration, 60);
        const advice = pstr(f?.advice, 300);
        if (when || advice) {
            items.push({
                id: nid("f"),
                kind: "followup",
                name: when || "Follow up",
                next_visit_duration: when,
                date: "",
                advice,
            });
        }
    }
    if (!items.length) return null;
    return {
        status: "pending",
        generated_at: new Date().toISOString(),
        items,
        note: pstr(obj.note, 300),
    };
}
// Returns a suggested plan or null. Never throws.
async function generateSuggestion({ transcript, patient, sd }) {
    try {
        if (!transcript || transcript.length < 40) return null;
        const ctx = [patientContext(patient), suggestionContext(sd || {})]
            .filter(Boolean)
            .join("\n");
        const base = fs
            .readFileSync("suggested-plan-prompt.md", "utf-8")
            .replace("{{patient_context}}", () => ctx || "None recorded")
            .replace("{{transcript}}", () => transcript);

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const payload = {
                    model: "gemma4:31b-cloud",
                    prompt:
                        attempt === 0
                            ? base
                            : `${base}\n\nIMPORTANT: Your previous reply could not be read. Reply with exactly one valid JSON object. Nothing else.`,
                    stream: false,
                };
                if (attempt > 0) payload.format = "json"; // unconfirmed for this model. Delete if it causes a 400.
                const r = await axios.post(
                    "https://ollama.com/api/generate",
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                        },
                        timeout: 90000,
                    },
                );
                const plan = cleanSuggestion(parseModelJson(r.data?.response));
                if (plan) return plan;
            } catch (err) {
                console.log(
                    `⚠️ Suggestion attempt ${attempt + 1} failed:`,
                    err.message,
                );
            }
        }
        return null;
    } catch (err) {
        console.log("⚠️ Suggestion failed:", err.message);
        return null;
    }
}
app.post(
    "/process-audio",
    upload.fields([
        { name: "file", maxCount: 1 },
        { name: "attachments", maxCount: 20 },
    ]),
    async (req, res) => {
        const startTime = Date.now();
        const audioFile = req.files?.file?.[0];
        const attachmentFiles = req.files?.attachments || [];
        const cleanupFiles = () =>
            [audioFile, ...attachmentFiles]
                .filter(Boolean)
                .forEach((f) => fs.unlink(f.path, () => {}));

        const body = req.body || {};
        const patientId = String(body.patient_id || "").trim();
        const sttProvider = String(
            body.stt_provider || "whisper",
        ).toLowerCase();

        // A retry sends the transcript back instead of the audio
        let transcript =
            typeof body.transcript === "string"
                ? body.transcript.trim().slice(0, 300000)
                : "";
        let diarized =
            typeof body.diarized_transcript === "string"
                ? body.diarized_transcript.slice(0, 300000)
                : null;
        let language = String(body.language || "unknown").slice(0, 20);
        const fromTranscript = transcript.length > 0;

        // Failure reply. Carries the transcript when there is one, so Retry can reuse it.
        const fail = (stage, status = 502) =>
            res.status(status).json({
                error: "generation_failed",
                stage,
                transcript: transcript || null,
                diarizedTranscript: diarized || null,
                language,
            });

        console.log("\n🚀 /process-audio", {
            audio: !!audioFile,
            attachments: attachmentFiles.length,
            fromTranscript,
        });

        try {
            if (!audioFile && attachmentFiles.length === 0 && !fromTranscript) {
                return res
                    .status(400)
                    .json({ error: "No audio file or documents uploaded" });
            }
            if (!UUID_RE.test(patientId)) {
                return res
                    .status(400)
                    .json({ error: "Select a patient first" });
            }

            // Cheap check first: patient must exist and belong to this doctor
            const { data: patient, error: patientError } = await supabase
                .from("patients")
                .select()
                .eq("id", patientId)
                .eq("owner_id", req.userId)
                .maybeSingle();
            if (patientError) throw patientError;
            if (!patient)
                return res.status(404).json({ error: "Patient not found" });

            // ---- 1. Transcribe (skipped on a transcript retry) ----
            if (audioFile && !fromTranscript) {
                const fns = {
                    sarvam: transcribeWithSarvam,
                    elevenlabs: transcribeWithElevenLabs,
                };
                const transcribeFn = fns[sttProvider] || transcribeWithGroq;
                try {
                    const out = await transcribeFn(
                        audioFile.path,
                        audioFile.originalname,
                        audioFile.mimetype,
                    );
                    transcript = (out.transcript || "").trim();
                    diarized = out.diarizedTranscript || null;
                    language = out.language || "unknown";
                } catch (err) {
                    console.log(
                        "❌ Transcription failed:",
                        err.response?.data || err.message,
                    );
                    return fail("transcribe");
                }
            }
            if (!transcript && attachmentFiles.length === 0)
                return fail("transcribe");

            // ---- 2. Build the prompt ----
            const template = fs.readFileSync("template.json", "utf-8");
            let prompt = fs
                .readFileSync("prompt.md", "utf-8")
                .replace("{{template}}", () => template)
                .replace("{{transcript}}", () => transcript);

            const regContext = patientContext(patient);
            if (regContext) {
                prompt += `\n\n# Patient registration record (context only)\nThis is background from registration. Use it to understand the visit. Do NOT copy any of it into the output unless the transcript itself mentions it.\n${regContext}\n`;
            }
            let attachmentImages = [];
            for (const file of attachmentFiles) {
                try {
                    attachmentImages = attachmentImages.concat(
                        await attachmentToImages(file),
                    );
                } catch (err) {
                    console.log(
                        `⚠️ Failed to read ${file.originalname}:`,
                        err.message,
                    );
                }
            }

            // ---- 3. Summary, with automatic retries ----
            let structuredData;
            try {
                structuredData = await extractStructured(
                    prompt,
                    attachmentImages,
                );
            } catch (err) {
                console.log(
                    "❌ Summary generation failed:",
                    err.response?.data || err.message,
                );
                return fail("summarize");
            }
            // Runs while codes are verified. Capped at 60 seconds.
            const planPromise = generateSuggestion({
                transcript,
                patient,
                sd: structuredData,
            });
            // ---- 4. Code verification. Never blocks. ----
            try {
                await warmCodes(structuredData);
                structuredData = await verifyAllCodes(structuredData);
            } catch (err) {
                console.log(
                    "⚠️ Code lookup failed, keeping what was found:",
                    err.message,
                );
            }
            const plan = await Promise.race([
                planPromise,
                sleep(60000).then(() => null),
            ]);
            if (plan) {
                structuredData.suggested_plan = plan;
                brands
                    .warm(
                        plan.items
                            .filter((i) => i.kind === "medication")
                            .map((i) => ({ name: i.name, dosage: i.dosage })),
                    )
                    .catch(() => {});
            } // ---- 5. Save ----
            const { data: consultation, error: saveError } = await supabase
                .from("consultations")
                .insert({
                    patient_id: patient.id,
                    owner_id: req.userId,
                    language,
                    transcript,
                    diarized_transcript: diarized || null,
                    structured_data: structuredData,
                })
                .select()
                .single();
            if (saveError) {
                console.log("❌ Consultation save failed:", saveError.message);
                return fail("other", 500);
            }

            regeneratePatientSummary(patient.id).catch((err) =>
                console.log(
                    "⚠️ Patient summary regeneration failed:",
                    err.message,
                ),
            );

            console.log(`✅ Done in ${(Date.now() - startTime) / 1000}s`);
            return res.json({
                language,
                transcript,
                diarizedTranscript: diarized || null,
                structured_data: structuredData,
                created_at: consultation.created_at,
                saved: {
                    patient_id: patient.id,
                    patient_name: patient.name,
                    patient_age: ageFromDob(patient.dob) ?? patient.age,
                    patient_gender: patient.gender,
                    patient_phone: patient.phone,
                    consultation_id: consultation.id,
                },
            });
        } catch (err) {
            console.log("❌ SERVER ERROR", err);
            if (!res.headersSent) fail("other", 500);
        } finally {
            cleanupFiles();
        }
    },
);
app.get("/patients/search", async (req, res) => {
    const query = (req.query.query || "").trim();
    if (query.length < 2) return res.json({ patients: [] });

    const digits = query.replace(/[\s\-().]/g, "");
    const phoneQ = /^\+?\d{3,}$/.test(digits) ? digits : query;

    const { data, error } = await supabase
        .from("patients")
        .select(PATIENT_COLS)
        .eq("owner_id", req.userId)
        .or(`name.ilike.%${query}%,phone.ilike.%${phoneQ}%`)
        .limit(10);
    if (error) throw error;
    res.json({ patients: data.map(withAge) });
});
app.get("/patients/:id/consultations", async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from("consultations")
            .select("id, created_at, language, structured_data")
            .eq("patient_id", id)
            .eq("owner_id", req.userId)
            .order("created_at", { ascending: false });
        if (error) throw error;

        const consultations = data.map((c) => ({
            id: c.id,
            created_at: c.created_at,
            language: c.language,
            // best-effort one-line summary for the list — adjust fields to match your template.json shape
            summary: c.structured_data?.conditions?.[0]?.name || null,
        }));

        res.json({ consultations });
    } catch (err) {
        console.log("⚠️ Fetching consultations failed:", err.message);
        res.status(500).json({ error: "Failed to fetch consultations" });
    }
});

app.get("/consultations/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from("consultations")
            .select("*, patients(id, name, dob, age, gender, phone)")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Not found" });

        res.json({
            language: data.language,
            transcript: data.transcript,
            diarizedTranscript: data.diarized_transcript,
            structured_data: data.structured_data,
            created_at: data.created_at,
            saved: {
                patient_id: data.patients?.id,
                patient_name: data.patients?.name,
                patient_age:
                    ageFromDob(data.patients?.dob) ?? data.patients?.age,
                patient_gender: data.patients?.gender,
                patient_phone: data.patients?.phone,
                consultation_id: data.id,
            },
        });
    } catch (err) {
        console.log("⚠️ Fetching consultation failed:", err.message);
        res.status(500).json({ error: "Failed to fetch consultation" });
    }
});
app.get("/patients/:id/summary", async (req, res) => {
    const { id } = req.params;
    try {
        const { data: patient, error } = await supabase
            .from("patients")
            .select("patient_summary, patient_summary_updated_at")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!patient) return res.status(404).json({ error: "Not found" });
        if (patient.patient_summary !== null) {
            return res.json({ patient_summary: patient.patient_summary });
        }

        // No cache yet (e.g. patient existed before this feature, or first-ever visit
        // hasn't triggered a regenerate for some reason) — compute once, then cached from here on.
        const patientSummary = await regeneratePatientSummary(id);
        res.json({ patient_summary: patientSummary });
    } catch (err) {
        console.log("⚠️ Patient summary fetch failed:", err.message);
        res.status(500).json({ error: "Failed to load patient summary" });
    }
});
app.get("/doctor/profile", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("doctors")
            .select("*")
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        res.json({ profile: data || null });
    } catch (err) {
        console.log("⚠️ Profile fetch failed:", err.message);
        res.status(500).json({ error: "Failed to load profile" });
    }
});

app.put("/doctor/profile", async (req, res) => {
    try {
        const b = req.body || {};
        const name = typeof b.name === "string" ? b.name.trim() : "";
        const sig = b.signature_data;

        if (!name) return res.status(400).json({ error: "Name is required" });
        if (typeof sig !== "string" || sig.length > 500000) {
            return res
                .status(400)
                .json({ error: "A valid signature is required" });
        }
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(sig)) {
            return res
                .status(400)
                .json({ error: "Signature must be a PNG or JPEG image" });
        }

        const clean = (v, max = 200) =>
            (typeof v === "string" ? v.trim().slice(0, max) : "") || null;
        const mobile = normPhone(
            typeof b.mobile === "string" ? b.mobile.trim().slice(0, 25) : "",
        );
        if (!mobile)
            return res.status(400).json({ error: "Mobile number is required" });
        if (!PHONE_RE.test(mobile)) {
            return res
                .status(400)
                .json({ error: "Enter a valid 10-digit mobile number" });
        }
        const { data, error } = await supabase
            .from("doctors")
            .upsert(
                {
                    owner_id: req.userId,
                    name: name.slice(0, 120),
                    qualification: clean(b.qualification),
                    registration_no: clean(b.registration_no, 60),
                    email: clean(b.email),
                    clinic_name: clean(b.clinic_name),
                    clinic_address: clean(b.clinic_address, 300),
                    signature_data: sig,
                    mobile,
                    council_name: clean(b.council_name, 120),
                    updated_at: new Date().toISOString(),
                },
                { onConflict: "owner_id" },
            )
            .select()
            .single();
        if (error) throw error;
        res.json({ profile: data });
    } catch (err) {
        console.log("⚠️ Profile save failed:", err.message);
        res.status(500).json({ error: "Failed to save profile" });
    }
});
const RX_FIELDS = {
    symptoms: ["name", "duration", "start_date", "end_date", "notes"],
    medications: ["name", "duration", "instructions", "brand"],
    diagnosis: ["name"],
    followup: ["next_visit_duration", "date", "advice"],
};
const BLANK_CODES = {
    symptoms: { snomed_ct_code: "" },
    medications: { rxnorm_code: "" },
    diagnosis: { snomed_ct_code: "", snomed_ct_term: "", icd10_code: "" },
    followup: {},
};
const CODE_KEY = /code|_verified|_corrected|umls_term|snomed_ct_term/;
const str = (v, max = 300) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";

// Rebuild each entry from a whitelist. Existing codes are kept when the name is
// unchanged; new or renamed entries get fresh codes looked up via UMLS.
async function sanitizeRxList(key, incoming, existing) {
    if (!Array.isArray(incoming)) return [];
    const out = [];
    for (const raw of incoming.slice(0, 30)) {
        if (!raw || typeof raw !== "object") continue;
        const entry = {};
        for (const f of RX_FIELDS[key]) entry[f] = str(raw[f]);
        if (key === "medications") {
            entry.dosage = (Array.isArray(raw.dosage) ? raw.dosage : [])
                .map((d) => str(d, 60))
                .filter(Boolean)
                .slice(0, 10);
        }
        const hasContent = Object.values(entry).some((v) =>
            Array.isArray(v) ? v.length > 0 : v,
        );
        if (!hasContent) continue;

        if (key !== "followup") {
            if (!entry.name) continue; // a row without a name is dropped
            const prev = existing.find(
                (e) => str(e?.name).toLowerCase() === entry.name.toLowerCase(),
            );
            if (prev) {
                for (const k of Object.keys(prev)) {
                    if (CODE_KEY.test(k)) entry[k] = prev[k];
                }
            } else {
                Object.assign(entry, BLANK_CODES[key]);
                try {
                    await verifyEntry(
                        entry,
                        key === "medications"
                            ? "drug"
                            : key === "diagnosis"
                              ? "diagnosis"
                              : "symptom",
                    );
                } catch (err) {
                    console.log(
                        "⚠️ Code lookup failed for edited entry:",
                        err.message,
                    );
                }
            }
        }
        out.push(entry);
    }
    return out;
}

app.put("/consultations/:id/prescription", async (req, res) => {
    try {
        const { id } = req.params;
        const incoming = req.body?.prescription;
        if (!incoming || typeof incoming !== "object") {
            return res.status(400).json({ error: "Invalid prescription data" });
        }

        const { data: row, error } = await supabase
            .from("consultations")
            .select("structured_data")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ error: "Not found" });

        const sd =
            row.structured_data && typeof row.structured_data === "object"
                ? row.structured_data
                : {};
        const existingRx = sd.prescription || {};

        const cleaned = {};
        for (const key of Object.keys(RX_FIELDS)) {
            if (!(key in incoming)) continue; // older screens do not send tests
            cleaned[key] = await sanitizeRxList(
                key,
                incoming[key],
                Array.isArray(existingRx[key]) ? existingRx[key] : [],
            );
        }
        const prescription = { ...existingRx, ...cleaned };
        const updated = await afterConsultationEdit(id, {
            ...sd,
            prescription,
        });

        res.json({
            prescription: updated.prescription,
            consultation_summary: updated.consultation_summary,
        });
    } catch (err) {
        console.log("⚠️ Prescription update failed:", err.message);
        res.status(500).json({ error: "Failed to save changes" });
    }
});
const SIMPLE_SECTIONS = {
    allergies: {
        kind: "allergy",
        fields: ["name", "notes"],
        codeFields: ["snomed_ct_code", "icd10_code"],
    },
    conditions: {
        kind: "condition",
        fields: ["name", "duration", "start_date", "end_date", "notes"],
        codeFields: ["snomed_ct_code", "icd10_code"],
    },
    procedures: {
        kind: "procedure",
        fields: ["name", "date", "notes"],
        codeFields: ["snomed_ct_code", "icd10_pcs_code"],
    },
    lifestyle_habits: {
        kind: "lifestyle",
        fields: [
            "name",
            "frequency",
            "duration",
            "start_date",
            "end_date",
            "notes",
        ],
        codeFields: ["snomed_ct_code"],
    },
    social_history: {
        kind: "social",
        fields: ["name", "notes"],
        codeFields: ["snomed_ct_code"],
    },

    other_history: {
        kind: "condition",
        fields: ["name", "notes"],
        codeFields: [],
    },
    medication_history: {
        kind: "drug",
        fields: [
            "name",
            "dosage",
            "duration",
            "start_date",
            "end_date",
            "status",
        ],
        codeFields: ["rxnorm_code"],
        listField: "instruction",
    },
};

// Handles allergies, conditions, procedures, lifestyle, social, other, medications
async function sanitizeSimpleList(config, incoming, existing) {
    if (!Array.isArray(incoming)) return [];
    const out = [];
    for (const raw of incoming.slice(0, 40)) {
        if (!raw || typeof raw !== "object") continue;
        const entry = {};
        for (const f of config.fields)
            entry[f] = str(raw[f], f === "notes" ? 500 : 300);
        if (config.listField) {
            entry[config.listField] = (
                Array.isArray(raw[config.listField])
                    ? raw[config.listField]
                    : str(raw[config.listField]).split(";")
            )
                .map((x) => str(x, 100))
                .filter(Boolean)
                .slice(0, 10);
        }
        const hasContent = Object.values(entry).some((v) =>
            Array.isArray(v) ? v.length > 0 : v,
        );
        if (!hasContent || !entry.name) continue;

        const prev = existing.find(
            (e) => str(e?.name).toLowerCase() === entry.name.toLowerCase(),
        );
        if (prev) {
            for (const k of Object.keys(prev))
                if (CODE_KEY.test(k)) entry[k] = prev[k];
        } else {
            for (const cf of config.codeFields) entry[cf] = "";
            try {
                await verifyEntry(entry, config.kind);
            } catch (err) {
                console.log(
                    "⚠️ Code lookup failed for edited entry:",
                    err.message,
                );
            }
        }
        out.push(entry);
    }
    return out;
}

async function sanitizeVitals(incoming, existing) {
    const base =
        Array.isArray(existing) && existing.length
            ? existing
            : JSON.parse(fs.readFileSync("template.json", "utf-8")).vitals;
    if (!Array.isArray(incoming)) return base;
    return base.map((v) => {
        const match = incoming.find(
            (iv) =>
                str(iv?.name).toLowerCase() === str(v.name).toLowerCase() ||
                str(iv?.loinc_code) === str(v.loinc_code),
        );
        return { ...v, value: match ? str(match.value, 30) : v.value };
    });
}

async function sanitizeFamilyHistory(incoming, existing) {
    if (!Array.isArray(incoming)) return [];
    const out = [];
    for (const raw of incoming.slice(0, 20)) {
        if (!raw || typeof raw !== "object") continue;
        const relationship = str(raw.relationship, 60);
        const illness = (
            Array.isArray(raw.illness)
                ? raw.illness
                : str(raw.illness).split(",")
        )
            .map((x) => str(x, 100))
            .filter(Boolean)
            .slice(0, 10);
        const notes = str(raw.notes, 300);
        if (!relationship && illness.length === 0 && !notes) continue;

        const prev = existing.find(
            (e) =>
                str(e?.relationship).toLowerCase() ===
                    relationship.toLowerCase() &&
                JSON.stringify((e?.illness || []).map(String)) ===
                    JSON.stringify(illness),
        );
        const entry = { relationship, illness, notes };
        if (prev) {
            entry.snomed_ct_codes = prev.snomed_ct_codes || [];
            entry.icd10_codes = prev.icd10_codes || [];
            entry.snomed_ct_codes_verified = prev.snomed_ct_codes_verified;
            entry.icd10_codes_verified = prev.icd10_codes_verified;
        } else {
            entry.snomed_ct_codes = new Array(illness.length).fill("");
            entry.icd10_codes = new Array(illness.length).fill("");
            try {
                await verifyFamilyIllness(entry);
            } catch (err) {
                console.log(
                    "⚠️ Family history code lookup failed:",
                    err.message,
                );
            }
        }
        out.push(entry);
    }
    return out;
}

async function sanitizeSystemReview(incoming, existing) {
    if (!Array.isArray(incoming)) return [];
    const out = [];
    for (const raw of incoming.slice(0, 20)) {
        if (!raw || typeof raw !== "object") continue;
        const name = str(raw.name, 80);
        const findingTexts = (
            Array.isArray(raw.findings)
                ? raw.findings.map((f) =>
                      typeof f === "string" ? f : f?.finding,
                  )
                : str(raw.findings).split(",")
        )
            .map((x) => str(x, 150))
            .filter(Boolean)
            .slice(0, 15);
        const notes = str(raw.notes, 300);
        if (!name && findingTexts.length === 0 && !notes) continue;

        const prev = existing.find(
            (e) => str(e?.name).toLowerCase() === name.toLowerCase(),
        );
        const prevFindings = prev?.findings || [];
        const findings = findingTexts.map((finding) => {
            const p = prevFindings.find(
                (pf) =>
                    str(pf?.finding).toLowerCase() === finding.toLowerCase(),
            );
            return p ? { ...p, finding } : { finding, snomed_ct_code: "" };
        });
        const toVerify = findings.filter((f) => !f.snomed_ct_code);
        if (toVerify.length) {
            try {
                await verifyFindings(toVerify);
            } catch (err) {
                console.log("⚠️ Finding code lookup failed:", err.message);
            }
        }
        out.push({ name, findings, notes });
    }
    return out;
}

async function sanitizeInvestigations(incoming, existing) {
    if (!Array.isArray(incoming)) return [];
    const out = [];
    for (const raw of incoming.slice(0, 15)) {
        if (!raw || typeof raw !== "object") continue;
        const name = str(raw.name, 120);
        const date = str(raw.date, 40);
        const prevInv = existing.find(
            (e) => str(e?.name).toLowerCase() === name.toLowerCase(),
        );
        const prevReadings = prevInv?.readings || [];
        const readings = [];
        for (const r of (Array.isArray(raw.readings) ? raw.readings : []).slice(
            0,
            20,
        )) {
            if (!r || typeof r !== "object") continue;
            const investigation_name = str(r.investigation_name, 120);
            if (!investigation_name) continue;
            const entry = {
                investigation_name,
                result: str(r.result, 60),
                unit: str(r.unit, 30),
                interpretation: str(r.interpretation, 60),
                notes: str(r.notes, 200),
            };
            const p = prevReadings.find(
                (pr) =>
                    str(pr?.investigation_name).toLowerCase() ===
                    investigation_name.toLowerCase(),
            );
            if (p) {
                entry.loinc_code = p.loinc_code || "";
                entry.interpretation_snomed_code =
                    p.interpretation_snomed_code || "";
            } else {
                entry.loinc_code = "";
                entry.interpretation_snomed_code = "";
                try {
                    await verifyEntry(entry, "lab");
                } catch (err) {
                    console.log(
                        "⚠️ Investigation code lookup failed:",
                        err.message,
                    );
                }
            }
            readings.push(entry);
        }
        if (!name && !date && readings.length === 0) continue;
        out.push({ name, date, readings });
    }
    return out;
}

app.put("/consultations/:id/section/:key", async (req, res) => {
    const { id, key } = req.params;
    try {
        const { data: row, error } = await supabase
            .from("consultations")
            .select("structured_data")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!row) return res.status(404).json({ error: "Not found" });

        const sd =
            row.structured_data && typeof row.structured_data === "object"
                ? row.structured_data
                : {};
        const incoming = req.body?.[key];
        let updatedSection;
        if (key === "vitals") {
            updatedSection = await sanitizeVitals(incoming, sd.vitals);
        } else if (key === "family_history") {
            updatedSection = await sanitizeFamilyHistory(
                incoming,
                Array.isArray(sd.family_history) ? sd.family_history : [],
            );
        } else if (key === "system_review") {
            updatedSection = await sanitizeSystemReview(
                incoming,
                Array.isArray(sd.system_review) ? sd.system_review : [],
            );
        } else if (key === "investigation_history") {
            updatedSection = await sanitizeInvestigations(
                incoming,
                Array.isArray(sd.investigation_history)
                    ? sd.investigation_history
                    : [],
            );
        } else if (SIMPLE_SECTIONS[key]) {
            updatedSection = await sanitizeSimpleList(
                SIMPLE_SECTIONS[key],
                incoming,
                Array.isArray(sd[key]) ? sd[key] : [],
            );
        } else {
            return res.status(400).json({ error: "Unknown section" });
        }
        const updated = await afterConsultationEdit(id, {
            ...sd,
            [key]: updatedSection,
        });

        res.json({
            [key]: updated[key],
            consultation_summary: updated.consultation_summary,
        });
    } catch (err) {
        console.log(`⚠️ Section update failed (${key}):`, err.message);
        res.status(500).json({ error: "Failed to save changes" });
    }
});
app.put("/doctor/letterhead", async (req, res) => {
    try {
        const b = req.body || {};
        const img = b.image_data;

        if (img === null) {
            const { data, error } = await supabase
                .from("doctors")
                .update({
                    letterhead_data: null,
                    letterhead_top_pct: null,
                    letterhead_bottom_pct: null,
                    updated_at: new Date().toISOString(),
                })
                .eq("owner_id", req.userId)
                .select()
                .maybeSingle();
            if (error) throw error;
            if (!data)
                return res
                    .status(404)
                    .json({ error: "Set up your profile first" });
            return res.json({ profile: data });
        }

        if (
            typeof img !== "string" ||
            img.length > 1200000 ||
            !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)
        ) {
            return res.status(400).json({
                error: "Letterhead must be a PNG or JPEG image (under ~900 KB)",
            });
        }

        const top = Number(b.top_pct);
        const bottom = Number(b.bottom_pct);
        if (
            !Number.isFinite(top) ||
            !Number.isFinite(bottom) ||
            top < 0 ||
            top > 60 ||
            bottom < 40 ||
            bottom > 100 ||
            bottom - top < 30
        ) {
            return res.status(400).json({ error: "Invalid content area" });
        }

        const { data, error } = await supabase
            .from("doctors")
            .update({
                letterhead_data: img,
                letterhead_top_pct: top,
                letterhead_bottom_pct: bottom,
                updated_at: new Date().toISOString(),
            })
            .eq("owner_id", req.userId)
            .select()
            .maybeSingle();
        if (error) throw error;
        if (!data)
            return res.status(404).json({ error: "Set up your profile first" });
        res.json({ profile: data });
    } catch (err) {
        console.log("⚠️ Letterhead save failed:", err.message);
        res.status(500).json({ error: "Failed to save letterhead" });
    }
});
app.get("/me", async (req, res) => {
    try {
        if (req.role === "staff") {
            const { data } = await supabase
                .from("doctors")
                .select("name")
                .eq("owner_id", req.userId)
                .maybeSingle();
            return res.json({ role: "staff", doctor_name: data?.name || null });
        }
        const { data, error } = await supabase
            .from("doctors")
            .select("*")
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        res.json({ role: "doctor", profile: data || null });
    } catch (err) {
        console.log("⚠️ /me failed:", err.message);
        res.status(500).json({ error: "Couldn't load account" });
    }
});

// const pstr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// function cleanPatient(b) {
//     const age = parseInt(b?.age, 10);
//     const gender = pstr(b?.gender, 10).toLowerCase();
//     return {
//         name: pstr(b?.name, 120),
//         phone: pstr(b?.phone, 20),
//         age: Number.isFinite(age) && age >= 0 && age <= 120 ? age : null,
//         gender: ["male", "female", "other"].includes(gender) ? gender : null,
//     };
// }
// const PATIENT_COLS = "id, name, age, gender, phone";

// app.post("/patients", async (req, res) => {
//     try {
//         const p = cleanPatient(req.body);
//         if (!p.name || !p.phone) {
//             return res
//                 .status(400)
//                 .json({ error: "Name and phone number are required" });
//         }
//         const { data, error } = await supabase
//             .from("patients")
//             .insert({ ...p, owner_id: req.userId, created_by: req.actorId })
//             .select(PATIENT_COLS)
//             .single();
//         if (error) {
//             if (error.code === "23505") {
//                 return res
//                     .status(409)
//                     .json({
//                         error: "A patient with this phone number already exists",
//                     });
//             }
//             throw error;
//         }
//         res.status(201).json({ patient: data });
//     } catch (err) {
//         console.log("⚠️ Patient create failed:", err.message);
//         res.status(500).json({ error: "Failed to add patient" });
//     }
// });

// app.put("/patients/:id", async (req, res) => {
//     try {
//         const p = cleanPatient(req.body);
//         if (!p.name || !p.phone) {
//             return res
//                 .status(400)
//                 .json({ error: "Name and phone number are required" });
//         }
//         const { data, error } = await supabase
//             .from("patients")
//             .update(p) // only these four fields can ever change
//             .eq("id", req.params.id)
//             .eq("owner_id", req.userId)
//             .select(PATIENT_COLS)
//             .maybeSingle();
//         if (error) {
//             if (error.code === "23505") {
//                 return res
//                     .status(409)
//                     .json({
//                         error: "Another patient already has this phone number",
//                     });
//             }
//             throw error;
//         }
//         if (!data) return res.status(404).json({ error: "Not found" });
//         res.json({ patient: data });
//     } catch (err) {
//         console.log("⚠️ Patient update failed:", err.message);
//         res.status(500).json({ error: "Failed to update patient" });
//     }
// });
const pstr = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const opt = (v, max) => pstr(v, max) || null;
const PHONE_RE = /^[6-9]\d{9}$/;
const normPhone = (s) => {
    let t = s.replace(/[\s\-().]/g, "");
    if (/^\+?91\d{10}$/.test(t)) t = t.replace(/^\+?91/, "");
    else if (/^0\d{10}$/.test(t)) t = t.slice(1);
    return t;
};
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^\d{6}$/;
const UHID_RE = /^[A-Za-z0-9\-_/]{1,40}$/;
const GENDERS = ["male", "female", "other"];
const TITLES = ["Mr.", "Mrs.", "Ms.", "Miss", "Master", "Dr."];
const MARITAL = ["Single", "Married", "Divorced", "Widowed", "Separated"];
const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const YES_NO = ["Yes", "No"];
const HISTORY_KEYS = ["diabetes", "hypertension", "hypothyroidism"];
const HABIT_KEYS = ["alcohol", "tobacco", "smoke"];

const PATIENT_COLS =
    "id, name, dob, age, gender, phone, title, uhid, marital_status, occupation, alt_phone, email, address, city, pincode, informant_name, channel, tag, referred_by_name, referred_by_phone, medical";

function ageFromDob(dob) {
    if (!dob) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob));
    if (!m) return null;
    const now = new Date();
    let age = now.getFullYear() - +m[1];
    const before =
        now.getMonth() + 1 < +m[2] ||
        (now.getMonth() + 1 === +m[2] && now.getDate() < +m[3]);
    if (before) age--;
    return age >= 0 ? age : age === -1 ? 0 : null;
}
const withAge = (p) =>
    p ? { ...p, age: p.dob ? ageFromDob(p.dob) : p.age } : p;

function parseDob(v) {
    const s = pstr(v, 10);
    if (!s) return { value: null };
    const d = new Date(`${s}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
        Number.isNaN(d.getTime()) ||
        d.toISOString().slice(0, 10) !== s
    ) {
        return { error: "Enter a valid date of birth" };
    }
    // One day of slack for the time zone gap between the phone and the server
    const limit = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    if (s > limit) return { error: "Date of birth can't be in the future" };
    const age = ageFromDob(s);
    if (age !== null && age > 120)
        return { error: "Enter a valid date of birth" };
    return { value: s };
}

function oneOf(v, list, label) {
    const s = pstr(v, 30);
    if (!s) return { value: null };
    return list.includes(s)
        ? { value: s }
        : { error: `Select a valid ${label}` };
}

function cleanPatient(b = {}) {
    const name = pstr(b.name, 120).replace(/\s+/g, " ");
    if (name.length < 2 || !NAME_RE.test(name))
        return { error: "Enter a valid name" };

    const phone = normPhone(pstr(b.phone, 25));
    if (!PHONE_RE.test(phone))
        return { error: "Enter a valid 10-digit phone number" };

    const dob = parseDob(b.dob);
    if (dob.error) return dob;

    const gender = pstr(b.gender, 10).toLowerCase();
    if (gender && !GENDERS.includes(gender))
        return { error: "Select a valid gender" };

    const title = oneOf(b.title, TITLES, "title");
    if (title.error) return title;
    const marital = oneOf(b.marital_status, MARITAL, "marital status");
    if (marital.error) return marital;

    const uhid = pstr(b.uhid, 40);
    if (uhid && !UHID_RE.test(uhid)) return { error: "Enter a valid UHID" };

    const email = pstr(b.email, 120).toLowerCase();
    if (email && !EMAIL_RE.test(email)) return { error: "Enter a valid email" };

    const altPhone = normPhone(pstr(b.alt_phone, 25));
    if (altPhone && !PHONE_RE.test(altPhone))
        return { error: "Enter a valid 10-digit alternative phone" };
    const refPhone = normPhone(pstr(b.referred_by_phone, 25));
    if (refPhone && !PHONE_RE.test(refPhone))
        return { error: "Enter a valid 10-digit referrer phone" };
    const pincode = pstr(b.pincode, 10);
    if (pincode && !PIN_RE.test(pincode))
        return { error: "Enter a valid 6-digit pincode" };

    const m = b.medical && typeof b.medical === "object" ? b.medical : {};
    const medical = {};
    const bg = oneOf(m.blood_group, BLOOD, "blood group");
    if (bg.error) return bg;
    if (bg.value) medical.blood_group = bg.value;
    for (const k of [...HISTORY_KEYS, ...HABIT_KEYS]) {
        const s = oneOf(m[k], YES_NO, k);
        if (s.error) return s;
        if (s.value) medical[k] = s.value;
    }
    if (m.no_known_history === true) {
        medical.no_known_history = true;
        HISTORY_KEYS.forEach((k) => delete medical[k]);
    }

    return {
        value: {
            name,
            phone,
            dob: dob.value,
            gender: gender || null,
            title: title.value,
            uhid: uhid || null,
            marital_status: marital.value,
            occupation: opt(b.occupation, 80),
            alt_phone: altPhone || null,
            email: email || null,
            address: opt(b.address, 300),
            city: opt(b.city, 80),
            pincode: pincode || null,
            informant_name: opt(b.informant_name, 120),
            channel: opt(b.channel, 80),
            tag: opt(b.tag, 80),
            referred_by_name: opt(b.referred_by_name, 120),
            referred_by_phone: refPhone || null,
            medical: Object.keys(medical).length ? medical : null,
        },
    };
}

const dupMessage = (error) =>
    String(error.message || "").includes("uhid")
        ? "This UHID already exists"
        : "A patient with this phone number already exists";

app.post("/patients", async (req, res) => {
    try {
        const c = cleanPatient(req.body);
        if (c.error) return res.status(400).json({ error: c.error });
        const { data, error } = await supabase
            .from("patients")
            .insert({
                ...c.value,
                age: ageFromDob(c.value.dob),
                owner_id: req.userId,
                created_by: req.actorId,
            })
            .select(PATIENT_COLS)
            .single();
        if (error) {
            if (error.code === "23505")
                return res.status(409).json({ error: dupMessage(error) });
            throw error;
        }
        res.status(201).json({ patient: withAge(data) });
    } catch (err) {
        console.log("⚠️ Patient create failed:", err.message);
        res.status(500).json({ error: "Failed to add patient" });
    }
});

app.put("/patients/:id", async (req, res) => {
    try {
        const c = cleanPatient(req.body);
        if (c.error) return res.status(400).json({ error: c.error });
        const update = { ...c.value };
        if (c.value.dob) update.age = ageFromDob(c.value.dob);
        const { data, error } = await supabase
            .from("patients")
            .update(update)
            .eq("id", req.params.id)
            .eq("owner_id", req.userId)
            .select(PATIENT_COLS)
            .maybeSingle();
        if (error) {
            if (error.code === "23505")
                return res.status(409).json({ error: dupMessage(error) });
            throw error;
        }
        if (!data) return res.status(404).json({ error: "Not found" });
        res.json({ patient: withAge(data) });
    } catch (err) {
        console.log("⚠️ Patient update failed:", err.message);
        res.status(500).json({ error: "Failed to update patient" });
    }
});
app.get("/patients", async (req, res) => {
    try {
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 20, 1),
            50,
        );
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const q = String(req.query.q || "")
            .replace(/[%_\\,()]/g, " ")
            .trim();
        const digits = q.replace(/[\s\-().]/g, "");
        const term = /^\+?\d{3,}$/.test(digits) ? digits : q;

        const { data, error } = await supabase.rpc("list_patients", {
            p_owner: req.userId,
            p_q: term,
            p_limit: limit + 1, // one extra row tells if more exist
            p_offset: offset,
        });
        if (error) throw error;

        const hasMore = data.length > limit;
        const patients = data
            .slice(0, limit)
            .map(withAge)
            .map((r) => {
                if (req.role === "staff") {
                    const { last_visit, visit_count, ...rest } = r; // staff never see visit data
                    return rest;
                }
                return { ...r, visit_count: Number(r.visit_count) };
            });
        res.json({ patients, hasMore });
    } catch (err) {
        console.log("⚠️ Patient list failed:", err.message);
        res.status(500).json({ error: "Failed to load patients" });
    }
});
const num2 = (v, min, max) => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return Math.round(n * 100) / 100;
};

async function cleanTax(b) {
    const name = pstr(b?.name, 40).replace(/\s+/g, " ");
    if (name.length < 2) return { error: "Enter a tax name" };
    const rate = num2(b?.rate, 0, 100);
    if (rate === null) return { error: "Rate must be 0 to 100" };
    return { value: { name, rate } };
}

async function cleanService(b, owner) {
    const name = pstr(b?.name, 80).replace(/\s+/g, " ");
    if (name.length < 2) return { error: "Enter a service name" };
    const fee = num2(b?.fee, 0, 10000000);
    if (fee === null) return { error: "Enter a valid fee" };
    let tax_id = null;
    if (b?.tax_id) {
        const { data } = await supabase
            .from("tax_brackets")
            .select("id")
            .eq("id", String(b.tax_id))
            .eq("owner_id", owner)
            .maybeSingle();
        if (!data) return { error: "Select a valid tax" };
        tax_id = data.id;
    }
    const description = pstr(b?.description, 200);
    return {
        value: {
            name,
            description: description || null,
            fee,
            tax_id,
            active: b?.active !== false,
        },
    };
}

app.get("/rate-card", async (req, res) => {
    try {
        const [svc, tax, bun] = await Promise.all([
            supabase
                .from("services")
                .select("id, name, description, fee, tax_id, active")
                .eq("owner_id", req.userId)
                .order("name"),
            supabase
                .from("tax_brackets")
                .select("id, name, rate")
                .eq("owner_id", req.userId)
                .order("name"),
            supabase
                .from("bundles")
                .select(
                    "id, name, description, active, bundle_items(service_id, qty, position)",
                )
                .eq("owner_id", req.userId)
                .order("name"),
        ]);
        if (svc.error) throw svc.error;
        if (tax.error) throw tax.error;
        if (bun.error) throw bun.error;

        const all = svc.data.map((s) => ({ ...s, fee: Number(s.fee) }));
        const byId = new Map(all.map((s) => [s.id, s]));
        let bundles = bun.data.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            active: b.active,
            items: [...(b.bundle_items || [])]
                .sort((a, z) => a.position - z.position)
                .map((m) => {
                    const s = byId.get(m.service_id);
                    return s
                        ? {
                              service_id: s.id,
                              qty: m.qty,
                              name: s.name,
                              description: s.description,
                              fee: s.fee,
                              tax_id: s.tax_id,
                              active: s.active,
                          }
                        : null;
                })
                .filter(Boolean),
        }));

        let services = all;
        if (req.role === "staff") {
            services = all.filter((s) => s.active);
            bundles = bundles.filter((b) => b.active && b.items.length);
        }
        res.json({
            services,
            bundles,
            taxes: tax.data.map((t) => ({ ...t, rate: Number(t.rate) })),
        });
    } catch (err) {
        console.log("⚠️ Rate card load failed:", err.message);
        res.status(500).json({ error: "Failed to load rate card" });
    }
});

app.post("/taxes", async (req, res) => {
    try {
        const c = await cleanTax(req.body);
        if (c.error) return res.status(400).json({ error: c.error });
        const { data, error } = await supabase
            .from("tax_brackets")
            .insert({ ...c.value, owner_id: req.userId })
            .select("id, name, rate")
            .single();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A tax with this name exists" });
            throw error;
        }
        res.status(201).json({ tax: data });
    } catch (err) {
        console.log("⚠️ Tax create failed:", err.message);
        res.status(500).json({ error: "Failed to save tax" });
    }
});

app.put("/taxes/:id", async (req, res) => {
    try {
        const c = await cleanTax(req.body);
        if (c.error) return res.status(400).json({ error: c.error });
        const { data, error } = await supabase
            .from("tax_brackets")
            .update(c.value)
            .eq("id", req.params.id)
            .eq("owner_id", req.userId)
            .select("id, name, rate")
            .maybeSingle();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A tax with this name exists" });
            throw error;
        }
        if (!data) return res.status(404).json({ error: "Not found" });
        res.json({ tax: data });
    } catch (err) {
        console.log("⚠️ Tax update failed:", err.message);
        res.status(500).json({ error: "Failed to save tax" });
    }
});

app.delete("/taxes/:id", async (req, res) => {
    try {
        const { count, error: cErr } = await supabase
            .from("services")
            .select("id", { count: "exact", head: true })
            .eq("owner_id", req.userId)
            .eq("tax_id", req.params.id);
        if (cErr) throw cErr;
        if (count > 0) {
            return res.status(409).json({
                error: `Used by ${count} service${count === 1 ? "" : "s"}. Change them first.`,
            });
        }
        const { error } = await supabase
            .from("tax_brackets")
            .delete()
            .eq("id", req.params.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.log("⚠️ Tax delete failed:", err.message);
        res.status(500).json({ error: "Failed to delete tax" });
    }
});

app.post("/services", async (req, res) => {
    try {
        const c = await cleanService(req.body, req.userId);
        if (c.error) return res.status(400).json({ error: c.error });
        const { data, error } = await supabase
            .from("services")
            .insert({ ...c.value, owner_id: req.userId })
            .select("id, name, description, fee, tax_id, active")
            .single();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A service with this name exists" });
            throw error;
        }
        res.status(201).json({ service: { ...data, fee: Number(data.fee) } });
    } catch (err) {
        console.log("⚠️ Service create failed:", err.message);
        res.status(500).json({ error: "Failed to save service" });
    }
});

app.put("/services/:id", async (req, res) => {
    try {
        const c = await cleanService(req.body, req.userId);
        if (c.error) return res.status(400).json({ error: c.error });
        const { data, error } = await supabase
            .from("services")
            .update(c.value)
            .eq("id", req.params.id)
            .eq("owner_id", req.userId)
            .select("id, name, description, fee, tax_id, active")
            .maybeSingle();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A service with this name exists" });
            throw error;
        }
        if (!data) return res.status(404).json({ error: "Not found" });
        res.json({ service: { ...data, fee: Number(data.fee) } });
    } catch (err) {
        console.log("⚠️ Service update failed:", err.message);
        res.status(500).json({ error: "Failed to save service" });
    }
});

app.delete("/services/:id", async (req, res) => {
    try {
        if (!UUID_RE.test(req.params.id))
            return res.status(404).json({ error: "Not found" });
        const { data: used, error: uErr } = await supabase
            .from("bundle_items")
            .select("bundles(name)")
            .eq("service_id", req.params.id);
        if (uErr) throw uErr;
        if (used.length) {
            const names = [
                ...new Set(used.map((u) => u.bundles?.name).filter(Boolean)),
            ];
            return res.status(409).json({
                error: `Used in bundle: ${names.join(", ")}. Remove it from the bundle first.`,
            });
        }
        const { error } = await supabase
            .from("services")
            .delete()
            .eq("id", req.params.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.log("⚠️ Service delete failed:", err.message);
        res.status(500).json({ error: "Failed to delete service" });
    }
});
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const pendingCutoff = () => new Date(Date.now() - PENDING_TTL_MS).toISOString();

async function ownsPatient(id, owner) {
    if (!UUID_RE.test(id)) return false;
    const { data } = await supabase
        .from("patients")
        .select("id")
        .eq("id", id)
        .eq("owner_id", owner)
        .maybeSingle();
    return !!data;
}

// Validates [{service_id, qty}]. Returns { value } or { error }.
// Validates services list. Catalog lines: {service_id, qty}.
// One-off lines (doctor only): {adhoc:true, id, name, description, fee, qty, tax_id}.
async function cleanItems(raw, owner, activeOnly, allowAdhoc = false) {
    if (!Array.isArray(raw) || raw.length > 50)
        return { error: "Invalid services" };

    const out = [];
    const idx = new Map(); // service_id -> position
    const bidx = new Map(); // bundle_id -> position
    for (const r of raw) {
        const qty = Number(r?.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
            return { error: "Quantity must be 1 to 99" };
        }
        if (r?.adhoc) {
            if (!allowAdhoc)
                return { error: "One-off services are not allowed here" };
            const name = pstr(r.name, 80).replace(/\s+/g, " ");
            if (name.length < 2)
                return { error: "Enter a name for the one-off service" };
            const fee = num2(r.fee, 0.01, 10000000);
            if (fee === null)
                return { error: "Enter a valid price for the one-off service" };
            let tax_id = null;
            if (r.tax_id) {
                tax_id = String(r.tax_id);
                if (!UUID_RE.test(tax_id))
                    return { error: "Select a valid tax" };
            }
            out.push({
                adhoc: true,
                id: UUID_RE.test(String(r.id || ""))
                    ? String(r.id)
                    : randomUUID(),
                name,
                description: pstr(r.description, 200) || null,
                fee,
                qty,
                tax_id,
            });
        } else if (r?.bundle_id) {
            const bid = String(r.bundle_id);
            if (!UUID_RE.test(bid)) return { error: "Invalid bundle" };
            const mode = r.mode === "services" ? "services" : "named";
            if (bidx.has(bid)) {
                Object.assign(out[bidx.get(bid)], { qty, mode });
            } else {
                bidx.set(bid, out.length);
                out.push({ bundle_id: bid, qty, mode });
            }
        } else {
            const id = String(r?.service_id || "");
            if (!UUID_RE.test(id)) return { error: "Invalid service" };
            if (idx.has(id)) {
                out[idx.get(id)].qty = qty;
            } else {
                idx.set(id, out.length);
                out.push({ service_id: id, qty });
            }
        }
    }

    const ids = [...idx.keys()];
    if (ids.length) {
        const { data, error } = await supabase
            .from("services")
            .select("id, active")
            .eq("owner_id", owner)
            .in("id", ids);
        if (error) throw error;
        if (data.length !== ids.length) return { error: "Unknown service" };
        if (activeOnly && data.some((s) => !s.active)) {
            return { error: "A selected service is not available" };
        }
    }

    const bids = [...bidx.keys()];
    if (bids.length) {
        const { data, error } = await supabase
            .from("bundles")
            .select("id, active")
            .eq("owner_id", owner)
            .in("id", bids);
        if (error) throw error;
        if (data.length !== bids.length) return { error: "Unknown bundle" };
        if (activeOnly && data.some((b) => !b.active)) {
            return { error: "A selected bundle is not available" };
        }
    }

    const taxIds = [
        ...new Set(out.filter((i) => i.adhoc && i.tax_id).map((i) => i.tax_id)),
    ];
    if (taxIds.length) {
        const { data, error } = await supabase
            .from("tax_brackets")
            .select("id")
            .eq("owner_id", owner)
            .in("id", taxIds);
        if (error) throw error;
        if (data.length !== taxIds.length)
            return { error: "Select a valid tax" };
    }

    return { value: out };
}

// Drops expired rows, then returns live pending items for a patient
async function livePendingItems(patientId, owner, activeOnly) {
    await supabase
        .from("patient_pending_services")
        .delete()
        .eq("owner_id", owner)
        .lt("created_at", pendingCutoff());
    const { data, error } = await supabase
        .from("patient_pending_services")
        .select("service_id, bundle_id, qty, services(active), bundles(active)")
        .eq("owner_id", owner)
        .eq("patient_id", patientId)
        .order("created_at");
    if (error) throw error;
    return data
        .filter(
            (r) =>
                !activeOnly ||
                (r.bundle_id ? r.bundles?.active : r.services?.active),
        )
        .map((r) =>
            r.bundle_id
                ? { bundle_id: r.bundle_id, qty: r.qty }
                : { service_id: r.service_id, qty: r.qty },
        );
}

app.get("/patients/:id/pending-services", async (req, res) => {
    try {
        if (!(await ownsPatient(req.params.id, req.userId))) {
            return res.status(404).json({ error: "Not found" });
        }
        const items = await livePendingItems(
            req.params.id,
            req.userId,
            req.role === "staff",
        );
        res.json({ items });
    } catch (err) {
        console.log("⚠️ Pending services load failed:", err.message);
        res.status(500).json({ error: "Failed to load services" });
    }
});

app.put("/patients/:id/pending-services", async (req, res) => {
    try {
        const id = req.params.id;
        if (!(await ownsPatient(id, req.userId))) {
            return res.status(404).json({ error: "Not found" });
        }
        const c = await cleanItems(
            req.body?.items,
            req.userId,
            req.role === "staff",
        );
        if (c.error) return res.status(400).json({ error: c.error });

        const del = await supabase
            .from("patient_pending_services")
            .delete()
            .eq("owner_id", req.userId)
            .eq("patient_id", id);
        if (del.error) throw del.error;

        if (c.value.length) {
            const ins = await supabase.from("patient_pending_services").insert(
                c.value.map((i) => ({
                    owner_id: req.userId,
                    patient_id: id,
                    service_id: i.service_id || null,
                    bundle_id: i.bundle_id || null,
                    qty: i.qty,
                    added_by: req.actorId,
                })),
            );
            if (ins.error) throw ins.error;
        }
        res.json({ items: c.value });
    } catch (err) {
        console.log("⚠️ Pending services save failed:", err.message);
        res.status(500).json({ error: "Failed to save services" });
    }
});

app.get("/consultations/:id/services", async (req, res) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id))
            return res.status(404).json({ error: "Not found" });
        const { data: c, error } = await supabase
            .from("consultations")
            .select("id, patient_id, created_at, service_items")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!c) return res.status(404).json({ error: "Not found" });

        let items = [];
        let source = "none";
        if (Array.isArray(c.service_items)) {
            items = c.service_items;
            source = "saved";
        } else if (
            new Date(c.created_at).getTime() >
            Date.now() - PENDING_TTL_MS
        ) {
            items = await livePendingItems(c.patient_id, req.userId, false);
            items = items.map((i) =>
                i.bundle_id ? { ...i, mode: "named" } : i,
            );
            source = "pending";
        }

        // Drop catalog services deleted since. One-off lines stay.
        // Drop catalog services and bundles deleted since. One-off lines stay.
        const sids = items
            .filter((i) => !i.adhoc && !i.bundle_id)
            .map((i) => i.service_id)
            .filter((x) => UUID_RE.test(x));
        const bids = items
            .filter((i) => i.bundle_id)
            .map((i) => i.bundle_id)
            .filter((x) => UUID_RE.test(x));
        let okS = new Set();
        let okB = new Set();
        if (sids.length) {
            const { data: f } = await supabase
                .from("services")
                .select("id")
                .eq("owner_id", req.userId)
                .in("id", sids);
            okS = new Set((f || []).map((s) => s.id));
        }
        if (bids.length) {
            const { data: f } = await supabase
                .from("bundles")
                .select("id")
                .eq("owner_id", req.userId)
                .in("id", bids);
            okB = new Set((f || []).map((b) => b.id));
        }
        items = items.filter(
            (i) =>
                i.adhoc ||
                (i.bundle_id ? okB.has(i.bundle_id) : okS.has(i.service_id)),
        );
        res.json({ items, source });
    } catch (err) {
        console.log("⚠️ Consultation services load failed:", err.message);
        res.status(500).json({ error: "Failed to load services" });
    }
});

app.put("/consultations/:id/services", async (req, res) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id))
            return res.status(404).json({ error: "Not found" });
        const { data: c, error } = await supabase
            .from("consultations")
            .select("id, patient_id")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        if (!c) return res.status(404).json({ error: "Not found" });

        const v = await cleanItems(req.body?.items, req.userId, false, true);
        if (v.error) return res.status(400).json({ error: v.error });

        const up = await supabase
            .from("consultations")
            .update({ service_items: v.value })
            .eq("id", id)
            .eq("owner_id", req.userId);
        if (up.error) throw up.error;

        // Pending list consumed
        await supabase
            .from("patient_pending_services")
            .delete()
            .eq("owner_id", req.userId)
            .eq("patient_id", c.patient_id);
        try {
            await refreshBillIfAny(id, req.userId);
        } catch (err) {
            console.log("⚠️ Bill refresh failed:", err.message);
        }
        res.json({ items: v.value });
    } catch (err) {
        console.log("⚠️ Consultation services save failed:", err.message);
        res.status(500).json({ error: "Failed to save services" });
    }
});
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const istDate = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" })
        .format(new Date())
        .replace(/-/g, "");

const nameSlug = (n) => {
    const s = String(n || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("")
        .slice(0, 24);
    return s || "Patient";
};

const BILL_COLS =
    "id, bill_no, consultation_id, patient, items, tax_summary, subtotal, tax_total, round_off, total, created_at, updated_at";

const shapeBill = (b) =>
    b && {
        ...b,
        subtotal: Number(b.subtotal),
        tax_total: Number(b.tax_total),
        round_off: Number(b.round_off),
        total: Number(b.total),
    };

// Freezes saved services at current rates into bill fields
async function buildBillData(consultationId, owner) {
    const { data: c, error } = await supabase
        .from("consultations")
        .select("id, patient_id, service_items")
        .eq("id", consultationId)
        .eq("owner_id", owner)
        .maybeSingle();
    if (error) throw error;
    if (!c) return { notFound: true };

    const saved = Array.isArray(c.service_items) ? c.service_items : [];
    if (saved.length === 0)
        return { error: "Save services on this consultation first" };

    // Bundles and their members
    const bundleIds = saved
        .filter((i) => i.bundle_id)
        .map((i) => i.bundle_id)
        .filter((x) => UUID_RE.test(x));
    let bundleMap = new Map();
    const membersByBundle = new Map();
    if (bundleIds.length) {
        const { data: bs, error: bErr } = await supabase
            .from("bundles")
            .select("id, name, description")
            .eq("owner_id", owner)
            .in("id", bundleIds);
        if (bErr) throw bErr;
        bundleMap = new Map(bs.map((b) => [b.id, b]));
        const { data: bi, error: biErr } = await supabase
            .from("bundle_items")
            .select("bundle_id, service_id, qty, position")
            .in("bundle_id", bundleIds)
            .order("position");
        if (biErr) throw biErr;
        for (const m of bi) {
            const arr = membersByBundle.get(m.bundle_id) || [];
            arr.push(m);
            membersByBundle.set(m.bundle_id, arr);
        }
    }

    // Every service we need: catalog lines plus bundle members
    const svcIds = new Set(
        saved
            .filter((i) => !i.adhoc && !i.bundle_id)
            .map((i) => i.service_id)
            .filter((x) => UUID_RE.test(x)),
    );
    for (const arr of membersByBundle.values())
        arr.forEach((m) => svcIds.add(m.service_id));
    let svcs = [];
    if (svcIds.size) {
        const { data, error: sErr } = await supabase
            .from("services")
            .select("id, name, description, fee, tax_id")
            .eq("owner_id", owner)
            .in("id", [...svcIds]);
        if (sErr) throw sErr;
        svcs = data;
    }
    const svcMap = new Map(svcs.map((s) => [s.id, s]));

    const taxIds = [
        ...new Set(
            [
                ...svcs.map((s) => s.tax_id),
                ...saved.filter((i) => i.adhoc).map((i) => i.tax_id),
            ].filter((x) => x && UUID_RE.test(x)),
        ),
    ];
    let taxMap = new Map();
    if (taxIds.length) {
        const { data: taxes, error: tErr } = await supabase
            .from("tax_brackets")
            .select("id, name, rate")
            .eq("owner_id", owner)
            .in("id", taxIds);
        if (tErr) throw tErr;
        taxMap = new Map(taxes.map((t) => [t.id, t]));
    }

    const items = [];
    const groups = new Map();
    let subtotal = 0;
    let taxTotal = 0;

    // One priced line. Adds to the bill totals and tax groups.
    const lineFor = (src, qty) => {
        const t = taxMap.get(src.tax_id); // deleted tax: no tax
        const fee = Number(src.fee);
        const rate = t ? Number(t.rate) : 0;
        const base = r2(fee * qty);
        const tax = r2((base * rate) / 100);
        if (t) {
            const key = `${t.name}|${rate}`;
            const g = groups.get(key) || {
                name: t.name,
                rate,
                taxable: 0,
                tax: 0,
            };
            g.taxable = r2(g.taxable + base);
            g.tax = r2(g.tax + tax);
            groups.set(key, g);
        }
        subtotal += base;
        taxTotal += tax;
        return {
            name: src.name,
            description: src.description || null,
            fee,
            qty,
            tax_name: t ? t.name : null,
            tax_rate: rate,
            base,
            tax,
            total: r2(base + tax),
        };
    };

    for (const it of saved) {
        const qty = Number(it.qty);

        if (it.bundle_id) {
            const b = bundleMap.get(it.bundle_id);
            const members = membersByBundle.get(it.bundle_id) || [];
            if (!b || members.length === 0) continue;
            const lines = [];
            let unit = 0;
            for (const m of members) {
                const s = svcMap.get(m.service_id);
                if (!s) continue;
                unit = r2(unit + Number(s.fee) * m.qty);
                lines.push({
                    service_id: s.id,
                    member_qty: m.qty,
                    ...lineFor(s, m.qty * qty),
                });
            }
            if (!lines.length) continue;
            items.push({
                type: "bundle",
                mode: it.mode === "services" ? "services" : "named",
                bundle_id: b.id,
                name: b.name,
                description: b.description || null,
                qty,
                unit_base: unit,
                lines,
                base: r2(lines.reduce((a, l) => a + l.base, 0)),
                tax: r2(lines.reduce((a, l) => a + l.tax, 0)),
                total: r2(lines.reduce((a, l) => a + l.total, 0)),
            });
            continue;
        }

        if (it.adhoc) {
            items.push({
                service_id: null,
                adhoc: true,
                ...lineFor(
                    {
                        name: it.name,
                        description: it.description,
                        fee: it.fee,
                        tax_id: it.tax_id,
                    },
                    qty,
                ),
            });
            continue;
        }

        const s = svcMap.get(it.service_id);
        if (!s) continue;
        items.push({ service_id: s.id, adhoc: false, ...lineFor(s, qty) });
    }
    if (!items.length) return { error: "Selected services no longer exist" };

    subtotal = r2(subtotal);
    taxTotal = r2(taxTotal);
    const grand = r2(subtotal + taxTotal);
    const total = Math.round(grand);
    const round_off = r2(total - grand);

    const { data: p, error: pErr } = await supabase
        .from("patients")
        .select("name, dob, age, gender, phone")
        .eq("id", c.patient_id)
        .eq("owner_id", owner)
        .maybeSingle();
    if (pErr) throw pErr;
    const pt = withAge(p) || {};

    return {
        value: {
            patient_id: c.patient_id,
            patient: {
                name: pt.name || "",
                age: pt.age ?? null,
                gender: pt.gender || "",
                phone: pt.phone || "",
            },
            items,
            tax_summary: [...groups.values()],
            subtotal,
            tax_total: taxTotal,
            round_off,
            total,
        },
    };
}
async function insertBill(owner, consultationId, v) {
    const base = `INV-${istDate()}-${nameSlug(v.patient.name)}`;
    for (let n = 1; n <= 25; n++) {
        const bill_no = n === 1 ? base : `${base}-${n}`;
        const { data, error } = await supabase
            .from("bills")
            .insert({
                owner_id: owner,
                consultation_id: consultationId,
                bill_no,
                ...v,
            })
            .select(BILL_COLS)
            .single();
        if (!error) return data;
        if (error.code !== "23505") throw error;
        // Double click raced us: bill for this consultation already exists
        if (String(error.message).includes("bills_consultation_key")) {
            const { data: ex } = await supabase
                .from("bills")
                .select(BILL_COLS)
                .eq("owner_id", owner)
                .eq("consultation_id", consultationId)
                .maybeSingle();
            if (ex) return ex;
        }
    }
    throw new Error("Couldn't allocate a bill number");
}

// After services change: rebuild existing bill. Same number. Delete if services emptied.
async function refreshBillIfAny(consultationId, owner) {
    const { data: existing } = await supabase
        .from("bills")
        .select("id")
        .eq("owner_id", owner)
        .eq("consultation_id", consultationId)
        .maybeSingle();
    if (!existing) return;
    const v = await buildBillData(consultationId, owner);
    if (!v.value) {
        await supabase.from("bills").delete().eq("id", existing.id);
        return;
    }
    const { error } = await supabase
        .from("bills")
        .update({ ...v.value, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    if (error) throw error;
}

app.post("/consultations/:id/bill", async (req, res) => {
    try {
        const id = req.params.id;
        if (!UUID_RE.test(id))
            return res.status(404).json({ error: "Not found" });

        const { data: existing, error: eErr } = await supabase
            .from("bills")
            .select(BILL_COLS)
            .eq("owner_id", req.userId)
            .eq("consultation_id", id)
            .maybeSingle();
        if (eErr) throw eErr;
        if (existing) return res.json({ bill: shapeBill(existing) });

        const v = await buildBillData(id, req.userId);
        if (v.notFound) return res.status(404).json({ error: "Not found" });
        if (v.error) return res.status(400).json({ error: v.error });

        const bill = await insertBill(req.userId, id, v.value);
        res.status(201).json({ bill: shapeBill(bill) });
    } catch (err) {
        console.log("⚠️ Bill generation failed:", err.message);
        res.status(500).json({ error: "Failed to generate bill" });
    }
});
function checkLetterhead(img, top, bottom) {
    if (
        typeof img !== "string" ||
        img.length > 1200000 ||
        !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)
    ) {
        return "Letterhead must be a PNG or JPEG image (under ~900 KB)";
    }
    const t = Number(top);
    const b = Number(bottom);
    if (
        !Number.isFinite(t) ||
        !Number.isFinite(b) ||
        t < 0 ||
        t > 60 ||
        b < 40 ||
        b > 100 ||
        b - t < 30
    ) {
        return "Invalid content area";
    }
    return null;
}

app.put("/doctor/bill-letterhead", async (req, res) => {
    try {
        const b = req.body || {};
        const update = {};
        if (typeof b.same === "boolean") update.bill_letterhead_same = b.same;

        if (b.image_data === null) {
            update.bill_letterhead_data = null;
            update.bill_letterhead_top_pct = null;
            update.bill_letterhead_bottom_pct = null;
        } else if (b.image_data !== undefined) {
            const err = checkLetterhead(b.image_data, b.top_pct, b.bottom_pct);
            if (err) return res.status(400).json({ error: err });
            update.bill_letterhead_data = b.image_data;
            update.bill_letterhead_top_pct = Number(b.top_pct);
            update.bill_letterhead_bottom_pct = Number(b.bottom_pct);
            update.bill_letterhead_same = false; // own image implies not same
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: "Nothing to update" });
        }
        update.updated_at = new Date().toISOString();

        const { data, error } = await supabase
            .from("doctors")
            .update(update)
            .eq("owner_id", req.userId)
            .select()
            .maybeSingle();
        if (error) throw error;
        if (!data)
            return res.status(404).json({ error: "Set up your profile first" });
        res.json({ profile: data });
    } catch (err) {
        console.log("⚠️ Bill letterhead save failed:", err.message);
        res.status(500).json({ error: "Failed to save bill letterhead" });
    }
});
async function cleanBundle(b, owner) {
    const name = pstr(b?.name, 80).replace(/\s+/g, " ");
    if (name.length < 2) return { error: "Enter a bundle name" };
    const description = pstr(b?.description, 200) || null;
    const raw = Array.isArray(b?.items) ? b.items : [];
    if (raw.length < 1)
        return { error: "Add at least one service to the bundle" };
    if (raw.length > 30)
        return { error: "A bundle can hold up to 30 services" };

    const items = [];
    const seen = new Set();
    for (const r of raw) {
        const id = String(r?.service_id || "");
        const qty = Number(r?.qty);
        if (!UUID_RE.test(id)) return { error: "Invalid service" };
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
            return { error: "Quantity must be 1 to 99" };
        }
        if (seen.has(id))
            return { error: "A service appears twice in this bundle" };
        seen.add(id);
        items.push({ service_id: id, qty, position: items.length });
    }
    const { data, error } = await supabase
        .from("services")
        .select("id")
        .eq("owner_id", owner)
        .in("id", [...seen]);
    if (error) throw error;
    if (data.length !== seen.size) return { error: "Unknown service" };
    return { value: { name, description, active: b?.active !== false, items } };
}

app.post("/bundles", async (req, res) => {
    try {
        const c = await cleanBundle(req.body, req.userId);
        if (c.error) return res.status(400).json({ error: c.error });
        const { items, ...fields } = c.value;
        const { data: bundle, error } = await supabase
            .from("bundles")
            .insert({ ...fields, owner_id: req.userId })
            .select("id")
            .single();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A bundle with this name exists" });
            throw error;
        }
        const ins = await supabase
            .from("bundle_items")
            .insert(items.map((i) => ({ ...i, bundle_id: bundle.id })));
        if (ins.error) {
            await supabase.from("bundles").delete().eq("id", bundle.id); // roll back
            throw ins.error;
        }
        res.status(201).json({ id: bundle.id });
    } catch (err) {
        console.log("⚠️ Bundle create failed:", err.message);
        res.status(500).json({ error: "Failed to save bundle" });
    }
});

app.put("/bundles/:id", async (req, res) => {
    try {
        if (!UUID_RE.test(req.params.id))
            return res.status(404).json({ error: "Not found" });
        const c = await cleanBundle(req.body, req.userId);
        if (c.error) return res.status(400).json({ error: c.error });
        const { items, ...fields } = c.value;
        const { data: b, error } = await supabase
            .from("bundles")
            .update(fields)
            .eq("id", req.params.id)
            .eq("owner_id", req.userId)
            .select("id")
            .maybeSingle();
        if (error) {
            if (error.code === "23505")
                return res
                    .status(409)
                    .json({ error: "A bundle with this name exists" });
            throw error;
        }
        if (!b) return res.status(404).json({ error: "Not found" });

        const up = await supabase.from("bundle_items").upsert(
            items.map((i) => ({ ...i, bundle_id: b.id })),
            {
                onConflict: "bundle_id,service_id",
            },
        );
        if (up.error) throw up.error;
        const del = await supabase
            .from("bundle_items")
            .delete()
            .eq("bundle_id", b.id)
            .not(
                "service_id",
                "in",
                `(${items.map((i) => i.service_id).join(",")})`,
            );
        if (del.error) throw del.error;
        res.json({ id: b.id });
    } catch (err) {
        console.log("⚠️ Bundle update failed:", err.message);
        res.status(500).json({ error: "Failed to save bundle" });
    }
});

app.delete("/bundles/:id", async (req, res) => {
    try {
        if (!UUID_RE.test(req.params.id))
            return res.status(404).json({ error: "Not found" });
        const { error } = await supabase
            .from("bundles")
            .delete()
            .eq("id", req.params.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.log("⚠️ Bundle delete failed:", err.message);
        res.status(500).json({ error: "Failed to delete bundle" });
    }
});
async function loadConsultationFull(id, owner) {
    if (!UUID_RE.test(id)) return null;
    const { data, error } = await supabase
        .from("consultations")
        .select("id, patient_id, transcript, structured_data")
        .eq("id", id)
        .eq("owner_id", owner)
        .maybeSingle();
    if (error) throw error;
    return data;
}
const sdOf = (c) =>
    c.structured_data && typeof c.structured_data === "object"
        ? c.structured_data
        : {};

// Build a plan for an older consultation, or rebuild one
app.post("/consultations/:id/suggestion", async (req, res) => {
    try {
        const c = await loadConsultationFull(req.params.id, req.userId);
        if (!c) return res.status(404).json({ error: "Not found" });
        const sd = sdOf(c);
        if (sd.suggested_plan?.status === "approved") {
            return res
                .status(409)
                .json({ error: "A suggestion was already added" });
        }
        const { data: patient } = await supabase
            .from("patients")
            .select()
            .eq("id", c.patient_id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        const plan = await generateSuggestion({
            transcript: c.transcript,
            patient,
            sd,
        });
        if (!plan) {
            return res.status(502).json({
                error: "Couldn't build a suggestion. Please try again.",
            });
        }
        const { error } = await supabase
            .from("consultations")
            .update({ structured_data: { ...sd, suggested_plan: plan } })
            .eq("id", c.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        brands
            .warm(
                plan.items
                    .filter((i) => i.kind === "medication")
                    .map((i) => ({ name: i.name, dosage: i.dosage })),
            )
            .catch(() => {});
        res.json({ suggested_plan: plan });
    } catch (err) {
        console.log("⚠️ Suggestion route failed:", err.message);
        res.status(500).json({
            error: "Couldn't build a suggestion. Please try again.",
        });
    }
});

// Dismiss or bring back
app.put("/consultations/:id/suggestion", async (req, res) => {
    try {
        const status = req.body?.status;
        if (!["dismissed", "pending"].includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }
        const c = await loadConsultationFull(req.params.id, req.userId);
        if (!c) return res.status(404).json({ error: "Not found" });
        const sd = sdOf(c);
        if (!sd.suggested_plan)
            return res.status(404).json({ error: "No suggestion" });
        if (sd.suggested_plan.status === "approved") {
            return res.status(409).json({ error: "Already added" });
        }
        const next = { ...sd.suggested_plan, status };
        const { error } = await supabase
            .from("consultations")
            .update({ structured_data: { ...sd, suggested_plan: next } })
            .eq("id", c.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        res.json({ suggested_plan: next });
    } catch (err) {
        console.log("⚠️ Suggestion status failed:", err.message);
        res.status(500).json({ error: "Failed to update" });
    }
});

// Add ticked items to the prescription
app.post("/consultations/:id/suggestion/approve", async (req, res) => {
    try {
        const c = await loadConsultationFull(req.params.id, req.userId);
        if (!c) return res.status(404).json({ error: "Not found" });
        const sd = sdOf(c);
        const plan = sd.suggested_plan;
        if (!plan || !Array.isArray(plan.items)) {
            return res.status(400).json({ error: "No suggestion to add" });
        }
        if (plan.status === "approved")
            return res.status(409).json({ error: "Already added" });

        const ids = new Set(
            Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [],
        );
        const picked = plan.items.filter((i) => ids.has(i.id));
        if (!picked.length)
            return res.status(400).json({ error: "Select at least one item" });
        const brandMap =
            req.body?.brands && typeof req.body.brands === "object"
                ? req.body.brands
                : {};
        const brandUses = [];
        const rx =
            sd.prescription && typeof sd.prescription === "object"
                ? sd.prescription
                : {};
        const cur = (k) => (Array.isArray(rx[k]) ? rx[k] : []);
        const low = (v) =>
            String(v || "")
                .trim()
                .toLowerCase();
        const seen = (list, name) =>
            list.some((e) => low(e?.name) === low(name));

        const next = {
            medications: [...cur("medications")],
            diagnosis: [...cur("diagnosis")],
            followup: [...cur("followup")],
        };
        for (const it of picked) {
            if (it.kind === "medication") {
                if (!seen(next.medications, it.name)) {
                    const brand = pstr(
                        typeof brandMap[it.id] === "string"
                            ? brandMap[it.id]
                            : "",
                        80,
                    );
                    next.medications.push({
                        name: it.name,
                        duration: it.duration || "",
                        dosage: Array.isArray(it.dosage) ? it.dosage : [],
                        instructions: it.instructions || "",
                        ...(brand ? { brand } : {}),
                    });
                    if (brand)
                        brandUses.push({
                            name: it.name,
                            dosage: it.dosage,
                            brand,
                        });
                }
            } else if (it.kind === "diagnosis") {
                if (!seen(next.diagnosis, it.name))
                    next.diagnosis.push({ name: it.name });
            } else if (it.kind === "followup") {
                const dup = next.followup.some(
                    (e) =>
                        low(e?.advice) === low(it.advice) &&
                        low(e?.next_visit_duration) ===
                            low(it.next_visit_duration),
                );
                if (!dup) {
                    next.followup.push({
                        next_visit_duration: it.next_visit_duration || "",
                        date: "",
                        advice: it.advice || "",
                    });
                }
            }
        }

        // Same cleaning and code lookup your prescription editor uses
        const cleaned = {};
        for (const key of ["medications", "diagnosis", "followup"]) {
            cleaned[key] = await sanitizeRxList(key, next[key], cur(key));
        }
        const updated = await afterConsultationEdit(c.id, {
            ...sd,
            prescription: { ...rx, ...cleaned },
            suggested_plan: {
                ...plan,
                status: "approved",
                approved_at: new Date().toISOString(),
                approved_ids: [...ids],
            },
        });
        brandUses.forEach((b) =>
            brands.bump(req.userId, b.name, b.dosage, b.brand).catch(() => {}),
        );
        res.json({
            prescription: updated.prescription,
            suggested_plan: updated.suggested_plan,
            consultation_summary: updated.consultation_summary,
        });
    } catch (err) {
        console.log("⚠️ Suggestion approve failed:", err.message);
        res.status(500).json({ error: "Failed to add to the prescription" });
    }
});
const voiceUpload = multer({
    dest: "uploads/",
    limits: { fileSize: 10 * 1024 * 1024 },
});

const istTodayLong = () =>
    new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    }).format(new Date());

const vList = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const vStr = (v, n) => pstr(typeof v === "string" ? v : "", n);

// One entry per section that supports voice. D2 adds the history sections here.
function cleanVoiceRx(obj) {
    const out = { symptoms: [], medications: [], diagnosis: [], followup: [] };
    for (const e of vList(obj?.symptoms, 15)) {
        const name = vStr(e?.name, 120);
        if (name)
            out.symptoms.push({
                name,
                duration: vStr(e?.duration, 60),
                notes: vStr(e?.notes, 300),
            });
    }
    for (const e of vList(obj?.medications, 15)) {
        const name = vStr(e?.name, 120);
        if (!name) continue;
        const dosage = (Array.isArray(e?.dosage) ? e.dosage : [e?.dosage])
            .map((x) => vStr(x, 80))
            .filter(Boolean)
            .slice(0, 6);
        out.medications.push({
            name,
            duration: vStr(e?.duration, 60),
            dosage,
            instructions: vStr(e?.instructions, 200),
        });
    }
    for (const e of vList(obj?.diagnosis, 10)) {
        const name = vStr(e?.name, 120);
        if (name) out.diagnosis.push({ name });
    }
    for (const e of vList(obj?.followup, 3)) {
        const row = {
            next_visit_duration: vStr(e?.next_visit_duration, 60),
            date: vStr(e?.date, 40),
            advice: vStr(e?.advice, 300),
        };
        if (row.next_visit_duration || row.date || row.advice)
            out.followup.push(row);
    }
    return out;
}

const VITAL_NAMES = [
    "Systolic Blood Pressure",
    "Diastolic Blood Pressure",
    "Body Temperature",
    "Respiration",
    "Body Weight",
    "Body Height",
];
const vitalName = (n) =>
    VITAL_NAMES.find(
        (x) =>
            x.toLowerCase() ===
            String(n || "")
                .trim()
                .toLowerCase(),
    ) || null;
const asText = (v) => (v === null || v === undefined ? "" : String(v));

function cleanAllVoice(obj) {
    const o = obj && typeof obj === "object" ? obj : {};
    const strList = (v, n, max) =>
        (Array.isArray(v)
            ? v
            : typeof v === "string" && v
              ? v.split(/[,;]/)
              : []
        )
            .map((x) => vStr(asText(x), n))
            .filter(Boolean)
            .slice(0, max);
    const simple = (key, fields, max = 15) => {
        const out = [];
        for (const e of vList(o[key], max)) {
            const row = {};
            for (const [f, n] of fields) row[f] = vStr(asText(e?.[f]), n);
            if (row.name) out.push(row);
        }
        return out;
    };

    const vitals = [];
    const seen = new Set();
    for (const e of vList(o.vitals, 12)) {
        const name = vitalName(e?.name);
        const value = vStr(asText(e?.value), 30);
        if (name && value && !seen.has(name)) {
            seen.add(name);
            vitals.push({ name, value });
        }
    }

    const medication_history = [];
    for (const e of vList(o.medication_history, 15)) {
        const name = vStr(e?.name, 120);
        if (!name) continue;
        medication_history.push({
            name,
            dosage: vStr(asText(e?.dosage), 80),
            duration: vStr(e?.duration, 60),
            status: vStr(e?.status, 40),
            instruction: strList(e?.instruction, 100, 6),
        });
    }

    const family_history = [];
    for (const e of vList(o.family_history, 10)) {
        const relationship = vStr(e?.relationship, 60);
        const illness = strList(e?.illness, 100, 8);
        if (relationship || illness.length) {
            family_history.push({
                relationship,
                illness,
                notes: vStr(e?.notes, 300),
            });
        }
    }

    const system_review = [];
    for (const e of vList(o.system_review, 12)) {
        const name = vStr(e?.name, 80);
        const findings = strList(e?.findings, 150, 12);
        if (name || findings.length) {
            system_review.push({ name, findings, notes: vStr(e?.notes, 300) });
        }
    }

    const investigation_history = [];
    for (const e of vList(o.investigation_history, 8)) {
        const readings = vList(e?.readings, 20)
            .map((r) => ({
                investigation_name: vStr(r?.investigation_name, 120),
                result: vStr(asText(r?.result), 60),
                unit: vStr(r?.unit, 30),
                interpretation: vStr(r?.interpretation, 60),
                notes: vStr(r?.notes, 200),
            }))
            .filter((r) => r.investigation_name);
        if (readings.length) {
            investigation_history.push({
                name: vStr(e?.name, 120),
                date: vStr(e?.date, 40),
                readings,
            });
        }
    }

    return {
        vitals,
        allergies: simple("allergies", [
            ["name", 120],
            ["notes", 300],
        ]),
        conditions: simple("conditions", [
            ["name", 120],
            ["duration", 60],
            ["notes", 300],
        ]),
        medication_history,
        investigation_history,
        procedures: simple("procedures", [
            ["name", 120],
            ["date", 40],
            ["notes", 300],
        ]),
        system_review,
        family_history,
        lifestyle_habits: simple("lifestyle_habits", [
            ["name", 120],
            ["frequency", 60],
            ["duration", 60],
            ["notes", 300],
        ]),
        social_history: simple("social_history", [
            ["name", 120],
            ["notes", 300],
        ]),
        other_history: simple("other_history", [
            ["name", 120],
            ["notes", 300],
        ]),
        prescription: cleanVoiceRx(o.prescription),
    };
}

const countRows = (rows) =>
    Object.entries(rows).reduce(
        (n, [k, v]) =>
            n +
            (k === "prescription"
                ? Object.values(v).reduce((m, a) => m + a.length, 0)
                : v.length),
        0,
    );
// ---- values the doctor can change by voice ----
const TX = (label, max = 120) => ({ label, type: "text", max });
const LS = (label, max = 100) => ({ label, type: "list", max });
const EDIT_SECTIONS = [
    {
        sec: "vitals",
        path: "vitals",
        label: "Vitals",
        title: (e) => e.name,
        fields: { value: TX("Value", 30) },
    },
    {
        sec: "allergies",
        path: "allergies",
        label: "Allergy",
        title: (e) => e.name,
        fields: { name: TX("Name"), notes: TX("Notes", 300) },
    },
    {
        sec: "conditions",
        path: "conditions",
        label: "Condition",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            duration: TX("Duration", 60),
            notes: TX("Notes", 300),
        },
    },
    {
        sec: "medication_history",
        path: "medication_history",
        label: "Medicine taken",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            dosage: TX("Dosage", 80),
            duration: TX("Duration", 60),
            status: TX("Status", 40),
            instruction: LS("Instructions"),
        },
    },
    {
        sec: "procedures",
        path: "procedures",
        label: "Procedure",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            date: TX("Date", 40),
            notes: TX("Notes", 300),
        },
    },
    {
        sec: "lifestyle_habits",
        path: "lifestyle_habits",
        label: "Lifestyle",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            frequency: TX("Frequency", 60),
            duration: TX("Duration", 60),
            notes: TX("Notes", 300),
        },
    },
    {
        sec: "social_history",
        path: "social_history",
        label: "Social history",
        title: (e) => e.name,
        fields: { name: TX("Name"), notes: TX("Notes", 300) },
    },
    {
        sec: "other_history",
        path: "other_history",
        label: "Other history",
        title: (e) => e.name,
        fields: { name: TX("Name"), notes: TX("Notes", 300) },
    },
    {
        sec: "family_history",
        path: "family_history",
        label: "Family history",
        title: (e) => e.relationship,
        fields: {
            relationship: TX("Relative", 60),
            illness: LS("Illness"),
            notes: TX("Notes", 300),
        },
    },
    {
        sec: "system_review",
        path: "system_review",
        label: "System review",
        title: (e) => e.name,
        fields: { name: TX("System", 80), notes: TX("Notes", 300) },
    },
    {
        sec: "prescription.symptoms",
        path: "prescription.symptoms",
        label: "Symptom",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            duration: TX("Duration", 60),
            notes: TX("Notes", 300),
        },
    },
    {
        sec: "prescription.medications",
        path: "prescription.medications",
        label: "Prescribed",
        title: (e) => e.name,
        fields: {
            name: TX("Name"),
            duration: TX("Duration", 60),
            dosage: LS("Dosage", 80),
            instructions: TX("Instructions", 200),
            brand: TX("Brand", 80),
        },
    },
    {
        sec: "prescription.diagnosis",
        path: "prescription.diagnosis",
        label: "Diagnosis",
        title: (e) => e.name,
        fields: { name: TX("Name") },
    },
    {
        sec: "prescription.followup",
        path: "prescription.followup",
        label: "Follow up",
        title: (e) => e.next_visit_duration || e.date || "Follow up",
        fields: {
            next_visit_duration: TX("When", 60),
            date: TX("Date", 40),
            advice: TX("Advice", 300),
        },
    },
];
const READING_SECTION = {
    sec: "investigation_history.readings",
    label: "Test result",
    title: (r) => r.investigation_name,
    fields: {
        investigation_name: TX("Test"),
        result: TX("Result", 60),
        unit: TX("Unit", 30),
        interpretation: TX("Interpretation", 60),
        notes: TX("Notes", 200),
    },
};

const asList = (v) =>
    Array.isArray(v)
        ? v.map((x) => asText(x).trim()).filter(Boolean)
        : asText(v).trim()
          ? [asText(v).trim()]
          : [];
const flat = (v) =>
    (Array.isArray(v) ? v.map(asText).join(", ") : asText(v))
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, " ")
        .trim();

// Every editable row in the record, each with an id such as "vitals.0"
function buildEditIndex(sd) {
    const out = [];
    for (const def of EDIT_SECTIONS) {
        const list = def.path.split(".").reduce((o, k) => o?.[k], sd);
        (Array.isArray(list) ? list : []).forEach((entry, i) => {
            if (entry && typeof entry === "object")
                out.push({ id: `${def.sec}.${i}`, def, entry, i });
        });
    }
    (Array.isArray(sd.investigation_history)
        ? sd.investigation_history
        : []
    ).forEach((inv, i) =>
        (Array.isArray(inv?.readings) ? inv.readings : []).forEach(
            (entry, j) => {
                if (entry && typeof entry === "object") {
                    out.push({
                        id: `${READING_SECTION.sec}.${i}.${j}`,
                        def: READING_SECTION,
                        entry,
                        i,
                        j,
                    });
                }
            },
        ),
    );
    return out.slice(0, 150);
}

// The record as text for the model
function editIndexText(index) {
    if (!index.length) return "(none)";
    return index
        .map(({ id, def, entry }) => {
            const fields = Object.entries(def.fields)
                .map(
                    ([k, spec]) =>
                        `${k}=${JSON.stringify(spec.type === "list" ? asList(entry[k]) : asText(entry[k]))}`,
                )
                .join(" | ");
            return `[${id}] ${def.label}: ${pstr(def.title(entry), 80) || "(unnamed)"} | ${fields}`;
        })
        .join("\n");
}

function editValue(raw, spec) {
    if (spec.type === "list") {
        const a = Array.isArray(raw)
            ? raw
            : typeof raw === "string"
              ? raw.split(/[,;]/)
              : [];
        return a
            .map((x) => vStr(asText(x).trim(), spec.max))
            .filter(Boolean)
            .slice(0, 8);
    }
    return vStr(asText(raw).trim(), spec.max);
}

// Checks every proposed change against the record as it is now. Voice never clears a value.
function findEdits(rawEdits, index) {
    const byId = new Map(index.map((r) => [r.id, r]));
    const out = new Map();
    for (const e of vList(rawEdits, 40)) {
        const row = byId.get(vStr(e?.id, 80));
        const field = vStr(e?.field, 40);
        const spec = row?.def.fields[field];
        if (!row || !spec) continue;
        const value = editValue(e?.value, spec);
        if (Array.isArray(value) ? value.length === 0 : !value) continue;
        const was = row.entry[field];
        if (flat(was) === flat(value)) continue;
        out.set(`${row.id}|${field}`, {
            id: row.id,
            sec: row.def.sec,
            i: row.i,
            j: row.j ?? null,
            field,
            type: spec.type,
            label: spec.label,
            section: row.def.label,
            title: pstr(row.def.title(row.entry), 120),
            old: spec.type === "list" ? asList(was).join(", ") : asText(was),
            new: spec.type === "list" ? value.join(", ") : value,
            value,
        });
    }
    return [...out.values()];
}

// Names that change need fresh codes. This feeds the lookup warm-up.
function withEditedNames(rows, edits) {
    const out = { ...rows, prescription: { ...rows.prescription } };
    for (const e of edits) {
        if (e.field !== "name" || e.type !== "text") continue;
        if (e.sec.startsWith("prescription.")) {
            const k = e.sec.split(".")[1];
            out.prescription[k] = [
                ...(out.prescription[k] || []),
                { name: e.value },
            ];
        } else if (Array.isArray(out[e.sec])) {
            out[e.sec] = [...out[e.sec], { name: e.value }];
        }
    }
    return out;
}
const VOICE_SECTIONS = {
    all: {
        label: "Consultation record",
        skeleton: `{
  "vitals": [{ "name": "", "value": "" }],
  "allergies": [{ "name": "", "notes": "" }],
  "conditions": [{ "name": "", "duration": "", "notes": "" }],
  "medication_history": [{ "name": "", "dosage": "", "duration": "", "status": "", "instruction": [] }],
  "investigation_history": [{ "name": "", "date": "", "readings": [{ "investigation_name": "", "result": "", "unit": "", "interpretation": "", "notes": "" }] }],
  "procedures": [{ "name": "", "date": "", "notes": "" }],
  "system_review": [{ "name": "", "findings": [], "notes": "" }],
  "family_history": [{ "relationship": "", "illness": [], "notes": "" }],
  "lifestyle_habits": [{ "name": "", "frequency": "", "duration": "", "notes": "" }],
  "social_history": [{ "name": "", "notes": "" }],
  "other_history": [{ "name": "", "notes": "" }],
  "prescription": {
    "symptoms": [{ "name": "", "duration": "", "notes": "" }],
    "medications": [{ "name": "", "duration": "", "dosage": [], "instructions": "" }],
    "diagnosis": [{ "name": "" }],
    "followup": [{ "next_visit_duration": "", "date": "", "advice": "" }]
  },
      "edits": [{ "id": "", "field": "", "value": "" }]
}`,
        rules: `Where each thing goes:
- Today's complaint, what brings the patient in now with how long: prescription.symptoms. "name", "duration", "notes".
- Medicines the doctor prescribes today: prescription.medications. "name" (with strength if said, for example "Paracetamol 500 mg"), "duration" (for example "5 days"), "dosage" (a list of short strings, for example ["1-0-1"] or ["twice daily"]), "instructions" (for example "after food").
- Diagnosis the doctor states today: prescription.diagnosis, "name".
- Follow-up: prescription.followup. "next_visit_duration" is how long until the next visit, for example "3 days". "date" only when a specific calendar date is said, written like "25 Oct 2026". Today is {{today}}. "advice" holds advice for the patient, including tests the doctor tells the patient to get.
- Medicines the patient already takes or took before today: medication_history. "name", "dosage" (short text), "duration", "status" (for example "Ongoing" or "Stopped"), "instruction" (a list).
- Long-term or past illnesses: conditions. "name", "duration", "notes".
- Allergies: allergies. "name", "notes" (for example the reaction).
- Past operations or procedures: procedures. "name", "date", "notes".
- Illnesses in relatives: family_history. "relationship" (for example "Father"), "illness" (a list), "notes".
- Examination findings by body system: system_review. "name" is the body system, for example "Cardiovascular". "findings" is a list of short findings. "notes".
- Lab or scan results with values: investigation_history. "name" is the report, for example "Lipid profile". "date". "readings" is a list of objects with "investigation_name", "result", "unit", "interpretation", "notes".
- Habits such as smoking, alcohol, exercise, sleep, diet: lifestyle_habits. "name", "frequency", "duration", "notes".
- Occupation, living situation, marital status, support at home: social_history. "name", "notes".
- Anything else about the history that fits nowhere above, such as travel: other_history. "name", "notes".
- Vital signs: vitals. Use exactly these names and units, converting if needed: "Systolic Blood Pressure" (mmHg), "Diastolic Blood Pressure" (mmHg), "Body Temperature" (°F), "Respiration" (per minute), "Body Weight" (kgs), "Body Height" (ft, decimal feet, for example 5 ft 6 in is 5.5). "value" is the number only. Blood pressure 120 over 80 gives two entries.
- Put each fact in one place only. Leave a list empty when the doctor did not speak about it.
- Changing values already in the record: the saved rows are listed under "Existing record". When the doctor corrects or changes something already there ("change", "make it", "correct that", "update", "actually", "not X but Y", "it should be"), put it in "edits" and not in the lists above. Give the row's id, the field name exactly as listed, and the new value. Match by what the doctor names: "temperature" is the row named Body Temperature, "paracetamol" is the prescribed row with Paracetamol in its name. If it could mean two different rows, skip it. A fact that is not in the record yet goes in the lists above as before. For a vital, the field is "value" and the value is the number only. For list fields (dosage, instruction, illness) give a list of short strings. Never delete anything. Never change a field the doctor did not talk about.`,
        clean: cleanAllVoice,
    },
};
// Returns cleaned rows, or null when the model gave nothing readable
// Returns { rows, edits }, or null when the model gave nothing readable
async function parseVoice(spec, heard, record = "(none)") {
    const today = istTodayLong();
    const base = fs
        .readFileSync("voice-edit-prompt.md", "utf-8")
        .replace("{{rules}}", () => spec.rules)
        .replace("{{section}}", () => spec.label)
        .replace("{{skeleton}}", () => spec.skeleton)
        .replace("{{record}}", () => record)
        .replaceAll("{{today}}", () => today)
        .replace("{{heard}}", () => heard);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const payload = {
                model: "gemma4:31b-cloud",
                prompt:
                    attempt === 0
                        ? base
                        : `${base}\n\nIMPORTANT: Your previous reply could not be read. Reply with exactly one valid JSON object. Nothing else.`,
                stream: false,
            };
            if (attempt > 0) payload.format = "json";
            const r = await axios.post(
                "https://ollama.com/api/generate",
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                    },
                    timeout: 60000,
                },
            );
            const obj = parseModelJson(r.data?.response);
            if (obj) return { rows: spec.clean(obj), edits: obj.edits };
        } catch (err) {
            console.log(
                `⚠️ Voice parse attempt ${attempt + 1} failed:`,
                err.message,
            );
        }
        if (attempt === 0) await sleep(500);
    }
    return null;
}

app.post(
    "/voice/parse",
    (req, res, next) =>
        voiceUpload.single("audio")(req, res, (err) =>
            err
                ? res.status(400).json({
                      error: "That recording is too large. Keep it under 2 minutes.",
                  })
                : next(),
        ),
    async (req, res) => {
        const file = req.file;
        try {
            const spec = VOICE_SECTIONS[String(req.body?.section || "all")];
            if (!spec)
                return res.status(400).json({ error: "Unknown section" });
            if (!file || file.size < 1500) {
                return res
                    .status(400)
                    .json({ error: "No speech was recorded" });
            }

            let heard = "";
            let language = "unknown";
            try {
                const out = await transcribeWithElevenLabs(
                    file.path,
                    file.originalname,
                    file.mimetype,
                );
                heard = (out.transcript || "").trim();
                language = out.language || "unknown";
            } catch (err) {
                console.log(
                    "❌ Voice transcription failed:",
                    err.response?.data || err.message,
                );
                return res.status(502).json({
                    error: "Couldn't understand the recording. Please try again.",
                });
            }

            if (heard.length < 3) {
                return res.json({
                    heard: "",
                    language,
                    rows: spec.clean({}),
                    empty: true,
                });
            }

            // The record so far, so a spoken correction can point at a saved row
            let sd = {};
            let index = [];
            const cid = String(req.body?.consultation_id || "");
            if (spec === VOICE_SECTIONS.all && cid) {
                const c = await loadConsultationFull(cid, req.userId).catch(
                    () => null,
                );
                if (c) {
                    sd = sdOf(c);
                    index = buildEditIndex(sd);
                }
            }

            const parsed = await parseVoice(spec, heard, editIndexText(index));
            if (!parsed) {
                return res.status(502).json({
                    error: "Couldn't understand the recording. Please try again.",
                });
            }
            const rows = parsed.rows;
            const rawEdits = Array.isArray(parsed.edits)
                ? [...parsed.edits]
                : [];

            // A spoken value for a vital that already has one is a change, not a new row
            if (index.length && Array.isArray(rows.vitals)) {
                const vit = Array.isArray(sd.vitals) ? sd.vitals : [];
                rows.vitals = rows.vitals.filter((v) => {
                    const i = vit.findIndex((x) => x?.name === v.name);
                    if (i < 0 || !asText(vit[i]?.value).trim()) return true;
                    rawEdits.push({
                        id: `vitals.${i}`,
                        field: "value",
                        value: v.value,
                    });
                    return false;
                });
            }

            const edits = findEdits(rawEdits, index).map((e) => ({
                id: e.id,
                field: e.field,
                label: e.label,
                section: e.section,
                title: e.title,
                old: e.old,
                new: e.new,
                value: e.value,
            }));
            res.json({
                heard,
                language,
                rows,
                edits,
                empty: countRows(rows) === 0 && edits.length === 0,
            });
        } catch (err) {
            console.log("❌ Voice route failed:", err.message);
            res.status(500).json({
                error: "Couldn't understand the recording. Please try again.",
            });
        } finally {
            if (file) fs.unlink(file.path, () => {});
        }
    },
);
app.post("/consultations/:id/voice/apply", async (req, res) => {
    try {
        const c = await loadConsultationFull(req.params.id, req.userId);
        if (!c) return res.status(404).json({ error: "Not found" });

        const rows = VOICE_SECTIONS.all.clean(req.body?.rows); // never trust the browser's shape
        const sd = sdOf(c);

        // Every change is checked against the record as it is now, and against the value the doctor saw
        const index = buildEditIndex(sd);
        const rawEdits = Array.isArray(req.body?.edits)
            ? req.body.edits.slice(0, 40)
            : [];
        const sentOld = new Map(
            rawEdits.map((e) => [
                `${vStr(e?.id, 80)}|${vStr(e?.field, 40)}`,
                asText(e?.old),
            ]),
        );
        const edits = findEdits(rawEdits, index).filter(
            (e) => flat(sentOld.get(`${e.id}|${e.field}`)) === flat(e.old),
        );
        if (edits.length < rawEdits.length)
            console.log(
                `voice apply: skipped ${rawEdits.length - edits.length} change(s)`,
            );
        if (countRows(rows) === 0 && edits.length === 0) {
            return res
                .status(400)
                .json({
                    error: "Nothing to apply. The record may have changed. Try again.",
                });
        }

        const t0 = Date.now();
        await warmCodes(withEditedNames(rows, edits)); // all lookups at once
        const tLookup = Date.now() - t0;

        const next = { ...sd };
        const patch = {};
        const arrOf = (k) => (Array.isArray(sd[k]) ? sd[k] : []);
        const editsFor = (sec) => edits.filter((e) => e.sec === sec);
        const withEdits = (list, sec) => {
            const out = list.map((x) =>
                x && typeof x === "object" ? { ...x } : x,
            );
            editsFor(sec).forEach((e) => {
                if (out[e.i] && typeof out[e.i] === "object")
                    out[e.i][e.field] = e.value;
            });
            return out;
        };

        for (const key of [
            "allergies",
            "conditions",
            "medication_history",
            "procedures",
            "lifestyle_habits",
            "social_history",
            "other_history",
        ]) {
            if (!rows[key].length && !editsFor(key).length) continue;
            patch[key] = next[key] = await sanitizeSimpleList(
                SIMPLE_SECTIONS[key],
                [...withEdits(arrOf(key), key), ...rows[key]],
                arrOf(key),
            );
        }
        if (rows.family_history.length || editsFor("family_history").length) {
            patch.family_history = next.family_history =
                await sanitizeFamilyHistory(
                    [
                        ...withEdits(arrOf("family_history"), "family_history"),
                        ...rows.family_history,
                    ],
                    arrOf("family_history"),
                );
        }
        if (rows.system_review.length || editsFor("system_review").length) {
            patch.system_review = next.system_review =
                await sanitizeSystemReview(
                    [
                        ...withEdits(arrOf("system_review"), "system_review"),
                        ...rows.system_review,
                    ],
                    arrOf("system_review"),
                );
        }

        const readingEdits = editsFor("investigation_history.readings");
        if (rows.investigation_history.length || readingEdits.length) {
            const base = arrOf("investigation_history").map((inv) => ({
                ...inv,
                readings: (Array.isArray(inv?.readings)
                    ? inv.readings
                    : []
                ).map((r) => ({ ...r })),
            }));
            readingEdits.forEach((e) => {
                const r = base[e.i]?.readings?.[e.j];
                if (r) r[e.field] = e.value;
            });
            patch.investigation_history = next.investigation_history =
                await sanitizeInvestigations(
                    [...base, ...rows.investigation_history],
                    arrOf("investigation_history"),
                );
        }

        const vitalsIn = [
            ...rows.vitals,
            ...editsFor("vitals")
                .map((e) => ({
                    name: arrOf("vitals")[e.i]?.name,
                    value: e.value,
                }))
                .filter((v) => v.name),
        ];
        if (vitalsIn.length)
            patch.vitals = next.vitals = await sanitizeVitals(
                vitalsIn,
                sd.vitals,
            );

        const rxIn = rows.prescription;
        const rx =
            sd.prescription && typeof sd.prescription === "object"
                ? sd.prescription
                : {};
        const cur = (k) => (Array.isArray(rx[k]) ? rx[k] : []);
        const cleaned = {};
        for (const key of [
            "symptoms",
            "medications",
            "diagnosis",
            "followup",
        ]) {
            const sec = `prescription.${key}`;
            if (!rxIn[key].length && !editsFor(sec).length) continue;
            cleaned[key] = await sanitizeRxList(
                key,
                [...withEdits(cur(key), sec), ...rxIn[key]],
                cur(key),
            );
        }
        if (Object.keys(cleaned).length)
            patch.prescription = next.prescription = { ...rx, ...cleaned };

        const { error: saveErr } = await supabase
            .from("consultations")
            .update({ structured_data: next })
            .eq("id", c.id)
            .eq("owner_id", req.userId);
        if (saveErr) throw saveErr;

        console.log(
            `voice apply: lookups ${tLookup} ms, total ${Date.now() - t0} ms`,
        );
        res.json({ patch }); // the overview refreshes separately
    } catch (err) {
        console.log("⚠️ Voice apply failed:", err.message);
        res.status(500).json({
            error: "Couldn't add to the record. Please try again.",
        });
    }
});
async function refreshSummary(consultationId, owner) {
    const c = await loadConsultationFull(consultationId, owner);
    if (!c) return null;
    const summary = await regenerateConsultationSummary(sdOf(c));
    // Read again, so edits made while the model was thinking are not overwritten
    const { data: fresh, error } = await supabase
        .from("consultations")
        .select("structured_data")
        .eq("id", consultationId)
        .eq("owner_id", owner)
        .maybeSingle();
    if (error || !fresh) return null;
    const up = await supabase
        .from("consultations")
        .update({
            structured_data: {
                ...(fresh.structured_data || {}),
                consultation_summary: summary,
            },
        })
        .eq("id", consultationId)
        .eq("owner_id", owner);
    if (up.error) throw up.error;
    regeneratePatientSummary(c.patient_id).catch(() => {});
    return summary;
}

app.post("/consultations/:id/summary/refresh", async (req, res) => {
    try {
        const summary = await refreshSummary(req.params.id, req.userId);
        if (!summary) return res.status(404).json({ error: "Not found" });
        res.json({ consultation_summary: summary });
    } catch (err) {
        console.log("⚠️ Summary refresh failed:", err.message);
        res.status(500).json({ error: "Couldn't refresh the summary" });
    }
});
const CODE_FIELDS = new Set([
    "snomed_ct_code",
    "icd10_code",
    "rxnorm_code",
    "loinc_code",
    "interpretation_snomed_code",
]);
const CODE_ARRAYS = new Set(["snomed_ct_codes", "icd10_codes"]);
const CODE_SECTIONS = new Set([
    "allergies",
    "conditions",
    "procedures",
    "lifestyle_habits",
    "social_history",
    "medication_history",
    "investigation_history",
    "system_review",
    "family_history",
    "prescription",
]);
const vocabOfField = (k) =>
    k.startsWith("snomed") || k === "interpretation_snomed_code"
        ? "snomed"
        : k.startsWith("icd10")
          ? "icd10"
          : k.startsWith("rxnorm")
            ? "rxnorm"
            : k.startsWith("loinc")
              ? "loinc"
              : null;

// Finds the exact field a path points at. Anything unexpected returns null.
function locateCode(sd, path) {
    if (!Array.isArray(path) || path.length < 2 || path.length > 8) return null;
    if (!CODE_SECTIONS.has(path[0])) return null;
    const ok = (s) =>
        (Number.isInteger(s) && s >= 0 && s < 1000) ||
        (typeof s === "string" && /^[a-z0-9_]+$/.test(s));
    if (!path.every(ok)) return null;
    const last = path[path.length - 1];
    const isIdx = Number.isInteger(last);
    const key = isIdx ? path[path.length - 2] : last;
    if (isIdx ? !CODE_ARRAYS.has(key) : !CODE_FIELDS.has(key)) return null;
    let cur = sd;
    for (const seg of path.slice(0, isIdx ? -2 : -1)) {
        if (
            cur == null ||
            typeof cur !== "object" ||
            !Object.prototype.hasOwnProperty.call(cur, seg)
        )
            return null;
        cur = cur[seg];
    }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    return { owner: cur, key, index: isIdx ? last : null };
}

function applyConfirmed(loc, code, term) {
    const { owner, key, index } = loc;
    if (index === null) {
        owner[key] = code;
        owner[`${key}_verified`] = true;
        owner[`${key}_corrected`] = false;
        owner[`${key}_umls_term`] = term;
        owner[`${key}_status`] = "confirmed";
        owner[`${key}_alts`] = [];
        if (key === "snomed_ct_code" && "snomed_ct_term" in owner)
            owner.snomed_ct_term = term;
    } else {
        const set = (name, v) => {
            const a = Array.isArray(owner[name]) ? [...owner[name]] : [];
            a[index] = v;
            owner[name] = a;
        };
        set(key, code);
        set(`${key}_verified`, true);
        set(`${key}_corrected`, false);
        set(`${key}_terms`, term);
        set(`${key}_status`, "confirmed");
        set(`${key}_alts`, []);
    }
}

app.get("/codes/search", async (req, res) => {
    try {
        const vocab = String(req.query.vocab || "");
        if (!["snomed", "icd10", "rxnorm", "loinc"].includes(vocab)) {
            return res.status(400).json({ error: "Unknown vocabulary" });
        }
        res.json({
            results: await terminology.searchCodes(
                vocab,
                String(req.query.q || ""),
            ),
        });
    } catch (err) {
        console.log("⚠️ Code search failed:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// Run this first. It shows what your keys can reach.
app.get("/codes/health", async (req, res) => {
    try {
        res.json(await terminology.health());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Confirm, or swap, one or more codes
app.put("/consultations/:id/code", async (req, res) => {
    try {
        const c = await loadConsultationFull(req.params.id, req.userId);
        if (!c) return res.status(404).json({ error: "Not found" });
        const changes = Array.isArray(req.body?.changes)
            ? req.body.changes.slice(0, 60)
            : [];
        if (!changes.length)
            return res.status(400).json({ error: "Nothing to change" });

        const sd = JSON.parse(JSON.stringify(sdOf(c)));
        for (const ch of changes) {
            const loc = locateCode(sd, ch?.path);
            if (!loc)
                return res.status(400).json({ error: "Invalid code location" });
            const code = String(ch?.code ?? "").trim();
            if (!/^[A-Za-z0-9.\-]{1,40}$/.test(code))
                return res.status(400).json({ error: "Invalid code" });

            const stored =
                loc.index === null
                    ? loc.owner[loc.key]
                    : loc.owner[loc.key]?.[loc.index];
            let term;
            if (stored === code) {
                // Confirming the code already shown. No lookup needed.
                term =
                    (loc.index === null
                        ? loc.owner[`${loc.key}_umls_term`]
                        : loc.owner[`${loc.key}_terms`]?.[loc.index]) || "";
            } else {
                const found = await terminology.exists(
                    vocabOfField(loc.key),
                    code,
                );
                if (!found.ok)
                    return res.status(502).json({
                        error: "The code service is not reachable. Try again.",
                    });
                if (!found.name)
                    return res.status(400).json({
                        error: `Code ${code} was not found. Pick one from the list.`,
                    });
                term = found.name;
            }
            applyConfirmed(loc, code, term);
        }

        const { error } = await supabase
            .from("consultations")
            .update({ structured_data: sd })
            .eq("id", c.id)
            .eq("owner_id", req.userId);
        if (error) throw error;
        res.json({ structured_data: sd });
    } catch (err) {
        console.log("⚠️ Code update failed:", err.message);
        res.status(500).json({
            error: "Couldn't save the code. Please try again.",
        });
    }
});
app.post("/brands/lookup", async (req, res) => {
    try {
        const items = Array.isArray(req.body?.items)
            ? req.body.items.slice(0, 20)
            : [];
        const results = await Promise.all(
            items.map((it) =>
                brands
                    .lookupOne(req.userId, {
                        id: String(it?.id || ""),
                        name: pstr(it?.name, 160),
                        dosage: Array.isArray(it?.dosage)
                            ? it.dosage.map((d) => pstr(d, 80)).slice(0, 6)
                            : [],
                    })
                    .catch((err) => {
                        console.log("⚠️ Brand lookup failed:", err.message);
                        return { id: String(it?.id || ""), brands: [] };
                    }),
            ),
        );
        res.json({ results });
    } catch (err) {
        console.log("⚠️ Brand lookup route failed:", err.message);
        res.status(500).json({ error: "Couldn't load brands" });
    }
});

app.get("/brands/medicines", async (req, res) => {
    try {
        res.json({
            results: await brands.searchIngredients(String(req.query.q || "")),
        });
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

app.get("/brands/families", async (req, res) => {
    try {
        res.json(await brands.families(String(req.query.ing || "")));
    } catch (err) {
        res.status(500).json({ error: "Couldn't load brands" });
    }
});

app.get("/brand-prefs", async (req, res) => {
    try {
        res.json({ prefs: await brands.listPrefs(req.userId) });
    } catch (err) {
        res.status(500).json({ error: "Couldn't load preferences" });
    }
});

app.put("/brand-prefs", async (req, res) => {
    try {
        await brands.saveFavourites(
            req.userId,
            req.body?.ing_key,
            req.body?.families,
        );
        res.json({ ok: true });
    } catch (err) {
        console.log("⚠️ Save brand prefs failed:", err.message);
        res.status(400).json({ error: "Couldn't save" });
    }
});

app.put("/brand-prefs/favourite", async (req, res) => {
    try {
        await brands.setFavourite(
            req.userId,
            req.body?.ing_key,
            req.body?.family,
            !!req.body?.favourite,
        );
        res.json({ ok: true });
    } catch (err) {
        console.log("⚠️ Favourite failed:", err.message);
        res.status(400).json({ error: "Couldn't save" });
    }
});
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
