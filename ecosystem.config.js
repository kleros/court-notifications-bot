module.exports = {
  apps: [
    {
      name: "mainnet",
      interpreter: "/bin/bash",
      script: "yarn",
      args: ["start:mainnet"],
      time: true,
    },
    {
      name: "xdai",
      interpreter: "/bin/bash",
      script: "yarn",
      args: ["start:xdai"],
      time: true,
    },
  ],
};
