'use strict';

module.exports = {
  routes: [
    {
      method: 'DELETE',
      path: '/exam-credentials/wipe-all',
      handler: 'exam-credential.wipeAllData',
      config: { auth: false },
    },
  ],
};
