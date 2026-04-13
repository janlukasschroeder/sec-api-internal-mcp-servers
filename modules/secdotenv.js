// secdotenv — single-file, zero-dependency drop-in replacement for dotenv
// copy this file into your project and require it instead of dotenv.
// only uses Node.js built-ins: crypto, child_process, fs, path, os.

const nodeCrypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { log } = console;

// --- constants ---

const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'secdotenv:';
const MARKER_SECIT = '# SECIT';
const MARKER_NOSECIT = '# NOSECIT';
const DIRECTIVE_SEC_ALL = '# SEC_ALL';
const DIRECTIVE_SEC_BACK = '# SEC_BACK';
const STRATEGY_SEC_ALL = 'SEC_ALL';
const STRATEGY_SEC_ONLY_SELECTED = 'SEC_ONLY_SELECTED';
const SECDOTENV_DIR = path.join(os.homedir(), '.secdotenv');
const KEY_PATH = path.join(SECDOTENV_DIR, 'key');
const CONFIG_PATH = path.join(SECDOTENV_DIR, 'config.json');
const DEFAULT_SSH_KEY_PATH = path.join(os.homedir(), '.ssh', 'id_ed25519');
const GENERATED_SSH_KEY_PATH = path.join(os.homedir(), '.ssh', 'id_secdotenv');
const IGNORED_PATHS = ['/node_modules/', '/output/', '/dify/'];
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
const CIPHER_REGEX = new RegExp(
  PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[A-Za-z0-9+/=]{40,}',
  'g'
);
// tests if a variable name includes any of the following
const SECRET_PATTERNS_REGEX = [
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CLIENT_SECRET',
  'ACCESS_KEY',
  'SECRET_KEY',
  'DATABASE_URL',
  'DATABASE_URI',
  'DATABASE_PASSWORD',
  'DATABASE_PASS',
  'DB_URL',
  'DB_URI',
  'DB_PASSWORD',
  'DB_PASS',
  'API_KEY',
  'API_TOKEN',
  'API_SECRET',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'AUTH_TOKEN',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'SIGNING_KEY',
  'CONNECTION_STRING',
  'TOKEN',
  'SECRET',
  'WEBHOOK_KEY',
];

// tests if a variable name exactly (case insensitive) matches any of the following
const SECRET_PATTERNS_EXACT = [
  // --- services ---
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'KAFKA_PASSWORD',
  'MONGO_URI',
  'MONGODB_URI',
  'ES_URI',
  'ELASTICSEARCH_URI',
  'REDIS_URL',
  'STRIPE_SECRET',
  'STRIPE_SK',
  'TWILIO_AUTH',
  'SENDGRID_API',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'SLACK_TOKEN',
  'SLACK_WEBHOOK',
  'DISCORD_TOKEN',
  'SENTRY_DSN',
  'AUTH0_CLIENT_ID',
  'AUTH0_CLIENT_SECRET',
  'MYSQL_PASSWORD',
  // --- exact matches ---
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SECRET',
  'AWS_SESSION_TOKEN',
  'OVH_US_S3_ACCESS_KEY_ID',
  'OVH_US_S3_SECRET_ACCESS_KEY',
  // --- prefix patterns (commented out — move to REGEX if needed) ---
  // 'VERCEL_',
  // 'CLOUDFLARE_',
  // 'CF_',
  // 'FIREBASE_',
  // 'GCP_',
  // 'AZURE_',
  // 'HETZNER_',
  // 'DIGITALOCEAN_',
  // 'DO_',
  // 'HEROKU_',
];

const FORCE_TRIGGER_KEYS = [
  'AUTH0_CLIENT_SECRET',
  'AUTH0_MGMT_API_CLIENT_SECRET',
  'AWS_ACCESS_KEY',
  'AWS_SECRET_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'STRIPE_API_KEY',
  'GITHUB_TOKEN',
];

const SECDOTENV_CONFIG_TEMPLATE =
  "const dotenv = require('../modules/secdotenv');\ndotenv.config();\n";

// --- ./modules/cli.js ---

