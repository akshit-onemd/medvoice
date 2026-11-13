// Template routes: library, my templates, create with Gemma, try on a visit, change a note's template,
// and saving a note's own (custom) sections.
const fs = require("fs");
const path = require("path");
const store = require("./store");
const { validateTemplate } = require("./validate");
const { repairTemplate } = require("./repair");
const { prepareExtraction } = require("./prepare");
const { buildExtractionPrompt } = require("./prompt");
const { normalizeExtraction } = require("./normalize");
const general = require("./general");
const { SECTION_TYPES } = require("./sectionTypes");

const MAX_OWN = 50;
const BUILDER_PROMPT = path.join(__dirname, "..", "template-builder-prompt.md");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOTS = new Set([
    ...Object.values(SECTION_TYPES).map((t) => t.storage[0]),
    "custom",
    "consultation_summary",
]);

function register(app, d) {
    const { supabase, llm, consentGateByConsultation } = d;
    const fail = (res, label, err, msg, code = 500) => {
        console.log(`⚠️ ${label}:`, err?.message || err);
        res.status(code).json({ error: msg });
    };
    const notFound = (err) => /not found/i.test(err?.message || "");

    app.get("/templates/:id", async (req, res) => {
        try {
            const t = await store.getTemplate(supabase, req.userId, req.params.id);
            if (!t) return res.status(404).json({ error: "Not found" });
            res.json(t);
        } catch (err) {
            fail(res, "Template load failed", err, "Couldn't load the template");
        }
    });

    app.post("/templates", async (req, res) => {
        try {
            const v = validateTemplate(req.body?.definition);
            if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
            if ((await store.countOwn(supabase, req.userId)) >= MAX_OWN)
                return res.status(400).json({ error: `You can keep up to ${MAX_OWN} templates` });
            const id = await store.createTemplate(supabase, req.userId, v.value);
            res.json(await store.getTemplate(supabase, req.userId, id));
        } catch (err) {
            fail(res, "Template create failed", err, "Couldn't save the template");
        }
    });

    app.put("/templates/:id", async (req, res) => {
        try {
            const v = validateTemplate(req.body?.definition);
            if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
            await store.updateTemplate(supabase, req.userId, req.params.id, v.value);
            res.json(await store.getTemplate(supabase, req.userId, req.params.id));
        } catch (err) {
            if (notFound(err)) return res.status(404).json({ error: "Not found" });
            fail(res, "Template update failed", err, "Couldn't save the template");
        }
    });

    app.delete("/templates/:id", async (req, res) => {
        try {
            await store.deleteTemplate(supabase, req.userId, req.params.id);
            res.json({ ok: true });
        } catch (err) {
            if (notFound(err)) return res.status(404).json({ error: "Not found" });
            fail(res, "Template delete failed", err, "Couldn't delete the template");
        }
    });

    // Add a library template to "My templates" so it can be changed
    app.post("/templates/:id/copy", async (req, res) => {
        try {
            const t = await store.getTemplate(supabase, req.userId, req.params.id);
            if (!t) return res.status(404).json({ error: "Not found" });
            if ((await store.countOwn(supabase, req.userId)) >= MAX_OWN)
                return res.status(400).json({ error: `You can keep up to ${MAX_OWN} templates` });
            const v = validateTemplate({
                ...t.definition,
                name: String(req.body?.name || t.name).slice(0, 80),
                specialty: t.specialty,
                kind: t.kind,
            });
            if (!v.ok) return res.status(400).json({ error: v.errors[0] });
            const id = await store.createTemplate(supabase, req.userId, v.value);
            res.json(await store.getTemplate(supabase, req.userId, id));
        } catch (err) {
            fail(res, "Template copy failed", err, "Couldn't add the template");
        }
    });

    // Create with Gemma: the conversation so far and the current draft in, a reply and a full draft out
    app.post("/templates/ai", async (req, res) => {
        try {
            const msgs = (Array.isArray(req.body?.messages) ? req.body.messages : [])
                .slice(-12)
                .map((m) => ({
                    role: m?.role === "assistant" ? "Assistant" : "Doctor",
                    text: String(m?.text || "").slice(0, 2000),
                }))
                .filter((m) => m.text.trim());
            if (!msgs.length || msgs.at(-1).role !== "Doctor")
                return res.status(400).json({ error: "Say what the template is for" });
            const draft = req.body?.draft && typeof req.body.draft === "object" ? req.body.draft : null;
            const base = fs
                .readFileSync(BUILDER_PROMPT, "utf8")
                .replace("{{draft}}", () => (draft ? JSON.stringify(draft, null, 2) : "(none yet)"))
                .replace("{{messages}}", () => msgs.map((m) => `${m.role}: ${m.text}`).join("\n\n"));

            let prompt = base;
            let last = { reply: "", errors: ["The reply could not be read"] };
            for (let attempt = 0; attempt < 3; attempt++) {
                let obj = null;
                try {
                    const text = await llm.generate(prompt, { json: true, timeout: 120000 });
                    obj = d.parseModelJson(text);
                    if (!obj) console.log("⚠️ Template builder reply was not JSON:", String(text).slice(0, 200));
                } catch (err) {
                    console.log(`⚠️ Template builder attempt ${attempt + 1}:`, err.message);
                }
                // Some replies put the template at the top level instead of under "template"
                const rawT = obj?.template ?? (Array.isArray(obj?.sections) ? obj : null);
                const reply =
                    typeof obj?.reply === "string"
                        ? obj.reply.slice(0, 1000)
                        : typeof obj?.message === "string"
                          ? obj.message.slice(0, 1000)
                          : "";
                if (obj && !rawT) {
                    if (draft) return res.json({ reply: reply || "Tell me what to change.", template: draft });
                    prompt = `${base}\n\nIMPORTANT: Include the full template under "template" in your JSON reply.`;
                    continue;
                }
                if (rawT) {
                    const fixed = repairTemplate(rawT);
                    const v = validateTemplate(fixed || rawT);
                    if (v.ok) return res.json({ reply: reply || "Here is a draft.", template: v.value });
                    console.log("⚠️ Template builder draft rejected:", v.errors.slice(0, 5).join("; "));
                    last = { reply, errors: v.errors };
                    prompt = `${base}\n\nYour previous template had these problems. Fix all of them and reply again with the full JSON:\n- ${v.errors.slice(0, 10).join("\n- ")}`;
                } else {
                    prompt = `${base}\n\nIMPORTANT: Reply with exactly one valid JSON object. Nothing else.`;
                }
            }
            res.status(502).json({
                error: "Couldn't build that template. Try saying it differently.",
                reply: last.reply,
                errors: last.errors,
            });
        } catch (err) {
            fail(res, "Template builder failed", err, "Couldn't build the template");
        }
    });

    // Try a draft (or any template) on a past visit; nothing is saved
    app.post("/consultations/:id/template-preview", consentGateByConsultation, async (req, res) => {
        try {
            const v = validateTemplate(req.body?.definition);
            if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
            const c = await d.loadConsultationFull(req.params.id, req.userId);
            if (!c) return res.status(404).json({ error: "Not found" });
            const transcript = String(c.transcript || "").trim();
            if (transcript.length < 40)
                return res.status(400).json({ error: "This visit has no recording to try it on" });
            const prompt = buildExtractionPrompt(v.value, transcript);
            const out = normalizeExtraction(v.value, await d.extractStructured(prompt, []));
            d.stripRxnorm(out);
            d.blankCodes(out);
            res.json({ structured_data: out, definition: v.value });
        } catch (err) {
            fail(res, "Template preview failed", err, "Couldn't try the template. Please try again.");
        }
    });

    // Rebuild a note from its transcript with another template. Edits made on the note are replaced.
    app.post("/consultations/:id/retemplate", consentGateByConsultation, async (req, res) => {
        try {
            const templateId = String(req.body?.template_id || "");
            const t = UUID_RE.test(templateId)
                ? await store.getTemplate(supabase, req.userId, templateId)
                : null;
            if (!t) return res.status(404).json({ error: "Template not found" });
            const c = await d.loadConsultationFull(req.params.id, req.userId);
            if (!c) return res.status(404).json({ error: "Not found" });
            const transcript = String(c.transcript || "").trim();
            if (transcript.length < 40)
                return res.status(400).json({
                    error: "This visit has no recording, so its template can't be changed",
                });
            const { data: patient } = await supabase
                .from("patients")
                .select()
                .eq("id", c.patient_id)
                .eq("owner_id", req.userId)
                .maybeSingle();
            const chosen = await prepareExtraction({
                supabase,
                ownerId: req.userId,
                templateId,
                transcript,
                regContext: d.patientContext(patient),
            });
            let out = normalizeExtraction(chosen.definition, await d.extractStructured(chosen.prompt, []));
            d.stripRxnorm(out);
            d.blankCodes(out);
            out.template = chosen.template;
            const extracted = JSON.parse(JSON.stringify(out));

            // Keep what isn't part of the note itself (for example billing flags)
            const old = c.structured_data && typeof c.structured_data === "object" ? c.structured_data : {};
            const keep = Object.fromEntries(
                Object.entries(old).filter(
                    ([k]) => !ROOTS.has(k) && !["template", "suggested_plan", "codes_pending_since"].includes(k),
                ),
            );
            const now = new Date().toISOString();
            const next = {
                ...keep,
                ...out,
                codes_pending_since: now,
                suggested_plan: { status: "generating", started_at: now },
            };
            const { error } = await supabase
                .from("consultations")
                .update({ structured_data: next })
                .eq("id", c.id)
                .eq("owner_id", req.userId);
            if (error) throw error;
            d.finishInBackground(c.id, req.userId, extracted, { transcript, patient });
            if (patient) d.regeneratePatientSummary(patient.id).catch(() => {});
            res.json({ structured_data: next });
        } catch (err) {
            fail(res, "Change template failed", err, "Couldn't change the template. Please try again.");
        }
    });

    // Save one of the note's own sections (values, list, checklist, choice, score, text)
    app.put("/consultations/:id/custom/:sectionId", consentGateByConsultation, async (req, res) => {
        try {
            const c = await d.loadConsultationFull(req.params.id, req.userId);
            if (!c) return res.status(404).json({ error: "Not found" });
            const sd = c.structured_data && typeof c.structured_data === "object" ? c.structured_data : {};
            const t = await store.templateForNote(supabase, req.userId, sd.template);
            const s = (t.definition.sections || []).find(
                (x) => x.id === req.params.sectionId && general.GENERAL_TYPES.includes(x.type),
            );
            if (!s) return res.status(404).json({ error: "Section not found" });
            const value = general.normalizeGeneral(s, req.body?.value);
            const custom = { ...(sd.custom && typeof sd.custom === "object" ? sd.custom : {}), [s.id]: value };
            const { error } = await supabase
                .from("consultations")
                .update({ structured_data: { ...sd, custom } })
                .eq("id", c.id)
                .eq("owner_id", req.userId);
            if (error) throw error;
            res.json({ custom, value });
        } catch (err) {
            fail(res, "Custom section save failed", err, "Couldn't save. Please try again.");
        }
    });
}

// Lines for the AI plan and the overview, from a note's own sections
async function customContext(supabase, sd) {
    if (!sd?.custom || typeof sd.custom !== "object" || !Object.keys(sd.custom).length) return "";
    const t = await store.noteDefinition(supabase, sd.template);
    return (t.definition.sections || [])
        .filter((s) => general.GENERAL_TYPES.includes(s.type))
        .map((s) => general.contextLine(s, sd.custom[s.id]))
        .filter(Boolean)
        .join("\n");
}

module.exports = { register, customContext };
