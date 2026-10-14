export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-empty': [2, 'always'],
    'footer-empty': [2, 'always'],
    'scope-empty': [2, 'never'],
    'header-max-length': [2, 'always', 100],
  },
};
