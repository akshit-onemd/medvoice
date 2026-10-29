"use strict";

const UTS = "https://uts-ws.nlm.nih.gov/rest";
const RXNAV = "https://rxnav.nlm.nih.gov/REST";
const CT_LOINC = "https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search";
const TTL_MS = 12 * 60 * 60 * 1000;
const SAB = { snomed: "SNOMEDCT_US", loinc: "LNC" };

// true: code the allergen substance ("Penicillin"). false: code the concept "Allergy to penicillin".
const ALLERGY_AS_SUBSTANCE = false;
// true: drop US-extension SNOMED codes (they contain 1000132). India uses the international edition.
const SNOMED_INTERNATIONAL_ONLY = true;
// true: a 3-character ICD-10 category that has subdivisions becomes its unspecified .9 code, amber.
const ICD_PREFER_SPECIFIC = true;

const GROUP = {
    allergy: "allergy",
    condition: "disorder",
    diagnosis: "disorder",
    disorder: "disorder",
    symptom: "finding",
    finding: "finding",
    procedure: "procedure",
    lifestyle: "situation",
    social: "situation",
    lab: "lab",
    interpretation: "interpretation",
    drug: "drug",
};
const KIND_HELP = {
    allergy: "an allergy. Prefer the 'Allergy to <substance>' concept.",
    disorder:
        "a disease or diagnosis (a disorder). Never a substance, food or measurement.",
    finding: "a symptom, sign or examination finding (a clinical finding).",
    procedure: "a medical or surgical procedure.",
    situation:
        "a lifestyle or social history item such as smoking, alcohol, occupation, exercise, sleep.",
    lab: "a laboratory test. Choose the code in the property the test is routinely reported in: [Mass/volume] (mg/dL, ng/mL), [Moles/volume] (mmol/L), [Units/volume] or [Enzymatic activity/volume] (U/L, IU/L, mIU/L), [Mass fraction] (%), [Number/volume] (cells). TSH is reported in mIU/L, so it is [Units/volume]. Chemistry tests (sodium, potassium, creatinine, urea, uric acid, enzymes, lipids, bilirubin, iron, calcium) are done on Serum or Plasma. Hemoglobin, cell counts and HbA1c are done on Blood. Qualitative tests use [Presence], [Titer] or [Type]. Avoid panels unless the term is a panel. Avoid '[Measurement]' codes, goals, estimated values and 'from ... profile' codes.",
    interpretation:
        "a result interpretation qualifier such as High, Low, Normal or Abnormal. Choose the qualifier value concept.",
    drug: "a medicine.",
};
const FORM_WORDS = {
    tablet: ["oral tablet"],
    capsule: ["oral capsule"],
    "oral solution": ["oral solution", "oral suspension"],
    "oral suspension": ["oral suspension", "oral solution"],
    injection: ["injectable", "injection"],
    cream: ["topical cream"],
    ointment: ["topical ointment"],
    drops: ["ophthalmic solution", "otic solution", "drops"],
    inhaler: ["inhal"],
};
// A different dosage form, not just a release profile
const DOSAGE_ALT =
    /(disintegrating|chewable|effervescent|dispersible|sublingual|buccal|for oral suspension|powder|granules|rectal|vaginal|lozenge)/;
// When the form is not stated, the common oral solids come first, injections last
const formRank = (tail, wantInjection) => {
    if (tail === "oral tablet") return 0;
    if (tail === "oral capsule") return 1;
    if (/^delayed release oral (tablet|capsule)$/.test(tail)) return 2;
    if (/injectable|injection/.test(tail)) return wantInjection ? 0 : 9;
    if (DOSAGE_ALT.test(tail)) return 6;
    if (/extended release|\d+ hr/.test(tail)) return 4;
    return 5;
};

// What a real code looks like. Anything else (block ranges, chapters, placeholders) is dropped.
const SHAPE = {
    snomed: /^\d{5,18}$/,
    loinc: /^\d{1,7}-\d$/,
    icd10: /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?[+*†]?$/,
};
const shapeOk = (vocab, code) => {
    const c = String(code);
    if (vocab === "snomed") {
        // Concept ids end in partition "00" plus a check digit. Extensions use "10" and a namespace.
        return (
            SHAPE.snomed.test(c) &&
            (!SNOMED_INTERNATIONAL_ONLY || c.slice(-3, -1) === "00")
        );
    }
    return !SHAPE[vocab] || SHAPE[vocab].test(c);
};
const vocabOfSab = (sab) =>
    sab === "SNOMEDCT_US" ? "snomed" : sab === "LNC" ? "loinc" : "icd10";
// WHO ICD-10 asterisk codes ("... in diseases classified elsewhere") are not for primary use
const badName = (vocab, name) =>
    vocab === "icd10" && /classified elsewhere/i.test(String(name || ""));

const norm = (s) =>
    String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
const clean = (s) =>
    String(s ?? "")
        .replace(/\s+/g, " ")
        .trim();
