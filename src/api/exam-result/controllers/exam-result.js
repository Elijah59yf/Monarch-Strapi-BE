'use strict';

/**
 * exam-result controller
 *
 * PERMISSIONS REMINDER:
 * ─────────────────────
 * After starting Strapi, go to:
 *   Admin Panel → Settings → Users & Permissions → Roles → Public
 *
 * Under "ExamResult", enable:
 *   ✅ find
 *   ✅ findOne  (optional, if you want single-entry lookup)
 *
 * WITHOUT this step, all public API requests to
 *   GET /api/exam-results
 * will return 403 Forbidden.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::exam-result.exam-result');
