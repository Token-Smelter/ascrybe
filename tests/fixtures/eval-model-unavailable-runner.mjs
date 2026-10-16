export async function run() {
  const error = new Error('No API key found for invented-provider');
  error.code = 'EVAL_MODEL_UNAVAILABLE';
  throw error;
}
