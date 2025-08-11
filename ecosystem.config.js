module.exports = {
  apps: [
    {
      name: 'fireworks-bot',
      script: 'fireworks-bot.js',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
