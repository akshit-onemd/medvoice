const test = require("node:test");
const assert = require("node:assert/strict");
const { seed } = require("../../templates/seed");
const { fakeSupabase } = require("../helpers/fakeSupabase");
const fs = require("fs");
const os = require("os");
const path = require("path");
// Only the generic template, so these tests don't change as built-ins are added
const ONLY_GENERIC = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-"));
fs.copyFileSync(
    path.join(__dirname, "../../templates/builtin/generic.json"),
    path.join(ONLY_GENERIC, "generic.json"),
);

test("seeds the generic template once, then reports it unchanged", async () => {
    const sb = fakeSupabase({ templates: [], template_versions: [] });
    assert.deepEqual(await seed(sb, ONLY_GENERIC), ["General OPD v1 seeded"]);
    assert.deepEqual(await seed(sb, ONLY_GENERIC), ["General OPD unchanged"]);
    assert.equal(sb.db.templates.length, 1);
    assert.equal(sb.db.templates[0].owner_id, null);
    assert.equal(sb.db.template_versions.length, 1);
});

test("adds a new version when the stored definition differs", async () => {
    const sb = fakeSupabase({
        templates: [
            { id: "00000000-0000-4000-8000-000000000001", owner_id: null, current_version: 1 },
        ],
        template_versions: [
            { template_id: "00000000-0000-4000-8000-000000000001", version: 1, definition: { name: "old" } },
        ],
    });
    assert.deepEqual(await seed(sb, ONLY_GENERIC), ["General OPD v2 seeded"]);
    assert.equal(sb.db.templates[0].current_version, 2);
});

test("treats a stored definition with reordered keys as unchanged (jsonb does not keep key order)", async () => {
    const generic = require("../../templates/builtin/generic.json");
    const { validateTemplate } = require("../../templates/validate");
    const { id, ...def } = validateTemplate(generic).value;
    const reorder = (v) =>
        Array.isArray(v)
            ? v.map(reorder)
            : v && typeof v === "object"
              ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reorder(v[k])]))
              : v;
    const sb = fakeSupabase({
        templates: [{ id, owner_id: null, current_version: 1 }],
        template_versions: [{ template_id: id, version: 1, definition: reorder(def) }],
    });
    assert.deepEqual(await seed(sb, ONLY_GENERIC), ["General OPD unchanged"]);
});
