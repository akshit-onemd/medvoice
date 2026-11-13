const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
    SECTION_TYPES,
    CLINICAL_TYPES,
    storageKey,
} = require("../../templates/sectionTypes");

test("registry lists the 15 clinical types in order", () => {
    assert.deepEqual(CLINICAL_TYPES, [
        "diagnosis",
        "complaints",
        "prescription",
        "followup",
        "vitals",
        "allergies",
        "conditions",
        "medication_history",
        "investigations",
        "procedures",
        "examination",
        "family_history",
        "lifestyle",
        "social_history",
        "other_history",
    ]);
});

test("each skeleton equals today's template.json at its path", () => {
    const tpl = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../template.json"), "utf8"),
    );
    for (const t of CLINICAL_TYPES) {
        const at = SECTION_TYPES[t].storage.reduce((o, k) => o[k], tpl);
        assert.deepEqual(SECTION_TYPES[t].skeleton, at, t);
    }
});

test("storageKey joins the path", () => {
    assert.equal(storageKey("prescription"), "prescription.medications");
    assert.equal(storageKey("examination"), "system_review");
});

test("every type has a voice rule naming its storage key", () => {
    for (const t of CLINICAL_TYPES)
        assert.ok(SECTION_TYPES[t].voiceRule.includes(storageKey(t)), t);
});
