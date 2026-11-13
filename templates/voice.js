// The voice-edit instructions and JSON shape for a template: one placement rule per section
// the template has, then the rules every template shares.
const { SECTION_TYPES } = require("./sectionTypes");
const generic = require("./builtin/generic.json");
const { GENERAL_TYPES, skeletonFor, promptLine, normalizeGeneral, isEmptyGeneral } = require("./general");

// Today's rule order and the voice skeleton exactly as the server has always sent it
const RULE_ORDER = ["complaints", "prescription", "diagnosis", "followup", "medication_history", "conditions", "allergies", "procedures", "family_history", "examination", "investigations", "lifestyle", "social_history", "other_history", "vitals"];
const SKELETON_TEXT = "{\n  \"vitals\": [{ \"name\": \"\", \"value\": \"\" }],\n  \"allergies\": [{ \"name\": \"\", \"notes\": \"\" }],\n  \"conditions\": [{ \"name\": \"\", \"duration\": \"\", \"notes\": \"\" }],\n  \"medication_history\": [{ \"name\": \"\", \"brand\": \"\", \"dosage\": \"\", \"duration\": \"\", \"status\": \"\", \"instruction\": [] }],\n  \"investigation_history\": [{ \"name\": \"\", \"date\": \"\", \"readings\": [{ \"investigation_name\": \"\", \"result\": \"\", \"unit\": \"\", \"interpretation\": \"\", \"notes\": \"\" }] }],\n  \"procedures\": [{ \"name\": \"\", \"date\": \"\", \"notes\": \"\" }],\n  \"system_review\": [{ \"name\": \"\", \"findings\": [], \"notes\": \"\" }],\n  \"family_history\": [{ \"relationship\": \"\", \"illness\": [], \"notes\": \"\" }],\n  \"lifestyle_habits\": [{ \"name\": \"\", \"frequency\": \"\", \"duration\": \"\", \"notes\": \"\" }],\n  \"social_history\": [{ \"name\": \"\", \"notes\": \"\" }],\n  \"other_history\": [{ \"name\": \"\", \"notes\": \"\" }],\n  \"prescription\": {\n    \"symptoms\": [{ \"name\": \"\", \"duration\": \"\", \"notes\": \"\" }],\n    \"medications\": [{ \"name\": \"\", \"brand\": \"\", \"duration\": \"\", \"dosage\": [], \"instructions\": \"\" }],\n    \"diagnosis\": [{ \"name\": \"\" }],\n    \"followup\": [{ \"next_visit_duration\": \"\", \"date\": \"\", \"advice\": \"\" }]\n  },\n      \"edits\": [{ \"id\": \"\", \"field\": \"\", \"value\": \"\" }]\n}";
const SKELETON_ORDER = [];
for (const [k, v] of Object.entries(JSON.parse(SKELETON_TEXT))) {
    if (k === "prescription") Object.keys(v).forEach((s) => SKELETON_ORDER.push(["prescription", s]));
    else if (k !== "edits") SKELETON_ORDER.push([k]);
}
const typeAt = new Map(
    Object.entries(SECTION_TYPES).map(([type, t]) => [t.storage.join("."), type]),
);

const CLOSING = [
    "Put each fact in one place only. Leave a list empty when the doctor did not speak about it.",
    "Changing values already in the record: the saved rows are listed under \"Existing record\". When the doctor corrects or changes something already there (\"change\", \"make it\", \"correct that\", \"update\", \"actually\", \"not X but Y\", \"it should be\"), put it in \"edits\" and not in the lists above. Give the row's id, the field name exactly as listed, and the new value. Match by what the doctor names: \"temperature\" is the row named Body Temperature, \"paracetamol\" is the prescribed row with Paracetamol in its name. If it could mean two different rows, skip it. A fact that is not in the record yet goes in the lists above as before. For a vital, the field is \"value\" and the value is the number only. For list fields (dosage, instruction, illness) give a list of short strings. Never delete anything. Never change a field the doctor did not talk about."
];
const EDITS = [{ id: "", field: "", value: "" }];

function setAt(obj, keys, value) {
    let o = obj;
    keys.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
    o[keys.at(-1)] = value;
}

function voiceSpecFor(def) {
    const d = def && Array.isArray(def.sections) ? def : generic;
    const have = new Set(d.sections.map((s) => s.type));
    const lines = RULE_ORDER.filter((t) => have.has(t)).map(
        (t) => `- ${SECTION_TYPES[t].voiceRule}`,
    );
    const custom = d.sections.filter((s) => GENERAL_TYPES.includes(s.type));
    if (custom.length)
        lines.push(
            "- This template's own sections go under \"custom\", by section id. Only fill what the doctor says now:",
            ...custom.map((s) => `  ${promptLine(s)}`),
        );
    const full = RULE_ORDER.every((t) => have.has(t)) && !custom.length;
    let skeleton = SKELETON_TEXT;
    if (!full) {
        const out = {};
        for (const keys of SKELETON_ORDER) {
            const type = typeAt.get(keys.join("."));
            if (type && have.has(type))
                setAt(out, keys, JSON.parse(JSON.stringify(SECTION_TYPES[type].voiceSkeleton)));
        }
        if (custom.length) out.custom = Object.fromEntries(custom.map((s) => [s.id, skeletonFor(s)]));
        out.edits = EDITS;
        skeleton = JSON.stringify(out, null, 2);
    }
    return {
        label: "Consultation record",
        rules: ["Where each thing goes:", ...lines, ...CLOSING.map((l) => `- ${l}`)].join("\n"),
        skeleton,
    };
}

// Voice rows for sections this template doesn't have are emptied, so a voice edit can never
// add a section the template left out (whatever the browser sends).
function limitRowsToTemplate(def, rows) {
    const d = def && Array.isArray(def.sections) ? def : generic;
    const have = new Set(d.sections.map((s) => s.type));
    const out = JSON.parse(JSON.stringify(rows || {}));
    for (const [type, t] of Object.entries(SECTION_TYPES)) {
        if (have.has(type)) continue;
        let o = out;
        for (const k of t.storage.slice(0, -1)) o = o && o[k];
        if (o && Array.isArray(o[t.storage.at(-1)])) o[t.storage.at(-1)] = [];
    }
    // Custom sections: only this template's, each in its own shape
    const custom = d.sections.filter((s) => GENERAL_TYPES.includes(s.type));
    if (out.custom || custom.length) {
        const given = out.custom && typeof out.custom === "object" ? out.custom : {};
        out.custom = Object.fromEntries(
            custom
                .filter((s) => given[s.id] != null)
                .map((s) => [s.id, normalizeGeneral(s, given[s.id])])
                .filter(([id, v]) => !isEmptyGeneral(custom.find((s) => s.id === id), v)),
        );
    }
    return out;
}

module.exports = { voiceSpecFor, limitRowsToTemplate };
