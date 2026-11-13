// Clinical section types: what each one is called, where it lives in a saved record,
// its empty shape for the extraction prompt (read from template.json so it cannot drift),
// and its line in the voice-edit instructions (copied from the voice prompt in server.js).
const fs = require("fs");
const path = require("path");

const TEMPLATE_JSON = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "template.json"), "utf8"),
);
const at = (obj, keys) => keys.reduce((o, k) => (o == null ? o : o[k]), obj);

const DEFS = [
    {
        type: "diagnosis",
        storage: ["prescription", "diagnosis"],
        defaultTitle: "Diagnosis",
        voiceRule:
            "Diagnosis the doctor states today: prescription.diagnosis, \"name\".",
        voiceSkeleton: [{"name": ""}],
    },
    {
        type: "complaints",
        storage: ["prescription", "symptoms"],
        defaultTitle: "Presenting symptoms",
        voiceRule:
            "Today's complaint, what brings the patient in now with how long: prescription.symptoms. \"name\", \"duration\", \"notes\".",
        voiceSkeleton: [{"name": "", "duration": "", "notes": ""}],
    },
    {
        type: "prescription",
        storage: ["prescription", "medications"],
        defaultTitle: "Prescribed today",
        voiceRule:
            "Medicines the doctor prescribes today: prescription.medications. \"name\" is the generic name with strength if said, for example \"Paracetamol 500 mg\". If the doctor says a brand name, put it in \"brand\" exactly as said without \"Tab\" or \"Cap\", and the generic in \"name\" only if you are certain of it. If you are not certain of the generic, put the brand as said in \"name\" and leave \"brand\" empty. If only a generic is said, leave \"brand\" empty. Never make up a brand. \"duration\" (for example \"5 days\"), \"dosage\" (a list of short strings, for example [\"1-0-1\"] or [\"twice daily\"]), \"instructions\" (for example \"after food\").",
        voiceSkeleton: [{"name": "", "brand": "", "duration": "", "dosage": [], "instructions": ""}],
    },
    {
        type: "followup",
        storage: ["prescription", "followup"],
        defaultTitle: "Follow-up",
        voiceRule:
            "Follow-up: prescription.followup. \"next_visit_duration\" is how long until the next visit, for example \"3 days\". \"date\" only when a specific calendar date is said, written like \"25 Oct 2026\". Today is {{today}}. \"advice\" holds advice for the patient, including tests the doctor tells the patient to get.",
        voiceSkeleton: [{"next_visit_duration": "", "date": "", "advice": ""}],
    },
    {
        type: "vitals",
        storage: ["vitals"],
        defaultTitle: "Vitals",
        voiceRule:
            "Vital signs: vitals. Use exactly these names and units, converting if needed: \"Systolic Blood Pressure\" (mmHg), \"Diastolic Blood Pressure\" (mmHg), \"Body Temperature\" (°F), \"Respiration\" (per minute), \"Body Weight\" (kgs), \"Body Height\" (ft, decimal feet, for example 5 ft 6 in is 5.5). \"value\" is the number only. Blood pressure 120 over 80 gives two entries.",
        voiceSkeleton: [{"name": "", "value": ""}],
    },
    {
        type: "allergies",
        storage: ["allergies"],
        defaultTitle: "Allergies",
        voiceRule:
            "Allergies: allergies. \"name\", \"notes\" (for example the reaction).",
        voiceSkeleton: [{"name": "", "notes": ""}],
    },
    {
        type: "conditions",
        storage: ["conditions"],
        defaultTitle: "Conditions",
        voiceRule:
            "Long-term or past illnesses: conditions. \"name\", \"duration\", \"notes\".",
        voiceSkeleton: [{"name": "", "duration": "", "notes": ""}],
    },
    {
        type: "medication_history",
        storage: ["medication_history"],
        defaultTitle: "Medication History",
        voiceRule:
            "Medicines the patient already takes or took before today: medication_history. \"name\" is the generic name with strength if said. If a brand name is said, put it in \"brand\" exactly as said without \"Tab\" or \"Cap\", and the generic in \"name\" only if you are certain of it. If you are not certain of the generic, put the brand as said in \"name\" and leave \"brand\" empty. Never make up a brand. \"dosage\" (short text), \"duration\", \"status\" (for example \"Ongoing\" or \"Stopped\"), \"instruction\" (a list).",
        voiceSkeleton: [{"name": "", "brand": "", "dosage": "", "duration": "", "status": "", "instruction": []}],
    },
    {
        type: "investigations",
        storage: ["investigation_history"],
        defaultTitle: "Investigations",
        voiceRule:
            "Lab or scan results with values: investigation_history. \"name\" is the report, for example \"Lipid profile\". \"date\". \"readings\" is a list of objects with \"investigation_name\", \"result\", \"unit\", \"interpretation\", \"notes\".",
        voiceSkeleton: [{"name": "", "date": "", "readings": [{"investigation_name": "", "result": "", "unit": "", "interpretation": "", "notes": ""}]}],
    },
    {
        type: "procedures",
        storage: ["procedures"],
        defaultTitle: "Procedures",
        voiceRule:
            "Past operations or procedures: procedures. \"name\", \"date\", \"notes\".",
        voiceSkeleton: [{"name": "", "date": "", "notes": ""}],
    },
    {
        type: "examination",
        storage: ["system_review"],
        defaultTitle: "Review of Systems",
        voiceRule:
            "Examination findings by body system: system_review. \"name\" is the body system, for example \"Cardiovascular\". \"findings\" is a list of short findings. \"notes\".",
        voiceSkeleton: [{"name": "", "findings": [], "notes": ""}],
    },
    {
        type: "family_history",
        storage: ["family_history"],
        defaultTitle: "Family History",
        voiceRule:
            "Illnesses in relatives: family_history. \"relationship\" (for example \"Father\"), \"illness\" (a list), \"notes\".",
        voiceSkeleton: [{"relationship": "", "illness": [], "notes": ""}],
    },
    {
        type: "lifestyle",
        storage: ["lifestyle_habits"],
        defaultTitle: "Lifestyle Habits",
        voiceRule:
            "Habits such as smoking, alcohol, exercise, sleep, diet: lifestyle_habits. \"name\", \"frequency\", \"duration\", \"notes\".",
        voiceSkeleton: [{"name": "", "frequency": "", "duration": "", "notes": ""}],
    },
    {
        type: "social_history",
        storage: ["social_history"],
        defaultTitle: "Social History",
        voiceRule:
            "Occupation, living situation, marital status, support at home: social_history. \"name\", \"notes\".",
        voiceSkeleton: [{"name": "", "notes": ""}],
    },
    {
        type: "other_history",
        storage: ["other_history"],
        defaultTitle: "Other Notes",
        voiceRule:
            "Anything else about the history that fits nowhere above, such as travel: other_history. \"name\", \"notes\".",
        voiceSkeleton: [{"name": "", "notes": ""}],
    },
];

const SECTION_TYPES = Object.fromEntries(
    DEFS.map((d) => [d.type, { ...d, skeleton: at(TEMPLATE_JSON, d.storage) }]),
);
const CLINICAL_TYPES = DEFS.map((d) => d.type);
const storageKey = (type) => SECTION_TYPES[type].storage.join(".");

module.exports = { SECTION_TYPES, CLINICAL_TYPES, storageKey };
