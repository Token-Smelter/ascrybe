export async function run() {
  return { environment: Object.fromEntries(Object.keys(process.env).sort().map(key => [key, process.env[key]])) };
}
