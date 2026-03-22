'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/moodle-sync/fetch-grades',
      handler: 'moodle-grade-sync.fetchGrades',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/moodle-sync/publish-results',
      handler: 'moodle-grade-sync.publishResults',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/moodle-sync/revoke-results',
      handler: 'moodle-grade-sync.revokeResults',
      config: {
        auth: false,
      },
    },
  ],
};
