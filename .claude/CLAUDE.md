# CLAUDE.md

Use ASD-STE100, or Simplified Technical English

Follow Zinsser's four principles of good writing:

- Simplicity: remove each word that does no work
- Brevity: use short sentences and short paragraphs
- Clarity: write one thought per sentence, and put it in the active voice
- Humanity: write to a person, not to a committee

## Code execution

- Always use `nvm` to switch to the designated node.js version prior to running any `node` commands, prior to executing any `npm run` commands, and prior to running anything running under node.js. use the following command:

  ```bash
  source ~/.nvm/nvm.sh && nvm use
  ```

  Ensure to run this command inside the project dir so that nvm can pick up a potential `.nvmrc` file.

## Coding Style

- Use CommonJS (`require`/`module.exports`), not ES modules
- Use arrow functions
- Start by importing `const config = require('../config')`, then node.js built-ins, then 3rd party modules, then local modules
- Declare `const { log } = console;` directly under all imports, and use `log(...)` instead of `console.log`
- Define global variables, such `const MAX_ROW = 5;` always right below `const { log } = console;` at the top of a file.
- Avoid importing tons of functions from a single module, and instead import the module, and call the functions directly.

```js
// ❌ DO NOT DO
const { a, b, c, d, e, f, g } = require('./my-module.js');
// ✅ Instead do:
const myModule = require('./my-module.js');
// later on:
myModule.a();
myModule.b();
// and so on...
```

- If a function is exported, add the export directly underneath the end of the function. For example:

```js
const myFn = async () => { ... };
module.exports.myFn = myFn;
```

- Do not export everything at the end of the file. Do not use default exports.
- As soon as there are more than 1 function parameter, use an object instead of a parameter list. For example:

```js
// multi params
// ❌ DO NOT DO
const multiParams = (inboundEmail, similarThreads) => {...}
// ✅ Instead do:
const multiParams = ({ inboundEmail, similarThreads }) => {...}
// single param
// ✅ DO:
const singleParam = (paramA) => {...}
```

- All process.env variables should be declared in `./config/index.js`. Never use process.env anywhere else. Instead, use `config.<GROUP_NAME>.<VAR>`. Import config whereever process.env are needed.
- All comments should start with lower-case, not upper case. For example:

```js
// ❌ DO NOT DO
// Fetch and store in batches
// ✅ Instead do:
// fetch and store in batches
```

- Always use curly brackets around if/else clauses:

```js
// ❌ DO NOT DO
if (a) return true;
else return false;
// ✅ Instead DO:
if (a) {
  return true;
} else {
  return false;
}
```

- Perfer string plus concatenation over template literals, except when the string is multi-line. For example:

```js
// ❌ DO NOT DO
const str = `item-${itemName.toUpperCase()}${fileExtension}.gz`;
// ✅ Instead DO:
const str = 'item-' + itemName.toUpperCase() + fileExtension + '.gz';
// using template literals in log(...) is fine
log(`item-${itemName.toUpperCase()}${fileExtension}.gz`);
```

- Keep it simple — KISS principles, no over-engineering
- Error handling at the top level only (in the `main` entry point)
- No unnecessary abstractions, helpers, or comments
- Use single quotes, not double-quotes
- Run prettier everytime you completed an update of files: use single quotes, and "trailingComma": "es5"
- No co-author line — never add Co-Authored-By to commit messages
- Avoid single-line functions:

```js
// ❌ DO NOT DO
const isExists = (filePath) => fs.existsSync(filePath);
// ✅ Instead DO:
const isExists = (filePath) => {
  return fs.existsSync(filePath);
};
```

- Use single line functions in .map or similar operators where the value is immediately return inside the loop:

```js
// ❌ DO NOT DO
const a = newItems.map((i) => {
  return i.url;
});
// ✅ Instead DO:
const a = newItems.map((i) => i.url);
```

- Do not add variable specifications as function inputs:

