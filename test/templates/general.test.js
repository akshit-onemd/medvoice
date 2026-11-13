const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { validateTemplate } = require("../../templates/validate");
const { buildExtractionPrompt, buildSkeleton } = require("../../templates/prompt");
const { normalizeExtraction } = require("../../templates/normalize");
const { voiceSpecFor, limitRowsToTemplate } = require("../../templates/voice");
const g = require("../../templates/general");

const dir = path.join(__dirname, "../../templates/builtin");
const load = (f) => validateTemplate(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).value;
const follow = load("endo-03-diabetes-follow-up.json");

test("every built-in template is valid", () => {
    for (const f of fs.readdirSync(dir)) {
        const v = validateTemplate(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        assert.ok(v.ok, `${f}: ${v.errors.join("; ")}`);
    }
});

test("general sections reject bad settings", () => {
    const v = validateTemplate({
        name: "x",
        sections: [
            { id: "a", type: "values", title: "A", fields: [] },
            { id: "b", type: "score", title: "B", min: 5, max: 1 },
            { id: "c", type: "choice", title: "C", options: ["x", "X"] },
        ],
    });
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 3);
});

test("prompt and skeleton carry custom sections", () => {
    const sk = buildSkeleton(follow);
    assert.deepEqual(Object.keys(sk.custom), ["anthropometry", "glycaemic", "smbg", "hypos", "adherence", "control"]);
    assert.equal(sk.custom.glycaemic.hba1c, "");
    const p = buildExtractionPrompt(follow, "hello", "A\n# Template\n{{template}}\n{{transcript}}");
    assert.match(p, /custom\.glycaemic \("Glycaemic profile"\)/);
    assert.ok(p.indexOf("# Sections") < p.indexOf("# Template"));
});

test("normalize coerces each shape", () => {
    const out = normalizeExtraction(follow, {
        custom: {
            glycaemic: { hba1c: 8.2, junk: "x" },
            smbg: [{ when: "fasting", reading: "160" }, { when: "" }],
            hypos: { selected: ["none", "Hospital visit"] },
            adherence: "good",
        },
    });
    assert.equal(out.custom.glycaemic.hba1c, "8.2");
    assert.equal(out.custom.glycaemic.junk, undefined);
    assert.equal(out.custom.smbg.length, 1);
    assert.deepEqual(out.custom.hypos.selected, ["None"]);
    assert.deepEqual(out.custom.adherence.selected, []);
});

test("checklist and score", () => {
    const cl = { id: "c", type: "checklist", items: ["Retinopathy", "Neuropathy"] };
    const v = g.normalizeGeneral(cl, [{ item: "neuropathy", status: "Yes" }]);
    assert.deepEqual(v.map((x) => x.status), ["", "yes"]);
    const sc = { id: "s", type: "score", min: 0, max: 10 };
    assert.equal(g.normalizeGeneral(sc, { value: "12" }).value, "");
    assert.equal(g.normalizeGeneral(sc, { value: "7" }).value, "7");
});

test("voice: custom rules, rows limited and merged", () => {
    const spec = voiceSpecFor(follow);
    assert.match(spec.skeleton, /"custom"/);
    const rows = limitRowsToTemplate(follow, { custom: { glycaemic: { hba1c: "7.1" }, nope: { a: 1 }, hypos: { selected: [] } } });
    assert.deepEqual(Object.keys(rows.custom), ["glycaemic"]);
    const s = follow.sections.find((x) => x.id === "glycaemic");
    const m = g.mergeGeneral(s, { hba1c: "8", fbs: "150" }, { hba1c: "7.1" });
    assert.equal(m.hba1c, "7.1");
    assert.equal(m.fbs, "150");
    assert.equal(g.contextLine(s, m), "Glycaemic profile: HbA1c 7.1 %; Fasting glucose 150 mg/dL");
});
