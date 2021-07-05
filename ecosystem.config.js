module.exports = {
  apps: [
    {
      name: "court-notification-bot",
      script: "./src/index.js",
      node_args: "-r dotenv-safe/config",
    },
  ],
};
