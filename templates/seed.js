// Loads every built-in template in templates/builtin/ into the database.
// Run after the SQL in sql/2026-11-13-templates.sql:  node templates/seed.js
// Adds a new version only when a definition changed. Safe to run any number of times.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { createClient } = require("@supabase/supabase-js");
const { validateTemplate } = require("./validate");

const KINDS = { new: "new", follow_up: "follow_up", condition: "condition" };

async function seed(supabase, dir = path.join(__dirname, "builtin")) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const defs = files.map((f) => {
        const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const v = validateTemplate(def);
        if (!v.ok) throw new Error(`${f}: ${v.errors.join("; ")}`);
        if (!def.id) throw new Error(`${f}: a built-in template needs a fixed "id"`);
        return v.value;
    });
    const out = [];
    for (const def of defs) {
        const { id, ...definition } = def;
        const { data: row, error } = await supabase
            .from("templates")
            .select("id, current_version")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!row) {
            const ins = await supabase.from("templates").insert({
                id,
                owner_id: null,
                name: def.name,
                specialty: def.specialty || null,
                kind: KINDS[def.kind] || null,
                current_version: 1,
            });
            if (ins.error) throw ins.error;
            const v = await supabase
                .from("template_versions")
                .insert({ template_id: id, version: 1, definition });
            if (v.error) throw v.error;
            out.push(`${def.name} v1 seeded`);
            continue;
        }
        const { data: cur, error: e2 } = await supabase
            .from("template_versions")
            .select("definition")
            .eq("template_id", id)
            .eq("version", row.current_version)
            .maybeSingle();
        if (e2) throw e2;
        // jsonb does not keep key order, so compare by value, not as strings
        if (cur && isDeepStrictEqual(cur.definition, definition)) {
            out.push(`${def.name} unchanged`);
            continue;
        }
        const next = row.current_version + 1;
        const v = await supabase
            .from("template_versions")
            .insert({ template_id: id, version: next, definition });
        if (v.error) throw v.error;
        const u = await supabase
            .from("templates")
            .update({
                name: def.name,
                specialty: def.specialty || null,
                kind: KINDS[def.kind] || null,
                current_version: next,
                updated_at: new Date().toISOString(),
            })
            .eq("id", id);
        if (u.error) throw u.error;
        out.push(`${def.name} v${next} seeded`);
    }
    return out;
}

if (require.main === module) {
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    seed(supabase)
        .then((lines) => lines.forEach((l) => console.log(l)))
        .catch((err) => {
            console.error("Seeding failed:", err.message);
            process.exit(1);
        });
}

module.exports = { seed };
