const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { voiceSpecFor } = require("../../templates/voice");
const generic = require("../../templates/builtin/generic.json");

const fx = (f) => fs.readFileSync(path.join(__dirname, "../fixtures", f), "utf8");

test("voiceSpecFor(undefined) equals generic", () => {
    assert.deepEqual(voiceSpecFor(undefined), voiceSpecFor(generic));
    assert.equal(voiceSpecFor(undefined).label, "Consultation record");
});

test("generic rules contain every line of today's rules", () => {
    const rules = voiceSpecFor(generic).rules;
    for (const line of fx("voice-rules-2026-11-13.txt").split("\n").filter((l) => l.trim()))
        assert.ok(rules.includes(line), line.slice(0, 60));
});

test("generic skeleton equals today's voice skeleton", () => {
    assert.deepEqual(
        JSON.parse(voiceSpecFor(generic).skeleton),
        JSON.parse(fx("voice-skeleton-2026-11-13.json")),
    );
});

test("a diagnosis-only template has one placement rule", () => {
    const spec = voiceSpecFor({ name: "X", sections: [{ id: "dx", type: "diagnosis" }] });
    assert.ok(spec.rules.includes("prescription.diagnosis"));
    assert.ok(!spec.rules.includes("prescription.medications"));
    assert.deepEqual(Object.keys(JSON.parse(spec.skeleton)).sort(), ["edits", "prescription"]);
});

test("limitRowsToTemplate empties sections the template lacks", () => {
    const { limitRowsToTemplate } = require("../../templates/voice");
    const rows = {
        allergies: [{ name: "Dust" }],
        vitals: [{ name: "Body Weight", value: "70" }],
        prescription: { diagnosis: [{ name: "URTI" }], medications: [{ name: "X" }], symptoms: [], followup: [] },
    };
    const out = limitRowsToTemplate({ name: "X", sections: [{ id: "dx", type: "diagnosis" }] }, rows);
    assert.deepEqual(out.allergies, []);
    assert.deepEqual(out.vitals, []);
    assert.deepEqual(out.prescription.medications, []);
    assert.deepEqual(out.prescription.diagnosis, [{ name: "URTI" }]);
});

test("generic voice rules and skeleton are byte-for-byte today's", () => {
    const spec = voiceSpecFor(generic);
    assert.equal(spec.rules, fx("voice-rules-2026-11-13.txt"));
    assert.equal(spec.skeleton, fx("voice-skeleton-2026-11-13.json"));
});

test("a partial template keeps today's rule order", () => {
    const spec = voiceSpecFor({
        name: "X",
        sections: [
            { id: "v", type: "vitals" },
            { id: "d", type: "diagnosis" },
            { id: "c", type: "complaints" },
        ],
    });
    const lines = spec.rules.split("\n");
    const at = (k) => lines.findIndex((l) => l.includes(k));
    assert.ok(at("prescription.symptoms") < at("prescription.diagnosis"));
    assert.ok(at("prescription.diagnosis") < at("vitals."));
});
