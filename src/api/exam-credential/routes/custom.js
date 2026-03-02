module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/exam-credentials/fetch-password',
      handler: 'exam-credential.fetchPassword',
      config: { auth: false },
    },
  ],
};