const grp = (k) => GROUP[k] || "disorder";
const keyOf = (vocab, kind, text) => `${vocab}|${grp(kind)}|${norm(text)}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMPTY = Object.freeze({
    code: "",
    term: null,
    status: "none",
    alts: [],
    standard: "",
});

const STOP = new Set([
    "of",
    "the",
    "and",
    "in",
    "to",
    "a",
    "an",
    "with",
    "without",
    "due",
]);
const toks = (s) =>
    norm(s)
        .split(" ")
        .filter((t) => t && !STOP.has(t));
// Every word of one text appears in the other
const covers = (standard, name) => {
    const want = toks(standard);
    if (!want.length) return false;
    const have = new Set(toks(name));
    return want.every((t) => have.has(t));
};
// Word overlap, 0 to 1
const jac = (a, b) => {
    const A = new Set(toks(a));
    const B = new Set(toks(b));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    A.forEach((t) => B.has(t) && hit++);
    return hit / (A.size + B.size - hit);
};

// Alternatives worth showing: exact synonyms first, then names that share words with the term
function altsFor(it, chosen, max = 4) {
    const qs = it.queries?.length ? it.queries : [it.standard || it.text];
    const score = (c) => Math.max(0, ...qs.map((q) => jac(q, c.name)));
    return (it.cands || [])
        .filter(
            (c) =>
                c.code !== chosen.code &&
                (it.lexSet?.has(c.code) || score(c) > 0),
        )
        .sort(
            (a, b) =>
                Number(!!it.lexSet?.has(b.code)) -
                    Number(!!it.lexSet?.has(a.code)) || score(b) - score(a),
        )
        .slice(0, max)
        .map((c) => ({ code: c.code, term: c.name }));
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) {
                const idx = i++;
                try {
                    out[idx] = await fn(items[idx], idx);
                } catch {
                    out[idx] = undefined;
                }
            }
        }),
    );
    return out;
}

// "500 mg" -> "500 MG", "125 mg/5 ml" -> "125 MG/5 ML", as RxNorm writes strengths
function normStrength(s) {
    const t = clean(s)
        .toUpperCase()
        .replace(/\bUG\b|µG/g, "MCG")
        .replace(/\s*\/\s*/g, "/");
    const m = t.match(
        /^(\d+(?:\.\d+)?)\s*(MG|MCG|G|IU|UNITS?|%|ML)(?:\/(\d+(?:\.\d+)?)?\s*(ML|G))?$/,
    );
    if (!m) return "";
    const unit = /^(IU|UNITS?)$/.test(m[2]) ? "UNT" : m[2];
    return (
        `${m[1]} ${unit}` + (m[4] ? `/${m[3] ? m[3] + " " : ""}${m[4]}` : "")
    );
}

// RxNorm may write the same strength another way: 120 MG/5 ML is 24 MG/ML, 1 G is 1000 MG, 50 MCG is 0.05 MG
function strengthVariants(s) {
    const base = normStrength(s);
    if (!base) return [];
    const out = new Set([base]);
    const m = base.match(
        /^(\d+(?:\.\d+)?) (MG|MCG|G|UNT|%|ML)(?:\/(?:(\d+(?:\.\d+)?) )?(ML|G))?$/,
    );
    if (m) {
        const [, num, unit, den, denUnit] = m;
        const n = Number(num);
        const tail = denUnit ? `/${den ? den + " " : ""}${denUnit}` : "";
        const fmt = (x) => +x.toFixed(6);
        if (denUnit && den && Number(den) > 0 && Number(den) !== 1) {
            out.add(`${fmt(n / Number(den))} ${unit}/${denUnit}`);
        }
        if (unit === "G") out.add(`${fmt(n * 1000)} MG${tail}`);
        if (unit === "MCG") out.add(`${fmt(n / 1000)} MG${tail}`);
        if (unit === "MG" && n < 1) out.add(`${fmt(n * 1000)} MCG${tail}`);
    }
    return [...out];
}

function crudeDrug(text) {
    const strength =
        (text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|ml|iu|%)\b/i) ||
            [])[0] || "";
    const name = text
        .replace(
            /\b(tab|tablet|cap|capsule|syp|syrup|inj|injection|oint|ointment|cream)\b\.?/gi,
            "",
        )
        .replace(strength, "")
        .replace(/\s+/g, " ")
        .trim();
    return { name, strength };
}

const wrapAllergy = (kind, text) =>
    !ALLERGY_AS_SUBSTANCE && grp(kind) === "allergy" && !/allerg/i.test(text)
        ? `Allergy to ${text}`
        : text;

module.exports = function createTerminology({
    axios,
    apiKey,
    llmJson,
    log = console.log,
}) {
    const cache = new Map();
    const cacheGet = (k) => {
        const h = cache.get(k);
        if (!h) return null;
        if (Date.now() - h.at > TTL_MS) {
            cache.delete(k);
            return null;
        }
        return h.v;
    };
    const cacheSet = (k, v) => cache.set(k, { v, at: Date.now() });
    // A network failure is never cached, so one bad moment cannot stick
    const done = (it, result) => {
        it.result = result;
        if (!it.unavailable) cacheSet(it.key, result);
    };

    // ---------------- UMLS ----------------
    async function umls(path, params = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const r = await axios.get(`${UTS}${path}`, {
                    params: { ...params, apiKey },
                    timeout: 15000,
                });
                return { ok: true, data: r.data };
            } catch (err) {
                if (err.response?.status === 404)
                    return { ok: true, data: null };
                if (
                    attempt === 0 &&
                    (!err.response || err.response.status >= 500)
                )
                    continue;
                log(
                    `⚠️ UMLS ${path} [${params.searchType || ""}] "${params.string || ""}" failed:`,
                    err.response?.status || err.message,
                    JSON.stringify(err.response?.data || "").slice(0, 160),
                );
                return { ok: false, data: null };
            }
        }
        return { ok: false, data: null };
    }

    async function umlsSearch(term, sab, searchType, pageSize = 25) {
        const r = await umls("/search/current", {
            string: term,
            sabs: sab,
            returnIdType: "code",
            searchType,
            pageSize,
        });
        const v = vocabOfSab(sab);
        const rows = r.data?.result?.results || [];
        return {
            ok: r.ok,
            rows: rows
                .filter(
                    (x) =>
                        x?.ui &&
                        x.ui !== "NONE" &&
                        shapeOk(v, x.ui) &&
                        !badName(v, x.name),
                )
                .map((x) => ({
                    code: String(x.ui),
                    name: String(x.name || ""),
                }))
                .slice(0, 12),
        };
    }

    // LOINC from the NLM Clinical Tables service: real LOINC codes only.
    // queries: one string or a list, merged. rankBy: the long common name we expect, used to sort.
    async function loincSearch(queries, rankBy = "") {
        const list = (Array.isArray(queries) ? queries : [queries])
            .map((q) => clean(String(q || "").replace(/[\[\]()\/]/g, " ")))
            .filter(Boolean);
        const JUNK =
            /\b(deprecated|ever told|survey|questionnaire|goal|intake|protocol|phenx|status|history|device|meter|prescribed|analog)\b/i;
        const run = async (terms) => {
            const r = await axios.get(CT_LOINC, {
                params: {
                    terms,
                    df: "LOINC_NUM,LONG_COMMON_NAME",
                    maxList: 50,
                },
                timeout: 12000,
            });
            const rows = Array.isArray(r.data?.[3]) ? r.data[3] : [];
            return rows
                .map((x) => ({
                    code: String(x?.[0] || ""),
                    name: String(x?.[1] || ""),
                }))
                .filter(
                    (x) =>
                        shapeOk("loinc", x.code) &&
                        x.name &&
                        !JUNK.test(x.name),
                );
        };
        try {
            const out = new Map();
            for (const q of list) {
                const words = q.split(" ");
                for (let n = words.length; n >= 1; n--) {
                    const rows = await run(words.slice(0, n).join(" "));
                    if (rows.length) {
                        rows.forEach(
                            (x) => out.has(x.code) || out.set(x.code, x),
                        );
                        break;
                    }
                }
            }
            const penalty = (x) =>
                /\b(panel|profile|estimated|ratio|calculated|measurement)\b/i.test(
                    x.name,
                )
                    ? 1
                    : 0;
            const rank = (x) => (rankBy ? jac(rankBy, x.name) : 0);
            const rows = [...out.values()].sort(
                (a, b) =>
                    rank(b) - rank(a) ||
                    penalty(a) - penalty(b) ||
                    a.name.length - b.name.length,
            );
            return { ok: true, rows: rows.slice(0, 25) };
        } catch (err) {
            log("⚠️ LOINC search failed:", err.response?.status || err.message);
            return { ok: false, rows: [] };
        }
    }

    // Strings that equal the term (or its normalized form) in this vocabulary
    async function lexicalSearch(sab, text) {
        if (sab === "LNC") return { lexical: [], failed: false }; // LOINC names are long. The model picks.
        const found = new Map();
        let failed = false;
        for (const type of ["exact", "normalizedString"]) {
            const r = await umlsSearch(text, sab, type, 25);
            if (!r.ok) failed = true;
            r.rows.forEach((x) => found.set(x.code, x));
            if (found.size) break;
        }
        return { lexical: [...found.values()], failed };
    }

    // "Polycystic ovarian syndrome" -> strings starting "polycystic ovar", which also finds "ovary"
    async function prefixSearch(sab, text) {
        const words = clean(text).split(" ");
        if (words.length < 2) return { ok: true, rows: [] };
        const head = words.slice(0, 2);
        const last = head[1];
        if (last.length > 5)
            head[1] = last.slice(0, Math.max(4, last.length - 3));
        return umlsSearch(head.join(" "), sab, "rightTruncation", 25);
    }

    // Looser candidates, exact ones first. (UMLS rejects searchType "approximate".)
    async function wideSearch(sab, text, have = [], extra = [], rankBy = "") {
        if (sab === "LNC") {
            const r = await loincSearch(
                [...extra, text],
                rankBy || extra[0] || text,
            );
            if (r.ok) return { cands: r.rows.slice(0, 12), failed: false };
        }
        const out = new Map(have.map((x) => [x.code, x]));
        let failed = false;
        const add = (r) => {
            if (!r.ok) failed = true;
            r.rows.forEach((x) => out.has(x.code) || out.set(x.code, x));
        };
        for (const type of ["words", "normalizedWords"]) {
            if (out.size >= 12) break;
            add(await umlsSearch(text, sab, type, 25));
        }
        if (out.size < 12) add(await prefixSearch(sab, text));
        return { cands: [...out.values()].slice(0, 12), failed };
    }

    // Last resort: the full text, then without its first word, then without its last
    async function searchProgressive(sab, text) {
        const words = clean(text).split(" ");
        const attempts = [words.join(" ")];
        if (words.length > 1)
            attempts.push(
                words.slice(1).join(" "),
                words.slice(0, -1).join(" "),
            );
        let failed = false;
        for (const a of attempts) {
            const w = await wideSearch(sab, a, []);
            failed = failed || w.failed;
            if (w.cands.length) return { cands: w.cands, failed };
        }
        return { cands: [], failed };
    }

    async function crosswalk(code, fromSab, toSab) {
        const r = await umls(
            `/crosswalk/current/source/${fromSab}/${encodeURIComponent(code)}`,
            {
                targetSource: toSab,
                pageSize: 50,
            },
        );
        const raw = Array.isArray(r.data?.result)
            ? r.data.result
            : r.data?.result?.results || [];
        const v = vocabOfSab(toSab);
        return {
            ok: r.ok,
            rows: raw
                .filter(
                    (x) =>
                        x?.ui &&
                        x.ui !== "NONE" &&
                        shapeOk(v, x.ui) &&
                        !badName(v, x.name),
                )
                .map((x) => ({
                    code: String(x.ui),
                    name: String(x.name || ""),
                })),
        };
    }

    // The names a single code carries (its preferred name and synonyms)
    const atomCache = new Map();
    async function atomNames(sab, code) {
        const k = `${sab}|${code}`;
        if (atomCache.has(k)) return atomCache.get(k);
        const r = await umls(
            `/content/current/source/${sab}/${encodeURIComponent(code)}/atoms`,
            { pageSize: 100 },
        );
        if (!r.ok) return null; // unknown. Not cached.
        const raw = Array.isArray(r.data?.result)
            ? r.data.result
            : r.data?.result?.results || [];
        const names = new Set();
        raw.forEach((a) => {
            const n = String(a?.name || "");
            names.add(norm(n));
            names.add(norm(n.replace(/\s*\([^)]*\)\s*$/, ""))); // drop tags like "(disorder)"
        });
        names.delete("");
        atomCache.set(k, names);
        return names;
    }
    async function hasAtom(sab, code, text) {
        const names = await atomNames(sab, code);
        return !!names && names.has(norm(text));
    }

    // Subdivisions of an ICD-10 category, for example E11 -> E11.0 ... E11.9
    async function icdChildren(sab, code) {
        const r = await umls(
            `/content/current/source/${sab}/${encodeURIComponent(code)}/children`,
            { pageSize: 25 },
        );
        const raw = Array.isArray(r.data?.result)
            ? r.data.result
            : r.data?.result?.results || [];
        return raw
            .map((x) => ({
                code: String(
                    x?.ui ||
                        String(x?.relatedId || "")
                            .split("/")
                            .pop() ||
                        "",
                ),
                name: String(x?.name || x?.relatedIdName || ""),
            }))
            .filter((x) => x.code && shapeOk("icd10", x.code));
    }

    // A bare category with subdivisions is not the code a record needs
    async function refineIcd(sab, res) {
        if (!ICD_PREFER_SPECIFIC || !res.code || res.code.includes("."))
            return res;
        const kids = await icdChildren(sab, res.code);
        if (!kids.length) return res;
        const pick =
            kids.find((k) => /\.9$/.test(k.code)) ||
            kids.find((k) => /unspecified|without complication/i.test(k.name));
        const rest = kids
            .filter((k) => !pick || k.code !== pick.code)
            .map((k) => ({ code: k.code, term: k.name }));
        if (pick) {
            return {
                ...res,
                code: pick.code,
                term: pick.name,
                status: "review",
                alts: [{ code: res.code, term: res.term }, ...rest].slice(0, 4),
            };
        }
        return { ...res, status: "review", alts: rest.slice(0, 4) };
    }

    // WHO ICD-10 is the UMLS source "ICD10". Falls back to ICD10CM if your key cannot read it.
    let icdPromise = null;
    function icdSab() {
        if (process.env.ICD10_SAB)
            return Promise.resolve(process.env.ICD10_SAB);
        if (!icdPromise) {
            icdPromise = (async () => {
                const r = await umlsSearch("cholera", "ICD10", "words", 25);
                if (r.ok && r.rows.length) return "ICD10";
                if (!r.ok) {
                    icdPromise = null; // try again next time
                    return "ICD10";
                }
                log(
                    "⚠️ WHO ICD-10 (ICD10) returned nothing for this key. Using ICD10CM instead.",
                );
                return "ICD10CM";
            })();
        }
        return icdPromise;
    }

    // ---------------- RxNav ----------------
    async function rxGet(path, params = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const r = await axios.get(`${RXNAV}${path}`, {
                    params,
                    timeout: 15000,
                });
                return { ok: true, data: r.data };
            } catch (err) {
                if (err.response?.status === 404)
                    return { ok: true, data: null };
                if (
                    attempt === 0 &&
                    (!err.response || err.response.status >= 500)
                )
                    continue;
                log(
                    `⚠️ RxNav ${path} failed:`,
                    err.response?.status || err.message,
                );
                return { ok: false, data: null };
            }
        }
        return { ok: false, data: null };
    }
    async function rxProps(id) {
        const r = await rxGet(`/rxcui/${id}/properties.json`);
        if (!r.ok) throw new Error("rxnav");
        const p = r.data?.properties;
        return p
            ? {
                  rxcui: String(p.rxcui),
                  name: String(p.name || ""),
                  tty: String(p.tty || ""),
              }
            : null;
    }
    async function rxIngredient(name) {
        const r = await rxGet("/rxcui.json", { name, search: 2 });
        if (!r.ok) throw new Error("rxnav");
        let id = r.data?.idGroup?.rxnormId?.[0];
        const exact = !!id;
        if (!id) {
            const a = await rxGet("/approximateTerm.json", {
                term: name,
                maxEntries: 5,
            });
            if (!a.ok) throw new Error("rxnav");
            id = a.data?.approximateGroup?.candidate?.[0]?.rxcui;
        }
        if (!id) return null;
        const p = await rxProps(id);
        if (!p) return null;
        if (["IN", "PIN", "MIN"].includes(p.tty))
            return { rxcui: p.rxcui, name: p.name, exact };
        const rel = await rxGet(`/rxcui/${id}/related.json`, { tty: "IN" });
        const g = rel.data?.relatedGroup?.conceptGroup?.find(
            (x) => x.tty === "IN",
        )?.conceptProperties?.[0];
        return g
            ? { rxcui: String(g.rxcui), name: String(g.name), exact: false }
            : { rxcui: p.rxcui, name: p.name, exact: false };
    }

    async function rxSingle(ing, form, rawText, brand) {
        const base = await rxIngredient(ing.name);
        if (!base) return { ...EMPTY, standard: ing.name };
        const sure = base.exact && !brand;
        const variants = strengthVariants(ing.strength);
        if (!variants.length) {
            return {
                code: base.rxcui,
                term: base.name,
                status: sure ? "verified" : "review",
                alts: [],
                standard: base.name,
            };
        }
        const rel = await rxGet(`/rxcui/${base.rxcui}/related.json`, {
            tty: "SCD",
        });
        if (!rel.ok) throw new Error("rxnav");
        const list =
            rel.data?.relatedGroup?.conceptGroup?.find((g) => g.tty === "SCD")
                ?.conceptProperties || [];

        // Single-ingredient products only: "<ingredient> [salt] <strength> <form>"
        const alt = variants.map((v) => esc(v.toLowerCase())).join("|");
        const re = new RegExp(
            `^(?:\\d+ hr )?(${esc(base.name.toLowerCase())}(?: [a-z]+)*?) (?:${alt}) (.+)$`,
        );
        const single = [];
        for (const p of list) {
            const m = re.exec(String(p.name).toLowerCase());
            if (!m || m[1].includes("/") || m[2].startsWith("/")) continue;
            single.push({
                rxcui: String(p.rxcui),
                name: String(p.name),
                tail: m[2],
            });
        }

        const words = FORM_WORDS[form] || [];
        const wantInj =
            form === "injection" || /\binj(ection)?\b/i.test(rawText);
        const modified =
            /\b(sr|er|xr|cr|retard|extended|chewable|dispersible|odt|mouth dissolving)\b/i.test(
                rawText,
            );
        const isMod = (m) =>
            /extended release|\d+ hr|sustained|chewable|disintegrating|dispersible/.test(
                m.tail,
            );
        const byForm = words.length
            ? single.filter((m) => words.some((w) => m.tail.includes(w)))
            : single;
        const ranked = [...byForm].sort(
            (a, b) =>
                formRank(a.tail, wantInj) - formRank(b.tail, wantInj) ||
                a.name.length - b.name.length,
        );
        const pool =
            modified && ranked.some(isMod) ? ranked.filter(isMod) : ranked;

        if (pool.length) {
            const best = pool[0];
            const exact = words.length
                ? pool.filter((m) => words.includes(m.tail))
                : [];
            const certain = modified
                ? pool.length === 1
                : words.length
                  ? exact.length === 1 ||
                    (exact.length === 0 &&
                        pool.length === 1 &&
                        !DOSAGE_ALT.test(best.tail))
                  : pool.length === 1 && !DOSAGE_ALT.test(best.tail);
            const others = pool
                .slice(1, 4)
                .map((m) => ({ code: m.rxcui, term: m.name }));
            return {
                code: best.rxcui,
                term: best.name,
                status: certain && sure ? "verified" : "review",
                alts: [...others, { code: base.rxcui, term: base.name }].slice(
                    0,
                    4,
                ),
                standard: `${base.name} ${variants[0]}`,
            };
        }
        // No product with that strength and form: show the ingredient and nearby products, same form first
        const nearAll = list.filter(
            (p) =>
                !String(p.name).includes(" / ") &&
                String(p.name)
                    .toLowerCase()
                    .startsWith(base.name.toLowerCase() + " "),
        );
        const sameForm = words.length
            ? nearAll.filter((p) =>
                  words.some((w) => String(p.name).toLowerCase().includes(w)),
              )
            : nearAll;
        const near = (sameForm.length ? sameForm : nearAll)
            .slice(0, 4)
            .map((p) => ({ code: String(p.rxcui), term: String(p.name) }));
        return {
            code: base.rxcui,
            term: base.name,
            status: "review",
            alts: near,
            standard: base.name,
        };
    }

    async function rxMulti(ings, form, brand) {
        const term =
            ings.map((i) => `${i.name} ${i.strength}`.trim()).join(" / ") +
            (form ? ` ${form}` : "");
        const a = await rxGet("/approximateTerm.json", { term, maxEntries: 8 });
        if (!a.ok) throw new Error("rxnav");
        const ids = [
            ...new Set(
                (a.data?.approximateGroup?.candidate || []).map((c) =>
                    String(c.rxcui),
                ),
            ),
        ].slice(0, 6);
        const props = (await mapLimit(ids, 3, rxProps)).filter(Boolean);
        const scd = props.filter((p) => p.tty === "SCD");
        // First six letters, so "clavulanic acid" still meets "clavulanate"
        const stems = ings.map((i) => i.name.toLowerCase().slice(0, 6));
        const hit = scd.find(
            (p) =>
                p.name.split(" / ").length === ings.length &&
                stems.every((s) => p.name.toLowerCase().includes(s)),
        );
        if (hit) {
            const up = hit.name.toUpperCase();
            const strengthsOk = ings.every((i) => {
                const v = strengthVariants(i.strength);
                return !v.length || v.some((x) => up.includes(x));
            });
            return {
                code: hit.rxcui,
                term: hit.name,
                status: strengthsOk && !brand ? "verified" : "review",
                alts: scd
                    .filter((p) => p.rxcui !== hit.rxcui)
                    .slice(0, 4)
                    .map((p) => ({ code: p.rxcui, term: p.name })),
                standard: term,
            };
        }
        const first = await rxIngredient(ings[0].name);
        if (!first) return { ...EMPTY, standard: term };
        return {
            code: first.rxcui,
            term: first.name,
            status: "review",
            alts: scd.slice(0, 4).map((p) => ({ code: p.rxcui, term: p.name })),
            standard: term,
        };
    }

    // ---------------- model steps ----------------
    const kindsText = Object.entries(KIND_HELP)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");

    async function chunked(list, size, fn) {
        const out = {};
        for (let i = 0; i < list.length; i += size)
            Object.assign(out, await fn(list.slice(i, i + size)));
        return out;
    }

    async function normalizeBatch(list) {
        if (!list.length) return {};
        return chunked(list, 40, async (part) => {
            const out =
                await llmJson(`You standardize medical terms before they are looked up in SNOMED CT, ICD-10, LOINC and RxNorm.

