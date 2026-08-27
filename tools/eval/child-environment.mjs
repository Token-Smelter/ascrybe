const ALLOWED_ENVIRONMENT_KEYS = Object.freeze([
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'PI_COMMAND',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TMPDIR', 'USER', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
]);

export function evaluationChildEnvironment(environment = process.env) {
  return Object.freeze(Object.fromEntries(ALLOWED_ENVIRONMENT_KEYS
    .filter(key => typeof environment[key] === 'string' && environment[key])
    .map(key => [key, environment[key]])));
}

export { ALLOWED_ENVIRONMENT_KEYS };
