// Shapes the model's answer to the template: only the template's sections, each present,
// each the right kind (list or object). Field-level cleaning stays in the existing code.
const { SECTION_TYPES } = require("./sectionTypes");
const { GENERAL_TYPES, normalizeGeneral } = require("./general");

const clone = (v) => JSON.parse(JSON.stringify(v));
const at = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, keys, value) {
    let o = obj;
    keys.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
    o[keys.at(-1)] = value;
}

function emptyFor(type) {
    // Vitals are a fixed list of measurements; every other list starts empty
    return type === "vitals" ? clone(SECTION_TYPES.vitals.skeleton) : [];
}

function normalizeExtraction(def, obj) {
    const src = obj && typeof obj === "object" ? obj : {};
    const out = {};
    for (const s of def.sections || []) {
        const t = SECTION_TYPES[s.type];
        if (!t) continue;
        const v = at(src, t.storage);
        setAt(out, t.storage, Array.isArray(v) ? v : emptyFor(s.type));
    }
    const custom = (def.sections || []).filter((s) => GENERAL_TYPES.includes(s.type));
    if (custom.length)
        out.custom = Object.fromEntries(
            custom.map((s) => [s.id, normalizeGeneral(s, src.custom?.[s.id])]),
        );
    const sum = src.consultation_summary;
    out.consultation_summary =
        sum && typeof sum === "object" && !Array.isArray(sum)
            ? {
                  overview: typeof sum.overview === "string" ? sum.overview : "",
                  details: Array.isArray(sum.details) ? sum.details : [],
              }
            : { overview: "", details: [] };
    return out;
}

module.exports = { normalizeExtraction };
