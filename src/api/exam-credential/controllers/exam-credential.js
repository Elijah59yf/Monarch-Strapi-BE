'use strict';
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::exam-credential.exam-credential', ({ strapi }) => ({
  
  async fetchPassword(ctx) {
    const { matricNo, surname } = ctx.request.body;

    if (!matricNo || !surname) {
      return ctx.badRequest('Matric Number and Surname are required.');
    }

    try {
      // 1. Fetch the master switch (Single Type)
      const settings = await strapi.entityService.findMany('api::exam-setting.exam-setting');
      
      // We use ?? instead of || so that 0 is accepted as a valid number
      const activeBatch = settings?.CurrentActiveBatch ?? 1;

      // NEW: The "Batch 0" Lockdown Check
      if (activeBatch === 0) {
        return ctx.forbidden('The exam portal is currently closed. Please wait for your batch to be called.');
      }

      // 2. Find the student
      const entry = await strapi.db.query('api::exam-credential.exam-credential').findOne({
        where: { MatricNo: matricNo.toLowerCase().trim() },
      });

      if (!entry) {
        return ctx.notFound('Student not found.');
      }

      // 3. Verify surname
      if (entry.Surname.toLowerCase().trim() !== surname.toLowerCase().trim()) {
        return ctx.unauthorized('Invalid surname provided.');
      }

      // 4. Bouncer Logic: Check if it's their batch's turn
      if (entry.BatchNumber !== activeBatch) {
        return ctx.forbidden(`Access Denied. It is currently time for Batch ${activeBatch}. You are assigned to Batch ${entry.BatchNumber}.`);
      }

      // 5. Success
      return ctx.send({ password: entry.MoodlePassword });

    } catch (err) {
      console.error(err);
      return ctx.internalServerError('Server error.');
    }
  }
}));