```js
// ❌ DO NOT DO
testPost(
  '/form-13f/cover-pages',
  {
    query: 'cik:320193',
    from: 0,
    size: 1,
    sort: [{ filedAt: { order: 'desc' } }],
  },
  (res) => {
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.data));
    assert.ok(res.data.data[0].accessionNo);
  }
);

// ✅ Instead DO:
const endpoint = '/form-13f/cover-pages';
const payload = {
  query: 'cik:320193',
  from: 0,
  size: 1,
  sort: [{ filedAt: { order: 'desc' } }],
};
const testFn = (res) => {
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.data));
  assert.ok(res.data.data[0].accessionNo);
};

testPost(endpoint, payload, testFn);
```

- Do not immediately invoke main or test functions. Declare an `async main` function and call it under a `require.main === module` guard.

```js
// ❌ DO NOT DO
(async () => {
  // ... main logic
})();

// ✅ Instead DO:
const main = async () => {
  // ... main logic
};

if (require.main === module) {
  main();
}
```

- Use `async.parallelLimit` to perform parallel task execution. Only use `Promise.all` for simple tasks, e.g. executing 2-4 functions.

```js
// ❌ DO NOT DO
await async.parallelLimit(
  files.map((msg) => async () => {
    try {
      // ... do something
    } catch (err) {
      // ...
    }
  }),
  100
);

// ✅ Instead DO:
const tasks = files.map((msg) => async () => {
  try {
    // ... do something
  } catch (err) {
    // ...
  }
});
await async.parallelLimit(tasks, 100);
```

- Always set AWS credentials explicitly using `config.aws.accessKeyId` and `config.aws.secretAccessKey`. Example:

```js
// assuming ../config/index.js contains secdotenv.js
const config = require('../config');
const AWS = require('aws-sdk');

// ❌ DO NOT DO
// pulls AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY directly from process.env, without decryption
const credentials = new AWS.EnvironmentCredentials('AWS');

// ✅ Instead DO:
const credentials = new AWS.Credentials({
  accessKeyId: config.aws.accessKeyId,
  secretAccessKey: config.aws.secretAccessKey,
});
```

- Write SQL queries as string literals:

```js
// ❌ DO NOT DO
const sql =
  'SELECT\n' +
  '  email\n' +
  'FROM users\n' +
  'WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz\n' +
  '  AND email IS NOT NULL\n';
// ✅ Instead DO:
const sql = `
  SELECT
    email
  FROM users
    ...
`;
```

- Write multi-line text as string literals:

```js
// ❌ DO NOT DO
const prompt =
  'My fancy\n' +
  'multi-line prompt\n' +
  'has many new lines...\n' +
  'with new lines\n';
// ✅ Instead DO:
const prompt = `My fancy
multi-line prompt
has many new lines...
with new lines
`;
```

- Use `const store = {myLocalVar: someValue}` instead of using `let myLocalVar = someValue` in global scope when it comes to `my-module.js` files. Use one `store` variable for any global param in a module. Declare a single `store` var after imports/require and after all constant declartion, but before function definitions

```js
const moduleA = require('moduleA');

const { log } = console;

const NR = 123;

// ❌ DO NOT DO
let myState = true;

const print = (msg) => myState && console.log(msg);

// ✅ Instead DO:
const store = {
  myState: true,
};

const print = (msg) => store.myState && console.log(msg);
```

- Declare all const at the top of the script, after imports, before function declarations.

```js
// ❌ DO NOT DO
const moduleA = require('moduleA');

const a = () => {...};
const b = () => {...};

const MAGIC_CONST = 1;

// ✅ Instead DO:
const moduleA = require('moduleA');

const MAGIC_CONST = 1;

const a = () => {...};
const b = () => {...};
```

## NEVER DO

- NEVER remove or delete code comments inside files unless the user explicitly asks you to do so. Example of a comment that should NEVER be deleted.

```js
// some fancy comment never to be deleted
const coolVar = 123;
```
