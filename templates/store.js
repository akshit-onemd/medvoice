// Reading and choosing templates. Only built-in templates (owner_id null) and the doctor's
// own are ever usable; anything else quietly falls back, so one doctor can never load
// another's template.
const generic = require("./builtin/generic.json");

const GENERIC_ID = generic.id;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { id: _gid, ...GENERIC_DEF } = generic; // eslint-disable-line no-unused-vars
const FILE_GENERIC = { id: GENERIC_ID, version: 1, name: generic.name, definition: GENERIC_DEF };

const usable = (row, ownerId) => !!row && (row.owner_id == null || row.owner_id === ownerId);

async function templateRow(supabase, id) {
    if (!id || !UUID_RE.test(String(id))) return null;
    const { data, error } = await supabase
        .from("templates")
        .select("id, owner_id, name, specialty, kind, current_version, archived")
        .eq("id", id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

// A saved version never changes, so each one is read from the database once per server process
const versionCache = new WeakMap(); // supabase client -> Map("id:version" -> definition)
function cacheFor(supabase) {
    let m = versionCache.get(supabase);
    if (!m) versionCache.set(supabase, (m = new Map()));
    return m;
}

async function versionOf(supabase, row, version) {
    const cache = cacheFor(supabase);
    const key = `${row.id}:${version}`;
    if (cache.has(key))
        return { id: row.id, version, name: row.name, definition: cache.get(key) };
    const { data, error } = await supabase
        .from("template_versions")
        .select("definition")
        .eq("template_id", row.id)
        .eq("version", version)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (cache.size > 500) cache.clear();
    cache.set(key, data.definition);
    return { id: row.id, version, name: row.name, definition: data.definition };
}

async function defaultIdOf(supabase, ownerId) {
    const { data, error } = await supabase
        .from("doctors")
        .select("default_template_id")
        .eq("owner_id", ownerId)
        .maybeSingle();
    if (error) throw error;
    return data?.default_template_id || null;
}

async function genericTemplate(supabase) {
    const row = await templateRow(supabase, GENERIC_ID);
    return (row && (await versionOf(supabase, row, row.current_version))) || FILE_GENERIC;
}

// A database problem (table not created yet, a timeout) must never stop a visit:
// fall back to the generic template from the file and log it.
const safely = (fn, label) =>
    async (...args) => {
        try {
            return await fn(...args);
        } catch (err) {
            console.log(`⚠️ ${label} failed, using the generic template:`, err.message);
            return FILE_GENERIC;
        }
    };

// The template to use for a new visit: requested, else the doctor's default, else generic
async function resolveTemplateRaw(supabase, ownerId, templateId) {
    // The chosen template first; the doctor's default is only looked up when needed
    const tryId = async (id) => {
        const row = await templateRow(supabase, id);
        if (!usable(row, ownerId) || row.archived) return null;
        return versionOf(supabase, row, row.current_version);
    };
    return (
        (templateId && (await tryId(templateId))) ||
        (await tryId(await defaultIdOf(supabase, ownerId))) ||
        genericTemplate(supabase)
    );
}

// The exact template version a saved note was made with (generic for older notes)
async function templateForNoteRaw(supabase, ownerId, ref) {
    const row = await templateRow(supabase, ref?.id);
    if (usable(row, ownerId) && Number.isInteger(ref?.version)) {
        const t = await versionOf(supabase, row, ref.version);
        if (t) return t;
    }
    return genericTemplate(supabase);
}

const resolveTemplate = safely(resolveTemplateRaw, "Template lookup");
const templateForNote = safely(templateForNoteRaw, "Note template lookup");

async function listTemplates(supabase, ownerId) {
    // Two plain queries rather than one or() filter, so the owner id is never put into a filter string
    const cols = "id, owner_id, name, specialty, kind, archived";
    // All three at once: one round trip instead of two
    const [builtins, own, def] = await Promise.all([
        supabase.from("templates").select(cols).is("owner_id", null),
        supabase.from("templates").select(cols).eq("owner_id", ownerId),
        defaultIdOf(supabase, ownerId),
    ]);
    if (builtins.error) throw builtins.error;
    if (own.error) throw own.error;
    const rows = [...(builtins.data || []), ...(own.data || [])].filter(
        (r) => usable(r, ownerId) && !r.archived,
    );
    const effective = rows.some((r) => r.id === def) ? def : GENERIC_ID;
    return rows
        .map((r) => ({
            id: r.id,
            name: r.name,
            specialty: r.specialty || null,
            kind: r.kind || null,
            builtin: r.owner_id == null,
            isDefault: r.id === effective,
        }))
        .sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1));
}

