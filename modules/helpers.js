const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const stableStringify = require('safe-stable-stringify');
const uuid = require('uuid');

module.exports.stableStringify = stableStringify;

const uuidV4 = uuid.v4;
const uuidV5 = uuid.v5;
const uuidV6 = uuid.v6;
module.exports.uuidV4 = uuidV4;
module.exports.uuidV5 = uuidV5;
module.exports.uuidV6 = uuidV6;

const compressData = async (data) => {
  return new Promise((res, rej) =>
    zlib.gzip(data, (err, compressedData) =>
      err ? rej(err) : res(compressedData)
    )
  );
};
module.exports.compressData = compressData;

const uncompressData = async (data) => {
  return new Promise((resolve, reject) =>
    zlib.gunzip(data, (err, data) =>
      err ? reject(err) : resolve(data.toString())
    )
  );
};
module.exports.uncompressData = uncompressData;

// prompt the user on stdin and resolve true only when they type 'y' or 'yes'
// (case-insensitive). use to gate destructive scripts. when stdin is not a
// tty (pm2, cron, piped runs), refuse instead of hanging on a prompt no one
// will ever answer — caller must pass --yes on argv to bypass.
const confirm = async (question) => {
  if (!process.stdin.isTTY) {
    if (process.argv.includes('--yes')) {
      return true;
    }
    console.log('refusing to run non-interactively without --yes');
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(question + ' [y/N] ', resolve);
    });
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
};
module.exports.confirm = confirm;

const wait = (ms) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};
module.exports.wait = wait;

const sha256 = (input) => {
  return crypto.createHash('sha256').update(input).digest('hex');
};
module.exports.sha256 = sha256;

const md5 = (input) => {
  return crypto.createHash('md5').update(input).digest('hex');
};
module.exports.md5 = md5;

const sha8 = (input) => {
  return sha256(input).slice(0, 8);
};
module.exports.sha8 = sha8;