For every item, return its standard English name.
Rules:
- Use the common standard medical term. Expand abbreviations (HTN is hypertension, T2DM is type 2 diabetes mellitus). Translate Hindi or any other language to English.
- Drop severity, negation, dates and dose text from names that are not drugs. Do not add information that is not there.
- "rewrite" says what you did to the text: "none" if you kept it as written (spelling or case fixes only), "expanded" if you only expanded an abbreviation or translated it, "reinterpreted" if the text was vague or colloquial and you chose a clinical term for it (for example "sugar" to diabetes mellitus, "BP" to hypertension, "body ache" to myalgia, "loose motions" to diarrhea). Be honest. When unsure, use "reinterpreted".
- "ambiguous": true if the text could reasonably mean more than one medical thing: abbreviations with several meanings (RA, AGE, MS, CAD), or a vague word that names no specific condition (pain, infection, discharge, weakness, swelling). Otherwise false.
- "translated": true if the text is not in English (Hindi, Hinglish, or another language), otherwise false.
- "also": if the text names two or more separate conditions (for example "hypertension with type 2 diabetes"), set "name" to the first and list each other one here, with its own standard name. Otherwise an empty list.
- "synonyms": up to two other standard clinical names for the same thing, as WHO ICD-10 or SNOMED might word it (for example "tuberculosis of lung" for pulmonary tuberculosis, "chronic renal failure" for chronic kidney disease, "polycystic ovary syndrome" for polycystic ovarian syndrome). Empty list if none.
- "kind" says what the item is.
- For kind "lab": give the test or analyte name only (for example "Hemoglobin A1c", "Troponin I"). Keep qualifiers that change the test, such as total, HDL, LDL, free, fasting, random, postprandial. Drop words like test, level, serum, blood. When the name is shorthand, name the measured form: "Vitamin D" is total 25-hydroxyvitamin D (D2 and D3 together), "TSH" is thyrotropin, "SGPT" is alanine aminotransferase, "SGOT" is aspartate aminotransferase, "FBS" is fasting glucose, "RBS" is random glucose, "PPBS" is postprandial glucose, "Sugar" is glucose. Named tests: "Widal" is Salmonella typhi O Ab, "ANA" is nuclear Ab, "HBsAg" is hepatitis B virus surface Ag, "Blood group" is ABO and Rh group. Also set "query" to the usual LOINC-style long common name for the test, using the property the test is routinely reported in (mIU/L is [Units/volume], U/L is [Enzymatic activity/volume], mg/dL is [Mass/volume], qualitative is [Presence], [Titer] or [Type]) and the usual specimen (chemistry is "in Serum or Plasma", blood counts and hemoglobin are "in Blood"). For example "Sodium [Moles/volume] in Serum or Plasma" or "Thyrotropin [Units/volume] in Serum or Plasma" or "ABO and Rh group [Type] in Blood". It is only a search string. Never write a code.
- For kind "drug": set "name" to the generic name and give "ingredients", a list of active ingredients. Each has "name" (the name RxNorm uses, for example acetaminophen for paracetamol, albuterol for salbutamol, clavulanate not clavulanic acid) and "strength" (for example "500 mg" or "125 mg/5 mL"). Give "form" as one of: tablet, capsule, oral solution, oral suspension, injection, cream, ointment, drops, inhaler, other, or "". Words like Tab, Cap, Syp, Inj state the form. Map brand names to their ingredients. For a combination product list every ingredient with its own strength (for example Augmentin 625 is amoxicillin 500 mg plus clavulanate 125 mg). Leave strength or form "" when it is not stated. Set "brand" to true when the text names a brand (Crocin, Dolo, Augmentin, Pan, Telma) instead of the generic name, otherwise false.
- Never write codes.