const cliJs = () => {
  const COMMANDS = {
    secure: {
      fn: cmdSecure,
      desc: 'encrypt # SECIT marked variables in .env files',
      usage: 'secure [--path <dir>]',
    },
    'auto-secure': {
      fn: cmdAutoSecure,
      desc: 'add # SECIT to known secret patterns and encrypt',
      usage: 'auto-secure [--path <dir>]',
    },
    audit: {
      fn: cmdAudit,
      desc: 'scan .env files and report security summary',
      usage: 'audit [--path <dir>]',
    },
    init: {
      fn: cmdInit,
      desc: 'initialize secdotenv with your SSH key',
      usage: 'init [--key <path>]',
    },
    'sec-back': {
      fn: cmdRestore,
      desc: 'decrypt all secdotenv: values back to plaintext',
      usage: 'sec-back [--path <file>]',
    },
    restore: {
      fn: cmdRestore,
      desc: 'alias for sec-back',
      usage: 'restore [--path <path>]',
    },
    find: {
      fn: cmdFind,
      desc: 'find all .env files under a directory',
      usage: 'find [--path <dir>]',
    },
    rekey: {
      fn: cmdRekey,
      desc: 're-encrypt all .env files after SSH key rotation',
      usage: 'rekey',
    },
    list: {
      fn: cmdList,
      desc: 'show all registered .env files',
      usage: 'list',
    },
    clean: {
      fn: cmdClean,
      desc: 'remove stale .env entries from config',
      usage: 'clean',
    },
    exclude: {
      fn: cmdExclude,
      desc: 'exclude a path from secure/audit/auto-secure',
      usage: 'exclude --path <dir>',
    },
    'auto-migrate': {
      fn: cmdAutoMigrate,
      desc: 'migrate projects from dotenv to secdotenv',
      usage: 'auto-migrate [--path <dir>] [--force]',
    },
  };

  function cmdInit(flags) {
    keyManager.init(flags.key);
    log('secdotenv initialized.');
    log('derived key stored in ~/.secdotenv/key');
  }

  function cmdRekey() {
    const oldKey = keyManager.loadKey();
    const cfg = keyManager.loadConfig();
    if (!cfg.sshKeyPath) {
      throw new Error('no SSH key path in config. Run: node secdotenv.js init');
    }
    const newKey = keyManager.init(cfg.sshKeyPath);
    let totalRekeyed = 0;

    for (const envPath of cfg.envFiles || []) {
      if (!fileIo.isExists(envPath)) {
        log('skipping (not found): ' + envPath);
        continue;
      }
      let raw = fileIo.readFile(envPath);
      let changed = false;
      raw = raw.replace(CIPHER_REGEX, (match) => {
        const plaintext = crypto.decrypt({
          encoded: match.slice(PREFIX.length),
          key: oldKey,
        });
        changed = true;
        totalRekeyed++;
        return PREFIX + crypto.encrypt({ plaintext, key: newKey });
      });
      if (changed) {
        fileIo.writeFile(envPath, raw);
        log('rekeyed: ' + envPath);
      }
    }

    log('done. ' + totalRekeyed + ' values rekeyed.');
  }

  function cmdRestore(flags) {
    const key = keyManager.loadKey();
    const resolved = flags.path || path.resolve(process.cwd(), '.env');
    if (!fileIo.isExists(resolved)) {
      throw new Error('.env not found at ' + resolved);
    }
    let raw = fileIo.readFile(resolved);
    let count = 0;
    raw = raw.replace(CIPHER_REGEX, (match) => {
      count++;
      return crypto.decrypt({ encoded: match.slice(PREFIX.length), key });
    });
    fileIo.writeFile(resolved, raw);
    log('restored ' + count + ' value(s) to plaintext in ' + resolved);
  }

  async function cmdFind(flags) {
    const startDir = flags.path || process.cwd();
    const files = findEnvFiles(startDir);
    const cfg = keyManager.loadConfig();
    const registered = new Set(cfg.envFiles || []);

    if (files.length === 0) {
      log('no .env files found under ' + path.resolve(startDir));
      return;
    }

    log(files.length + ' .env file(s) found:');
    for (const f of files) {
      const tag = registered.has(f) ? '  (registered)' : '';
      log('  ' + f + tag);
    }
  }

  function countSecrets(raw) {
    const lines = raw.split('\n');
    let plaintextSecrets = 0;
    let encryptedSecrets = 0;
    let emptySecrets = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed === MARKER_SECIT) {
        continue;
      }

      let varName = null;
      let value = null;

      if (trimmed.startsWith('#')) {
        const afterHash = trimmed.slice(1).trimStart();
        const eqIdx = afterHash.indexOf('=');
        if (eqIdx !== -1) {
          const k = afterHash.substring(0, eqIdx);
          if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k)) {
            varName = k;
            value = afterHash.substring(eqIdx + 1);
          }
        }
      } else {
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
          varName = line.substring(0, eqIdx).trim();
          value = line.substring(eqIdx + 1);
        }
      }

      if (!varName || value === null) {
        continue;
      }
      if (!isSecretKey(varName)) {
        continue;
      }
      if (value.trim() === '') {
        emptySecrets++;
      } else if (value.startsWith(PREFIX)) {
        encryptedSecrets++;
      } else {
        plaintextSecrets++;
      }
    }

    return { plaintextSecrets, encryptedSecrets, emptySecrets };
  }

  function logSecureReport({ envPath, before, after }) {
    const newlyEncrypted = before.plaintextSecrets - after.plaintextSecrets;
    log('');
    log('  ' + envPath);
    const beforeEmpty = before.emptySecrets
      ? ', ' + before.emptySecrets + ' empty'
      : '';
    const afterEmpty = after.emptySecrets
      ? ', ' + after.emptySecrets + ' empty'
      : '';
    log(
      '    before:  ' +
        before.plaintextSecrets +
        ' plaintext ' +
        (before.plaintextSecrets > 0 ? '❌' : '✅') +
        ', ' +
        before.encryptedSecrets +
        ' encrypted ✅' +
        beforeEmpty
    );
    log('    action:  ' + newlyEncrypted + ' secret(s) encrypted');
    log(
      '    after:   ' +
        after.plaintextSecrets +
        ' plaintext ' +
        (after.plaintextSecrets > 0 ? '❌' : '✅') +
        ', ' +
        after.encryptedSecrets +
        ' encrypted ✅' +
        afterEmpty
    );
  }

  async function cmdSecure(flags) {
    let files;
    if (flags.path) {
      files = filterExcluded(findEnvFiles(flags.path));
    } else {
      const envPath = path.resolve(process.cwd(), '.env');
      files = filterExcluded(fileIo.isExists(envPath) ? [envPath] : []);
    }
    const key = keyManager.loadKey();

    let totalNewlyEncrypted = 0;
    let filesChanged = 0;
    let permsFixed = 0;

    for (const envPath of files) {
      const raw = fileIo.readFile(envPath);
      const before = countSecrets(raw);
      const { updatedRaw, changed } = index.preprocess({ raw, key });
      if (changed) {
        fileIo.writeFile(envPath, updatedRaw);
        keyManager.registerEnvFile(envPath);
        filesChanged++;
      }
      const after = countSecrets(updatedRaw || raw);
      const newlyEncrypted = before.plaintextSecrets - after.plaintextSecrets;
      totalNewlyEncrypted += newlyEncrypted;
      logSecureReport({ envPath, before, after });

      // ensure correct permissions
      if (fileIo.getMode(envPath) !== 0o600) {
        fileIo.chmod(envPath, 0o600);
        log('    fixed permissions: ' + envPath + ' → rw------- (0600)');
        permsFixed++;
      }
    }

    log('');
    if (totalNewlyEncrypted === 0 && permsFixed === 0) {
      log('✅ all secrets already encrypted, all permissions correct.');
    } else {
      const parts = [];
      if (totalNewlyEncrypted > 0) {
        parts.push(
          totalNewlyEncrypted +
            ' secret(s) encrypted across ' +
            filesChanged +
            ' file(s)'
        );
      }
      if (permsFixed > 0) {
        parts.push(permsFixed + ' file(s) permissions fixed to 0600');
      }
      log('✅ done. ' + parts.join(', ') + '.');
    }
  }

  async function cmdAutoSecure(flags) {
    let files;
    if (flags.path) {
      files = filterExcluded(findEnvFiles(flags.path));
    } else {
      const envPath = path.resolve(process.cwd(), '.env');
      files = filterExcluded(fileIo.isExists(envPath) ? [envPath] : []);
    }
    const key = keyManager.loadKey();

    let totalNewlyEncrypted = 0;
    let filesChanged = 0;
    let permsFixed = 0;

    for (const envPath of files) {
      const raw = fileIo.readFile(envPath);
      const lines = raw.split('\n');
      const newLines = [];
      let marked = 0;

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed === '') {
          newLines.push(lines[i]);
          continue;
        }

        let varName = null;
        let value = null;

        if (trimmed.startsWith('#') && trimmed !== MARKER_SECIT) {
          const afterHash = trimmed.slice(1).trimStart();
          const eqIdx = afterHash.indexOf('=');
          if (eqIdx !== -1) {
            const k = afterHash.substring(0, eqIdx);
            if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k)) {
              varName = k;
              value = afterHash.substring(eqIdx + 1);
            }
          }
        } else if (!trimmed.startsWith('#')) {
          const eqIdx = lines[i].indexOf('=');
          if (eqIdx !== -1) {
            varName = lines[i].substring(0, eqIdx).trim();
            value = lines[i].substring(eqIdx + 1);
          }
        }

        if (!varName || !value) {
          newLines.push(lines[i]);
          continue;
        }

        if (value.startsWith(PREFIX)) {
          newLines.push(lines[i]);
          continue;
        }

        let alreadyMarked = false;
        for (let j = newLines.length - 1; j >= 0; j--) {
          const prev = newLines[j].trim();
          if (prev === '') {
            continue;
          }
          if (prev === MARKER_SECIT) {
            alreadyMarked = true;
          }
          break;
        }

        if (!alreadyMarked && isSecretKey(varName)) {
          newLines.push(MARKER_SECIT);
          marked++;
        }

        newLines.push(lines[i]);
      }

      const before = countSecrets(raw);
      if (marked > 0) {
        const markedRaw = newLines.join('\n');
        const { updatedRaw, changed } = index.preprocess({
          raw: markedRaw,
          key,
        });
        if (changed) {
          fileIo.writeFile(envPath, updatedRaw);
          keyManager.registerEnvFile(envPath);
          filesChanged++;
        }
        const after = countSecrets(updatedRaw || markedRaw);
        const newlyEncrypted = before.plaintextSecrets - after.plaintextSecrets;
        totalNewlyEncrypted += newlyEncrypted;
        logSecureReport({ envPath, before, after });
      }

      // ensure correct permissions (always, not just when marked)
      if (fileIo.getMode(envPath) !== 0o600) {
        fileIo.chmod(envPath, 0o600);
        log('    fixed permissions: ' + envPath + ' → rw------- (0600)');
        permsFixed++;
      }
    }

    log('');
    if (totalNewlyEncrypted === 0 && permsFixed === 0) {
      log('✅ all secrets already encrypted, all permissions correct.');
    } else {
      const parts = [];
      if (totalNewlyEncrypted > 0) {
        parts.push(
          totalNewlyEncrypted +
            ' secret(s) encrypted across ' +
            filesChanged +
            ' file(s)'
        );
      }
      if (permsFixed > 0) {
        parts.push(permsFixed + ' file(s) permissions fixed to 0600');
      }
      log('✅ done. ' + parts.join(', ') + '.');
    }
  }

  function cmdList() {
    const cfg = keyManager.loadConfig();
    const envFiles = cfg.envFiles || [];
    if (envFiles.length === 0) {
      log('no registered .env files.');
    } else {
      log(envFiles.length + ' registered .env file(s):');
      for (const f of envFiles) {
        const found = fileIo.isExists(f);
        log('  ' + f + (found ? '' : '  (not found)'));
      }
    }

    const excludePaths = cfg.excludePaths || [];
    if (excludePaths.length > 0) {
      log('');
      log(excludePaths.length + ' excluded path(s):');
      for (const p of excludePaths) {
        log('  ' + p);
      }
    }
  }

  function cmdClean() {
    const cfg = keyManager.loadConfig();
    const envFiles = cfg.envFiles || [];
    const kept = envFiles.filter((f) => fileIo.isExists(f));
    const removed = envFiles.length - kept.length;
    if (removed === 0) {
      log('no stale entries found.');
      return;
    }
    cfg.envFiles = kept;
    keyManager.saveConfig(cfg);
    log('removed ' + removed + ' stale entry/entries from config.');
  }

  function filterExcluded(files) {
    return files.filter((f) => !keyManager.isExcluded(f));
  }

  function cmdExclude(flags) {
    if (!flags.path) {
      log('usage: secdotenv exclude --path <dir>');
      return;
    }
    keyManager.excludePath(flags.path);
    log('excluded: ' + path.resolve(flags.path));
  }

  async function cmdAudit(flags) {
    const startDir = flags.path || process.cwd();
    const files = filterExcluded(findEnvFiles(startDir));

    if (files.length === 0) {
      log('no .env files found under ' + path.resolve(startDir));
      return;
    }

    const tally = {};
    const filePlaintext = {};
    const filePerms = {};

    for (const envPath of files) {
      const mode = fileIo.getMode(envPath);
      if (mode !== 0o600) {
        filePerms[envPath] =
          modeToString(mode) + ' (0' + mode.toString(8) + ')';
      }
      const raw = fileIo.readFile(envPath);
      const lines = raw.split('\n');
      let filePlaintextCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed === MARKER_SECIT) {
          continue;
        }

        let varLine = trimmed;
        if (trimmed.startsWith('#')) {
          const afterHash = trimmed.slice(1).trimStart();
          const eqIdx = afterHash.indexOf('=');
          if (eqIdx === -1) {
            continue;
          }
          const key = afterHash.substring(0, eqIdx);
          if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
            continue;
          }
          varLine = afterHash;
        }

        const eqIdx = varLine.indexOf('=');
        if (eqIdx === -1) {
          continue;
        }

        const varName = varLine.substring(0, eqIdx);
        const value = varLine.substring(eqIdx + 1);

        if (!tally[varName]) {
          tally[varName] = {
            count: 0,
            encrypted: 0,
            plaintext: 0,
            empty: 0,
            isSecret: isSecretKey(varName),
          };
        }
        tally[varName].count++;
        if (value.trim() === '') {
          tally[varName].empty++;
        } else if (value.startsWith(PREFIX)) {
          tally[varName].encrypted++;
        } else {
          tally[varName].plaintext++;
          if (tally[varName].isSecret) {
            filePlaintextCount++;
          }
        }
      }

      if (filePlaintextCount > 0) {
        filePlaintext[envPath] = filePlaintextCount;
      }
    }

    // sort: secrets first, then by count descending
    const entries = Object.entries(tally).sort((a, b) => {
      if (a[1].isSecret !== b[1].isSecret) {
        return b[1].isSecret - a[1].isSecret;
      }
      return b[1].count - a[1].count;
    });

    log(
      'audit of ' +
        path.resolve(startDir) +
        ' — ' +
        files.length +
        ' .env file(s) scanned'
    );

    // --- variable breakdown ---
    log('');
    log('variables found:');
    for (const [name, info] of entries) {
      const countStr = (info.count + ' file(s)').padEnd(12);
      if (info.isSecret) {
        const parts = [];
        if (info.encrypted > 0) {
          parts.push(info.encrypted + ' encrypted ✅');
        }
        if (info.plaintext > 0) {
          parts.push(info.plaintext + ' plaintext ❌');
        }
        if (info.empty > 0) {
          parts.push(info.empty + ' empty');
        }
        log(
          '  ' + name.padEnd(30) + countStr + '[secret]  ' + parts.join(', ')
        );
      } else {
        log('  ' + name.padEnd(30) + countStr);
      }
    }

    // --- files with plaintext secrets ---
    const exposedFiles = Object.entries(filePlaintext);
    if (exposedFiles.length > 0) {
      log('');
      log('files with plaintext secrets:');
      for (const [filePath, count] of exposedFiles) {
        log('  ❌ ' + filePath + '  — ' + count + ' plaintext secret(s)');
      }
    }

    // --- files with incorrect permissions ---
    const badPerms = Object.entries(filePerms);
    if (badPerms.length > 0) {
      log('');
      log('files with incorrect permissions (expected rw-------, 0600):');
      for (const [filePath, mode] of badPerms) {
        log('  ❌ ' + filePath + '  — ' + mode);
      }
    }

    // --- summary ---
    const totalVars = entries.length;
    const secretVars = entries.filter((e) => e[1].isSecret);
    const plaintextSecrets = secretVars.filter((e) => e[1].plaintext > 0);
    const encryptedSecrets = secretVars.filter((e) => e[1].encrypted > 0);
    const totalPlaintext = plaintextSecrets.reduce(
      (sum, e) => sum + e[1].plaintext,
      0
    );
    const totalEncrypted = encryptedSecrets.reduce(
      (sum, e) => sum + e[1].encrypted,
      0
    );

    log('');
    log('summary:');
    log('  total variables:    ' + totalVars);
    log('  secret variables:   ' + secretVars.length);
    if (totalPlaintext > 0) {
      log(
        '  ❌ plaintext secrets:  ' +
          totalPlaintext +
          ' value(s) across ' +
          plaintextSecrets.length +
          ' variable(s) → run "secdotenv auto-secure" to fix'
      );
    } else {
      log('  ✅ plaintext secrets:  0');
    }
    if (totalEncrypted > 0) {
      log(
        '  ✅ encrypted secrets:  ' +
          totalEncrypted +
          ' value(s) across ' +
          encryptedSecrets.length +
          ' variable(s)'
      );
    } else {
      log('  encrypted secrets:  0');
    }
    if (badPerms.length > 0) {
      log(
        '  ❌ file permissions:   ' +
          badPerms.length +
          ' file(s) not rw------- (0600)'
      );
    } else {
      log('  ✅ file permissions:   all files rw------- (0600)');
    }
  }

  function prompt(question) {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  function hasForceKeys(envContent) {
    return FORCE_TRIGGER_KEYS.some((k) => envContent.includes(k + '='));
  }

  async function cmdAutoMigrate(flags) {
    const startDir = flags.path || process.cwd();
    const files = filterExcluded(findEnvFiles(startDir));
    const force = flags.force || false;

    // resolve path to self
    const secdotenvContent = fileIo.readFile(__filename);

    let migrated = 0;
    let skipped = 0;

    log(
      'auto-migrate of ' +
        path.resolve(startDir) +
        ' — ' +
        files.length +
        ' .env file(s) found'
    );

    for (const envPath of files) {
      const projectDir = path.dirname(envPath);

      // skip ignore patterns
      if (
        IGNORED_PATHS.some(
          (p) => projectDir.includes(p) || projectDir.endsWith(p.slice(0, -1))
        )
      ) {
        log('');
        log('  ⏭️  ' + projectDir);
        log('    skipped: path matches ignore pattern');
        skipped++;
        continue;
      }

      const modulesDir = path.join(projectDir, 'modules');
      const targetSecdotenv = path.join(modulesDir, 'secdotenv.js');
      const configIndex = path.join(projectDir, 'config', 'index.js');

      // already migrated
      if (fileIo.isExists(targetSecdotenv)) {
        log('');
        log('  ⏭️  ' + projectDir);
        log('    skipped: ./modules/secdotenv.js already exists');
        skipped++;
        continue;
      }

      // check standard eligibility
      const hasModules = fileIo.isExists(modulesDir);
      const hasConfig = fileIo.isExists(configIndex);
      const configContent = hasConfig ? fileIo.readFile(configIndex) : '';
      const hasSecdotenvRequire = configContent.includes('secdotenv');
      if (hasSecdotenvRequire) {
        log('');
        log('  ⏭️  ' + projectDir);
        log('    skipped: config/index.js already references secdotenv');
        skipped++;
        continue;
      }

      const hasDotenvRequire =
        configContent.includes("require('dotenv')") ||
        configContent.includes('require("dotenv")');

      const eligible = hasModules && hasConfig && hasDotenvRequire;

      if (!eligible && !force) {
        log('');
        log('  ⏭️  ' + projectDir);
        if (!hasModules) {
          log('    skipped: no ./modules/ folder');
        } else if (!hasConfig) {
          log('    skipped: no ./config/index.js');
        } else {
          log('    skipped: no dotenv require found in config/index.js');
        }
        skipped++;
        continue;
      }

      // --force: check if .env has trigger keys
      if (!eligible && force) {
        const envContent = fileIo.readFile(envPath);
        if (!hasForceKeys(envContent)) {
          log('');
          log('  ⏭️  ' + projectDir);
          log('    skipped: no force-trigger keys found in .env');
          skipped++;
          continue;
        }
      }

      // --- confirm with user ---
      log('');
      log('  eligible: ' + projectDir + (eligible ? '' : ' (force)'));
      const answer = await prompt('    migrate this project? [Y/n]');
      if (answer.toLowerCase() === 'n') {
        log('    skipped by user');
        skipped++;
        continue;
      }

      // --- migrate ---

      // 1. ensure modules/ exists and copy secdotenv.js
      if (!hasModules) {
        fileIo.mkDir(modulesDir, { recursive: true });
      }
      fileIo.writeFile(targetSecdotenv, secdotenvContent);

      // 2. handle config/index.js
      if (!hasConfig) {
        const configDir = path.join(projectDir, 'config');
        if (!fileIo.isExists(configDir)) {
          fileIo.mkDir(configDir, { recursive: true });
        }
        fileIo.writeFile(configIndex, SECDOTENV_CONFIG_TEMPLATE);
      } else if (hasDotenvRequire) {
        const updatedConfig = configContent.replace(
          /^((?!\s*\/\/).*require\(['"]dotenv['"]\).*)$/gm,
          (match) => {
            const commented = '// ' + match;
            const replaced = match.replace(
              /['"]dotenv['"]/,
              "'../modules/secdotenv'"
            );
            return commented + '\n' + replaced;
          }
        );
        fileIo.writeFile(configIndex, updatedConfig);
      } else {
        fileIo.writeFile(
          configIndex,
          SECDOTENV_CONFIG_TEMPLATE + '\n' + configContent
        );
      }

      // 3. verify migration
      try {
        execFileSync(process.execPath, [configIndex], {
          cwd: projectDir,
          timeout: 10000,
          stdio: 'ignore',
        });
        log('    ✅ verification passed: config/index.js runs without errors');
      } catch (err) {
        log('    ❌ verification failed: config/index.js threw an error');
        log('    reverting migration...');
        if (hasConfig) {
          fileIo.writeFile(configIndex, configContent);
        } else {
          fileIo.unlinkSync(configIndex);
        }
        fileIo.unlinkSync(targetSecdotenv);
        skipped++;
        continue;
      }

      // 4. auto-secure the .env
      keyManager.registerEnvFile(envPath);
      log('    migrated: copied secdotenv.js, updated config/index.js');

      await cmdAutoSecure({ path: projectDir });

      migrated++;
    }

    log('');
    log('done. ' + migrated + ' project(s) migrated, ' + skipped + ' skipped.');
  }

  function modeToString(mode) {
    const chars = 'rwx';
    let result = '';
    for (let i = 2; i >= 0; i--) {
      const bits = (mode >> (i * 3)) & 7;
      for (let j = 2; j >= 0; j--) {
        result += bits & (1 << j) ? chars[2 - j] : '-';
      }
    }
    return result;
  }

  function isEnvFile(name) {
    if (name === '.env') {
      return true;
    }
    return name.startsWith('.env.') && !name.endsWith('.example');
  }

  function isIgnoredDir(name) {
    return (
      name.startsWith('.') ||
      IGNORED_PATHS.some((p) => name === p.replace(/\//g, ''))
    );
  }

  function findEnvFiles(startDir) {
    const resolved = path.resolve(startDir);
    if (!fileIo.isExists(resolved)) {
      throw new Error('directory not found: ' + resolved);
    }

    const results = [];
    const queue = [resolved];

    while (queue.length > 0) {
      const dir = queue.shift();

      let entries;
      try {
        entries = fileIo.readDir(dir, { withFileTypes: true });
      } catch (err) {
        continue;
      }

      for (const e of entries) {
        if (e.isFile() && isEnvFile(e.name)) {
          results.push(path.join(dir, e.name));
        } else if (e.isDirectory() && !isIgnoredDir(e.name)) {
          queue.push(path.join(dir, e.name));
        }
      }
    }

    return results;
  }

  function isSecretKey(varName) {
    const upper = varName.toUpperCase();
    if (SECRET_PATTERNS_REGEX.some((pattern) => upper.includes(pattern))) {
      return true;
    }
    return SECRET_PATTERNS_EXACT.some((pattern) => upper === pattern);
  }

  function parseArgs(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--key' && args[i + 1]) {
        flags.key = args[i + 1];
        i++;
      }
      if (args[i] === '--path' && args[i + 1]) {
        flags.path = args[i + 1];
        i++;
      }
      if (args[i] === '--force') {
        flags.force = true;
      }
    }
    return flags;
  }

  async function run() {
    const command = process.argv[2];
    const flags = parseArgs(process.argv.slice(3));

    const entry = COMMANDS[command];
    if (entry) {
      await entry.fn(flags);
    } else {
      log('usage: node secdotenv.js <command>');
      log('');
      log('commands:');
      for (const [, cmd] of Object.entries(COMMANDS)) {
        log('  ' + cmd.usage.padEnd(24) + ' ' + cmd.desc);
      }
      process.exit(1);
    }
  }

  return { run };
};

// --- ./modules/crypto.js ---

const cryptoJs = () => {
  const encrypt = ({ plaintext, key }) => {
    const nonce = nodeCrypto.randomBytes(NONCE_LENGTH);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([nonce, encrypted, authTag]).toString('base64');
  };

  const decrypt = ({ encoded, key }) => {
    const buf = Buffer.from(encoded, 'base64');
    const nonce = buf.subarray(0, NONCE_LENGTH);
    const authTag = buf.subarray(-AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(NONCE_LENGTH, -AUTH_TAG_LENGTH);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
  };

  return { encrypt, decrypt };
};

const crypto = cryptoJs();

// --- ./modules/file-io.js ---

const fileIoJs = () => {
  const isExists = (filePath) => fs.existsSync(filePath);

  const readFile = (filePath) => fs.readFileSync(filePath, 'utf8');

  const writeFile = (filePath, data, opts) => {
    log('writing ' + filePath);
    fs.writeFileSync(filePath, data, {
      encoding: 'utf8',
      mode: 0o600,
      ...opts,
    });
  };

  const mkDir = (dirPath, opts) => fs.mkdirSync(dirPath, opts);

  const readDir = (dirPath, opts) => fs.readdirSync(dirPath, opts);

  const getMode = (filePath) => fs.statSync(filePath).mode & 0o777;

  const chmod = (filePath, mode) => fs.chmodSync(filePath, mode);

  const unlinkSync = (filePath) => {
    log('removing ' + filePath);
    fs.unlinkSync(filePath);
  };

  return {
    isExists,
    readFile,
    writeFile,
    mkDir,
    readDir,
    getMode,
    chmod,
    unlinkSync,
  };
};

const fileIo = fileIoJs();

// --- ./modules/key-manager.js ---

const keyManagerJs = () => {
  const ensureDir = () => {
    if (!fileIo.isExists(SECDOTENV_DIR)) {
      fileIo.mkDir(SECDOTENV_DIR, { recursive: true, mode: 0o700 });
    }
  };

  const loadConfig = () => {
    if (!fileIo.isExists(CONFIG_PATH)) {
      return { sshKeyPath: null, envFiles: [] };
    }
    return JSON.parse(fileIo.readFile(CONFIG_PATH));
  };

  const saveConfig = (cfg) => {
    ensureDir();
    fileIo.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), {
      mode: 0o600,
    });
  };

  const registerEnvFile = (envFilePath) => {
    const absPath = path.resolve(envFilePath);
    const cfg = loadConfig();
    if (!cfg.envFiles) {
      cfg.envFiles = [];
    }
    if (!cfg.envFiles.includes(absPath)) {
      cfg.envFiles.push(absPath);
      saveConfig(cfg);
    }
  };

  const generateSshKey = () => {
    const sshDir = path.join(os.homedir(), '.ssh');
    if (!fileIo.isExists(sshDir)) {
      fileIo.mkDir(sshDir, { recursive: true, mode: 0o700 });
    }
    execFileSync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      GENERATED_SSH_KEY_PATH,
      '-N',
      '',
      '-C',
      'secdotenv',
    ]);
    log('generated SSH key at ' + GENERATED_SSH_KEY_PATH);
    return GENERATED_SSH_KEY_PATH;
  };

  const init = (sshKeyPath) => {
    let keyPath = sshKeyPath || DEFAULT_SSH_KEY_PATH;
    let resolvedPath = keyPath.startsWith('~')
      ? path.join(os.homedir(), keyPath.slice(1))
      : keyPath;

    if (!fileIo.isExists(resolvedPath) && !sshKeyPath) {
      keyPath = GENERATED_SSH_KEY_PATH;
      resolvedPath = keyPath;
      if (!fileIo.isExists(resolvedPath)) {
        generateSshKey();
      }
    } else if (!fileIo.isExists(resolvedPath)) {
      throw new Error('SSH key not found at ' + resolvedPath);
    }

    const sshKeyContent = fileIo.readFile(resolvedPath);
    const derivedKey = nodeCrypto
      .createHash('sha256')
      .update(sshKeyContent)
      .digest();

    ensureDir();
    fileIo.writeFile(KEY_PATH, derivedKey.toString('hex'), { mode: 0o600 });

    const cfg = loadConfig();
    cfg.sshKeyPath = keyPath;
    saveConfig(cfg);

    return derivedKey;
  };

  const loadKey = () => {
    if (!fileIo.isExists(KEY_PATH)) {
      log('secdotenv not initialized — running auto-init...');
      init();
    }
    return Buffer.from(fileIo.readFile(KEY_PATH).trim(), 'hex');
  };

  const excludePath = (dirPath) => {
    const absPath = path.resolve(dirPath);
    const cfg = loadConfig();
    if (!cfg.excludePaths) {
      cfg.excludePaths = [];
    }
    if (!cfg.excludePaths.includes(absPath)) {
      cfg.excludePaths.push(absPath);
      saveConfig(cfg);
    }
  };

  const isExcluded = (filePath) => {
    const cfg = loadConfig();
    const excludePaths = cfg.excludePaths || [];
    const absPath = path.resolve(filePath);
    return excludePaths.some((p) => absPath.startsWith(p));
  };

  return {
    init,
    loadKey,
    loadConfig,
    saveConfig,
    registerEnvFile,
    excludePath,
    isExcluded,
  };
};

const keyManager = keyManagerJs();

// --- ./modules/dotenv.js ---

const dotenvJs = () => {
  const parse = (src) => {
    const obj = {};
    let lines = src.toString();
    lines = lines.replace(/\r\n?/gm, '\n');

    let match;
    while ((match = LINE.exec(lines)) != null) {
      const key = match[1];
      let value = (match[2] || '').trim();
      const maybeQuote = value[0];
      value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
      if (maybeQuote === '"') {
        value = value.replace(/\\n/g, '\n');
        value = value.replace(/\\r/g, '\r');
      }
      obj[key] = value;
    }

    return obj;
  };

  const populate = (processEnv, parsed, options) => {
    const override = Boolean(options && options.override);
    for (const key of Object.keys(parsed)) {
      if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
        if (override === true) {
          processEnv[key] = parsed[key];
        }
      } else {
        processEnv[key] = parsed[key];
      }
    }
  };

  const config = (options) => {
    const envPath =
      options && options.path
        ? path.resolve(options.path)
        : path.resolve(process.cwd(), '.env');

    if (!fileIo.isExists(envPath)) {
      return { parsed: {} };
    }

    const raw = fileIo.readFile(envPath);
    const parsed = parse(raw);

    let processEnv = process.env;
    if (options && options.processEnv != null) {
      processEnv = options.processEnv;
    }

    populate(processEnv, parsed, options);
    return { parsed };
  };

  return { parse, populate, config };
};

