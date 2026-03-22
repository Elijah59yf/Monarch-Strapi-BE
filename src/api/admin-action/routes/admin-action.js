'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/admin-action/sync-moodle',
      handler: 'admin-action.syncMoodle',
      config: {
        // Authentication will be managed via Strapi's Users & Permissions plugin
        // No auth: false - requires valid JWT token
      },
    },
    {
      method: 'POST',
      path: '/admin-action/publish-results',
      handler: 'admin-action.publishResults',
      config: {
        // Authentication will be managed via Strapi's Users & Permissions plugin
        // No auth: false - requires valid JWT token
      },
    },
    {
      method: 'POST',
      path: '/admin-action/revoke-results',
      handler: 'admin-action.revokeResults',
      config: {
        // Authentication will be managed via Strapi's Users & Permissions plugin
        // No auth: false - requires valid JWT token
      },
    },
    {
      method: 'POST',
      path: '/admin-action/broadcast-emails',
      handler: 'admin-action.broadcastEmails',
      config: {
        // Authentication will be managed via Strapi's Users & Permissions plugin
        // No auth: false - requires valid JWT token
      },
    },
  ],
};