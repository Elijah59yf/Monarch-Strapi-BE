'use strict';

/**
 * student-profile controller
 *
 * PERMISSIONS REMINDER:
 * ─────────────────────
 * After starting Strapi, go to:
 *   Admin Panel → Settings → Users & Permissions → Roles → Public
 *
 * Under "StudentProfile", enable:
 *   ✅ find
 *
 * WITHOUT this step, all public API requests to
 *   GET /api/student-profiles
 * will return 403 Forbidden.
 *
 * NOTE: The custom find() below strips MasterPIN from all responses
 * so it is never leaked to the client, while still allowing it
 * to be used as a query filter.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::student-profile.student-profile', ({ strapi }) => ({
  async find(ctx) {
    // Call the default find logic
    const { data, meta } = await super.find(ctx);

    // Strip MasterPIN from every entry in the response
    const sanitized = data.map(entry => {
      if (entry.attributes) {
        const { MasterPIN, ...rest } = entry.attributes;
        return { ...entry, attributes: rest };
      }
      // Strapi v5 flat format
      const { MasterPIN, ...rest } = entry;
      return rest;
    });

    return { data: sanitized, meta };
  },
}));
