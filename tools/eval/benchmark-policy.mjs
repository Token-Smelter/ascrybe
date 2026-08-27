import { posix } from 'node:path';

const externalPolicy = Object.freeze({ material: 'external', excluded_path_prefixes: Object.freeze([]) });

function normalizedPrefix(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || posix.isAbsolute(value)
    || value.endsWith('/') || value === '.' || value === '..' || value.startsWith('../') || posix.normalize(value) !== value) {
    throw new Error('benchmark excluded path prefixes must be normalized repository-relative paths');
  }
  return value;
}

export function validateBenchmarkPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('benchmark_policy with material declaration is required');
  }
  if (!['committed', 'external'].includes(policy.material)) {
    throw new Error('benchmark_policy.material must be committed or external');
  }
  const prefixes = policy.excluded_path_prefixes == null ? [] : policy.excluded_path_prefixes;
  if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== 'string')) {
    throw new Error('benchmark_policy.excluded_path_prefixes must be an array');
  }
  const normalized = prefixes.map(normalizedPrefix);
  if (new Set(normalized).size !== normalized.length) throw new Error('benchmark excluded path prefixes must be unique');
  if (policy.material === 'committed' && normalized.length === 0) {
    throw new Error('committed benchmark material requires excluded path prefixes');
  }
  return Object.freeze({ material: policy.material, excluded_path_prefixes: Object.freeze(normalized) });
}

export function defaultExternalBenchmarkPolicy() {
  return externalPolicy;
}

export function isExcludedBenchmarkPath(path, policy) {
  if (!policy?.excluded_path_prefixes?.length || typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')
    || posix.isAbsolute(path) || path === '.' || path === '..' || path.startsWith('../') || posix.normalize(path) !== path) return false;
  return policy.excluded_path_prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function benchmarkPathExcluded(path) {
  const error = new Error(`EVAL_BENCHMARK_PATH_EXCLUDED: benchmark path is excluded (${path})`);
  error.code = 'EVAL_BENCHMARK_PATH_EXCLUDED';
  return error;
}
