const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareExtraction } = require("../../templates/prepare");
const { buildExtractionPrompt } = require("../../templates/prompt");
const { GENERIC_ID } = require("../../templates/store");
const { fakeSupabase } = require("../helpers/fakeSupabase");

const CONTEXT_HEAD =
    "\n\n# Patient registration record (context only)\nThis is background from registration. Use it to understand the visit. Do NOT copy any of it into the output unless the transcript itself mentions it.\n";

test("generic: today's prompt plus the registration context", async () => {
    const r = await prepareExtraction({
        supabase: fakeSupabase({}),
        ownerId: "doc1",
        transcript: "T",
        regContext: "Age: 40",
    });
    assert.equal(r.template.id, GENERIC_ID);
    assert.deepEqual(Object.keys(r.template).sort(), ["id", "name", "version"]);
    assert.equal(r.prompt, buildExtractionPrompt(r.definition, "T") + CONTEXT_HEAD + "Age: 40\n");
});

test("no registration context adds nothing", async () => {
    const r = await prepareExtraction({ supabase: fakeSupabase({}), ownerId: "doc1", transcript: "T", regContext: "" });
    assert.equal(r.prompt, buildExtractionPrompt(r.definition, "T"));
});

test("unknown template id falls back to generic", async () => {
    const r = await prepareExtraction({
        supabase: fakeSupabase({}),
        ownerId: "doc1",
        templateId: "not-a-uuid",
        transcript: "T",
    });
    assert.equal(r.template.id, GENERIC_ID);
});
