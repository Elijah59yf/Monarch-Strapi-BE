module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/broadcast-results',
      handler: 'broadcast.broadcastResults',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};