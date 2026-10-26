"use strict";

const SALTS = new Set([
    "hydrochloride",
    "hcl",
    "dihydrochloride",
    "sodium",
    "disodium",
    "potassium",
    "calcium",
    "magnesium",
    "besylate",
    "maleate",
    "tartrate",
    "succinate",
    "fumarate",
    "citrate",
    "phosphate",
    "sulfate",
    "sulphate",
    "acetate",
    "mesylate",
    "hydrobromide",
    "bromide",
    "dihydrate",
    "monohydrate",
    "trihydrate",
    "hemihydrate",
    "anhydrous",
    "ip",
    "bp",
    "usp",
    "ep",
    "nf",
    "hyclate",
    "medoxomil",
    "axetil",
    "proxetil",
    "pivoxil",
    "dipropionate",
    "propionate",
    "furoate",
    "valerate",
    "lysine",
    "tromethamine",
]);
// Spellings and US/Indian names that mean the same ingredient
const ALIAS = {
    acetaminophen: "paracetamol",
    albuterol: "salbutamol",
    epinephrine: "adrenaline",
    norepinephrine: "noradrenaline",
    amoxycillin: "amoxicillin",
    clavulanate: "clavulanic acid",
    frusemide: "furosemide",
    rifampin: "rifampicin",
    glyburide: "glibenclamide",
    lignocaine: "lidocaine",
    cefalexin: "cephalexin",
    "vitamin d3": "cholecalciferol",
    "vitamin b12": "cyanocobalamin",
    "vitamin c": "ascorbic acid",
    thyroxine: "levothyroxine",
    "ethinyl estradiol": "ethinylestradiol",
};
// Makers that sell generics under their own shop name. Not brands a doctor prescribes.
const RETAILER_RE =
    /(davaindia|genericart|swast aushadhi|sarvagunaushdhi|jan aushadhi|janaushadhi|pmbjp)/i;
// Sustained-release or special forms
const MODIFIED_RE =
    /\b(sr|xr|er|cr|mr|xl|pr|retard|prolonged|dt|odt|md|mt|chewable|dispersible|mouth dissolving)\b/i;

const clean = (s) =>
    String(s ?? "")
        .replace(/\s+/g, " ")
        .trim();

function canonIngredient(raw) {
    const s = String(raw ?? "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/[^a-z0-9 ]+/g, " ");
    const out = s
        .split(/\s+/)
        .filter((w) => w && !SALTS.has(w) && !/^\d+$/.test(w))
        .join(" ")
        .trim();
    return ALIAS[out] || out;
}

const STRENGTH_RE =
    /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|iu|units?|%|ml)(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*(ml|g|mg|l))?/i;

// "500 mg" -> "500mg", "0.5 g" -> "500mg", "125 mg/5 ml" -> "125mg/5ml"
function canonStrength(raw) {
    const t = String(raw || "")
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/µg|ug/g, "mcg");
    const m = t.match(
        /^(\d+(?:\.\d+)?)(mg|mcg|g|iu|units?|%|ml)(?:\/(\d+(?:\.\d+)?)?(ml|g|mg|l))?$/,
    );
    if (!m) return "";
    let n = Number(m[1]);
    let unit = m[2];
    if (unit === "g" && !m[4]) {
        n *= 1000;
        unit = "mg";
    }
    if (/^units?$/.test(unit)) unit = "units";
    const base = `${+n.toFixed(4)}${unit}`;
    return m[4] ? `${base}/${m[3] || ""}${m[4]}` : base;
}

// "Amoxycillin (500mg) + Clavulanic Acid (125mg)" -> [{name, strength}, ...]
function splitComposition(text) {
    return String(text || "")
        .split(/\s*[+;&]\s*|\s+,\s*/)
        .map((part) => {
            const m = STRENGTH_RE.exec(part);
            if (!m) {
                const name = canonIngredient(part);
                return name ? { name, strength: "" } : null;
            }
            const name = canonIngredient(
                part.slice(0, m.index) +
                    " " +
                    part.slice(m.index + m[0].length),
            );
            return name ? { name, strength: canonStrength(m[0]) } : null;
        })
        .filter(Boolean);
}

const compKey = (ings) =>
    ings.length && ings.every((i) => i.strength)
        ? [...ings]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((i) => `${i.name} ${i.strength}`)
              .join(" + ")
        : "";
const ingKey = (ings) =>
    [...new Set(ings.map((i) => i.name))].sort().join(" + ");

function formOf(text) {
    const t = String(text || "").toLowerCase();
    if (/\b(inj|injection|injectable|vial|infusion)\b/.test(t))
        return "injection";
    if (/\b(cream|gel|ointment|oint|lotion|spray)\b/.test(t)) return "topical";
    if (/\b(cap|capsule|capsules)\b/.test(t)) return "capsule";
    if (/\b(tab|tablet|tablets)\b/.test(t)) return "tablet";
    if (/\b(syp|syrup|susp|suspension|solution|drops|liquid)\b/.test(t))
        return "liquid";
    return "";
}

const DROP_WORDS =
    /\b(tablets?|tab|capsules?|cap|syrup|syp|suspension|susp|injection|inj|drops?|gel|cream|ointment|lotion|solution|oral|strip|kit|sachet|powder)\b\.?/gi;
// "Dolo 650mg Tablet" -> "Dolo 650"
function displayName(raw) {
    return clean(
        String(raw || "")
            .replace(/\([^)]*\)/g, " ")
            .replace(/(\d+(?:\.\d+)?)\s*(?:mg|mcg|ml|gm|g)\b/gi, "$1")
            .replace(DROP_WORDS, " "),
    );
}

// "Dolo 650" -> "dolo", "Crocin Advance 500" -> "crocin advance", "E Prin 75" -> "e prin", "T-98" -> "t 98"
function familyOf(display) {
    const tokens = String(display || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    if (!tokens.length) return "";
    const hasWord = tokens.some((t) => /^[a-z]{3,}$/.test(t));
    return (hasWord ? tokens.filter((t) => !/^\d+$/.test(t)) : tokens).join(
        " ",
    );
}

// A pharmacy-chain label: the generic name sits inside the product name, or the maker is a generic store
function genericLabelled(brand, composition, manufacturer) {
    if (RETAILER_RE.test(`${manufacturer || ""} ${brand || ""}`)) return true;
    const words = new Set(
        String(brand || "")
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter((w) => w.length >= 6),
    );
    return String(composition || "")
        .toLowerCase()
        .split(/[^a-z]+/)
        .some((w) => w.length >= 6 && words.has(w));
}

const isModified = (text) => MODIFIED_RE.test(String(text || ""));

// A medicine written by the model, for example "Paracetamol 500 mg", with the dosage list as a backup
function parseMedication(name, dosage = []) {
    const text = clean(name).replace(DROP_WORDS, " ");
    const ings = splitComposition(text);
    if (ings.length === 1 && !ings[0].strength) {
        for (const d of dosage || []) {
            const m = STRENGTH_RE.exec(String(d));
            if (m) {
                ings[0].strength = canonStrength(m[0]);
                break;
            }
        }
    }
    return { ings, form: formOf(name) };
}

module.exports = {
    canonIngredient,
    canonStrength,
    splitComposition,
    compKey,
    ingKey,
    formOf,
    displayName,
    familyOf,
    parseMedication,
    genericLabelled,
    isModified,
};
