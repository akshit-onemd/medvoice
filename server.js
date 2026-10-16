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
const SAB_MAP = {
    snomed_ct_code: "SNOMEDCT_US",
    icd10_code: "ICD10CM",
    icd10_pcs_code: "ICD10PCS",
    rxnorm_code: "RXNORM",
    loinc_code: "LNC",
    interpretation_snomed_code: "SNOMEDCT_US",
};

// In-memory cache so repeated codes (fixed vitals LOINC codes, common
// conditions across patients) don't re-hit UMLS every single request.
const codeCache = new Map();
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
async function verifyAndCorrectCode(sab, code, term) {
    // No code at all, but we have a name to search on — try to fill one in.
    if (!code) {
        if (!term)
            return { code: "", verified: null, corrected: false, term: null };
        const found = await searchCode(sab, term);
        return found
            ? {
                  code: found.code,
                  verified: true,
                  corrected: true,
                  term: found.name,
              }
            : { code: "", verified: null, corrected: false, term: null };
    }

    const cacheKey = `verify:${sab}:${code}`;
    let check = codeCache.get(cacheKey);
    if (!check) {
        try {
            const response = await axios.get(
                `${UTS_BASE_URL}/content/current/source/${sab}/${encodeURIComponent(code)}`,
                { params: { apiKey: UMLS_API_KEY } },
            );
            check = { valid: true, name: response.data?.result?.name || null };
        } catch (err) {
            check =
                err.response?.status === 404
                    ? { valid: false, name: null }
                    : { valid: null, name: null };
            if (err.response?.status !== 404) {
                console.log(
                    `⚠️ UMLS verify failed for ${sab}/${code}:`,
                    err.response?.status,
                    err.message,
                );
            }
        }
        codeCache.set(cacheKey, check);
    }

    if (check.valid === true) {
        return { code, verified: true, corrected: false, term: check.name };
    }

    if (check.valid === false && term) {
        const found = await searchCode(sab, term);
        if (found) {
            return {
                code: found.code,
                verified: true,
                corrected: true,
                term: found.name,
            };
        }
        return { code, verified: false, corrected: false, term: null }; // couldn't find a replacement — keep it flagged
    }

    return { code, verified: check.valid, corrected: false, term: check.name };
}
async function searchCode(sab, term) {
    if (!term) return null;
    const cacheKey = `search:${sab}:${term.toLowerCase()}`;
    if (codeCache.has(cacheKey)) return codeCache.get(cacheKey);

    let result = null;
    try {
        const response = await axios.get(`${UTS_BASE_URL}/search/current`, {
            params: {
                apiKey: UMLS_API_KEY,
                string: term,
                sabs: sab,
                returnIdType: "code",
                pageSize: 1,
            },
        });
        const hit = response.data?.result?.results?.[0];
        if (hit && hit.ui && hit.ui !== "NONE") {
            result = { code: hit.ui, name: hit.name };
        }
    } catch (err) {
        console.log(
            `⚠️ UMLS search failed for ${sab}/"${term}":`,
            err.response?.status,
            err.message,
        );
    }
    codeCache.set(cacheKey, result);
    return result;
}
function termForField(entry, key) {
    switch (key) {
        case "snomed_ct_code":
        case "icd10_code":
        case "icd10_pcs_code":
            return entry.snomed_ct_term || entry.name || null;
        case "rxnorm_code":
            return entry.name || null;
        case "loinc_code":
            return entry.investigation_name || entry.name || null;
        case "interpretation_snomed_code":
            return entry.interpretation || null;
        default:
            return null;
    }
}
async function verifyEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    for (const key of Object.keys(SAB_MAP)) {
        if (!(key in entry)) continue;
        const sab = SAB_MAP[key];
        const term = termForField(entry, key);
        const result = await verifyAndCorrectCode(sab, entry[key], term);
        entry[key] = result.code;
        entry[`${key}_verified`] = result.verified;
        entry[`${key}_corrected`] = result.corrected;
        entry[`${key}_umls_term`] = result.term;
    }
}
async function verifyFamilyIllness(entry) {
    if (!Array.isArray(entry.illness)) return;
    const snomed = [];
    const icd10 = [];
    for (let i = 0; i < entry.illness.length; i++) {
        const term = entry.illness[i];
        snomed.push(
            await verifyAndCorrectCode(
                "SNOMEDCT_US",
                entry.snomed_ct_codes?.[i] || "",
                term,
            ),
        );
        icd10.push(
            await verifyAndCorrectCode(
                "ICD10CM",
                entry.icd10_codes?.[i] || "",
                term,
            ),
        );
    }
    entry.snomed_ct_codes = snomed.map((r) => r.code);
    entry.snomed_ct_codes_verified = snomed.map((r) => r.verified);
    entry.snomed_ct_codes_corrected = snomed.map((r) => r.corrected);
    entry.icd10_codes = icd10.map((r) => r.code);
    entry.icd10_codes_verified = icd10.map((r) => r.verified);
    entry.icd10_codes_corrected = icd10.map((r) => r.corrected);
}
async function verifyFindings(findings) {
    if (!Array.isArray(findings)) return;
    for (const f of findings) {
        const result = await verifyAndCorrectCode(
            "SNOMEDCT_US",
            f.snomed_ct_code,
            f.finding,
        );
        f.snomed_ct_code = result.code;
        f.snomed_ct_code_verified = result.verified;
        f.snomed_ct_code_corrected = result.corrected;
    }
}
async function verifyAllCodes(data) {
    for (const [sectionName, section] of Object.entries(data)) {
        if (sectionName === "vitals" || sectionName === "consultation_summary")
            continue;

        if (sectionName === "family_history") {
            for (const entry of section) {
                await verifyFamilyIllness(entry);
            }
            continue;
        }

        if (
            sectionName === "prescription" &&
            section &&
            typeof section === "object"
        ) {
            for (const subList of Object.values(section)) {
                if (!Array.isArray(subList)) continue;
                for (const entry of subList) {
                    await verifyEntry(entry);
                }
            }
            continue;
        }

        if (!Array.isArray(section)) continue;

        for (const entry of section) {
            await verifyEntry(entry);
            if (Array.isArray(entry.readings)) {
                for (const reading of entry.readings)
                    await verifyEntry(reading);
            }
            if (Array.isArray(entry.findings)) {
                await verifyFindings(entry.findings);
            }
        }
    }
    return data;
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
app.post(
    "/process-audio",
    upload.fields([
        { name: "file", maxCount: 1 },
        { name: "attachments", maxCount: 20 },
    ]),
    async (req, res) => {
        const startTime = Date.now();

        console.log("\n========================================");
        console.log("🚀 /process-audio request received");
        console.log("========================================");

        try {
            const audioFile = req.files?.file?.[0];
            const attachmentFiles = req.files?.attachments || [];

            if (!audioFile && attachmentFiles.length === 0) {
                console.log("❌ No file received");
                return res
                    .status(400)
                    .json({ error: "No audio file or documents uploaded" });
            }
            console.log("📁 File received:");
            if (audioFile) {
                console.log("   Original name:", audioFile.originalname);
                console.log("   Saved path:", audioFile.path);
                console.log("   Size:", audioFile.size, "bytes");
                console.log("   MIME type:", audioFile.mimetype);
            } else {
                console.log("   No audio file — processing attachments only");
            }
            if (attachmentFiles.length > 0) {
                console.log(`   Attachments: ${attachmentFiles.length}`);
                attachmentFiles.forEach((f) =>
                    console.log("     -", f.originalname, f.mimetype),
                );
            }
            const patientId = (req.body.patient_id || "").trim() || null;
            const patientName = (req.body.patient_name || "").trim();
            const patientPhone = (req.body.patient_phone || "").trim();
            const patientAge = req.body.patient_age
                ? parseInt(req.body.patient_age, 10)
                : null;
            const patientGender = req.body.patient_gender || null;
            const sttProvider = (
                req.body.stt_provider || "whisper"
            ).toLowerCase();
            if (!patientId && (!patientName || !patientPhone)) {
                return res.status(400).json({
                    error: "Select an existing patient, or provide a name and phone number for a new one",
                });
            }
            async function runPipeline(
                transcript,
                language,
                diarizedTranscript,
            ) {
                console.log("\n📝 Transcript:");
                console.log(transcript);

                if (diarizedTranscript) {
                    console.log("\n🗣️ Diarized Transcript:");
                    console.log(diarizedTranscript);
                }

                console.log("\n📄 Loading template.json...");
                const template = fs.readFileSync("template.json", "utf-8");

                console.log("📄 Loading prompt.txt...");
                let prompt = fs.readFileSync("prompt.md", "utf-8");
                prompt = prompt
                    .replace("{{template}}", template)
                    .replace("{{transcript}}", transcript);

                console.log("✅ Prompt prepared");
                console.log("Prompt length:", prompt.length);

                console.log("\n📎 Reading attachments...");
                let attachmentImages = [];
                for (const file of attachmentFiles) {
                    try {
                        const imgs = await attachmentToImages(file);
                        attachmentImages = attachmentImages.concat(imgs);
                    } catch (err) {
                        console.log(
                            `⚠️ Failed to read ${file.originalname}:`,
                            err.message,
                        );
                    } finally {
                        fs.unlink(file.path, () => {});
                    }
                }

                console.log("\n🤖 Calling Ollama...");
                console.log("Model: gemma4:31b-cloud");
                const ollamaStart = Date.now();

                try {
                    const ollamaResponse = await axios.post(
                        "https://ollama.com/api/generate",
                        {
                            model: "gemma4:31b-cloud",
                            prompt: prompt,
                            images: attachmentImages,
                            stream: false,
                        },
                        {
                            headers: {
                                Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
                            },
                        },
                    );

                    console.log(
                        `🤖 Ollama completed in ${(Date.now() - ollamaStart) / 1000} seconds`,
                    );

                    let structuredData;
                    try {
                        let rawResponse = ollamaResponse.data.response.trim();
                        rawResponse = rawResponse
                            .replace(/```json/g, "")
                            .replace(/```/g, "")
                            .trim();
                        if (!rawResponse.startsWith("{"))
                            throw new Error("Invalid JSON response");
                        structuredData = JSON.parse(rawResponse);
                        console.log("✅ Ollama response parsed as JSON");
                        console.log(structuredData);
                    } catch (err) {
                        console.log(
                            "⚠️ Ollama response is not valid JSON, returning raw response.",
                        );
                        structuredData = {
                            raw_response: ollamaResponse.data.response,
                        };
                    }

                    console.log("\n========================================");
                    console.log("✅ PROCESS COMPLETE");
                    console.log(
                        "⏱️ Total time:",
                        (Date.now() - startTime) / 1000,
                        "seconds",
                    );
                    console.log("========================================\n");

                    if (structuredData && !structuredData.raw_response) {
                        console.log("\n🔎 Verifying codes against UMLS...");
                        try {
                            structuredData =
                                await verifyAllCodes(structuredData);
                            console.log("✅ Code verification complete");
                        } catch (err) {
                            console.log(
                                "⚠️ UMLS verification step failed, returning unverified codes:",
                                err.message,
                            );
                        }
                    }
                    console.log("\n💾 Resolving patient...");
                    let patient = null;
                    try {
                        if (patientId) {
                            // existing patient: must belong to this user
                            const { data, error } = await supabase
                                .from("patients")
                                .select()
                                .eq("id", patientId)
                                .eq("owner_id", req.userId)
                                .single();
                            if (error) throw error;
                            patient = data;
                        } else {
                            const { data, error } = await supabase
                                .from("patients")
                                // new patient: stamp the owner
                                .insert({
                                    name: patientName,
                                    age: patientAge,
                                    gender: patientGender,
                                    phone: patientPhone,
                                    owner_id: req.userId,
                                })
                                .select()
                                .single();

                            if (error) {
                                if (error.code === "23505") {
                                    // Phone already exists — someone raced us, or the search missed it. Use the existing record.
                                    console.log(
                                        "⚠️ Phone already registered, using existing patient",
                                    );
                                    const { data: existing, error: fetchErr } =
                                        await supabase
                                            .from("patients")
                                            // duplicate-phone fallback: look up within this user's patients only
                                            .select()
                                            .eq("phone", patientPhone)
                                            .eq("owner_id", req.userId)
                                            .single();
                                    if (fetchErr) throw fetchErr;
                                    patient = existing;
                                } else {
                                    throw error;
                                }
                            } else {
                                patient = data;
                            }
                        }
                    } catch (err) {
                        console.log(
                            "⚠️ Patient resolution failed:",
                            err.message,
                        );
                    }

                    let savedRecord = null;
                    let createdAt = null;
                    if (patient) {
                        try {
                            const {
                                data: consultation,
                                error: consultationError,
                            } = await supabase
                                .from("consultations")
                                // consultation insert
                                .insert({
                                    patient_id: patient.id,
                                    owner_id: req.userId,
                                    language,
                                    transcript,
                                    diarized_transcript:
                                        diarizedTranscript || null,
                                    structured_data: structuredData,
                                })
                                .select()
                                .single();
                            if (consultationError) throw consultationError;
                            createdAt = consultation.created_at;

                            savedRecord = {
                                patient_id: patient.id,
                                patient_name: patient.name,
                                patient_age:
                                    ageFromDob(patient.dob) ?? patient.age,
                                patient_gender: patient.gender,
                                patient_phone: patient.phone,
                                consultation_id: consultation.id,
                            };
                            console.log("✅ Saved:", savedRecord);

                            regeneratePatientSummary(patient.id).catch((err) =>
                                console.log(
                                    "⚠️ Patient summary regeneration failed:",
                                    err.message,
                                ),
                            );
                        } catch (err) {
                            console.log(
                                "⚠️ Consultation save failed:",
                                err.message,
                            );
                        }
                    }

                    res.json({
                        language,
                        transcript,
                        diarizedTranscript: diarizedTranscript || null,
                        structured_data: structuredData,
                        created_at: createdAt,
                        saved: savedRecord,
                    });
                } catch (ollamaError) {
                    console.log(
                        "\n❌ PIPELINE ERROR (Ollama call or post-processing)",
                    );
                    if (ollamaError.response) {
                        console.log("Status:", ollamaError.response.status);
                        console.log("Response:", ollamaError.response.data);
                    } else {
                        console.log(ollamaError.message);
                    }
                    return res.status(500).json({
                        error: "Ollama request failed",
                        details: ollamaError.message,
                    });
                }
            }

            if (audioFile) {
                const providerLabels = {
                    sarvam: "Sarvam",
                    elevenlabs: "ElevenLabs Scribe",
                    whisper: "Groq Whisper",
                };
                const providerLabel =
                    providerLabels[sttProvider] || "Groq Whisper";
                console.log(`\n🎙️ Transcribing via ${providerLabel}...`);
                try {
                    const transcribeFns = {
                        sarvam: transcribeWithSarvam,
                        elevenlabs: transcribeWithElevenLabs,
                    };
                    const transcribeFn =
                        transcribeFns[sttProvider] || transcribeWithGroq;
                    const { transcript, language, diarizedTranscript } =
                        await transcribeFn(
                            audioFile.path,
                            audioFile.originalname,
                            audioFile.mimetype,
                        );
                    await runPipeline(transcript, language, diarizedTranscript);
                } catch (err) {
                    console.log(
                        `❌ ${providerLabel} transcription failed:`,
                        err.response?.data || err.message,
                    );
                    return res.status(500).json({
                        error: "Transcription failed",
                        details:
                            err.response?.data?.error?.message ||
                            err.response?.data?.message ||
                            err.message,
                    });
                } finally {
                    fs.unlink(audioFile.path, () => {});
                }
            } else {
                console.log("\n🎙️ Skipping Whisper — no audio file provided");
                await runPipeline("", "unknown");
            }
        } catch (err) {
            console.log("\n❌ SERVER ERROR");
            console.log(err);

            res.status(500).json({
                error: err.message,
            });
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
    medications: ["name", "duration", "instructions"], // dosage handled separately (array)
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
                    await verifyEntry(entry);
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
        fields: ["name", "notes"],
        codeFields: ["snomed_ct_code", "icd10_code"],
    },
    conditions: {
        fields: ["name", "duration", "start_date", "end_date", "notes"],
        codeFields: ["snomed_ct_code", "icd10_code"],
    },
    procedures: {
        fields: ["name", "date", "notes"],
        codeFields: ["snomed_ct_code", "icd10_pcs_code"],
    },
    lifestyle_habits: {
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
        fields: ["name", "notes"],
        codeFields: ["snomed_ct_code"],
    },
    other_history: { fields: ["name", "notes"], codeFields: [] },
    medication_history: {
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
                await verifyEntry(entry);
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
                    await verifyEntry(entry);
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
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
