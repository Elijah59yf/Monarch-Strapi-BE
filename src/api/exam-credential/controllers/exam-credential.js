'use strict';
const { createCoreController } = require('@strapi/strapi').factories;
const { syncStudentToMoodle } = require('../services/moodle-sync');

/**
 * Generate a random password that satisfies Moodle's strict password policy:
 * - At least 8 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 digit
 * - At least 1 special character
 */
function generateMoodlePassword(length = 12) {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const specials = '!@#$%&*';
  const allChars = uppercase + lowercase + digits + specials;

  // Guarantee at least one character from each required category
  const mandatoryChars = [
    uppercase[Math.floor(Math.random() * uppercase.length)],
    lowercase[Math.floor(Math.random() * lowercase.length)],
    digits[Math.floor(Math.random() * digits.length)],
    specials[Math.floor(Math.random() * specials.length)],
  ];

  // Fill the remaining slots with random characters from the full set
  const remainingLength = Math.max(length - mandatoryChars.length, 4);
  for (let i = 0; i < remainingLength; i++) {
    mandatoryChars.push(allChars[Math.floor(Math.random() * allChars.length)]);
  }

  // Shuffle to avoid predictable positions
  for (let i = mandatoryChars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [mandatoryChars[i], mandatoryChars[j]] = [mandatoryChars[j], mandatoryChars[i]];
  }

  return mandatoryChars.join('');
}

