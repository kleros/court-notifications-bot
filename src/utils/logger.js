const logger = require("pino")({
  // Disable pid and hostname in the logging object
  base: null,
});

module.exports = logger;
