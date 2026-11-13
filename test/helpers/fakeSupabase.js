// A tiny in-memory stand-in for the parts of the Supabase client the templates code uses:
// from(table).select().eq().in().is().order().maybeSingle(), insert(), update().eq()
function fakeSupabase(tables = {}) {
    const db = Object.fromEntries(
        Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
    );
    const from = (table) => {
        db[table] = db[table] || [];
        let filters = [];
        let order = null;
        let mode = "select";
        let payload = null;
        const rows = () =>
            db[table].filter((r) => filters.every((f) => f(r)));
        const q = {
            select() {
                return q;
            },
            eq(col, val) {
                filters.push((r) => r[col] === val);
                return q;
            },
            in(col, vals) {
                filters.push((r) => vals.includes(r[col]));
                return q;
            },
            is(col, val) {
                filters.push((r) => (r[col] ?? null) === val);
                return q;
            },
            or(expr) {
                // supports "owner_id.is.null,owner_id.eq.<id>"
                const parts = expr.split(",").map((p) => p.split("."));
                filters.push((r) =>
                    parts.some(([c, op, v]) =>
                        op === "is" ? (r[c] ?? null) === null : r[c] === v,
                    ),
                );
                return q;
            },
            order(col, opts = {}) {
                order = { col, asc: opts.ascending !== false };
                return q;
            },
            insert(row) {
                mode = "insert";
                payload = row;
                return q;
            },
            update(patch) {
                mode = "update";
                payload = patch;
                return q;
            },
            async maybeSingle() {
                const r = rows();
                return { data: r[0] ? { ...r[0] } : null, error: null };
            },
            async single() {
                return q.maybeSingle();
            },
            then(resolve, reject) {
                try {
                    if (mode === "insert") {
                        const list = Array.isArray(payload) ? payload : [payload];
                        list.forEach((r) => db[table].push({ ...r }));
                        return resolve({ data: null, error: null });
                    }
                    if (mode === "update") {
                        rows().forEach((r) => Object.assign(r, payload));
                        return resolve({ data: null, error: null });
                    }
                    let r = rows().map((x) => ({ ...x }));
                    if (order)
                        r.sort((a, b) =>
                            (a[order.col] > b[order.col] ? 1 : -1) * (order.asc ? 1 : -1),
                        );
                    return resolve({ data: r, error: null });
                } catch (e) {
                    return reject(e);
                }
            },
        };
        return q;
    };
    return { from, db };
}

module.exports = { fakeSupabase };
