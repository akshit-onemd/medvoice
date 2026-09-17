const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const { pdf } = require("pdf-to-img");
const app = express();
require("dotenv").config();
const FormData = require("form-data");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);
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
        if (sectionName === "vitals") continue;

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
app.post(
    "/process-audio",
    upload.fields([
        { name: "file", maxCount: 1 },
        { name: "attachments", maxCount: 10 },
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

            if (!patientId && (!patientName || !patientPhone)) {
                return res.status(400).json({
                    error: "Select an existing patient, or provide a name and phone number for a new one",
                });
            }
            async function runPipeline(transcript, language) {
                console.log("\n📝 Transcript:");
                console.log(transcript);

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
                            const { data, error } = await supabase
                                .from("patients")
                                .select()
                                .eq("id", patientId)
                                .single();
                            if (error) throw error;
                            patient = data;
                        } else {
                            const { data, error } = await supabase
                                .from("patients")
                                .insert({
                                    name: patientName,
                                    age: patientAge,
                                    gender: patientGender,
                                    phone: patientPhone,
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
                                            .select()
                                            .eq("phone", patientPhone)
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
                    if (patient) {
                        try {
                            const {
                                data: consultation,
                                error: consultationError,
                            } = await supabase
                                .from("consultations")
                                .insert({
                                    patient_id: patient.id,
                                    language,
                                    transcript,
                                    structured_data: structuredData,
                                })
                                .select()
                                .single();
                            if (consultationError) throw consultationError;

                            savedRecord = {
                                patient_id: patient.id,
                                patient_name: patient.name,
                                consultation_id: consultation.id,
                            };
                            console.log("✅ Saved:", savedRecord);
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
                        structured_data: structuredData,
                        saved: savedRecord,
                    });
                } catch (ollamaError) {
                    console.log("\n❌ OLLAMA ERROR");
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
                console.log("\n🎙️ Transcribing via Groq Whisper...");
                try {
                    const { transcript, language } = await transcribeWithGroq(
                        audioFile.path,
                        audioFile.originalname,
                        audioFile.mimetype,
                    );
                    await runPipeline(transcript, language);
                } catch (err) {
                    console.log(
                        "❌ Groq transcription failed:",
                        err.response?.data || err.message,
                    );
                    return res.status(500).json({
                        error: "Transcription failed",
                        details:
                            err.response?.data?.error?.message || err.message,
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

    try {
        const { data, error } = await supabase
            .from("patients")
            .select("id, name, age, gender, phone")
            .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
            .limit(10);

        if (error) throw error;
        res.json({ patients: data });
    } catch (err) {
        console.log("⚠️ Patient search failed:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
