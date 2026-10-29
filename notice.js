const NOTICE = {
    version: "1.0",
    title: "Your consent for digital notes at {{clinic}}",
    intro: "{{doctor}} uses OneMD Scribe to write your visit notes. Please read this and choose Agree or Decline.",
    sections: [
        {
            heading: "What we record",
            items: [
                "Your voice during the consultation",
                "Your name, age, gender and phone number",
                "Your health details: symptoms, diagnosis, medicines, tests and advice",
            ],
        },
        {
            heading: "Why",
            text: "Only to turn your consultation into a written medical record for your doctor, and to show it to your doctor at future visits. We do not use it for advertising, we do not sell it, and we do not use it to train AI.",
        },
        {
            heading: "How it is kept safe",
            items: [
                "Your data is encrypted and kept on secure servers in India.",
                "Only your doctor and authorised clinic staff can see it.",
                "Our technology partners process it only to create your notes, under a written contract.",
                "Voice recordings are deleted right after the notes are made.",
                "Your notes are kept for 3 years, as medical records rules require, and are then deleted.",
            ],
        },
        {
            heading: "Your choices",
            items: [
                "Declining does not affect your treatment. The doctor will write notes by hand.",
                "You can withdraw consent any time, as easily as you gave it, by telling the clinic. We will stop using your data. We may have to keep notes already made if the law requires it.",
                "You can ask to see, correct or delete your data, and you can name someone to act for you.",
                // "Questions or complaints: [Name, email, phone]. If we don't resolve it, you can complain to the Data Protection Board of India.",
            ],
        },
    ],
    agreeText:
        "I have read this notice and I agree to my voice and health details being recorded and processed as described.",
    minorText:
        "If the patient is under 18, a parent or legal guardian must read this and sign.",
};

module.exports = { NOTICE };
