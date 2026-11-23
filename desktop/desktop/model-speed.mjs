/** An explicit service-tier rejection before a request starts is safe to retry at standard speed. */
export const tierRejected = (message) =>
  /service[ _-]?tier|priority tier|ultra[ -]?fast mode/i.test(message) &&
  /invalid|unsupported|not supported|unavailable|not available|not allowed|not eligible|not enabled|unknown|not permitted|not included|unrecognized/i.test(message);