const dotenv = dotenvJs();
module.exports.parse = dotenv.parse;
module.exports.populate = dotenv.populate;

// --- ./index.js ---

const indexJs = () => {
  const shouldEncrypt = ({ marker, strategy }) => {
    if (marker === MARKER_NOSECIT) {
      return false;
    }
    if (marker === MARKER_SECIT) {
      return true;
    }
    return strategy === STRATEGY_SEC_ALL;
  };

  const preprocess = ({ raw, key }) => {
    const lines = raw.split('\n');
    let strategy = STRATEGY_SEC_ONLY_SELECTED;
    let secBack = false;
    let changed = false;
    let marker = null;

    // detect top-level directives
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      if (trimmed === DIRECTIVE_SEC_ALL) {
        strategy = STRATEGY_SEC_ALL;
      }
      if (trimmed === DIRECTIVE_SEC_BACK) {
        secBack = true;
      }
      if (!trimmed.startsWith('#')) {
        break;
      }
    }

    // walk lines: encrypt/decrypt values
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed === MARKER_SECIT) {
        marker = MARKER_SECIT;
        continue;
      }
      if (trimmed === MARKER_NOSECIT) {
        marker = MARKER_NOSECIT;
        continue;
      }

      // skip blank lines (don't reset marker)
      if (trimmed === '') {
        continue;
      }

      // handle comments that are not markers
      let commentPrefix = '';
      if (
        trimmed.startsWith('#') &&
        trimmed !== MARKER_SECIT &&
        trimmed !== MARKER_NOSECIT
      ) {
        const afterHash = trimmed.slice(1).trimStart();
        const commentEqIdx = afterHash.indexOf('=');
        if (commentEqIdx === -1) {
          marker = null;
          continue;
        }
        const commentKey = afterHash.substring(0, commentEqIdx);
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(commentKey)) {
          marker = null;
          continue;
        }
        const hashIdx = lines[i].indexOf('#');
        const rest = lines[i].slice(hashIdx + 1);
        const leadingSpaces = rest.match(/^\s*/)[0];
        commentPrefix = lines[i].slice(0, hashIdx + 1) + leadingSpaces;
      }

      // parse KEY=value
      const rawLine = commentPrefix
        ? lines[i].slice(commentPrefix.length)
        : lines[i];
      const eqIndex = rawLine.indexOf('=');
      if (eqIndex === -1) {
        marker = null;
        continue;
      }

      const varKey = rawLine.substring(0, eqIndex);
      const value = rawLine.substring(eqIndex + 1);

      if (secBack) {
        if (value.startsWith(PREFIX)) {
          const decrypted = crypto.decrypt({
            encoded: value.slice(PREFIX.length),
            key,
          });
          lines[i] = commentPrefix + varKey + '=' + decrypted;
          changed = true;
        }
      } else if (shouldEncrypt({ marker, strategy })) {
        if (!value.startsWith(PREFIX)) {
          const encrypted = crypto.encrypt({ plaintext: value, key });
          lines[i] = commentPrefix + varKey + '=' + PREFIX + encrypted;
          changed = true;
        }
      }

      marker = null;
    }

    const updatedRaw = lines.join('\n');

    let decryptedRaw = updatedRaw;
    if (!secBack) {
      decryptedRaw = updatedRaw.replace(CIPHER_REGEX, (match) => {
        const encoded = match.slice(PREFIX.length);
        return crypto.decrypt({ encoded, key });
      });
    }

    return { updatedRaw, decryptedRaw, changed };
  };

  const config = (options) => {
    if (process.env.SECDOTENV === 'false') {
      return dotenv.config(options);
    }

    const envPath =
      options && options.path
        ? path.resolve(options.path)
        : path.resolve(process.cwd(), '.env');

    if (!fileIo.isExists(envPath)) {
      return dotenv.config(options);
    }

    const key = keyManager.loadKey();
    const raw = fileIo.readFile(envPath);
    const { updatedRaw, decryptedRaw, changed } = preprocess({ raw, key });

    if (changed) {
      fileIo.writeFile(envPath, updatedRaw);
      keyManager.registerEnvFile(envPath);
    }

    const parsed = dotenv.parse(decryptedRaw);

    let processEnv = process.env;
    if (options && options.processEnv != null) {
      processEnv = options.processEnv;
    }

    dotenv.populate(processEnv, parsed, options);

    return { parsed };
  };

  return { config, preprocess };
};

const index = indexJs();
module.exports.config = index.config;
module.exports.init = keyManager.init;

// --- CLI entry point ---

if (require.main === module) {
  const cli = cliJs();
  cli.run();
}