Kinds:
${kindsText}

Return ONLY JSON: {"items":[{"id":"","name":"","rewrite":"none","ambiguous":false,"translated":false,"also":[""],"synonyms":[""],"query":"","brand":false,"ingredients":[{"name":"","strength":""}],"form":""}]}

Items:
${JSON.stringify(part)}`);
            const map = {};
            for (const r of Array.isArray(out?.items) ? out.items : [])
                if (r && r.id != null) map[String(r.id)] = r;
            return map;
        });
    }

    async function rerankBatch(list) {
        if (!list.length) return {};
        return chunked(list, 20, async (part) => {
            const out =
                await llmJson(`You choose the correct standard code for each medical term. Every item lists real candidate concepts from the terminology. Pick only from the listed candidates. Never write a code yourself.

Rules:
- Pick the candidate that means exactly the same as the term. Prefer it over broader or narrower concepts.
- "kind" says what the term is. A candidate of the wrong type (a food, a substance or a measurement for a disease) is wrong, even if the words match.
- If none means the same, pick the closest and set confidence to "low". If none is reasonable, pick 0.
- Set confidence to "high" only when the candidate clearly means the same thing. A broader or narrower concept than the term is never "high", except an ICD-10 default category as described below.
- If several candidates mean the same thing, pick the one listed first.
- For ICD-10: if a listed code's title, or a bracketed synonym in it, names the term, choose that code. Only when no listed code names the term, choose the disease's default category (the unspecified, essential or primary form), and give "high" only if the term has no extra detail. Never choose a code whose title ends with "in diseases classified elsewhere".

