'use strict';

const { Resend } = require('resend');
const { BrevoClient } = require('@getbrevo/brevo');

/**
 * Stateful Email Broadcasting System
 * 
 * Features:
 * 1. Sequential processing with immediate persistence
 * 2. Automatic failover from Resend to Brevo on rate limits (429)
 * 3. Configurable provider mode (Automatic/Resend Only/Brevo Only)
 * 4. Paginated fetching for ALL mode to prevent memory crashes
 */
module.exports = {
  async broadcastResults(ctx) {
    const { courseCode } = ctx.request.body;

    // Validate input
    if (!courseCode) {
      return ctx.badRequest('courseCode is required in request body');
    }

    try {
      // 1. Fetch EmailProvider configuration (Single Type)
      const emailProvider = await strapi.documents('api::email-provider.email-provider').findMany({
        limit: 1,
      });
      
      const providerMode = emailProvider?.[0]?.EmailProviderMode || 'Automatic';
      
      // 2. Initialize email clients
      const resendClient = new Resend(process.env.RESEND_API_KEY);
      const brevoClient = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
      
      const BATCH_SIZE = 100;
      let queue = [];
      let totalCredentials = 0;
      let targetCourse = null;
      
      // 3. Build query based on courseCode
      if (courseCode === 'ALL') {
        strapi.log.info(`Starting broadcast for ALL courses with provider mode: ${providerMode}`);
        
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
        
        strapi.log.info(`Found ${queue.length} students in queue (unsent emails) out of ${totalCredentials} total exam credentials across ALL courses`);
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
        strapi.log.info(`Found ${queue.length} students in queue (unsent emails) out of ${totalCredentials} total for course "${courseCode}"`);
      }

      if (queue.length === 0) {
        const message = courseCode === 'ALL' 
          ? 'No pending emails across ALL courses - all students have already been notified'
          : `No pending emails for course "${courseCode}" - all students have already been notified`;
        
        strapi.log.info(message);
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
          strapi.log.warn(`Student ${credential.MatricNo} has no email address, skipping`);
          stats.failedOrUnsent++;
          continue;
        }

        // Determine active provider for this iteration
        let activeProvider = providerMode === 'Resend Only' ? 'resend' : 
                           providerMode === 'Brevo Only' ? 'brevo' : 'resend';
        
        strapi.log.info(`Processing student ${credential.MatricNo} (${index + 1}/${queue.length}) with active provider: ${activeProvider}`);
        
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
          // Find the course from the credential's courses relation or use the previously fetched targetCourse
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
          if (activeProvider === 'resend') {
            try {
              const resendResult = await resendClient.emails.send({
                from: 'M-Academy <noreply@monarchdem.me>',
                to: studentEmail,
                subject: subject,
                html: htmlBody,
                text: textBody,
              });

              if (resendResult.data?.id) {
                strapi.log.info(`Success: Sent email to ${studentEmail} via Resend for student ${credential.MatricNo}`);
                emailSent = true;
                stats.sentViaResend++;
              }
            } catch (resendError) {
              strapi.log.error(`Resend error for ${studentEmail}:`, {
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
                strapi.log.warn(`Resend rate limit hit for ${studentEmail}, will failover to Brevo if mode is Automatic`);
                rateLimitHit = true;
                
                if (providerMode === 'Automatic') {
                  activeProvider = 'brevo';
                  strapi.log.info(`Switching to Brevo provider for remaining emails`);
                }
              }
            }
          }

          // If Resend failed due to rate limit and we're in Automatic mode, try Brevo
          if (!emailSent && activeProvider === 'brevo') {
            try {
              strapi.log.info(`Attempting to send email via Brevo to ${studentEmail}`);
              const brevoResult = await brevoClient.transactionalEmails.sendTransacEmail({
                subject: subject,
                htmlContent: htmlBody,
                textContent: textBody,
                sender: { email: "noreply@monarchdem.me", name: "M-Academy" },
                to: [{ email: studentEmail, name: `${credential.Firstname} ${credential.Surname}` }]
              });
              
              if (brevoResult.messageId) {
                strapi.log.info(`Success: Sent email to ${studentEmail} via Brevo for student ${credential.MatricNo}`);
                emailSent = true;
                stats.sentViaBrevo++;
              } else {
                strapi.log.warn(`Brevo sent but no messageId returned for ${studentEmail}:`, brevoResult);
              }
            } catch (brevoError) {
              strapi.log.error(`Brevo error for ${studentEmail}:`, {
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
              strapi.log.info(`Updated database: IsEmailSent = true for student ${credential.MatricNo}`);
            } catch (updateError) {
              strapi.log.error(`Failed to update IsEmailSent for student ${credential.MatricNo}:`, {
                message: updateError.message,
                stack: updateError.stack,
                documentId: studentProfile.documentId
              });
              // Even if persistence fails, we count it as sent
            }
          } else {
            strapi.log.warn(`Email not sent for student ${credential.MatricNo} (${studentEmail}) - marked as failed/unsent`);
            stats.failedOrUnsent++;
          }

          // Small delay to avoid overwhelming the email providers (100ms between emails)
          if (index < queue.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

        } catch (loopError) {
          strapi.log.error(`Unexpected error processing student ${credential.MatricNo}:`, {
            message: loopError.message,
            stack: loopError.stack,
            studentEmail: studentEmail,
            credential: credential.MatricNo
          });
          stats.failedOrUnsent++;
        }
      }

      // 8. Return comprehensive statistics
      strapi.log.info(`Broadcast completed for course "${courseCode}": ${stats.sentViaResend} via Resend, ${stats.sentViaBrevo} via Brevo, ${stats.failedOrUnsent} failed`);
      return ctx.send({
        success: true,
        message: `Broadcast completed for course "${courseCode}"`,
        stats: stats,
        providerMode: providerMode
      });

    } catch (error) {
      strapi.log.error('Broadcast results error:', {
        message: error.message,
        stack: error.stack,
        courseCode: courseCode,
        fullError: error
      });
      return ctx.internalServerError('An unexpected error occurred during the broadcast');
    }
  }
};