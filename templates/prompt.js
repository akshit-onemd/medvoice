// Builds the extraction prompt for a template: today's prompt.md with the template's own
// JSON shape, plus a short list of renamed or explained sections when there are any.
const fs = require("fs");
const path = require("path");
const { SECTION_TYPES, storageKey } = require("./sectionTypes");
const { GENERAL_TYPES, skeletonFor, promptLine } = require("./general");
const generalSections = (def) => (def.sections || []).filter((s) => GENERAL_TYPES.includes(s.type));

const PROMPT_MD = path.join(__dirname, "..", "prompt.md");
const SUMMARY = { overview: "", details: [] };

const clone = (v) => JSON.parse(JSON.stringify(v));
function setAt(obj, keys, value) {
    let o = obj;
    keys.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
    o[keys.at(-1)] = value;
}

const TEMPLATE_PATH = path.join(__dirname, "..", "template.json");
const TEMPLATE_TEXT = fs.readFileSync(TEMPLATE_PATH, "utf8");
const TEMPLATE_JSON = JSON.parse(TEMPLATE_TEXT);

// Every storage path in template.json's own order, so a template's skeleton keeps the order
// the model has always seen, whatever order the template lists its sections in
const CANONICAL = [];
for (const [k, v] of Object.entries(TEMPLATE_JSON)) {
    if (k === "prescription") Object.keys(v).forEach((s) => CANONICAL.push(["prescription", s]));
    else if (k !== "consultation_summary") CANONICAL.push([k]);
}
const typeAt = new Map(
    Object.entries(SECTION_TYPES).map(([type, t]) => [t.storage.join("."), type]),
);
const typesOf = (def) => new Set((def.sections || []).map((s) => s.type));

// The empty record the model fills, with only this template's sections
function buildSkeleton(def) {
    const have = typesOf(def);
    const out = {};
    for (const keys of CANONICAL) {
        const type = typeAt.get(keys.join("."));
        if (type && have.has(type)) setAt(out, keys, clone(SECTION_TYPES[type].skeleton));
    }
    const custom = generalSections(def);
    if (custom.length) out.custom = Object.fromEntries(custom.map((s) => [s.id, skeletonFor(s)]));
    out.consultation_summary = clone(SUMMARY);
    return out;
}

// A template with every section and no renamed ones uses template.json exactly as written
const isFull = (def) => {
    const have = typesOf(def);
    return [...typeAt.values()].every((t) => have.has(t)) && !generalSections(def).length;
};

// One line per section whose name or meaning differs from the standard one
function sectionNotes(def) {
    const lines = [];
    for (const s of def.sections || []) {
        const t = SECTION_TYPES[s.type];
        if (!t) continue;
        const title = (s.title || "").trim();
        const extra = (s.instructions || "").trim();
        if ((!title || title === t.defaultTitle) && !extra) continue;
        lines.push(
            `- ${storageKey(s.type)} ("${title || t.defaultTitle}")${extra ? `: ${extra}` : ""}`,
        );
    }
    return lines;
}

function buildExtractionPrompt(def, transcript, promptText) {
    let text = promptText ?? fs.readFileSync(PROMPT_MD, "utf8");
    const notes = sectionNotes(def);
    const custom = generalSections(def).map(promptLine);
    if (notes.length || custom.length) {
        const at = text.indexOf("# Template");
        let block = "# Sections\n\n";
        if (notes.length)
            block += `This doctor's template names or explains some sections. Use these meanings when deciding where each fact goes:\n${notes.join("\n")}\n\n`;
        if (custom.length)
            block += `The template also has these sections of its own, under "custom". Fill them only from what was said; leave a value empty when it was not mentioned. A fact that belongs in one of these goes there and not in a standard section as well:\n${custom.join("\n")}\n\n`;
        text = at >= 0 ? text.slice(0, at) + block + text.slice(at) : block + text;
    }
    return text
        .replace("{{template}}", () =>
            isFull(def) && !notes.length
                ? TEMPLATE_TEXT
                : JSON.stringify(buildSkeleton(def), null, 4),
        )
        .replace("{{transcript}}", () => transcript);
}

module.exports = { buildSkeleton, buildExtractionPrompt };
