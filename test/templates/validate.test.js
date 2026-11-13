const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTemplate } = require("../../templates/validate");

const sec = (id, type, extra = {}) => ({ id, type, ...extra });
const tpl = (sections, name = "X") => ({ name, sections });

test("accepts a minimal template and fills defaults", () => {
    const r = validateTemplate(tpl([sec("dx", "diagnosis")]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.sections[0].title, "Diagnosis");
    assert.equal(r.value.sections[0].print, true);
    assert.equal(r.value.sections[0].showEmpty, false);
    assert.equal(r.value.sections[0].instructions, "");
});

test("rejects more than 25 sections", () => {
    const many = Array.from({ length: 26 }, (_, i) => sec(`s${i}`, "diagnosis"));
    const r = validateTemplate(tpl(many));
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes("At most 25 sections"));
});

test("rejects an invalid section id", () => {
    const r = validateTemplate(tpl([sec("Dx-1", "diagnosis")]));
    assert.ok(r.errors.includes('Section id "Dx-1" is invalid'));
});

test("rejects duplicate ids", () => {
    const r = validateTemplate(
        tpl([sec("dx", "diagnosis"), sec("dx", "complaints")]),
    );
    assert.ok(r.errors.includes('Duplicate section id "dx"'));
});

test("rejects unknown types", () => {
    const r = validateTemplate(tpl([sec("t", "tooth_chart")]));
    assert.ok(r.errors.includes('Unknown section type "tooth_chart"'));
});

test("rejects a clinical type used twice", () => {
    const r = validateTemplate(
        tpl([sec("a", "diagnosis"), sec("b", "diagnosis")]),
    );
    assert.ok(r.errors.includes('Section type "diagnosis" used more than once'));
});

test("rejects long titles and instructions", () => {
    const r1 = validateTemplate(tpl([sec("dx", "diagnosis", { title: "x".repeat(61) })]));
    assert.ok(r1.errors.includes('Title too long in "dx"'));
    const r2 = validateTemplate(
        tpl([sec("dx", "diagnosis", { instructions: "x".repeat(301) })]),
    );
    assert.ok(r2.errors.includes('Instructions too long in "dx"'));
});

test("requires at least one section", () => {
    const r = validateTemplate(tpl([]));
    assert.ok(r.errors.includes("A template needs at least one section"));
});

test("checks the name", () => {
    assert.ok(validateTemplate(tpl([sec("dx", "diagnosis")], "")).errors.includes("Template name is required"));
    assert.ok(
        validateTemplate(tpl([sec("dx", "diagnosis")], "n".repeat(81))).errors.includes(
            "Template name too long",
        ),
    );
});
