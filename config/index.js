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
  mcp: {
    // the http endpoint of the server in docker, used by the stdio worker
    httpUrl: process.env.MCP_HTTP_URL || 'http://127.0.0.1:22001/mcp',
  },
  // gluetun control server, one per proton container. used to cycle the vpn
  // tunnel after youtube flags an egress ip, which hands the container a new
  // exit node. host is the atlas tailscale ip, not loopback — the containers
  // run on atlas and this code runs on beast.
  gluetun: {
    host: process.env.GLUETUN_HOST || 'http://100.124.201.21',
    apiKey: process.env.GLUETUN_API_KEY || 'paste-a-random-uuid-here',
  },
};
