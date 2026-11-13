const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildSkeleton, buildExtractionPrompt } = require("../../templates/prompt");
const generic = require("../../templates/builtin/generic.json");

const ROOT = path.join(__dirname, "../..");
const templateJson = JSON.parse(fs.readFileSync(path.join(ROOT, "template.json"), "utf8"));
const promptMd = fs.readFileSync(path.join(ROOT, "prompt.md"), "utf8");

test("generic skeleton equals template.json", () => {
    assert.deepEqual(buildSkeleton(generic), templateJson);
});

test("generic prompt keeps today's text", () => {
    const out = buildExtractionPrompt(generic, "T");
    const [before, after] = promptMd.split("{{template}}");
    const tail = after.replace("{{transcript}}", "T");
    assert.ok(out.startsWith(before), "text before the template is unchanged");
    assert.ok(out.endsWith(tail), "text after the template is unchanged");
    const middle = out.slice(before.length, out.length - tail.length);
    assert.deepEqual(JSON.parse(middle), templateJson);
    assert.ok(!out.includes("# Sections"));
});

test("custom titles add a Sections block", () => {
    const def = {
        name: "X",
        sections: [
            { id: "dx", type: "diagnosis", title: "Impression", instructions: "Most likely first" },
        ],
    };
    const out = buildExtractionPrompt(def, "T");
    assert.ok(out.includes('- prescription.diagnosis ("Impression"): Most likely first'));
    assert.ok(out.indexOf("# Sections") < out.indexOf("# Template"));
    assert.deepEqual(Object.keys(buildSkeleton(def)).sort(), ["consultation_summary", "prescription"]);
    assert.deepEqual(Object.keys(buildSkeleton(def).prescription), ["diagnosis"]);
});

test("generic prompt is byte-for-byte today's prompt", () => {
    const today = promptMd
        .replace("{{template}}", () => fs.readFileSync(path.join(ROOT, "template.json"), "utf8"))
        .replace("{{transcript}}", () => "T");
    assert.equal(buildExtractionPrompt(generic, "T"), today);
});

test("a partial template keeps template.json's key order", () => {
    const def = {
        name: "X",
        sections: [
            { id: "f", type: "followup" },
            { id: "v", type: "vitals" },
            { id: "a", type: "allergies" },
            { id: "s", type: "complaints" },
        ],
    };
    const sk = buildSkeleton(def);
    assert.deepEqual(Object.keys(sk), ["allergies", "vitals", "prescription", "consultation_summary"]);
    assert.deepEqual(Object.keys(sk.prescription), ["symptoms", "followup"]);
});
