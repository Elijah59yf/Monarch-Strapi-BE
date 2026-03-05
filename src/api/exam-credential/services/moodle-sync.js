'use strict';

/**
 * Moodle REST API integration service.
 *
 * Syncs a paying student into Moodle:
 *  1. Creates (or looks up) the Moodle user account.
 *  2. Enrols the user into every purchased course.
 *  3. Assigns the user to the correct "Batch N" group in each course.
 *
 * All Moodle REST calls use native fetch() with form-urlencoded payloads.
 */

const MOODLE_STUDENT_ROLE_ID = 5; // Moodle's default "student" role

/* ── Helper: call any Moodle REST function ── */
async function moodleCall(wsfunction, params = {}) {
  const baseUrl = process.env.MOODLE_URL; // e.g. "http://localhost:8019"
  const token = process.env.MOODLE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('MOODLE_URL or MOODLE_TOKEN is not configured in .env');
  }

  const body = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: 'json',
    ...params,
  });

  const res = await fetch(`${baseUrl}/webservice/rest/server.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();

  // Moodle returns { exception, errorcode, message } on failure
  if (data && data.exception) {
    const err = new Error(`Moodle [${wsfunction}]: ${data.message}`);
    err.errorcode = data.errorcode;
    throw err;
  }

  return data;
}

/* ── Main export ── */

/**
 * @param {Object}   studentData      – The Strapi exam-credential document (must include documentId)
 * @param {Array}    coursesArray     – Array of Strapi Course documents (must include MoodleCourseID, CourseCode)
 * @param {Object}   assignedBatches  – Map of CourseCode → batch number, e.g. { "MTH101": 1, "PHY107": 3 }
 */
async function syncStudentToMoodle(studentData, coursesArray, assignedBatches) {
  try {
    // ──────────────────────────────────────────
    // 1. User lookup / creation
    // ──────────────────────────────────────────
    let userId = null;

    // Check if the user already exists in Moodle
    const existingUsers = await moodleCall('core_user_get_users_by_field', {
      field: 'username',
      'values[0]': studentData.MatricNo,
    });

    if (Array.isArray(existingUsers) && existingUsers.length > 0) {
      userId = existingUsers[0].id;
      strapi.log.info(`Moodle sync: user "${studentData.MatricNo}" already exists (id=${userId}).`);
    } else {
      // Create the user
      const created = await moodleCall('core_user_create_users', {
        'users[0][username]': studentData.MatricNo,
        'users[0][password]': studentData.MoodlePassword,
        'users[0][firstname]': studentData.Firstname,
        'users[0][lastname]': studentData.Surname,
        'users[0][email]': studentData.Email,
      });

      if (!Array.isArray(created) || created.length === 0) {
        throw new Error('Moodle user creation returned an unexpected response.');
      }

      userId = created[0].id;
      strapi.log.info(`Moodle sync: created user "${studentData.MatricNo}" (id=${userId}).`);
    }

    // ──────────────────────────────────────────
    // 2. Per-course: enrol → group → assign
    // ──────────────────────────────────────────
    for (const course of coursesArray) {
      const moodleCourseId = course.MoodleCourseID;
      const courseCode = course.CourseCode;
      const batchNum = assignedBatches[courseCode];

      if (!moodleCourseId) {
        strapi.log.warn(`Moodle sync: skipping "${courseCode}" — no MoodleCourseID.`);
        continue;
      }

      // ── A. Enrol user into the course ──
      await moodleCall('enrol_manual_enrol_users', {
        'enrolments[0][roleid]': MOODLE_STUDENT_ROLE_ID,
        'enrolments[0][userid]': userId,
        'enrolments[0][courseid]': moodleCourseId,
      });

      strapi.log.info(`Moodle sync: enrolled user ${userId} in course ${courseCode} (moodle id=${moodleCourseId}).`);

      // If no batch was assigned for this course, skip group logic
      if (!batchNum) continue;

      const expectedGroupName = `Batch ${batchNum}`;

      // ── B. Get or create the batch group ──
      const existingGroups = await moodleCall('core_group_get_course_groups', {
        courseid: moodleCourseId,
      });

      let groupId = null;

      if (Array.isArray(existingGroups)) {
        const match = existingGroups.find((g) => g.name === expectedGroupName);
        if (match) {
          groupId = match.id;
        }
      }

      if (!groupId) {
        // Create the group
        const createdGroups = await moodleCall('core_group_create_groups', {
          'groups[0][courseid]': moodleCourseId,
          'groups[0][name]': expectedGroupName,
          'groups[0][description]': `Auto-created batch group for ${courseCode}`,
        });

        if (!Array.isArray(createdGroups) || createdGroups.length === 0) {
          strapi.log.error(`Moodle sync: failed to create group "${expectedGroupName}" in course ${courseCode}.`);
          continue;
        }

        groupId = createdGroups[0].id;
        strapi.log.info(`Moodle sync: created group "${expectedGroupName}" (id=${groupId}) in course ${courseCode}.`);
      }

      // ── C. Assign user to the group ──
      await moodleCall('core_group_add_group_members', {
        'members[0][groupid]': groupId,
        'members[0][userid]': userId,
      });

      strapi.log.info(`Moodle sync: added user ${userId} to group "${expectedGroupName}" in course ${courseCode}.`);
    }

    // All Moodle operations succeeded — mark the Strapi record as synced
    if (studentData.documentId) {
      await strapi.documents('api::exam-credential.exam-credential').update({
        documentId: studentData.documentId,
        data: { IsSynced: true },
      });
      strapi.log.info(`Moodle sync: marked "${studentData.MatricNo}" as synced.`);
    }

    return { success: true, moodleUserId: userId };
  } catch (err) {
    strapi.log.error('Moodle sync failed:', err);
    return { success: false, error: err.message };
  }
}

module.exports = { syncStudentToMoodle };
