const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeExtraction } = require("../../templates/normalize");
const generic = require("../../templates/builtin/generic.json");

const dxOnly = { name: "X", sections: [{ id: "dx", type: "diagnosis" }] };
const EMPTY_SUMMARY = { overview: "", details: [] };

test("drops sections the template lacks", () => {
    const out = normalizeExtraction(dxOnly, {
        allergies: [{ name: "Dust" }],
        prescription: { diagnosis: [{ name: "URTI" }], medications: [{ name: "X" }] },
    });
    assert.deepEqual(out, {
        prescription: { diagnosis: [{ name: "URTI" }] },
        consultation_summary: EMPTY_SUMMARY,
    });
});

test("fills missing sections", () => {
    const out = normalizeExtraction(generic, {});
    for (const k of ["allergies", "conditions", "medication_history", "investigation_history", "procedures", "family_history", "lifestyle_habits", "social_history", "other_history", "system_review"])
        assert.deepEqual(out[k], [], k);
    for (const k of ["symptoms", "medications", "diagnosis", "followup"])
        assert.deepEqual(out.prescription[k], [], k);
    assert.equal(out.vitals.length, 6);
    assert.ok(out.vitals.every((v) => v.value === ""));
    assert.deepEqual(out.consultation_summary, EMPTY_SUMMARY);
});

test("repairs wrong kinds", () => {
    const out = normalizeExtraction(generic, { allergies: "none", prescription: "x" });
    assert.deepEqual(out.allergies, []);
    assert.deepEqual(out.prescription.medications, []);
});

test("keeps the model's summary and values", () => {
    const summary = { overview: "Fever for 2 days", details: ["fever"] };
    const out = normalizeExtraction(generic, {
        consultation_summary: summary,
        conditions: [{ name: "Asthma" }],
    });
    assert.deepEqual(out.consultation_summary, summary);
    assert.deepEqual(out.conditions, [{ name: "Asthma" }]);
});
