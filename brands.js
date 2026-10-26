"use strict";

const {
    parseMedication,
    compKey,
    ingKey,
    familyOf,
    canonIngredient,
    genericLabelled,
    isModified,
} = require("./brandUtils");

const SHOW = 3;
const LEARN_FROM_APPROVALS = true; // each approved brand nudges its rank up
const PRIOR_CANDIDATES = 60; // how many real brands the model sees
const PRIOR_KEEP = 8;
const PRIOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const RANK_WAIT_MS = 6000; // never make the doctor wait longer than this for the ranking

// Large Indian and multinational makers. Used to order the fallback. Edit as you like.
const ESTABLISHED_RE = new RegExp(
    [
        "sun pharma",
        "cipla",
        "abbott",
        "glenmark",
        "lupin",
        "dr\\.? reddy",
        "zydus",
        "cadila",
        "torrent",
        "alkem",
        "mankind",
        "intas",
        "micro labs",
        "usv",
        "alembic",
        "macleods",
        "ipca",
        "eris",
        "ajanta",
        "glaxo",
        "gsk",
        "pfizer",
        "novartis",
        "astrazeneca",
        "merck",
        "sanofi",
        "biocon",
        "emcure",
        "aristo",
        "franco-indian",
        "wockhardt",
        "piramal",
        "natco",
        "hetero",
        "unichem",
        "fdc",
        "indoco",
        "j\\.?b\\.? chemicals",
        "mylan",
        "viatris",
        "bayer",
        "novo nordisk",
        "eli lilly",
        "boehringer",
        "akumentis",
        "troikaa",
        "msn",
        "la renon",
        "blue cross",
        "ranbaxy",
        "cadila",
        "knoll",
        "abbvie",
        "johnson",
        "roche",
        "takeda",
    ].join("|"),
    "i",
);
// How far apart two words are, counting single-letter edits
function lev(a, b) {
    const m = a.length;
    const n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            d[i][j] = Math.min(
                d[i - 1][j] + 1,
                d[i][j - 1] + 1,
                d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return d[m][n];
}
module.exports = function createBrands({ supabase, llmJson }) {
    const now = () => new Date().toISOString();
    const famOk = (f) => /^[a-z0-9 ]{1,60}$/.test(String(f || ""));
    const ingOk = (s) =>
        typeof s === "string" && s.length > 0 && s.length <= 120;

    async function prefMap(owner, ing) {
        const { data, error } = await supabase
            .from("brand_prefs")
            .select("family, favourite, position, uses")
            .eq("owner_id", owner)
            .eq("ing_key", ing);
        if (error) throw error;
        return new Map((data || []).map((r) => [r.family, r]));
    }

    // Which brands doctors in India prescribe most. The model names brands from its own knowledge.
    // A name is kept only when the database has a live brand with exactly this composition.
    // Saved per medicine and strength.
    async function priorOrder(cacheKey, label, cands) {
        if (!llmJson || !cands.length) return [];
        const hit = await supabase
            .from("brand_prior")
            .select("ranked, updated_at")
            .eq("cache_key", cacheKey)
            .maybeSingle();
        if (
            hit.data &&
            Date.now() - new Date(hit.data.updated_at).getTime() < PRIOR_TTL_MS
        ) {
            return Array.isArray(hit.data.ranked) ? hit.data.ranked : [];
        }

        const families = cands.map((c) => c.fam);
        // Exact family, or a family that starts with the named brand ("Crocin" finds "crocin advance")
        const matchName = (name) => {
            const nf = familyOf(name);
            if (!nf) return "";
            return (
                families.find((f) => f === nf) ||
                families.find((f) => f.startsWith(`${nf} `)) ||
                ""
            );
        };
        const ranked = [];
        const add = (f) => {
            if (f && !ranked.includes(f)) ranked.push(f);
        };

        // 1. The model names well-known brands. The database confirms each one.
        const named =
            await llmJson(`List the 15 brand names that doctors in India most commonly prescribe for: ${label}.
Rules:
- Brand names only, for example "Dolo" or "Crocin". No generic names.
- Most commonly prescribed first.
- Only brands you are confident are sold in India. If unsure, leave it out.
- Never list pharmacy-chain or generic-store labels.

Return ONLY JSON: {"brands": ["...", "..."]}`);
        const names = (Array.isArray(named?.brands) ? named.brands : [])
            .map(String)
            .slice(0, 15);
        const matched = [];
        const unmatched = [];
        names.forEach((b) => {
            const f = matchName(b);
            if (f) {
                add(f);
                matched.push(`${b} -> ${f}`);
            } else unmatched.push(b);
        });
        if (process.env.DEBUG_BRANDS) {
            console.log(`\n[brands] ${label}`);
            console.log("  model named:", names.join(", ") || "(nothing)");
            console.log("  matched    :", matched.join(", ") || "(none)");
            console.log("  not in data:", unmatched.join(", ") || "(none)");
        }
        // 2. Too few matched: let the model pick from the database's own list
        if (ranked.length < SHOW) {
            const list = cands.slice(0, PRIOR_CANDIDATES);
            const out =
                await llmJson(`You help doctors in India choose brand names for a medicine.
Below are real brands from a drug database. Each contains exactly: ${label}.
Choose the ${PRIOR_KEEP} that Indian doctors prescribe most often, most common first.
Rules:
- Pick only from the numbered list. Never write a brand that is not in it.
- Prefer long-established brands from established companies.
- Never choose a pharmacy-chain or generic-store label.
- If you are unsure about a brand, leave it out.

Return ONLY JSON: {"ranked": [3, 1, 7]} using the list numbers.

List:
${list.map((c, i) => `${i + 1}. ${c.brand} (${c.manufacturer || "unknown maker"})`).join("\n")}`);
            (Array.isArray(out?.ranked) ? out.ranked : [])
                .map(Number)
                .filter(
                    (n) => Number.isInteger(n) && n >= 1 && n <= list.length,
                )
                .forEach((n) => add(list[n - 1].fam));
        }

        const final = ranked.slice(0, PRIOR_KEEP);
        if (final.length) {
            await supabase
                .from("brand_prior")
                .upsert(
                    { cache_key: cacheKey, ranked: final, updated_at: now() },
                    { onConflict: "cache_key" },
                );
        }
        return final;
    }

    // The eligible brand families for one medicine, established makers first
    async function candidatesFor(med) {
        const p = parseMedication(med.name, med.dosage);
        if (!p.ings.length) return null;
        const ing = ingKey(p.ings);
        const comp = compKey(p.ings);

        let q = supabase
            .from("drug_brands")
            .select("brand, manufacturer, form, price, prominence, composition")
            .eq("discontinued", false);
        q = comp ? q.eq("comp_key", comp) : q.eq("ing_key", ing);
        const { data, error } = await q
            .order("prominence", { ascending: false })
            .limit(1000);
        if (error) throw error;

        const wantModified = isModified(med.name);
        // A name that is only the generic cut short or misspelled ("Amlodip", "Metform", "Cetrizine")
        const stubOf = (fam) =>
            p.ings.some((i) => {
                const g = i.name.replace(/[^a-z]/g, "");
                const f = fam.replace(/[^a-z]/g, "");
                if (f.length < 4 || !g) return false;
                return (
                    (g.startsWith(f) && f.length < g.length) ||
                    (f.length >= 6 && lev(f, g) <= 2)
                );
            });
        let rows = (data || []).filter(
            (r) =>
                !genericLabelled(r.brand, r.composition, r.manufacturer) &&
                (wantModified || !isModified(r.brand)),
        );
        if (p.form) {
            const same = rows.filter((r) => r.form === p.form);
            if (same.length) rows = same;
        } else {
            const oral = rows.filter(
                (r) => r.form === "tablet" || r.form === "capsule",
            );
            if (oral.length) rows = oral;
        }

        // One product per brand family. An established maker beats a small one.
        const byFam = new Map();
        for (const r of rows) {
            const fam = familyOf(r.brand);
            if (!fam) continue;
            const est = ESTABLISHED_RE.test(r.manufacturer || "");
            const cur = byFam.get(fam);
            const better =
                !cur ||
                (est && !cur.est) ||
                (est === cur.est &&
                    Number(r.prominence) > Number(cur.prominence));
            if (better) byFam.set(fam, { ...r, fam, est, stub: stubOf(fam) });
        }
        const cands = [...byFam.values()].sort(
            (a, b) =>
                Number(b.est) - Number(a.est) ||
                Number(a.stub) - Number(b.stub) ||
                Number(b.prominence) - Number(a.prominence),
        );
        const label = p.ings
            .map((i) => `${i.name} ${i.strength}`.trim())
            .join(" + ");
        const key = `${comp || ing}|${p.form || "-"}|${wantModified ? "m" : "-"}`;
        return { p, ing, comp, cands, label, key };
    }

    // Up to three brands for one medicine
    async function lookupOne(owner, med) {
        const c = await candidatesFor(med);
        if (!c) return { id: med.id, brands: [] };
        if (!c.cands.length) return { id: med.id, ingKey: c.ing, brands: [] };

        const prefs = await prefMap(owner, c.ing);
        const favCount = c.cands.filter(
            (x) => prefs.get(x.fam)?.favourite,
        ).length;
        let order = [];
        if (favCount < SHOW) {
            const run = priorOrder(c.key, c.label, c.cands).catch((err) => {
                console.log("⚠️ Brand ranking failed:", err.message);
                return [];
            });
            // Do not keep the doctor waiting. If the model is slow, show the fallback now.
            // The ranking finishes in the background and is used next time.
            order =
                (await Promise.race([
                    run,
                    new Promise((r) => setTimeout(() => r(null), RANK_WAIT_MS)),
                ])) || [];
        }
        const rank = new Map(order.map((f, i) => [f, i]));

        const scored = c.cands.map((x) => {
            const pr = prefs.get(x.fam);
            let score =
                Number(x.prominence || 0) +
                (x.est ? 50 : 0) -
                (x.stub ? 40 : 0);
            if (rank.has(x.fam)) score = 10000 - rank.get(x.fam) * 100;
            if (LEARN_FROM_APPROVALS && pr?.uses)
                score = 100000 + Math.min(pr.uses, 1000);
            if (pr?.favourite) score = 1000000 - (pr.position || 0);
            return { x, score, fav: !!pr?.favourite };
        });
        const brands = scored
            .sort((a, b) => b.score - a.score)
            .slice(0, SHOW)
            .map(({ x, fav }) => ({
                name: x.brand,
                family: x.fam,
                manufacturer: x.manufacturer || "",
                price: x.price ?? null,
                favourite: fav,
            }));
        return { id: med.id, ingKey: c.ing, brands };
    }

    // Start the ranking for a list of medicines. Runs in the background, one at a time.
    async function warm(meds) {
        for (const med of meds || []) {
            try {
                const c = await candidatesFor({
                    name: String(med?.name || ""),
                    dosage: med?.dosage || [],
                });
                if (c && c.cands.length)
                    await priorOrder(c.key, c.label, c.cands);
            } catch (err) {
                console.log("⚠️ Brand warm-up failed:", err.message);
            }
        }
    }

    // Generic-name search for the settings screen
    async function searchIngredients(q) {
        const t = String(q || "")
            .toLowerCase()
            .replace(/[^a-z0-9 +]/g, "")
            .trim()
            .slice(0, 60);
        if (t.length < 2) return [];
        const canon = canonIngredient(t);
        const terms = [
            ...new Set([t, canon].filter((x) => x && x.length >= 2)),
        ];
        const found = new Map();
        for (const term of terms) {
            const { data } = await supabase
                .from("drug_ingredients")
                .select("ing_key, label, brand_count")
                .ilike("ing_key", `%${term}%`)
                .order("brand_count", { ascending: false })
                .limit(12);
            (data || []).forEach((r) => found.set(r.ing_key, r));
        }
        return [...found.values()]
            .sort((a, b) => b.brand_count - a.brand_count)
            .slice(0, 12);
    }

    // Brand families for one ingredient. Pharmacy-chain labels are left out.
    async function families(ing) {
        if (!ingOk(ing)) return { ing_key: ing, label: ing, families: [] };
        const { data, error } = await supabase
            .from("drug_brands")
            .select("brand, manufacturer, comp_key, composition, prominence")
            .eq("ing_key", ing)
            .eq("discontinued", false)
            .order("prominence", { ascending: false })
            .limit(1000);
        if (error) throw error;
        const map = new Map();
        for (const r of data || []) {
            if (genericLabelled(r.brand, r.composition, r.manufacturer))
                continue;
            const fam = familyOf(r.brand);
            if (!fam) continue;
            if (!map.has(fam))
                map.set(fam, {
                    family: fam,
                    sample: r.brand,
                    manufacturer: r.manufacturer || "",
                    strengths: new Set(),
                });
            map.get(fam).strengths.add(r.comp_key.replace(`${ing} `, ""));
        }
        const { data: lab } = await supabase
            .from("drug_ingredients")
            .select("label")
            .eq("ing_key", ing)
            .maybeSingle();
        return {
            ing_key: ing,
            label: lab?.label || ing,
            families: [...map.values()].slice(0, 60).map((f) => ({
                ...f,
                strengths: [...f.strengths].slice(0, 6),
            })),
        };
    }

    async function listPrefs(owner) {
        const { data, error } = await supabase
            .from("brand_prefs")
            .select("ing_key, family, position")
            .eq("owner_id", owner)
            .eq("favourite", true)
            .order("position", { ascending: true });
        if (error) throw error;
        const groups = new Map();
        (data || []).forEach((r) => {
            if (!groups.has(r.ing_key)) groups.set(r.ing_key, []);
            groups.get(r.ing_key).push(r.family);
        });
        const keys = [...groups.keys()];
        const labels = new Map();
        if (keys.length) {
            const { data: l } = await supabase
                .from("drug_ingredients")
                .select("ing_key, label")
                .in("ing_key", keys);
            (l || []).forEach((r) => labels.set(r.ing_key, r.label));
        }
        return keys.map((k) => ({
            ing_key: k,
            label: labels.get(k) || k,
            families: groups.get(k),
        }));
    }

    // Replace the ordered favourites of one medicine
    async function saveFavourites(owner, ing, fams) {
        if (!ingOk(ing)) throw new Error("Invalid medicine");
        const list = [...new Set((fams || []).map(String))]
            .filter(famOk)
            .slice(0, 6);
        const off = await supabase
            .from("brand_prefs")
            .update({ favourite: false })
            .eq("owner_id", owner)
            .eq("ing_key", ing);
        if (off.error) throw off.error;
        if (!list.length) return;
        const { error } = await supabase.from("brand_prefs").upsert(
            list.map((family, i) => ({
                owner_id: owner,
                ing_key: ing,
                family,
                favourite: true,
                position: i,
                updated_at: now(),
            })),
            { onConflict: "owner_id,ing_key,family" },
        );
        if (error) throw error;
    }

    async function setFavourite(owner, ing, family, on) {
        if (!ingOk(ing) || !famOk(family)) throw new Error("Invalid brand");
        if (!on) {
            const { error } = await supabase
                .from("brand_prefs")
                .update({ favourite: false, updated_at: now() })
                .eq("owner_id", owner)
                .eq("ing_key", ing)
                .eq("family", family);
            if (error) throw error;
            return;
        }
        const { data } = await supabase
            .from("brand_prefs")
            .select("position")
            .eq("owner_id", owner)
            .eq("ing_key", ing)
            .eq("favourite", true)
            .order("position", { ascending: false })
            .limit(1);
        const position = data?.[0] ? data[0].position + 1 : 0;
        const { error } = await supabase.from("brand_prefs").upsert(
            {
                owner_id: owner,
                ing_key: ing,
                family,
                favourite: true,
                position,
                updated_at: now(),
            },
            { onConflict: "owner_id,ing_key,family" },
        );
        if (error) throw error;
    }

    // Called when a doctor approves a brand
    async function bump(owner, medName, dosage, brandName) {
        if (!LEARN_FROM_APPROVALS) return;
        const p = parseMedication(medName, dosage);
        if (!p.ings.length) return;
        const ing = ingKey(p.ings);
        const family = familyOf(brandName);
        if (!family) return;
        const { data } = await supabase
            .from("brand_prefs")
            .select("uses")
            .eq("owner_id", owner)
            .eq("ing_key", ing)
            .eq("family", family)
            .maybeSingle();
        await supabase.from("brand_prefs").upsert(
            {
                owner_id: owner,
                ing_key: ing,
                family,
                uses: (data?.uses || 0) + 1,
                updated_at: now(),
            },
            { onConflict: "owner_id,ing_key,family" },
        );
    }

    return {
        lookupOne,
        searchIngredients,
        families,
        listPrefs,
        saveFavourites,
        setFavourite,
        bump,
        warm,
    };
};
