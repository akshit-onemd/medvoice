const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTemplate } = require("../../templates/validate");
const { CLINICAL_TYPES } = require("../../templates/sectionTypes");
const generic = require("../../templates/builtin/generic.json");

test("generic template is valid", () => {
    assert.equal(validateTemplate(generic).ok, true);
});

test("generic template has every clinical type, in registry order", () => {
    assert.deepEqual(
        generic.sections.map((s) => s.id),
        CLINICAL_TYPES,
    );
    assert.deepEqual(
        generic.sections.map((s) => s.type),
        CLINICAL_TYPES,
    );
});
