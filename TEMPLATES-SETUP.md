# Templates – backend setup

Copy these files over the root of your backend repo (they include Plan 1).

1. Supabase SQL editor: run `sql/2026-11-13-templates.sql` (safe to re-run).
2. Load the built-in templates (General OPD + 10 endocrine): `node templates/seed.js`
   Re-run it whenever a file in templates/builtin/ changes; it only adds new versions.
3. `npm test` should pass. Deploy.

New routes: GET/POST/PUT/DELETE /templates, GET /templates/:id, POST /templates/:id/copy,
POST /templates/ai (create with Gemma), POST /consultations/:id/template-preview (try on a visit),
POST /consultations/:id/retemplate (change template), PUT /consultations/:id/custom/:sectionId.
Deleting a template hides it (archived); notes made with it keep their layout.
