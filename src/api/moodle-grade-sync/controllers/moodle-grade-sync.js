'use strict';

/**
 * moodle-grade-sync controller (production-ready)
 *
 * POST /api/moodle-sync/fetch-grades
 * Header: x-admin-secret (must match process.env.ADMIN_WIPE_SECRET)
 *
 * Body: { "cmid": 21, "courseId": 3, "courseCode": "GST 105" }
 *
 * Pipeline:
 *  0. Auth check (x-admin-secret)
 *  1. Resolve cmid → quizid via mod_quiz_get_quizzes_by_courses
 *  2. Fetch enrolled roster, filter to students only
 *  3. Concurrent batched grade fetch via gradereport_user_get_grade_items
 *  4. Duplicate-checked injection into Strapi ExamResult (IsPublished: false)
 */

const CONCURRENCY = 5; // max parallel Moodle API calls

module.exports = {
  async fetchGrades(ctx) {
    // ─────────────────────────────────────────────
    // AUTH: x-admin-secret header check
    // ─────────────────────────────────────────────
    const secret = ctx.request.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_WIPE_SECRET) {
      return ctx.unauthorized('Invalid or missing admin secret.');
    }

    const { cmid, courseId, courseCode } = ctx.request.body;

    // ── Validate input ──
    if (!cmid || !courseId || !courseCode) {
      return ctx.badRequest(
        'Missing required fields: cmid (Moodle course module ID), courseId (Moodle course ID), and courseCode are required.'
      );
    }

    const MOODLE_URL = process.env.MOODLE_URL;
    const MOODLE_TOKEN = process.env.MOODLE_TOKEN;

    if (!MOODLE_URL || !MOODLE_TOKEN) {
      return ctx.internalServerError('MOODLE_URL or MOODLE_TOKEN is not configured in .env');
    }

    // ─────────────────────────────────────────────
    // Helper: call any Moodle REST function
    // ─────────────────────────────────────────────
    async function moodleCall(wsfunction, params = {}) {
      const body = new URLSearchParams({
        wstoken: MOODLE_TOKEN,
        wsfunction,
        moodlewsrestformat: 'json',
        ...params,
      });

      const res = await fetch(`${MOODLE_URL}/webservice/rest/server.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await res.json();

      if (data && data.exception) {
        const err = new Error(`Moodle [${wsfunction}]: ${data.message}`);
        err.errorcode = data.errorcode;
        throw err;
      }

      return data;
    }

    // ─────────────────────────────────────────────
    // Helper: process chunks with controlled concurrency
    // ─────────────────────────────────────────────
    async function processInBatches(items, batchSize, fn) {
      const results = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(fn));
        results.push(...batchResults);
      }
      return results;
    }

    try {
      // ─────────────────────────────────────────────
      // STEP 1: Resolve cmid → quizid
      // ─────────────────────────────────────────────
      strapi.log.info(
        `[grade-sync] Resolving cmid ${cmid} for Moodle course ${courseId} ("${courseCode}")`
      );

      const quizzesData = await moodleCall('mod_quiz_get_quizzes_by_courses', {
        'courseids[0]': courseId,
      });

      const quizzes = quizzesData.quizzes || [];
      const matchedQuiz = quizzes.find((q) => q.coursemodule === cmid);

      if (!matchedQuiz) {
        return ctx.badRequest(
          `Quiz module not found in this course. cmid ${cmid} does not match any quiz in Moodle course ${courseId}.`
        );
      }

      const quizId = matchedQuiz.id;
      strapi.log.info(
        `[grade-sync] Resolved cmid ${cmid} → quizid ${quizId} ("${matchedQuiz.name}")`
      );

      // ─────────────────────────────────────────────
      // STEP 2: Fetch enrolled roster + filter
      // ─────────────────────────────────────────────
      const rawRoster = await moodleCall('core_enrol_get_enrolled_users', {
        courseid: courseId,
      });

      if (!Array.isArray(rawRoster) || rawRoster.length === 0) {
        return ctx.send({
          message: 'No enrolled users found for this Moodle course.',
          recordsAdded: 0,
          duplicatesSkipped: 0,
          errors: 0,
        });
      }

      // Filter to likely students only:
      //  - Must have a username
      //  - Ignore common non-student usernames (admin, guest, teacher accounts)
      //  - Matric numbers typically contain digits (e.g. "20/0541", "CSC/2020/001")
      const NON_STUDENT_NAMES = new Set(['admin', 'guest', 'administrator']);

      const roster = rawRoster.filter((user) => {
        const uname = (user.username || '').trim().toLowerCase();
        if (!uname) return false;
        if (NON_STUDENT_NAMES.has(uname)) return false;
        // Matric numbers contain at least one digit
        if (!/\d/.test(uname)) return false;
        return true;
      });

      const filtered = rawRoster.length - roster.length;
      strapi.log.info(
        `[grade-sync] Roster: ${rawRoster.length} enrolled, ${filtered} filtered (non-student), ${roster.length} to process`
      );

      // ─────────────────────────────────────────────
      // STEP 3: Concurrent batched grade fetch + inject
      // ─────────────────────────────────────────────
      let recordsAdded = 0;
      let duplicatesSkipped = 0;
      let noAttempts = 0;
      let errors = 0;

      const batchResults = await processInBatches(roster, CONCURRENCY, async (student) => {
        const moodleUserId = student.id;
        const matricNumber = (student.username || '').trim();

        // ── Auto-healer: Link ExamCredential to StudentProfile if both exist ──
        try {
          const profile = await strapi.documents('api::student-profile.student-profile').findFirst({
            filters: { MatricNumber: matricNumber },
          });
          
          const credential = await strapi.documents('api::exam-credential.exam-credential').findFirst({
            filters: { MatricNo: matricNumber },
          });

          if (profile && credential && !credential.student_profile) {
            // Link the ExamCredential to the StudentProfile
            await strapi.documents('api::exam-credential.exam-credential').update({
              documentId: credential.documentId,
              data: { student_profile: profile.documentId },
            });
            strapi.log.info(`[grade-sync] Auto-linked ExamCredential ${credential.documentId} to StudentProfile ${profile.documentId} for matric ${matricNumber}`);
          }
        } catch (linkErr) {
          // Non-fatal error — log and continue with grade sync
          strapi.log.warn(`[grade-sync] Auto-healer linking failed for ${matricNumber}:`, linkErr.message);
        }

        // ── Fetch this student's grade items ──
        const gradeData = await moodleCall('gradereport_user_get_grade_items', {
          courseid: courseId,
          userid: moodleUserId,
        });

        const gradeItems = gradeData.usergrades?.[0]?.gradeitems || [];

        // Find the specific quiz grade item
        const quizGrade = gradeItems.find(
          (item) => item.itemmodule === 'quiz' && item.iteminstance === quizId
        );

        if (!quizGrade || quizGrade.graderaw === null || quizGrade.graderaw === undefined) {
          return { status: 'no_attempt', matricNumber };
        }

        // Scale raw grade to percentage out of 100, formatted to 2 decimal places
        const graderaw = parseFloat(quizGrade.graderaw);
        const grademax = parseFloat(quizGrade.grademax) || 100;
        const finalScore = parseFloat(((graderaw / grademax) * 100).toFixed(2));

        // ── Duplicate check ──
        const existing = await strapi.entityService.findMany('api::exam-result.exam-result', {
          filters: {
            MatricNumber: matricNumber,
            CourseCode: courseCode,
          },
          limit: 1,
        });

        if (existing && existing.length > 0) {
          return { status: 'duplicate', matricNumber };
        }

        // ── Create ExamResult ──
        await strapi.entityService.create('api::exam-result.exam-result', {
          data: {
            MatricNumber: matricNumber,
            CourseCode: courseCode,
            FinalScore: finalScore,
            IsPublished: false,
          },
        });

        return { status: 'added', matricNumber, finalScore };
      });

      // Tally the results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const val = result.value;
          if (val.status === 'added') recordsAdded++;
          else if (val.status === 'duplicate') duplicatesSkipped++;
          else if (val.status === 'no_attempt') noAttempts++;
        } else {
          // Promise rejected
          strapi.log.error('[grade-sync] Student processing error:', result.reason);
          errors++;
        }
      }

      strapi.log.info(
        `[grade-sync] Complete — Added: ${recordsAdded}, Skipped: ${duplicatesSkipped}, No attempts: ${noAttempts}, Errors: ${errors}`
      );

      return ctx.send({
        message: 'Sync complete.',
        quizName: matchedQuiz.name,
        resolvedQuizId: quizId,
        cmid,
        courseId,
        courseCode,
        enrolledStudents: rawRoster.length,
        studentsProcessed: roster.length,
        nonStudentsFiltered: filtered,
        recordsAdded,
        duplicatesSkipped,
        noAttempts,
        errors,
      });
    } catch (err) {
      strapi.log.error('[grade-sync] Fatal error:', err);
      return ctx.internalServerError(`Grade sync failed: ${err.message}`);
    }
  },

  // ──────────────────────────────────────────────
  // POST /api/moodle-sync/publish-results
  // Bulk-publish all ExamResults for a given courseCode
  // ──────────────────────────────────────────────
  async publishResults(ctx) {
    const secret = ctx.request.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_WIPE_SECRET) {
      return ctx.unauthorized('Invalid or missing admin secret.');
    }

    const { courseCode } = ctx.request.body;

    if (!courseCode) {
      return ctx.badRequest('Missing required field: courseCode.');
    }

    try {
      // Handle "ALL" command - update all records without filtering
      const whereClause = courseCode === 'ALL' ? {} : { CourseCode: courseCode };
      
      const result = await strapi.db.query('api::exam-result.exam-result').updateMany({
        where: whereClause,
        data: { IsPublished: true },
      });

      const targetDescription = courseCode === 'ALL' ? 'ALL courses' : `"${courseCode}"`;
      strapi.log.info(`[publish] Set IsPublished=true for ${result.count} record(s) in ${targetDescription}`);

      return ctx.send({
        message: `Published ${result.count} result(s) for ${targetDescription}.`,
        courseCode,
        recordsPublished: result.count,
      });
    } catch (err) {
      strapi.log.error('[publish] Error:', err);
      return ctx.internalServerError(`Publish failed: ${err.message}`);
    }
  },

  // ──────────────────────────────────────────────
  // POST /api/moodle-sync/revoke-results
  // Bulk-revoke (unpublish) all ExamResults for a given courseCode
  // ──────────────────────────────────────────────
  async revokeResults(ctx) {
    const secret = ctx.request.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_WIPE_SECRET) {
      return ctx.unauthorized('Invalid or missing admin secret.');
    }

    const { courseCode } = ctx.request.body;

    if (!courseCode) {
      return ctx.badRequest('Missing required field: courseCode.');
    }

    try {
      // Handle "ALL" command - update all records without filtering
      const whereClause = courseCode === 'ALL' ? {} : { CourseCode: courseCode };
      
      const result = await strapi.db.query('api::exam-result.exam-result').updateMany({
        where: whereClause,
        data: { IsPublished: false },
      });

      const targetDescription = courseCode === 'ALL' ? 'ALL courses' : `"${courseCode}"`;
      strapi.log.info(`[revoke] Set IsPublished=false for ${result.count} record(s) in ${targetDescription}`);

      return ctx.send({
        message: `Results revoked for ${targetDescription}.`,
        courseCode,
        recordsRevoked: result.count,
      });
    } catch (err) {
      strapi.log.error('[revoke] Error:', err);
      return ctx.internalServerError(`Revoke failed: ${err.message}`);
    }
  },
};
