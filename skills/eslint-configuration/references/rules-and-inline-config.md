Source: https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/rules.md, https://github.com/eslint/eslint/tree/v10.12.0/docs/src/use/configure/configuration-files.md (MIT), condensed.

# Rules and inline configuration

## Severities

| Value            | Effect                                  |
| ---------------- | --------------------------------------- |
| `"off"` or `0`   | Rule disabled                           |
| `"warn"` or `1`  | Reported, does not change the exit code |
| `"error"` or `2` | Reported, exit code 1                   |

- Use `"error"` for anything CI, pre-commit hooks and merges must enforce.
- Use `"warn"` while introducing a rule that will become an error, for findings that are not build or runtime errors (such as unused variables), or for rules that may have false positives.

## Options

```js
export default defineConfig([
  {
    rules: {
      eqeqeq: 'off',
      'no-unused-vars': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
]);
```

The first array item is the severity; the rest are the rule's options (see each rule's documentation). When several objects configure the same rule, the later one wins. A later severity-only value keeps the earlier options: `semi: ['error', 'never']` then `semi: 'warn'` results in `['warn', 'never']`.

Rules configured in comments have the highest priority and apply after all configuration files.

## Plugin rules

Prefix the rule with the plugin namespace: `'example/rule1': 'warn'`, after registering `plugins: { example }`. Configuration comments can set plugin rules (`/* eslint "example/rule1": "error" */`) only if the config file loads the plugin; comments cannot load plugins.

## Configuration comments

```js
/* eslint eqeqeq: "off", curly: "error" */
/* eslint quotes: ["error", "double"], curly: 2 */
/* global var1, var2:writable */
```

- Add a reason after two or more dashes: `/* eslint eqeqeq: "off" -- legacy API returns strings */`. In a multi-line block comment, the dashes do not work on a line that starts with `*`.
- Since ESLint 9, a severity-only comment keeps the options from the config file, and a second `/* eslint */` comment for the same rule in a file is reported and ignored (the first applies).
- `linterOptions.reportUnusedInlineConfigs` (default `"off"`) reports comments that change nothing; `--report-unused-inline-configs` overrides it.
- The docs suggest `eslint-plugin-eslint-comments` (eslint-community) to enforce comment best practices.

## Disabling rules in code

Treat inline disabling as an exception: use it only with a clear reason, document the reason after `--`, track temporary disables with a follow-up task, and prefer configuration files for anything project-wide.

```js
/* eslint-disable no-alert, no-console */
alert('foo');
console.log('bar');
/* eslint-enable no-alert, no-console */

alert('foo'); // eslint-disable-line no-alert

// eslint-disable-next-line no-alert, quotes -- reason here
alert('foo');

/* eslint no-alert: "off" */
```

- `/* eslint-disable */` at the top of a file disables every rule for the file; with rule names, only those rules.
- `/* eslint-enable */` without rule names re-enables every disabled rule.
- `/* eslint no-alert: "off" */` keeps the rule off regardless of later enable comments.
- Plugin rules work the same way: `// eslint-disable-line example/rule-name`.
- Disabled code is still parsed, so it must be valid syntax.

## Disabling rules for groups of files

Add a later object with `files`:

```js
export default defineConfig([
  {
    rules: { 'no-unused-expressions': 'error' },
  },
  {
    files: ['*-test.js', '*.spec.js'],
    rules: { 'no-unused-expressions': 'off' },
  },
]);
```

## linterOptions

```js
export default defineConfig([
  {
    files: ['**/*.js'],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
]);
```

| Option                          | Default  | Notes                                                                                                                      |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `noInlineConfig`                | `false`  | Ignores all inline configuration. CLI: `--no-inline-config`                                                                |
| `reportUnusedDisableDirectives` | `"warn"` | Severity string. Legacy `true` means `"warn"`, `false` means `"off"`. CLI: `--report-unused-disable-directives(-severity)` |
| `reportUnusedInlineConfigs`     | `"off"`  | Severity string. CLI: `--report-unused-inline-configs <severity>`                                                          |

With unused-directive reporting on, upgrading ESLint or a plugin can surface new errors: when a false positive gets fixed, the `eslint-disable` comment that hid it becomes unused.

`--no-inline-config` ignores `/*eslint-disable*/`, `/*eslint-enable*/`, `/*global*/`, `/*eslint*/`, `// eslint-disable-line` and `// eslint-disable-next-line`.

## Adopting a strict rule in a large codebase

Enable it as `"error"`, run `eslint --fix`, review the diff, then record the remaining violations with bulk suppressions (`--suppress-rule <rule>`; see cli.md). New code is checked immediately and the backlog stays visible in `eslint-suppressions.json`. Only `"error"` rules can be suppressed.
