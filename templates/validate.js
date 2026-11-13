// Checks a template definition and fills in defaults.
// Returns every problem at once, so a doctor (or Gemma) can fix them in one go.
const { SECTION_TYPES } = require("./sectionTypes");
const { GENERAL_TYPES, DEFAULT_TITLES, validateGeneral } = require("./general");

const MAX_SECTIONS = 25;
const MAX_NAME = 80;
const MAX_TITLE = 60;
const MAX_INSTRUCTIONS = 300;
const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

const str = (v) => (typeof v === "string" ? v.trim() : "");

function validateTemplate(def) {
    const errors = [];
    const name = str(def?.name);
    if (!name) errors.push("Template name is required");
    else if (name.length > MAX_NAME) errors.push("Template name too long");

    const raw = Array.isArray(def?.sections) ? def.sections : [];
    if (!raw.length) errors.push("A template needs at least one section");
    if (raw.length > MAX_SECTIONS) errors.push(`At most ${MAX_SECTIONS} sections`);

    const ids = new Set();
    const typesUsed = new Set();
    const sections = [];
    for (const s of raw) {
        const id = str(s?.id);
        const type = str(s?.type);
        if (!ID_RE.test(id)) errors.push(`Section id "${id}" is invalid`);
        else if (ids.has(id)) errors.push(`Duplicate section id "${id}"`);
        ids.add(id);

        const known = SECTION_TYPES[type];
        const general = GENERAL_TYPES.includes(type);
        if (!known && !general) errors.push(`Unknown section type "${type}"`);
        else if (known && typesUsed.has(type))
            errors.push(`Section type "${type}" used more than once`);
        typesUsed.add(type);

        const title = str(s?.title) || known?.defaultTitle || DEFAULT_TITLES[type] || "";
        if (general && !title) errors.push(`Section "${id}" needs a title`);
        let settings = {};
        if (general) {
            const g = validateGeneral({ ...s, type }, id);
            errors.push(...g.errors);
            settings = g.value;
        }
        if (title.length > MAX_TITLE) errors.push(`Title too long in "${id}"`);
        const instructions = str(s?.instructions);
        if (instructions.length > MAX_INSTRUCTIONS)
            errors.push(`Instructions too long in "${id}"`);

        sections.push({
            id,
            type,
            title,
            instructions,
            ...settings,
            print: s?.print !== false,
            showEmpty: s?.showEmpty === true,
        });
    }
    return {
        ok: errors.length === 0,
        errors,
        value: {
            ...def,
            name,
            description: str(def?.description).slice(0, 200),
            sections,
        },
    };
}

module.exports = { validateTemplate, MAX_SECTIONS, ID_RE };
