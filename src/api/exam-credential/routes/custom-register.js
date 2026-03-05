'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/exam-credentials/register',
      handler: 'api::exam-credential.exam-credential.registerAndVerify',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/exam-credentials/registration-status',
      handler: 'api::exam-credential.exam-credential.checkRegistrationStatus',
      config: {
        auth: false,
      },
    },
  ],
};
