// const dotenv = require('dotenv'); // load variables from .env file
const dotenv = require('../modules/secdotenv'); // load variables from .env file
dotenv.config({ quiet: true });
// turn off AWS SDK maintenance mode message
// require('aws-sdk/lib/maintenance_mode_message').suppress = true;

const TIMEZONE = 'America/New_York';
const NODE_ENV = process.env.NODE_ENV || 'development';

process.env.TZ = TIMEZONE; // force nodejs to use specific timezone
const isProduction = NODE_ENV === 'production';

module.exports = {
  app: {
    timezone: TIMEZONE,
    nodeEnv: NODE_ENV,
    isProduction,
  },
  aws: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  scrapingbee: {
    apiKey: process.env.SCRAPINGBEE_API_KEY,
  },
};
