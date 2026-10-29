const crypto = require("crypto");
const fs = require("fs");
const { getAuth } = require("@clerk/express");
const { NOTICE } = require("./notice");

const NOTICE_HASH = crypto
    .createHash("sha256")
    .update(JSON.stringify(NOTICE))
    .digest("hex");

const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

function roleOf(req) {
    return req.role === "staff" ? "staff" : "doctor";
}

function ageOf(p) {
    if (p?.dob) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(p.dob));
        if (m) {
            const now = new Date();
            let a = now.getFullYear() - +m[1];
            if (
                now.getMonth() + 1 < +m[2] ||
                (now.getMonth() + 1 === +m[2] && now.getDate() < +m[3])
            )
                a--;
            return a >= 0 ? a : 0;
        }
    }
    return p?.age ?? null;
}

function renderNotice(ctx) {
    const esc = (v) => JSON.stringify(v).slice(1, -1);
    const json = JSON.stringify(NOTICE)
        .replace(/{{clinic}}/g, esc(ctx.clinic))
        .replace(/{{doctor}}/g, esc(ctx.doctor));
    return JSON.parse(json);
}

// "none" | "valid" | "outdated" | "declined" | "withdrawn"
function stateOf(row) {
    if (!row) return "none";
    if (row.status === "declined") return "declined";
    if (row.status === "withdrawn") return "withdrawn";
    return row.notice_hash === NOTICE_HASH ? "valid" : "outdated";
}

async function latestRows(supabase, ownerId, patientIds) {
    const out = {};
    if (!patientIds.length) return out;
    const { data, error } = await supabase
        .from("patient_consents")
        .select(
            "patient_id, status, notice_version, notice_hash, signer_type, signer_name, captured_by_role, created_at",
        )
        .eq("owner_id", ownerId)
        .in("patient_id", patientIds)
        .order("created_at", { ascending: false });
    if (error) throw error;
    for (const r of data) if (!out[r.patient_id]) out[r.patient_id] = r;
    return out;
}

async function consentStates(supabase, ownerId, patientIds) {
    const rows = await latestRows(supabase, ownerId, patientIds);
    const out = {};
    for (const id of patientIds) out[id] = stateOf(rows[id]);
    return out;
}

function cleanupFiles(req) {
    const all = [];
    if (Array.isArray(req.files)) all.push(...req.files);
    else if (req.files) Object.values(req.files).forEach((a) => all.push(...a));
    all.forEach((f) => f?.path && fs.unlink(f.path, () => {}));
}

function deny(req, res, state, msg) {
    cleanupFiles(req);
    return res.status(403).json({
        error: msg || "Patient consent is required before this action.",
        code: "CONSENT_REQUIRED",
        consent_status: state,
    });
}

// Gate by patient id (body.patient_id or params.patientId). Fails closed.
// On multipart routes put it AFTER multer so req.body is parsed.
function requireConsent(supabase) {
    return async (req, res, next) => {
        try {
            const pid = String(
                req.body?.patient_id || req.params?.patientId || "",
            ).trim();
            if (!pid)
                return deny(
                    req,
                    res,
                    "none",
                    "Save the patient and record their consent first.",
                );
            const { data: p, error } = await supabase
                .from("patients")
                .select("id")
                .eq("id", pid)
                .eq("owner_id", req.userId)
                .maybeSingle();
            if (error) throw error;
            if (!p) return res.status(404).json({ error: "Patient not found" });
            const state = (await consentStates(supabase, req.userId, [pid]))[
                pid
            ];
            if (state !== "valid") return deny(req, res, state);
            next();
        } catch (err) {
            console.log("⚠️ Consent gate error:", err.message);
            return deny(
                req,
                res,
                "none",
                "Couldn't verify consent. Try again.",
            );
        }
    };
}

// Gate for routes addressed by consultation id (/consultations/:id/...)
function requireConsentForConsultation(supabase) {
    return async (req, res, next) => {
        try {
            const { data: c, error } = await supabase
                .from("consultations")
                .select("patient_id")
                .eq("id", req.params.id)
                .eq("owner_id", req.userId)
                .maybeSingle();
            if (error) throw error;
            if (!c) return res.status(404).json({ error: "Not found" });
            const state = (
                await consentStates(supabase, req.userId, [c.patient_id])
            )[c.patient_id];
            if (state !== "valid") return deny(req, res, state);
            next();
        } catch (err) {
            console.log("⚠️ Consent gate error:", err.message);
            return deny(
                req,
                res,
                "none",
                "Couldn't verify consent. Try again.",
            );
        }
    };
}