Kinds:
${kindsText}

Return ONLY JSON: {"items":[{"id":"","pick":1,"confidence":"high"}]}

Items:
${JSON.stringify(part)}`);
            const map = {};
            for (const r of Array.isArray(out?.items) ? out.items : [])
                if (r && r.id != null) map[String(r.id)] = r;
            return map;
        });
    }

    // Two independent picks, the second with the list reversed. Green needs both to agree.
    async function rerankTwice(list) {
        const rev = list.map((x) => ({
            ...x,
            candidates: [...x.candidates]
                .reverse()
                .map((c, k) => ({ n: k + 1, name: c.name })),
        }));
        const [a, b] = await Promise.all([rerankBatch(list), rerankBatch(rev)]);
        const out = {};
        for (const x of list) {
            const len = x.candidates.length;
            const pa = a[x.id];
            const pb = b[x.id];
            const ia =
                Number.isInteger(pa?.pick) && pa.pick >= 1 && pa.pick <= len
                    ? pa.pick
                    : 0;
            const ib =
                Number.isInteger(pb?.pick) && pb.pick >= 1 && pb.pick <= len
                    ? len - pb.pick + 1
                    : 0;
            out[x.id] = {
                pick: ia && ib ? Math.min(ia, ib) : ia || ib,
                other: ia && ib && ia !== ib ? Math.max(ia, ib) : 0,
                agree: !!ia && ia === ib,
                high: pa?.confidence === "high" && pb?.confidence === "high",
            };
        }
        return out;
    }

    // ---------------- the batch ----------------
    async function runBatch(items) {
        const coreMap = new Map();
        const rxItems = [];
        const icdItems = [];
        for (const it of items) {
            if (cacheGet(it.key)) continue;
            if (it.vocab === "rxnorm") rxItems.push(it);
            else if (it.vocab === "icd10") {
                icdItems.push(it);
                const k = keyOf("snomed", it.kind, it.text);
                if (!cacheGet(k) && !coreMap.has(k))
                    coreMap.set(k, {
                        vocab: "snomed",
                        kind: it.kind,
                        text: it.text,
                        key: k,
                    });
            } else if (!coreMap.has(it.key)) coreMap.set(it.key, it);
        }
        const core = [...coreMap.values()];

        // A. Exact lookups on the text as written
        await mapLimit(core, 5, async (it) => {
            it.q = wrapAllergy(it.kind, it.text);
            it.lex = await lexicalSearch(SAB[it.vocab], it.q);
        });

        // B. One model call to standardize everything
        const toNorm = [
            ...core.map((ref) => ({
                ref,
                text: ref.text,
                kind: grp(ref.kind),
            })),
            ...rxItems.map((ref) => ({ ref, text: ref.text, kind: "drug" })),
        ];
        const names = await normalizeBatch(
            toNorm.map((x, i) => ({
                id: String(i),
                text: x.text,
                kind: x.kind,
            })),
        );
        toNorm.forEach((x, i) => {
            x.ref.norm = names[String(i)] || null;
        });

        // C. Candidates for every term
        const rerank = [];
        await mapLimit(core, 5, async (it) => {
            const sab = SAB[it.vocab];
            const n = it.norm;
            const isLab = grp(it.kind) === "lab";
            const std = wrapAllergy(it.kind, clean(n?.name) || it.text);
            it.standard = std;
            it.rewrite = ["none", "expanded", "reinterpreted"].includes(
                n?.rewrite,
            )
                ? n.rewrite
                : norm(std) === norm(it.q)
                  ? "none"
                  : "reinterpreted";
            // Vague, translated or multi-meaning text is never certain
            it.soft = n?.translated === true || n?.ambiguous === true;
            const syns = (Array.isArray(n?.synonyms) ? n.synonyms : [])
                .map((s) => wrapAllergy(it.kind, clean(s)))
                .filter((s) => s && norm(s) !== norm(std))
                .slice(0, 2);
            it.queries = [std, ...syns];
            const lq = isLab ? clean(n?.query) : "";
            if (lq) it.queries.push(lq);

            const lexical = new Map(
                (it.lex?.lexical || []).map((x) => [x.code, x]),
            );
            it.exactSet = new Set(lexical.keys()); // concepts that carry the term itself
            let failed = !!it.lex?.failed;
            for (const [qi, q] of it.queries.entries()) {
                if (norm(q) === norm(it.q) || (isLab && q === lq)) continue;
                const l = await lexicalSearch(sab, q);
                failed = failed || l.failed;
                if (qi === 0) l.lexical.forEach((x) => it.exactSet.add(x.code));
                l.lexical.forEach(
                    (x) => lexical.has(x.code) || lexical.set(x.code, x),
                );
            }

            // A second condition in the same text: offer its code as an alternative
            it.alsoC = [];
            for (const a of (Array.isArray(n?.also) ? n.also : []).slice(
                0,
                2,
            )) {
                const name = clean(a);
                if (!name || sab === "LNC") continue;
                const l = await lexicalSearch(sab, name);
                failed = failed || l.failed;
                if (l.lexical[0]) it.alsoC.push(l.lexical[0]);
            }

            let cands = [...lexical.values()];
            if (sab === "LNC") {
                const texts = [lq, std, ...syns].filter(Boolean);
                const w = await wideSearch(
                    sab,
                    texts[0],
                    [],
                    texts.slice(1),
                    lq || std,
                );
                failed = failed || w.failed;
                cands = w.cands;
            } else if (cands.length < 4) {
                const seen = new Map(cands.map((x) => [x.code, x]));
                for (const q of it.queries) {
                    const w = await wideSearch(sab, q, [...seen.values()]);
                    failed = failed || w.failed;
                    w.cands.forEach(
                        (x) => seen.has(x.code) || seen.set(x.code, x),
                    );
                    if (seen.size >= 12) break;
                }
                cands = [...seen.values()].slice(0, 12);
            }
            if (!cands.length) {
                const p = await searchProgressive(sab, std);
                failed = failed || p.failed;
                cands = p.cands;
            }
            if (!cands.length) {
                it.unavailable = failed;
                done(it, { ...EMPTY, standard: std, queries: it.queries });
                return;
            }
            it.cands = cands.slice(0, 12);
            it.lexSet = new Set(lexical.keys());
            rerank.push(it);
        });

        // D. The model picks twice from the real candidates. Every term goes through this.
        if (rerank.length) {
            const picks = await rerankTwice(
                rerank.map((it, i) => ({
                    id: String(i),
                    term: it.standard,
                    original: it.text,
                    kind: grp(it.kind),
                    candidates: it.cands.map((c, k) => ({
                        n: k + 1,
                        name: c.name,
                    })),
                })),
            );
            await mapLimit(rerank, 5, async (it, i) => {
                const p = picks[String(i)] || {};
                const chosen = p.pick >= 1 ? it.cands[p.pick - 1] : it.cands[0];
                const other = p.other >= 1 ? it.cands[p.other - 1] : null;
                // If two concepts both carry the doctor's exact words, the term is ambiguous in SNOMED.
                // Green then needs the chosen concept's own name to be the term.
                const ambiguous = it.exactSet.size >= 2;
                const named =
                    norm(chosen.name) === norm(it.text) ||
                    norm(chosen.name) === norm(it.standard);
                let evidence = false;
                if (
                    p.agree &&
                    p.high &&
                    it.vocab !== "loinc" &&
                    it.rewrite !== "reinterpreted" &&
                    !it.soft &&
                    !it.alsoC.length &&
                    (!ambiguous || named)
                ) {
                    const sab = SAB[it.vocab];
                    evidence =
                        (await hasAtom(sab, chosen.code, it.text)) ||
                        (await hasAtom(sab, chosen.code, it.standard)) ||
                        covers(it.standard, chosen.name);
                }
                const alts = altsFor(it, chosen);
                if (other && !alts.some((a) => a.code === other.code))
                    alts.unshift({ code: other.code, term: other.name });
                it.alsoC.forEach(
                    (c) =>
                        alts.some((a) => a.code === c.code) ||
                        alts.unshift({ code: c.code, term: c.name }),
                );
                done(it, {
                    code: chosen.code,
                    term: chosen.name,
                    status: evidence ? "verified" : "review",
                    alts: alts.slice(0, 4),
                    standard: it.standard,
                    queries: it.queries,
                    rewrite: it.rewrite,
                    soft: it.soft,
                    compound: it.alsoC.length > 0,
                });
            });
        }

        // E. Medicines
        await mapLimit(rxItems, 3, async (it) => {
            const n = it.norm;
            let ings = (Array.isArray(n?.ingredients) ? n.ingredients : [])
                .map((x) => ({
                    name: clean(x?.name),
                    strength: clean(x?.strength),
                }))
                .filter((x) => x.name);
            const form = clean(n?.form).toLowerCase();
            const brand = !!n?.brand;
            if (!ings.length) {
                const c = crudeDrug(it.text);
                if (c.name) ings = [{ name: c.name, strength: c.strength }];
            }
            if (!ings.length) {
                done(it, { ...EMPTY, standard: it.text });
                return;
            }
            try {
                done(
                    it,
                    ings.length === 1
                        ? await rxSingle(ings[0], form, it.text, brand)
                        : await rxMulti(ings, form, brand),
                );
            } catch {
                it.unavailable = true;
                done(it, { ...EMPTY, standard: it.text });
            }
        });

        // F. ICD-10. The shared-concept link and a direct search both feed one list.
        if (icdItems.length) {
            const sab = await icdSab();
            const open = [];
            const finals = [];
            await mapLimit(icdItems, 5, async (it) => {
                const base = cacheGet(keyOf("snomed", it.kind, it.text));
                const std = base?.standard || wrapAllergy(it.kind, it.text);
                const queries = base?.queries?.length
                    ? base.queries.filter((q) => !/\[/.test(q))
                    : [std];
                const mapSet = new Set();
                const lexSet = new Set();
                const mapRows = [];
                const lexRows = [];
                let failed = false;
                if (base?.code) {
                    const cw = await crosswalk(base.code, SAB.snomed, sab);
                    failed = !cw.ok;
                    cw.rows.forEach((x) => {
                        mapSet.add(x.code);
                        mapRows.push(x);
                    });
                }
                for (const q of queries) {
                    const lex = await lexicalSearch(sab, q);
                    failed = failed || lex.failed;
                    lex.lexical.forEach((x) => {
                        lexSet.add(x.code);
                        lexRows.push(x);
                    });
                }
                const seen = new Map(
                    [...lexRows, ...mapRows].map((x) => [x.code, x]),
                );
                if (seen.size < 6) {
                    for (const q of queries) {
                        const w = await wideSearch(sab, q, [...seen.values()]);
                        failed = failed || w.failed;
                        w.cands.forEach(
                            (x) => seen.has(x.code) || seen.set(x.code, x),
                        );
                        if (seen.size >= 12) break;
                    }
                }
                let cands = [...seen.values()].slice(0, 12);
                if (!cands.length) {
                    for (const q of queries) {
                        const p = await searchProgressive(sab, q);
                        failed = failed || p.failed;
                        if (p.cands.length) {
                            cands = p.cands;
                            break;
                        }
                    }
                }
                Object.assign(it, {
                    cands,
                    base,
                    mapSet,
                    lexSet,
                    std,
                    queries,
                });
                if (!cands.length) {
                    it.unavailable = failed;
                    done(it, { ...EMPTY, standard: std, queries });
                    return;
                }
                if (cands.length === 1) {
                    const c = cands[0];
                    const baseOk = ["verified", "confirmed"].includes(
                        base?.status,
                    );
                    const safe = base
                        ? base.rewrite !== "reinterpreted" &&
                          !base.soft &&
                          !base.compound
                        : true;
                    const trust =
                        (mapSet.has(c.code) && baseOk) ||
                        lexSet.has(c.code) ||
                        covers(std, c.name);
                    finals.push({
                        it,
                        res: {
                            code: c.code,
                            term: c.name,
                            status: trust && safe ? "verified" : "review",
                            alts: [],
                            standard: std,
                            queries,
                        },
                    });
                    return;
                }
                open.push(it);
            });
            if (open.length) {
                const picks = await rerankTwice(
                    open.map((it, i) => ({
                        id: String(i),
                        term: it.std,
                        original: it.text,
                        kind: grp(it.kind),
                        candidates: it.cands.map((c, k) => ({
                            n: k + 1,
                            name: c.name,
                        })),
                    })),
                );
                open.forEach((it, i) => {
                    const p = picks[String(i)] || {};
                    const chosen =
                        p.pick >= 1 ? it.cands[p.pick - 1] : it.cands[0];
                    const other = p.other >= 1 ? it.cands[p.other - 1] : null;
                    const baseOk = ["verified", "confirmed"].includes(
                        it.base?.status,
                    );
                    const evidence =
                        (it.mapSet.has(chosen.code) && baseOk) ||
                        it.lexSet.has(chosen.code) ||
                        covers(it.std, chosen.name);
                    const safe = it.base
                        ? it.base.rewrite !== "reinterpreted" &&
                          !it.base.soft &&
                          !it.base.compound
                        : true;
                    const alts = altsFor(it, chosen);
                    if (other && !alts.some((a) => a.code === other.code))
                        alts.unshift({ code: other.code, term: other.name });
                    finals.push({
                        it,
                        res: {
                            code: chosen.code,
                            term: chosen.name,
                            status:
                                p.agree && p.high && evidence && safe
                                    ? "verified"
                                    : "review",
                            alts: alts.slice(0, 4),
                            standard: it.std,
                            queries: it.queries,
                        },
                    });
                });
            }
            // A bare 3-character category becomes its usable subdivision
            await mapLimit(finals, 4, async ({ it, res }) =>
                done(it, await refineIcd(sab, res)),
            );
        }
    }

    // ---------------- public ----------------
    async function resolve(vocab, text, kind = "condition") {
        const t = clean(text);
        if (!t) return EMPTY;
        const key = keyOf(vocab, kind, t);
        const hit = cacheGet(key);
        if (hit) return hit;
        const it = { vocab, kind, text: t, key };
        await runBatch([it]);
        return it.result || cacheGet(key) || EMPTY;
    }

    async function warm(jobs) {
        const seen = new Map();
        for (const j of jobs || []) {
            const t = clean(j?.text);
            if (!t || !["snomed", "icd10", "loinc", "rxnorm"].includes(j.vocab))
                continue;
            const key = keyOf(j.vocab, j.kind, t);
            if (!seen.has(key) && !cacheGet(key)) {
                seen.set(key, {
                    vocab: j.vocab,
                    kind: j.kind || "condition",
                    text: t,
                    key,
                });
            }
        }
        if (seen.size) await runBatch([...seen.values()]);
    }

    // For the manual picker
    async function searchCodes(vocab, q) {
        const text = clean(q).slice(0, 80);
        if (text.length < 2) return [];
        if (vocab === "rxnorm") {
            const ids = new Set();
            const ing = await rxIngredient(text).catch(() => null);
            if (ing) ids.add(ing.rxcui);
            const a = await rxGet("/approximateTerm.json", {
                term: text,
                maxEntries: 8,
            });
            (a.data?.approximateGroup?.candidate || []).forEach((c) =>
                ids.add(String(c.rxcui)),
            );
            const props = (
                await mapLimit([...ids].slice(0, 8), 3, rxProps)
            ).filter(Boolean);
            return props.map((p) => ({ code: p.rxcui, term: p.name }));
        }
        if (vocab === "loinc") {
            const r = await loincSearch(text, text);
            if (r.ok)
                return r.rows.map((x) => ({ code: x.code, term: x.name }));
        }
        const sab = vocab === "icd10" ? await icdSab() : SAB[vocab];
        const lex = await lexicalSearch(sab, text);
        const w = await wideSearch(sab, text, lex.lexical);
        return w.cands
            .slice(0, 12)
            .map((c) => ({ code: c.code, term: c.name }));
    }

    // Does this code exist? Returns { ok, name }. ok false means the service was unreachable.
    async function exists(vocab, code) {
        try {
            if (vocab === "rxnorm") {
                const p = await rxProps(code);
                return { ok: true, name: p?.name || null };
            }
            if (!shapeOk(vocab, code)) return { ok: true, name: null };
            const sab = vocab === "icd10" ? await icdSab() : SAB[vocab];
            const r = await umls(
                `/content/current/source/${sab}/${encodeURIComponent(code)}`,
            );
            if (!r.ok) return { ok: false, name: null };
            let name = r.data?.result?.name || null;
            if (!name && vocab === "loinc") {
                const l = await loincSearch(code);
                name = l.rows.find((x) => x.code === code)?.name || null;
            }
            return { ok: true, name };
        } catch {
            return { ok: false, name: null };
        }
    }

    async function health() {
        const out = {};
        const t = async (label, fn) => {
            try {
                out[label] = await fn();
            } catch (e) {
                out[label] = { ok: false, error: e.message };
            }
        };
        await t("snomed", async () => {
            const r = await umlsSearch("hypertension", SAB.snomed, "exact", 25);
            return { ok: r.ok && r.rows.length > 0, sample: r.rows[0] || null };
        });
        await t("icd10", async () => {
            const sab = await icdSab();
            const r = await umlsSearch("cholera", sab, "words", 25);
            return {
                ok: r.ok && r.rows.length > 0,
                sab,
                sample: r.rows[0] || null,
            };
        });
        await t("loinc", async () => {
            const r = await loincSearch("hemoglobin a1c", "hemoglobin a1c");
            return { ok: r.ok && r.rows.length > 0, sample: r.rows[0] || null };
        });
        await t("rxnorm", async () => {
            const r = await rxIngredient("acetaminophen");
            return { ok: !!r, sample: r };
        });
        await t("model", async () => ({
            ok: !!(await llmJson('Return exactly this JSON: {"ok": true}')),
        }));
        return out;
    }

    // Cached result only. Never calls the network. null when this term has not been looked up yet.
    function peek(vocab, text, kind = "condition") {
        const t = clean(text);
        if (!t) return EMPTY;
        return cacheGet(keyOf(vocab, kind, t)) || null;
    }

    return { resolve, peek, warm, searchCodes, exists, health };
};
