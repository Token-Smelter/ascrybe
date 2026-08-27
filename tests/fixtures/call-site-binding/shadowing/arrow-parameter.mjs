function helper() { return 2; }
const outer = helper => helper();
