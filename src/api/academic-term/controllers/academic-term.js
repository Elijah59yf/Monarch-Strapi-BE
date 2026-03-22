'use strict';

/**
 * academic-term controller
 *
 * PERMISSIONS REMINDER:
 * ─────────────────────
 * After starting Strapi, go to:
 *   Admin Panel → Settings → Users & Permissions → Roles → Public
 *
 * Under "AcademicTerm", enable:
 *   ✅ find
 *
 * WITHOUT this step, GET /api/academic-term will return 403 Forbidden.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::academic-term.academic-term');
