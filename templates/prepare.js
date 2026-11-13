// Everything the upload route needs before calling the model: the chosen template
// (with safe fallbacks) and the prompt built from it.
const { resolveTemplate } = require("./store");
const { buildExtractionPrompt } = require("./prompt");

async function prepareExtraction({ supabase, ownerId, templateId, transcript, regContext }) {
    const t = await resolveTemplate(supabase, ownerId, templateId);
    let prompt = buildExtractionPrompt(t.definition, transcript);
    if (regContext) {
        prompt += `\n\n# Patient registration record (context only)\nThis is background from registration. Use it to understand the visit. Do NOT copy any of it into the output unless the transcript itself mentions it.\n${regContext}\n`;
    }
    return {
        prompt,
        template: { id: t.id, version: t.version, name: t.name },
        definition: t.definition,
    };
}

module.exports = { prepareExtraction };
