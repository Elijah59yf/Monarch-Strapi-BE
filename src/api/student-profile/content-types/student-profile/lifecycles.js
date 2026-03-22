'use strict';

const crypto = require('crypto');

/**
 * StudentProfile lifecycle hooks
 *
 * beforeCreate — auto-generates a 10-character alphanumeric uppercase
 * MasterPIN if one is not explicitly provided when creating a profile.
 */
module.exports = {
  beforeCreate(event) {
    const { data } = event.params;

    if (!data.MasterPIN) {
      // Generate 10-char uppercase alphanumeric string
      // Use 8 random bytes → base36 gives ~12 chars, slice to 10
      data.MasterPIN = crypto
        .randomBytes(8)
        .toString('base64url')       // URL-safe base64: A-Z a-z 0-9 _ -
        .replace(/[^A-Za-z0-9]/g, '') // strip non-alphanumeric
        .toUpperCase()
        .slice(0, 10)
        .padEnd(10, 'X');            // pad if somehow < 10 chars
    }
  },
};
