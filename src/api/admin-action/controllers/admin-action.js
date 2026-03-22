'use strict';

/**
 * admin-action controller
 * 
 * Custom API endpoints for Admin Portal actions
 * 
 * Routes:
 * - POST /api/admin-action/sync-moodle
 * - POST /api/admin-action/publish-results  
 * - POST /api/admin-action/revoke-results
 * - POST /api/admin-action/broadcast-emails
 * 
 * All endpoints require valid JWT authentication via Strapi's Users & Permissions plugin
 */

const CONCURRENCY = 5; // max parallel Moodle API calls

// Email service dependencies - optional
let Resend, BrevoClient;
try {
  ({ Resend } = require('resend'));
} catch (e) {
  // Resend package not installed - will be handled in broadcastEmails
}
try {
  ({ BrevoClient } = require('@getbrevo/brevo'));
} catch (e) {
  // Brevo package not installed - will be handled in broadcastEmails
}

module.exports = {
  /**
   * Sync Moodle grades for a course
   * @param {Object} ctx - Strapi context object
   * @returns {Object} JSON response
   */
  async syncMoodle(ctx) {
    try {
      // Extract all three parameters
      const { courseCode, cmid, courseId } = ctx.request.body;

      if (!courseCode || !cmid || !courseId) {
        return ctx.badRequest('courseCode, cmid, and courseId are required in request body');
      }

      strapi.log.info(`[admin-action] syncMoodle called for course: ${courseCode}, cmid: ${cmid}, courseId: ${courseId}`);

      const MOODLE_URL = process.env.MOODLE_URL;
      const MOODLE_TOKEN = process.env.MOODLE_TOKEN;

      if (!MOODLE_URL || !MOODLE_TOKEN) {
        return ctx.internalServerError('MOODLE_URL or MOODLE_TOKEN is not configured in .env');
      }

      // Helper: call any Moodle REST function
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

      // Helper: process chunks with controlled concurrency
      async function processInBatches(items, batchSize, fn) {
        const results = [];
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          const batchResults = await Promise.allSettled(batch.map(fn));
          results.push(...batchResults);
        }
        return results;
      }

      // STEP 1: Resolve cmid → quizid
      strapi.log.info(
        `[admin-action] Resolving cmid ${cmid} for Moodle course ${courseId} ("${courseCode}")`
      );

      const quizzesData = await moodleCall('mod_quiz_get_quizzes_by_courses', {
        'courseids[0]': courseId,
      });

      const quizzes = quizzesData.quizzes || [];
      const matchedQuiz = quizzes.find((q) => q.coursemodule === parseInt(cmid));

      if (!matchedQuiz) {
        return ctx.badRequest(
          `Quiz module not found in this course. cmid ${cmid} does not match any quiz in Moodle course ${courseId}.`
        );
      }

      const quizId = matchedQuiz.id;
      strapi.log.info(
        `[admin-action] Resolved cmid ${cmid} → quizid ${quizId} ("${matchedQuiz.name}")`
      );

      // STEP 2: Fetch enrolled roster + filter
      const rawRoster = await moodleCall('core_enrol_get_enrolled_users', {
        courseid: courseId,
      });

      if (!Array.isArray(rawRoster) || rawRoster.length === 0) {
        return ctx.send({
          message: 'No enrolled users found for this Moodle course.',
          quizName: matchedQuiz.name,
          cmid,
          courseId,
          courseCode,
          enrolledStudents: 0,
          studentsProcessed: 0,
          nonStudentsFiltered: 0,
          recordsAdded: 0,
          duplicatesSkipped: 0,
          noAttempts: 0,
          errors: 0
        });
      }

      // Filter to likely students only:
      const NON_STUDENT_NAMES = new Set(['admin', 'guest', 'administrator']);
      const roster = rawRoster.filter((user) => {
        const uname = (user.username || '').trim().toLowerCase();
        if (!uname) return false;
        if (NON_STUDENT_NAMES.has(uname)) return false;
        if (!/\d/.test(uname)) return false;
        return true;
      });

      const filtered = rawRoster.length - roster.length;
      strapi.log.info(
        `[admin-action] Roster: ${rawRoster.length} enrolled, ${filtered} filtered (non-student), ${roster.length} to process`
      );

      // STEP 3: Concurrent batched grade fetch + inject
      let recordsAdded = 0;
      let duplicatesSkipped = 0;
      let noAttempts = 0;
      let errors = 0;

      const batchResults = await processInBatches(roster, CONCURRENCY, async (student) => {
        const moodleUserId = student.id;
        const matricNumber = (student.username || '').trim();

        // Auto-healer: Link ExamCredential to StudentProfile if both exist
        try {
          const profile = await strapi.documents('api::student-profile.student-profile').findFirst({
            filters: { MatricNumber: matricNumber },
          });
          
          const credential = await strapi.documents('api::exam-credential.exam-credential').findFirst({
            filters: { MatricNo: matricNumber },
          });

          if (profile && credential && !credential.student_profile) {
            await strapi.documents('api::exam-credential.exam-credential').update({
              documentId: credential.documentId,
              data: { student_profile: profile.documentId },
            });
            strapi.log.info(`[admin-action] Auto-linked ExamCredential ${credential.documentId} to StudentProfile ${profile.documentId} for matric ${matricNumber}`);
          }
        } catch (linkErr) {
          strapi.log.warn(`[admin-action] Auto-healer linking failed for ${matricNumber}:`, linkErr.message);
        }

        // Fetch this student's grade items
        const gradeData = await moodleCall('gradereport_user_get_grade_items', {
          courseid: courseId,
          userid: moodleUserId,
        });

        const gradeItems = gradeData.usergrades?.[0]?.gradeitems || [];
        const quizGrade = gradeItems.find(
          (item) => item.itemmodule === 'quiz' && item.iteminstance === quizId
        );

        if (!quizGrade || quizGrade.graderaw === null || quizGrade.graderaw === undefined) {
          return { status: 'no_attempt', matricNumber };
        }

        const graderaw = parseFloat(quizGrade.graderaw);
        const grademax = parseFloat(quizGrade.grademax) || 100;
        const finalScore = parseFloat(((graderaw / grademax) * 100).toFixed(2));

        // Duplicate check
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

        // Create ExamResult
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
          strapi.log.error('[admin-action] Student processing error:', result.reason);
          errors++;
        }
      }

      strapi.log.info(
        `[admin-action] Sync complete — Added: ${recordsAdded}, Skipped: ${duplicatesSkipped}, No attempts: ${noAttempts}, Errors: ${errors}`
      );

      return ctx.send({
        message: 'Sync complete.',
        quizName: matchedQuiz.name,
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
    } catch (error) {
      strapi.log.error('[admin-action] syncMoodle error:', error);
      return ctx.internalServerError(`An error occurred during syncMoodle operation: ${error.message}`);
    }
  },

  /**
   * Publish exam results for a course
   * @param {Object} ctx - Strapi context object
   * @returns {Object} JSON response
   */
  async publishResults(ctx) {
    try {
      const { courseCode } = ctx.request.body;

      if (!courseCode) {
        return ctx.badRequest('courseCode is required in request body');
      }

      strapi.log.info(`[admin-action] publishResults called for course: ${courseCode}`);

      // Handle "ALL" command - update all records without filtering
      const whereClause = courseCode === 'ALL' ? {} : { CourseCode: courseCode };
      
      const result = await strapi.db.query('api::exam-result.exam-result').updateMany({
        where: whereClause,
        data: { IsPublished: true },
      });

      const targetDescription = courseCode === 'ALL' ? 'ALL courses' : `"${courseCode}"`;
      strapi.log.info(`[admin-action] Set IsPublished=true for ${result.count} record(s) in ${targetDescription}`);

      return ctx.send({
        message: `Published ${result.count} result(s) for ${targetDescription}.`,
        courseCode,
        recordsPublished: result.count,
      });
    } catch (error) {
      strapi.log.error('[admin-action] publishResults error:', error);
      return ctx.internalServerError(`An error occurred during publishResults operation: ${error.message}`);
    }
  },

  /**
   * Revoke (unpublish) exam results for a course
   * @param {Object} ctx - Strapi context object
   * @returns {Object} JSON response
   */
  async revokeResults(ctx) {
    try {
      const { courseCode } = ctx.request.body;

      if (!courseCode) {
        return ctx.badRequest('courseCode is required in request body');
      }

      strapi.log.info(`[admin-action] revokeResults called for course: ${courseCode}`);

      // Handle "ALL" command - update all records without filtering
      const whereClause = courseCode === 'ALL' ? {} : { CourseCode: courseCode };
      
      const result = await strapi.db.query('api::exam-result.exam-result').updateMany({
        where: whereClause,
        data: { IsPublished: false },
      });

      const targetDescription = courseCode === 'ALL' ? 'ALL courses' : `"${courseCode}"`;
      strapi.log.info(`[admin-action] Set IsPublished=false for ${result.count} record(s) in ${targetDescription}`);

      return ctx.send({
        message: `Results revoked for ${targetDescription}.`,
        courseCode,
        recordsRevoked: result.count,
      });
    } catch (error) {
      strapi.log.error('[admin-action] revokeResults error:', error);
      return ctx.internalServerError(`An error occurred during revokeResults operation: ${error.message}`);
    }
  },

  /**
   * Broadcast emails for a course
   * @param {Object} ctx - Strapi context object
   * @returns {Object} JSON response
   */
  async broadcastEmails(ctx) {
    let courseCode;
    try {
      ({ courseCode } = ctx.request.body);

      if (!courseCode) {
        return ctx.badRequest('courseCode is required in request body');
      }

      strapi.log.info(`[admin-action] broadcastEmails called for course: ${courseCode}`);

      // 1. Fetch EmailProvider configuration
      const emailProvider = await strapi.documents('api::email-provider.email-provider').findMany({
        limit: 1,
      });
      
      const providerMode = emailProvider?.[0]?.EmailProviderMode || 'Automatic';
      
      // 2. Initialize email clients
      const resendClient = Resend ? new Resend(process.env.RESEND_API_KEY) : null;
      const brevoClient = BrevoClient ? new BrevoClient({ apiKey: process.env.BREVO_API_KEY }) : null;
      
      const BATCH_SIZE = 100;
      let queue = [];
      let totalCredentials = 0;
      let targetCourse = null;
      
      // 3. Build query based on courseCode
      if (courseCode === 'ALL') {
        strapi.log.info(`[admin-action] Starting broadcast for ALL courses with provider mode: ${providerMode}`);
        
        // Paginated query for ALL courses - only credentials with unsent emails
        let start = 0;
        let hasMore = true;
        
        while (hasMore) {
          const batch = await strapi.documents('api::exam-credential.exam-credential').findMany({
            start,
            limit: BATCH_SIZE,
            filters: {
              student_profile: {
                IsEmailSent: { $in: [false, null] }
              }
            },
            populate: {
              courses: true,
              student_profile: true
            }
          });
          
          if (batch.length === 0) {
            hasMore = false;
          } else {
            queue = queue.concat(batch);
            start += BATCH_SIZE;
            totalCredentials += batch.length;
            
            if (batch.length < BATCH_SIZE) {
              hasMore = false;
            }
          }
        }
        
        strapi.log.info(`[admin-action] Found ${queue.length} students in queue (unsent emails) out of ${totalCredentials} total exam credentials across ALL courses`);
      } else {
        // Specific course mode - find the matching Course
        const course = await strapi.documents('api::course.course').findMany({
          filters: { CourseCode: courseCode },
          populate: {
            exam_credentials: {
              populate: {
                student_profile: true
              }
            }
          },
          limit: 1,
        });

        if (!course || course.length === 0) {
          return ctx.notFound(`Course with code "${courseCode}" not found`);
        }

        targetCourse = course[0];
        const examCredentials = targetCourse.exam_credentials || [];
        
        // Build queue: only students where student_profile.IsEmailSent is false or null
        queue = examCredentials.filter(cred => {
          const studentProfile = cred.student_profile;
          return studentProfile && (studentProfile.IsEmailSent === false || studentProfile.IsEmailSent === null);
        });
        
        totalCredentials = examCredentials.length;
        strapi.log.info(`[admin-action] Found ${queue.length} students in queue (unsent emails) out of ${totalCredentials} total for course "${courseCode}"`);
      }

      if (queue.length === 0) {
        const message = courseCode === 'ALL' 
          ? 'No pending emails across ALL courses - all students have already been notified'
          : `No pending emails for course "${courseCode}" - all students have already been notified`;
        
        strapi.log.info(`[admin-action] ${message}`);
        return ctx.send({
          success: true,
          message: message,
          stats: {
            totalAttempted: 0,
            sentViaResend: 0,
            sentViaBrevo: 0,
            failedOrUnsent: 0
          }
        });
      }

      // 4. Statistics tracking
      const stats = {
        totalAttempted: queue.length,
        sentViaResend: 0,
        sentViaBrevo: 0,
        failedOrUnsent: 0
      };

      // 5. Stateful failover loop - STRICTLY SEQUENTIAL
      for (const [index, credential] of queue.entries()) {
        const studentProfile = credential.student_profile;
        const studentEmail = credential.ContactEmail || credential.MoodleEmail;
        
        if (!studentEmail) {
          strapi.log.warn(`[admin-action] Student ${credential.MatricNo} has no email address, skipping`);
          stats.failedOrUnsent++;
          continue;
        }

        // Determine active provider for this iteration
        let activeProvider = providerMode === 'Resend Only' ? 'resend' : 
                           providerMode === 'Brevo Only' ? 'brevo' : 'resend';
        
        strapi.log.info(`[admin-action] Processing student ${credential.MatricNo} (${index + 1}/${queue.length}) with active provider: ${activeProvider}`);
        
        let emailSent = false;
        let rateLimitHit = false;

        // Email content - conditional based on ALL mode vs specific course
        let subject, htmlBody, textBody;
        
        if (courseCode === 'ALL') {
          // ALL mode: generic email without course reference
          subject = '[M-Academy] Your Results are Live!';
          htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>M-Academy Results Notification</h2>
              <p>Hello ${credential.Firstname},</p>
              <p>Your examination results have been published and are now available. Please use the PIN below to access them.</p>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>MasterPIN:</strong> ${studentProfile.MasterPIN}</p>
              </div>
              <p>If you encounter any issues, please contact the M-Academy support team.</p>
            </div>
          `;
          textBody = `Hello ${credential.Firstname},\n\nYour examination results have been published and are now available. Please use the PIN below to access them.\n\nMasterPIN: ${studentProfile.MasterPIN}\n\nIf you encounter any issues, please contact the M-Academy support team.`;
        } else {
          // Specific course mode - need targetCourse reference
          const targetCourseFromCredential = credential.courses?.[0] || targetCourse;
          const courseTitle = targetCourseFromCredential?.Title || 'the course';
          
          subject = `[M-Academy] Your Results for ${courseCode} are Live!`;
          htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>M-Academy Results Notification</h2>
              <p>Hello ${credential.Firstname},</p>
              <p>Your examination results for <strong>${courseCode} - ${courseTitle}</strong> have been published and are now available. Please use the PIN below to access them.</p>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>MasterPIN:</strong> ${studentProfile.MasterPIN}</p>
              </div>
              <p>If you encounter any issues, please contact the M-Academy support team.</p>
            </div>
          `;
          textBody = `Hello ${credential.Firstname},\n\nYour examination results for ${courseCode} - ${courseTitle} have been published and are now available. Please use the PIN below to access them.\n\nMasterPIN: ${studentProfile.MasterPIN}\n\nIf you encounter any issues, please contact the M-Academy support team.`;
        }

        try {
          // Attempt to send with active provider
          if (activeProvider === 'resend' && resendClient) {
            try {
              const resendResult = await resendClient.emails.send({
                from: 'M-Academy <noreply@monarchdem.me>',
                to: studentEmail,
                subject: subject,
                html: htmlBody,
                text: textBody,
              });

              if (resendResult.data?.id) {
                strapi.log.info(`[admin-action] Success: Sent email to ${studentEmail} via Resend for student ${credential.MatricNo}`);
                emailSent = true;
                stats.sentViaResend++;
              }
            } catch (resendError) {
              strapi.log.error(`[admin-action] Resend error for ${studentEmail}:`, {
                statusCode: resendError.statusCode,
                name: resendError.name,
                message: resendError.message,
                code: resendError.code,
                details: resendError.details
              });
              
              // Check for rate limit (429 status code)
              if (resendError.statusCode === 429 || 
                  resendError.name?.toLowerCase().includes('rate_limit') ||
                  resendError.message?.toLowerCase().includes('rate limit')) {
                strapi.log.warn(`[admin-action] Resend rate limit hit for ${studentEmail}, will failover to Brevo if mode is Automatic`);
                rateLimitHit = true;
                
                if (providerMode === 'Automatic') {
                  activeProvider = 'brevo';
                  strapi.log.info(`[admin-action] Switching to Brevo provider for remaining emails`);
                }
              }
            }
          }

          // If Resend failed due to rate limit and we're in Automatic mode, try Brevo
          if (!emailSent && activeProvider === 'brevo' && brevoClient) {
            try {
              strapi.log.info(`[admin-action] Attempting to send email via Brevo to ${studentEmail}`);
              const brevoResult = await brevoClient.transactionalEmails.sendTransacEmail({
                subject: subject,
                htmlContent: htmlBody,
                textContent: textBody,
                sender: { email: "noreply@monarchdem.me", name: "M-Academy" },
                to: [{ email: studentEmail, name: `${credential.Firstname} ${credential.Surname}` }]
              });
              
              if (brevoResult.messageId) {
                strapi.log.info(`[admin-action] Success: Sent email to ${studentEmail} via Brevo for student ${credential.MatricNo}`);
                emailSent = true;
                stats.sentViaBrevo++;
              } else {
                strapi.log.warn(`[admin-action] Brevo sent but no messageId returned for ${studentEmail}:`, brevoResult);
              }
            } catch (brevoError) {
              strapi.log.error(`[admin-action] Brevo error for ${studentEmail}:`, {
                message: brevoError.message,
                statusCode: brevoError.statusCode,
                response: brevoError.response,
                stack: brevoError.stack,
                fullError: brevoError
              });
            }
          }

          // 7. CRITICAL: Immediate persistence after each successful send
          if (emailSent && studentProfile) {
            try {
              await strapi.documents('api::student-profile.student-profile').update({
                documentId: studentProfile.documentId,
                data: {
                  IsEmailSent: true
                }
              });
              strapi.log.info(`[admin-action] Updated database: IsEmailSent = true for student ${credential.MatricNo}`);
            } catch (updateError) {
              strapi.log.error(`[admin-action] Failed to update IsEmailSent for student ${credential.MatricNo}:`, {
                message: updateError.message,
                stack: updateError.stack,
                documentId: studentProfile.documentId
              });
              // Even if persistence fails, we count it as sent
            }
          } else {
            strapi.log.warn(`[admin-action] Email not sent for student ${credential.MatricNo} (${studentEmail}) - marked as failed/unsent`);
            stats.failedOrUnsent++;
          }

          // Small delay to avoid overwhelming the email providers (100ms between emails)
          if (index < queue.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

        } catch (loopError) {
          strapi.log.error(`[admin-action] Unexpected error processing student ${credential.MatricNo}:`, {
            message: loopError.message,
            stack: loopError.stack,
            studentEmail: studentEmail,
            credential: credential.MatricNo
          });
          stats.failedOrUnsent++;
        }
      }

      // 8. Return comprehensive statistics
      strapi.log.info(`[admin-action] Broadcast completed for course "${courseCode}": ${stats.sentViaResend} via Resend, ${stats.sentViaBrevo} via Brevo, ${stats.failedOrUnsent} failed`);
      return ctx.send({
        success: true,
        message: `Broadcast completed for course "${courseCode}"`,
        stats: stats,
        providerMode: providerMode
      });

    } catch (error) {
      strapi.log.error('[admin-action] broadcastEmails error:', {
        message: error.message,
        stack: error.stack,
        courseCode: courseCode,
        fullError: error
      });
      return ctx.internalServerError('An unexpected error occurred during the broadcast');
    }
  }
};
