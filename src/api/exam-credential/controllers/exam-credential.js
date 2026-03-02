'use strict';
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::exam-credential.exam-credential', ({ strapi }) => ({
  async fetchPassword(ctx) {
    const { matricNo, surname } = ctx.request.body;
    if (!matricNo || !surname) return ctx.badRequest('Matric Number and Surname are required.');

    try {
      const entry = await strapi.db.query('api::exam-credential.exam-credential').findOne({
        where: { MatricNo: matricNo.toLowerCase().trim() },
      });

      if (!entry) return ctx.notFound('Student not found.');
      if (entry.Surname.toLowerCase().trim() !== surname.toLowerCase().trim()) return ctx.unauthorized('Invalid surname.');
      
      return ctx.send({ password: entry.MoodlePassword });
    } catch (err) {
      return ctx.internalServerError('Server error.');
    }
  }
}));