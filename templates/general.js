// General section types: what a template adds beyond the clinical sections.
// Data for these lives at structured_data.custom[<section id>].
//   values    {fields:[{key,label,unit?,range?}]}        -> { <key>: "text" }
//   list      {fields:[{key,label}]}                      -> [ { <key>: "text" } ]
//   checklist {items:["Retinopathy", ...]}                -> [ { item, status: yes|no|not_examined|"", note } ]
//   choice    {options:[...], multiple?: bool}            -> { selected: [option, ...] }
//   score     {min, max}                                  -> { value: "number as text", note }
//   text      {}                                          -> { text }
const GENERAL_TYPES = ["values", "list", "checklist", "choice", "score", "text"];
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const STATUS = ["yes", "no", "not_examined", ""];
const str = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const arr = (v) => (Array.isArray(v) ? v : []);

const DEFAULT_TITLES = {
    values: "Values",
    list: "List",
    checklist: "Checklist",
    choice: "Choice",
    score: "Score",
    text: "Notes",
};

// Checks a general section's own settings. Returns { errors, value } (value = cleaned settings).
function validateGeneral(s, id) {
    const errors = [];
    const out = {};
    if (s.type === "values" || s.type === "list") {
        const fields = arr(s.fields);
        if (!fields.length) errors.push(`Section "${id}" needs at least one field`);
        if (fields.length > 20) errors.push(`Section "${id}" has more than 20 fields`);
        const keys = new Set();
        out.fields = fields.slice(0, 20).map((f, i) => {
            const label = str(f?.label, 60);
            const key = str(f?.key, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `field_${i + 1}`;
            const k = /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40);
            if (!label) errors.push(`A field in "${id}" has no label`);
            if (!KEY_RE.test(k)) errors.push(`Field key "${k}" in "${id}" is invalid`);
            else if (keys.has(k)) errors.push(`Duplicate field "${k}" in "${id}"`);
            keys.add(k);
            const field = { key: k, label };
            if (s.type === "values") {
                const unit = str(f?.unit, 20);
                const range = str(f?.range, 40);
                if (unit) field.unit = unit;
                if (range) field.range = range;
            }
            return field;
        });
    }
    if (s.type === "checklist" || s.type === "choice") {
        const name = s.type === "checklist" ? "items" : "options";
        const list = arr(s[name]).map((x) => str(x, 60)).filter(Boolean);
        if (!list.length) errors.push(`Section "${id}" needs at least one ${name === "items" ? "item" : "option"}`);
        if (list.length > 20) errors.push(`Section "${id}" has more than 20 ${name}`);
        if (new Set(list.map((x) => x.toLowerCase())).size !== list.length)
            errors.push(`Section "${id}" lists the same ${name === "items" ? "item" : "option"} twice`);
        out[name] = list.slice(0, 20);
        if (s.type === "choice") out.multiple = s.multiple === true;
    }
    if (s.type === "score") {
        const min = Number(s.min ?? 0);
        const max = Number(s.max ?? 10);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max)
            errors.push(`Section "${id}" needs a score range with min below max`);
        out.min = min;
        out.max = max;
    }
    return { errors, value: out };
}

// The empty shape the model fills
function skeletonFor(s) {
    switch (s.type) {
        case "values":
            return Object.fromEntries(s.fields.map((f) => [f.key, ""]));
        case "list":
            return [Object.fromEntries(s.fields.map((f) => [f.key, ""]))];
        case "checklist":
            return s.items.map((item) => ({ item, status: "", note: "" }));
        case "choice":
            return { selected: [] };
        case "score":
            return { value: "", note: "" };
        default:
            return { text: "" };
    }
}

// One line telling the model what this section holds and how to fill it
function promptLine(s) {
    const head = `- custom.${s.id} ("${s.title}")`;
    const how = {
        values: `values: ${s.fields?.map((f) => `"${f.key}" = ${f.label}${f.unit ? ` (${f.unit})` : ""}`).join(", ")}. Write each value as said, without the unit.`,
        list: `a list, one object per item, with ${s.fields?.map((f) => `"${f.key}" (${f.label})`).join(", ")}.`,
        checklist: `one entry per item listed; "status" is "yes" if present or done, "no" if absent or normal, "not_examined" if the doctor says it was not checked, "" if not discussed; "note" for details.`,
        choice: `"selected" is a list of the options that apply, copied exactly from: ${s.options?.map((o) => `"${o}"`).join(", ")}${s.multiple ? "" : " (one at most)"}.`,
        score: `"value" is a number from ${s.min} to ${s.max}; "note" for context.`,
        text: `"text" is a short paragraph.`,
    }[s.type];
    return `${head}: ${how}${s.instructions ? ` ${s.instructions}` : ""}`;
}

