module.exports = [
  'strapi::errors',
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      enabled: true,
      origin: [
        'http://localhost:1337', // Strapi itself

        // Your test/dev servers
        'http://localhost:5500', 
        'http://127.0.0.1:5500', 

        // Your new Apache server
        'http://localhost:8080', 
        'http://127.0.0.1:8080',
        'https://exam.monarchdem.me', //Registration Portal
        'https://console.monarchdem.me', //Admin Portal
        // Your future Cloudflare domain
        'https://monarchdem.me' // CHANGE THIS

      ],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      headers: [
        'Content-Type',
        'Authorization',
        'Origin',
        'Accept',
        'X-Requested-With',
        'X-CSRF-Token'
      ],
      credentials: true,
      keepHeaderOnError: true,
    },
  },
  'strapi::poweredBy',
  'strapi::logger',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  // ... rest of the file
];