function registerConsentRoutes(app, supabase) {
    async function ownedPatient(req, id) {
        const { data, error } = await supabase
            .from("patients")
            .select("id, name, dob, age")
            .eq("id", id)
            .eq("owner_id", req.userId)
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    async function doctorCtx(req) {
        const { data: d } = await supabase
            .from("doctors")
            .select("name, clinic_name")
            .eq("owner_id", req.userId)
            .maybeSingle();
        return {
            clinic: d?.clinic_name || "[Clinic name]",
            doctor: d?.name
                ? `Dr. ${d.name.replace(/^dr\.?\s*/i, "")}`
                : "Your doctor",
        };
    }

    app.get("/consent/notice", async (req, res) => {
        try {
            const notice = renderNotice(await doctorCtx(req));
            res.json({ hash: NOTICE_HASH, version: NOTICE.version, notice });
        } catch (err) {
            console.log("⚠️ Notice fetch failed:", err.message);
            res.status(500).json({
                error: "Failed to load the consent notice",
            });
        }
    });

    app.get("/patients/:id/consent", async (req, res) => {
        try {
            if (!(await ownedPatient(req, req.params.id)))
                return res.status(404).json({ error: "Not found" });
            const row = (
                await latestRows(supabase, req.userId, [req.params.id])
            )[req.params.id];
            res.json({
                status: stateOf(row),
                latest: row
                    ? {
                          decision: row.status,
                          notice_version: row.notice_version,
                          signer_name: row.signer_name,
                          signer_type: row.signer_type,
                          captured_by_role: row.captured_by_role,
                          at: row.created_at,
                      }
                    : null,
            });
        } catch (err) {
            console.log("⚠️ Consent fetch failed:", err.message);
            res.status(500).json({ error: "Failed to load consent" });
        }
    });

    async function insertRow(req, res, patient, fields) {
        const { error } = await supabase.from("patient_consents").insert({
            patient_id: patient.id,
            owner_id: req.userId,
            notice_version: NOTICE.version,
            notice_hash: NOTICE_HASH,
            notice_snapshot: renderNotice(await doctorCtx(req)),
            captured_by: req.actorId || req.userId,
            captured_by_role: roleOf(req),
            user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
            ...fields,
        });
        if (error) throw error;
        const st = (await consentStates(supabase, req.userId, [patient.id]))[
            patient.id
        ];
        res.json({ status: st });
    }

    app.post("/patients/:id/consent", async (req, res) => {
        try {
            const patient = await ownedPatient(req, req.params.id);
            if (!patient) return res.status(404).json({ error: "Not found" });
            const b = req.body || {};

            if (b.notice_hash !== NOTICE_HASH)
                return res.status(409).json({
                    error: "The consent notice was updated. Please read the new version.",
                    code: "NOTICE_CHANGED",
                });

            if (b.decision === "declined")
                return await insertRow(req, res, patient, {
                    status: "declined",
                });
            if (b.decision !== "granted")
                return res.status(400).json({ error: "Invalid decision" });

            const clean = (v, n = 200) =>
                (typeof v === "string" ? v.trim().slice(0, n) : "") || null;
            const type = ["self", "guardian", "representative"].includes(
                b.signer_type,
            )
                ? b.signer_type
                : null;
            const signerName = clean(b.signer_name, 120);
            const rel = clean(b.signer_relationship, 60);
            const reason = clean(b.on_behalf_reason, 300);
            const sig = b.signature_data;

            if (!type || !signerName)
                return res
                    .status(400)
                    .json({ error: "Signer name is required" });
            if (type !== "self" && !rel)
                return res
                    .status(400)
                    .json({ error: "Relationship is required" });
            if (type === "representative" && !reason)
                return res.status(400).json({ error: "Please give a reason" });
            if (
                ageOf(patient) != null &&
                ageOf(patient) < 18 &&
                type === "self"
            )
                return res.status(400).json({
                    error: "A parent or guardian must sign for a patient under 18",
                });
            if (
                typeof sig !== "string" ||
                sig.length > 400000 ||
                !SIG_RE.test(sig)
            )
                return res
                    .status(400)
                    .json({ error: "A valid signature is required" });

            await insertRow(req, res, patient, {
                status: "granted",
                signer_type: type,
                signer_name: signerName,
                signer_relationship: type === "self" ? null : rel,
                on_behalf_reason: type === "representative" ? reason : null,
                signature_data: sig,
            });
        } catch (err) {
            console.log("⚠️ Consent save failed:", err.message);
            if (!res.headersSent)
                res.status(500).json({ error: "Couldn't save consent" });
        }
    });

    app.post("/patients/:id/consent/withdraw", async (req, res) => {
        try {
            const patient = await ownedPatient(req, req.params.id);
            if (!patient) return res.status(404).json({ error: "Not found" });
            await insertRow(req, res, patient, { status: "withdrawn" });
        } catch (err) {
            console.log("⚠️ Consent withdraw failed:", err.message);
            if (!res.headersSent)
                res.status(500).json({ error: "Couldn't withdraw consent" });
        }
    });
}

module.exports = {
    registerConsentRoutes,
    requireConsent,
    requireConsentForConsultation,
    consentStates,
};