async function setDefaultTemplate(supabase, ownerId, templateId) {
    if (templateId != null) {
        const row = await templateRow(supabase, templateId);
        if (!usable(row, ownerId) || row.archived) throw new Error("Template not found");
    }
    const { error } = await supabase
        .from("doctors")
        .update({ default_template_id: templateId ?? null })
        .eq("owner_id", ownerId);
    if (error) throw error;
}

// For server-side context only (AI plan, overview, PDF): the definition a note was made with.
// The note itself was already checked to belong to the doctor.
async function noteDefinitionRaw(supabase, ref) {
    const row = await templateRow(supabase, ref?.id);
    if (row && Number.isInteger(ref?.version)) {
        const t = await versionOf(supabase, row, ref.version);
        if (t) return t;
    }
    return genericTemplate(supabase);
}
const noteDefinition = safely(noteDefinitionRaw, "Note definition lookup");

// One template with its current definition, if the doctor may see it
async function getTemplate(supabase, ownerId, id) {
    const row = await templateRow(supabase, id);
    if (!usable(row, ownerId) || row.archived) return null;
    const t = await versionOf(supabase, row, row.current_version);
    if (!t) return null;
    return {
        ...t,
        specialty: row.specialty || null,
        kind: row.kind || null,
        builtin: row.owner_id == null,
    };
}

const KINDS = ["new", "follow_up", "condition"];
// def must already be validated
async function createTemplate(supabase, ownerId, def) {
    const { data, error } = await supabase
        .from("templates")
        .insert({
            owner_id: ownerId,
            name: def.name,
            specialty: def.specialty ? String(def.specialty).slice(0, 60) : null,
            kind: KINDS.includes(def.kind) ? def.kind : null,
            current_version: 1,
        })
        .select("id")
        .single();
    if (error) throw error;
    const { id: _drop, ...definition } = def; // eslint-disable-line no-unused-vars
    const v = await supabase
        .from("template_versions")
        .insert({ template_id: data.id, version: 1, definition });
    if (v.error) {
        await supabase.from("templates").delete().eq("id", data.id);
        throw v.error;
    }
    return data.id;
}

// Saving a change adds a new version; notes keep pointing at the version they were made with
async function updateTemplate(supabase, ownerId, id, def) {
    const row = await templateRow(supabase, id);
    if (!row || row.owner_id !== ownerId || row.archived) throw new Error("Template not found");
    const version = row.current_version + 1;
    const { id: _drop, ...definition } = def; // eslint-disable-line no-unused-vars
    const v = await supabase
        .from("template_versions")
        .insert({ template_id: id, version, definition });
    if (v.error) throw v.error;
    const { error } = await supabase
        .from("templates")
        .update({
            name: def.name,
            specialty: def.specialty ? String(def.specialty).slice(0, 60) : null,
            kind: KINDS.includes(def.kind) ? def.kind : null,
            current_version: version,
            updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("owner_id", ownerId);
    if (error) throw error;
    return version;
}

async function deleteTemplate(supabase, ownerId, id) {
    const row = await templateRow(supabase, id);
    if (!row || row.owner_id !== ownerId) throw new Error("Template not found");
    // Hidden, not removed: notes made with it keep their layout
    if ((await defaultIdOf(supabase, ownerId)) === id) await setDefaultTemplate(supabase, ownerId, null);
    const { error } = await supabase
        .from("templates")
        .update({ archived: true, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("owner_id", ownerId);
    if (error) throw error;
}

async function countOwn(supabase, ownerId) {
    const { count, error } = await supabase
        .from("templates")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", ownerId)
        .eq("archived", false);
    if (error) throw error;
    return count || 0;
}

module.exports = {
    GENERIC_ID,
    resolveTemplate,
    templateForNote,
    noteDefinition,
    listTemplates,
    setDefaultTemplate,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    countOwn,
};
