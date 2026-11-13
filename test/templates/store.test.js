const test = require("node:test");
const assert = require("node:assert/strict");
const {
    GENERIC_ID,
    resolveTemplate,
    templateForNote,
    listTemplates,
    setDefaultTemplate,
} = require("../../templates/store");
const { fakeSupabase } = require("../helpers/fakeSupabase");

const A = "11111111-1111-4111-8111-111111111111"; // built-in
const MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";
const def = (name) => ({ name, sections: [{ id: "dx", type: "diagnosis" }] });

function db({ defaultId = null } = {}) {
    return fakeSupabase({
        templates: [
            { id: GENERIC_ID, owner_id: null, name: "General OPD", specialty: "General Medicine", kind: "new", current_version: 1 },
            { id: A, owner_id: null, name: "Diabetes follow-up", specialty: "Endocrinology", kind: "follow_up", current_version: 1 },
            { id: MINE, owner_id: "doc1", name: "My clinic", specialty: null, kind: null, current_version: 2 },
            { id: THEIRS, owner_id: "doc2", name: "Theirs", specialty: null, kind: null, current_version: 1 },
        ],
        template_versions: [
            { template_id: GENERIC_ID, version: 1, definition: def("General OPD") },
            { template_id: A, version: 1, definition: def("Diabetes follow-up") },
            { template_id: MINE, version: 1, definition: def("My clinic v1") },
            { template_id: MINE, version: 2, definition: def("My clinic v2") },
            { template_id: THEIRS, version: 1, definition: def("Theirs") },
        ],
        doctors: [{ owner_id: "doc1", default_template_id: defaultId }],
    });
}

test("uses the requested built-in template", async () => {
    const t = await resolveTemplate(db(), "doc1", A);
    assert.equal(t.id, A);
    assert.equal(t.version, 1);
    assert.equal(t.name, "Diabetes follow-up");
    assert.equal(t.definition.name, "Diabetes follow-up");
});

test("uses the doctor's own template at its current version", async () => {
    const t = await resolveTemplate(db(), "doc1", MINE);
    assert.equal(t.version, 2);
    assert.equal(t.definition.name, "My clinic v2");
});

test("ignores another owner's template", async () => {
    const t = await resolveTemplate(db({ defaultId: A }), "doc1", THEIRS);
    assert.equal(t.id, A);
});

test("uses the doctor's default when none requested", async () => {
    const t = await resolveTemplate(db({ defaultId: MINE }), "doc1");
    assert.equal(t.id, MINE);
});

test("falls back to generic when default is gone", async () => {
    const t = await resolveTemplate(
        db({ defaultId: "44444444-4444-4444-8444-444444444444" }),
        "doc1",
    );
    assert.equal(t.id, GENERIC_ID);
});

test("works before the seed runs", async () => {
    const t = await resolveTemplate(fakeSupabase({}), "doc1", A);
    assert.equal(t.id, GENERIC_ID);
    assert.equal(t.version, 1);
    assert.equal(t.name, "General OPD");
    assert.ok(t.definition.sections.length >= 15);
});

test("templateForNote loads the stored version, not the current one", async () => {
    const t = await templateForNote(db(), "doc1", { id: MINE, version: 1 });
    assert.equal(t.version, 1);
    assert.equal(t.definition.name, "My clinic v1");
});

test("templateForNote falls back to generic for old notes and foreign templates", async () => {
    assert.equal((await templateForNote(db(), "doc1", undefined)).id, GENERIC_ID);
    assert.equal(
        (await templateForNote(db(), "doc1", { id: THEIRS, version: 1 })).id,
        GENERIC_ID,
    );
});

test("listTemplates shows built-ins first, then mine, never others'", async () => {
    const list = await listTemplates(db({ defaultId: MINE }), "doc1");
    assert.deepEqual(
        list.map((t) => [t.name, t.builtin, t.isDefault]),
        [
            ["Diabetes follow-up", true, false],
            ["General OPD", true, false],
            ["My clinic", false, true],
        ],
    );
});

test("setDefaultTemplate saves a usable template", async () => {
    const sb = db();
    await setDefaultTemplate(sb, "doc1", A);
    assert.equal(sb.db.doctors[0].default_template_id, A);
    await setDefaultTemplate(sb, "doc1", null);
    assert.equal(sb.db.doctors[0].default_template_id, null);
});

test("setDefaultTemplate rejects another owner's template", async () => {
    await assert.rejects(setDefaultTemplate(db(), "doc1", THEIRS), /Template not found/);
});

test("listTemplates marks generic as default when none is set", async () => {
    const list = await listTemplates(db(), "doc1");
    assert.deepEqual(list.filter((t) => t.isDefault).map((t) => t.id), [GENERIC_ID]);
});

const broken = () => ({
    from: () => {
        const q = {
            select: () => q,
            eq: () => q,
            is: () => q,
            maybeSingle: async () => ({ data: null, error: new Error('relation "templates" does not exist') }),
            then: (res) => res({ data: null, error: new Error("boom") }),
        };
        return q;
    },
});

test("resolveTemplate falls back to generic when the database errors", async () => {
    const t = await resolveTemplate(broken(), "doc1", A);
    assert.equal(t.id, GENERIC_ID);
});

test("templateForNote falls back to generic when the database errors", async () => {
    const t = await templateForNote(broken(), "doc1", { id: A, version: 1 });
    assert.equal(t.id, GENERIC_ID);
});
