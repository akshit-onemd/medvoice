// Tidies a template the model wrote before it is checked: fixes ids and keys, maps near-miss
// type names, drops what can't be used. The model is close most of the time; this saves a retry.
const { SECTION_TYPES } = require("./sectionTypes");
const { GENERAL_TYPES } = require("./general");

const ALIASES = {
    symptoms: "complaints", chief_complaints: "complaints", presenting_complaints: "complaints",
    complaint: "complaints", presenting_symptoms: "complaints", history_of_present_illness: "complaints",
    medications: "prescription", medicines: "prescription", rx: "prescription", treatment: "prescription",
    prescribed: "prescription", prescription_medications: "prescription",
    follow_up: "followup", advice: "followup", plan: "followup",
    vital_signs: "vitals", vital: "vitals",
    allergy: "allergies",
    history: "conditions", past_history: "conditions", past_medical_history: "conditions",
    medical_history: "conditions", comorbidities: "conditions",
    current_medications: "medication_history", drug_history: "medication_history",
    medications_history: "medication_history",
    labs: "investigations", lab_results: "investigations", investigation: "investigations",
    investigation_history: "investigations", tests: "investigations",
    physical_examination: "examination", exam: "examination", system_review: "examination",
    review_of_systems: "examination", clinical_examination: "examination",
    surgeries: "procedures", surgical_history: "procedures", procedure: "procedures",
    habits: "lifestyle", lifestyle_habits: "lifestyle",
    social: "social_history",
    other: "other_history", notes: "other_history",
    diagnoses: "diagnosis", assessment: "diagnosis",
    value: "values", measurements: "values", numeric: "values", fields: "values",
    table: "list", rows: "list",
    checkbox: "checklist", checkboxes: "checklist",
    select: "choice", options: "choice", radio: "choice", multiselect: "choice", dropdown: "choice",
    scale: "score", rating: "score",
    textarea: "text", free_text: "text", paragraph: "text", note: "text",
};

const slug = (v) =>
    String(v ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
const startLetter = (k, prefix) => (/^[a-z]/.test(k) ? k : `${prefix}_${k}`.slice(0, 40));
const str = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "");
const labelOf = (x) => (typeof x === "string" || typeof x === "number" ? String(x) : x?.label || x?.name || x?.text || x?.value || "");

function unique(base, used) {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}_${n}`;
    used.add(id);
    return id;
}

function repairTemplate(raw) {
    let t = raw;
    if (typeof t === "string") {
        try {
            t = JSON.parse(t);
        } catch {
            return null;
        }
    }
    if (!t || typeof t !== "object") return null;
    const list = Array.isArray(t.sections) ? t.sections : [];
    const ids = new Set();
    const clinicalUsed = new Set();
    const sections = [];
    for (const s of list) {
        if (!s || typeof s !== "object") continue;
        let type = slug(s.type);
        type = ALIASES[type] || type;
        const clinical = !!SECTION_TYPES[type];
        if (!clinical && !GENERAL_TYPES.includes(type)) continue;
        if (clinical && clinicalUsed.has(type)) continue;
        if (clinical) clinicalUsed.add(type);

        const title = str(s.title || s.name || s.label, 60);
        const out = { type, title, instructions: str(s.instructions || s.description, 300) };

        if (type === "values" || type === "list") {
            const keys = new Set();
            out.fields = (Array.isArray(s.fields) ? s.fields : [])
                .map((f) => {
                    const label = str(labelOf(f), 60);
                    if (!label) return null;
                    const key = unique(startLetter(slug(f?.key || label) || "field", "f"), keys);
                    const field = { key, label };
                    if (type === "values") {
                        const unit = str(f?.unit, 20);
                        const range = str(f?.range || f?.normal_range, 40);
                        if (unit) field.unit = unit;
                        if (range) field.range = range;
                    }
                    return field;
                })
                .filter(Boolean)
                .slice(0, 20);
            if (!out.fields.length) {
                out.type = "text";
                delete out.fields;
            }
        }
        if (type === "checklist" || type === "choice") {
            const seen = new Set();
            const vals = (Array.isArray(s.items) ? s.items : Array.isArray(s.options) ? s.options : [])
                .map((x) => str(labelOf(x), 60))
                .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
                .slice(0, 20);
            if (!vals.length) out.type = "text";
            else if (type === "checklist") out.items = vals;
            else {
                out.options = vals;
                out.multiple = s.multiple === true || s.multiple === "true";
            }
        }
        if (type === "score") {
            let min = Number(s.min ?? 0);
            let max = Number(s.max ?? 10);
            if (!Number.isFinite(min)) min = 0;
            if (!Number.isFinite(max)) max = 10;
            if (min > max) [min, max] = [max, min];
            if (min === max) max = min + 10;
            Object.assign(out, { min, max });
        }
        const idBase = startLetter(slug(s.id) || (clinical ? type : slug(title)) || out.type, "s");
        out.id = unique(idBase, ids);
        if (!clinical && !out.title) out.title = out.id.replace(/_/g, " ");
        sections.push(out);
        if (sections.length >= 25) break;
    }
    const kind = slug(t.kind);
    return {
        name: str(t.name, 80) || "New template",
        specialty: str(t.specialty, 60),
        kind: ["new", "follow_up", "condition"].includes(kind) ? kind : kind === "followup" ? "follow_up" : "",
        description: str(t.description, 200),
        sections,
    };
}

module.exports = { repairTemplate };
