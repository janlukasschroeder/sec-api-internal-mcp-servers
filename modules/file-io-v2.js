const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const streamPromises = require('node:stream/promises');
const { pipeline, PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const { LRUCache } = require('lru-cache');
const csvParse = require('csv-parse'); // csv-parse@6.1.0
const csvStringify = require('csv-stringify'); // csv-stringify@6.6.0

const gzipPromise = promisify(zlib.gzip);
const gunzipPromise = promisify(zlib.gunzip);

const { log } = console;

// needed to ensure worker-sec-api written files can be accessed (=deleted/updated) by other users
const DEFAULT_WRITE_FILE_PERSMISSIONS = 0o664; // rw-rw-r--
// const DEFAULT_CREATE_DIR_PERMISSIONS = 0o775; // rwxrwxr-x
// 2 (in 0o2775) = lowercase s => forces all future files inside directory to inherit the storageadmin group
// 0o2775 = 'setgid' (2) + User rwx (7) + Group rwx (7) + Others r-x (5)
const DEFAULT_CREATE_DIR_PERMISSIONS = 0o2775;

const ensureDirExistsCache = new LRUCache({
  max: 100_000,
  ttl: 1000 * 60 * 60 * 24, // 24 hours
  updateAgeOnHas: true, // reset TTL on access
});

class CsvWriter {
  constructor({
    filePath,
    hasHeaders = true,
    headers = [],
    mkdir = true,
    delimiter = ',',
  }) {
    this.filePath = filePath;
    this.error = null;
    this.needInit = true;
    this.hasHeaders = hasHeaders;
    this.headers = headers;
    this.mkdir = mkdir;
    this.delimiter = delimiter;

    // serialize writes to avoid max event listeners exceeded
    // when calling `async writeRow()` more than 10 times, eg in async.parallelLimit(..., 20)
    this._chain = Promise.resolve();
    this._closed = false;
  }

  async init() {
    const isGzipped = this.filePath.endsWith('.gz');

    if (this.mkdir) {
      await ensureDirExists(path.dirname(this.filePath));
    }

    this.parser = csvStringify.stringify({
      header: this.hasHeaders,
      columns: this.headers.length ? this.headers : null,
      delimiter: this.delimiter,
    });

    // this.fileStream = fs.createWriteStream(this.filePath);
    this.fileStream = fs.createWriteStream(this.filePath, {
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });

    const transforms = [this.parser];
    if (isGzipped) transforms.push(zlib.createGzip());
    transforms.push(this.fileStream);

    // pipeline manages errors and cleanup across all stages
    this.streamPipelinePromise = new Promise((resolve, reject) => {
      pipeline(...transforms, (err) => {
        if (err) {
          // any stream error triggers this callback
          // => errors if any stream error at any time during piping occurs
          this.error = err;
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.needInit = false;
  }

  async writeRow(row) {
    // if (this.needInit) {
    //   await this.init();
    // }

    // if (this.error) throw this.error;

    // // parser.write returns false if the internal buffer is full (backpressure)
    // const canAcceptMore = this.parser.write(row);

    // if (!canAcceptMore) {
    //   // wait for the 'drain' event before continuing
    //   await new Promise((resolve) => this.parser.once('drain', resolve));
    // }
    // if (this.error) throw this.error;

    this._chain = this._chain.then(async () => {
      if (this._closed) throw new Error('CsvWriter is closed');
      if (this.needInit) await this.init();
      if (this.error) throw this.error;

      const ok = this.parser.write(row);
      if (!ok) {
        await new Promise((resolve) => this.parser.once('drain', resolve));
      }
      if (this.error) throw this.error;
    });

    return this._chain;
  }

  // write multiple rows (=batch)
  async writeRows(rows) {
    for (const row of rows) {
      await this.writeRow(row);
    }
  }

  async close() {
    this._closed = true;
    await this._chain; // wait for queued writes
    if (this.parser) {
      this.parser.end();
    }
    return this.streamPipelinePromise;
  }
}
module.exports.CsvWriter = CsvWriter;

class CsvReader {
  constructor({
    filePath,
    hasHeaders = true,
    castTypes = false,
    delimiter = ',',
  }) {
    this.filePath = filePath;
    this.hasHeaders = hasHeaders;
    this.castTypes = castTypes;
    this.isGzipped = filePath.endsWith('.gz');
    this.delimiter = delimiter;
  }

  async *read() {
    const fileStream = fs.createReadStream(this.filePath);

    const parser = csvParse.parse({
      columns: this.hasHeaders, // use first row as headers and convert each row to object
      skip_empty_lines: true,
      trim: true,
      cast: this.castTypes, // Automatically converts numbers/booleans
      bom: true, // handle BOM if present, i.e. UTF-8 with BOM
      delimiter: this.delimiter,
    });

    const gunzip = this.isGzipped ? zlib.createGunzip() : null;

    // Start piping in the background; route any pipeline error into the parser
    const piping = (async () => {
      try {
        if (gunzip) {
          await streamPromises.pipeline(fileStream, gunzip, parser);
        } else {
          await streamPromises.pipeline(fileStream, parser);
        }
      } catch (err) {
        // Ensure the async iterator sees the failure
        parser.destroy(err);
      }
    })();

    try {
      for await (const row of parser) {
        yield row;
      }
      // Ensure pipeline completion/errors are observed
      await piping;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw err;
      }
      if (err && err.code === 'Z_DATA_ERROR') {
        throw err;
      }
      throw new Error(
        `CSV Parse Error at ${this.filePath}: ${err?.message || String(err)}`
      );
    } finally {
      // Make sure everything is torn down if consumer stops early
      if (!parser.destroyed) parser.destroy();
      if (gunzip && !gunzip.destroyed) gunzip.destroy();
      if (!fileStream.destroyed) fileStream.destroy();
    }
  }
}
module.exports.CsvReader = CsvReader;

const ensureFileExists = async (filePath) => {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch (err) {
    await ensureDirExists(path.dirname(filePath));
    await fsp.writeFile(filePath, '');
  }
};
module.exports.ensureFileExists = ensureFileExists;

const readRaw = async ({ filePath, createIfNotExists = false }) => {
  if (createIfNotExists) {
    await ensureFileExists(filePath);
  }
  return await fsp.readFile(filePath, { encoding: 'utf8' });
};
module.exports.readRaw = readRaw;

const readFile = async ({ filePath, encoding = 'utf8' }) => {
  return await fsp.readFile(filePath, { encoding });
};
module.exports.readFile = readFile;

const readGzAsTxt = async (filePath) => {
  const source = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const chunks = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};
module.exports.readGzAsTxt = readGzAsTxt;

const writeRaw = async ({
  filePath,
  data,
  encoding = 'utf8',
  mkdir = true,
}) => {
  if (mkdir) {
    await ensureDirExists(path.dirname(filePath));
  }
  // await fsp.writeFile(filePath, data, { encoding });
  await fsp.writeFile(filePath, data, {
    encoding,
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
};
module.exports.writeRaw = writeRaw;

const readCsv = async ({ filePath, hasHeaders = true, castTypes = false }) => {
  if (!(filePath.endsWith('.csv') || filePath.endsWith('.csv.gz'))) {
    throw new Error('Input file must be a csv or csv.gz file');
  }

  const reader = new CsvReader({ filePath, hasHeaders, castTypes });

  const data = [];
  for await (const obj of reader.read()) {
    data.push(obj);
  }

  return data;
};
module.exports.readCsv = readCsv;

const writeCsv = async ({
  filePath,
  data = [],
  headers = null, // set headers if data[0] does not include all keys
  hasHeaders = true,
  mkdir = true,
  delimiter = ',',
}) => {
  if (headers == null) {
    headers = hasHeaders ? Object.keys(data[0]) : [];
  }

  // writer ensures directory exists
  const writer = new CsvWriter({
    filePath,
    hasHeaders,
    headers,
    mkdir,
    delimiter,
  });

  for (const row of data) {
    await writer.writeRow(row);
  }

  await writer.close();
};
module.exports.writeCsv = writeCsv;

/*
const reader = new fileIo.JsonlReader({ filePath: jsonlGzFilePath });  

for await (const row of reader.read()) {
    console.log(row);
}
*/
class JsonlReader {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.isGzipped = filePath.endsWith('.gz');
  }

  async *read() {
    const fileStream = fs.createReadStream(this.filePath);
    const gunzip = this.isGzipped ? zlib.createGunzip() : null;

    const inputStream = gunzip ? fileStream.pipe(gunzip) : fileStream;

    const rl = readline.createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });

    // handle errors from the file and gzip streams not captured by readline
    let streamErr = null;

    const fail = (err) => {
      if (streamErr) return;
      streamErr = err;

      // stop iteration promptly
      rl.close();

      // ensure underlying streams are torn down
      if (gunzip && !gunzip.destroyed) gunzip.destroy(err);
      if (!fileStream.destroyed) fileStream.destroy(err);
    };

    // IMPORTANT: consume stream errors explicitly (readline won't)
    fileStream.once('error', fail);
    gunzip?.once('error', fail);

    try {
      for await (const line of rl) {
        if (streamErr) throw streamErr;
        const s = line.trim();
        // skip empty lines
        if (!s) continue;
        yield JSON.parse(s);
      }

      // if readline stopped because of a stream error, surface it
      if (streamErr) throw streamErr;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw err;
      }
      if (err?.code === 'Z_DATA_ERROR') {
        throw err;
      }
      throw new Error(
        `JSONL Parse Error at ${this.filePath}: ${err?.message || String(err)}`
      );
    } finally {
      rl.close();
      fileStream.removeListener('error', fail);
      gunzip?.removeListener('error', fail);

      if (gunzip && !gunzip.destroyed) gunzip.destroy();
      if (!fileStream.destroyed) fileStream.destroy();
    }
  }
}
module.exports.JsonlReader = JsonlReader;

class JsonlWriter {
  constructor({ filePath, mkdir = true }) {
    this.filePath = filePath;
    this.needInit = true;
    this.mkdir = mkdir;

    // serialize writes to avoid max event listeners exceeded
    // when calling `async writeRow()` more than 10 times, eg in async.parallelLimit(..., 20)
    this._chain = Promise.resolve();
    this._closed = false;
  }

  async init() {
    const isGzipped = this.filePath.endsWith('.gz');

    // Ensure output directory exists
    if (this.mkdir) {
      await ensureDirExists(path.dirname(this.filePath));
    }

    // Separate writing from processing by using PassThrough buffer
    this.input = new PassThrough();
    // this.fileStream = fs.createWriteStream(this.filePath);
    this.fileStream = fs.createWriteStream(this.filePath, {
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });

    const transforms = [this.input];
    if (isGzipped) transforms.push(zlib.createGzip());
    transforms.push(this.fileStream);

    // Standard pipeline for safe error handling
    this.streamPipelinePromise = new Promise((resolve, reject) => {
      pipeline(...transforms, (err) => {
        if (err) {
          // any stream error triggers this callback
          // => errors if any stream error at any time during piping occurs
          this.error = err;
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.needInit = false;
  }

  async writeRow(row) {
    // if (this.needInit) {
    //   await this.init();
    // }

    // if (this.error) throw this.error;

    // const rowContent = JSON.stringify(row) + '\n';

    // // input.write returns false if the internal buffer is full (backpressure)
    // const canAcceptMore = this.input.write(rowContent);

    // if (!canAcceptMore) {
    //   // wait for the 'drain' event before continuing
    //   await new Promise((resolve) => this.input.once('drain', resolve));
    //   if (this.error) throw this.error;
    // }

    this._chain = this._chain.then(async () => {
      if (this._closed) throw new Error('JsonlWriter is closed');
      if (this.needInit) await this.init();
      if (this.error) throw this.error;

      const rowContent = JSON.stringify(row) + '\n';
      const ok = this.input.write(rowContent);
      if (!ok) {
        await new Promise((resolve) => this.input.once('drain', resolve));
      }
      if (this.error) throw this.error;
    });

    return this._chain;
  }

  // write mutliple rows (=batch)
  async writeRows(rows) {
    for (const row of rows) {
      await this.writeRow(row);
    }
  }

  async close() {
    // this.input.end();
    // return this.streamPipelinePromise;
    this._closed = true;
    await this._chain; // wait for queued writes

    // if init() was never called (e.g., 0 rows written), there are no streams to close.
    if (this.needInit) {
      return Promise.resolve();
    }

    this.input.end();
    return this.streamPipelinePromise;
  }
}
module.exports.JsonlWriter = JsonlWriter;

const readJsonl = async ({ filePath }) => {
  const reader = new JsonlReader({ filePath });
  const objs = [];
  for await (const obj of reader.read()) {
    objs.push(obj);
  }
  return objs;
};
module.exports.readJsonl = readJsonl;

const writeJsonl = async ({ filePath, data, mkdir = true }) => {
  if (!filePath.endsWith('.jsonl') && !filePath.endsWith('.jsonl.gz')) {
    throw new Error('Output file must be a JSONL or JSONL.GZ file');
  }

  // writer ensures directory exists
  const writer = new JsonlWriter({ filePath, mkdir });
  for (const obj of data) {
    await writer.writeRow(obj);
  }
  await writer.close();
};
module.exports.writeJsonl = writeJsonl;

const writeJsonGz = async ({ filePath, data }) => {
  const jsonString = JSON.stringify(data, null, 2);
  const compressedBuffer = await gzipPromise(jsonString);
  // await fsp.writeFile(filePath, compressedBuffer);
  await fsp.writeFile(filePath, compressedBuffer, {
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
};

const writeJson = async ({ filePath, data, logging = false, mkdir = true }) => {
  const isGzipped = filePath.endsWith('.json.gz');
  const isPlainJson = filePath.endsWith('.json');

  if (!isPlainJson && !isGzipped) {
    throw new Error('Output file must be a .json or .json.gz file');
  }

  if (mkdir) {
    await ensureDirExists(path.dirname(filePath));
  }
  if (isGzipped) {
    await writeJsonGz({ filePath, data });
  } else {
    // await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });
  }
  if (logging) {
    const status = isGzipped ? '(compressed)' : '';
    console.log(`File saved: ${filePath} ${status}`);
  }
};
module.exports.writeJson = writeJson;

const readJsonGz = async ({ filePath }) => {
  const compressedBuffer = await fsp.readFile(filePath);
  const decompressedBuffer = await gunzipPromise(compressedBuffer);
  return JSON.parse(decompressedBuffer.toString('utf8'));
};

const readJson = async ({ filePath }) => {
  const isGzipped = filePath.endsWith('.json.gz');
  const isPlainJson = filePath.endsWith('.json');

  if (!isPlainJson && !isGzipped) {
    throw new Error('Input file must be a .json or .json.gz file');
  }

  if (isGzipped) {
    return readJsonGz({ filePath });
  }

  const content = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(content);
};
module.exports.readJson = readJson;

const convertJsonToJsonlFile = async (
  jsonFilePath,
  jsonlFilePath,
  { mkdir = false }
) => {
  if (!jsonFilePath.endsWith('.json')) {
    throw new Error('Input file must be a JSON file');
  }
  if (!jsonlFilePath.endsWith('.jsonl')) {
    throw new Error('Output file must be a JSONL file');
  }

  const data = await readJson({ filePath: jsonFilePath });
  await writeJsonl({ filePath: jsonlFilePath, data, mkdir });
};
module.exports.convertJsonToJsonlFile = convertJsonToJsonlFile;

const toFileSync = (filePath, content) => {
  const _path = filePath.includes('/output/')
    ? filePath
    : `./output/${filePath}`;

  const dir = path.dirname(_path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
      mode: DEFAULT_CREATE_DIR_PERMISSIONS,
    });
  }

  if (typeof content === 'string') {
    fs.writeFileSync(_path, content, {
      encoding: 'utf-8',
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });
  } else if (typeof content === 'object') {
    fs.writeFileSync(_path, JSON.stringify(content, null, 2), {
      encoding: 'utf-8',
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });
  } else {
    throw new Error('Unsupported content type');
  }
};
module.exports.toFileSync = toFileSync;

const toFile = async (filePath, content) => {
  const _path = filePath.includes('/output/')
    ? filePath
    : `./output/${filePath}`;

  const dir = path.dirname(_path);

  await ensureDirExists(dir);

  if (typeof content === 'string') {
    // await fsp.writeFile(_path, content, 'utf-8');
    await fsp.writeFile(_path, content, {
      encoding: 'utf-8',
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });
  }

  if (typeof content === 'object') {
    // await fsp.writeFile(_path, JSON.stringify(content, null, 2), 'utf-8');
    await fsp.writeFile(_path, JSON.stringify(content, null, 2), {
      encoding: 'utf-8',
      mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    });
  }

  console.log(`File saved: ${_path}`);
};
module.exports.toFile = toFile;

// writeFileSync
const writeFileSync = ({
  filePath,
  data,
  encoding = 'utf-8',
  mkdir = true,
}) => {
  if (mkdir) {
    fs.mkdirSync(path.dirname(filePath), {
      recursive: true,
      mode: DEFAULT_CREATE_DIR_PERMISSIONS,
    });
  }
  // fs.writeFileSync(filePath, data, { encoding });
  fs.writeFileSync(filePath, data, {
    encoding,
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
};
module.exports.writeFileSync = writeFileSync;

// writeFile
const writeFile = async ({
  filePath,
  data,
  encoding = 'utf-8',
  mkdir = true,
}) => {
  if (mkdir) {
    await ensureDirExists(filePath);
  }
  // await fsp.writeFile(filePath, data, { encoding });
  await fsp.writeFile(filePath, data, {
    encoding,
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
};
module.exports.writeFile = writeFile;

const gzipFile = async (inputPath, outputPath = null, { mkdir = true }) => {
  if (outputPath == null) {
    outputPath = inputPath + '.gz';
  }
  if (!outputPath.endsWith('.gz')) {
    throw new Error('Output file must end in .gz');
  }

  if (mkdir && path.dirname(outputPath) !== path.dirname(inputPath)) {
    await ensureDirExists(path.dirname(outputPath));
  }

  const inputStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  // const outputStream = fs.createWriteStream(outputPath);
  const outputStream = fs.createWriteStream(outputPath, {
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
  const gzip = zlib.createGzip();

  return new Promise((resolve, reject) => {
    inputStream
      .pipe(gzip)
      .pipe(outputStream)
      .on('finish', () => {
        gzip.end();
        outputStream.end();
        console.log(`Converted ${inputPath} to ${outputPath}`);
        resolve();
      })
      .on('error', (error) => {
        console.error(`Error converting ${inputPath} to ${outputPath}:`, error);
        reject(error);
      });
  });
};
module.exports.gzipFile = gzipFile;

const prependFile = async ({
  filePath,
  data,
  encoding = 'utf-8',
  mkdir = true,
}) => {
  if (mkdir) {
    await ensureDirExists(path.dirname(filePath));
  }

  if (await fileExists(filePath)) {
    const existingData = await fsp.readFile(filePath, { encoding });
    // await fsp.writeFile(filePath, data + existingData, { encoding });
    await writeFile({ filePath, data: data + existingData, encoding });
  } else {
    // await fsp.writeFile(filePath, data, { encoding });
    await writeFile({ filePath, data, encoding });
  }
};
module.exports.prependFile = prependFile;

const appendFile = async ({
  filePath,
  data,
  encoding = 'utf-8',
  mkdir = true,
}) => {
  if (mkdir) {
    await ensureDirExists(path.dirname(filePath));
  }
  // await fsp.appendFile(filePath, data, { encoding });
  await fsp.appendFile(filePath, data, {
    encoding,
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
  });
};
module.exports.appendFile = appendFile;

const listDir = async (dirPath, params = { recursive: false }) => {
  const files = await fsp.readdir(dirPath, { withFileTypes: true });

  const fileList = files.map((file) => {
    const filePath = dirPath.startsWith('./')
      ? './' + path.join(dirPath, file.name)
      : path.join(dirPath, file.name);

    return {
      filePath,
      isDirectory: file.isDirectory(),
    };
  });

  if (params.recursive) {
    const subDirs = fileList.filter((file) => file.isDirectory);
    for (const subDir of subDirs) {
      const subDirFiles = await listDir(subDir.filePath, params);
      // fileList.push(...subDirFiles);
      subDirFiles.forEach((d) => fileList.push(d));
    }
  }

  return fileList;
};
module.exports.listDir = listDir;

// call with:
// listDirSync(..., { recursive: true })
const listDirSync = (
  dirPath,
  // { recursive = false, recursiveDepth = Infinity, currentDepth = 0 } = {}
  params = {}
) => {
  const _params = {
    // default params
    recursive: false,
    recursiveDepth: Infinity,
    currentDepth: 0,
    // user applied params overwriting defaults
    ...params,
  };

  const files = fs.readdirSync(dirPath, { withFileTypes: true });

  let fileList = files.map((file) => {
    const filePath = dirPath.startsWith('./')
      ? './' + path.join(dirPath, file.name)
      : path.join(dirPath, file.name);

    return {
      filePath,
      isDirectory: file.isDirectory(),
      hasSubDirs: undefined,
    };
  });

  if (_params.recursive && _params.currentDepth < _params.recursiveDepth) {
    const subDirs = fileList.filter((file) => file.isDirectory);
    for (const subDir of subDirs) {
      const subDirFiles = listDirSync(subDir.filePath, {
        ..._params,
        currentDepth: _params.currentDepth + 1,
      });
      fileList = fileList.concat(subDirFiles);
    }
  }

  return fileList;
};
module.exports.listDirSync = listDirSync;

const fileExists = async (filePath) => {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
};
module.exports.fileExists = fileExists;

// stream-hash so multi-hundred-MB files don't get slurped into ram.
const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256');
  await streamPromises.pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
};
module.exports.sha256File = sha256File;

const existsSync = (filePath) => {
  return fs.existsSync(filePath);
};
module.exports.existsSync = existsSync;

// ensure the directory exists
// treat dirPath as a directory if it ends in / or the last part does not contain .
// else treat it as a filePath and use its directory part
const ensureDirExists = async (dirPath) => {
  // don't use this to ensure its a directory path
  // it selects the dirpath of one level up
  // const _dirPath = path.dirname(dirPath);

  // use dirPath directly if it ends in / or last part does not have a .
  // else assume its a file and get its dirpath
  const _dirPath =
    dirPath[-1] === '/' || !path.basename(dirPath).includes('.')
      ? dirPath
      : path.dirname(dirPath);
  if (ensureDirExistsCache.has(_dirPath)) {
    return;
  }

  await fsp.mkdir(_dirPath, {
    recursive: true,
    mode: DEFAULT_CREATE_DIR_PERMISSIONS,
  });
  ensureDirExistsCache.set(_dirPath, true);
};
module.exports.ensureDirExists = ensureDirExists;

const deleteDir = async (dirPath) => {
  await fsp.rm(dirPath, { recursive: true, force: true });
};
module.exports.deleteDir = deleteDir;

const deleteFile = async (filePath) => {
  if (typeof filePath === 'object') {
    filePath = filePath?.filePath;
  }
  try {
    await fsp.rm(filePath);
  } catch (e) {}
};
module.exports.deleteFile = deleteFile;

const createWriteStream = (arg1, arg2 = {}) => {
  return fs.createWriteStream(arg1, {
    mode: DEFAULT_WRITE_FILE_PERSMISSIONS,
    ...arg2,
  });
};
module.exports.createWriteStream = createWriteStream;

const getFileSize = async ({ filePath }) => {
  const stats = await fsp.stat(filePath);
  return stats.size;
};
module.exports.getFileSize = getFileSize;

// in:  /2013/2013-07.jsonl.gz
// out: .jsonl.gz
const getFileExtension = (filePath = '') => {
  if (!filePath) {
    return null;
  }
  // handle cases without ending gracefully, return null for
  // foo/bar
  // foo.bar/baz
  // bar
  // ./output
  // undefined input

  // only split on last part of path
  const parts = path.basename(filePath).toLowerCase().split('.');

  // single part should
  if (parts.length < 2) {
    return null;
  }
  let ext = parts.at(-1);
  if (ext === 'gz') {
    ext = parts.slice(-2).join('.'); // ['json','gz'] => jsonl.gz
  }
  return '.' + ext;
};
module.exports.getFileExtension = getFileExtension;

////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////
const testRoundTrip = async () => {
  const crypto = require('crypto');

  const generateTestData = (count = 10) => {
    return Array.from({ length: count }, () => ({
      // 2 Strings
      id: crypto.randomUUID(),
      category: crypto.randomBytes(4).toString('base64'),

      // 2 Integers
      count: Math.floor(Math.random() * 1000),
      age: Math.floor(Math.random() * 100),

      // 3 Floats
      price: parseFloat((Math.random() * 500).toFixed(2)),
      latitude: parseFloat((Math.random() * 180 - 90).toFixed(6)),
      longitude: parseFloat((Math.random() * 360 - 180).toFixed(6)),
    }));
  };

  // const dataFile =
  //   './output/massive-com/daily-pricing-data-by-ticker/via-rest-api/adjusted/S/SPY-2004-01-01-2025-12-31.jsonl';
  // const data = await fileIo.readJsonl(dataFile);
  const numSamples = 1_000_000; // 1M still fits into memory
  log(`Running test with ${numSamples.toLocaleString()} samples`);
  console.time('generating data');
  const data = generateTestData(numSamples);
  console.timeEnd('generating data');

  // log(data[0]);

  const testCases = {
    csv: {
      write: writeCsv,
      read: readCsv,
      ending: 'csv',
    },
    csvGz: {
      write: writeCsv,
      read: readCsv,
      ending: 'csv.gz',
    },
    jsonl: {
      write: writeJsonl,
      read: readJsonl,
      ending: 'jsonl',
    },
    jsonlGz: {
      write: writeJsonl,
      read: readJsonl,
      ending: 'jsonl.gz',
    },
    json: {
      write: writeJson,
      read: readJson,
      ending: 'json',
    },
    jsonGz: {
      write: writeJson,
      read: readJson,
      ending: 'json.gz',
    },
    raw: {
      write: async ({ filePath, data }) => {
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      },
      read: async ({ filePath }) => {
        const data = await readRaw({ filePath });
        return JSON.parse(data);
      },
      ending: 'txt',
    },
  };

  for (const [name, testCase] of Object.entries(testCases)) {
    const outputDir = `./output/file-io-v2-testsuite/`;
    // const outputDir = `/home/js/VSCodeProjects/tmp/file-io-v2-testsuite/`;
    //
    const testFileName = `test-case-${name}.${testCase.ending}`;
    const outputPath = outputDir + testFileName;
    const timingStr = `Ran test case ${name} for ${numSamples.toLocaleString()} samples`;
    const timingWriteStr = `Write to ${testFileName}`;
    const timingReadStr = `Read to ${testFileName}`;

    console.time(timingStr);
    log('-'.repeat(40));
    log(
      `Test case ${name}, outputPath ${outputPath}, numSamples ${numSamples.toLocaleString()}`
    );

    // write data
    console.time(timingWriteStr);
    await testCase.write({ filePath: outputPath, data });
    console.timeEnd(timingWriteStr);

    // read back data
    console.time(timingReadStr);
    const readData = await testCase.read({
      filePath: outputPath,
      hasHeaders: true,
      castTypes: true,
    });
    console.timeEnd(timingReadStr);

    let roundTripMatches = true;
    if (readData.length !== data.length) {
      roundTripMatches = false;
    }

    // check if data matches
    if (roundTripMatches) {
      for (let i = 0; i < data.length; i++) {
        if (JSON.stringify(data[i]) !== JSON.stringify(readData[i])) {
          log(`Mismatch:`);
          log(`data[${i}] = `, data[i]);
          log(`readData[${i}] = `, readData[i]);
          roundTripMatches = false;
          break;
        }
      }
    }

    // compare to original
    if (roundTripMatches) {
      log(`✅ ${name} successful saving and reading round trip`);
    } else {
      log(
        `❌ ${name} only wrote ${readData.length} / ${numSamples} or mismatch in read data`
      );
    }
    console.timeEnd(timingStr);
  }
};

const testFileNotExists = async () => {
  const crypto = require('crypto');

  // test if readers properly handle file not found errors
  const testCases = {
    json: { reader: readJson, ending: 'json' },
    jsonGz: { reader: readJson, ending: 'json.gz' },
    jsonl: { reader: readJsonl, ending: 'jsonl' },
    jsonlGz: { reader: readJsonl, ending: 'jsonl.gz' },
    csv: { reader: readCsv, ending: 'csv' },
    csvGz: { reader: readCsv, ending: 'csv.gz' },
  };

  for (const [name, { reader, ending }] of Object.entries(testCases)) {
    const fakeFileName = crypto.randomUUID() + '.' + ending;
    try {
      const data = await reader({ filePath: fakeFileName });
    } catch (error) {
      log(`✅ Caught error for ${name}: ${error.message}`);
    }
  }
  log(`✅ Successfully ran FileNotFound error propagation test`);
};

const createInvalidGz = ({ filePath, dataString }) => {
  const gz = zlib.gzipSync(dataString);

  // write only part of the gzip buffer
  fs.writeFileSync(filePath, gz.slice(0, gz.length - 10));
};

const testBrokenGzFile = async () => {
  const testCases = {
    jsonGz: {
      reader: readJson,
      ending: 'json.gz',
      dataString: '{"a":1,"b":2,"c":3,"d":4}',
    },
    jsonlGz: {
      reader: readJsonl,
      ending: 'jsonl.gz',
      dataString: '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}',
    },
    csvGz: {
      reader: readCsv,
      ending: 'csv.gz',
      dataString: 'a,b\n1,2\n3,4\n5,6\n7,8',
    },
  };

  for (const [name, { reader, ending, dataString }] of Object.entries(
    testCases
  )) {
    const brokenFileName = './output/' + crypto.randomUUID() + '.' + ending;
    createInvalidGz({ filePath: brokenFileName, dataString });
    try {
      const data = await reader({ filePath: brokenFileName });
    } catch (error) {
      log(`✅ Caught error for ${name}: ${error.message}`);
    } finally {
      fs.rmSync(brokenFileName);
    }
  }
  log(`✅ Successfully ran broken gzip pipe error propagation test`);
};

const testRunner = async () => {
  const tests = {
    'FileNotFound error propagation': testFileNotExists,
    'Invalid gzip error propagation': testBrokenGzFile,
    'Roundtrip data comparison': testRoundTrip,
  };

  for (const [name, test] of Object.entries(tests)) {
    log('='.repeat(40));
    log('='.repeat(40));
    log(`Running test ${name}`);
    log('='.repeat(40));
    await test();
    log('');
  }
};

if (require.main === module) {
  // testSuiteRoundTrip();
  // testFileNotExists();
  // testBrokenGzFile();
  testRunner();

  // // check gzipFile function, run this after test suite to create the file
  // gzipFile(
  //   './output/file-io-v2-testsuite/test-case-json.json',
  //   './output/file-io-v2-testsuite/test-case-json-gzipFile.json.gz'
  // );
  // bash -c 'diff output/file-io-v2-testsuite/test-case-jsonGz.json.gz output/file-io-v2-testsuite/test-case-json-gzipFile.json.gz'
  // -> files match
}

// RAID 6 output home server
/*
========================================
========================================
Running test FileNotFound error propagation
========================================
✅ Caught error for json: ENOENT: no such file or directory, open '9b3d26ad-342c-4e15-90e8-692376f7f0a3.json'
✅ Caught error for jsonGz: ENOENT: no such file or directory, open 'e3ed6191-5103-4c22-a600-ed886875b7f7.json.gz'
✅ Caught error for jsonl: ENOENT: no such file or directory, open 'e4718be6-0bbe-4bb2-8d9c-78a62c67f1e3.jsonl'
✅ Caught error for jsonlGz: ENOENT: no such file or directory, open '3ebd95d4-dc6d-432c-b9aa-ce1a5d5632b4.jsonl.gz'
✅ Caught error for csv: ENOENT: no such file or directory, open '5040dba0-5760-4058-976b-453458184fb4.csv'
✅ Caught error for csvGz: ENOENT: no such file or directory, open '97a964b6-939e-4ce7-8e98-d17b962a0a34.csv.gz'
✅ Successfully ran FileNotFound error propagation test

========================================
========================================
Running test Invalid gzip error propagation
========================================
✅ Caught error for jsonGz: unexpected end of file
✅ Caught error for jsonlGz: JSONL Parse Error at ./output/f9de4990-b886-4265-a4e4-b692599f4668.jsonl.gz: unexpected end of file
✅ Caught error for csvGz: CSV Parse Error at ./output/eb00ba45-9b9b-4333-a93f-70fb63ddf9c9.csv.gz: unexpected end of file
✅ Successfully ran broken gzip pipe error propagation test

========================================
========================================
Running test Roundtrip data comparison
========================================
Running test with 1,000,000 samples
generating data: 6.448s
----------------------------------------
Test case csv, outputPath ./output/file-io-v2-testsuite/test-case-csv.csv, numSamples 1,000,000
✅ csv successful saving and reading round trip
Ran test case csv for 1,000,000 samples: 15.215s
----------------------------------------
Test case csvGz, outputPath ./output/file-io-v2-testsuite/test-case-csvGz.csv.gz, numSamples 1,000,000
✅ csvGz successful saving and reading round trip
Ran test case csvGz for 1,000,000 samples: 49.993s
----------------------------------------
Test case jsonl, outputPath ./output/file-io-v2-testsuite/test-case-jsonl.jsonl, numSamples 1,000,000
✅ jsonl successful saving and reading round trip
Ran test case jsonl for 1,000,000 samples: 8.326s
----------------------------------------
Test case jsonlGz, outputPath ./output/file-io-v2-testsuite/test-case-jsonlGz.jsonl.gz, numSamples 1,000,000
✅ jsonlGz successful saving and reading round trip
Ran test case jsonlGz for 1,000,000 samples: 41.018s
----------------------------------------
Test case json, outputPath ./output/file-io-v2-testsuite/test-case-json.json, numSamples 1,000,000
File saved: ./output/file-io-v2-testsuite/test-case-json.json 
✅ json successful saving and reading round trip
Ran test case json for 1,000,000 samples: 5.514s
----------------------------------------
Test case jsonGz, outputPath ./output/file-io-v2-testsuite/test-case-jsonGz.json.gz, numSamples 1,000,000
File saved: ./output/file-io-v2-testsuite/test-case-jsonGz.json.gz (compressed)
✅ jsonGz successful saving and reading round trip
Ran test case jsonGz for 1,000,000 samples: 10.528s
*/

// MacBook Pro M3 Max
/*
========================================
Running test FileNotFound error propagation
========================================
✅ Caught error for json: ENOENT: no such file or directory, open '90d65783-364b-4908-9e7d-a75346de2b22.json'
✅ Caught error for jsonGz: ENOENT: no such file or directory, open 'e3165b0d-1ee3-4a4f-bc1a-e5d4777765f0.json.gz'
✅ Caught error for jsonl: ENOENT: no such file or directory, open 'fc855c18-df6d-40ce-a509-773acc25a8d4.jsonl'
✅ Caught error for jsonlGz: ENOENT: no such file or directory, open 'd0a1c3be-e5c9-437f-9ee2-5ea469a941dc.jsonl.gz'
✅ Caught error for csv: ENOENT: no such file or directory, open 'fe8b1f87-0a65-4152-a2a5-5a5987c136c6.csv'
✅ Caught error for csvGz: ENOENT: no such file or directory, open '04999e1e-0819-4e93-9a57-75321d45f358.csv.gz'
✅ Successfully ran FileNotFound error propagation test

========================================
========================================
Running test Invalid gzip error propagation
========================================
✅ Caught error for jsonGz: unexpected end of file
✅ Caught error for jsonlGz: JSONL Parse Error at ./output/c7509796-1159-4d86-8d8a-7e7cb45f3a82.jsonl.gz: unexpected end of file
✅ Caught error for csvGz: CSV Parse Error at ./output/e370604f-7eb6-4537-b01c-d41b0dd6e11e.csv.gz: unexpected end of file
✅ Successfully ran broken gzip pipe error propagation test

========================================
========================================
Running test Roundtrip data comparison
========================================
Running test with 1,000,000 samples
generating data: 2.635s
----------------------------------------
Test case csv, outputPath ./output/file-io-v2-testsuite/test-case-csv.csv, numSamples 1,000,000
✅ csv successful saving and reading round trip
Ran test case csv for 1,000,000 samples: 6.021s
----------------------------------------
Test case csvGz, outputPath ./output/file-io-v2-testsuite/test-case-csvGz.csv.gz, numSamples 1,000,000
✅ csvGz successful saving and reading round trip
Ran test case csvGz for 1,000,000 samples: 14.063s
----------------------------------------
Test case jsonl, outputPath ./output/file-io-v2-testsuite/test-case-jsonl.jsonl, numSamples 1,000,000
✅ jsonl successful saving and reading round trip
Ran test case jsonl for 1,000,000 samples: 3.572s
----------------------------------------
Test case jsonlGz, outputPath ./output/file-io-v2-testsuite/test-case-jsonlGz.jsonl.gz, numSamples 1,000,000
✅ jsonlGz successful saving and reading round trip
Ran test case jsonlGz for 1,000,000 samples: 11.848s
----------------------------------------
Test case json, outputPath ./output/file-io-v2-testsuite/test-case-json.json, numSamples 1,000,000
File saved: ./output/file-io-v2-testsuite/test-case-json.json 
✅ json successful saving and reading round trip
Ran test case json for 1,000,000 samples: 2.566s
----------------------------------------
Test case jsonGz, outputPath ./output/file-io-v2-testsuite/test-case-jsonGz.json.gz, numSamples 1,000,000
File saved: ./output/file-io-v2-testsuite/test-case-jsonGz.json.gz (compressed)
✅ jsonGz successful saving and reading round trip
Ran test case jsonGz for 1,000,000 samples: 5.400s
*/
