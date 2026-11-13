const test = require("node:test");
const assert = require("node:assert");
const { repairTemplate } = require("../../templates/repair");
const { validateTemplate } = require("../../templates/validate");

test("a messy model draft becomes a valid template", () => {
    const messy = {
        name: "Diabetes Follow-Up",
        kind: "follow-up",
        sections: [
            { id: "Chief-Complaints", type: "Symptoms" },
            { id: "HbA1c Panel", type: "values", title: "Sugar control", fields: [{ key: "HbA1c", label: "HbA1c", unit: "%" }, "FBS", { label: "HbA1c" }] },
            { type: "checkbox", title: "Screening", items: [{ label: "Retinopathy" }, "retinopathy", "Neuropathy"] },
            { type: "select", title: "Hypos", options: [] },
            { type: "score", title: "Pain", min: 10, max: 0 },
            { type: "medications" },
            { type: "prescription" },
            { type: "unknown_thing" },
            { id: "1st", type: "text", title: "Notes" },
        ],
    };
    const v = validateTemplate(repairTemplate(messy));
    assert.ok(v.ok, v.errors.join("; "));
    const types = v.value.sections.map((s) => s.type);
    assert.deepEqual(types, ["complaints", "values", "checklist", "text", "score", "prescription", "text"]);
    assert.deepEqual(v.value.sections[1].fields.map((f) => f.key), ["hba1c", "fbs", "hba1c_2"]);
    assert.equal(v.value.kind, "follow_up");
});

test("a template sent as a string or empty", () => {
    assert.equal(repairTemplate("not json"), null);
    assert.equal(validateTemplate(repairTemplate({ sections: [] })).ok, false);
});
