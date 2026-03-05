'use strict';

const { syncStudentToMoodle } = require('../src/api/exam-credential/services/moodle-sync');

/**
 * Cron tasks — retry queue for failed Moodle syncs.
 *
 * Runs every 2 minutes. Finds all exam-credential records with
 * IsSynced === false, fetches their linked courses, and retries
 * the Moodle sync (user creation + enrolment + batch grouping).
 *
 * On success, syncStudentToMoodle marks IsSynced = true automatically.
 */
module.exports = {
  // ┌────────── minute (every 2nd)
  // │ ┌──────── hour
  // │ │ ┌────── day of month
  // │ │ │ ┌──── month
  // │ │ │ │ ┌── day of week
  // │ │ │ │ │
  '*/2 * * * *': {
    task: async ({ strapi }) => {
      // Skip if Moodle env vars aren't configured
      if (!process.env.MOODLE_URL || !process.env.MOODLE_TOKEN) return;

      try {
        // Find all unsynced students
        const unsynced = await strapi.documents('api::exam-credential.exam-credential').findMany({
          filters: { IsSynced: false },
          populate: { courses: true },
          limit: -1,
        });

        if (unsynced.length === 0) return;

        strapi.log.info(`Moodle retry cron: found ${unsynced.length} unsynced record(s). Processing...`);

        for (const student of unsynced) {
          const coursesArray = student.courses || [];
          const assignedBatches = student.CourseBatches || {};

          if (coursesArray.length === 0) {
            strapi.log.warn(`Moodle retry cron: skipping "${student.MatricNo}" — no courses linked.`);
            continue;
          }

          const studentData = {
            documentId: student.documentId,
            MatricNo: student.MatricNo,
            MoodlePassword: student.MoodlePassword,
            Firstname: student.Firstname,
            Surname: student.Surname,
            Email: student.Email,
          };

          const result = await syncStudentToMoodle(studentData, coursesArray, assignedBatches);

          if (result.success) {
            strapi.log.info(`Moodle retry cron: synced "${student.MatricNo}" successfully.`);
          } else {
            strapi.log.warn(`Moodle retry cron: "${student.MatricNo}" still failing — ${result.error}. Will retry next cycle.`);
          }
        }
      } catch (err) {
        strapi.log.error('Moodle retry cron error:', err);
      }
    },
    options: {
      tz: 'Africa/Lagos',
    },
  },
};