module.exports = createCoreController('api::exam-credential.exam-credential', ({ strapi }) => ({

  // ──────────────────────────────────────────────
  // POST /exam-credentials/register
  // Multi-course cart: verify Paystack, dynamic pricing, returning-student check
  // ──────────────────────────────────────────────
  async registerAndVerify(ctx) {
    const { reference, firstname, surname, matricNo, contactEmail, courseIds } = ctx.request.body;

    // 1. Validate required fields
    if (!reference || !firstname || !surname || !matricNo || !Array.isArray(courseIds) || courseIds.length === 0) {
      return ctx.badRequest('Missing required fields: reference, firstname, surname, matricNo, and a non-empty courseIds array are all required.');
    }

    try {
      // 2. Fetch requested courses from the Document Service
      const courses = await strapi.documents('api::course.course').findMany({
        filters: { documentId: { $in: courseIds } },
      });

      if (!courses.length || courses.length !== courseIds.length) {
        return ctx.badRequest('One or more course IDs are invalid.');
      }

      // 3. Calculate expected price based on each course's registration state
      let expectedNaira = 0;

      for (const course of courses) {
        if (course.IsLateRegOpen) {
          expectedNaira += course.LatePrice;
        } else if (course.IsNormalRegOpen) {
          expectedNaira += course.NormalPrice;
        } else {
          return ctx.badRequest(`Registration is closed for "${course.CourseCode} — ${course.Title}".`);
        }
      }

      const expectedKobo = expectedNaira * 100;

      // 4. Verify the transaction with Paystack
      const paystackResponse = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      const paystackData = await paystackResponse.json();

      if (!paystackData.status || paystackData.data?.status !== 'success') {
        return ctx.badRequest('Payment verification failed. Transaction is not successful.');
      }

      // 5. CRITICAL — amount integrity check
      if (paystackData.data.amount !== expectedKobo) {
        strapi.log.warn(
          `Amount mismatch for ref ${reference}: paid ${paystackData.data.amount} kobo, expected ${expectedKobo} kobo`
        );
        return ctx.badRequest('Payment amount mismatch. Please contact support.');
      }

      // 6. Course-Specific Batching Engine
      const assignedBatches = {};

      for (const course of courses) {
        const capacity = course.BatchCapacity || 18;
        const count = await strapi.documents('api::exam-credential.exam-credential').count({
          filters: { courses: { documentId: course.documentId } },
        });
        assignedBatches[course.CourseCode] = Math.floor(count / capacity) + 1;
      }

      // 7. Returning-student check
      const existingStudent = await strapi.db.query('api::exam-credential.exam-credential').findOne({
        where: { MatricNo: matricNo.trim() },
        populate: { courses: true },
      });

      if (existingStudent) {
        // ── Branch A: Returning Student ──
        const existingCourseIds = (existingStudent.courses || []).map((c) => c.documentId);
        const mergedIds = [...new Set([...existingCourseIds, ...courseIds])];

        // Merge new batches into existing CourseBatches JSON
        const existingBatches = existingStudent.CourseBatches || {};
        const mergedBatches = { ...existingBatches, ...assignedBatches };

        await strapi.documents('api::exam-credential.exam-credential').update({
          documentId: existingStudent.documentId,
          data: {
            courses: mergedIds,
            CourseBatches: mergedBatches,
            IsSynced: false, // Reset — new courses need syncing
          },
        });

        // Sync returning student to Moodle (enrol + group only, user already exists)
        const returningStudentData = {
          documentId: existingStudent.documentId,
          MatricNo: matricNo.trim(),
          MoodlePassword: existingStudent.MoodlePassword,
          Firstname: existingStudent.Firstname,
          Surname: existingStudent.Surname,
          MoodleEmail: existingStudent.MoodleEmail,
        };
        // Fire async — don't block the HTTP response
        syncStudentToMoodle(returningStudentData, courses, assignedBatches).catch((err) =>
          strapi.log.error('Moodle sync (returning) background error:', err)
        );

        // Look up existing StudentProfile to return the MasterPIN
        let masterPIN = null;
        try {
          const existingProfile = await strapi.db.query('api::student-profile.student-profile').findOne({
            where: { MatricNumber: matricNo.trim() },
          });
          masterPIN = existingProfile?.MasterPIN || null;
        } catch (profileErr) {
          strapi.log.warn('Could not retrieve StudentProfile for returning student:', profileErr);
        }

        return ctx.send({
          message: 'Payment successful! Courses added to your existing profile.',
          assignedBatches,
          masterPIN,
        });
      }

      // ── Branch B: New Student ──
      const moodlePassword = generateMoodlePassword();
      const generatedEmail = `${matricNo.trim()}@monarchdem.me`;

      // Create exam credential
      const created = await strapi.documents('api::exam-credential.exam-credential').create({
        data: {
          Firstname: firstname.trim(),
          Surname: surname.trim(),
          LowSurname: surname.toLowerCase().trim(),
          MatricNo: matricNo.trim(),
          MoodleEmail: generatedEmail.toLowerCase().trim(),
          ContactEmail: contactEmail ? contactEmail.trim() : null,
          MoodlePassword: moodlePassword,
          CourseBatches: assignedBatches,
          IsSynced: false,
          courses: courseIds,
        },
        status: 'published',
      });

      // Create StudentProfile — triggers beforeCreate lifecycle hook
      // which auto-generates the MasterPIN
      let studentProfile;
      try {
        studentProfile = await strapi.entityService.create('api::student-profile.student-profile', {
          data: {
            MatricNumber: matricNo.trim(),
            ContactEmail: contactEmail ? contactEmail.trim() : null,
          },
        });
      } catch (profileErr) {
        // If profile creation fails (e.g. duplicate MatricNumber), log but don't block
        strapi.log.error('StudentProfile creation failed:', profileErr);
        // Try to find an existing profile as fallback
        studentProfile = await strapi.db.query('api::student-profile.student-profile').findOne({
          where: { MatricNumber: matricNo.trim() },
        });
      }

      // Sync new student to Moodle (create user + enrol + group)
      const newStudentData = {
        documentId: created.documentId,
        MatricNo: matricNo.trim(),
        MoodlePassword: moodlePassword,
        Firstname: firstname.trim(),
        Surname: surname.trim(),
        MoodleEmail: generatedEmail.toLowerCase().trim(),
      };
      // Fire async — don't block the HTTP response
      syncStudentToMoodle(newStudentData, courses, assignedBatches).catch((err) =>
        strapi.log.error('Moodle sync (new) background error:', err)
      );

      return ctx.send({
        message: 'Registration successful! Your Moodle account is ready.',
        assignedBatches,
        moodlePassword,
        masterPIN: studentProfile?.MasterPIN || null,
      });
    } catch (err) {
      strapi.log.error('registerAndVerify error:', err);
      return ctx.internalServerError('An unexpected error occurred. Please try again later.');
    }
  },

  // ──────────────────────────────────────────────
  // GET /exam-credentials/registration-status
  // Check if registration is currently open
  // ──────────────────────────────────────────────
  async checkRegistrationStatus(ctx) {
    try {
      const settings = await strapi.entityService.findMany('api::exam-setting.exam-setting');
      const normalOpen = settings?.IsNormalRegOpen ?? true;
      const lateOpen = settings?.IsLateRegOpen ?? true;

      return ctx.send({
        normalRegOpen: normalOpen,
        lateRegOpen: lateOpen,
      });
    } catch (err) {
      strapi.log.error('checkRegistrationStatus error:', err);
      return ctx.internalServerError('Could not retrieve registration status.');
    }
  },

  // ──────────────────────────────────────────────
  // POST /exam-credentials/fetch-password
  // Just-In-Time password release with per-course batch bouncer
  // ──────────────────────────────────────────────
  async fetchPassword(ctx) {
    const { matricNo, surname } = ctx.request.body;

    if (!matricNo || !surname) {
      return ctx.badRequest('Matric Number and Surname are required.');
    }

    try {
      // 1. Fetch the master switch (Single Type)
      const settings = await strapi.entityService.findMany('api::exam-setting.exam-setting');
      const activeBatch = settings?.CurrentActiveBatch ?? 1;

      // "Batch 0" Lockdown — entire portal is shut
      if (activeBatch === 0) {
        return ctx.forbidden('The exam portal is currently closed. Please wait for your batch to be called.');
      }

      // 2. Find the student WITH their linked courses populated
      const entry = await strapi.db.query('api::exam-credential.exam-credential').findOne({
        where: { MatricNo: matricNo.toLowerCase().trim() },
        populate: { courses: true },
      });

      if (!entry) {
        return ctx.notFound('Student not found.');
      }

      // 3. Reject if surname is not all lowercase
      if (surname.trim() !== surname.toLowerCase().trim()) {
        return ctx.badRequest('Surname must be typed in all lowercase letters.');
      }

      // 4. Verify surname matches (compare against LowSurname)
      if (entry.LowSurname?.trim() !== surname.toLowerCase().trim()) {
        return ctx.unauthorized('Invalid surname provided.');
      }

      // 5. Just-In-Time Bouncer — per-course, per-batch check
      const studentBatches = entry.CourseBatches || {};
      const studentCourses = entry.courses || [];
      let allowed = false;

      for (const course of studentCourses) {
        const studentBatch = studentBatches[course.CourseCode];
        if (!studentBatch) continue;

        const releaseOpen = course.IsPasswordReleaseOpen === true;
        const activeBatchList = Array.isArray(course.ActiveBatches) ? course.ActiveBatches : [];

        if (releaseOpen && activeBatchList.includes(studentBatch)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return ctx.forbidden(
          'Your exam is not currently active. If your course is running, please wait for your specific batch to be called. Check the timetable.'
        );
      }

      // 6. Success — return password and their course batch assignments
      return ctx.send({
        password: entry.MoodlePassword,
        courseBatches: entry.CourseBatches || {},
      });

    } catch (err) {
      console.error(err);
      return ctx.internalServerError('Server error.');
    }
  },

  // ──────────────────────────────────────────────
  // DELETE /exam-credentials/wipe-all
  // Synchronized wipe: remove students from Moodle, then purge Strapi
  // Secured via x-admin-secret header
  // ──────────────────────────────────────────────
  async wipeAllData(ctx) {
    // 1. Auth — check custom secret header
    const secret = ctx.request.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_WIPE_SECRET) {
      return ctx.unauthorized('Invalid or missing admin wipe secret.');
    }

    try {
      // 2. Fetch every student record from Strapi
      const students = await strapi.documents('api::exam-credential.exam-credential').findMany({
        limit: -1,
      });

      if (students.length === 0) {
        return ctx.send({
          message: 'Nothing to wipe — the collection is already empty.',
          moodleUsersDeleted: 0,
          strapiRecordsDeleted: 0,
        });
      }

      const usernames = students.map((s) => s.MatricNo).filter(Boolean);

      // 3. Moodle cleanup (best-effort — log and continue if Moodle is unreachable)
      let moodleDeletedCount = 0;
      const MOODLE_URL = process.env.MOODLE_URL;   // e.g. "http://localhost/moodle"
      const MOODLE_TOKEN = process.env.MOODLE_TOKEN;

      if (MOODLE_URL && MOODLE_TOKEN && usernames.length > 0) {
        try {
          // Step A — Resolve Moodle user IDs from usernames
          const lookupParams = new URLSearchParams({
            wstoken: MOODLE_TOKEN,
            wsfunction: 'core_user_get_users_by_field',
            moodlewsrestformat: 'json',
            field: 'username',
          });

          usernames.forEach((u, i) => {
            lookupParams.append(`values[${i}]`, u);
          });

          const lookupRes = await fetch(`${MOODLE_URL}/webservice/rest/server.php?${lookupParams.toString()}`);
          const lookupData = await lookupRes.json();

          if (Array.isArray(lookupData) && lookupData.length > 0) {
            const moodleIds = lookupData.map((u) => u.id);

            // Step B — Delete those users from Moodle
            const deleteParams = new URLSearchParams({
              wstoken: MOODLE_TOKEN,
              wsfunction: 'core_user_delete_users',
              moodlewsrestformat: 'json',
            });

            moodleIds.forEach((id, i) => {
              deleteParams.append(`userids[${i}]`, id);
            });

            await fetch(`${MOODLE_URL}/webservice/rest/server.php`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: deleteParams.toString(),
            });

            moodleDeletedCount = moodleIds.length;
            strapi.log.info(`Moodle wipe: deleted ${moodleDeletedCount} user(s).`);
          } else {
            strapi.log.info('Moodle wipe: no matching users found on Moodle.');
          }
        } catch (moodleErr) {
          strapi.log.error('Moodle wipe failed (continuing with Strapi wipe):', moodleErr);
        }
      } else {
        strapi.log.warn('Moodle wipe skipped — MOODLE_URL or MOODLE_TOKEN not configured.');
      }

      // 4. Purge all Strapi exam-credential records
      const strapiResult = await strapi.db
        .query('api::exam-credential.exam-credential')
        .deleteMany({});

      strapi.log.info(`Strapi wipe: deleted ${strapiResult.count} record(s).`);

      return ctx.send({
        message: 'Synchronized wipe complete.',
        moodleUsersDeleted: moodleDeletedCount,
        strapiRecordsDeleted: strapiResult.count,
      });
    } catch (err) {
      strapi.log.error('wipeAllData error:', err);
      return ctx.internalServerError('An unexpected error occurred during the wipe.');
    }
  },
}));