// Makes whatever came back fit the section; anything else is dropped
function normalizeGeneral(s, v) {
    switch (s.type) {
        case "values": {
            const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
            return Object.fromEntries(s.fields.map((f) => [f.key, str(o[f.key], 80)]));
        }
        case "list":
            return arr(v)
                .map((row) => Object.fromEntries(s.fields.map((f) => [f.key, str(row?.[f.key], 200)])))
                .filter((row) => Object.values(row).some(Boolean))
                .slice(0, 50);
        case "checklist": {
            const given = arr(v);
            return s.items.map((item) => {
                const g = given.find((x) => str(x?.item).toLowerCase() === item.toLowerCase()) || {};
                let status = str(g.status).toLowerCase().replace(/\s+/g, "_");
                if (status === "not_checked") status = "not_examined";
                return { item, status: STATUS.includes(status) ? status : "", note: str(g.note, 200) };
            });
        }
        case "choice": {
            const picked = arr(v?.selected).map((x) => str(x, 60).toLowerCase());
            const sel = s.options.filter((o) => picked.includes(o.toLowerCase()));
            return { selected: s.multiple ? sel : sel.slice(0, 1) };
        }
        case "score": {
            const n = Number(str(v?.value));
            const ok = str(v?.value) !== "" && Number.isFinite(n) && n >= s.min && n <= s.max;
            return { value: ok ? String(n) : "", note: str(v?.note, 200) };
        }
        default:
            return { text: str(v?.text ?? (typeof v === "string" ? v : ""), 2000) };
    }
}

const isEmptyGeneral = (s, d) => {
    switch (s.type) {
        case "values":
            return !Object.values(d || {}).some(Boolean);
        case "list":
            return !arr(d).length;
        case "checklist":
            return !arr(d).some((x) => x.status || x.note);
        case "choice":
            return !arr(d?.selected).length;
        case "score":
            return !d?.value;
        default:
            return !str(d?.text);
    }
};

// A readable line for other prompts (AI plan, overview): "Glycaemic profile: HbA1c 8.2 %; FBS 168 mg/dL"
function contextLine(s, d) {
    if (!d || isEmptyGeneral(s, d)) return "";
    let body = "";
    switch (s.type) {
        case "values":
            body = s.fields.filter((f) => d[f.key]).map((f) => `${f.label} ${d[f.key]}${f.unit ? ` ${f.unit}` : ""}`).join("; ");
            break;
        case "list":
            body = d.map((row) => s.fields.map((f) => row[f.key]).filter(Boolean).join(", ")).join("; ");
            break;
        case "checklist":
            body = d.filter((x) => x.status || x.note).map((x) => `${x.item}: ${x.status.replace("_", " ") || "-"}${x.note ? ` (${x.note})` : ""}`).join("; ");
            break;
        case "choice":
            body = d.selected.join(", ");
            break;
        case "score":
            body = `${d.value} of ${s.max}${d.note ? ` (${d.note})` : ""}`;
            break;
        default:
            body = d.text;
    }
    return body ? `${s.title}: ${body}` : "";
}

// Voice edits add to what is there: values and scores replace, lists append, checklists update by item
function mergeGeneral(s, cur, add) {
    const a = normalizeGeneral(s, add);
    const c = normalizeGeneral(s, cur);
    switch (s.type) {
        case "values":
            return Object.fromEntries(s.fields.map((f) => [f.key, a[f.key] || c[f.key]]));
        case "list":
            return [...c, ...a].slice(0, 50);
        case "checklist":
            return c.map((x, i) => (a[i].status || a[i].note ? a[i] : x));
        case "choice":
            return a.selected.length ? a : c;
        case "score":
            return a.value ? a : c;
        default:
            return a.text ? { text: c.text ? `${c.text}\n${a.text}` : a.text } : c;
    }
}

module.exports = {
    GENERAL_TYPES,
    DEFAULT_TITLES,
    validateGeneral,
    skeletonFor,
    promptLine,
    normalizeGeneral,
    isEmptyGeneral,
    contextLine,
    mergeGeneral,
};
